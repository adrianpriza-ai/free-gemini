# Gemini Web2API - Netlify 部署指南

[English](NETLIFY.md) | [Cloudflare 部署文档](../cloudflare/README_CN.md)

将 Gemini Web2API 部署到 Netlify Edge Functions：支持打字机式 SSE 流式输出，全球边缘节点低延迟，无需自己维护服务器。

---

## ⚡ 快速部署

### 方案 1：一键部署到 Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/adrianpriza-ai/free-gemini)

1. 点击上方的 **Deploy to Netlify** 按钮。
2. 连接您的 GitHub 账号并创建仓库。
3. （可选）在 **Environment Variables** 中设置 `API_KEY` 或 `COOKIE_STRING`。
4. 点击 **Deploy**，一分钟左右即可通过 `https://your-app-name.netlify.app` 访问。

---

### 方案 2：通过 Netlify 控制台关联 Git

1. 将本仓库 Fork 或推送至您的 GitHub 账号。
2. 打开 [Netlify 控制台](https://app.netlify.com)。
3. 点击 **Add new site** → **Import an existing project**。
4. 选择 **GitHub** 并授权访问对应仓库。
5. 构建配置保持默认：
   - **Base directory**：留空
   - **Build command**：留空
   - **Publish directory**：留空
6. 点击 **Deploy site**。
7. Netlify 会自动识别 `netlify.toml` 并激活 `/*` 边缘函数路由。

---

## ⚙️ 环境变量配置（可选）

在 Netlify 中设置：**Site configuration** → **Environment variables** → **Add a variable**。

| 环境变量 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `API_KEY` / `API_KEYS` | String | 客户端请求鉴权密钥（支持逗号或 `\|` 分隔多个）。 | `sk-gemini` |
| `COOKIE_STRING` | String | Google 账号 Cookie（含 `__Secure-1PSID` 等），用于高频与 Pro 模型。 | `null` |
| `SAPISID` | String | Google SAPISID 认证值（若未填会自动从 Cookie 中提取）。 | `null` |
| `DEFAULT_MODEL` | String | 客户端未指定 model 时使用的默认模型。 | `gemini-3.6-flash` |
| `GEMINI_BL` | String | Gemini Web 前端构建标签。 | 内置最新版 |
| `RATE_LIMIT_MAX` | Number | 单 IP 窗口期内最大允许请求数。 | `3000` |
| `RATE_LIMIT_WINDOW` | Number | 限流时间窗口（秒）。 | `60` |
| `ENABLE_PROXY` | String | 在支持原始 TCP Socket 的平台（如 Cloudflare Workers）启用轮换式**代理池**。**Netlify Edge 不支持**（无 TCP Socket API）——设置了也不生效，请求时会在日志中输出 `WARN` 告警。请改用下方的 `HTTPS_PROXY`。 | `false` |
| `HTTPS_PROXY` | String | 静态出站代理地址（如 `http://user:pass@proxy:port`）。Netlify Edge 运行于 Deno，其 `fetch()` 会原生读取 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`，直连请求会自动经代理隧道发出。`HTTP_PROXY` 与 `ALL_PROXY` 同样生效。 | 直连 |

> 💡 **多 Cookie 轮换**：支持多个 Cookie 轮换，用竖线 `|` 分隔即可，例如：`cookie1| cookie2| cookie3`。

> ⚠️ **Netlify 代理说明**：Netlify Edge Functions **不提供原始 TCP Socket**（`cloudflare:sockets`），因此轮换式**代理池**（`ENABLE_PROXY`/`PROXY_ENABLED`）**在 Netlify 上不受支持**，会被忽略并在日志中输出 `WARN` 告警。如需在 Netlify 走代理，请设置 **`HTTPS_PROXY`**（Deno 的 `fetch()` 会自动经其隧道转发）。`/health` 端点的 `proxy.mode` 会显示实际生效模式（`direct`、`outbound` 或 `pool`）。

---

## 🔍 验证部署

部署完成后，在浏览器访问或使用 curl 验证健康状态：

```bash
curl https://your-app-name.netlify.app/health
```

返回示例：
```json
{
  "status": "ok",
  "version": "1.7.3-multi-platform",
  "platform": "Netlify Edge Functions",
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
    "poolSupported": false,
    "outboundProxy": null
  }
}
```

`proxy` 块反映实际出站模式：`direct`（默认）、`outbound`（静态 `HTTPS_PROXY` 生效中）或 `pool`（轮换代理池——仅 Cloudflare Workers 支持）。注意 Netlify Edge 上 `poolSupported` 恒为 `false`，因此仅设置 `ENABLE_PROXY=true` 无法把模式切换为 `pool`；如需代理请设置 `HTTPS_PROXY` 以获得 `"mode": "outbound"`。

---

## 💻 客户端接入配置

### NextChat (ChatGPT-Next-Web)

| 配置项 | 推荐值 |
|---|---|
| 接口类型 | OpenAI |
| 接口地址 | `https://your-app-name.netlify.app/v1` |
| API Key | `sk-gemini`（或您自定义的 key） |
| 模型名称 | `gemini-3.6-flash` 或 `gemini-3.5-flash-thinking` |

### Cherry Studio / ChatBox

| 配置项 | 推荐值 |
|---|---|
| 提供商 | OpenAI |
| API Base URL | `https://your-app-name.netlify.app/v1` |
| API Key | `sk-gemini` |
| 模型 | `gemini-3.6-flash` |

### curl 测试调用

```bash
curl https://your-app-name.netlify.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "你好，Gemini！"}]
  }'
```

---

## 🛠️ 本地开发与调试

可通过 Netlify CLI 在本地测试运行 Edge Function：

```bash
npm install -g netlify-cli
netlify dev
```

本地服务默认监听在 `http://localhost:8888`。

---

## 🚨 故障排查

### `Error - Request ID: 01M...`

这是 Netlify 的通用错误页。出现它通常有两种原因：Edge Function 发生未捕获异常，
或者没能在 Netlify 的 40 秒响应头时限内发出响应。真实错误可在控制台的
**Logs → Edge Functions** 中查看。

常见原因与解决办法：

| 原因 | 解决办法 |
|---|---|
| 上游 Gemini 不可达或响应慢，重试耗时超过 40s 响应头时限 | 已修复：非流式请求的重试总耗时现在限制在 30 秒响应截止内。如仍复现，调低 `REQUEST_TIMEOUT_SEC`（如 `10`）。 |
| 请求格式异常（`model` 不是字符串、JSON body 不是对象） | 已修复：非法输入现在返回结构化的 `400`，不再崩溃。 |
| `GEMINI_BL` 构建标签过期（上游返回 405） | 打开 `https://gemini.google.com/app`，按 F12 → Network 标签，在任意请求 URL 中搜索 `boq_assistant`，把最新标签填入 `GEMINI_BL` 环境变量。 |
| 被 Google 限流（上游返回 429） | 配置有效的 `COOKIE_STRING`（及 `SAPISID`）环境变量，或降低请求频率。 |
| 代码缺陷导致 Handler 崩溃 | 已修复：入口 Handler 带有顶层 try/catch，会返回包含错误信息的 JSON `500`，不再是不透明错误页。 |

出错的请求现在会在响应体和函数日志里给出真实错误信息，不用再对着
`Error - Request ID` 猜原因。
