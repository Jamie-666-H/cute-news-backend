/* Cloudflare Workers + Static Assets 入口
   静态资源由 wrangler.toml [assets] 自动托管；
   /api/* 请求走下面逻辑；其余回退到 env.ASSETS.fetch()。 */
/* 共享库：新闻抓取 / 阅读源 / 天气 / GitHub 存储
   Cloudflare Pages Functions 版（ESM + node_compat）。
   原 Netlify 版中 @netlify/blobs 已弃用，同步数据统一持久化到 GitHub 仓库，
   避免 Cloudflare 多实例无共享内存导致数据丢失。 */

/* ---------------- 运行时环境变量（由 [[path]].js 在请求时注入） ---------------- */
let RUNTIME_ENV = {};
function setEnv(e) {
  RUNTIME_ENV = e || {};
}
function env(key, def) {
  if (RUNTIME_ENV && RUNTIME_ENV[key] !== undefined) return RUNTIME_ENV[key];
  if (typeof process !== 'undefined' && process.env && process.env[key] !== undefined) return process.env[key];
  return def;
}

/* ---------------- VAPID（Web Push 凭证，默认值兜底，建议用环境变量覆盖） ---------------- */
function VAPID_PUBLIC() { return env('VAPID_PUBLIC', 'BGsde9o-MzxqNO0vzu6VPhPq__PNTzqx_GwgNBNvMcTkbQcx3QVtBBIer3qU1tvx3SfwKjZM1rq6YEGpM85wchA'); }
function VAPID_PRIVATE() { return env('VAPID_PRIVATE', 'VxW2gdyFJF3bQ78B7PgVLSoSdriLRiI5wiDyEcYB-7Q'); }

/* ---------------- 用户同步存储（GitHub 持久化，必须配 GH_TOKEN） ----------------
   Cloudflare 多实例无共享内存，同步数据必须落盘到 GitHub 仓库（免费、持久）：
   sync_store.json / push_subs.json，放在独立 data 分支，避免污染 main。 */
function GH_REPO() { return env('GH_REPO', 'Jamie-666-H/cute-news-backend'); }
function GH_TOKEN() { return env('GH_TOKEN', ''); }
function GH_BRANCH() { return env('GH_BRANCH', 'data'); }
const FILE_OF = { 'cute-sync': 'sync_store.json', 'cute-push': 'push_subs.json' };

async function ghGet(path) {
  // 注意：GitHub Contents API 仅在文件 ≤1MB 时内联返回 content；大文件(同步数据常超1MB)必须走 raw 域名
  const url = `https://raw.githubusercontent.com/${GH_REPO()}/${GH_BRANCH()}/${path}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'cute-workbench' } });
  if (!r.ok) return null;
  const text = await r.text();
  return { sha: '', text };
}
async function ghEnsureBranch() {
  const url = `https://api.github.com/repos/${GH_REPO()}/git/refs/heads/${GH_BRANCH()}`;
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + GH_TOKEN(), 'User-Agent': 'cute-workbench', 'Accept': 'application/vnd.github+json' } });
  if (r.ok) return true;
  const main = await fetch(`https://api.github.com/repos/${GH_REPO()}/git/ref/heads/main`, { headers: { 'Authorization': 'Bearer ' + GH_TOKEN(), 'User-Agent': 'cute-workbench', 'Accept': 'application/vnd.github+json' } });
  if (!main.ok) return false;
  const mj = await main.json();
  const sha = mj.object && mj.object.sha; if (!sha) return false;
  const cr = await fetch(`https://api.github.com/repos/${GH_REPO()}/git/refs`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GH_TOKEN(), 'User-Agent': 'cute-workbench', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${GH_BRANCH()}`, sha })
  });
  return cr.ok;
}
// 写入走 Git Data API（blob/tree/commit），突破 Contents API 的 1MB 限制，支持大文件
async function ghPut(path, content, sha) {
  await ghEnsureBranch();
  const repo = GH_REPO(); const branch = GH_BRANCH();
  const api = 'https://api.github.com/repos/' + repo;
  const AUTH = { 'Authorization': 'Bearer ' + GH_TOKEN(), 'User-Agent': 'cute-workbench', 'Accept': 'application/vnd.github+json' };
  try {
    const refR = await fetch(api + '/git/ref/heads/' + branch, { headers: AUTH });
    if (!refR.ok) return false;
    const baseSha = (await refR.json()).object.sha;
    const commitJ = await (await fetch(api + '/git/commits/' + baseSha, { headers: AUTH })).json();
    const baseTree = commitJ.tree.sha;
    const blobJ = await (await fetch(api + '/git/blobs', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: Buffer.from(content, 'utf-8').toString('base64'), encoding: 'base64' }) })).json();
    if (!blobJ.sha) return false;
    const treeJ = await (await fetch(api + '/git/trees', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ base_tree: baseTree, tree: [{ path, mode: '100644', type: 'blob', sha: blobJ.sha }] }) })).json();
    if (!treeJ.sha) return false;
    const newCommitJ = await (await fetch(api + '/git/commits', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'sync: update user data', tree: treeJ.sha, parents: [baseSha] }) })).json();
    if (!newCommitJ.sha) return false;
    const updR = await fetch(api + '/git/refs/heads/' + branch, { method: 'PATCH', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: newCommitJ.sha }) });
    return updR.ok;
  } catch (e) { console.error('ghPut fail', e && e.message); return false; }
}

async function blobGet(name, key) {
  const file = FILE_OF[name];
  if (!GH_TOKEN() || !file) {
    if (!GH_TOKEN()) console.error('[sync] 未配置 GH_TOKEN，无法读取云端数据（数据仅存本地）');
    return null;
  }
  try {
    const f = await ghGet(file);
    if (!f) return null;
    const all = JSON.parse(f.text);
    return all[key] || null;
  } catch (e) { console.error('ghGet fail', name, e && e.message); return null; }
}
async function blobSet(name, key, val) {
  const file = FILE_OF[name];
  if (!GH_TOKEN() || !file) {
    console.error('[sync] 未配置 GH_TOKEN，云端同步不可用（数据仅存本地）');
    return false;
  }
  try {
    const f = await ghGet(file);
    let all = {};
    if (f) { try { all = JSON.parse(f.text); } catch (e) { all = {}; } }
    all[key] = val;
    const str = JSON.stringify(all);
    if (str.length > 9 * 1024 * 1024) { console.error('store too large, skip', name); return false; }
    return await ghPut(file, str, f && f.sha);
  } catch (e) { console.error('ghPut fail', name, e && e.message); return false; }
}

/* ---------------- 通用抓取工具 ---------------- */
function unescapeHtml(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, '');
}
function clean(t) {
  return unescapeHtml((t || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
async function fetchText(url, { timeout = 8000, headers = {} } = {}) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    const text = await r.text();
    return { ok: true, text, cookie: (r.headers.get('set-cookie') || '') };
  } catch (e) {
    return { ok: false, error: e && e.message };
  } finally {
    clearTimeout(id);
  }
}
function uniq(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.title || it.title.length < 4) continue;
    const k = it.title + '|' + it.src;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/* ---------------- 新闻抓取（并行各源，压在 10s 内） ---------------- */
async function secCctv() {
  const out = [];
  const pages = ['https://news.cctv.com/', 'https://news.cctv.com/china/', 'https://news.cctv.com/world/'];
  for (const page of pages) {
    const { ok, text } = await fetchText(page, { timeout: 7000 });
    if (!ok) continue;
    const re = /<a[^>]*href="(https?:\/\/[^"]*cctv\.com[^"]*?\/202\d\/\d\d\/\d\d\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(text))) { const title = clean(m[2]); const url = m[1]; if (title.length >= 4 && url) out.push({ title, url, src: '央视新闻' }); }
  }
  return out;
}
async function secPeople() {
  const out = [];
  const feeds = ['http://www.people.com.cn/rss/politics.xml', 'http://www.people.com.cn/rss/society.xml'];
  for (const feed of feeds) {
    const { ok, text } = await fetchText(feed, { timeout: 7000 });
    if (!ok) continue;
    const re = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/g;
    let m;
    while ((m = re.exec(text))) { const title = clean(m[1]); const url = clean(m[2]); if (title.length >= 4 && url) out.push({ title, url, src: '人民网' }); }
  }
  return out;
}
async function secXinhua() {
  const out = [];
  const feeds = ['https://www.news.cn/politics/news_politics.xml', 'https://www.news.cn/world/news_world.xml', 'https://www.news.cn/fortune/news_fortune.xml'];
  for (const feed of feeds) {
    const { ok, text } = await fetchText(feed, { timeout: 7000 });
    if (!ok) continue;
    const re = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/g;
    let m;
    while ((m = re.exec(text))) { const title = clean(m[1]); const url = clean(m[2]); if (title.length >= 4 && url) out.push({ title, url, src: '新华网' }); }
  }
  return out;
}
async function secWeibo() {
  const out = [];
  const r0 = await fetchText('https://weibo.com/', { timeout: 7000 });
  const cookie = r0.cookie || '';
  const { ok, text } = await fetchText('https://weibo.com/ajax/side/hotSearch', {
    timeout: 7000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://weibo.com/', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': cookie }
  });
  if (!ok) return out;
  let j; try { j = JSON.parse(text); } catch (e) { return out; }
  for (const it of (j.data && j.data.realtime) || []) {
    const w = it.word;
    if (w && w !== '~') { const q = encodeURIComponent('#' + w + '#'); out.push({ title: w, url: 'https://s.weibo.com/weibo?q=' + q, src: '微博热搜' }); }
  }
  return out;
}
async function secBaidu() {
  const out = []; const seen = new Set();
  const { ok, text } = await fetchText('https://top.baidu.com/board?tab=realtime', { timeout: 7000 });
  if (!ok) return out;
  const re = /"word":"([^"]+)"/g; let m; let cnt = 0;
  while ((m = re.exec(text))) {
    const w = m[1];
    if (w && !seen.has(w)) { seen.add(w); out.push({ title: w, url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(w), src: '百度热点' }); if (++cnt >= 25) break; }
  }
  return out;
}
async function secDouyin() {
  const out = [];
  const { ok, text } = await fetchText('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', { timeout: 7000 });
  if (!ok || !text) return out;
  let j; try { j = JSON.parse(text); } catch (e) { return out; }
  for (const it of (j.word_list || [])) { const w = it.word; if (w) out.push({ title: w, url: 'https://www.douyin.com/search/' + encodeURIComponent(w), src: '抖音热点' }); }
  return out;
}
function xhsClean(u) {
  if (/xiaohongshu\.com|xhslink\.com/.test(u)) { const m = /keyword=([^&]+)/.exec(u); if (m) return 'https://www.xiaohongshu.com/search_result?keyword=' + m[1]; }
  return u;
}
async function secXhs() {
  const out = [];
  let { ok, text } = await fetchText('https://60s.viki.moe/v2/rednote', { timeout: 9000 });
  let data = null;
  if (ok) { try { data = JSON.parse(text).data || []; } catch (e) { data = null; } }
  if (data && data.length) {
    let cnt = 0;
    for (const it of data) {
      const t = (it.title || it.word || '').trim();
      const u = it.link || it.url || '';
      const hot = it.score || it.hot_value || null;
      if (t && u) { out.push({ title: t, url: xhsClean(u), src: '小红书热点', hot }); if (++cnt >= 20) break; }
    }
  }
  if (out.length === 0) {
    const r2 = await fetchText('https://uapis.cn/api/v1/misc/hotboard?type=xiaohongshu', { timeout: 9000 });
    if (r2.ok) {
      try {
        const d = JSON.parse(r2.text).list || [];
        for (const it of d) { const t = (it.title || it.word || '').trim(); const u = it.url || it.link || ''; const hot = it.hot_value || it.score || null; if (t && u) out.push({ title: t, url: xhsClean(u), src: '小红书热点', hot }); }
      } catch (e) {}
    }
  }
  return out;
}
async function crawl() {
  const sections = [secCctv, secPeople, secXinhua, secWeibo, secBaidu, secDouyin, secXhs];
  const results = await Promise.allSettled(sections.map(s => s()));
  let news = [];
  results.forEach(r => { if (r.status === 'fulfilled') news = news.concat(r.value); });
  news = uniq(news);
  const by = {};
  for (const n of news) (by[n.src] = by[n.src] || []).push(n);
  const cap = { '央视新闻': 12, '人民网': 12, '新华网': 12, '微博热搜': 20, '百度热点': 20, '抖音热点': 20, '小红书热点': 20 };
  const balanced = [];
  for (const src of Object.keys(cap)) balanced.push(...(by[src] || []).slice(0, cap[src]));
  return { updated: new Date().toLocaleString('zh-CN', { hour12: false }), items: balanced };
}

/* ---------------- 每日阅读源（多源保底） ---------------- */
async function srcMeiriyiwen() {
  const { ok, text } = await fetchText('https://interface.meiriyiwen.com/article/random?dev=1', { timeout: 9000 });
  if (!ok) return null;
  let obj; try { obj = JSON.parse(text); } catch (e) { return null; }
  const content = clean(obj.content || '');
  const title = (obj.title || '每日一文').trim();
  if (content.length < 80) return null;
  return { id: 'myw-' + (obj.date || title), title, author: (obj.author || '').trim(), src: '每日一文', lang: 'zh', en: '', zh: content.slice(0, 2200), link: '' };
}
async function srcJinrishici() {
  const { ok, text } = await fetchText('https://v2.jinrishici.com/one.json', { timeout: 8000 });
  if (!ok) return null;
  let obj; try { obj = JSON.parse(text); } catch (e) { return null; }
  if (obj.status !== 'success') return null;
  const d = obj.data;
  const content = (d.content || '').trim();
  const origin = d.origin || {};
  const otitle = (origin.title || '').trim();
  const oauthor = (origin.author || '').trim();
  const ocontent = (origin.content || []).join('');
  let zh = content;
  if (otitle) zh += '\n——《' + otitle + '》' + (oauthor ? ' ' + oauthor : '');
  if (ocontent) zh += '\n' + ocontent;
  if (zh.length < 8) return null;
  return { id: 'jrs-' + (d.id || content), title: (otitle || '今日诗词'), author: oauthor, src: '古诗文', lang: 'zh', en: '', zh: zh.slice(0, 1600), link: '' };
}
async function srcHitokoto() {
  const cats = 'd,e,h,i,j,k';
  const { ok, text } = await fetchText('https://v1.hitokoto.cn/?c=' + cats, { timeout: 8000 });
  if (!ok) return null;
  let obj; try { obj = JSON.parse(text); } catch (e) { return null; }
  const hit = (obj.hitokoto || '').trim();
  if (hit.length < 6) return null;
  const frm = (obj.from || '').trim();
  const who = (obj.from_who || '').trim();
  return { id: 'hk-' + (obj.id || hit), title: (frm || '一言'), author: who || frm, src: '一言', lang: 'zh', en: '', zh: hit, link: '' };
}
async function srcTed() {
  const { ok, text } = await fetchText('https://pa.tedcdn.com/talks/rss', { timeout: 9000 });
  if (!ok) return null;
  const items = (text.match(/<item>[\s\S]*?<\/item>/g) || []);
  if (!items.length) return null;
  const it = items[Math.floor(Math.random() * items.length)];
  const cd = (field) => {
    const m = new RegExp('<' + field + '>(?:<\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</' + field + '>', 's').exec(it);
    return m ? (m[1] || m[2] || '').trim() : '';
  };
  const title = cd('title') || 'TED';
  const desc = clean(cd('description'));
  const link = cd('link');
  if (desc.length < 80) return null;
  return { id: 'ted-' + (title.replace(/\W+/g, '').slice(0, 40)), title, author: 'TED', src: 'TED', lang: 'en', en: desc.slice(0, 1800), zh: '', link };
}
const READ_SOURCES = {
  ted: [srcTed],
  essay: [srcMeiriyiwen, srcJinrishici, srcHitokoto],
  all: [srcMeiriyiwen, srcJinrishici, srcTed, srcHitokoto]
};
async function getReading(kind) {
  const order = (READ_SOURCES[kind] || READ_SOURCES.all).slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let last = null;
  for (const fn of order) {
    try { const item = await fn(); if (item && (item.zh || item.en)) { last = item; return item; } } catch (e) {}
  }
  return last;
}

/* ---------------- 天气（open-meteo） ---------------- */
const WMO = {
  0: ['☀️', '晴'], 1: ['🌤️', '晴间多云'], 2: ['⛅', '多云'], 3: ['☁️', '阴'],
  45: ['🌫️', '雾'], 48: ['🌫️', '雾'],
  51: ['🌦️', '毛毛雨'], 53: ['🌦️', '毛毛雨'], 55: ['🌦️', '毛毛雨'],
  56: ['🌧️', '冻雨'], 57: ['🌧️', '冻雨'],
  61: ['🌧️', '小雨'], 63: ['🌧️', '中雨'], 65: ['🌧️', '大雨'],
  66: ['🌨️', '冻雨'], 67: ['🌨️', '冻雨'],
  71: ['🌨️', '小雪'], 73: ['🌨️', '中雪'], 75: ['🌨️', '大雪'], 77: ['🌨️', '雪粒'],
  80: ['🌦️', '阵雨'], 81: ['🌦️', '阵雨'], 82: ['🌦️', '强阵雨'],
  85: ['🌨️', '阵雪'], 86: ['🌨️', '阵雪'],
  95: ['⛈️', '雷阵雨'], 96: ['⛈️', '雷阵雨'], 99: ['⛈️', '雷阵雨']
};
async function getWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
    const { ok, text } = await fetchText(url, { timeout: 10000 });
    if (!ok) return { ok: false, error: 'fetch failed' };
    const wj = JSON.parse(text);
    const cur = wj.current || {};
    const code = parseInt(cur.weather_code || 0, 10);
    const temp = cur.temperature_2m;
    const [emoji, desc] = WMO[code] || ['🌡️', '未知'];
    return { ok: true, temp, code, emoji, desc };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 用户数据合并（云端同步，合并逻辑仍在客户端完成） ---------------- */
function mergeValue(lv, rv) {
  if (rv && typeof rv === 'object' && !Array.isArray(rv) && lv && typeof lv === 'object' && !Array.isArray(lv)) {
    const out = Object.assign({}, lv);
    for (const k in rv) out[k] = mergeValue(out[k], rv[k]);
    return out;
  }
  if (Array.isArray(rv) && Array.isArray(lv)) {
    const m = {};
    const key = x => (x && typeof x === 'object' && 'id' in x) ? String(x.id) : JSON.stringify(x);
    for (const x of lv) m[key(x)] = x;
    for (const x of rv) m[key(x)] = x; // 远端优先
    return Object.values(m);
  }
  return rv !== undefined ? rv : lv;
}
function mergeData(local, remote) {
  local = local || {}; remote = remote || {};
  const out = mergeValue(local, remote);
  out.updated = Math.max(parseInt(local.updated || 0, 10), parseInt(remote.updated || 0, 10));
  return out;
}

/* ---------------- Web Push 发送 ---------------- */
/* ---------------- Web Push 发送 ----------------
   注意：Cloudflare Workers 运行时无法打包 Node 的 web-push（依赖 https 模块），
   故此处不再引入该依赖。订阅数据仍由 /api/push/* 正常存储，便于后续用
   WebCrypto+VAPID 或外部调度器实现真正的到点提醒。当前发送优雅降级返回 false。 */
async function sendPush(sub, title, body, url = '/') {
  // 暂未启用服务端推送（Workers 免费档无 Cron，且需改用 WebCrypto 实现 VAPID）
  return false;
}



/* ---------------- API 路由入口（原 Pages Functions [[path]].js） ---------------- */
/* Cloudflare Pages Functions 路由入口：捕获 /api/* 任意路径（含 /api/push/subscribe 多级）。
   用法：请求 /api/news → params.path = ['news']；/api/push/subscribe → ['push','subscribe']。 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(code, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS, extra || {})
  });
}
function parseBody(req) {
  return req.text().then(t => { try { return t ? JSON.parse(t) : {}; } catch (e) { return null; } });
}
function isPing() { return false; }

export async function onRequest(context) {
  const { request, params, env } = context;
  setEnv(env); // 注入 Cloudflare 环境变量
  const url = new URL(request.url);
  const pathParts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const p = pathParts.join('/'); // 例如 'push/subscribe' 或 'sync'
  const method = request.method || 'GET';
  const q = Object.fromEntries(url.searchParams.entries());

  if (method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  /* ---- 健康检查 ---- */
  if (p === 'ping') return json(200, { ok: true });

  /* ---- 新闻 ---- */
  if (p === 'news') {
    const cached = await blobGet('cute-news', 'latest');
    if (cached && (Date.now() - (cached._ts || 0) < 15 * 60 * 1000)) return json(200, cached);
    try {
      const out = await Promise.race([crawl(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))]);
      out._ts = Date.now();
      await blobSet('cute-news', 'latest', out);
      return json(200, out);
    } catch (e) {}
    if (cached) return json(200, cached);
    try {
      const r = await fetch(new URL('/news.json', url));
      if (r.ok) { const j = await r.json(); j._ts = Date.now(); return json(200, j); }
    } catch (e) {}
    return json(200, { updated: '', items: [] });
  }

  /* ---- 每日阅读 ---- */
  if (p === 'reading') {
    const kind = ['all', 'essay', 'ted'].includes(q.type) ? q.type : 'all';
    const item = await getReading(kind);
    if (item) return json(200, Object.assign({ ok: true }, item));
    return json(200, { ok: false, error: 'no_source' });
  }

  /* ---- 天气 ---- */
  if (p === 'weather') {
    const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
    if (isNaN(lat) || isNaN(lon)) return json(400, { ok: false, error: 'missing lat/lon' });
    return json(200, await getWeather(lat, lon));
  }

  /* ---- 云端同步 ---- */
  if (p === 'sync') {
    const key = q.key || '';
    if (!key) return json(400, { error: 'missing key' });
    if (method === 'GET') {
      const rec = await blobGet('cute-sync', key);
      return json(200, rec || { updated: 0, data: null });
    }
    if (method === 'POST') {
      const data = await parseBody(request);
      if (data === null) return json(400, { error: 'bad json' });
      if (JSON.stringify(data).length > 8 * 1024 * 1024) return json(413, { error: 'payload too large (max 8MB)' });
      const store = { updated: parseInt(data.updated || 0, 10), data: data.data };
      const ok = await blobSet('cute-sync', key, store);
      if (!ok) return json(200, { ok: false, note: '云端未配置 GH_TOKEN，本次仅本地保存' });
      return json(200, store);
    }
    return json(405, { error: 'method not allowed' });
  }

  /* ---- Web Push ---- */
  if (p.startsWith('push/')) {
    const kind = p.slice('push/'.length);
    if (kind === 'subscribe') {
      const data = await parseBody(request);
      if (data === null) return json(400, { ok: false, error: 'bad body' });
      const dev = (data.device || '').trim();
      if (!dev || !data.subscription) return json(400, { ok: false, error: 'missing device/subscription' });
      const subs = (await blobGet('cute-push', 'subs')) || {};
      const rec = subs[dev] || {};
      rec.subscription = data.subscription;
      rec.schedule = data.schedule || [];
      rec.updated = Date.now();
      subs[dev] = rec;
      await blobSet('cute-push', 'subs', subs);
      return json(200, { ok: true });
    }
    if (kind === 'schedule') {
      const data = await parseBody(request);
      const dev = (data && data.device || '').trim();
      const subs = (await blobGet('cute-push', 'subs')) || {};
      if (subs[dev] && subs[dev].subscription) {
        subs[dev].schedule = (data && data.schedule) || [];
        subs[dev].updated = Date.now();
        await blobSet('cute-push', 'subs', subs);
      }
      return json(200, { ok: true });
    }
    if (kind === 'unsubscribe') {
      const data = await parseBody(request);
      const dev = (data && data.device || '').trim();
      const subs = (await blobGet('cute-push', 'subs')) || {};
      delete subs[dev];
      await blobSet('cute-push', 'subs', subs);
      return json(200, { ok: true });
    }
    if (kind === 'test') {
      const subs = (await blobGet('cute-push', 'subs')) || {};
      let sent = 0; const expired = [];
      for (const [dev, rec] of Object.entries(subs)) {
        const r = await sendPush(rec && rec.subscription, '🔔 测试提醒', '如果看到这条，说明每日提醒已经打通啦 🎉', '/');
        if (r === 'expired') expired.push(dev);
        else if (r) sent++;
      }
      for (const d of expired) delete subs[d];
      if (expired.length) await blobSet('cute-push', 'subs', subs);
      return json(200, { ok: true, sent });
    }
    return json(404, { ok: false, error: 'unknown push route' });
  }

  return new Response('Not Found', { status: 404, headers: CORS });
}


/* ---------------- Workers 入口 ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return onRequest({ request, env, params: {} });
    }
    return env.ASSETS.fetch(request);
  }
};
