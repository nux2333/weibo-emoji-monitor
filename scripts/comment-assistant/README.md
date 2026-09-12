# Comment Assistant

用于从 `superlike_posts` 中按 `experience_7d` 从高到低挑选帖子，并使用各微博账号自己的登录态辅助评论。

## 当前架构

正常运行时不常驻 Chromium：

```text
启动账号
→ 临时启动 Chromium 读取该账号 Persistent Profile 的登录 Cookie
→ 关闭 Chromium
→ 创建同一代理的 Playwright APIRequestContext
→ 帖子 GET / CSRF / 评论 POST 全部走 HTTP
```

只有下面两种情况会启动 Chromium：

1. 该账号第一次使用，还没有登录信息；
2. 微博返回 `-100` / login / passport，判断登录态已经失效。

重新登录完成后会再次关闭 Chromium，恢复 HTTP 模式。

> 评论仍然保留人工确认：每条评论发送前必须输入 `y`。脚本不会无人值守连续发送。

## 启动

项目根目录执行：

```powershell
node -r ./src/postgres-preload.js .\scripts\comment-assistant\index.js
```

也可以继续使用原来的 CLI / Web 入口，它们仍然调用 `index.js`。

账号 Profile 默认保存在：

```text
data/comment-assistant-profiles/<账号名>
```

旧默认账号仍兼容：

```text
data/comment-assistant-profile
```

## 默认筛选规则

- `current_has_superlike = 0`
- `experience_7d >= 70`
- `comments_count <= 19`
- 必须有 `post_link`
- 仅当天帖子
- 按 `experience_7d DESC` 排序
- 同分时优先较新的帖子
- 每轮最多 20 条

## 可调整参数

```powershell
$env:COMMENT_MIN_EXPERIENCE='80'
$env:COMMENT_TARGET_LIMIT='30'
$env:COMMENT_MAX_EXISTING_COMMENTS='19'
$env:COMMENT_HTTP_TIMEOUT_MS='15000'
node -r ./src/postgres-preload.js .\scripts\comment-assistant\index.js
```

参数：

- `COMMENT_MIN_EXPERIENCE`：最低经验值，默认 `70`
- `COMMENT_TARGET_LIMIT`：本轮最多处理多少条，默认 `20`
- `COMMENT_MAX_EXISTING_COMMENTS`：帖子已有评论数上限，默认 `19`
- `COMMENT_ASSISTANT_PROFILE`：自定义浏览器 profile 目录
- `COMMENT_BROWSER_PROXY`：当前账号固定代理；未设置时从健康代理池随机选择一个
- `COMMENT_HTTP_TIMEOUT_MS`：HTTP 请求超时，默认 `15000`
- `COMMENT_TEXT`：默认评论内容
- `COMMENT_FP`：如微博评论接口要求 `fp`，可通过此变量提供

## 操作

每条帖子：

- 输入 `y`：通过 HTTP 发送评论
- 输入 `s`：跳过当前帖子
- 输入 `q`：退出

如果 HTTP 会话检测到登录失效，会只为当前账号临时打开 Chromium，让你重新登录；登录完成后关闭 Chromium并继续 HTTP 模式。
