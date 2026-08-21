/* 定时推送：每 15 分钟检查固定事项提醒时间，到点向订阅设备推送系统通知。
   免费档不打开网站也能弹提醒，靠这个定时任务驱动。 */
const { blobGet, blobSet, sendPush } = require('./_lib');

exports.config = { schedule: '*/15 * * * *' };

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parseTime(t) {
  if (!t || t.length < 5) return null;
  const h = parseInt(t.slice(0, 2), 10), m = parseInt(t.slice(3, 5), 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

exports.handler = async () => {
  const subs = (await blobGet('cute-push', 'subs')) || {};
  const sent = (await blobGet('cute-push', 'sent')) || {}; // {'YYYY-MM-DD|id': 1} 去重，防一分钟内重复
  const now = new Date();
  const today = ymd(now);
  const cm = now.getHours() * 60 + now.getMinutes();
  const expired = [];

  for (const [dev, rec] of Object.entries(subs)) {
    for (const it of (rec.schedule || [])) {
      const tm = parseTime(it.time);
      if (tm === null) continue;
      const due = (tm === cm) || (tm < cm && cm <= tm + 5);
      if (!due) continue;
      const mk = today + '|' + it.id;
      if (sent[mk]) continue;
      const r = await sendPush(rec.subscription, '🔔 该做啦：' + (it.text || '今日事项'), '到时间咯，今天也要加油呀～ 🌸', '/');
      if (r === 'expired') expired.push(dev);
      else if (r) sent[mk] = 1;
    }
  }
  // 清理非今天的去重标记
  for (const k of Object.keys(sent)) if (!k.startsWith(today)) delete sent[k];
  // 清理过期订阅
  for (const d of expired) delete subs[d];

  await blobSet('cute-push', 'subs', subs);
  await blobSet('cute-push', 'sent', sent);
  return { statusCode: 200, body: 'push-check done, devices=' + Object.keys(subs).length };
};
