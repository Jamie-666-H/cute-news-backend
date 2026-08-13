# -*- coding: utf-8 -*-
"""常驻后端：一直运行，每 60 秒重新抓取新闻；同时托管整个 App + 实时接口 + 用户数据云端同步。
接口：
- 访问 /             -> 打开「我的小天地」工作台
- 访问 /news.json    -> 同域静态文件（后端每 60 秒重写，天然新鲜）
- 访问 /api/news     -> 实时新闻 JSON {updated, items}（带 CORS）
- 访问 /api/sync     -> 用户数据云端同步
      GET  /api/sync?key=XXX  -> {"updated":<ts>,"data":<obj>|null}
      POST /api/sync?key=XXX  -> body {"updated":<ts>,"data":<obj>}，服务端做合并后返回合并结果
运行:  python news_server.py   （可用 PORT 环境变量指定端口，默认 3000）
依赖:  仅 Python 标准库，无需 pip install。
"""
import os, sys, threading, time, json, copy
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crawl_news import crawl

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(ROOT, 'news.json')
SYNC_FILE = os.path.join(ROOT, 'sync_store.json')
INTERVAL = 60  # 每 60 秒重新抓取一次

cache = {'updated': '', 'items': []}
cache_lock = threading.Lock()

sync_store = {}
sync_lock = threading.Lock()


def load_sync():
    global sync_store
    try:
        if os.path.exists(SYNC_FILE):
            with open(SYNC_FILE, 'r', encoding='utf-8') as f:
                sync_store = json.load(f)
    except Exception:
        sync_store = {}


def save_sync():
    try:
        with open(SYNC_FILE, 'w', encoding='utf-8') as f:
            json.dump(sync_store, f, ensure_ascii=False)
    except Exception:
        pass


def _merge_value(lv, rv):
    """递归合并单个值：对象递归合并键；数组按 id(无 id 则按内容) 去重取并集，冲突时远端优先。"""
    if isinstance(rv, dict) and isinstance(lv, dict):
        out = dict(lv)
        for k, v in rv.items():
            out[k] = _merge_value(out.get(k), v)
        return out
    if isinstance(rv, list) and isinstance(lv, list):
        m = {}
        def key(x):
            return str(x['id']) if isinstance(x, dict) and 'id' in x else json.dumps(x, ensure_ascii=False, sort_keys=True)
        for x in lv:
            m[key(x)] = x
        for x in rv:
            m[key(x)] = x  # 远端优先
        return list(m.values())
    return rv if rv is not None else lv


def merge_data(local, remote):
    """合并两份用户数据（递归），冲突时远端优先，updated 取较大值。"""
    local = local or {}
    remote = remote or {}
    out = _merge_value(local, remote)
    out['updated'] = max(int(local.get('updated', 0) or 0), int(remote.get('updated', 0) or 0))
    return out


def refresh():
    global cache
    try:
        out = crawl()
        with cache_lock:
            cache = out
        try:
            with open(CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(out, f, ensure_ascii=False, indent=0)
        except Exception:
            pass
        print('[refresh] OK', out['updated'], '条数', len(out['items']))
    except Exception as e:
        print('[refresh] FAIL', repr(e))


def loop():
    while True:
        refresh()
        time.sleep(INTERVAL)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        p = self.path.split('?')[0]
        if p in ('/api/news', '/api/news/', '/news.json', '/news.json/'):
            with cache_lock:
                body = json.dumps(cache, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
            return
        if p in ('/api/sync', '/api/sync/'):
            key = parse_qs(urlparse(self.path).query).get('key', [''])[0]
            with sync_lock:
                rec = copy.deepcopy(sync_store.get(key))
            if rec is None:
                rec = {'updated': 0, 'data': None}
            self._send_json(200, rec)
            return
        return super().do_GET()

    def do_POST(self):
        p = self.path.split('?')[0]
        if p in ('/api/sync', '/api/sync/'):
            try:
                ln = int(self.headers.get('Content-Length', 0) or 0)
                raw = self.rfile.read(ln) if ln else b''
            except Exception:
                self._send_json(400, {'error': 'read failed'})
                return
            if len(raw) > 8 * 1024 * 1024:
                self._send_json(413, {'error': 'payload too large (max 8MB)'})
                return
            try:
                data = json.loads(raw.decode('utf-8')) if raw else {}
            except Exception:
                self._send_json(400, {'error': 'bad json'})
                return
            key = parse_qs(urlparse(self.path).query).get('key', [''])[0]
            if not key:
                self._send_json(400, {'error': 'missing key'})
                return
            incoming_data = data.get('data')
            incoming_updated = int(data.get('updated', 0) or 0)
            with sync_lock:
                rec = sync_store.get(key)
                if rec and isinstance(rec.get('data'), dict) and isinstance(incoming_data, dict):
                    merged = merge_data(rec['data'], incoming_data)
                    merged['updated'] = max(int(rec.get('updated', 0) or 0), incoming_updated)
                    sync_store[key] = merged
                else:
                    sync_store[key] = {'updated': incoming_updated, 'data': incoming_data}
                save_sync()
                out = copy.deepcopy(sync_store[key])
            self._send_json(200, out)
            return
        self.send_response(405)
        self.end_headers()
        self.wfile.write(b'Method Not Allowed')

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    load_sync()
    # 先启动后台抓取循环（首次抓取在后台进行），立即绑定端口，
    # 避免长时间阻塞导致平台（Render 等）健康检查判定启动失败。
    threading.Thread(target=loop, daemon=True).start()
    print('常驻后端已启动，监听端口', port, '（每', INTERVAL, '秒重新抓取，首抓在后台进行）')
    HTTPServer(('0.0.0.0', port), Handler).serve_forever()
