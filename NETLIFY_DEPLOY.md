# 把「我的小天地」部署到 Netlify（完全免费 · 不绑卡）

> 之前 Render 免费档每月 5GB 流量用完被停了。Netlify 免费档 **100GB/月**、不用信用卡，
> 而且自带云函数 + 免费存储（Blobs），正好跑我们的新闻/阅读/天气/同步/推送。
> 代码已经 push 到 GitHub `Jamie-666-H/cute-news-backend`，下面几步全是点点点。

## 第 1 步：用 GitHub 登录 Netlify
1. 打开 https://app.netlify.com
2. 点 **Sign up / Log in** → 选 **GitHub** → 授权登录（用你现有的 GitHub 账号即可，免费）。

## 第 2 步：导入这个仓库
1. 登录后点 **Add new site** → **Import an existing project**。
2. 选 **GitHub**，搜 `cute-news-backend` → 点它。
3. 部署设置 Netlify 会**自动读 `netlify.toml`**，你会看到：
   - Build command：`echo skip-build`
   - Publish directory：`.`（根目录）
   - Functions directory：`netlify/functions`
   不用改，直接点 **Deploy**。
4. 等 1~2 分钟，状态变 **Published**，会给你一个类似
   `xxx.netlify.app` 的网址（也可以点 **Domain settings** 换成你自己的域名，可选）。

## 第 3 步：手机上装好 + 开推送
1. 用手机浏览器打开那个 `xxx.netlify.app` 网址。
2. 点浏览器的「分享 / 添加到主屏幕」（iPhone 在分享菜单里；安卓在地址栏 ⋮ 菜单），
   把它装成桌面的 App（这样才有系统通知能力）。
3. 进「✅ 待办计划」页，拉到底部 **🔔 每日提醒** → 打开 → 允许通知。
4. 给固定事项设好提醒时间（比如背单词 09:00）。
5. 点 **📨 发一条测试通知**，看手机有没有弹 🔔。能弹就通了。

## 之后怎么用
- 固定事项每天自动出现，到点（每 15 分钟检查一次）手机自动弹提醒，**不用打开网站**。
- 每日随机待办每天自动抽 3 条，可「🔄 换一批」。
- 新闻/阅读/天气照常，而且流量有 100GB，基本用不完。
- 数据同步走 Netlify Blobs（免费存储），不再狂写 GitHub 仓库，流量更省。

## 想更新代码时
改完本地 → 复制到 `cnb-deploy` → `git add -A && git commit && git push`，
Netlify 会自动重新部署（比 Render 省心，不用手动触发）。
