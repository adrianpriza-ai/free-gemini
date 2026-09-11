# Gemini Web2API - Cloudflare Workers Deployment Documentation

[中文文档](README_CN.md) | ⚡ **[Quick Setup Guide](SETUP.md)** (~5 min, zero to deployed)

> 🚀 **New here?** Follow the [Quick Setup Guide](SETUP.md) — cookie, KV, secrets, deploy, verify, first request.

## 📖 Project Introduction

Gemini Web2API is a serverless proxy service deployed on Cloudflare Workers that converts the Google Gemini web interface into an OpenAI-compatible API interface. No server required, no API Key needed (optional), ready to use out of the box.

### Core Features

- **Zero-cost deployment**: Based on Cloudflare Workers free plan (100,000 requests per day)
- **Global acceleration**: Automatically deployed to Cloudflare's 300+ global edge nodes
- **OpenAI compatible**: Fully compatible with `/v1/chat/completions` and `/v1/models` endpoints
- **Typewriter streaming output**: True SSE (Server-Sent Events) streaming response
- **Multi-fingerprint rotation**: 8 browser fingerprints + 6 language preferences randomly rotated to reduce detection probability
- **Multi-Cookie rotation**: Supports configuring multiple Google account cookies, randomly selected for use
- **Concurrent safety**: Request-level configuration isolation, completely eliminating configuration crosstalk in high-concurrency scenarios
- **Tool call support**: Compatible with OpenAI Function Calling format
- **ProxyScrape Auto Proxy Rotation**: Automatically fetches free proxies from ProxyScrape (timeout <= 200ms API or GitHub raw), auto-tests connectivity against `gemini.google.com:443`, supports HTTP/SOCKS4/SOCKS5 via `cloudflare:sockets`. Uses **Smart Round Robin** (inverse-latency weighted selection) so the fastest verified proxy wins most requests while slower ones still get periodic health checks, updates every 24 hours (Cron Trigger + auto background refresh), features **in-memory candidate caching** to avoid redundant upstream fetches, and seamlessly falls back to direct connection.

### Applicable Scenarios

- Provide free Gemini API for NextChat, Cherry Studio, ChatBox and other clients
- Used as Gemini model backend in tools like WorkBuddy
- Personal learning, research and small project AI capability access

---

## 🚀 Quick Deployment

### Step 1: Log in to Cloudflare

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Log in to your Cloudflare account (free registration available if you don't have one)
3. Go to the left menu **Workers & Pages**

### Step 2: Create Worker

1. Click **Create Application** → **Create Worker**
2. Give your Worker a name (e.g., `api`)
3. Click the **Deploy** button
4. Click the **Edit Code** button
5. Clear the default code in the editor
6. Paste the complete project code into the editor
7. Click **Save and Deploy** in the top right corner

### Step 3: Get Test Address

After successful deployment, your API address is:

```
https://your-worker-name.your-account-name.workers.dev
```

For example: `https://api.geminai.workers.dev`

### Step 4: Verify Deployment

Visit the following address in your browser:

```
https://your-worker.workers.dev/health
```

If you see a JSON response similar to the following, deployment is successful:

```json
{
  "status": "ok",
  "version": "1.5.0-cf-multifingerprint",
  "platform": "Cloudflare Workers",
  "models": ["gemini-3.6-flash", "gemini-3.5-flash", "..."],
  "hasCookie": false,
  "hasSapisid": false
}
```

---

## 🔧 Client Configuration

### NextChat (ChatGPT-Next-Web)

| Configuration Item | Value |
|-|-|
| Interface Type | OpenAI |
| Interface Address | `https://your-worker.workers.dev/v1` |
| API Key | `sk-gemini` (default key) |
| Model | `gemini-3.6-flash` |

### Cherry Studio

| Configuration Item | Value |
|-|-|
| API Address | `https://your-worker.workers.dev/v1` |
| API Key | `sk-gemini` |
| Model | `gemini-3.6-flash` |

### ChatBox

| Configuration Item | Value |
|-|-|
| API Mode | OpenAI API |
| API Domain | `https://your-worker.workers.dev` |
| API Path | `/v1/chat/completions` |
| API Key | `sk-gemini` |

### Using curl for Testing

```bash
# Non-streaming request
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'

# Streaming request (typewriter effect)
curl -N https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'
```

---

## ⚙️ Environment Variable Configuration (Optional)

Configure in Cloudflare Dashboard → Workers → Your Worker → Settings → Variables → Environment Variables:

### Authentication Related

| Variable Name | Description | Example Value |
|-|-|-|
| `COOKIE_STRING` | Gemini Cookie, multiple separated by `\|` | `cookie1\| cookie2\| cookie3` |
| `SAPISID` | SAPISID value, multiple separated by `\|` | `sapisid1\| sapisid2\| sapisid3` |
| `API_KEY` / `API_KEYS` | API Key, supports single string, comma/pipe-separated multiple keys, or JSON array | `my-secret-key` or `key1, key2` or `["sk-gemini", "my-key"]` |

### Gemini Configuration

| Variable Name | Description | Example Value |
|-|-|-|
| `GEMINI_BL` | Gemini build tag (update when encountering 405) | `boq_assistant-bard-web-server_20260907.07_p0` |
| `DEFAULT_MODEL` | Default model | `gemini-3.6-flash` |
| `AUTH_USER` | Multi-account index | `0` |

### Performance Optimization

| Variable Name | Description | Default Value |
|-|-|-|
| `RETRY_ATTEMPTS` | Retry attempts | `3` |
| `RETRY_DELAY_SEC` | Retry interval (seconds) | `2` |
| `REQUEST_TIMEOUT_SEC` | Request timeout (seconds) | `28` |
| `FINGERPRINT_JITTER_MS` | Random delay maximum value (milliseconds) | `1500` |
| `RATE_LIMIT_MAX` | Rate limit maximum request count | `3000` |
| `RATE_LIMIT_WINDOW` | Rate limit time window (seconds) | `60` |

### 🌐 Auto Proxy Pool & 24h Update Configuration

| Variable Name | Description | Default Value |
|-|-|-|
| `ENABLE_PROXY` | Enable/disable proxy rotation | `true` |
| `PROXY_SOURCE_URL` | Primary proxy source URL (ProxyScrape 200ms API) | `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=200` |
| `PROXY_FALLBACK_SOURCE_URL` | Fallback proxy source URL (GitHub raw full list) | `https://raw.githubusercontent.com/ProxyScrape/free-proxy-list/refs/heads/main/proxies/all/data.txt` |
| `STATIC_PROXIES` / `PROXY_URL` | Custom fixed proxies (comma/newline separated, e.g. `http://user:pass@ip:port`, `socks5://ip:port`) | (empty) |
| `AUTO_TEST_PROXY` | Auto-test proxies before adding to verified pool | `true` |
| `PROXY_TEST_TIMEOUT_MS` | Per-proxy connection test timeout (ms) | `1000` |
| `PROXY_UPDATE_INTERVAL_HOURS` | Proxy pool auto-update interval (hours) | `24` |
| `PROXY_MAX_POOL_SIZE` | Maximum verified proxies to keep in pool | `12` |
| `PROXY_FALLBACK_DIRECT` | Fall back to direct connection if all proxies fail | `true` |
| `PROXY_ROTATION_MODE` | Proxy selection algorithm — see [Proxy Rotation Modes](#proxy-rotation-modes) below | `best-of-2` |

#### Proxy Rotation Modes

Set `PROXY_ROTATION_MODE` to one of four values to control how the next proxy is chosen for each request. All modes share the same **adaptive scoring layer**: every successful request updates the proxy's latency with an EWMA (α = 0.3) and resets its fail counter, so a proxy that just slowed down drops in rank within ~3 requests, and a recovered one climbs back. Every failed request increments `fails`, which halves that proxy's score (exponential cooldown), and any proxy that hits 2 cumulative fails is evicted from the pool.

| Mode | Selection rule | Cost | Best for |
|-|-|-|-|
| `best-of-2` *(default)* | Pick 2 distinct proxies at random, return the one with the higher score | O(1) | **Production** — near-optimal load balancing, naturally avoids the heavy-weight concentration of pure roulette |
| `round-robin` | Strict sequential walk through the pool, wrap around at the end | O(1) | Want perfect fairness, no quality signal |
| `random` | Pure uniform random, ignores latency and fails | O(1) | Debugging / baseline comparison |
| `weighted` | Inverse-latency roulette with a 10% exploration floor so the slowest proxy still gets probed | O(n) | Compatible with the legacy "Smart Round Robin" — use if you need explicit probability distribution over all proxies |

**Score formula** (used by `best-of-2` and `weighted`):

```
score = reliability / (latency + 1)
reliability = 1           if fails == 0
            = 0.5 ^ fails  otherwise
```

- Latency defaults to 1000 ms if missing or non-positive, so the `latency=0` path (pretest disabled) no longer collapses to `1/0 = Infinity`.
- `fails` resets to 0 on the first successful request, so a proxy recovers fully after one good call.

**Examples:**

```bash
# Default — power-of-two choices
PROXY_ROTATION_MODE=best-of-2

# Strict sequential, ignore quality
PROXY_ROTATION_MODE=round-robin

# Pure random, for A/B testing
PROXY_ROTATION_MODE=random

# Legacy inverse-latency weighted
PROXY_ROTATION_MODE=weighted
```

Invalid values are ignored and logged as a `WARN`; the worker keeps the default (`best-of-2`).

#### How the 24-Hour Update Works:
1. **Cloudflare Cron Trigger (Recommended)**:
   - When deploying via Wrangler, `wrangler.jsonc` already configures `"triggers": { "crons": ["0 0 * * *"] }`.
   - In Cloudflare Dashboard: Go to **Workers & Pages** → Your Worker → **Triggers** → **Cron Triggers** → **Add Cron Trigger** → enter `0 0 * * *` (every 24 hours at 00:00 UTC).
2. **On-Demand Auto-Update**:
   - Even if you don't configure a Cron Trigger, the Worker automatically checks the timestamp on incoming requests. If 24 hours have passed since the last update, it refreshes the proxy pool in the background using `ctx.waitUntil()` without slowing down user requests!
3. **Cloudflare KV Persistence (Recommended with Cron)**:
   - Bind a KV namespace named `PROXY_KV` to your Worker. Verified proxies will be cached in KV across all edge data center instances!
   - **This is what makes the Cron Trigger effective**: the daily cron refresh runs in its own invocation with its own subrequest budget, tests the pool, and writes the verified result to KV — so user requests on any isolate load the warm pool from KV instead of paying the cold-start test cost.
   - Setup: `npx wrangler kv namespace create PROXY_KV`, then paste the returned namespace `id` into the `kv_namespaces` block of `wrangler.jsonc` (a placeholder is already there).
   - Without KV, the cron refresh only warms the cron's own throwaway isolate; each user-facing isolate still does its own cold-start refresh. 4. **Proxy Endpoints** (all require a valid API key — same auth as `/v1` endpoints):
    - `GET /proxies`: View proxy pool status, active proxy count, latencies, and last/next update times.
    - `POST /proxies/refresh` or `GET /proxies/refresh`: Force an immediate re-fetch and test of the proxy pool.
    - `GET /debug/proxies`: Detailed pool diagnostics — per-proxy health (`healthy`/`flaky`), latency, fail counts, rotation scores (highest first), and internal state (candidate cache, refresh due, rotation mode). Requires a valid API key (same auth as `/v1` endpoints).
    - `GET /health`: Includes live proxy status in the health check JSON.
5. **In-Memory Candidate Caching (Free)**:
   - After fetching from the primary/fallback source, the parsed candidate list is cached **per Worker Isolate** (free, no KV cost).
   - TTL equals `PROXY_UPDATE_INTERVAL_HOURS` (24h default). Within one cycle, refresh attempts reuse the cache and skip both the ProxyScrape and GitHub raw fetches.
   - Manual `/proxies/refresh` calls bypass the cache (`force=true`) and always re-fetch.
   - Empty results never poison the cache, so a transient primary failure won't lock the pool.

---


## 🍪 How to Get Gemini Cookie

### Why Do You Need Cookie?

Anonymous requests are easily rate-limited by Gemini (returning HTTP 429 error). Configuring valid Cookie can:
- Significantly reduce the probability of being rate-limited
- Improve Pro model routing quality
- Obtain a more stable service experience

### Obtaining Steps

1. Open Chrome/Edge browser
2. Visit https://gemini.google.com/app and log in to your Google account
3. Press **F12** to open developer tools
4. Go to the **Application** tab
5. On the left, select **Cookies** → `https://gemini.google.com`
6. Find the following Cookies and copy their values:
   - `__Secure-1PSID`
   - `__Secure-3PSID`
   - `SAPISID`
7. Combine into a complete Cookie string:
   ```
   __Secure-1PSID=your_value; __Secure-3PSID=your_value; SAPISID=your_value
   ```

### Multi-account Configuration

If you have multiple Google accounts, you can separate multiple Cookies with `|`:

```
COOKIE_STRING = "cookie_account1| cookie_account2| cookie_account3"
SAPISID = "sapisid_1| sapisid_2| sapisid_3"
```

Each request will randomly select a Cookie to use, greatly reducing the probability of a single account being rate-limited.

---

## 🔄 Updating BL Version

If you encounter `HTTP 405: Method Not Allowed` error, it means the Gemini frontend has been updated, and you need to synchronize the build tag update:

1. Open https://gemini.google.com/app in browser
2. Press **F12** → **Network** tab
3. Search for `boq_assistant` in any request's URL
4. Copy the latest version number, for example:
   ```
   boq_assistant-bard-web-server_20260730.02_p0
   ```
5. Update the environment variable `GEMINI_BL` or the `geminiBl` configuration item in the code

---

## 🎭 Multi-fingerprint Rotation Mechanism

This program has a built-in browser fingerprint rotation system, where each request randomly selects different browser identifiers:

| Fingerprint Type | Pool Size | Description |
|-|-|-|
| User-Agent | 8 types | Weighted random, simulating real browser market share |
| Accept-Language | 6 types | Uniform random, simulating users from different regions |
| Sec-Ch-Ua | 3 types | Chrome version identifier (only added when Chrome UA) |
| Random Delay | 0-1500ms | Add random delay before request to simulate human operation |

---

## 🛡️ Security Recommendations

1. **Modify default API Key**: Change `sk-gemini` in `apiKeys` to your own key
2. **Set rate limiting**: Adjust `RATE_LIMIT_MAX` based on actual usage
3. **Regularly update Cookie**: Google Cookies expire and need regular replacement
4. **Do not share Cookie**: Cookie is equivalent to your Google account credentials

---

## ❓ Frequently Asked Questions

### Q: Returns `empty response from server`

**Cause**: NextChat streaming parsing issue.  
**Solution**: Make sure you're using the latest version of the code (SSE format has been fixed).

### Q: Returns `HTTP 429: Too Many Requests`

**Cause**: Gemini rate limiting, anonymous request frequency limits are stricter.  
**Solution**: Configure valid `COOKIE_STRING` and `SAPISID`.

### Q: Returns `HTTP 405: Method Not Allowed`

**Cause**: BL version expired.  
**Solution**: Update `geminiBl` configuration (see the "Updating BL Version" section above).

### Q: Returns `invalid api key`

**Cause**: Client API Key configuration error.  
**Solution**: Check if the client is configured with the correct API Key (default `sk-gemini`).

### Q: WorkBuddy usage shows crosstalk

**Cause**: Multi-model concurrent requests share global configuration.  
**Solution**: Current version has resolved this issue through request-level configuration isolation.

---

## 📊 Supported Model List

| Model ID | Type | Description |
|-|-|-|
| `gemini-3.8-flash` | FAST | Newest all-round model (Gemini 3.8 Flash) |
| `gemini-3.7-flash` | FAST | Latest all-round model (Gemini 3.7 Flash) |
| `gemini-3.6-flash` | FAST | All-round model (Gemini 3.6 Flash) |
| `gemini-3.5-flash` | FAST | Alias for 3.6 Flash |
| `gemini-3.5-flash-thinking` | THINKING | Deep thinking mode |
| `gemini-3.1-pro` | PRO | Professional version (requires Cookie) |
| `gemini-auto` | AUTO | Automatic model selection |
| `gemini-3.5-flash-thinking-lite` | DYNAMIC | Adaptive dynamic thinking |
| `gemini-flash-lite` | LITE | Lightweight fast model |
| `gemini-2.5-flash` | FAST | Client compatibility alias (routes to 3.6 Flash) |
| `gemini-2.0-flash` | FAST | Client compatibility alias (routes to 3.6 Flash) |
| `gemini-2.5-pro` | PRO | Client compatibility alias (routes to 3.1 Pro) |

Supports overriding thinking mode via `@think=` parameter:
- `gemini-3.6-flash@think=0` — Flash model + deep thinking
- `gemini-3.1-pro@think=4` — Pro model + automatic thinking

---

## 📝 Changelog

| Version | Date | Update Content |
|-|-|-|
| 1.7.3 | 2026-09-11 | Reduced default `PROXY_MAX_POOL_SIZE` from 30 to 12 so a cold-start pool refresh uses far fewer subrequests (~14 vs ~32) |
| 1.7.2 | 2026-09-11 | Fixed `Too many subrequests by single Worker invocation`: added a per-invocation subrequest budget — proxy pool refresh (source fetch + tests) is capped at 32 subrequests and stops early to reserve headroom for the actual Gemini request; proxy attempts and direct fallbacks are budget-tracked; fixed `startTls()` never working (`connect` missing `secureTransport: 'starttls'`) which made every proxied request hang |
| 1.7.1 | 2026-09-10 | Switched proxy rotation to **Smart Round Robin** (inverse-latency weighted), reduced default `PROXY_TEST_TIMEOUT_MS` from 2000 to 1000, added free in-memory candidate cache (TTL = update interval) to avoid redundant upstream fetches |
| 1.7.0 | 2026-09-10 | Added ProxyScrape auto proxy fetching (timeout <= 200ms API or GitHub raw), auto connectivity test system via cloudflare:sockets (HTTP CONNECT, SOCKS5, SOCKS4), 24-hour automatic background update & Cron Trigger support (`0 0 * * *`), automatic failover & fallback to direct connection, `/proxies` and `/proxies/refresh` management endpoints |
| 1.6.0 | 2026-09-09 | Upgraded to Chrome 132-134 fingerprint library, streaming request 429 automatic exponential backoff retry, support flexible environment variable `API_KEY` (string/comma-separated/JSON), added `gemini-3.7-flash` and 2.0/2.5 compatibility aliases, health check returns detailed status |
| 1.5.0 | 2026-07-31 | Added multi-fingerprint rotation, multi-Cookie rotation, random delay mechanism |
| 1.4.0 | 2026-07-30 | Fixed concurrent crosstalk, rate limiting memory safety |
| 1.3.0 | 2026-07-29 | Fixed SSE streaming format, NextChat compatibility |
| 1.0.0 | 2026-07-16 | Initial version, ported from gemini-web2api v1.1.0 |

---

## 📄 License

This project is based on the original project [gemini-web2api](https://github.com/Sophomoresty/gemini-web2api) ported, following the original project's open source license.
