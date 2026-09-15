// 🔒 请求级配置
// DEFAULT_CONFIG 只读模板 + getRequestConfig() 请求级配置生成器，平台无关。
// Read-only default config plus the per-request config factory.

import {
  PLATFORM_ID,
  connect,
  getProxyPoolDefaultEnabled,
  mergePlatformEnv,
} from './platform.js';
import { getProxyTimeoutDefaults } from './proxy.js';
import { log } from './utils.js';

// 🔒 默认配置 - 仅作为只读模板
//
// 这是所有请求配置的"蓝图"（Blueprint），用于生成每个请求的独立配置副本。
// 这个对象永远不会被修改，所有修改都在请求级的 config 副本中进行。
// 使用 Object.freeze() 确保不可变性，防止意外修改导致全局影响。

// 挂起防护超时默认值（真实来源在 src/proxy.js，这里仅用于填充 DEFAULT_CONFIG）
// Hang-guard timeout defaults (single source of truth in src/proxy.js).
var proxyTimeoutDefaults = getProxyTimeoutDefaults();

export var DEFAULT_CONFIG = {
  // -- 重试配置
  // 当请求失败时，自动重试的次数
  // 每次重试使用指数退避策略：延迟时间 = retryDelaySec * 2^attempt
  // 例如：第一次重试延迟 2 秒，第二次 4 秒，第三次 8 秒
  retryAttempts: 3,
  // 重试间隔的基础时间（秒）
  // 实际延迟 = retryDelaySec * 2^attempt（指数退避）
  retryDelaySec: 2,

  // -- 请求超时
  // 单次 HTTP 请求的超时时间（秒）
  // 注意：CF Workers 免费版有 30 秒 CPU 时间限制
  // 流式请求的 CPU 时间在数据到达时重置，所以不受此严格限制
  // 但初始连接和第一个数据块必须在超时内到达
  requestTimeoutSec: 28,

  // -- Gemini 构建标签
  // Gemini 前端的版本标识，用于 API 请求的 URL 参数
  // 如果遇到 405 Method Not Allowed 错误，说明此值已过期
  // 更新方法：
  //   1. 浏览器打开 https://gemini.google.com/app
  //   2. 按 F12 打开开发者工具
  //   3. 切换到 Network（网络）标签
  //   4. 在任意请求的 URL 中搜索 "boq_assistant"
  //   5. 复制最新版本号，如 "boq_assistant-bard-web-server_20260730.02_p0"
  geminiBl: 'boq_assistant-bard-web-server_20260907.07_p0',

  // -- 多账户支持
  // Google 支持在同一个浏览器中登录多个账户
  // null 或 "" 表示使用默认账户（第一个登录的账户）
  // "0" 表示第一个账户，"1" 表示第二个账户，以此类推
  // 使用非默认账户时，Gemini URL 会包含 /u/1 等前缀
  authUser: null,

  // -- XSRF 令牌
  // 跨站请求伪造保护令牌
  // Gemini Web 前端会使用此令牌，但 API 调用通常不需要
  // 如果遇到 403 错误，可以尝试从浏览器中提取此值
  xsrfToken: null,

  // -- 默认模型
  // 当客户端请求未指定 model 参数时使用的默认模型
  // 可选值参考 MODELS 字典的键名
  defaultModel: 'gemini-3.6-flash',

  // -- API 密钥白名单
  // 用于验证客户端请求的密钥列表
  // 空数组 [] 表示不验证，所有请求都可以访问（不推荐用于生产）
  // 设置后，客户端必须在请求头中提供有效的密钥
  // 支持 Bearer Token、x-api-key、x-goog-api-key、URL 参数 ?key=
  // 示例: ["sk-gemini", "sk-my-custom-key"]
  apiKeys: ['sk-gemini'],

  // -- Cookie 认证
  // Gemini 对匿名请求有严格的速率限制（容易触发 429 Too Many Requests）
  // 提供有效的 Cookie 可以大幅提升稳定性和降低限流概率
  // cookieString: 从浏览器复制的完整 Cookie 字符串
  //   格式: "__Secure-1PSID=xxx; __Secure-3PSID=xxx; SAPISID=xxx; ..."
  //   支持多个 Cookie（用 | 分隔），每次请求随机选择一个
  //   示例: "cookie1| cookie2| cookie3"
  cookieString: null,
  // sapisid: 从 Cookie 中提取的 SAPISID 值
  //   用于生成 Google API 所需的 SAPISIDHASH 认证头
  //   格式: "abc123/def456"
  //   如果设置了 cookieString 但未设置 sapisid，程序会自动提取
  //   支持多个（用 | 分隔），与 Cookie 对应
  //   示例: "sapisid1| sapisid2| sapisid3"
  sapisid: null,

  // -- 日志开关
  // 是否在控制台输出请求日志
  // 生产环境建议保持开启，便于排查问题
  // 日志格式: [HH:MM:SS] [LEVEL] message
  logRequests: true,

  // -- 速率限制
  // Cloudflare Workers 级别的请求频率控制
  // 用于防止滥用和保护上游 Gemini API
  rateLimit: {
    // 是否启用速率限制
    enabled: true,
    // 时间窗口内的最大请求数
    // 默认 3000，设置为较高值以避免正常使用被限制
    // 如果遇到滥用，可以调低此值（如 30-100）
    maxRequests: 3000,
    // 时间窗口大小（秒）
    // 60 表示每分钟最多允许 maxRequests 个请求
    windowSec: 60,
  },

  // -- 指纹轮换配置
  // 请求前随机延迟的最大值（毫秒）
  // 模拟人类操作间隔，降低被检测为自动化请求的概率
  // 默认 1500ms（1.5秒），设为 0 可禁用
  // 配合 User-Agent 轮换使用效果更佳
  fingerprintJitterMs: 1500,

  // -- 代理池配置（Netlify 支持直连，默认使用直连）
  proxy: {
    // 是否启用代理池（默认值由平台适配器注入，见 src/platform.js）
    enabled: getProxyPoolDefaultEnabled(),
    // 代理源 URL（默认使用 ProxyScrape 200ms timeout API，体积小、速度快、质量高）
    sourceUrl: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=200',
    // 备用源（GitHub raw 完整源）
    fallbackSourceUrl: 'https://raw.githubusercontent.com/ProxyScrape/free-proxy-list/refs/heads/main/proxies/all/data.txt',
    // 用户自定义固定代理列表（支持 http/socks5，以逗号、竖线或换行分隔）
    staticProxies: [],
    // 自动测试代理开关（通过 cloudflare:sockets 握手验证可用性）
    autoTest: true,
    // 单个代理连接与握手测试超时（毫秒）
    testTimeoutMs: 1000,
    // 代理池最大保留数量（避免占用过多 Worker 内存；也限制刷新时的代理测试子请求数）
    maxPoolSize: 12,
    // 代理池更新间隔时间（小时，默认 24 小时）
    updateIntervalHours: 24,
    // 当所有代理不可用时是否自动降级回退到直连（确保业务高可用）
    fallbackDirect: true,
    // ⏱️ 挂起防护超时（默认值由 src/proxy.js 单一来源提供，环境变量可覆盖）：
    //   sourceFetchTimeoutMs: 拉取代理列表源的硬超时（PROXY_SOURCE_FETCH_TIMEOUT_MS）
    //   handshakeTimeoutMs:   与代理建立 CONNECT/SOCKS 隧道的硬超时（PROXY_HANDSHAKE_TIMEOUT_MS）
    //   refreshSyncMs:        冷启动同步等待代理池刷新的上限，超时转后台（PROXY_REFRESH_SYNC_MS）
    sourceFetchTimeoutMs: proxyTimeoutDefaults.sourceFetchMs,
    handshakeTimeoutMs: proxyTimeoutDefaults.handshakeMs,
    refreshSyncMs: proxyTimeoutDefaults.refreshSyncMs,
    // 代理轮询方式（PROXY_ROTATION_MODE 环境变量覆盖）：
    //   'round-robin'  严格顺序轮询（公平，无质量感知）
    //   'random'       纯均匀随机
    //   'best-of-2'    二次幂选择：从池中抽 2 个，挑评分更高的（默认，自适应）
    //   'weighted'     反向延迟加权轮盘赌（带探索底量，兼容旧 "Smart Round Robin"）
    rotationMode: 'best-of-2',
  },
};

// 🔑 核心：请求级配置生成器（解决并发串扰 + 多Cookie轮换 + 指纹轮换）

/**
 * 为当前请求创建独立的配置副本
 * 
 * 【为什么需要这个函数？—— 并发串扰问题】
 * Cloudflare Workers 在处理请求时使用 Isolate（隔离环境）。
 * 冷启动时全局代码会重新执行，变量回到初始值。
 * 但热启动（Isolate 复用）时，全局代码不会重新执行，
 * 全局变量保留上一次请求修改后的值。
 * 
 * 当 WorkBuddy 等客户端在极短时间内发送 5-20 个并发请求时，
 * 这些请求可能被分配到同一个 Isolate，共享全局变量。
 * 
 * 举例说明串扰过程：
 *   请求 A 到达 → CONFIG.cookieString = "cookie_a"
 *   请求 B 到达 → CONFIG.cookieString = "cookie_b"  ← 覆盖了 A 的设置！
 *   请求 A 继续执行 → 使用的是 "cookie_b" ← 串扰！
 * 
 * 【如何解决？—— 请求级配置隔离】
 * 1. 每次请求调用此函数，从 DEFAULT_CONFIG 模板创建全新的配置对象
 * 2. 从 env（环境变量，每个请求由 CF 平台独立注入）读取定制配置
 * 3. 所有后续函数通过 config 参数接收配置，完全不依赖全局状态
 * 4. 使用显式赋值（env.X || null）防止 Isolate 复用时的值残留
 * 
 * 【多 Cookie 轮换】
 * 如果环境变量中使用 | 分隔多个 Cookie 和 SAPISID，
 * 每次请求会随机选择一个组合使用。
 * 这可以大幅降低单个 Google 账号被限流的概率。
 * 
 * 【环境变量格式】
 * COOKIE_STRING = "cookie_account1| cookie_account2| cookie_account3"
 * SAPISID = "sapisid_1| sapisid_2| sapisid_3"
 * 
 * @param {Object} env - Cloudflare Worker 环境变量（每个请求独立）
 * @param {Object} ctx - Cloudflare Worker 执行上下文（包含 waitUntil 等）
 * @returns {Object} 专属于当前请求的配置副本
 */
export function getRequestConfig(env, ctx) {
  // 自动从多种运行环境提取环境变量（兼容 Netlify Edge, Netlify Functions, Cloudflare, Node.js 等）
  // Auto-merge env vars from every supported runtime (see src/platform.js).
  env = mergePlatformEnv(env);

  // 从默认模板创建全新的配置对象
  // 逐字段手动拷贝，确保每个字段都是独立的基本类型副本
  // 不使用展开运算符 (...DEFAULT_CONFIG)，避免引用共享问题
  var config = {
    // -- 基本配置字段
    retryAttempts: DEFAULT_CONFIG.retryAttempts,
    retryDelaySec: DEFAULT_CONFIG.retryDelaySec,
    requestTimeoutSec: DEFAULT_CONFIG.requestTimeoutSec,
    geminiBl: DEFAULT_CONFIG.geminiBl,
    authUser: DEFAULT_CONFIG.authUser,
    xsrfToken: DEFAULT_CONFIG.xsrfToken,
    defaultModel: DEFAULT_CONFIG.defaultModel,
    apiKeys: DEFAULT_CONFIG.apiKeys,
    cookieString: DEFAULT_CONFIG.cookieString,
    sapisid: DEFAULT_CONFIG.sapisid,
    logRequests: DEFAULT_CONFIG.logRequests,
    fingerprintJitterMs: DEFAULT_CONFIG.fingerprintJitterMs,
    outboundProxy: null,

    // -- 嵌套对象：rateLimit 需要深拷贝
    // 因为 rateLimit 是一个对象，不能直接赋值（会引用共享）
    // 需要创建一个新对象，逐字段拷贝
    rateLimit: {
      enabled: DEFAULT_CONFIG.rateLimit.enabled,
      maxRequests: DEFAULT_CONFIG.rateLimit.maxRequests,
      windowSec: DEFAULT_CONFIG.rateLimit.windowSec,
    },

    // -- 嵌套对象：proxy 需要深拷贝
    proxy: {
      enabled: DEFAULT_CONFIG.proxy.enabled,
      sourceUrl: DEFAULT_CONFIG.proxy.sourceUrl,
      fallbackSourceUrl: DEFAULT_CONFIG.proxy.fallbackSourceUrl,
      staticProxies: DEFAULT_CONFIG.proxy.staticProxies.slice(),
      autoTest: DEFAULT_CONFIG.proxy.autoTest,
      testTimeoutMs: DEFAULT_CONFIG.proxy.testTimeoutMs,
      maxPoolSize: DEFAULT_CONFIG.proxy.maxPoolSize,
      updateIntervalHours: DEFAULT_CONFIG.proxy.updateIntervalHours,
      fallbackDirect: DEFAULT_CONFIG.proxy.fallbackDirect,
      rotationMode: DEFAULT_CONFIG.proxy.rotationMode,
      // 挂起防护超时（数字类型，逐字段拷贝）
      sourceFetchTimeoutMs: DEFAULT_CONFIG.proxy.sourceFetchTimeoutMs,
      handshakeTimeoutMs: DEFAULT_CONFIG.proxy.handshakeTimeoutMs,
      refreshSyncMs: DEFAULT_CONFIG.proxy.refreshSyncMs,
    },
  };

  // 代理池默认开关：请求时读取（而非模块加载时），确保平台适配器注入的默认值生效
  // Proxy-pool default is resolved per request so adapter-injected defaults apply.
  config.proxy.enabled = getProxyPoolDefaultEnabled();

  // 环境变量覆盖
  // env 是 Cloudflare 为每个请求独立提供的环境变量对象
  // 这些值是在 CF Dashboard 中配置的，修改后自动生效

  // -- 字符串类型：有值才覆盖（保留默认值作为兜底）
  if (env.GEMINI_BL) {
    config.geminiBl = env.GEMINI_BL;
  }
  if (env.DEFAULT_MODEL) {
    config.defaultModel = env.DEFAULT_MODEL;
  }

  // -- 认证相关字段：使用 || 操作符确保显式覆盖
  // 这些字段可能为 null 或空字符串
  // 使用 || null 确保即使 env 值为 undefined 或空字符串，
  // 也会显式设置为 null，防止 Isolate 复用时上次请求的值残留
  config.authUser = env.AUTH_USER || null;
  config.xsrfToken = env.XSRF_TOKEN || null;

  // 🎭 多 Cookie 轮换支持
  //
  // 将环境变量中的字符串按 | 分割成数组
  // 过滤掉空字符串（处理连续 | 或首尾 | 的情况）
  // 
  // 环境变量格式示例:
  //   COOKIE_STRING = "cookie_account1| cookie_account2| cookie_account3"
  //   SAPISID = "sapisid_1| sapisid_2| sapisid_3"
  // 
  // 如果分割后只有 1 个元素，效果等同于单个 Cookie

  var cookieStrings = (env.COOKIE_STRING || '').split('|').filter(function (c) {
    return c.trim();  // 过滤掉空字符串
  });
  var sapisids = (env.SAPISID || '').split('|').filter(function (s) {
    return s.trim();  // 过滤掉空字符串
  });

  // 情况 1：有多个 Cookie 可供选择
  if (cookieStrings.length > 0) {
    // 随机选择一个 Cookie 索引
    var cookieIdx = Math.floor(Math.random() * cookieStrings.length);
    config.cookieString = cookieStrings[cookieIdx].trim();

    // 如果 SAPISID 数量与 Cookie 数量匹配，使用对应索引的 SAPISID
    // 这样可以保持 Cookie 和 SAPISID 的对应关系
    if (sapisids.length === cookieStrings.length) {
      config.sapisid = sapisids[cookieIdx].trim();
    } else if (sapisids.length > 0) {
      // 如果数量不匹配，随机选择一个 SAPISID
      var sapisidIdx = Math.floor(Math.random() * sapisids.length);
      config.sapisid = sapisids[sapisidIdx].trim();
    }
    // 如果只有一个 SAPISID 或没有 SAPISID，留给后面的自动提取逻辑处理
  }
  // 情况 2：只有 SAPISID，没有 Cookie
  else if (sapisids.length > 0) {
    // 随机选择一个 SAPISID
    var sapisidIdx = Math.floor(Math.random() * sapisids.length);
    config.sapisid = sapisids[sapisidIdx].trim();
  }
  // 情况 3：既没有 Cookie 也没有 SAPISID
  // config.cookieString 和 config.sapisid 保持默认值 null

  // 🛡️ 智能兼容：自动从 COOKIE_STRING 提取 SAPISID
  //
  // 如果最终 SAPISID 为空但 Cookie 不为空，
  // 尝试从 Cookie 字符串中正则匹配提取 SAPISID 值
  // 
  // Cookie 格式示例:
  //   "__Secure-1PSID=AJDrVf...; __Secure-3PSID=AJDrVf...; SAPISID=abc123/def456; ..."
  // 
  // 正则 /SAPISID=([^;]+)/ 的含义：
  //   SAPISID=   匹配字面量 "SAPISID="
  //   ([^;]+)    捕获组：匹配一个或多个非分号字符（即 SAPISID 的值）
  if (!config.sapisid && config.cookieString) {
    var match = config.cookieString.match(/SAPISID=([^;]+)/);
    if (match) {
      // match[1] 是第一个捕获组，即 SAPISID 的值
      // trim() 去除可能的首尾空白字符
      config.sapisid = match[1].trim();
    }
  }

  // -- API 密钥：支持 API_KEY, API_KEYS, 或 API-KEY 环境变量
  // 支持格式：
  // 1. 普通字符串: "my-secret-key"
  // 2. 逗号/竖线分隔: "key1,key2" 或 "key1|key2"
  // 3. JSON 数组: '["key1", "key2"]'
  var rawApiKeyEnv = env.API_KEY || env.API_KEYS || env['API-KEY'] || null;
  if (rawApiKeyEnv) {
    if (typeof rawApiKeyEnv === 'string') {
      var trimmed = rawApiKeyEnv.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          config.apiKeys = JSON.parse(trimmed);
        } catch (e) {
          console.error('[ERROR] API_KEYS JSON 解析失败: ' + e.message + '，尝试按分隔符解析');
          config.apiKeys = trimmed.replace(/^\[|\]$/g, '').split(/[,|]/).map(function (k) { return k.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean);
        }
      } else {
        // 单个 key 或逗号/管道分隔的多个 key
        config.apiKeys = trimmed.split(/[,|]/).map(function (k) { return k.trim(); }).filter(Boolean);
      }
    } else if (Array.isArray(rawApiKeyEnv)) {
      config.apiKeys = rawApiKeyEnv;
    }
  }

  // -- 数字类型字段：需要 parseInt 转换
  // env 中的环境变量都是字符串类型
  // 需要用 parseInt(value, 10) 转换为十进制整数
  // 使用 isNaN() 检查转换结果，防止无效值
  if (env.RETRY_ATTEMPTS) {
    var ra = parseInt(env.RETRY_ATTEMPTS, 10);
    if (!isNaN(ra)) config.retryAttempts = ra;
  }
  if (env.RETRY_DELAY_SEC) {
    var rd = parseInt(env.RETRY_DELAY_SEC, 10);
    if (!isNaN(rd)) config.retryDelaySec = rd;
  }
  if (env.REQUEST_TIMEOUT_SEC) {
    var rt = parseInt(env.REQUEST_TIMEOUT_SEC, 10);
    if (!isNaN(rt)) config.requestTimeoutSec = rt;
  }
  // 指纹轮换随机延迟配置
  if (env.FINGERPRINT_JITTER_MS) {
    var fj = parseInt(env.FINGERPRINT_JITTER_MS, 10);
    if (!isNaN(fj)) config.fingerprintJitterMs = fj;
  }

  // -- 速率限制配置
  if (env.RATE_LIMIT_MAX) {
    var rlmax = parseInt(env.RATE_LIMIT_MAX, 10);
    if (!isNaN(rlmax)) config.rateLimit.maxRequests = rlmax;
  }
  if (env.RATE_LIMIT_WINDOW) {
    var rlwin = parseInt(env.RATE_LIMIT_WINDOW, 10);
    if (!isNaN(rlwin)) config.rateLimit.windowSec = rlwin;
  }
  // -- 代理池配置环境变量解析
  if (env.ENABLE_PROXY !== undefined) {
    config.proxy.enabled = String(env.ENABLE_PROXY).toLowerCase() === 'true' || env.ENABLE_PROXY === '1';
  } else if (env.PROXY_ENABLED !== undefined) {
    config.proxy.enabled = String(env.PROXY_ENABLED).toLowerCase() === 'true' || env.PROXY_ENABLED === '1';
  }
  if (env.PROXY_SOURCE_URL) {
    config.proxy.sourceUrl = env.PROXY_SOURCE_URL.trim();
  }
  if (env.PROXY_FALLBACK_SOURCE_URL) {
    config.proxy.fallbackSourceUrl = env.PROXY_FALLBACK_SOURCE_URL.trim();
  }
  if (env.STATIC_PROXIES || env.PROXY_URL || env.PROXIES) {
    var rawStatic = (env.STATIC_PROXIES || env.PROXY_URL || env.PROXIES || '').trim();
    config.proxy.staticProxies = rawStatic.split(/[\n,;|]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  if (env.AUTO_TEST_PROXY !== undefined) {
    config.proxy.autoTest = String(env.AUTO_TEST_PROXY).toLowerCase() === 'true' || env.AUTO_TEST_PROXY === '1';
  }
  if (env.PROXY_TEST_TIMEOUT_MS) {
    var pttm = parseInt(env.PROXY_TEST_TIMEOUT_MS, 10);
    if (!isNaN(pttm) && pttm > 0) config.proxy.testTimeoutMs = pttm;
  }
  if (env.PROXY_MAX_POOL_SIZE) {
    var pmps = parseInt(env.PROXY_MAX_POOL_SIZE, 10);
    if (!isNaN(pmps) && pmps > 0) config.proxy.maxPoolSize = pmps;
  }
  if (env.PROXY_UPDATE_INTERVAL_HOURS) {
    var puih = parseInt(env.PROXY_UPDATE_INTERVAL_HOURS, 10);
    if (!isNaN(puih) && puih > 0) config.proxy.updateIntervalHours = puih;
  }
  // -- 挂起防护超时（毫秒）：防止代理源/死代理/冷启动刷新无限期挂起
  // 与其他超时变量一致：>0 才生效，非法值静默忽略并保留默认值
  if (env.PROXY_SOURCE_FETCH_TIMEOUT_MS) {
    var psftm = parseInt(env.PROXY_SOURCE_FETCH_TIMEOUT_MS, 10);
    if (!isNaN(psftm) && psftm > 0) config.proxy.sourceFetchTimeoutMs = psftm;
  }
  if (env.PROXY_HANDSHAKE_TIMEOUT_MS) {
    var phtm = parseInt(env.PROXY_HANDSHAKE_TIMEOUT_MS, 10);
    if (!isNaN(phtm) && phtm > 0) config.proxy.handshakeTimeoutMs = phtm;
  }
  if (env.PROXY_REFRESH_SYNC_MS) {
    var prsm = parseInt(env.PROXY_REFRESH_SYNC_MS, 10);
    if (!isNaN(prsm) && prsm > 0) config.proxy.refreshSyncMs = prsm;
  }
  if (env.PROXY_FALLBACK_DIRECT !== undefined) {
    config.proxy.fallbackDirect = String(env.PROXY_FALLBACK_DIRECT).toLowerCase() === 'true' || env.PROXY_FALLBACK_DIRECT === '1';
  }
  if (env.PROXY_ROTATION_MODE) {
    var requestedMode = env.PROXY_ROTATION_MODE.trim().toLowerCase();
    var validModes = { 'round-robin': 1, 'random': 1, 'best-of-2': 1, 'weighted': 1 };
    if (validModes[requestedMode]) {
      config.proxy.rotationMode = requestedMode;
    } else {
      log('PROXY_ROTATION_MODE=' + requestedMode + ' 不合法,已忽略(合法值: round-robin / random / best-of-2 / weighted),使用默认 ' + config.proxy.rotationMode, 'WARN', config);
    }
  }

  // -- 静态出站代理(HTTPS_PROXY / HTTP_PROXY / ALL_PROXY)
  //
  // Netlify Edge Functions 运行在 Deno 2 之上,其全局 fetch() 会原生读取
  // HTTPS_PROXY / HTTP_PROXY / NO_PROXY 环境变量并自动通过代理发起 CONNECT 隧道。
  // 因此这里无需手动转发:只要在 Netlify 环境变量中设置 HTTPS_PROXY,直连路径
  // (geminiFetch → fetch)就会自动走代理。
  //
  // 本处仅解析该变量用于状态展示与日志,便于在 /health 中确认代理是否已生效。
  var rawHttpsProxy = env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy || null;
  config.outboundProxy = rawHttpsProxy ? String(rawHttpsProxy).trim() : null;
  if (config.proxy.enabled && !connect) {
    // 当前平台没有原始 TCP Socket（如 Netlify Edge Functions），代理池(pool)无法工作：
    // 1. 关闭 autoTest，避免刷新代理池时对每个代理发起注定失败的 TCP 握手测试
    // 2. 输出告警，明确说明期望模式与实际生效模式
    // The platform has no raw TCP sockets (e.g. Netlify Edge Functions), so the
    // rotating proxy pool cannot work: disable the pointless per-proxy TCP
    // handshake auto-tests and warn about the effective outbound mode instead.
    config.proxy.autoTest = false;
    log('ENABLE_PROXY=true 已配置,但当前平台不提供原始 TCP Socket(connect=null),代理池(pool)不可用。' +
      '实际出站模式: ' + (config.outboundProxy ? 'outbound(静态出站代理 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY)' : 'direct(直连)') + '。' +
      (config.outboundProxy ? '' : '如需走代理,请设置 HTTPS_PROXY 环境变量(Deno fetch 原生支持;Vercel/Node 不会自动应用)。'), 'WARN', config);
  }

  // 附加环境与上下文引用,便于异步任务与 KV 访问
  config._env = env;
  config._ctx = ctx;
  config._platform = PLATFORM_ID;

  // 返回请求专属的配置副本
  // 这个对象在请求结束后随 Isolate 回收
  return config;
}
