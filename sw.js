/* 我的小天地 - 离线缓存 Service Worker */
const CACHE = 'cute-workbench-v70';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 断网/被墙时的兜底提示页（绝不白屏，明确告诉用户数据与下一步）
function offlinePage() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的小天地</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    background:linear-gradient(135deg,#ffe3ef,#fff0f6);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .card{background:#fff;border-radius:24px;padding:32px 28px;max-width:360px;text-align:center;
    box-shadow:0 12px 40px rgba(255,143,191,.25)}
  .emoji{font-size:54px;margin-bottom:8px}
  h1{color:#e85d9c;font-size:20px;margin:0 0 12px}
  p{color:#7a6a72;font-size:15px;line-height:1.7;margin:8px 0}
  .tip{background:#fff0f6;border-radius:14px;padding:12px 14px;color:#c44d86;font-size:14px;margin-top:14px}
  button{margin-top:18px;background:#ff8fbf;color:#fff;border:0;border-radius:999px;padding:12px 26px;font-size:15px;cursor:pointer}
</style></head>
<body><div class="card">
  <div class="emoji">🌸</div>
  <h1>网络暂时连不上</h1>
  <p>你的数据都<strong>安全保存在云端</strong>，没有丢，别担心。</p>
  <p>这通常是因为当前网络访问不到托管站点（国内访问 github.io 偶尔会被限）。</p>
  <div class="tip">👉 试试：① 切换手机流量 / 换一个 Wi-Fi 再打开<br>② 等一会儿再刷新</div>
  <button onclick="location.reload()">重试</button>
</div></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 页面与脚本始终走网络，避免旧缓存锁定导致一直跑旧代码（相框恢复依赖最新代码）
  if (url.pathname === '/' || url.pathname.endsWith('index.html') || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { // 顺手把最新页面存进缓存，下次断网也能看
          const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(()=>{});
          return r;
        })
        .catch(() => caches.match('./index.html').then(c => c || offlinePage()))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).catch(() => caches.match('./index.html').then(c => c || offlinePage()))
    )
  );
});

/* 接收服务器推送并显示系统通知（固定事项到点提醒） */
self.addEventListener('push', e => {
  let data = { title: '我的小天地', body: '你有新的提醒 🔔', url: './' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: './icon-512.png',
    badge: './icon-192.png',
    tag: 'cute-reminder',
    renotify: true,
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
