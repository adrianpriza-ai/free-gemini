# Gemini Web2API - Deno Deploy Documentation

[中文文档](README_CN.md) | [Cloudflare Docs](../cloudflare/README.md) | [Netlify Docs](../netlify/README.md) | [Vercel Docs](../vercel/README.md)

Run Gemini Web2API on [Deno Deploy](https://deno.com/deploy) for SSE streaming with raw TCP socket support — zero config, no server to maintain.

> The entrypoint is at [`deno/deploy.js`](../deno/deploy.js), a thin Deno adapter over the shared core in [`src/`](../src/) (the same core used by the Cloudflare, Netlify and Vercel adapters). It starts an HTTP server with `Deno.serve()` — the API required by the current Deno Deploy platform (Deploy Classic, which accepted legacy `serve()`, was shut down on 2026-07-20). [`deno/sockets.js`](../deno/sockets.js) wraps `Deno.connect` into the socket shape the proxy pool expects, so the rotating proxy pool works on Deno too.

> Deno Deploy is a good fit because, like Cloudflare Workers (but unlike Netlify/Vercel Edge), Deno exposes raw TCP sockets (`Deno.connect`), so the full rotating proxy pool is available. And like Netlify Edge (but unlike Vercel), Deno's `fetch()` natively tunnels through `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` for static outbound proxies.

---

## Quick Deploy

### Option 1: GitHub integration (recommended)

1. Fork or push this repository to your GitHub account.
2. Sign in at [console.deno.com](https://console.deno.com) and create an **organization** (new Deno Deploy uses a separate account system from the retired Deploy Classic).
3. Click **+ New App**, select your GitHub repository, and grant the Deno Deploy GitHub app access if prompted.
4. In **Edit build config**:
   - **Framework preset**: `No Preset`
   - **Install command**: (leave empty)
   - **Build command**: (leave empty)
   - **Runtime mode**: `Dynamic`
   - **Entrypoint**: `deno/deploy.js`
5. (Optional) Add environment variables (see table below), choosing the Production/Development contexts.
6. Click **Create App**. The build runs, warms up, and your API is live at `https://your-app-name.deno.net`.

### Option 2: Deno CLI

The `deployctl` CLI is sunset; the `deno deploy` subcommand replaces it (Deno 2.x includes it).

```bash
deno deploy create \
  --org your-org \
  --app gemini-web2api \
  --source local \
  --runtime-mode dynamic \
  --entrypoint deno/deploy.js \
  --region global

# subsequent deploys of an existing app:
deno deploy --org your-org --app gemini-web2api --prod
```

Environment variables can be managed from the CLI too:

```bash
deno deploy env add API_KEY "sk-your-key" --secret
```

---

## Environment Variables (Optional)

Configure these in Deno Deploy: **app settings → Add/Edit environment variables** (or `deno deploy env add`).

| Variable | Type | Description | Default |
|-|-|-|-|
| `API_KEY` / `API_KEYS` | String | Authorized client API keys (comma or `\|` separated). | `sk-gemini` |
| `COOKIE_STRING` | String | Google account cookies (`__Secure-1PSID`, etc.) for authenticated access. | `null` |
| `SAPISID` | String | SAPISID value (auto-extracted from `COOKIE_STRING` if omitted). | `null` |
| `DEFAULT_MODEL` | String | Default model if client does not specify one. | `gemini-3.6-flash` |
| `GEMINI_BL` | String | Gemini web build label (e.g. `boq_assistant-bard-web-server_...`). | built-in latest |
| `RATE_LIMIT_MAX` | Number | Max requests per IP in the window. | `3000` |
| `RATE_LIMIT_WINDOW` | Number | Rate limit window in seconds. | `60` |
| `REQUEST_DEADLINE_MS` | Number | Server-side per-request deadline (ms): returns a structured 502 (`upstream_timeout`) instead of hanging when the upstream response is not ready in time. Keep below the platform's 55s response-header limit. `0` disables | `50000` |
| `ENABLE_PROXY` | String | Enables the rotating **proxy pool** (`Deno.connect` raw sockets are available on Deno). | `false` |
| `HTTPS_PROXY` | String | Static outbound proxy URL (e.g. `http://user:pass@proxy:port`). Deno's `fetch()` reads `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` natively, so direct requests are tunneled automatically. `HTTP_PROXY` and `ALL_PROXY` are also honored. | none (direct) |

> TLS proxying note (Deno Deploy): Deno Deploy prohibits plain `Deno.connect` to port 443 (TLS termination is required on 443; see Deno's "Pricing and limitations" page). The proxy pool only ever connects to *proxy servers* — typically on ports 80/1080/3128/8080 — so normal HTTP/SOCKS proxies are unaffected. Plain SOCKS/HTTP proxies on 443 would fail on Deploy but work under local `deno run`. The `/health` endpoint reports the effective mode under `proxy.mode` (`direct`, `outbound`, or `pool`).

> Tip for Multiple Cookies: You can rotate between multiple Google accounts by separating cookies with a pipe character (`|`), e.g. `cookie_account_1| cookie_account_2`.

---

## Verification

Once deployed, check your health endpoint in your browser or with curl:

```bash
curl https://your-app-name.deno.net/health
```

Expected response:
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

`poolSupported` is `true` on Deno (raw TCP sockets are available), so setting `ENABLE_PROXY=true` switches the mode to `pool` — the same full proxy-pool experience as Cloudflare Workers.

---

## Client Configuration

### NextChat / ChatGPT-Next-Web

| Field | Value |
|-|-|
| Interface Type | OpenAI |
| Endpoint / Base URL | `https://your-app-name.deno.net/v1` |
| API Key | `sk-gemini` (or your configured `API_KEY`) |
| Model | `gemini-3.6-flash` or `gemini-3.5-flash-thinking` |

### Cherry Studio / ChatBox

| Field | Value |
|-|-|
| Provider | OpenAI |
| API Base URL | `https://your-app-name.deno.net/v1` |
| API Key | `sk-gemini` |
| Model | `gemini-3.6-flash` |

### curl Test

```bash
curl https://your-app-name.deno.net/v1/chat/completions \
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

Run the exact same adapter locally with the Deno CLI (no account needed):

```bash
deno run --allow-net --allow-env deno/deploy.js
# or: npm run dev:deno
```

The server starts at `http://localhost:8000` (`Deno.serve`'s default port; set the `DENO_PORT` environment variable, e.g. `DENO_PORT=8081 deno run ...`, to change it).

> Always pass `--allow-env`: the adapter reads config from environment variables at request time. Running with only `--allow-net` makes the first request block on Deno's interactive permission prompt — in a background/pipe context that prompt is invisible and every request appears to hang forever. The entry now self-checks permissions at startup and exits with a clear message instead.

---

## Troubleshooting

### `upstream timeout: no response within 50000ms (REQUEST_DEADLINE_MS)` (502)

The server gave up waiting for Gemini because no upstream response (headers) arrived within `REQUEST_DEADLINE_MS` (default 50s). This is a symptom, not the root cause — on Deno Deploy the usual root causes are:

1. **Anonymous direct egress is throttled by Gemini.** Requests without cookies leave from Deno Deploy's shared edge IPs, which Gemini frequently hangs or stalls (especially for non-streaming requests, where the full response must be ready before any of it can be returned). Fixes, in order of effectiveness:
   - Set a valid `COOKIE_STRING` (+ `SAPISID`) — the single most effective fix.
   - Enable the rotating proxy pool: `ENABLE_PROXY=true` (Deno raw sockets are supported), or set a static `HTTPS_PROXY`.
2. **Long generations exceed the deadline.** Non-streaming requests with big outputs can legitimately take >50s. Raise `REQUEST_DEADLINE_MS` (e.g. `90000`), or use `stream: true` so tokens arrive incrementally.
3. **The 50s router deadline is shorter than the 55s retry budget.** This is already fixed in code: the retry loop now aligns to the router deadline and surfaces the real per-attempt error (e.g. a readable per-attempt timeout with hints) instead of the generic 502. If you still see the generic message on an old deployment, redeploy.

> ℹ️ **Seeing `HTTP 429: Too Many Requests - 请添加有效的 Cookie 或降低请求频率` instead?** That is the *correct*, attributed error — Gemini is answering with 429 (rate limited), and older versions could mask it behind the generic timeout when Gemini's `Retry-After` wait exceeded the remaining deadline budget. The retry loop now surfaces the real 429 immediately instead of burning the budget on a doomed wait. If 429s are constant, set `COOKIE_STRING` or reduce request frequency.

Quick check: `GET /health` reports the effective outbound mode under `proxy.mode` (`direct` / `outbound` / `pool`) — if it says `direct` and you have no cookies, cause #1 applies to you.

### Requests hang / no response at all (local `deno run`)

The adapter reads env config on every request. If you started the server without `--allow-env` (e.g. `deno run --allow-net deno/deploy.js`), the first request blocks on Deno's interactive permission prompt. In a terminal you'd see the prompt, but with background/piped output it is invisible — the server just never replies. Start with both flags (the entry now exits immediately with a clear error when permissions are missing):

```bash
deno run --allow-net --allow-env deno/deploy.js
```

### `TLS proxying is not allowed` / connection errors to port 443

Deno Deploy prohibits non-TLS `Deno.connect` to port 443. The proxy pool connects to proxy servers (rarely on 443), so this usually only bites if you add a SOCKS/HTTP proxy listening on 443 to `STATIC_PROXIES`. Move the proxy to a standard port, or drop `ENABLE_PROXY` and set `HTTPS_PROXY` instead (Deno `fetch()` tunnels through it natively).

### Warmup/build fails with a timeout

Make sure the **Entrypoint** is set to `deno/deploy.js` and Runtime mode is `Dynamic`. The entry uses `Deno.serve()`; older Deploy Classic snippets that import `serve()` from `deno.land/std/http` will not work on the new platform.

### Upstream 429 / empty responses

Gemini's web endpoint rate-limits anonymous requests aggressively. Add a valid `COOKIE_STRING` (+ `SAPISID`) environment variable, or lower request frequency. The adapter enables the proxy pool (`ENABLE_PROXY=true`) to rotate exit IPs, which helps when a single IP is throttled.

### Logs

Runtime logs, traces and metrics are available in the Deno Deploy dashboard under **Logs** / **Traces** for your app. The handler logs requests as `[HH:MM:SS] [LEVEL] message` when `logRequests` is enabled (default).
