# Gemini Web2API - Cloudflare Workers Complete Concurrent Safety Fix Version
  Multiple fingerprint rotation + Multiple cookie rotation + Typewriter effect + Random delay + ProxyScrape automatic proxy pool with 24h timed update

[中文文档](cloudflare/CLOUDFLARE-WORKERS_CN.md)

## Project Description

This program converts Google Gemini's web interface into an OpenAI-compatible API interface.
Deployed on Cloudflare Workers edge computing platform, no server required to run.
Supports streaming output (SSE typewriter effect), non-streaming output, tool calling (Function Calling).
Supports ProxyScrape free proxy pool automatic scraping, connectivity automatic testing, 24-hour timed update & automatic fallback to direct connection on failure.


Core feature list:


1. 【Concurrent Safety】Thoroughly eliminated the serious risk of global CONFIG being concurrently tampered with/cross-talked by asynchronous requests.
      Root cause: CF Workers Isolate in hot start (reuse), global scope code is not re-executed.
      When WorkBuddy etc. clients send multiple concurrent requests in extremely short time,
      they share the same global CONFIG object (because they reuse the same Isolate).
      Request A modifies CONFIG.cookieString = "cookie_a",
      Request B immediately modifies CONFIG.cookieString = "cookie_b",
      Request A subsequently uses cookie_b, causing authentication information cross-talk.
      This is particularly severe in WorkBuddy's multi-model concurrent call scenario.
      
      Solution:
      Each request creates a brand new independent configuration copy via getRequestConfig(env),
      all functions receive configuration object via parameters, completely independent of global mutable state.
   
2. 【Request-level Configuration Isolation】Implemented mechanism to create independent configuration copy for each request.
     - DEFAULT_CONFIG as read-only template, never modified
     - getRequestConfig(env) creates independent configuration copy for each request
     - Load custom configuration from env (environment variables, independently injected by CF platform for each request)
     - All function signatures include config parameter, completely eliminating global state dependency
     - Use explicit assignment (env.X || null) to prevent value retention when Isolate is reused
  
  3. 【Rate Limit Memory Safety】Fixed implicit memory leak problem of global rateLimitStore in Serverless environment.
     - In Serverless environment, Isolate may remain alive for long time (hot start reuse)
     - If expired records are not cleaned up, Map will grow infinitely causing memory leak
     - Use probabilistic cleanup mechanism (5% probability triggers global cleanup)
     - Each cleanup traverses all keys, deletes expired or empty records
     - Ensure memory usage remains stable after long-term operation
  
  4. 【SAPISID Automatic Extraction】Added defensive logic to automatically extract SAPISID from COOKIE_STRING.
     - Users usually copy complete Cookie string from browser
     - Cookie format: "__Secure-1PSID=xxx; SAPISID=yyy; ..."
     - If user sets COOKIE_STRING but forgets to separately set SAPISID
     - Program will automatically extract SAPISID value from Cookie string via regex
     - Regex expression: /SAPISID=([^;]+)/
     - Improves user experience, reduces configuration errors
  
  5. 【Multiple Fingerprint Rotation】Added browser fingerprint rotation mechanism to reduce probability of being identified by Gemini.
     - User-Agent rotation pool (8 real browser UAs, covering Windows/macOS/Linux)
     - Accept-Language rotation pool (6 language preference settings)
     - Sec-Ch-Ua rotation pool (3 Chrome version identifiers)
     - Sec-Ch-Ua-Platform rotation pool (3 operating system platforms)
     - Weighted random selection to simulate real browser market share distribution
     - Chrome ~72% (including Windows/macOS/Linux), Firefox ~8%, Safari ~8%
  
  6. 【Multiple Cookie Rotation】Supports configuring multiple Google account Cookies, randomly selected for use.
     - Environment variables use | to separate multiple Cookies: "cookie1| cookie2| cookie3"
     - Environment variables use | to separate multiple SAPISIDs: "sapisid1| sapisid2| sapisid3"
     - Each request randomly selects one Cookie and corresponding SAPISID
     - If SAPISID quantity matches Cookie quantity, use SAPISID at corresponding index
     - Greatly reduces probability of single Google account being rate-limited (429)
  
  7. 【Random Delay】Adds random micro-delay before request to simulate human operation interval.
     - Delay time randomly between 0 and fingerprintJitterMs (default 1500ms)
     - Retry also adds new random delay
     - Configurable: set environment variable FINGERPRINT_JITTER_MS=0 to disable
     - Better effect when used with fingerprint rotation
  
  8. 【SSE Typewriter Effect】OPTIONS pre-check prioritized, real-time incremental output, heartbeat keep-alive.
     SSE format strictly complies with OpenAI standard:
     - First chunk: delta: { role: 'assistant' } (only role, no content)
     - Content chunk: delta: { content: 'incremental text' } (real-time calculation and push incremental)
     - End chunk: delta: { content: "" }, finish_reason: 'stop'
     - Heartbeat keep-alive: send ": heartbeat\n\n" SSE comment every 2 seconds
  
  9. 【Complete Functionality Retention】Tool calling (Function Calling), rate limiting, API authentication,
     Google native API (Gemini CLI compatible), Responses API (Codex CLI compatible).
  
  10. 【Automatic Proxy Pool with 24h Update】
       - Automatically obtain low-latency proxy list from ProxyScrape API (default timeout=200 ultra-speed mode, saving traffic and memory)
       - Supports GitHub raw full source as backup fallback
       - Built-in automatic testing system: through cloudflare:sockets truly test target gemini.google.com:443 tunnel connectivity
       - Supports HTTP CONNECT, SOCKS5, SOCKS4 proxy protocols, automatically upgrade TLS, supports typewriter streaming output
       - Smart Round Robin (default rotation mode): inverse-latency weighted selection — the fastest verified proxy is most likely to be chosen, while slower proxies still receive occasional traffic so their availability is continuously re-validated
       - In-memory candidate caching: the parsed proxy list is cached per Worker Isolate (free, no KV cost). TTL aligns with the update interval so repeated refresh attempts within one cycle skip both the ProxyScrape and GitHub raw fetches. Empty results are never cached
       - Automatically refresh proxy pool every 24 hours (supports Cloudflare Cron timed trigger & on-demand background asynchronous update)
       - Supports Cloudflare KV persistent caching (shared tested proxies across multiple instances)
       - Automatic failover: single proxy request failure automatically rotates to next, all proxies failure automatically falls back to direct connection, ensuring service high availability
       - Default per-proxy handshake test timeout is 1000ms (configurable via PROXY_TEST_TIMEOUT_MS)


## Deployment Instructions:

1. Log in to Cloudflare Dashboard -> Workers & Pages
2. Create Worker -> Paste this code -> Save and deploy
3. Configure environment variables (optional):

    【Authentication Related】
    - COOKIE_STRING: Cookie string, multiple separated by |
      Format: "cookie_account1| cookie_account2| cookie_account3"
      Copy complete Cookie from browser F12 -> Application -> Cookies
      Contains __Secure-1PSID, __Secure-3PSID, SAPISID, etc.
    - SAPISID: SAPISID value, multiple separated by |
      Format: "sapisid_1| sapisid_2| sapisid_3"
      If not set, will be automatically extracted from COOKIE_STRING

    【API Security】
    - API_KEYS: API key JSON array, like ["sk-gemini", "sk-my-key"]
      Leave empty or set to [] to indicate no key verification

    【Gemini Configuration】
    - GEMINI_BL: Gemini build tag
      Need to update this value when encountering 405 error
      Obtaining method: Open gemini.google.com in browser -> F12 -> Network -> search for "boq_assistant"
    - DEFAULT_MODEL: Default model name, e.g., "gemini-3.6-flash"
    - AUTH_USER: Multi-account index, 0=first account, 1=second account

    【Performance Tuning】
    - RETRY_ATTEMPTS: Retry attempts, default 3
    - RETRY_DELAY_SEC: Retry interval (seconds), default 2
    - REQUEST_TIMEOUT_SEC: Request timeout (seconds), default 28
    - FINGERPRINT_JITTER_MS: Request pre-random delay maximum value (milliseconds), default 1500
      Set to 0 to disable random delay
    - RATE_LIMIT_MAX: Rate limit maximum request count, default 3000
    - RATE_LIMIT_WINDOW: Rate limit time window (seconds), default 60

Client Configuration:
   Base URL: https://yourworker.workers.dev/v1
   API Key: sk-gemini (or the key you set in configuration)
   Model: gemini-3.6-flash


## Technical Architecture Description:


  【Isolate Model】
  Cloudflare Workers uses Isolate (isolated environment) to handle each request:
  - Cold start: global code re-executes, all variables re-initialized
  - Hot start: reuse existing Isolate, global code does not execute, variables retain previous state
  - env parameter: each request independently injected by CF platform, always contains latest environment variables

  【Configuration Isolation Principle】
   1. DEFAULT_CONFIG as immutable template (read-only)
   2. getRequestConfig(env) creates brand new copy each time
   3. Read configuration from env, explicitly overwrite all fields with || null
   4. All functions receive configuration via config parameter
   5. No dependency on any global mutable state
  
  【Why Need Explicit Overwrite？】
   If using if (env.X) CONFIG.X = env.X pattern：
   - When env.X exists, CONFIG.X is updated ✓
   - When env.X does not exist, if not executed, CONFIG.X retains previous value ✗
   Using CONFIG.X = env.X || null ensures explicit assignment every time.
  
  Based on gemini-web2api v1.1.0 port
  Original author project: https://github.com/your-repo/gemini-web2api
