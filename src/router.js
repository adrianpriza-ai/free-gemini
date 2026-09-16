// 🚦 路由与请求编排
// 所有平台共用的请求入口：CORS 预检、环境归一化（含 Vercel x-matched-path
// 还原）、速率限制、密钥校验、健康检查与端点分发。
// Shared request entry: CORS preflight, env normalization, rate limiting,
// API key checks, health endpoints and route dispatch.

import { connect } from './platform.js';
import { getRequestConfig } from './config.js';
import { log } from './utils.js';
import { MODELS } from './models.js';
import { checkRateLimit, checkApiKey, sendJSON } from './http.js';
import { globalProxyState, refreshProxyPool } from './proxy.js';
import {
  handleChatCompletions,
  handleResponses,
  handleGoogleAPI,
} from './handlers.js';

// 🚦 平台无关主入口 — 由各平台适配器调用
// Platform-agnostic request router, invoked by the thin platform adapters.

export async function handleRequest(request, envOrContext, ctx) {

  // 第一步：OPTIONS CORS 预检请求优先处理
  //
  // 浏览器在发送跨域 POST 请求前会先发送 OPTIONS 预检请求。
  // 必须返回正确的 CORS 头，否则浏览器会阻止实际请求。
  // 这个处理必须在所有其他逻辑之前完成。
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,  // No Content
      headers: {
        'Access-Control-Allow-Origin': '*',              // 允许所有域访问
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',  // 允许的 HTTP 方法
        'Access-Control-Allow-Headers': '*',             // 允许所有自定义请求头
        'Access-Control-Max-Age': '86400',               // 预检结果缓存 24 小时（秒）
      },
    });
  }

  // 第二步：为当前请求创建独立的配置副本
  // 兼容 Netlify (context) 和 Cloudflare (env, ctx)
  var env = (envOrContext && !envOrContext.geo && !envOrContext.next && typeof envOrContext === 'object') ? envOrContext : null;
  var execCtx = ctx || (envOrContext && typeof envOrContext.waitUntil === 'function' ? envOrContext : null);
  var config = getRequestConfig(env, execCtx);

  // 解析请求 URL 和方法
  var requestUrl = new URL(request.url);
  var path = requestUrl.pathname;
  var method = request.method;

  // 🔀 Vercel 兼容：URL 重写后的内部路径还原
  //
  // vercel.json 通过 rewrites 将所有路径（/v1/...、/health 等）路由到
  // api/gemini。当 Vercel 在函数内暴露重写后的内部 URL（/api/gemini）时，
  // 原始公共路径会通过 x-matched-path 请求头传递。若存在该头且函数看到的
  // 是内部路径，则还原为原始路径，确保路由逻辑在两种 URL 约定下都能工作。
  //
  // Vercel compatibility: recover the original public path when the platform
  // exposes the rewritten internal URL inside the function. The original path
  // is carried in the x-matched-path header under that convention.
  var matchedPath = request.headers.get('x-matched-path');
  if (matchedPath && path !== matchedPath) {
    try {
      var matchedUrl = new URL(matchedPath, requestUrl.origin);
      if (matchedUrl.pathname !== path) {
        log('Vercel rewrite detected: internal path ' + path + ' -> original path ' + matchedUrl.pathname, 'INFO', config);
        path = matchedUrl.pathname;
      }
    } catch (e) { /* 无效的 x-matched-path 值，忽略并沿用内部路径 */ }
  }
  // 规范入口：/api/gemini（直接访问函数的 canonical 路径）视为健康检查
  if (path === '/api/gemini' || path === '/api/gemini/') {
    path = '/health';
  }

  // 第三步：速率限制检查（支持 Cloudflare、Netlify 及标准代理头）
  var clientIP = request.headers.get('CF-Connecting-IP') ||
                 request.headers.get('x-nf-client-connection-ip') ||
                 request.headers.get('client-ip') ||
                 (envOrContext && envOrContext.ip) ||
                 (request.headers.get('x-forwarded-for') ? request.headers.get('x-forwarded-for').split(',')[0].trim() : '0.0.0.0');
  if (!checkRateLimit(clientIP, config)) {
    log('Rate limit exceeded: ' + clientIP, 'WARN', config);
    return sendJSON({
      error: {
        message: '请求过于频繁，请稍后再试',
        type: 'rate_limit_exceeded',
      },
    }, 429);  // HTTP 429 Too Many Requests
  }

  // 第四步：API 密钥验证
  var needsApiKey = path.indexOf('/v1') === 0 || path.indexOf('/debug') === 0 || path.indexOf('/proxies') === 0;
  if (needsApiKey && !checkApiKey(request, config)) {
    return sendJSON({
      error: { message: 'invalid api key' },
    }, 401);  // HTTP 401 Unauthorized
  }

  // 第五步：GET 请求处理
  if (method === 'GET') {
    // -- 健康检查端点
    if (path === '/' || path === '/health') {
      var platform = 'Netlify Edge Functions';
      if (typeof WebSocketPair !== 'undefined' || (env && env.PROXY_KV)) {
        platform = 'Cloudflare Workers';
      } else if (typeof EdgeRuntime === 'string' || (typeof process !== 'undefined' && process.env && process.env.VERCEL)) {
        platform = 'Vercel Edge Functions';
      } else if (typeof Netlify !== 'undefined' || request.headers.get('x-nf-client-connection-ip')) {
        platform = 'Netlify Edge Functions';
      } else if (typeof process !== 'undefined' && process.env && process.env.NETLIFY) {
        platform = 'Netlify Functions';
      } else if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
        // Deno Deploy / 本地 deno run（Netlify Edge 也是 Deno，但已被上面的
        // Netlify 分支拦截）。Deno Deploy 请求不携带任何专属指纹头，依靠
        // Deno 全局识别。
        // Deno Deploy / local `deno run`. Netlify Edge also runs on Deno but is
        // caught by the Netlify branch above; Deploy requests carry no
        // platform-specific headers, so detection relies on the Deno global.
        platform = 'Deno Deploy';
      }

      return sendJSON({
        status: 'ok',
        version: '1.7.3',
        platform: platform,
        models: Object.keys(MODELS),
        defaultModel: config.defaultModel,
        geminiBl: config.geminiBl,
        // Cloudflare 旧版 /health 兼容字段（activeCount/lastUpdated/nextUpdate）
        // Compatibility fields kept for legacy Cloudflare /health consumers
        activeCount: globalProxyState.proxies.length,
        lastUpdated: globalProxyState.lastUpdated ? new Date(globalProxyState.lastUpdated).toISOString() : null,
        nextUpdate: globalProxyState.lastUpdated ? new Date(globalProxyState.lastUpdated + (config.proxy.updateIntervalHours || 24) * 3600 * 1000).toISOString() : null,
        hasCookie: !!config.cookieString,
        hasSapisid: !!config.sapisid,
        proxy: {
          // 实际生效模式:
          //   pool     = 代理池轮换（需要平台原始 TCP Socket，如 Cloudflare Workers）
          //   outbound = 静态出站代理（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，Deno fetch 原生支持）
          //   direct   = 直连（默认）
          // Effective mode:
          //   pool = rotating proxy pool (requires raw TCP sockets, e.g. Cloudflare Workers)
          //   outbound = static outbound proxy via HTTPS_PROXY/HTTP_PROXY/ALL_PROXY (native in Deno fetch)
          //   direct = direct connection (default)
          mode: (config.proxy.enabled && !!connect) ? 'pool' : (config.outboundProxy ? 'outbound' : 'direct'),
          // 是否有任一代理实际生效（等价于 mode !== 'direct'，便于监控判断）
          // Whether any proxy is actually in effect (equivalent to mode !== 'direct')
          enabled: (config.proxy.enabled && !!connect) || !!config.outboundProxy,
          // 当前平台是否支持原始 TCP Socket（代理池的必要条件；Netlify Edge 上恒为 false）
          // Whether this platform supports raw TCP sockets (required for the pool; always false on Netlify Edge)
          poolSupported: !!connect,
          // 配置的静态出站代理（隐藏具体值，只报告是否设置）
          // Configured static outbound proxy (value hidden, only reported as set/unset)
          outboundProxy: config.outboundProxy ? '(set)' : null,
          // ⏱️ 挂起防护超时（请求级生效值，环境变量可调）
          // Hang-guard timeouts in effect for this request (env-tunable)
          timeouts: {
            sourceFetchMs: config.proxy.sourceFetchTimeoutMs,
            handshakeMs: config.proxy.handshakeTimeoutMs,
            refreshSyncMs: config.proxy.refreshSyncMs,
            bodyIdleMs: config.proxy.bodyIdleTimeoutMs,
            requestDeadlineMs: config.requestDeadlineMs,
          },
        },
      });
    }

      // -- 代理池状态端点
      if (path === '/proxies') {
        return sendJSON({
          status: 'ok',
          proxyPool: {
            enabled: config.proxy.enabled,
            totalActive: globalProxyState.proxies.length,
            lastUpdated: globalProxyState.lastUpdated ? new Date(globalProxyState.lastUpdated).toISOString() : null,
            nextUpdate: globalProxyState.lastUpdated ? new Date(globalProxyState.lastUpdated + (config.proxy.updateIntervalHours || 24) * 3600 * 1000).toISOString() : null,
            updateIntervalHours: config.proxy.updateIntervalHours,
            autoTest: config.proxy.autoTest,
            testTimeoutMs: config.proxy.testTimeoutMs,
            fallbackDirect: config.proxy.fallbackDirect,
            rotationMode: config.proxy.rotationMode,
            proxies: globalProxyState.proxies.map(function (p) {
              return {
                url: p.protocol + '://' + p.host + ':' + p.port,
                protocol: p.protocol,
                latencyMs: p.latency,
                fails: p.fails || 0,
              };
            }),
          },
        });
      }

      // -- 手动强制刷新代理池端点 (GET /proxies/refresh)
      if (path === '/proxies/refresh') {
        var refreshed = await refreshProxyPool(config, env, ctx, true);
        return sendJSON({
          status: 'ok',
          message: '代理池已完成刷新与测速',
          activeCount: refreshed.length,
          proxies: refreshed.map(function (p) {
            return {
              url: p.protocol + '://' + p.host + ':' + p.port,
              protocol: p.protocol,
              latencyMs: p.latency,
            };
          }),
        });
      }

      // -- 代理池调试端点 (GET /debug/proxies)
      // 报告代理池健康度、各代理延迟与失败计数及内部状态，用于诊断代理系统问题
      if (path === '/debug/proxies') {
        var nowDebug = Date.now();
        var intervalMsDebug = (config.proxy.updateIntervalHours || 24) * 3600 * 1000;
        var poolProxies = globalProxyState.proxies;

        // 与 geminiFetch 完全相同的评分公式，便于观察 best-of-2/weighted 会优先选谁
        // score = reliability(fails) / (latency + 1)，延迟缺失时回退 1000ms
        var scoreOfDebug = function (p) {
          var lat = (typeof p.latency === 'number' && p.latency > 0) ? p.latency : 1000;
          var fails = p.fails || 0;
          var reliability = fails === 0 ? 1 : Math.pow(0.5, fails);
          return reliability / (lat + 1);
        };

        var healthyCount = 0;
        var flakyCount = 0;
        var totalLatency = 0;
        var latencyCount = 0;
        var proxyDetails = poolProxies.map(function (p) {
          var pFails = p.fails || 0;
          if (pFails === 0) healthyCount++;
          else flakyCount++;
          if (typeof p.latency === 'number' && p.latency > 0) {
            totalLatency += p.latency;
            latencyCount++;
          }
          return {
            url: p.protocol + '://' + p.host + ':' + p.port,
            protocol: p.protocol,
            hasAuth: !!p.auth,
            latencyMs: p.latency,
            fails: pFails,
            // healthy: 零失败；flaky: 已失败 1 次（再失败 1 次将被移出代理池）
            health: pFails === 0 ? 'healthy' : 'flaky',
            score: Math.round(scoreOfDebug(p) * 100000) / 100000,
          };
        });

        // 按评分从高到低排序，评分最高（最低延迟、无失败）的代理排在最前
        proxyDetails.sort(function (a, b) { return b.score - a.score; });

        return sendJSON({
          status: 'ok',
          proxyPool: {
            enabled: config.proxy.enabled,
            isUpdating: globalProxyState.isUpdating,
            totalActive: poolProxies.length,
            healthy: healthyCount,
            flaky: flakyCount,
            avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : null,
            lastUpdated: globalProxyState.lastUpdated ? new Date(globalProxyState.lastUpdated).toISOString() : null,
            ageSeconds: globalProxyState.lastUpdated ? Math.round((nowDebug - globalProxyState.lastUpdated) / 1000) : null,
            updateIntervalHours: config.proxy.updateIntervalHours,
            refreshDue: globalProxyState.lastUpdated ? (nowDebug - globalProxyState.lastUpdated >= intervalMsDebug) : true,
            maxPoolSize: config.proxy.maxPoolSize,
            fallbackDirect: config.proxy.fallbackDirect,
            rotationMode: config.proxy.rotationMode,
            // ⏱️ 挂起防护超时（请求级生效值，环境变量可调）
            // Hang-guard timeouts in effect for this request (env-tunable)
            timeouts: {
              sourceFetchMs: config.proxy.sourceFetchTimeoutMs,
              handshakeMs: config.proxy.handshakeTimeoutMs,
              refreshSyncMs: config.proxy.refreshSyncMs,
              bodyIdleMs: config.proxy.bodyIdleTimeoutMs,
            },
            candidatesCache: {
              size: globalProxyState.candidatesCache ? globalProxyState.candidatesCache.length : 0,
              ageSeconds: globalProxyState.candidatesCacheTime ? Math.round((nowDebug - globalProxyState.candidatesCacheTime) / 1000) : null,
            },
          },
          proxies: proxyDetails,
        });
      }

      // -- OpenAI 格式模型列表
      // 返回所有可用模型的信息
      // 客户端（NextChat、Cherry Studio 等）会调用此端点获取模型列表
      if (path === '/v1/models') {
        var modelList = [];
        var modelKeys = Object.keys(MODELS);
        for (var i = 0; i < modelKeys.length; i++) {
          var id = modelKeys[i];
          var cfg = MODELS[id];
          modelList.push({
            id: id,
            object: 'model',
            created: 1700000000,
            owned_by: 'google',
            description: cfg.desc,
          });
        }
        return sendJSON({ object: 'list', data: modelList });
      }

      // -- Google 原生格式模型列表
      // 用于 Gemini CLI 等工具的模型发现
      if (path === '/v1beta/models') {
        var googleModels = [];
        var gKeys = Object.keys(MODELS);
        for (var j = 0; j < gKeys.length; j++) {
          var name = gKeys[j];
          var gCfg = MODELS[name];
          googleModels.push({
            name: 'models/' + name,
            displayName: name,
            description: gCfg.desc,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          });
        }
        return sendJSON({ models: googleModels });
      }

      // 未匹配的 GET 请求
      return sendJSON({ error: { message: 'not found' } }, 404);
    }

    // 第六步：POST 请求处理
    //
    if (method === 'POST') {
      // -- 代理池手动刷新端点 (POST /proxies/refresh)
      if (path === '/proxies/refresh') {
        var refreshedPost = await refreshProxyPool(config, env, ctx, true);
        return sendJSON({
          status: 'ok',
          message: '代理池已完成刷新与测速',
          activeCount: refreshedPost.length,
          proxies: refreshedPost.map(function (p) {
            return {
              url: p.protocol + '://' + p.host + ':' + p.port,
              protocol: p.protocol,
              latencyMs: p.latency,
            };
          }),
        });
      }

      var body;
      try {
        body = await request.json();
      } catch (e) {
        return sendJSON({ error: { message: 'invalid JSON' } }, 400);
      }

      // 🛡️ 防御性检查：body 必须是普通对象。
      // null / 数组 / 字符串等会让后续 body.model 访问抛 TypeError 导致 500。
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        body = {};
      }

      // -- OpenAI Chat Completions API
      // 这是最常用的端点，处理聊天补全请求
      if (path === '/v1/chat/completions') {
        return handleChatCompletions(request, body, config);
      }

      // -- OpenAI Responses API（Codex CLI 兼容）
      if (path === '/v1/responses') {
        return handleResponses(request, body, config);
      }

      // -- Google 原生 streamGenerateContent（流式）
      if (path.indexOf(':streamGenerateContent') !== -1) {
        return handleGoogleAPI(request, body, true, config);
      }

      // -- Google 原生 generateContent（非流式）
      if (path.indexOf(':generateContent') !== -1) {
        return handleGoogleAPI(request, body, false, config);
      }

      // -- 万能兜底路由
      // 所有 /v1/ 下的未匹配 POST 请求都自动转为 chat 处理
      // 兼容各种客户端的路径差异
      if (path.indexOf('/v1/') === 0) {
        return handleChatCompletions(request, body, config);
      }

      // 未匹配的 POST 请求
      return sendJSON({ error: { message: 'not found' } }, 404);
    }

    // 第七步：未支持的 HTTP 方法
    //
    return sendJSON({ error: { message: 'method not allowed' } }, 405);
}

// ⏰ 定时任务调度器
// Cloudflare Workers Cron Trigger（wrangler.jsonc: "0 0 * * *"）等定时触发时，
// 后台静默拉取并测试最新代理。
// Scheduled trigger handler: silently refresh the proxy pool on cron events.
export async function handleScheduled(event, env, ctx) {
  var config = getRequestConfig(env, ctx);
  log('收到定时任务触发 (Cron: ' + (event && event.cron ? event.cron : '24h') + ')，正在刷新代理池...', 'INFO', config);
  try {
    var proxies = await refreshProxyPool(config, env, ctx, true);
    log('定时刷新代理池成功，当前存活可用代理: ' + proxies.length + ' 个', 'INFO', config);
  } catch (err) {
    log('定时刷新代理池异常: ' + err.message, 'ERROR', config);
  }
}

// 🛡️ 顶层兜底异常处理 + 单请求服务端截止时间
//
// 两层保护：
// 1. 异常兜底：Netlify/Vercel 对未捕获异常会返回非 JSON 的通用错误页（无
//    CORS 头、客户端无法解析），这里捕获所有未被上层捕获的异常，转换为
//    结构化的 500 JSON 响应。
// 2. 截止时间：requestDeadlineMs（REQUEST_DEADLINE_MS 可调，0 禁用）内未能
//    拿到上游响应时，立即返回结构化的 502（upstream_timeout），抢在客户端
//    自身超时或平台硬限制之前给出可解析的错误。SSE 流式响应不受影响 ——
//    截止只约束"响应头就位"，流已经开始后计时器即失效。
//
// Top-level catch-all + per-request server-side deadline.
// 1. Catch-all: convert unhandled errors into a structured JSON 500 (platforms
//    like Netlify/Vercel would otherwise return a generic non-JSON error page).
// 2. Deadline: if the upstream response (i.e. response headers) is not ready
//    within requestDeadlineMs (env REQUEST_DEADLINE_MS, 0 disables), return a
//    structured 502 (upstream_timeout) before the client's own timeout or the
//    platform's hard limit kicks in. SSE streaming is unaffected: the deadline
//    only gates "headers ready" — once the response has started, it is moot.
//
// 参数兼容两种调用约定：Cloudflare fetch(request, env, ctx) 与
// Netlify/Vercel handler(request, context)（后者传 envOrContext=null）。
// Accepts both calling conventions: Cloudflare fetch(request, env, ctx) and
// Netlify/Vercel handler(request, context) (envOrContext=null in the latter).
export async function handleRequestSafe(request, envOrContext, ctx) {
  var deadlineMs = 0;
  try {
    var cfg = getRequestConfig(envOrContext && typeof envOrContext === 'object' && !envOrContext.geo && !envOrContext.next ? envOrContext : null, ctx);
    deadlineMs = cfg.requestDeadlineMs || 0;
  } catch (cfgErr) {
    deadlineMs = 0; // 配置异常时退化为仅异常兜底 / config failure: catch-all only
  }

  var timer = null;
  try {
    var workPromise = handleRequest(request, envOrContext, ctx);

    if (deadlineMs <= 0) {
      return await workPromise;
    }

    var deadlinePromise = new Promise(function (resolve) {
      timer = setTimeout(function () {
        resolve(sendJSON({
          error: {
            message: 'upstream timeout: no response within ' + deadlineMs + 'ms (REQUEST_DEADLINE_MS)',
            type: 'upstream_timeout',
          },
        }, 502));
      }, deadlineMs);
    });

    var outcome = await Promise.race([workPromise, deadlinePromise]);
    return outcome;
  } catch (error) {
    var errMsg = error && error.message ? error.message : String(error);
    try { log('Unhandled error: ' + errMsg, 'ERROR', null); } catch (logErr) {}
    return sendJSON({
      error: {
        message: 'internal error: ' + errMsg,
        type: 'internal_error',
      },
    }, 500);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
