/* Cloudflare Pages Functions 路由入口：捕获 /api/* 任意路径（含 /api/push/subscribe 多级）。
   用法：请求 /api/news → params.path = ['news']；/api/push/subscribe → ['push','subscribe']。 */
import { setEnv, blobGet, blobSet, crawl, getReading, getWeather, sendPush } from '../_lib.js';

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
  const p = (params.path || []).join('/'); // 例如 'push/subscribe' 或 'sync'
  const method = request.method || 'GET';
  const url = new URL(request.url);
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
