# ⚡ Quick Setup Guide

Get the Gemini proxy worker running on Cloudflare Workers in ~5 minutes.

---

## 1. Prerequisites

- Node.js 18+
- A Cloudflare account (free plan works)
- A logged-in **gemini.google.com** session in your browser

## 2. Get your Gemini cookie

1. Open [gemini.google.com](https://gemini.google.com) and make sure you're logged in.
2. Press `F12` → **Network** tab → refresh the page → click any request to `gemini.google.com`.
3. Under **Request Headers**, copy the full `Cookie` value (the whole long string).
4. Optional but recommended: also copy your `SAPISID` value from the cookie string.

> Multiple accounts? Join several cookies with `|` — e.g. `COOKIE_STRING="cookie1|cookie2"` — and the worker rotates them randomly.

## 3. Create the KV namespace (one command)

```bash
npx wrangler login
npx wrangler kv namespace create PROXY_KV
```

Copy the returned `id` and paste it into `wrangler.jsonc`, replacing the placeholder:

```jsonc
"kv_namespaces": [
  { "binding": "PROXY_KV", "id": "paste-your-id-here" }
]
```

KV is what makes the daily cron (`0 0 * * *`, already configured) useful: the cron refreshes and tests the proxy pool in its own invocation and writes the verified list to KV, so user requests skip the cold-start test cost entirely.

## 4. Set your secrets

```bash
npx wrangler secret put COOKIE_STRING   # paste the cookie from step 2
npx wrangler secret put SAPISID         # optional, from the same cookie
npx wrangler secret put API_KEY         # your own key, e.g. sk-my-secret-123
```

## 5. Deploy

```bash
npm install
npx wrangler deploy
```

Note your worker URL, e.g. `https://free-gemini.<your-subdomain>.workers.dev`.

## 6. Verify

```bash
curl https://your-worker.workers.dev/health
curl -H "Authorization: Bearer sk-my-secret-123" \
     https://your-worker.workers.dev/v1/models
```

## 7. Use it (OpenAI-compatible)

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-my-secret-123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

Point any OpenAI-compatible client (NextChat, LobeChat, Codex CLI, …) at `https://your-worker.workers.dev/v1` with your API key.

---

## Optional environment variables

| Variable | Default | Purpose |
|-|-|-|
| `ENABLE_PROXY` | `true` | Route via free proxy pool (`false`/`0` to disable and always go direct) |
| `STATIC_PROXIES` | — | Your own proxies, comma-separated — far more reliable than free pools |
| `PROXY_MAX_POOL_SIZE` | `12` | Max verified proxies kept in the pool |
| `PROXY_ROTATION_MODE` | `best-of-2` | `round-robin` / `random` / `best-of-2` / `weighted` |
| `PROXY_SOURCE_URL` | ProxyScrape | Custom proxy list source |
| `PROXY_UPDATE_INTERVAL_HOURS` | `24` | Pool refresh interval |

Set them in the Cloudflare dashboard (**Workers → your worker → Settings → Variables**) or in `wrangler.jsonc` under `"vars"`.

## Useful endpoints

| Endpoint | Auth | What it shows |
|-|-|-|
| `GET /health` | public | Worker + proxy status, version |
| `GET /v1/models` | API key | Available models |
| `GET /proxies` | API key | Pool status + proxy latencies |
| `POST /proxies/refresh` | API key | Force a pool refresh now |
| `GET /debug/proxies` | API key | Per-proxy health, fail counts, rotation scores |

## Troubleshooting

- **`401 invalid api key`** — pass the key as `Authorization: Bearer …`, `x-api-key: …`, or `?key=…`.
- **`upstream error: Too many subrequests…`** — should be fixed (v1.7.2+ budget system). Make sure you deployed the latest `worker.js`.
- **Slow first request** — cold start: the pool is being fetched/tested. With KV + cron enabled this only happens once per day.
- **Cookie errors / auth failures** — your Gemini cookie expired; re-copy it and `npx wrangler secret put COOKIE_STRING` again.
