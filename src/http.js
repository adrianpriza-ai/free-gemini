// 🧾 协议与校验辅助
// 速率限制、API 密钥校验、JSON/SSE 响应封装与模型名解析。
// Rate limiting, API key checks, JSON/SSE helpers and model resolution.

import { MODELS } from './models.js';

var rateLimitStore = new Map();

/**
 * 检查请求是否超过速率限制（滑动窗口算法）
 * 
 * 算法步骤:
 * 1. 获取当前时间和该 IP 的历史请求记录
 * 2. 过滤出时间窗口内的有效请求
 * 3. 如果有效请求数达到或超过阈值 → 拒绝（返回 false）
 * 4. 否则记录本次请求并允许（返回 true）
 * 
 * 【内存管理】
 * 由于 Cloudflare Workers 的 Isolate 可能长时间存活（热启动复用），
 * rateLimitStore 中的记录如果不清理会无限增长，导致内存泄漏。
 * 
 * 清理策略:
 * - 每次检查时有 5% 的概率触发全局清理（Math.random() < 0.05）
 * - 遍历所有 IP 的记录，删除过期或空的条目
 * - 5% 的概率确保清理不会过于频繁影响性能
 * 
 * @param {string} clientIP - 客户端 IP 地址
 * @param {Object} config - 请求级配置对象
 * @returns {boolean} true 表示允许请求，false 表示被限流拒绝
 */
export function checkRateLimit(clientIP, config) {
  // 如果速率限制未启用，直接放行
  if (!config.rateLimit || !config.rateLimit.enabled) return true;

  var now = Date.now();
  // 计算时间窗口的毫秒数（配置中是秒，需要转换为毫秒）
  var windowMs = config.rateLimit.windowSec * 1000;
  // 生成存储键（添加前缀避免与其他键冲突）
  var key = 'rl:' + clientIP;

  // 获取该 IP 的历史记录，并过滤出当前窗口内的有效请求
  var timestamps = (rateLimitStore.get(key) || []).filter(function (t) {
    return now - t < windowMs;
  });

  // 检查是否达到或超过阈值
  if (timestamps.length >= config.rateLimit.maxRequests) {
    return false;  // 拒绝请求
  }

  // 记录本次请求的时间戳
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);

  // 🛡️ 随机概率清理过期键（5% 概率触发）
  //
  // 防止长期高并发运行后，大量冷 IP 记录残留内存
  // 5% 的概率（约每 20 次检查触发一次）确保不会频繁执行
  if (Math.random() < 0.05) {
    // 使用 forEach 遍历 Map 中的所有条目
    rateLimitStore.forEach(function (v, k) {
      // 过滤出有效的（未过期的）记录
      var valid = v.filter(function (t) {
        return now - t < windowMs;
      });
      if (valid.length === 0) {
        // 该 IP 已无任何有效记录，删除整个条目
        rateLimitStore.delete(k);
      } else {
        // 更新为只包含有效记录的数组
        rateLimitStore.set(k, valid);
      }
    });
  }

  return true;  // 允许请求
}

// 🔐 API 密钥验证

/**
 * 验证 API 密钥（支持多种认证方式）
 * 
 * 认证方式按优先级排列:
 * 1. Authorization: Bearer <key>（标准 Bearer Token 认证，最推荐）
 * 2. x-api-key: <key>（自定义请求头，常用于 OpenAI SDK）
 * 3. x-goog-api-key: <key>（Google 风格的请求头）
 * 4. URL 查询参数 ?key=<key>（最不推荐，密钥暴露在 URL 中）
 * 
 * 如果 apiKeys 为空数组 []，表示不验证密钥，所有请求都允许。
 * 适用于内网使用或已有其他安全措施的场景。
 * 
 * @param {Request} request - HTTP 请求对象
 * @param {Object} config - 请求级配置对象
 * @returns {boolean} true 表示通过认证，false 表示认证失败
 */
export function checkApiKey(request, config) {
  // 获取 API 密钥白名单
  var keys = config.apiKeys || [];

  // 如果没有配置任何密钥，允许所有请求（不验证模式）
  if (keys.length === 0) return true;

  // 方式 1: Authorization: Bearer <key>
  var auth = request.headers.get('Authorization') || '';
  // 检查是否以 "Bearer " 开头
  if (auth.indexOf('Bearer ') === 0) {
    // 提取 Bearer 后面的 token（去掉 "Bearer " 前缀，共 7 个字符）
    var token = auth.slice(7);
    // 使用 indexOf 检查 token 是否在白名单中
    if (keys.indexOf(token) !== -1) return true;
  }

  // 方式 2 & 3: x-api-key / x-goog-api-key
  var headerNames = ['x-api-key', 'x-goog-api-key'];
  for (var i = 0; i < headerNames.length; i++) {
    var value = request.headers.get(headerNames[i]) || '';
    if (keys.indexOf(value) !== -1) return true;
  }

  // 方式 4: URL 查询参数 ?key=<key>
  var url = new URL(request.url);
  var keyParam = url.searchParams.get('key');
  if (keyParam && keys.indexOf(keyParam) !== -1) return true;

  // 所有认证方式都失败
  return false;
}

// 📤 HTTP 响应构建

/**
 * 发送 JSON 格式的 HTTP 响应
 * 
 * 自动设置 CORS 跨域头，允许来自任何域的请求访问。
 * 
 * @param {Object} data - 要发送的响应数据（会被 JSON.stringify 序列化）
 * @param {number} [status] - HTTP 状态码，默认 200
 * @returns {Response} HTTP 响应对象
 */
export function sendJSON(data, status) {
  if (status === undefined) status = 200;
  // 将数据序列化为 JSON 字符串
  var body = JSON.stringify(data);
  // 构建并返回 Response 对象
  return new Response(body, {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',           // 允许所有域访问
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',  // 允许的 HTTP 方法
      'Access-Control-Allow-Headers': '*',           // 允许所有请求头
    },
  });
}

/**
 * 发送 SSE（Server-Sent Events）流式响应
 * 
 * SSE 是一种服务器向客户端推送实时数据的协议。
 * 相比 WebSocket，SSE 更简单：
 * - 单向通信（服务器 → 客户端）
 * - 基于 HTTP 协议
 * - 自动重连机制
 * 
 * 数据格式:
 * data: {json}\n\n
 * 
 * 特殊格式:
 * data: [DONE]\n\n  → 表示流结束
 * : heartbeat\n\n   → SSE 注释（客户端忽略），用于保持连接
 * 
 * @param {ReadableStream} stream - 可读流对象
 * @returns {Response} HTTP 流式响应对象
 */
export function sendSSE(stream) {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',  // SSE 必需的内容类型
      'Cache-Control': 'no-cache',                          // 禁用缓存
      'Connection': 'keep-alive',                           // 保持连接不关闭
      'X-Accel-Buffering': 'no',                            // 禁用 nginx 代理缓冲
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

// 🎯 模型解析

/**
 * 解析模型名称，获取对应的配置参数
 * 
 * 支持 @think= 参数来覆盖默认的思考模式。
 * 例如: "gemini-3.6-flash@think=0" 
 * 表示使用 Flash 模型但启用深度思考（think=0）。
 * 
 * @param {string} modelName - 模型名称
 *   格式: "模型名" 或 "模型名@think=数字"
 * @returns {Object} 
 *   - modelName: 去掉 @think= 参数后的实际模型名称
 *   - modelId: MODE_CATEGORY 枚举值（1-6）
 *   - thinkMode: 思考模式（0=深度思考, 4=自动）
 *   - error: 错误信息，null 表示正常
 */
export function resolveModel(modelName) {
  var thinkOverride = null;

  // 🛡️ 防御性类型检查：客户端可能传入数字、null、对象等非字符串类型的 model。
  // 若不拦截，下方 indexOf/split 会抛出 TypeError，导致整个请求 500。
  if (modelName === null || modelName === undefined) {
    return { error: 'missing model' };
  }
  if (typeof modelName !== 'string') {
    modelName = String(modelName);
  }

  var actualModelName = modelName;

  // 检查是否包含 @think= 参数
  if (modelName.indexOf('@think=') !== -1) {
    var parts = modelName.split('@think=');
    actualModelName = parts[0];           // 提取真正的模型名称
    thinkOverride = parseInt(parts[1], 10);  // 提取思考模式覆盖值
    if (isNaN(thinkOverride)) {
      return { error: '无效的 think 参数: ' + parts[1] };
    }
  }

  // 查找模型配置
  var cfg = MODELS[actualModelName];
  if (!cfg) {
    return { error: '未知模型: ' + actualModelName };
  }

  // 返回解析结果
  return {
    modelName: actualModelName,
    modelId: cfg.mode,                                            // 模型类别 ID
    thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,  // 使用覆盖值或默认值
    error: null,
  };
}
