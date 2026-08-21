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
import os, sys, threading, time, json, copy, re, random
from collections import deque
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request, urllib.parse as _uparse, urllib.error, base64

try:
    from pywebpush import webpush, WebPushException
    HAVE_WEBPUSH = True
except Exception:
    class WebPushException(Exception):
        pass
    webpush = None
    HAVE_WEBPUSH = False

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crawl_news import crawl

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(ROOT, 'news.json')
SYNC_FILE = os.path.join(ROOT, 'sync_store.json')
INTERVAL = 60  # 每 60 秒重新抓取一次

# ---------- 云端同步持久化（GitHub 文件为主，本地文件回退） ----------
# Render 临时盘会在重启/部署时清空，所以同步数据持久化到 GitHub 仓库文件，
# 跨设备/跨部署都能拉到同一份。无 GH_TOKEN 时回退到本地 sync_store.json。
GITHUB_REPO = 'Jamie-666-H/cute-news-backend'
GITHUB_SYNC_PATH = 'sync_store.json'
GH_TOKEN = os.environ.get('GH_TOKEN')


def _gh_get():
    if not GH_TOKEN:
        return None, None
    try:
        url = 'https://api.github.com/repos/%s/contents/%s' % (GITHUB_REPO, GITHUB_SYNC_PATH)
        req = urllib.request.Request(url, headers={
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'cute-sync',
            'Authorization': 'Bearer ' + GH_TOKEN,
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read().decode('utf-8', 'ignore'))
        if 'content' not in j:
            return None, None
        text = base64.b64decode(j['content']).decode('utf-8', 'ignore')
        return json.loads(text), j.get('sha')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        return None, None
    except Exception:
        return None, None


def _gh_put(store):
    if not GH_TOKEN:
        return False
    for attempt in range(2):
        try:
            remote, sha = _gh_get()
            if not isinstance(remote, dict):
                remote = {}
            merged = dict(remote)
            for k, v in store.items():
                if k in merged and isinstance(merged[k], dict) and isinstance(v, dict):
                    merged[k] = merge_data(merged[k], v)  # 本地刚推送的优先
                else:
                    merged[k] = v
            content = base64.b64encode(json.dumps(merged, ensure_ascii=False).encode('utf-8')).decode('ascii')
            body = {'message': 'sync update', 'content': content}
            if sha:
                body['sha'] = sha
            url = 'https://api.github.com/repos/%s/contents/%s' % (GITHUB_REPO, GITHUB_SYNC_PATH)
            req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), headers={
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'cute-sync',
                'Authorization': 'Bearer ' + GH_TOKEN,
            }, method='PUT')
            urllib.request.urlopen(req, timeout=15).read()
            return True
        except urllib.error.HTTPError as e:
            if e.code == 409 and attempt == 0:
                continue  # 并发冲突，重试一次
            return False
        except Exception:
            return False
    return False


# ---------- Web Push 每日提醒（固定事项到点自动弹系统通知，不用打开 App） ----------
# 依赖 pywebpush（见 requirements.txt）。VAPID 私钥优先读环境变量 VAPID_PRIVATE，
# 未配置时回退到内置硬编码密钥（与前端 VAPID_PUBLIC 配套）。
VAPID_PRIVATE = os.environ.get('VAPID_PRIVATE', 'VxW2gdyFJF3bQ78B7PgVLSoSdriLRiI5wiDyEcYB-7Q')
VAPID_SUBJECT = 'mailto:cute-workbench@example.com'
PUSH_FILE = os.path.join(ROOT, 'push_subs.json')
push_subs = {}          # device -> {subscription, schedule, updated}
push_lock = threading.Lock()
sent_markers = {}       # (date, itemId) -> True，防止同一事项一分钟内重复推送
sent_lock = threading.Lock()

def _aud(sub):
    ep = (sub or {}).get('endpoint', '')
    try:
        u = urlparse(ep)
        return '%s://%s' % (u.scheme, u.netloc)
    except Exception:
        return 'https://fcm.googleapis.com'

def load_push():
    global push_subs
    try:
        if os.path.exists(PUSH_FILE):
            with open(PUSH_FILE, 'r', encoding='utf-8') as f:
                push_subs = json.load(f)
    except Exception:
        push_subs = {}

def save_push():
    try:
        with open(PUSH_FILE, 'w', encoding='utf-8') as f:
            json.dump(push_subs, f, ensure_ascii=False)
    except Exception:
        pass

def send_push(sub, title, body, url='/'):
    if not webpush:
        return False
    try:
        webpush(
            subscription_info=sub,
            data=json.dumps({'title': title, 'body': body, 'url': url}, ensure_ascii=False),
            vapid_private_key=VAPID_PRIVATE,
            vapid_claims={'sub': VAPID_SUBJECT, 'aud': _aud(sub)},
        )
        return True
    except WebPushException as e:
        try:
            if e.response and e.response.status_code in (404, 410):
                return 'expired'
        except Exception:
            pass
        return False
    except Exception:
        return False

def broadcast(title, body, url='/'):
    expired = []
    with push_lock:
        items = list(push_subs.items())
    for dev, rec in items:
        sub = (rec or {}).get('subscription')
        if not sub:
            continue
        r = send_push(sub, title, body, url)
        if r == 'expired':
            expired.append(dev)
    if expired:
        with push_lock:
            for d in expired:
                push_subs.pop(d, None)
        save_push()

def push_scheduler():
    """每 30 秒检查固定事项提醒时间；到点（及迟到 5 分钟内）向所有订阅设备推送。"""
    while True:
        try:
            now = time.localtime()
            today = time.strftime('%Y-%m-%d', now)
            cm = now.tm_hour * 60 + now.tm_min
            with push_lock:
                sched = []
                for dev, rec in push_subs.items():
                    for it in (rec.get('schedule') or []):
                        t = it.get('time') or ''
                        if len(t) >= 5:
                            try:
                                tm = int(t[0:2]) * 60 + int(t[3:5])
                            except Exception:
                                continue
                            if tm == cm or (tm < cm <= tm + 5):
                                sched.append(it)
            if sched:
                with sent_lock:
                    due = [it for it in sched if (today, it.get('id')) not in sent_markers]
                for it in due:
                    broadcast('🔔 该做啦：' + (it.get('text') or '今日事项'),
                              '到时间咯，今天也要加油呀～ 🌸', '/')
                    with sent_lock:
                        sent_markers[(today, it.get('id'))] = True
            with sent_lock:
                for k in [k for k in sent_markers if k[0] != today]:
                    sent_markers.pop(k, None)
        except Exception:
            pass
        time.sleep(30)

cache = {'updated': '', 'items': []}
cache_lock = threading.Lock()

sync_store = {}
sync_lock = threading.Lock()


def load_sync():
    global sync_store
    # 优先从 GitHub 拉（持久、跨部署/重启）
    if GH_TOKEN:
        data, _ = _gh_get()
        if isinstance(data, dict):
            sync_store = data
            return
    # 回退本地文件
    try:
        if os.path.exists(SYNC_FILE):
            with open(SYNC_FILE, 'r', encoding='utf-8') as f:
                sync_store = json.load(f)
            return
    except Exception:
        pass
    sync_store = {}


def save_sync():
    # 回退本地临时文件
    try:
        with open(SYNC_FILE, 'w', encoding='utf-8') as f:
            json.dump(sync_store, f, ensure_ascii=False)
    except Exception:
        pass
    # 主存储 GitHub（持久）
    if GH_TOKEN:
        try:
            _gh_put(sync_store)
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


# ---------- 实时阅读源（多源保底，每次现抓、互不重复） ----------
# 浏览器直连第三方网站会被 CORS 拦截，所以由后端代抓，再带 CORS 原样吐给前端。
# 任一源可用即返回；全部故障才返回 ok:false，前端回退到内置离线库。
READING_RECENT = deque(maxlen=20)
READING_LOCK = threading.Lock()
_READ_UA = {'User-Agent': 'Mozilla/5.0 (compatible; cute-workbench/1.0)'}

def _http_text(url, timeout=9):
    req = urllib.request.Request(url, headers=_READ_UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', 'ignore')

def _strip_html(html):
    html = re.sub(r'<script.*?</script>', '', html, flags=re.S | re.I)
    html = re.sub(r'<style.*?</style>', '', html, flags=re.S | re.I)
    text = re.sub(r'<[^>]+>', '', html)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&[a-z]+;', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def _src_meiriyiwen():
    """每日一文：随机一篇完整中文美文（真实网站，无限、不重复）。"""
    obj = json.loads(_http_text('https://interface.meiriyiwen.com/article/random?dev=1', 10))
    content = _strip_html(obj.get('content', '') or '')
    title = (obj.get('title') or '每日一文').strip()
    if len(content) < 80:
        return None
    return {'id': 'myw-' + str(obj.get('date', '') or title), 'title': title,
            'author': (obj.get('author') or '').strip(), 'src': '每日一文',
            'lang': 'zh', 'en': '', 'zh': content[:2200], 'link': ''}

def _src_jinrishici():
    """今日诗词：随机一首古诗词（含出处）。"""
    obj = json.loads(_http_text('https://v2.jinrishici.com/one.json', 9))
    if obj.get('status') != 'success':
        return None
    d = obj['data']
    content = (d.get('content') or '').strip()
    origin = d.get('origin') or {}
    otitle = (origin.get('title') or '').strip()
    oauthor = (origin.get('author') or '').strip()
    ocontent = ''.join(origin.get('content') or [])
    zh = content
    if otitle:
        zh += '\n——《' + otitle + '》' + (oauthor and (' ' + oauthor) or '')
    if ocontent:
        zh += '\n' + ocontent
    if len(zh) < 8:
        return None
    return {'id': 'jrs-' + str(d.get('id') or content), 'title': (otitle or '今日诗词'),
            'author': oauthor, 'src': '古诗文', 'lang': 'zh',
            'en': '', 'zh': zh[:1600], 'link': ''}

def _src_hitokoto():
    """一言：文学/哲学/诗词等分类的随机句子（保底源，沙箱已验证稳定）。"""
    cats = 'd,e,h,i,j,k'  # 文学/原创/影视/诗词/网易云/哲学
    obj = json.loads(_http_text('https://v1.hitokoto.cn/?c=' + cats, 9))
    hit = (obj.get('hitokoto') or '').strip()
    if len(hit) < 6:
        return None
    frm = (obj.get('from') or '').strip()
    who = (obj.get('from_who') or '').strip()
    return {'id': 'hk-' + str(obj.get('id') or hit), 'title': (frm or '一言'),
            'author': who or frm, 'src': '一言', 'lang': 'zh',
            'en': '', 'zh': hit, 'link': ''}

def _src_ted():
    """TED 最新演讲 RSS：英文摘要（真实网站，无限、不重复）。"""
    data = _http_text('https://pa.tedcdn.com/talks/rss', 10)
    items = re.findall(r'<item>(.*?)</item>', data, flags=re.S)
    if not items:
        return None
    it = random.choice(items)
    def _cd(field):
        m = re.search(r'<%s>(?:<!\[CDATA\[(.*?)\]\]>)?(.*?)</%s>' % (field, field), it, flags=re.S)
        return (m.group(1) or m.group(2) or '').strip() if m else ''
    title = _cd('title') or 'TED'
    desc = _strip_html(_cd('description'))
    link = _cd('link')
    if len(desc) < 80:
        return None
    return {'id': 'ted-' + re.sub(r'\W+', '', title)[:40], 'title': title,
            'author': 'TED', 'src': 'TED', 'lang': 'en',
            'en': desc[:1800], 'zh': '', 'link': link}

_READ_SOURCES = {
    'ted':   [_src_ted],
    'essay': [_src_meiriyiwen, _src_jinrishici, _src_hitokoto],
    'all':   [_src_meiriyiwen, _src_jinrishici, _src_ted, _src_hitokoto],
}

def get_reading(kind):
    order = _READ_SOURCES.get(kind, _READ_SOURCES['all'])
    order = order[:]
    random.shuffle(order)
    last = None
    for fn in order:
        try:
            item = fn()
        except Exception:
            continue
        if not item or not (item.get('zh') or item.get('en')):
            continue
        last = item
        with READING_LOCK:
            if item['id'] in READING_RECENT:
                continue
            READING_RECENT.append(item['id'])
        return item
    return last  # 全部都撞上最近重复时，仍返回一篇，保证不空


# ---------- 实时天气（按定位经纬度，后端代抓，前端走同源调用，避开 CORS） ----------
# 浏览器直连 open-meteo 在国内手机网络不稳定且可能受 CORS 限制；由后端（Render 美国节点）
# 代抓 open-meteo 实时天气 + BigDataCloud 反向地理编码，再同源吐给前端。带 10 分钟网格缓存。
WEATHER_CACHE = {}
WEATHER_CACHE_LOCK = threading.Lock()
WEATHER_TTL = 600  # 10 分钟

WMO = {
    0: ('☀️', '晴'), 1: ('🌤️', '晴间多云'), 2: ('⛅', '多云'), 3: ('☁️', '阴'),
    45: ('🌫️', '雾'), 48: ('🌫️', '雾'),
    51: ('🌦️', '毛毛雨'), 53: ('🌦️', '毛毛雨'), 55: ('🌦️', '毛毛雨'),
    56: ('🌧️', '冻雨'), 57: ('🌧️', '冻雨'),
    61: ('🌧️', '小雨'), 63: ('🌧️', '中雨'), 65: ('🌧️', '大雨'),
    66: ('🌨️', '冻雨'), 67: ('🌨️', '冻雨'),
    71: ('🌨️', '小雪'), 73: ('🌨️', '中雪'), 75: ('🌨️', '大雪'), 77: ('🌨️', '雪粒'),
    80: ('🌦️', '阵雨'), 81: ('🌦️', '阵雨'), 82: ('🌦️', '强阵雨'),
    85: ('🌨️', '阵雪'), 86: ('🌨️', '阵雪'),
    95: ('⛈️', '雷阵雨'), 96: ('⛈️', '雷阵雨'), 99: ('⛈️', '雷阵雨'),
}

def get_weather(lat, lon):
    key = (round(lat, 1), round(lon, 1))  # 0.1 度网格，避免同一城市频繁请求
    now = time.time()
    with WEATHER_CACHE_LOCK:
        c = WEATHER_CACHE.get(key)
        if c and now - c[0] < WEATHER_TTL:
            return c[1]
    try:
        wurl = ('https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f'
                '&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto' % (lat, lon))
        wj = json.loads(_http_text(wurl, 10))
        cur = wj.get('current', {})
        code = int(cur.get('weather_code', 0))
        temp = cur.get('temperature_2m')
        emoji, desc = WMO.get(code, ('🌡️', '未知'))
        # 城市名改由前端用 BigDataCloud 的 CORS 接口按经纬度反查（Render 美国节点连不通该服务）
        result = {'ok': True, 'temp': temp, 'code': code, 'emoji': emoji, 'desc': desc}
    except Exception as e:
        result = {'ok': False, 'error': str(e)[:80]}
    with WEATHER_CACHE_LOCK:
        WEATHER_CACHE[key] = (now, result)
    return result


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
        if p in ('/api/reading', '/api/reading/'):
            rk = parse_qs(urlparse(self.path).query).get('type', ['all'])[0]
            if rk not in ('all', 'essay', 'ted'):
                rk = 'all'
            item = get_reading(rk)
            if item:
                self._send_json(200, {'ok': True, **item})
            else:
                self._send_json(200, {'ok': False, 'error': 'no_source'})
            return
        if p in ('/api/weather', '/api/weather/'):
            qs = parse_qs(urlparse(self.path).query)
            try:
                lat = float(qs.get('lat', [''])[0])
                lon = float(qs.get('lon', [''])[0])
            except (ValueError, IndexError):
                self._send_json(400, {'ok': False, 'error': 'missing lat/lon'})
                return
            self._send_json(200, get_weather(lat, lon))
            return
        if p in ('/api/ping', '/api/ping/'):
            self._send_json(200, {'ok': True})
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
        if p in ('/api/push/subscribe', '/api/push/subscribe/'):
            self._post_push('subscribe')
            return
        if p in ('/api/push/schedule', '/api/push/schedule/'):
            self._post_push('schedule')
            return
        if p in ('/api/push/unsubscribe', '/api/push/unsubscribe/'):
            self._post_push('unsubscribe')
            return
        if p in ('/api/push/test', '/api/push/test/'):
            self._post_push('test')
            return
        self.send_response(405)
        self.end_headers()
        self.wfile.write(b'Method Not Allowed')

    def _read_body(self):
        try:
            ln = int(self.headers.get('Content-Length', 0) or 0)
            raw = self.rfile.read(ln) if ln else b''
        except Exception:
            return None
        if len(raw) > 8 * 1024 * 1024:
            return None
        try:
            return json.loads(raw.decode('utf-8')) if raw else {}
        except Exception:
            return None

    def _post_push(self, kind):
        if not HAVE_WEBPUSH:
            self._send_json(200, {'ok': False, 'error': 'push 服务未配置'})
            return
        data = self._read_body()
        if data is None:
            self._send_json(400, {'ok': False, 'error': 'bad body'})
            return
        dev = (data.get('device') or '').strip()
        if kind == 'subscribe':
            sub = data.get('subscription')
            sched = data.get('schedule') or []
            if not dev or not sub:
                self._send_json(400, {'ok': False, 'error': 'missing device/subscription'})
                return
            with push_lock:
                rec = push_subs.get(dev) or {}
                rec['subscription'] = sub
                rec['schedule'] = sched
                rec['updated'] = int(time.time())
                push_subs[dev] = rec
                save_push()
            self._send_json(200, {'ok': True})
            return
        if kind == 'schedule':
            sched = data.get('schedule') or []
            with push_lock:
                rec = push_subs.get(dev) or {}
                if rec.get('subscription'):
                    rec['schedule'] = sched
                    rec['updated'] = int(time.time())
                    push_subs[dev] = rec
                    save_push()
            self._send_json(200, {'ok': True})
            return
        if kind == 'unsubscribe':
            with push_lock:
                push_subs.pop(dev, None)
                save_push()
            self._send_json(200, {'ok': True})
            return
        if kind == 'test':
            broadcast('🔔 测试提醒', '如果看到这条，说明每日提醒已经打通啦 🎉', '/')
            self._send_json(200, {'ok': True, 'sent': len(push_subs)})
            return

    def guess_type(self, path):
        # 确保 PWA 清单 / Service Worker 的 MIME 正确，否则浏览器拒绝安装或注册
        if path.endswith('.webmanifest'):
            return 'application/manifest+json'
        if path.endswith('.json'):
            return 'application/json'
        if path.endswith('.js'):
            return 'text/javascript'
        if path.endswith('.png') or path.endswith('.ico'):
            return 'image/x-icon' if path.endswith('.ico') else 'image/png'
        return super().guess_type(path)

    def end_headers(self):
        # 静态资源不缓存，保证 push 后前端立即更新（API / news.json 自带 no-store，跳过）
        p = self.path.split('?')[0]
        if not p.startswith('/api/') and p != '/news.json':
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    load_sync()
    load_push()
    # 先启动后台抓取循环（首次抓取在后台进行），立即绑定端口，
    # 避免长时间阻塞导致平台（Render 等）健康检查判定启动失败。
    threading.Thread(target=loop, daemon=True).start()
    if HAVE_WEBPUSH:
        threading.Thread(target=push_scheduler, daemon=True).start()
        print('Web Push 调度已启动（固定事项到点自动提醒）')
    print('常驻后端已启动，监听端口', port, '（每', INTERVAL, '秒重新抓取，首抓在后台进行）')
    HTTPServer(('0.0.0.0', port), Handler).serve_forever()
