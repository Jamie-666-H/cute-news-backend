/* 共享库：新闻抓取 / 阅读源 / 天气 / Web Push / Netlify Blobs 存储
   被 api.js、news-refresh.js、push-check.js 复用。CommonJS 以便与 web-push 互操作。 */
const webpush = require('web-push');
const { getStore } = require('@netlify/blobs');

/* ---------------- VAPID（Web Push 凭证） ---------------- */
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BGsde9o-MzxqNO0vzu6VPhPq__PNTzqx_GwgNBNvMcTkbQcx3QVtBBIer3qU1tvx3SfwKjZM1rq6YEGpM85wchA';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'VxW2gdyFJF3bQ78B7PgVLSoSdriLRiI5wiDyEcYB-7Q';
const VAPID_SUBJECT = 'mailto:cute-workbench@example.com';
try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) {}

/* ---------------- Netlify Blobs 存储 ---------------- */
function blob(name) { return getStore({ name }); }
async function blobGet(name, key) {
  try { return await blob(name).get(key, { type: 'json' }); } catch (e) { return null; }
}
async function blobSet(name, key, val) {
  try { await blob(name).set(key, JSON.stringify(val)); return true; } catch (e) { console.error('blobSet fail', e && e.message); return false; }
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
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[order[i], order[j]] = [order[j], order[i]]; }
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

/* ---------------- 用户数据合并（云端同步） ---------------- */
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
async function sendPush(sub, title, body, url = '/') {
  if (!sub) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body, url }), {});
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return 'expired';
    return false;
  }
}

module.exports = {
  blobGet, blobSet, crawl, getReading, getWeather, mergeData, sendPush,
  VAPID_PUBLIC, VAPID_PRIVATE
};
