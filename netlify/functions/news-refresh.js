/* 定时刷新新闻：每 15 分钟抓一次存进 Blob，保证 /api/news 即时返回且不超时 */
const { crawl, blobSet } = require('./_lib');

exports.config = { schedule: '*/15 * * * *' };

exports.handler = async () => {
  try {
    const out = await Promise.race([
      crawl(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('crawl-timeout')), 9000))
    ]);
    out._ts = Date.now();
    await blobSet('cute-news', 'latest', out);
    return { statusCode: 200, body: 'news refreshed, items=' + out.items.length };
  } catch (e) {
    return { statusCode: 200, body: 'news refresh skipped: ' + (e && e.message) };
  }
};
