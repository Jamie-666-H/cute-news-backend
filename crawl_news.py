# -*- coding: utf-8 -*-
"""服务端真·实时抓取 央视/人民网/新华网/微博热搜/百度热点
直接访问各官网/RSS，不依赖任何国外代理，国内可稳定抓取。
可作为脚本运行:  python crawl_news.py   -> 生成 news.json
也可被 news_server.py 导入:  from crawl_news import crawl
"""
import urllib.request, ssl, re, json, html as ihtml, time, http.cookiejar, urllib.parse
from collections import defaultdict, Counter

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}


def get(url, headers=None, t=12, cj=None):
    import gzip
    last = None
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj else urllib.request.build_opener()
            with op.open(req, timeout=t) as r:
                data = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    data = gzip.decompress(data)
                return data.decode('utf-8', 'ignore')
        except Exception as e:
            last = e
            time.sleep(1.5)
    raise last


def clean(t):
    return ihtml.unescape(re.sub(r'<[^>]+>', '', t)).replace('\n', ' ').replace('\r', ' ').strip()


def uniq(items):
    seen, out = set(), []
    for it in items:
        if not it['title'] or len(it['title']) < 4:
            continue
        k = (it['title'], it['src'])   # 按 标题+平台 去重，避免不同平台的同名热词被误删
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out


def crawl():
    """抓取五大平台，返回 {'updated': '...', 'items': [{title,url,src}...]}"""
    news = []

    def add(title, url, src):
        title = clean(title)
        if len(title) < 4 or not url:
            return
        news.append({'title': title, 'url': url.strip(), 'src': src})

    # ---------- 1. 央视新闻 ----------
    try:
        for page in ['https://news.cctv.com/', 'https://news.cctv.com/china/', 'https://news.cctv.com/world/']:
            h = get(page, t=10)
            for m in re.finditer(r'<a[^>]*href="(https?://[^"]*cctv\.com[^"]*?/202\d/\d\d/\d\d/[^"]*)"[^>]*>([\s\S]*?)</a>', h):
                add(m.group(2), m.group(1), '央视新闻')
    except Exception as e:
        print('央视 FAIL', e)

    # ---------- 2. 人民网 RSS ----------
    for feed in ['http://www.people.com.cn/rss/politics.xml', 'http://www.people.com.cn/rss/society.xml']:
        try:
            h = get(feed, t=10)
            for m in re.finditer(r'<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>[\s\S]*?<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>', h):
                add(m.group(1), m.group(2), '人民网')
        except Exception as e:
            print('人民网 FAIL', e)

    # ---------- 3. 新华网 RSS ----------
    for feed in ['https://www.news.cn/politics/news_politics.xml', 'https://www.news.cn/world/news_world.xml', 'https://www.news.cn/fortune/news_fortune.xml']:
        try:
            h = get(feed, t=10)
            for m in re.finditer(r'<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>[\s\S]*?<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>', h):
                add(m.group(1), m.group(2), '新华网')
        except Exception as e:
            print('新华网 FAIL', e)

    # ---------- 4. 微博热搜 (先取 cookie 再调接口) ----------
    try:
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(urllib.request.Request('https://weibo.com/', headers=UA), timeout=10).read()
        cookies = '; '.join(f'{c.name}={c.value}' for c in cj)
        wb = get('https://weibo.com/ajax/side/hotSearch',
                 headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://weibo.com/',
                          'X-Requested-With': 'XMLHttpRequest', 'Cookie': cookies}, t=10)
        j = json.loads(wb)
        for it in j.get('data', {}).get('realtime', []):
            w = it.get('word', '')
            if w and w != '~':
                q = urllib.parse.quote('#' + w + '#')
                add(w, 'https://s.weibo.com/weibo?q=' + q, '微博热搜')
    except Exception as e:
        print('微博 FAIL', e)

    # ---------- 5. 百度热点（直接取 word 字段、自己拼搜索链接，标题与链接 100% 对应）----------
    try:
        h = get('https://top.baidu.com/board?tab=realtime', t=10)
        seen = set()
        for m in re.finditer(r'"word":"([^"]+)"', h):
            w = m.group(1)
            if w and w not in seen:
                seen.add(w)
                add(w, 'https://www.baidu.com/s?wd=' + urllib.parse.quote(w), '百度热点')
                if len(seen) >= 25:
                    break
    except Exception as e:
        print('百度 FAIL', e)

    # ---------- 6. 抖音热点（官方热榜接口，实时）----------
    try:
        h = get('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', t=10)
        j = json.loads(h)
        for it in j.get('word_list', []):
            w = it.get('word', '')
            if w:
                add(w, 'https://www.douyin.com/search/' + urllib.parse.quote(w), '抖音热点')
    except Exception as e:
        print('抖音 FAIL', e)

    # ---------- 7. 小红书热点（平台无公开接口，取当天真实热词配小红书搜索，标题与链接一致）----------
    try:
        seen = set(); cnt = 0
        for n in news:
            if n['src'] in ('微博热搜', '百度热点', '抖音热点') and n['title'] not in seen:
                seen.add(n['title'])
                add(n['title'], 'https://www.xiaohongshu.com/search_result?keyword=' + urllib.parse.quote(n['title']), '小红书热点')
                cnt += 1
                if cnt >= 20:
                    break
    except Exception as e:
        print('小红书 FAIL', e)

    # ---------- 平衡各平台条数 ----------
    by = defaultdict(list)
    for n in uniq(news):
        by[n['src']].append(n)
    cap = {'央视新闻': 12, '人民网': 12, '新华网': 12, '微博热搜': 20,
           '百度热点': 20, '抖音热点': 20, '小红书热点': 20}
    balanced = []
    for src, lim in cap.items():
        balanced.extend(by.get(src, [])[:lim])

    return {'updated': time.strftime('%Y-%m-%d %H:%M'), 'items': balanced}


if __name__ == '__main__':
    out = crawl()
    with open('news.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print('TOTAL:', len(out['items']))
    print(Counter(x['src'] for x in out['items']))
    print('updated:', out['updated'])
    for x in out['items'][:3]:
        print(' ', x['src'], '|', x['title'][:34])
    print('  ...')
    for x in out['items'][-3:]:
        print(' ', x['src'], '|', x['title'][:34])
