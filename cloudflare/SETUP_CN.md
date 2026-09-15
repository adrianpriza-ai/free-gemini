# ⚡ 快速设置指南

在 Cloudflare Workers 上运行 Gemini 代理工作器大约需要 5 分钟。

---

## 1. 先决条件

- Node.js 18+
- 一个 Cloudflare 账户（免费计划即可）
- 浏览器中已登录的 **gemini.google.com** 会话

## 2. 获取您的 Gemini cookie

1. 打开 [gemini.google.com](https://gemini.google.com) 并确保您已登录。
2. 按 `F12` → **Network** 选项卡 → 刷新页面 → 点击任意一个发往 `gemini.google.com` 的请求。
3. 在 **请求头** 中，复制完整的 `Cookie` 值（整个长字符串）。
4. 可选但推荐：同时从 cookie 字符串中复制您的 `SAPISID` 值。

> 多个账户？可以用 `|` 连接多个 cookie — 例如 `COOKIE_STRING="cookie1|cookie2"` — 工作器会随机轮换使用它们。

## 3. 创建 KV 命名空间（一条命令）

```bash
npx wrangler login
npx wrangler kv namespace create PROXY_KV
```

复制返回的 `id` 并将其粘贴到 `wrangler.jsonc` 中，替换占位符：

```jsonc
"kv_namespaces": [
  { "binding": "PROXY_KV", "id": "paste-your-id-here" }
]
```

KV 使得每日定时任务（`0 0 * * *`，已预配置）变得有用：定时任务在其自身调用中刷新并测试代理池，并将验证后的列表写入 KV，这样用户请求就可以跳过冷启动测试的开销。

## 4. 设置您的密钥

```bash
npx wrangler secret put COOKIE_STRING   # 粘贴来自步骤 2 的 cookie
npx wrangler secret put SAPISID         # 可选，来自同一 cookie
npx wrangler secret put API_KEY         # 您自己的密钥，例如 sk-my-secret-123
```

## 5. 部署

```bash
npm install
npx wrangler deploy
```

请记下您的工作器 URL，例如 `https://free-gemini.<your-subdomain>.workers.dev`。

## 6. 验证

```bash
curl https://your-worker.workers.dev/health
curl -H "Authorization: Bearer sk-my-secret-123" \
     https://your-worker.workers.dev/v1/models
```

## 7. 使用（OpenAI 兼容）

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-my-secret-123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

将任何 OpenAI 兼容的客户端（NextChat, LobeChat, Codex CLI, …）指向 `https://your-worker.workers.dev/v1` 并使用您的 API 密钥。

---

## 可选环境变量

| 变量 | 默认值 | 用途 |
|-|-|-|
| `ENABLE_PROXY` | `true` | 通过免费代理池路由（`false`/`0` 表示禁用并始终直连） |
| `STATIC_PROXIES` | — | 您自己的代理，用逗号分隔 — 比免费池更可靠 |
| `PROXY_MAX_POOL_SIZE` | `12` | 保持在池中的已验证代理最大数量 |
| `PROXY_ROTATION_MODE` | `best-of-2` | `round-robin` / `random` / `best-of-2` / `weighted` |
| `PROXY_SOURCE_URL` | ProxyScrape | 自定义代理列表来源 |
| `PROXY_UPDATE_INTERVAL_HOURS` | `24` | 池刷新间隔（小时） |
| `PROXY_SOURCE_FETCH_TIMEOUT_MS` | `8000` | 获取代理列表来源的硬超时（毫秒） |
| `PROXY_HANDSHAKE_TIMEOUT_MS` | `6000` | 每个代理的 CONNECT/SOCKS 握手硬超时（毫秒） |
| `PROXY_REFRESH_SYNC_MS` | `8000` | 冷启动池刷新的最大同步等待时间（毫秒） |

在 Cloudflare 仪表板中设置它们（**Workers → 您的工作器 → 设置 → 变量**）或在 `wrangler.jsonc` 的 `"vars"` 下设置。

## 有用的端点

| 端点 | 认证 | 显示内容 |
|-|-|-|
| `GET /health` | 公开 | 工作器 + 代理状态，版本 |
| `GET /v1/models` | API key | 可用模型 |
| `GET /proxies` | API key | 池状态 + 代理延迟 |
| `POST /proxies/refresh` | API key | 立即强制刷新池 |
| `GET /debug/proxies` | API key | 每个代理的健康状况，失败次数，轮换分数 |

## 故障排除

- **`401 invalid api key`** — 请将密钥作为 `Authorization: Bearer …`、`x-api-key: …` 或 `?key=…` 传递。
- **`upstream error: Too many subrequests…`** — 应该已修复（v1.7.2+ 预算系统）。请确保您部署了最新的 `worker.js`。
- **首次请求较慢** — 冷启动：正在获取/测试代理池。启用 KV + cron 后，这仅在每天发生一次。
- **Cookie 错误 / 认证失败** — 您的 Gemini cookie 已过期；请重新复制它并再次执行 `npx wrangler secret put COOKIE_STRING`。