# Gemini Web2API - Netlify 部署指南

[English](NETLIFY.md) | [Cloudflare 部署文档](cloudflare/README_CN.md)

将 Gemini Web2API 无缝部署到 Netlify Edge Functions，享受真正的打字机 SSE 流式传输输出、全球低延迟边缘节点网络，且无需自行维护服务器。

---

## ⚡ 快速部署

### 方案 1：一键部署到 Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/adrianpriza-ai/free-gemini)

1. 点击上方的 **Deploy to Netlify** 按钮。
2. 连接您的 GitHub 账号并创建仓库。
3. （可选）在 **Environment Variables** 中设置 `API_KEY` 或 `COOKIE_STRING`。
4. 点击 **Deploy**，数秒后即可通过 `https://your-app-name.netlify.app` 访问！

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
| `HTTPS_PROXY` | String | 自定义出站代理（如 `http://user:pass@proxy:port`）。 | 直连 |

> 💡 **多 Cookie 轮换**：支持多个 Cookie 轮换，用竖线 `|` 分隔即可，例如：`cookie1| cookie2| cookie3`。

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
  "hasSapisid": false
}
```

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
