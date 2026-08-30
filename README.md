# 微博 Emoji 每日监控

## 功能
- 后台添加多个微博评论 URL
- 每个 URL 独立指定多个 Emoji
- 每天 06:00（服务器本地时间）自动抓取一次
- 手动立即抓取
- 保存最近抓取到的评论 ID / 内容
- 每个 Emoji 出现次数
- 指定 Emoji 总次数
- 包含指定 Emoji 的评论数
- 不含指定 Emoji 的评论数
- 公共 H5 页面只读，适合手机访问
- SQLite 本地数据库，无需单独数据库服务器

## 安装
需要 Node.js 20+。

```bash
npm install
npx playwright install chromium
```

## 启动

```bash
set ADMIN_TOKEN=change-this-token
npm start
```

Linux/macOS：

```bash
ADMIN_TOKEN=change-this-token npm start
```

公共页面：
`http://服务器IP:3000/`

后台：
`http://服务器IP:3000/admin.html`

## 后台添加
Token 输入环境变量 ADMIN_TOKEN。

项目名称：例如「商品A」

URL：你的微博小店评论 URL

Emoji：例如 `😂,❤️,👍`

添加后可以点「立即抓取」测试。

## 每日任务
代码默认每天服务器本地时间 06:00 执行全部 enabled 项目一次。
如果以后部署到 VPS，建议把服务器时区设成 Asia/Tokyo；如果你希望固定 UTC 时间，可以改 scheduler。

## 非常重要：微博抓取适配
`src/weibo.js` 当前是 Playwright 网络响应自动识别器。它不会假装知道微博小店真实 API；第一次运行你给的 `shop.e.weibo.com/v2/comment?...` URL 时，如果提示“没有识别到评论数据”，需要打开该页面的开发者工具 Network，确认实际评论 JSON 接口和分页参数，再把 `fetchComments()` 改成直接请求该 API。

一旦确认真实 API，建议改成直接 HTTP 请求，不再每次启动 Chromium。这样服务器资源消耗会低很多，也更适合 200 人访问。

## 生产环境建议
- 用 HTTPS
- 管理后台加更强的 ADMIN_TOKEN
- 用 Nginx/Caddy 反代 Node.js
- 数据目录定期备份
- 公共页面只开放 GET 接口，管理 API 保留 Token
- 如果以后同时监控很多 URL，增加任务队列/并发限制




启动
你当前已经在：D:\dev\workspace4txn\weibo-emoji-monitor\weibo-emoji-monitor

直接执行：
npm install

然后再执行：
npx playwright install chromium

最后：
npm start

如果成功，应该看到类似：

H5 started: http://localhost:3000

然后浏览器打开：
http://localhost:3000


DB 怎么清空？

这个非常简单。

你的数据库现在应该在：

data\monitor.db
方法一：全部清空，重新开始

最简单粗暴的方法就是停止 Node，然后删除 DB。

先：

Ctrl + C

然后：

cd /d D:\dev\workspace4txn\weibo-emoji-monitor\weibo-emoji-monitor

删除：

del data\monitor.db

如果存在：

del data\monitor.db-wal
del data\monitor.db-shm

然后：

npm start

程序会自动重新创建：

data
 └─ monitor.db

这时候：

监控项目 = 0
评论 = 0
统计 = 0