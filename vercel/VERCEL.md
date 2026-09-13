# Gemini Web2API - Vercel Deployment Documentation

[中文文档](VERCEL_CN.md) | [Cloudflare Docs](../cloudflare/README.md) | [Netlify Docs](../netlify/NETLIFY.md)

Run Gemini Web2API on Vercel Edge Functions for true SSE streaming on Vercel's global edge network — zero config, no server to maintain.

> 📁 The endpoint lives at [`api/gemini.js`](../api/gemini.js), a direct port of the Cloudflare worker and the Netlify edge function. Vercel auto-detects any file in `api/` as a serverless function, and the `export const config = { runtime: 'edge' }` at the bottom of the file runs it on the Edge runtime.

---

## ⚡ Quick Deploy

### Option 1: 1-Click Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/adrianpriza-ai/free-gemini)

1. Click the **Deploy** button above.
2. Connect your GitHub account and choose a repository name.
3. (Optional) In **Environment Variables**, configure `API_KEY` or `COOKIE_STRING`.
4. Click **Deploy**. Your API is live at `https://your-app-name.vercel.app`.

### Option 2: Connect via Vercel Dashboard (Git)

1. Fork or push this repository to your GitHub account.
2. Open the [Vercel Dashboard](https://vercel.com/dashboard).
3. Click **Add New...** → **Project** and import your repository.
4. In **Configure Project**:
   - **Framework Preset**: `Other`
   - **Build Command**: (leave empty)
   - **Output Directory**: (leave empty)
   - **Install Command**: (leave empty)
5. Click **Deploy**. Vercel detects `api/gemini.js` automatically — no `vercel.json` needed.

### Option 3: Vercel CLI

```bash
npm install -g vercel
vercel          # preview deployment
vercel --prod   # production deployment
```

---

## ⚙️ Environment Variables (Optional)

Configure these in Vercel: **Project Settings** → **Environment Variables** (or `vercel env add`).

| Variable | Type | Description | Default |
|---|---|---|---|
| `API_KEY` / `API_KEYS` | String | Authorized client API keys (comma or `\|` separated). | `sk-gemini` |
| `COOKIE_STRING` | String | Google account cookies (`__Secure-1PSID`, etc.) for authenticated access. | `null` |
| `SAPISID` | String | SAPISID value (auto-extracted from `COOKIE_STRING` if omitted). | `null` |
| `DEFAULT_MODEL` | String | Default model if client does not specify one. | `gemini-3.6-flash` |
| `GEMINI_BL` | String | Gemini web build label (e.g. `boq_assistant-bard-web-server_...`). | built-in latest |
| `RATE_LIMIT_MAX` | Number | Max requests per IP in the window. | `3000` |
| `RATE_LIMIT_WINDOW` | Number | Rate limit window in seconds. | `60` |
| `REQUEST_TIMEOUT_SEC` | Number | Per-attempt upstream timeout in seconds. Keep small (e.g. `10`) to stay inside the 25s header deadline. | `28` |
| `ENABLE_PROXY` | String | Enables the rotating **proxy pool** on platforms with raw TCP sockets (e.g. Cloudflare Workers). **Not supported on Vercel Edge** (no TCP socket API) — setting it has no effect; a `WARN` is logged at request time. | `false` |
| `HTTPS_PROXY` | String | Static outbound proxy URL. **Informational only on Vercel**: unlike Netlify Edge (Deno), Vercel's `fetch()` does **not** automatically tunnel through `HTTPS_PROXY`, so this value is reported by `/health` but not applied. | none (direct) |

> ⚠️ **Proxy support on Vercel**: Vercel Edge Functions do **not** provide raw TCP sockets (`cloudflare:sockets`), so the rotating **proxy pool** (`ENABLE_PROXY`/`PROXY_ENABLED`) is **not supported** on Vercel and is ignored with a `WARN` in the logs. Unlike Netlify Edge (Deno-based, native `HTTPS_PROXY` tunneling), Vercel's Edge runtime does **not** auto-tunnel `fetch()` through `HTTPS_PROXY` either — direct connection is the only outbound mode on Vercel. If you need a proxy, use the Cloudflare Workers deployment. The `/health` endpoint reports the effective mode under `proxy.mode` (`direct` on Vercel).

> 💡 **Tip for Multiple Cookies**: You can rotate between multiple Google accounts by separating cookies with a pipe character (`|`), e.g. `cookie_account_1| cookie_account_2`.

---

## 📏 Platform Limits (Edge Runtime)

| Limit | Value | How this deployment handles it |
|---|---|---|
| First response byte | Must start within **25s** | Non-streaming requests cap all retries at a **22s** pre-response deadline (3s safety margin). Streaming responses send headers immediately, so they are unaffected. |
| Total streaming duration | Up to **300s** | Plenty for SSE token streaming. |
| Request/response body | 4.5 MB | Long conversations may hit this; keep payloads reasonable. |
| Bundle size | 250 MB uncompressed | The handler is a single ~155 KB file — no concern. |

---

## 🔍 Verification

Once deployed, check your health endpoint in your browser or with curl:

```bash
curl https://your-app-name.vercel.app/health
```

Expected response:
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

On Vercel, `poolSupported` is always `false` and `proxy.mode` is always `direct` — the platform offers no TCP sockets and no automatic proxy tunneling.

---

## 💻 Client Configuration

### NextChat / ChatGPT-Next-Web

| Field | Value |
|---|---|
| Interface Type | OpenAI |
| Endpoint / Base URL | `https://your-app-name.vercel.app/v1` |
| API Key | `sk-gemini` (or your configured `API_KEY`) |
| Model | `gemini-3.6-flash` or `gemini-3.5-flash-thinking` |

### Cherry Studio / ChatBox

| Field | Value |
|---|---|
| Provider | OpenAI |
| API Base URL | `https://your-app-name.vercel.app/v1` |
| API Key | `sk-gemini` |
| Model | `gemini-3.6-flash` |

### curl Test

```bash
curl https://your-app-name.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello Gemini!"}]
  }'
```

---

## 🛠️ Local Development

You can run and test the Vercel Edge Function locally using the Vercel CLI:

```bash
npm install -g vercel
vercel dev
```

The local server will start at `http://localhost:3000`.

---

## 🚨 Troubleshooting

### `FUNCTION_INVOCATION_TIMEOUT` (504)

Vercel Edge Functions must **begin sending a response within 25 seconds**, otherwise the
invocation is terminated with a 504. Non-streaming requests now cap all retries at a 22s
pre-response deadline. If you still see this:

| Cause | Fix |
|---|---|
| Gemini upstream unreachable or slow | Lower `REQUEST_TIMEOUT_SEC` (e.g. `10`) so a single attempt cannot consume the deadline. |
| `GEMINI_BL` build label expired (upstream returns 405) | Open `https://gemini.google.com/app`, press F12 → Network tab, search any request URL for `boq_assistant`, copy the newest label into the `GEMINI_BL` environment variable. |
| Rate limited by Google (upstream returns 429) | Add a valid `COOKIE_STRING` (+ `SAPISID`) environment variable, or lower request frequency. |

### `FUNCTION_INVOCATION_FAILED` (500)

The function crashed with an unhandled exception. The handler has a top-level try/catch
that returns a structured JSON `500`, so this usually means the error happened before the
handler was invoked. Check **Deployments → Runtime Logs** in the Vercel dashboard.

### Malformed request (non-string `model`, non-object JSON body)

Fixed: invalid input returns a structured `400` instead of crashing.

### Logs

Runtime logs are available in the Vercel dashboard under **Deployments → Runtime Logs**
(or `vercel logs <deployment-url>`). The handler logs requests as
`[HH:MM:SS] [LEVEL] message` when `logRequests` is enabled (default).
