# Gemini Web2API - Vercel 部署指南

[English](VERCEL.md) | [Cloudflare 部署文档](../cloudflare/README_CN.md) | [Netlify 部署文档](../netlify/NETLIFY_CN.md)

将 Gemini Web2API 部署到 Vercel Edge Functions：在 Vercel 全球边缘节点上实现打字机式 SSE 流式输出——零配置，无需自己维护服务器。

> 📁 端点位于 [`api/gemini.js`](../api/gemini.js)，由 Cloudflare Worker 与 Netlify Edge Function 直接移植而来。Vercel 会自动把 `api/` 目录下的文件识别为 Serverless Function，文件末尾的 `export const config = { runtime: 'edge' }` 使其运行在 Edge Runtime 上。

---

## ⚡ 快速部署

### 方案 1：一键部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/adrianpriza-ai/free-gemini)

1. 点击上方的 **Deploy** 按钮。
2. 连接您的 GitHub 账号并创建仓库。
3. （可选）在 **Environment Variables** 中设置 `API_KEY` 或 `COOKIE_STRING`。
4. 点击 **Deploy**，部署完成后即可通过 `https://your-app-name.vercel.app` 访问。

### 方案 2：通过 Vercel 控制台关联 Git

1. 将本仓库 Fork 或推送至您的 GitHub 账号。
2. 打开 [Vercel 控制台](https://vercel.com/dashboard)。
3. 点击 **Add New...** → **Project**，导入您的仓库。
4. 在 **Configure Project** 中：
   - **Framework Preset**：`Other`
   - **Build Command**：留空
   - **Output Directory**：留空
   - **Install Command**：留空
5. 点击 **Deploy**。Vercel 会自动识别 `api/gemini.js`，无需 `vercel.json`。

### 方案 3：Vercel CLI

```bash
npm install -g vercel
vercel          # 预览部署
vercel --prod   # 生产部署
```

---

## ⚙️ 环境变量配置（可选）

在 Vercel 中设置：**Project Settings** → **Environment Variables**（或使用 `vercel env add`）。

| 环境变量 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `API_KEY` / `API_KEYS` | String | 客户端请求鉴权密钥（支持逗号或 `\|` 分隔多个）。 | `sk-gemini` |
| `COOKIE_STRING` | String | Google 账号 Cookie（含 `__Secure-1PSID` 等），用于高频与 Pro 模型。 | `null` |
| `SAPISID` | String | Google SAPISID 认证值（若未填会自动从 Cookie 中提取）。 | `null` |
| `DEFAULT_MODEL` | String | 客户端未指定 model 时使用的默认模型。 | `gemini-3.6-flash` |
| `GEMINI_BL` | String | Gemini Web 前端构建标签。 | 内置最新版 |
| `RATE_LIMIT_MAX` | Number | 单 IP 窗口期内最大允许请求数。 | `3000` |
| `RATE_LIMIT_WINDOW` | Number | 限流时间窗口（秒）。 | `60` |
| `REQUEST_TIMEOUT_SEC` | Number | 单次上游请求超时（秒）。建议调小（如 `10`）以保持在 25 秒响应头时限内。 | `28` |
| `ENABLE_PROXY` | String | 在支持原始 TCP Socket 的平台（如 Cloudflare Workers）启用轮换式**代理池**。**Vercel Edge 不支持**（无 TCP Socket API）——设置了也不生效，请求时会在日志中输出 `WARN` 告警。 | `false` |
| `HTTPS_PROXY` | String | 静态出站代理地址。**在 Vercel 上仅作展示**：与 Netlify Edge（Deno）不同，Vercel 的 `fetch()` **不会**自动经 `HTTPS_PROXY` 建立隧道，该值仅由 `/health` 报告，不会实际生效。 | 直连 |

> ⚠️ **Vercel 代理说明**：Vercel Edge Functions **不提供原始 TCP Socket**（`cloudflare:sockets`），因此轮换式**代理池**（`ENABLE_PROXY`/`PROXY_ENABLED`）**在 Vercel 上不受支持**，会被忽略并在日志中输出 `WARN` 告警。与 Netlify Edge（Deno 原生支持 `HTTPS_PROXY` 隧道）不同，Vercel 的 Edge Runtime 也**不会**自动把 `fetch()` 经 `HTTPS_PROXY` 转发——直连是 Vercel 上唯一的出站模式。如需代理，请使用 Cloudflare Workers 部署。`/health` 端点的 `proxy.mode` 会显示实际生效模式（Vercel 上恒为 `direct`）。

> 💡 **多 Cookie 轮换**：支持多个 Cookie 轮换，用竖线 `|` 分隔即可，例如：`cookie1| cookie2| cookie3`。

---

## 📏 平台限制（Edge Runtime）

| 限制 | 数值 | 本部署的应对方式 |
|---|---|---|
| 响应首字节 | 必须在 **25 秒**内开始发送 | 非流式请求的重试总耗时被限制在 **22 秒**响应截止内（预留 3 秒余量）。流式响应立即发送响应头，不受影响。 |
| 流式总时长 | 最长 **300 秒** | 对 SSE 流式输出绰绰有余。 |
| 请求/响应体 | 4.5 MB | 超长对话可能触顶，请控制消息长度。 |
| 打包体积 | 250 MB（未压缩） | 处理器是单个约 155 KB 的文件——毫无压力。 |

---

## 🔍 验证部署

部署完成后，在浏览器访问或使用 curl 验证健康状态：

```bash
curl https://your-app-name.vercel.app/health
```

返回示例：
```json
{
  "status": "ok",
  "version": "1.7.3-multi-platform",
  "platform": "Vercel Edge Functions",
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

Vercel 上 `poolSupported` 恒为 `false`，`proxy.mode` 恒为 `direct`——该平台既无 TCP Socket，也不会自动进行代理隧道转发。

---

## 💻 客户端接入配置

### NextChat (ChatGPT-Next-Web)

| 配置项 | 推荐值 |
|---|---|
| 接口类型 | OpenAI |
| 接口地址 | `https://your-app-name.vercel.app/v1` |
| API Key | `sk-gemini`（或您自定义的 key） |
| 模型名称 | `gemini-3.6-flash` 或 `gemini-3.5-flash-thinking` |

### Cherry Studio / ChatBox

| 配置项 | 推荐值 |
|---|---|
| 提供商 | OpenAI |
| API Base URL | `https://your-app-name.vercel.app/v1` |
| API Key | `sk-gemini` |
| 模型 | `gemini-3.6-flash` |

### curl 测试调用

```bash
curl https://your-app-name.vercel.app/v1/chat/completions \
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

可通过 Vercel CLI 在本地测试运行 Edge Function：

```bash
npm install -g vercel
vercel dev
```

本地服务默认监听在 `http://localhost:3000`。

---

## 🚨 故障排查

### `FUNCTION_INVOCATION_TIMEOUT` (504)

Vercel Edge Functions 必须**在 25 秒内开始发送响应**，否则该次调用会被终止并返回
504。非流式请求的重试总耗时现在限制在 22 秒响应截止内。如果仍然出现：

| 原因 | 解决办法 |
|---|---|
| 上游 Gemini 不可达或响应慢 | 调低 `REQUEST_TIMEOUT_SEC`（如 `10`），确保单次尝试不会耗尽截止时间。 |
| `GEMINI_BL` 构建标签过期（上游返回 405） | 打开 `https://gemini.google.com/app`，按 F12 → Network 标签，在任意请求 URL 中搜索 `boq_assistant`，把最新标签填入 `GEMINI_BL` 环境变量。 |
| 被 Google 限流（上游返回 429） | 配置有效的 `COOKIE_STRING`（及 `SAPISID`）环境变量，或降低请求频率。 |

### `FUNCTION_INVOCATION_FAILED` (500)

函数发生未捕获异常。入口 Handler 带有顶层 try/catch，会返回结构化的 JSON `500`，
因此若出现此错误，通常说明异常发生在 Handler 被调用之前。请在 Vercel 控制台的
**Deployments → Runtime Logs** 中查看详情。

### 请求格式异常（`model` 不是字符串、JSON body 不是对象）

已修复：非法输入现在返回结构化的 `400`，不再崩溃。

### 日志

运行日志可在 Vercel 控制台 **Deployments → Runtime Logs** 中查看（或使用
`vercel logs <deployment-url>`）。启用 `logRequests`（默认开启）时，处理器会以
`[HH:MM:SS] [LEVEL] message` 格式输出请求日志。
