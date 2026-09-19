# Gemini Web2API - Netlify Deployment Documentation

[中文文档](NETLIFY_CN.md) | [Cloudflare Docs](../cloudflare/README.md) | [Netlify Docs](../netlify/README.md) | [Deno Docs](../deno/README.md)

Run Gemini Web2API on Netlify Edge Functions for SSE streaming and no server maintenance.

---

## Quick Deploy

### Option 1: 1-Click Deploy to Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/adrianpriza-ai/free-gemini)

1. Click the Deploy to Netlify button above.
2. Connect your GitHub account and choose a repository name.
3. (Optional) In **Environment Variables**, configure `API_KEY` or `COOKIE_STRING`.
4. Click **Deploy**. Your API is live within a minute at `https://your-app-name.netlify.app`.

---

### Option 2: Connect via Netlify Dashboard (Git)

1. Fork or push this repository to your GitHub account.
2. Open the [Netlify Dashboard](https://app.netlify.com).
3. Click **Add new site** → **Import an existing project**.
4. Select **GitHub** and authorize access to your repository.
5. In the build settings:
   - **Base directory**: (leave blank)
   - **Build command**: (leave blank)
   - **Publish directory**: (leave blank)
6. Click Deploy site.
7. Netlify will automatically detect `netlify.toml` and configure the edge function at `/*`.

---

## Environment Variables (Optional)

Configure these in Netlify: **Site configuration** → **Environment variables** → **Add a variable**.

| Variable | Type | Description | Default |
|---|---|---|---|
| `API_KEY` / `API_KEYS` | String | Authorized client API keys (comma or `\|` separated). | `sk-gemini` |
| `COOKIE_STRING` | String | Google account cookies (`__Secure-1PSID`, etc.) for authenticated access. | `null` |
| `SAPISID` | String | SAPISID value (auto-extracted from `COOKIE_STRING` if omitted). | `null` |
| `DEFAULT_MODEL` | String | Default model if client does not specify one. | `gemini-3.6-flash` |
| `GEMINI_BL` | String | Gemini web build label (e.g. `boq_assistant-bard-web-server_...`). | built-in latest |
| `RATE_LIMIT_MAX` | Number | Max requests per IP in the window. | `3000` |
| `RATE_LIMIT_WINDOW` | Number | Rate limit window in seconds. | `60` |
| `ENABLE_PROXY` | String | Enables the rotating proxy pool on platforms with raw TCP sockets (e.g. Cloudflare Workers). **Not supported on Netlify Edge** (the runtime exposes only web-standard APIs, no `Deno.connect`) — setting it has no effect beyond a `WARN` in the logs; requests still work via the mode below. Use `HTTPS_PROXY` instead. | `false` |
| `HTTPS_PROXY` | String | Static outbound proxy URL (e.g. `http://user:pass@proxy:port`). Netlify Edge Functions run on Deno, whose `fetch()` reads `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` natively — once set, every upstream request is tunneled through the proxy automatically, no code or adapter change needed. `HTTP_PROXY`, `ALL_PROXY` (and lowercase variants) are also honored; use `NO_PROXY` to exempt hosts. | none (direct) |

> Proxy support on Netlify: Netlify Edge Functions do not provide raw TCP sockets (`Deno.connect` / `cloudflare:sockets`), so the rotating proxy pool (`ENABLE_PROXY`/`PROXY_ENABLED`) is not supported on Netlify and is ignored with a `WARN` in the logs. To route traffic through a proxy on Netlify, set `HTTPS_PROXY` instead — this is the same native Deno tunneling the [Deno Deploy](../deno/README.md) deployment gets, and it works out of the box because Edge Functions run on Deno.
>
> Check `/health` after setting `HTTPS_PROXY`: `proxy.mode` should flip from `direct` to `outbound` and `proxy.enabled` to `true` (the proxy URL value itself is never reported). If it still says `direct`, the two usual causes are:
>
> 1. Scope: the environment variable's scope must include **Functions** (Netlify Dashboard → Site configuration → Environment variables → the variable's scope checkboxes), otherwise Edge Functions never see it at runtime.
> 2. Redeploy: environment variables are injected at deploy time — trigger a redeploy after adding/changing `HTTPS_PROXY`.
>
> Node.js runtime caveat: the above applies to **Edge Functions** (`netlify/edge-functions/`, Deno). The classic **Netlify Functions** runtime (`netlify/functions/`, Node.js) does **not** auto-tunnel `fetch()` through `HTTPS_PROXY` — on Node 18+ you'd need a custom dispatcher (e.g. `undici.ProxyAgent`). This repo's Netlify deployment uses the Edge function at `/*`, so `HTTPS_PROXY` works as described.

> Tip for Multiple Cookies: You can rotate between multiple Google accounts by separating cookies with a pipe character (`|`), e.g. `cookie_account_1| cookie_account_2`.

---

## Verification

Once deployed, check your health endpoint in your browser or with curl:

```bash
curl https://your-app-name.netlify.app/health
```

Expected response:
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

The `proxy` block reflects the actual outbound mode: `direct` (default), `outbound` (static `HTTPS_PROXY` in effect), or `pool` (rotating proxy pool — Cloudflare Workers and Deno Deploy only). Note that `poolSupported` is always `false` on Netlify Edge, so `ENABLE_PROXY=true` alone can never switch the mode to `pool` here; use `HTTPS_PROXY` to get `"mode": "outbound"` — that's the supported way to proxy upstream traffic on Netlify.

---

## Client Configuration

### NextChat / ChatGPT-Next-Web

| Field | Value |
|---|---|
| Interface Type | OpenAI |
| Endpoint / Base URL | `https://your-app-name.netlify.app/v1` |
| API Key | `sk-gemini` (or your configured `API_KEY`) |
| Model | `gemini-3.6-flash` or `gemini-3.5-flash-thinking` |

### Cherry Studio / ChatBox

| Field | Value |
|---|---|
| Provider | OpenAI |
| API Base URL | `https://your-app-name.netlify.app/v1` |
| API Key | `sk-gemini` |
| Model | `gemini-3.6-flash` |

### curl Test

```bash
curl https://your-app-name.netlify.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello Gemini!"}]
  }'
```

---

## Local Development

You can run and test the Netlify Edge Function locally using Netlify CLI:

```bash
npm install -g netlify-cli
netlify dev
```

The local edge server will start at `http://localhost:8888`.

---

## Troubleshooting

### `Error - Request ID: 01M...`

That page is Netlify's generic error response. It shows up when the edge function
crashes with an unhandled exception, or when it fails to send response headers
within Netlify's 40-second limit. The real error is in the dashboard under
**Logs → Edge Functions**.

Known causes and fixes:

| Cause | Fix |
|---|---|
| Gemini upstream unreachable or slow, retries ran past the 40s header limit | Fixed: non-streaming requests now cap all retries at a 30s pre-response deadline. If it still happens, lower `REQUEST_TIMEOUT_SEC` (e.g. `10`). |
| Malformed request (non-string `model`, non-object JSON body) | Fixed: invalid input now returns a structured `400` instead of crashing. |
| Expired `GEMINI_BL` build label (upstream returns 405) | Open `https://gemini.google.com/app`, press F12 → Network tab, search any request URL for `boq_assistant`, copy the newest label into the `GEMINI_BL` environment variable. |
| Rate limited by Google (upstream returns 429) | Add a valid `COOKIE_STRING` (+ `SAPISID`) environment variable, or lower request frequency. |
| A bug crashing the handler | Fixed: the entry handler has a top-level try/catch that returns a JSON `500` with the error message instead of the opaque error page. |

After any failure, the response body and the function logs now show the actual
error message, so you no longer have to guess behind `Error - Request ID`.
