// 🧩 平台抽象层 (Platform abstraction layer)
//
// 平台适配器（cloudflare/worker.js、api/gemini.js、netlify/*/gemini.js）在模块
// 加载时调用 setPlatformConnect() 注入本平台的能力：
//   - Cloudflare Workers: 注入 import { connect } from 'cloudflare:sockets'
//   - Netlify Edge/Functions 与 Vercel Edge: 保持 null（无原始 TCP socket，
//     全局 fetch 直连 gemini.google.com；Deno fetch 还会原生读取 HTTPS_PROXY）
//
// Platform adapters inject their capabilities at module load via
// setPlatformConnect(): Cloudflare passes `connect` from 'cloudflare:sockets',
// while Netlify/Vercel have no raw sockets and stay null (global fetch only).

// 原始 TCP socket 工厂；null 表示当前平台不支持（代理池自动降级为直连）
// Raw TCP socket factory; null means the platform cannot host the proxy pool.
export var connect = null;

// 当前平台标识（用于 /health 的 platform 检测兜底、日志与 config._platform）
// Current platform identifier (fallback for /health detection and logs).
export var PLATFORM_ID = 'unknown';

// 非流式请求的响应头截止时间（毫秒）；0 表示平台无此限制、禁用截止逻辑
// Pre-response deadline for non-streaming requests (ms); 0 disables the logic.
// CF Workers: 无限制 (no limit) · Vercel Edge: 22s · Netlify Edge: 30s
export var PRERESPONSE_DEADLINE_MS = 0;

// 代理池是否默认启用（CF 默认开启代理池；Netlify/Vercel 默认直连）
// Whether the rotating proxy pool is enabled by default.
export var PROXY_POOL_DEFAULT_ENABLED = false;

/**
 * 注入平台能力（由各平台适配器在模块加载时调用）
 * Inject platform capabilities (called by each platform adapter at load time).
 *
 * @param {Function|null} connectFn - 原始 TCP socket 工厂 / raw TCP socket factory
 * @param {string} [platformId] - 平台标识 / platform identifier
 */
export function setPlatformConnect(connectFn, platformId) {
  connect = connectFn || null;
  if (platformId) {
    PLATFORM_ID = platformId;
  }
}

/**
 * 设置非流式请求的响应头截止时间（平台适配器在模块加载时调用）
 * Set the pre-response deadline (called by platform adapters at load time).
 *
 * @param {number} ms - 截止毫秒数；0 表示禁用截止逻辑 / deadline ms; 0 disables
 */
export function setPreresponseDeadline(ms) {
  PRERESPONSE_DEADLINE_MS = typeof ms === 'number' && ms > 0 ? ms : 0;
}

/**
 * 设置代理池默认开关（平台适配器在模块加载时调用）
 * Set the proxy-pool default switch (called by platform adapters at load time).
 *
 * @param {boolean} enabled - 是否默认启用代理池 / default pool enabled
 */
export function setProxyPoolDefaultEnabled(enabled) {
  PROXY_POOL_DEFAULT_ENABLED = !!enabled;
}

/**
 * 读取代理池默认开关（在构建 DEFAULT_CONFIG 时调用）
 * Read the proxy-pool default switch (used while building DEFAULT_CONFIG).
 *
 * 通过函数而非直接读取 var，确保适配器在模块加载后注入的值能生效
 * （ES 模块的 import 求值顺序早于适配器主体的 setter 调用）。
 * Using a function (instead of reading the var at import time) guarantees the
 * adapter-injected value is honored, since ES module imports evaluate before
 * the adapter body runs its setters.
 *
 * @returns {boolean} 是否默认启用代理池 / default pool enabled
 */
export function getProxyPoolDefaultEnabled() {
  return PROXY_POOL_DEFAULT_ENABLED;
}

/**
 * 自动从多种运行环境提取环境变量
 * （兼容 Netlify Edge, Netlify Functions, Cloudflare, Node.js 等）
 * Auto-merge env vars from every supported runtime.
 *
 * @param {Object|null} env - 平台传入的环境变量 / platform-provided env object
 * @returns {Object} 合并后的环境变量 / merged env object
 */
export function mergePlatformEnv(env) {
  var mergedEnv = {};
  if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.toObject === 'function') {
    try { Object.assign(mergedEnv, Netlify.env.toObject()); } catch (e) {}
  } else if (typeof Deno !== 'undefined' && Deno.env && typeof Deno.env.toObject === 'function') {
    try { Object.assign(mergedEnv, Deno.env.toObject()); } catch (e) {}
  }
  if (typeof process !== 'undefined' && process.env) {
    try { Object.assign(mergedEnv, process.env); } catch (e) {}
  }
  if (env && typeof env === 'object') {
    Object.assign(mergedEnv, env);
  }
  return mergedEnv;
}
