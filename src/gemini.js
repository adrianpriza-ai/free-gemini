// 📡 Gemini API 客户端
// 请求负载/URL/请求头构建 + 非流式调用（含重试与截止时间）+ 响应文本解析。
// Payload/URL/header builders, non-streaming call with retries, text parsing.

import { PRERESPONSE_DEADLINE_MS as PLATFORM_PRERESPONSE_DEADLINE_MS } from './platform.js';
import {
  getRandomUserAgent,
  getRandomAcceptLanguage,
  getRandomSecChUa,
  getRandomSecChUaPlatform,
} from './fingerprint.js';
import {
  log,
  generateUUID,
  generateShortId,
  timestamp,
  estimateTokens,
  makeSapisidHash,
  getAccountPrefix,
} from './utils.js';
import { geminiFetch } from './proxy.js';

// 📡 Gemini API 请求构建
//
// Gemini 的内部 API 使用复杂的嵌套数组结构。
// 以下函数负责构建与 Gemini Web 前端完全一致的请求负载和请求头。
// 这是整个程序能够正常工作的基础。

/**
 * 构建 Gemini API 请求负载
 * 
 * Gemini 内部使用 80 个元素的嵌套数组作为请求体。
 * 这个结构是通过逆向工程 Gemini Web 前端 JS 代码获得的。
 * 
 * 关键字段说明:
 *   inner[0]: 用户消息和元数据
 *     [prompt, 消息索引, 图片数据, 附件信息, 元数据, 上下文ID, 是否新对话]
 *   inner[1]: 语言设置 ["en"]
 *   inner[2]: 对话上下文（空表示新对话）
 *   inner[6]: 连续对话标志 [0]
 *   inner[7]: 流式输出标志 1
 *   inner[10]: 流式输出标志 1
 *   inner[11]: 安全过滤级别（0=基础, 1=严格, 2=最严格）
 *   inner[17]: 思考模式 [[thinkMode]]
 *     thinkMode=0: 启用深度思考
 *     thinkMode=4: 自动选择
 *   inner[18]: 扩展思考标志 0
 *   inner[30]: 输出格式 [4]
 *   inner[41]: 响应类型 [2]
 *   inner[59]: 唯一请求 ID（UUID v4）
 *   inner[61]: 附件列表 []
 *   inner[79]: 模型选择（MODE_CATEGORY 枚举值）⭐ 最关键的字段
 *     1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
 * 
 * 其他索引位置的值为 null，表示使用默认设置。
 * 
 * 外层包装:
 *   outer = [null, json.dumps(inner)]
 *   然后作为 f.req 参数的值进行 URL 编码
 * 
 * @param {string} prompt - 用户输入的提示文本
 * @param {number} modelId - 模型类别 ID（MODE_CATEGORY 枚举值: 1-6）
 * @param {number} thinkMode - 思考模式设置（0=深度思考, 4=自动）
 * @param {Object} config - 请求级配置对象
 * @returns {string} URL 编码的请求体字符串，格式为 "f.req=..."
 */
export function buildPayload(prompt, modelId, thinkMode, config) {
  // 创建 80 个元素的数组，所有元素初始化为 null
  // 这是 Gemini Web 前端实际使用的数据结构
  var inner = new Array(80).fill(null);

  // -- 用户消息
  // [prompt, 消息索引, 图片, 附件, 元数据, 上下文ID, 新对话标志]
  inner[0] = [prompt, 0, null, null, null, null, 0];

  // -- 语言设置为英语
  inner[1] = ['en'];

  // -- 对话上下文
  // 全部为空表示新对话，不使用任何历史记录
  inner[2] = ['', '', '', null, null, null, null, null, null, ''];

  // -- 连续对话标志
  inner[6] = [0];

  // -- 流式输出标志
  inner[7] = 1;    // 启用流式
  inner[10] = 1;   // 流式输出

  // -- 安全过滤级别
  // 0 = 基础过滤（推荐值，不会过度拦截正常内容）
  // 1 = 严格过滤（可能误拦）
  // 2 = 最严格过滤（非常保守）
  inner[11] = 0;

  // -- 思考模式配置
  // 双层嵌套数组: [[thinkMode]]
  // 外层数组包含一个内层数组，内层数组包含 thinkMode 值
  inner[17] = [[thinkMode]];

  // -- 扩展思考标志
  inner[18] = 0;

  // -- 各种内部参数
  // 这些参数的具体含义未知，但保持与 Gemini Web 前端一致
  inner[27] = 1;   // 未知标志
  inner[30] = [4]; // 输出格式设置
  inner[41] = [2]; // 响应类型设置
  inner[53] = 0;   // 未知标志

  // -- 唯一请求 ID
  // 使用 UUID v4 确保每次请求都有全局唯一的标识
  inner[59] = generateUUID();

  // -- 附件列表
  // 空数组表示没有附件
  inner[61] = [];

  // -- 其他设置
  inner[68] = 1;   // 未知标志

  // ⭐ 模型选择（最关键字段）
  // MODE_CATEGORY 枚举值:
  //   1=FAST（快速）, 2=THINKING（深度思考）, 3=PRO（专业版）
  //   4=AUTO（自动）, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
  inner[79] = modelId;

  // -- 外层包装
  // Gemini 的请求体是双层嵌套 JSON:
  // 外层: [null, inner_json_string]
  var outer = [null, JSON.stringify(inner)];

  // -- 构建 URL 编码参数
  var params = new URLSearchParams();
  // 主要数据放在 f.req 参数中
  params.append('f.req', JSON.stringify(outer));

  // 可选：添加 XSRF 令牌
  // 通常不需要，但某些极端情况下 Gemini 可能要求
  if (config.xsrfToken) {
    params.append('at', config.xsrfToken);
  }

  // 返回 URL 编码的字符串
  // 例如: f.req=%5Bnull%2C%22%5B%5B...%5D%5D%22%5D
  return params.toString();
}

/**
 * 构建 Gemini API 请求 URL
 * 
 * URL 格式:
 * https://gemini.google.com{prefix}/_/BardChatUi/data/
 *   assistant.lamda.BardFrontendService/StreamGenerate
 *   ?bl={build_label}&hl=en&_reqid={request_id}&rt=c
 * 
 * 参数说明:
 * - bl (build label): Gemini 前端构建版本标识，用于 API 版本控制
 * - hl (host language): 界面语言，固定为 en（英语）
 * - _reqid: 请求 ID，使用时间戳的后 6 位数字
 * - rt: 请求类型，c 表示普通聊天请求
 * 
 * @param {Object} config - 请求级配置对象
 * @returns {string} 完整的请求 URL
 */
export function buildUrl(config) {
  // 获取多账户 URL 前缀
  var prefix = getAccountPrefix(config);
  // 生成请求 ID（使用时间戳的后 6 位数字）
  // 例如 timestamp() = 1753872000 → reqid = 872000
  var reqid = timestamp() % 1000000;
  // 拼接完整 URL
  return 'https://gemini.google.com' + prefix +
    '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' +
    '?bl=' + config.geminiBl +
    '&hl=en' +
    '&_reqid=' + reqid +
    '&rt=c';
}

/**
 * 构建 Gemini API 请求头（包含多指纹轮换）
 * 
 * 🎭 多指纹轮换机制:
 * 每次调用此函数时，会随机选择不同的浏览器指纹组合：
 * - User-Agent: 从 8 种真实浏览器 UA 中加权随机选择
 * - Accept-Language: 从 6 种语言偏好中均匀随机选择
 * - Sec-Ch-Ua: 如果选中的是 Chrome UA，随机选择 Chrome 版本标识
 * - Sec-Ch-Ua-Platform: 随机选择操作系统平台
 * 
 * 这使每次请求看起来来自不同的浏览器和设备，
 * 降低被 Gemini 服务器识别为自动化脚本的概率。
 * 
 * 注意：Firefox 和 Safari 不会发送 Sec-Ch-Ua 系列头，
 * 所以只有当 UA 是 Chrome 时才添加这些头。
 * 
 * @param {Object} config - 请求级配置对象
 * @returns {Promise<Object>} HTTP 请求头对象
 */
export async function buildHeaders(config) {
  // 获取多账户 URL 前缀
  var prefix = getAccountPrefix(config);

  // 🎭 第一步：随机选择浏览器指纹
  var selectedUA = getRandomUserAgent();           // 加权随机选择 User-Agent
  var selectedLanguage = getRandomAcceptLanguage(); // 均匀随机选择语言偏好

  // 第二步：构建基础请求头
  var headers = {
    // 标准表单提交格式（与浏览器表单提交一致）
    'Content-Type': 'application/x-www-form-urlencoded',
    // 声明请求来源域（必须是 gemini.google.com）
    'Origin': 'https://gemini.google.com',
    // 声明引用页面
    'Referer': 'https://gemini.google.com' + prefix + '/app',
    // 同域请求标志（让 Gemini 认为这是内部请求）
    'X-Same-Domain': '1',
    // 🔑 使用随机选择的 User-Agent
    'User-Agent': selectedUA,
    // 接受任意响应类型
    'Accept': '*/*',
    // 🔑 使用随机选择的 Accept-Language
    'Accept-Language': selectedLanguage,
    // 浏览器安全策略头（现代浏览器的标准行为）
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  // 🎭 第三步：如果是 Chrome UA，添加 Sec-Ch-Ua 系列头
  // 判断方法：检查 User-Agent 字符串中是否包含 "Chrome"
  // Firefox 的 UA 包含 "Gecko" 和 "Firefox"，不包含 "Chrome"
  // Safari 的 UA 包含 "Safari" 但不包含 "Chrome"
  if (selectedUA.indexOf('Chrome') !== -1) {
    headers['Sec-Ch-Ua'] = getRandomSecChUa();              // Chrome 版本标识
    headers['Sec-Ch-Ua-Mobile'] = '?0';                      // 桌面端（非移动端）
    headers['Sec-Ch-Ua-Platform'] = getRandomSecChUaPlatform(); // 操作系统平台
  }

  // 第四步：多账户支持
  // 如果使用了非默认账户（authUser 不为空），添加认证用户头
  if (prefix) {
    headers['X-Goog-AuthUser'] = String(config.authUser);
  }

  // 第五步：Cookie 认证（如果有）
  // 提供有效的 Cookie 可以大幅提升请求稳定性
  // 减少 429（限流）和 403（禁止访问）错误的概率
  if (config.cookieString) {
    headers['Cookie'] = config.cookieString;
  }

  // 第六步：SAPISID 认证哈希（如果有）
  // 生成基于时间的 SHA-1 哈希，证明请求来自有效的 Google 会话
  // 格式: SAPISIDHASH {timestamp}_{sha1_hex_hash}
  if (config.sapisid) {
    headers['Authorization'] = await makeSapisidHash(config.sapisid);
  }


  return headers;
}

// 📡 非流式 API 调用

/**
 * 非流式调用 Gemini API
 * 
 * 发送请求到 Gemini StreamGenerate 端点并等待完整响应。
 * 支持自动重试、指数退避、详细的错误处理。
 * 
 * 【重试策略】
 * 使用指数退避算法：
 * - 第一次重试: 等待 retryDelaySec * 2^0 = 2 秒
 * - 第二次重试: 等待 retryDelaySec * 2^1 = 4 秒
 * - 第三次重试: 等待 retryDelaySec * 2^2 = 8 秒
 * 
 * 【错误处理】
 * - 405: BL 版本过期，需要更新 geminiBl 配置
 * - 429: 请求频率超限，等待 Retry-After 秒后重试
 * - 403: 需要有效的 Cookie 认证
 * - 其他: 记录错误信息并重试
 * 
 * 🎭 【指纹轮换】
 * 每次重试时都会重新构建请求头，使用不同的浏览器指纹。
 * 这增加了重试成功的机会，因为不同的指纹可能通过不同的限流规则。
 * 
 * 🎭 【随机延迟】
 * 请求前会添加 0 到 fingerprintJitterMs 之间的随机延迟。
 * 模拟人类操作的自然间隔，降低被检测为脚本的概率。
 * 
 * @param {string} prompt - 用户输入的提示文本
 * @param {number} modelId - 模型类别 ID（MODE_CATEGORY 枚举值: 1-6）
 * @param {number} thinkMode - 思考模式设置（0=深度思考, 4=自动）
 * @param {Object} config - 请求级配置对象
 * @returns {Promise<string>} API 原始响应文本（包含嵌套 JSON）
 * @throws {Error} 所有重试失败后抛出最后的错误
 */
export async function geminiStreamGenerate(prompt, modelId, thinkMode, config) {
  // ⏱️ 响应头截止时间（重要：Netlify Edge 平台限制）
  //
  // Netlify Edge Functions 要求响应头必须在 40 秒内发出，否则平台会
  // 中断请求并返回通用的 "Error - Request ID: ..." 错误页。
  // 旧版重试逻辑（3 次 × 28s 超时 + 指数退避 + Retry-After 等待）
  // 最坏情况可达 90+ 秒，必然触发该平台错误。
  //
  // 这里为非流式路径设定 30 秒硬截止：所有重试与等待都必须在此之前
  // 完成并拿到上游响应（响应体的传输不受此限制，只约束"首字节/响应头"）。
  // 流式路径的响应头立即可用，不受此限制。
  // ⏱️ 响应头截止时间（平台差异由 src/platform.js 提供：
  //    Cloudflare 无限制(0=禁用截止逻辑)，Vercel 22s，Netlify 30s）
  // Platform pre-response deadline, see src/platform.js.
  var PRERESPONSE_DEADLINE_MS = PLATFORM_PRERESPONSE_DEADLINE_MS;
  var deadline = Date.now() + PRERESPONSE_DEADLINE_MS;

  // ⏱️ 路由层总截止时间（REQUEST_DEADLINE_MS，handleRequestSafe 强制执行）
  //
  // handleRequestSafe 在 requestDeadlineMs（默认 50000ms）内拿不到上游响应
  // 就返回 502 upstream_timeout。重试循环必须把自己的预算对齐到这个更早的
  // 截止：用 config._requestStartMs（进入路由时打点）扣除已耗时，再预留
  // 3000ms 给响应体读取/收尾。否则（如 Deno Deploy：平台 55s > 路由 50s）
  // 重试会越过路由截止，客户端先收到笼统的 upstream_timeout，真正的
  // 上游错误（单次尝试超时/被拒）被掩盖。
  // config._requestStartMs 缺失（直接调用/旧调用方）时此约束不生效。
  //
  // Router-level total deadline (REQUEST_DEADLINE_MS, enforced by
  // handleRequestSafe). The retry loop must align its budget to this earlier
  // deadline: subtract elapsed time since config._requestStartMs (stamped on
  // router entry), reserving 3000ms for body read/finalization. Otherwise
  // (e.g. Deno Deploy: platform 55s > router 50s) retries overrun the router
  // deadline and clients see the generic upstream_timeout instead of the real
  // upstream error (per-attempt timeout / rejection).
  // Inactive when config._requestStartMs is absent (direct/legacy callers).
  var ROUTER_DEADLINE_MARGIN_MS = 3000;
  var routerDeadline = 0;
  if (config && config._requestStartMs > 0 && config.requestDeadlineMs > 0) {
    routerDeadline = config._requestStartMs + config.requestDeadlineMs - ROUTER_DEADLINE_MARGIN_MS;
    if (routerDeadline > 0 && (PRERESPONSE_DEADLINE_MS <= 0 || routerDeadline < deadline)) {
      deadline = routerDeadline;
    }
  }

  // 🎭 请求前添加随机微小延迟（模拟人类操作间隔）
  // 延迟时间在 0 到 fingerprintJitterMs 毫秒之间随机均匀分布
  // 例如 fingerprintJitterMs=1500 时，延迟在 0 到 1.5 秒之间
  if (config.fingerprintJitterMs > 0) {
    var jitter = Math.random() * config.fingerprintJitterMs;
    await new Promise(function (resolve) { setTimeout(resolve, jitter); });
  }

  // 构建请求负载、请求头、请求 URL
  var body = buildPayload(prompt, modelId, thinkMode, config);
  var headers = await buildHeaders(config);
  var url = buildUrl(config);

  // 保存最后一次错误，所有重试失败后抛出
  var lastError;

  // 重试循环
  for (var attempt = 0; attempt < config.retryAttempts; attempt++) {
    // ⏱️ 截止时间检查：剩余时间不足以完成一次有意义的请求时停止重试，
    // 避免总耗时越过 Netlify 的 40 秒响应头限制（导致 "Error - Request ID" 页面）
    if (PRERESPONSE_DEADLINE_MS > 0) {
      var remainingMs = deadline - Date.now();
      if (remainingMs < 3000) {
        log('非流式请求响应截止时间将耗尽，停止重试以保住响应头时限', 'WARN', config);
        break;
      }
    }

    try {
      // 🎭 重试时重新构建请求头（使用不同的浏览器指纹）
      // 这增加了重试成功的机会
      if (attempt > 0) {
        headers = await buildHeaders(config);
        // 重试时也添加新的随机延迟
        // 避免在完全相同的时间点重试
        if (config.fingerprintJitterMs > 0) {
          var retryJitter = Math.random() * config.fingerprintJitterMs;
          await new Promise(function (resolve) { setTimeout(resolve, retryJitter); });
        }
      }

      // 创建 AbortController 用于超时控制
      // 单次尝试超时不得超过剩余截止时间（最多再留 500ms 余量给头部处理）
      // Per-attempt timeout must not exceed the remaining pre-response deadline.
      var attemptTimeoutMs = config.requestTimeoutSec * 1000;
      if (PRERESPONSE_DEADLINE_MS > 0) {
        var remainingForAttempt = deadline - Date.now();
        attemptTimeoutMs = Math.max(1000, Math.min(attemptTimeoutMs, remainingForAttempt - 500));
      }
      var controller = new AbortController();
      var attemptTimedOut = false;
      var timeout = setTimeout(function () {
        attemptTimedOut = true;
        controller.abort();  // 超时后中止请求
      }, attemptTimeoutMs);

      // 发送 HTTP POST 请求（通过代理池或直连）
      var response = await geminiFetch(url, {
        method: 'POST',
        headers: headers,
        body: body,
        signal: controller.signal,  // 关联中止信号
      }, config);

      // 请求成功，清除超时定时器
      clearTimeout(timeout);

      // 错误状态码处理

      // 405 Method Not Allowed: BL 版本过期
      // Gemini 更新了前端，需要同步更新 geminiBl 配置
      if (response.status === 405) {
        throw new Error('HTTP 405: Method Not Allowed - 可能 BL 版本过期，请更新 geminiBl');
      }      // 429 Too Many Requests: 请求频率超限
      // 等待服务器指定的 Retry-After 时间后重试

      if (response.status === 429) {
        var retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
        log('收到 429 限流，等待 ' + retryAfter + ' 秒后重试...', 'WARN', config);
        if (attempt < config.retryAttempts - 1) {
          // ⏱️ 等待时间封顶：不得超过响应截止时间的剩余量（启用截止时间的平台）
          var waitMs = retryAfter * 1000;
          if (PRERESPONSE_DEADLINE_MS > 0) {
            waitMs = Math.min(waitMs, deadline - Date.now());
            if (waitMs < 1000) {
              throw new Error('HTTP 429: Too Many Requests - 请添加有效的 Cookie 或降低请求频率');
            }
          }
          await new Promise(function (resolve) { setTimeout(resolve, waitMs); });
          continue;  // 跳过本次，进入下一次重试
        }
        throw new Error('HTTP 429: Too Many Requests - 请添加有效的 Cookie 或降低请求频率');
      }

      // 403 Forbidden: 需要认证
      if (response.status === 403) {
        throw new Error('HTTP 403: Forbidden - 可能需要有效的 Cookie 认证');
      }

      // 其他 HTTP 错误
      if (!response.ok) {
        var errorText = '';
        try {
          errorText = await response.text();
        } catch (e) {
          errorText = '无法读取错误信息';
        }
        throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
      }

      // 请求成功，返回响应文本
      // 响应体读取同样受截止时间约束：上游响应头及时但正文停滞时，
      // 让读取与截止竞争，避免此处再吃掉整个剩余预算。
      // Body read is deadline-bound too: headers may arrive in time but the
      // body can stall — race the read against the deadline instead of
      // letting it consume the whole remaining budget.
      if (PRERESPONSE_DEADLINE_MS > 0) {
        var bodyLeft = deadline - Date.now();
        if (bodyLeft <= 0) {
          throw new Error('上游响应截止时间已耗尽（含响应体读取），请增加 REQUEST_DEADLINE_MS 或减少重试次数');
        }
        var bodyRead = response.text();
        var bodyTimer = null;
        var bodyTimeoutPromise = new Promise(function (_, reject) {
          bodyTimer = setTimeout(function () {
            reject(new Error('上游响应体读取超时（截止 ' + PRERESPONSE_DEADLINE_MS + 'ms 内未完成），可尝试流式模式或调大 REQUEST_DEADLINE_MS'));
          }, bodyLeft);
        });
        try {
          var bodyText = await Promise.race([bodyRead, bodyTimeoutPromise]);
          return bodyText;
        } finally {
          if (bodyTimer) clearTimeout(bodyTimer);
        }
      }
      return await response.text();

    } catch (error) {
      // 保存错误信息
      // 🔍 将 fetch 超时触发的裸 AbortError 包装成可读的错误消息。
      // Deno/Node/workerd 里 controller.abort() 让 await fetch 抛出
      // "The operation was aborted"（无上下文），用户无法判断是哪一层超时。
      // attemptTimedOut 标志能区分"我们主动超时"与"外部取消"。
      // Wrap the bare AbortError raised by our own per-attempt timer.
      // controller.abort() makes `await fetch` throw "The operation was
      // aborted" with no context; attemptTimedOut distinguishes our timeout
      // from an external cancellation.
      if (attemptTimedOut) {
        error = new Error('上游请求超时（单次尝试 ' + attemptTimeoutMs + 'ms 内未拿到响应），已重试/将重试。' +
          '如持续出现：设置 COOKIE_STRING 可大幅降低上游延迟；或启用 ENABLE_PROXY=true / HTTPS_PROXY 换出口 IP');
      }
      lastError = error;

      // 如果还有重试机会，等待后重试
      if (attempt < config.retryAttempts - 1) {
        log('重试 ' + (attempt + 1) + '/' + config.retryAttempts + ': ' + error.message, 'WARN', config);
        // 指数退避: 延迟时间 = 基础延迟 * 2^attempt
        // ⏱️ 退避等待封顶：不得超过响应截止时间的剩余量（启用截止时间的平台）
        var delay = config.retryDelaySec * Math.pow(2, attempt) * 1000;
        if (PRERESPONSE_DEADLINE_MS > 0) {
          delay = Math.min(delay, deadline - Date.now());
          if (delay < 500) {
            // 剩余时间不足，直接放弃重试，把最后的错误抛给上层
            break;
          }
        }
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
      }
    }
  }

  // 所有重试都失败，抛出最后的错误
  // lastError 可能为 undefined：预算在首次尝试前就耗尽时（如剩余截止 < 3s），
  // 循环直接 break，从未进入 try/catch —— 抛 undefined 会让上层显示
  // "upstream error: undefined"。这里兜底为明确的错误消息。
  // lastError may be undefined: if the budget is exhausted before the first
  // attempt (remaining deadline < 3s), the loop breaks without ever entering
  // try/catch — `throw lastError` would surface "upstream error: undefined"
  // upstream. Fall back to an explicit message.
  throw lastError || new Error('上游请求截止时间已耗尽，未发起任何有效尝试（可调大 REQUEST_DEADLINE_MS）');
}

// 📝 文本处理

/**
 * 清理 Gemini 响应中的代码执行痕迹
 * 
 * Gemini 有时会在响应中包含代码执行参考和输出块，格式如下:
 * ```python?code_reference&code_event_index=0
 * ...代码内容...
 * ```
 * ```javascript?code_stdout&code_event_index=1
 * ...输出内容...
 * ```
 * 
 * 这些代码执行块对最终用户没有意义，应该被移除以获得干净的响应文本。
 * 
 * 正则表达式说明:
 * - ```(?:python|javascript|text): 匹配代码块开始的三个反引号和语言标识
 * - \?code_(?:reference|stdout): 匹配代码执行参数
 * - &code_event_index=\d+: 匹配事件索引
 * - \n[\s\S]*?```: 匹配代码块内容（非贪婪模式）到结束的三个反引号
 * - \n?: 匹配可能存在的尾随换行符
 * 
 * @param {string} text - 原始响应文本
 * @param {boolean} [strip] - 是否去除首尾空白字符，默认 true
 * @returns {string} 清理后的文本
 */
export function cleanGeminiText(text, strip) {
  // 如果未指定 strip 参数，默认值为 true
  if (strip === undefined) strip = true;

  // 移除代码执行块
  // 使用全局替换（g 标志）和多行模式（s 标志，允许 . 匹配换行符）
  text = text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
    ''
  );

  // 根据 strip 参数决定是否去除首尾空白
  return strip ? text.trim() : text;
}

/**
 * 从 Gemini API 原始响应中提取最终文本
 * 
 * Gemini API 返回的是多行嵌套 JSON 数据，每行格式如下:
 * [["wrb.fr", "[[...]]", ...], ...]
 * 
 * 解析逻辑:
 * 1. 检查是否有 BardErrorInfo 错误信息
 * 2. 按行分割原始响应文本
 * 3. 跳过不包含 "wrb.fr" 标记的行（非数据行）
 * 4. 跳过长度小于 200 的行（太短，不包含有效数据）
 * 5. 解析每行的 JSON 数据（双层嵌套结构）
 * 6. 从 inner[4] 中提取文本内容
 * 7. 返回最后一个非空文本（通常是最终的完整响应）
 * 
 * 数据结构说明:
 * 外层 JSON 数组:
 *   [0]: "wrb.fr"（数据标记）
 *   [1]: 预留
 *   [2]: 内层 JSON 字符串
 * 内层 JSON 数组:
 *   [4]: 对话内容数组
 *     [*][0]: 内容类型
 *     [*][1]: 文本数组
 * 
 * @param {string} raw - API 原始响应文本
 * @returns {string} 提取并清理后的最终文本
 * @throws {Error} 如果检测到 BardErrorInfo 错误
 */
export function extractResponseText(raw) {
  // 第一步：检查 BardErrorInfo 错误
  // 格式: BardErrorInfo [错误代码]
  // 例如: BardErrorInfo [10] 表示请求被拒绝
  var bardErr = raw.match(/BardErrorInfo\s*\[(\d+)\]/);
  if (bardErr) {
    throw new Error('Gemini upstream rejected request: BardErrorInfo [' + bardErr[1] + ']');
  }

  // 第二步：收集所有提取到的文本片段
  var texts = [];

  // 第三步：按行分割原始响应
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // 跳过不包含 "wrb.fr" 的行（不是数据行）
    // 跳过长度小于 200 的行（太短，不包含有效数据）
    if (line.indexOf('"wrb.fr"') === -1 || line.length < 200) continue;

    try {
      // 第四步：解析外层 JSON
      var arr = JSON.parse(line);
      // 提取内层 JSON 字符串（arr[0][2]）
      var innerStr = arr[0][2];

      // 跳过空的或太短的内层 JSON
      if (!innerStr || innerStr.length < 50) continue;

      // 第五步：解析内层 JSON
      var inner = JSON.parse(innerStr);

      // 第六步：检查 inner[4] 是否存在且包含内容
      if (Array.isArray(inner) && inner.length > 4 && inner[4]) {
        var parts = inner[4];
        // 遍历 inner[4] 的每个部分
        for (var j = 0; j < parts.length; j++) {
          var part = parts[j];
          // part[1] 包含文本数据
          if (Array.isArray(part) && part.length > 1 && part[1]) {
            if (Array.isArray(part[1])) {
              var textItems = part[1];
              // 遍历文本项
              for (var k = 0; k < textItems.length; k++) {
                var t = textItems[k];
                // 收集非空字符串
                if (typeof t === 'string' && t.length > 0) {
                  texts.push(t);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      // JSON 解析错误，可能是响应不完整
      // 继续处理下一行，不中断整个解析过程
    }
  }

  // 第七步：获取最后一个非空文本
  // Gemini 的响应是逐步累积的，最后一个文本通常包含完整内容
  var text = '';
  for (var m = texts.length - 1; m >= 0; m--) {
    if (texts[m].trim()) {
      text = texts[m];
      break;
    }
  }

  // 第八步：清理代码执行痕迹并返回
  return cleanGeminiText(text);
}

// 🔄 OpenAI 格式转换

/**
 * 将 OpenAI 消息列表转换为 Gemini 提示文本
 * 
 * 这是整个程序的"翻译层"，负责将 OpenAI 的 Chat Completions API 格式
 * 转换为 Gemini 可以理解的纯文本格式。
 * 
 * 转换规则:
 * ┌──────────────┬──────────────────────────────────────────┐
 * │ OpenAI Role  │ Gemini 格式                              │
 * ├──────────────┼──────────────────────────────────────────┤
 * │ system       │ [System instruction]: {content}          │
 * │ assistant    │ [Assistant]: {content}                   │
 * │ tool         │ [Tool result for {name}]: {content}      │
 * │ user         │ {content}（直接使用）                    │
 * │ 工具调用      │ ```tool_call\n{json}\n``` 代码块格式     │
 * └──────────────┴──────────────────────────────────────────┘
 * 
 * 多条消息之间使用双换行（\n\n）分隔。
 * 
 * @param {Array} messages - OpenAI 格式的消息列表
 *   每条消息格式: { role: string, content: string | array }
 * @param {Array} [tools] - 可用的工具/函数定义列表（可选）
 *   每个工具格式: { type: "function", function: { name, description, parameters } }
 * @returns {string} 转换后的提示文本
 */
export function messagesToPrompt(messages, tools) {
  // 存储各个消息段的数组
  var parts = [];

  // 第一步：如果提供了工具定义，在开头添加工具使用说明
  if (tools && tools.length > 0) {
    // 标准化工具定义格式
    // 兼容两种格式:
    //   1. { type: "function", function: { name, description, parameters } }
    //   2. { name, description, parameters }（简写格式）
    var toolDefs = [];
    for (var ti = 0; ti < tools.length; ti++) {
      var tool = tools[ti];
      var fn = (tool.type === 'function') ? (tool.function || tool) : tool;
      toolDefs.push({
        name: fn.name || tool.name || '',
        description: fn.description || tool.description || '',
        parameters: fn.parameters || tool.parameters || {},
      });
    }

    // 构建工具使用说明文本
    // 包含:
    //   1. 工具调用格式说明
    //   2. 所有可用工具的 JSON 定义
    parts.push(
      '[System instruction]: You have access to tools. ' +
      'To call a tool, respond with:\n' +
      '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
      'Only use tool_call blocks when needed.\n\n' +
      'Available tools:\n' + JSON.stringify(toolDefs, null, 2)
    );
  }

  // 第二步：逐条处理消息
  for (var mi = 0; mi < messages.length; mi++) {
    var msg = messages[mi];
    var role = msg.role || 'user';     // 角色，默认为 user
    var content = msg.content || '';    // 消息内容

    // 如果内容是数组（多模态消息），提取文本部分
    // 例如: [{ type: "text", text: "Hello" }, { type: "image_url", ... }]
    // 只提取 type 为 "text" 或 "input_text" 的部分
    if (Array.isArray(content)) {
      var textParts = [];
      for (var ci = 0; ci < content.length; ci++) {
        var c = content[ci];
        if (c.type === 'text' || c.type === 'input_text') {
          textParts.push(c.text || '');
        }
      }
      content = textParts.join(' ');
    }

    // 根据角色进行不同的格式化
    if (role === 'system') {
      // 系统消息：添加指令前缀
      parts.push('[System instruction]: ' + content);
    } else if (role === 'assistant') {
      // 助手消息：检查是否包含工具调用
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // 将工具调用转换为代码块格式
        var tcStrs = [];
        for (var tci = 0; tci < msg.tool_calls.length; tci++) {
          var tc = msg.tool_calls[tci];
          var fn = tc.function || {};
          tcStrs.push(
            '```tool_call\n' +
            '{"name": "' + fn.name + '", "arguments": ' + (fn.arguments || '{}') + '}\n' +
            '```'
          );
        }
        parts.push('[Assistant]: ' + (content || '') + '\n' + tcStrs.join('\n'));
      } else {
        parts.push('[Assistant]: ' + content);
      }
    } else if (role === 'tool') {
      // 工具响应：添加结果前缀和工具名称
      parts.push('[Tool result for ' + (msg.name || 'unknown') + ']: ' + content);
    } else {
      // 用户消息：直接使用内容
      parts.push(content || '');
    }
  }

  // 第三步：用双换行连接所有部分，过滤掉空字符串
  return parts.filter(function (p) { return p; }).join('\n\n');
}

/**
 * 从响应文本中解析工具调用
 * 
 * 工具调用格式（在响应文本中）:
 * ```tool_call
 * {"name": "get_weather", "arguments": {"city": "Beijing"}}
 * ```
 * 
 * 解析后转换为 OpenAI 格式的工具调用对象:
 * {
 *   id: "call_xxxxxxxxxxxx",
 *   type: "function",
 *   function: {
 *     name: "get_weather",
 *     arguments: '{"city":"Beijing"}'
 *   }
 * }
 * 
 * @param {string} text - 可能包含工具调用的响应文本
 * @returns {Object} { cleanText: 清理后的纯文本, toolCalls: 工具调用数组 }
 */
export function parseToolCalls(text) {
  var toolCalls = [];

  // 正则匹配 tool_call 代码块
  // /```tool_call\s*\n(.*?)\n```/gs
  // g: 全局匹配（查找所有匹配项，而非只找第一个）
  // s: dotAll 模式（允许 . 匹配换行符 \n）
  var pattern = /```tool_call\s*\n(.*?)\n```/gs;
  var match;

  // 循环提取所有工具调用
  while ((match = pattern.exec(text)) !== null) {
    try {
      // match[1] 是第一个捕获组，即 tool_call 代码块中的 JSON 内容
      var data = JSON.parse(match[1].trim());

      // 构建 OpenAI 格式的工具调用对象
      toolCalls.push({
        id: 'call_' + generateShortId(8),       // 生成唯一的调用 ID
        type: 'function',
        function: {
          name: data.name,                       // 函数名
          arguments: JSON.stringify(data.arguments || {}),  // 参数（必须是 JSON 字符串）
        },
      });
    } catch (e) {
      // JSON 解析失败，跳过格式有误的代码块
      // 不中断整个解析过程
    }
  }

  // 从文本中移除所有 tool_call 代码块
  var cleanText = text.replace(pattern, '').trim();

  return {
    cleanText: cleanText,    // 清理后的纯文本
    toolCalls: toolCalls     // 工具调用数组
  };
}

/**
 * Google 原生 API 格式转换为提示文本
 * 
 * 支持 Google Gemini CLI 的原生 API 格式（generateContent）。
 * 格式示例:
 * {
 *   "systemInstruction": {
 *     "parts": [{"text": "你是一个有用的助手"}]
 *   },
 *   "contents": [
 *     {"role": "user", "parts": [{"text": "你好"}]},
 *     {"role": "model", "parts": [{"text": "你好！有什么可以帮助你的？"}]}
 *   ]
 * }
 * 
 * 转换规则:
 * - systemInstruction.parts[].text → "[System instruction]: {text}"
 * - contents[].role="model" → "[Assistant]: {text}"
 * - contents[].role="user" → {text}（直接使用）
 * 
 * @param {Object} req - Google API 格式的请求对象
 * @returns {string} 转换后的提示文本
 */
export function googleContentsToPrompt(req) {
  var parts = [];

  // 处理系统指令（systemInstruction）
  var sysInst = req.systemInstruction;
  if (sysInst && sysInst.parts) {
    var sysTextParts = [];
    for (var si = 0; si < sysInst.parts.length; si++) {
      var sp = sysInst.parts[si];
      if (sp.text) sysTextParts.push(sp.text);
    }
    var sysText = sysTextParts.join(' ');
    if (sysText) {
      parts.push('[System instruction]: ' + sysText);
    }
  }

  // 处理对话内容（contents）
  var contents = req.contents || [];
  for (var ci = 0; ci < contents.length; ci++) {
    var content = contents[ci];
    var role = content.role || 'user';
    var textParts = [];
    var partsArr = content.parts || [];
    for (var pi = 0; pi < partsArr.length; pi++) {
      if (partsArr[pi].text) textParts.push(partsArr[pi].text);
    }
    var text = textParts.join(' ');

    // model 角色 → Assistant 前缀
    if (role === 'model') {
      parts.push('[Assistant]: ' + text);
    } else {
      parts.push(text);
    }
  }

  return parts.filter(function (p) { return p; }).join('\n\n');
}

// 🚦 速率限制（Serverless 安全的内存存储）

// 使用 Map 数据结构存储每个 IP 的请求历史
// Map 相对于普通 Object 的优势：
// 1. 支持任意类型的键（这里使用字符串）
// 2. 有内置的 size 属性
// 3. 迭代性能更好
