# Gemini Web2API - Deno Deploy 部署指南

[English](README.md) | [Cloudflare 文档](../cloudflare/README_CN.md) | [Netlify 文档](../netlify/README_CN.md) | [Vercel 文档](../vercel/README_CN.md)

在 [Deno Deploy](https://deno.com/deploy) 上运行 Gemini Web2API，获得 SSE 流式输出，并支持原始 TCP Socket（代理池可用）—— 零配置、无需维护服务器。

> 入口文件位于 [`deno/deploy.js`](../deno/deploy.js)，是加载 [`src/`](../src/) 共享核心的薄适配器（与 Cloudflare、Netlify、Vercel 适配器共用同一核心）。入口使用 `Deno.serve()` 启动 HTTP 服务 —— 这是当前 Deno Deploy 平台要求的 API（旧版 Deploy Classic 已于 2026-07-20 停服，其支持的 std `serve()` 不再可用）。[`deno/sockets.js`](../deno/sockets.js) 把 `Deno.connect` 包装成代理池期望的 socket 形态，因此轮换式代理池在 Deno 上也能完整工作。

> 为什么 Deno Deploy 是个好选择：与 Cloudflare Workers 一样（Netlify/Vercel Edge 则不行），Deno 提供原始 TCP Socket（`Deno.connect`），完整的轮换式代理池可用；与 Netlify Edge 一样（Vercel 则不行），Deno 的 `fetch()` 原生读取 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，静态出站代理自动隧道生效。

---

## 快速部署

### 方式 1：GitHub 集成（推荐）

1. Fork 或推送本仓库到你的 GitHub 账号。
2. 登录 [console.deno.com](https://console.deno.com) 并创建组织（新版 Deno Deploy 的账号体系与已停服的 Deploy Classic 相互独立）。
3. 点击 **+ New App**，选择你的 GitHub 仓库，按提示授权 Deno Deploy GitHub App。
4. 在 **Edit build config** 中配置：
   - **Framework preset**: `No Preset`
   - **Install command**: （留空）
   - **Build command**: （留空）
   - **Runtime mode**: `Dynamic`
   - **Entrypoint**: `deno/deploy.js`
5. （可选）按下表添加环境变量，并选择 Production/Development 上下文。
6. 点击 **Create App**。构建与预热完成后，API 即已在 `https://your-app-name.deno.net` 上线。

### 方式 2：Deno CLI

`deployctl` CLI 已停止维护，由 `deno deploy` 子命令取代（Deno 2.x 自带）。

```bash
deno deploy create \
  --org your-org \
  --app gemini-web2api \
  --source local \
  --runtime-mode dynamic \
  --entrypoint deno/deploy.js \
  --region global

# 已有应用的后续部署:
deno deploy --org your-org --app gemini-web2api --prod
```

也可以用 CLI 管理环境变量：

```bash
deno deploy env add API_KEY "sk-your-key" --secret
```

---

## 环境变量（可选）

在 Deno Deploy 的 **app settings → Add/Edit environment variables** 中配置（或用 `deno deploy env add`）。

| 变量 | 类型 | 说明 | 默认值 |
|-|-|-|-|
| `API_KEY` / `API_KEYS` | String | 客户端密钥白名单（逗号或 `\|` 分隔）。 | `sk-gemini` |
| `COOKIE_STRING` | String | Google 账号 Cookie（`__Secure-1PSID` 等），用于登录态访问。 | `null` |
| `SAPISID` | String | SAPISID 值（未填时自动从 `COOKIE_STRING` 提取）。 | `null` |
| `DEFAULT_MODEL` | String | 客户端未指定模型时的默认模型。 | `gemini-3.6-flash` |
| `GEMINI_BL` | String | Gemini 网页版构建标签（如 `boq_assistant-bard-web-server_...`）。 | 内置最新 |
| `RATE_LIMIT_MAX` | Number | 时间窗口内单 IP 最大请求数。 | `3000` |
| `RATE_LIMIT_WINDOW` | Number | 速率限制窗口（秒）。 | `60` |
| `REQUEST_DEADLINE_MS` | Number | 服务端单请求总截止时间（毫秒）：上游响应未按时就位时立即返回结构化 502（`upstream_timeout`），而不是挂起。部署在 Deno Deploy 时建议低于平台 55s 响应头限制。`0` 禁用 | `50000` |
| `ENABLE_PROXY` | String | 启用轮换式代理池（Deno 提供原始 TCP Socket，可用）。 | `false` |
| `HTTPS_PROXY` | String | 静态出站代理地址（如 `http://user:pass@proxy:port`）。Deno 的 `fetch()` 原生读取 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`，直连请求自动经代理隧道发出；`HTTP_PROXY` 与 `ALL_PROXY` 同样生效。 | 直连 |

> TLS 代理限制（Deno Deploy）：Deno Deploy 禁止用 `Deno.connect` 直连 **443 端口**（443 必须做 TLS 终结，详见 Deno "Pricing and limitations" 文档）。代理池只连接*代理服务器*——通常在 80/1080/3128/8080 端口——因此常规 HTTP/SOCKS 代理不受影响。监听在 443 的明文 SOCKS/HTTP 代理在 Deploy 上会失败，但在本地 `deno run` 下可用。`/health` 端点的 `proxy.mode` 会显示实际生效模式（`direct`、`outbound` 或 `pool`）。

> 多 Cookie 轮换提示：用竖线分隔多个账号 Cookie 即可轮换，如 `cookie_account_1| cookie_account_2`。

---

## 验证

部署完成后，用浏览器或 curl 访问健康检查端点：

```bash
curl https://your-app-name.deno.net/health
```

预期响应：
```json
{
  "status": "ok",
  "version": "1.7.3-multi-platform",
  "platform": "Deno Deploy",
  "models": [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-thinking",
    "gemini-3.1-pro",
    "gemini-auto",
    ...
  ],
  "defaultModel": "gemini-3.6-flash",
  "hasCookie": false,
  "hasSapisid": false,
  "proxy": {
    "mode": "direct",
    "enabled": false,
    "poolSupported": true,
    "outboundProxy": null
  }
}
```

Deno 上 `poolSupported` 为 `true`（提供原始 TCP Socket），设置 `ENABLE_PROXY=true` 即可切换到 `pool` 模式 —— 与 Cloudflare Workers 一样的完整代理池体验。

---

## 客户端配置

### NextChat / ChatGPT-Next-Web

| 字段 | 值 |
|-|-|
| Interface Type | OpenAI |
| Endpoint / Base URL | `https://your-app-name.deno.net/v1` |
| API Key | `sk-gemini`（或你配置的 `API_KEY`） |
| Model | `gemini-3.6-flash` 或 `gemini-3.5-flash-thinking` |

### Cherry Studio / ChatBox

| 字段 | 值 |
|-|-|
| Provider | OpenAI |
| API Base URL | `https://your-app-name.deno.net/v1` |
| API Key | `sk-gemini` |
| Model | `gemini-3.6-flash` |

### curl 测试

```bash
curl https://your-app-name.deno.net/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "你好 Gemini!"}]
  }'
```

---

## 🛠️ 本地开发

用 Deno CLI 在本地运行完全相同的适配器（无需账号）：

```bash
deno run --allow-net --allow-env deno/deploy.js
# 或者: npm run dev:deno
```

服务默认启动在 `http://localhost:8000`（`Deno.serve` 默认端口；通过 `DENO_PORT` 环境变量修改，如 `DENO_PORT=8081 deno run ...`）。

> ⚠️ **务必带上 `--allow-env`**：适配器在请求时读取环境变量配置。只给 `--allow-net` 的话，第一个请求会卡在 Deno 的交互式权限确认上 —— 后台/管道运行时提示不可见，所有请求表现为永久挂起。入口现在会在启动时自检权限并直接报错退出。

---

## 🚨 常见问题排查

### `upstream timeout: no response within 50000ms (REQUEST_DEADLINE_MS)`（502）

服务端在 `REQUEST_DEADLINE_MS`（默认 50 秒）内没有等到上游响应头，主动放弃并返回结构化 502。这是**症状**而非根因 —— 在 Deno Deploy 上常见根因有：

1. **匿名直连出口被 Gemini 限流/挂起。** 不带 Cookie 的请求从 Deno Deploy 共享边缘 IP 发出，Gemini 经常让这类请求静默挂起或长时间无响应（非流式请求尤其明显，因为完整响应必须就绪后才能开始返回）。按有效性排序的解决办法：
   - 设置有效的 `COOKIE_STRING`（+ `SAPISID`）—— 单项最有效的修复。
   - 开启轮换代理池：`ENABLE_PROXY=true`（Deno 支持原始 TCP Socket），或设置静态 `HTTPS_PROXY`。
2. **长生成超过截止时间。** 非流式请求输出很长时，耗时可能合理地超过 50 秒。调大 `REQUEST_DEADLINE_MS`（如 `90000`），或改用 `stream: true` 让内容增量到达。
3. **路由 50 秒截止短于 55 秒重试预算。** 此问题已在代码中修复：重试循环现在会对齐路由截止时间，并抛出带提示的可读单次尝试超时错误，而不是笼统的 502。如果老部署仍显示笼统消息，请重新部署。

> ℹ️ **看到的是 `HTTP 429: Too Many Requests - 请添加有效的 Cookie 或降低请求频率`？** 这才是**正确归属**的错误 —— 说明上游确实返回了 429（限流）。旧版本在 Gemini 的 `Retry-After` 等待超过剩余截止预算时，会把真实的 429 掩盖成笼统的超时。现在重试循环会立即抛出真实的 429，而不再白等。若 429 持续出现，请设置 `COOKIE_STRING` 或降低请求频率。

快速自查：`GET /health` 的 `proxy.mode` 字段显示实际出站模式（`direct` / `outbound` / `pool`）—— 如果是 `direct` 且没有配置 Cookie，则命中原因 1。

### 请求挂起 / 完全无响应（本地 `deno run`）

适配器每次请求都要读取环境变量。如果启动时漏掉 `--allow-env`（如 `deno run --allow-net deno/deploy.js`），第一个请求会阻塞在 Deno 的交互式权限确认上。终端前台能看到提示，但后台/管道运行时提示不可见 —— 服务就是"永远不回复"。请始终用两个权限标志启动（入口现在会在权限缺失时立即报错退出）：

```bash
deno run --allow-net --allow-env deno/deploy.js
```

### `TLS proxying is not allowed` / 连接 443 端口报错

Deno Deploy 禁止对 443 端口的非 TLS `Deno.connect`。代理池连接的是代理服务器（很少在 443），所以一般只有往 `STATIC_PROXIES` 里添加监听 443 的明文 SOCKS/HTTP 代理时才会遇到。把代理挪到常规端口，或放弃 `ENABLE_PROXY` 改设 `HTTPS_PROXY`（Deno `fetch()` 原生支持隧道）。

### 构建/Warmup 阶段超时失败

请确认 **Entrypoint** 设为 `deno/deploy.js`、Runtime mode 为 `Dynamic`。本入口使用 `Deno.serve()`；旧版 Deploy Classic 时代从 `deno.land/std/http` 导入 `serve()` 的写法在新平台上无法工作。

### 上游 429 / 空回复

Gemini 网页端对匿名请求限流非常严格。请添加有效的 `COOKIE_STRING`（+ `SAPISID`）环境变量，或降低请求频率。也可以开启代理池（`ENABLE_PROXY=true`）轮换出口 IP，缓解单 IP 被限流的问题。

### 日志

运行日志、链路追踪和指标可在 Deno Deploy 控制台对应 App 的 **Logs** / **Traces** 面板查看。`logRequests` 开启时（默认），处理器会以 `[HH:MM:SS] [LEVEL] message` 格式输出请求日志。
