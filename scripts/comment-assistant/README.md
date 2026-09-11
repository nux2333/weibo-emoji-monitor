# Comment Assistant

用于从 `superlike_posts` 中按 `experience_7d` 从高到低挑选帖子，并用一个独立的 Playwright persistent profile 打开帖子、定位评论框。

> 为避免无人值守刷评，这个脚本不会自动点击“发送”。每条评论完成后，在终端按 Enter 才会进入下一条。

## 启动

项目根目录执行：

```powershell
node -r ./src/postgres-preload.js .\scripts\comment-assistant\index.js
```

第一次启动后会弹出 Chromium。先在这个浏览器里登录微博；登录状态会保存在：

```text
data/comment-assistant-profile
```

之后再次启动会继续使用这个登录状态。

## 默认筛选规则

- `current_has_superlike = 0`
- `experience_7d >= 70`
- `comments_count <= 19`
- 必须有 `post_link`
- 按 `experience_7d DESC` 排序
- 同分时优先较新的帖子
- 每轮最多 20 条

## 可调整参数

PowerShell 示例：

```powershell
$env:COMMENT_MIN_EXPERIENCE='80'
$env:COMMENT_TARGET_LIMIT='30'
$env:COMMENT_MAX_EXISTING_COMMENTS='19'
node -r ./src/postgres-preload.js .\scripts\comment-assistant\index.js
```

参数：

- `COMMENT_MIN_EXPERIENCE`：最低经验值，默认 `70`
- `COMMENT_TARGET_LIMIT`：本轮最多打开多少条，默认 `20`
- `COMMENT_MAX_EXISTING_COMMENTS`：帖子已有评论数上限，默认 `19`
- `COMMENT_ASSISTANT_PROFILE`：自定义浏览器 profile 目录

## 操作

每条帖子打开后：

- 正常评论并发送，然后终端按 `Enter`：下一条
- 输入 `s`：跳过当前帖子
- 输入 `q`：退出
