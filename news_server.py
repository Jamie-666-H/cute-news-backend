# -*- coding: utf-8 -*-
"""常驻后端：一直运行，每 60 秒重新抓取五大平台新闻，同时托管整个 App + 实时接口。
- 访问 /             -> 打开「我的小天地」工作台
- 访问 /news.json    -> 同域静态文件（后端每 60 秒重写，天然新鲜）
- 访问 /api/news     -> 实时 JSON {updated, items}（带 CORS，便于跨域调试）
运行:  python news_server.py   （可用 PORT 环境变量指定端口，默认 3000）
依赖:  仅 Python 标准库，无需 pip install。
"""
import os, sys, threading, time, json
from http.server import HTTPServer, SimpleHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crawl_news import crawl

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(ROOT, 'news.json')
INTERVAL = 60  # 每 60 秒重新抓取一次

cache = {'updated': '', 'items': []}
cache_lock = threading.Lock()


def refresh():
    global cache
    try:
        out = crawl()
        with cache_lock:
            cache = out
        # 持久化，方便静态服务 / 进程重启后有近期数据
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
        return super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    # 先启动后台抓取循环（首次抓取在后台进行），立即绑定端口，
    # 避免长时间阻塞导致平台（Render 等）健康检查判定启动失败。
    threading.Thread(target=loop, daemon=True).start()
    print('常驻后端已启动，监听端口', port, '（每', INTERVAL, '秒重新抓取，首抓在后台进行）')
    HTTPServer(('0.0.0.0', port), Handler).serve_forever()
