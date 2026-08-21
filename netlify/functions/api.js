/* 主 API 路由：/api/news、/api/reading、/api/weather、/api/sync、/api/ping、/api/push/*
   通过 netlify.toml 的 /api/* 重定向到这里，event.path = /.netlify/functions/api/<splat> */
const { blobGet, blobSet, crawl, getReading, getWeather, mergeData, sendPush } = require('./_lib');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function json(code, obj, extra) {
  return { statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS, extra || {}), body: JSON.stringify(obj) };
}
function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch (e) { return null; }
}

exports.handler = async (event) => {
  const p = (event.path || '').replace('/.netlify/functions/api', '') || '/';
  const method = event.httpMethod || 'GET';
  const q = event.queryStringParameters || {};

  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  /* ---- 健康检查 ---- */
  if (p === '/ping') return json(200, { ok: true });

  /* ---- 新闻：优先缓存，过期则即时重抓（压 9s），兜底静态 news.json ---- */
  if (p === '/news') {
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
      const r = await fetch('https://' + (event.headers && event.headers.host) + '/news.json');
      if (r.ok) { const j = await r.json(); j._ts = Date.now(); return json(200, j); }
    } catch (e) {}
    return json(200, { updated: '', items: [] });
  }

  /* ---- 每日阅读 ---- */
  if (p === '/reading') {
    const kind = ['all', 'essay', 'ted'].includes(q.type) ? q.type : 'all';
    const item = await getReading(kind);
    if (item) return json(200, Object.assign({ ok: true }, item));
    return json(200, { ok: false, error: 'no_source' });
  }

  /* ---- 天气 ---- */
  if (p === '/weather') {
    const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
    if (isNaN(lat) || isNaN(lon)) return json(400, { ok: false, error: 'missing lat/lon' });
    return json(200, await getWeather(lat, lon));
  }

  /* ---- 云端同步 ---- */
  if (p === '/sync') {
    const key = q.key || '';
    if (!key) return json(400, { error: 'missing key' });
    if (method === 'GET') {
      const rec = await blobGet('cute-sync', key);
      return json(200, rec || { updated: 0, data: null });
    }
    if (method === 'POST') {
      const data = parseBody(event);
      if (data === null) return json(400, { error: 'bad json' });
      if (JSON.stringify(data).length > 8 * 1024 * 1024) return json(413, { error: 'payload too large (max 8MB)' });
      const incoming = data.data;
      const incoming_updated = parseInt(data.updated || 0, 10);
      const cur = await blobGet('cute-sync', key) || null;
      let merged;
      if (cur && cur.data && typeof cur.data === 'object' && incoming && typeof incoming === 'object') {
        merged = mergeData(cur.data, incoming);
        merged.updated = Math.max(parseInt(cur.updated || 0, 10), incoming_updated);
      } else {
        merged = { updated: incoming_updated, data: incoming };
      }
      await blobSet('cute-sync', key, merged);
      return json(200, merged);
    }
    return json(405, { error: 'method not allowed' });
  }

  /* ---- Web Push ---- */
  if (p.startsWith('/push/')) {
    const kind = p.slice('/push/'.length);
    if (kind === 'subscribe') {
      const data = parseBody(event);
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
      const data = parseBody(event);
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
      const data = parseBody(event);
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

  return { statusCode: 404, headers: CORS, body: 'Not Found' };
};
