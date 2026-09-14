// 🛠 通用工具函数
// 日志、UUID、时间戳、token 估算与 SAPISID 认证哈希，平台无关。
// Logging, UUID, timestamp, token estimation and SAPISID auth helpers.

import { DEFAULT_CONFIG } from './config.js';

// 🛠 工具函数

/**
 * 日志记录函数
 * 
 * 使用请求级配置中的 logRequests 开关控制是否输出日志。
 * 如果没有传入 config 参数（比如在 getRequestConfig 中调用），
 * 使用 DEFAULT_CONFIG 的 logRequests 设置。
 * 
 * 日志格式: [HH:MM:SS] [LEVEL] message
 * 例如: [14:30:25] [INFO] Chat: model=gemini-3.6-flash, stream=true
 * 
 * @param {string} msg - 要记录的日志消息
 * @param {string} [level] - 日志级别，默认 'INFO'。可选值: INFO / WARN / ERROR
 * @param {Object} [config] - 请求级配置对象（可选，用于并发安全）
 */
export function log(msg, level, config) {
  // 如果未指定日志级别，默认使用 INFO
  level = level || 'INFO';
  // 根据 config 参数决定是否输出日志
  // 有 config 时使用 config.logRequests，没有时使用默认配置
  var shouldLog = config ? config.logRequests : DEFAULT_CONFIG.logRequests;
  if (shouldLog) {
    // 生成时间戳，格式: HH:MM:SS
    // toISOString() 返回 "2026-07-30T14:30:25.123Z"
    // split('T')[1] 取 "14:30:25.123Z"
    // split('.')[0] 取 "14:30:25"
    var ts = new Date().toISOString().split('T')[1].split('.')[0];
    console.log('[' + ts + '] [' + level + '] ' + msg);
  }
}

/**
 * 生成 UUID v4（通用唯一标识符）
 * 
 * UUID v4 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * 其中 4 固定为版本号，y 的高位固定为 10xx（表示变体）
 * 
 * Cloudflare Workers 环境优先使用内置的 crypto.randomUUID() 方法。
 * 如果不可用（老版本或其他环境），使用 Math.random() 回退方案。
 * 回退方案的随机性较弱，不适合安全敏感场景。
 * 
 * @returns {string} UUID v4 格式的字符串，如 "550e8400-e29b-41d4-a716-446655440000"
 */
export function generateUUID() {
  // 优先使用 CF Workers 内置方法（性能更好，随机性更强）
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // 回退方案：手动生成符合 UUID v4 规范的字符串
  // 使用 Math.random() 生成伪随机数
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    // 生成 0-15 的随机整数
    var r = Math.random() * 16 | 0;
    // x 位置直接使用随机值
    // y 位置确保高位为 10xx（符合 UUID v4 规范：10xx = 8,9,a,b）
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 生成短 ID
 * 
 * 从 UUID 中提取前 length 个十六进制字符（去掉连字符）。
 * 用于生成聊天补全 ID、工具调用 ID、请求 ID 等不需要完整 UUID 的场景。
 * 
 * @param {number} [length] - 需要的 ID 长度，默认 12 字符
 * @returns {string} 短 ID 字符串，如 "a1b2c3d4e5f6"
 */
export function generateShortId(length) {
  var len = length || 12;
  // 去掉 UUID 中的连字符，取前 len 个字符
  return generateUUID().replace(/-/g, '').substring(0, len);
}

/**
 * 获取当前 Unix 时间戳（秒）
 * 
 * Unix 时间戳是从 1970-01-01 00:00:00 UTC 开始的秒数。
 * 广泛用于 API 响应中的 created 字段。
 * 
 * @returns {number} Unix 时间戳（秒），如 1753872000
 */
export function timestamp() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 估算文本的 Token 数量
 * 
 * 使用简单的启发式算法进行粗略估算：
 * - 英文约 4 字符 = 1 token
 * - 这个估算不够精确，但足以用于基本的资源预估和日志显示
 * - 不是精确计算，仅供 reference
 * 
 * @param {string} text - 要估算的文本
 * @returns {number} 估算的 token 数量，至少为 1
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // 至少返回 1，避免除零错误
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * 生成 SAPISID 认证哈希
 * 
 * Google API 使用基于时间的 SHA-1 哈希进行认证。
 * 这个哈希证明请求来自持有有效 Google 会话的用户。
 * 
 * 算法步骤:
 * 1. 获取当前 Unix 时间戳（秒）
 * 2. 构造输入字符串: "{timestamp} {sapisid} https://gemini.google.com"
 * 3. 使用 SHA-1 算法对输入进行哈希
 * 4. 将哈希结果转换为十六进制字符串
 * 5. 返回格式化字符串: "SAPISIDHASH {timestamp}_{hex_hash}"
 * 
 * 格式示例: SAPISIDHASH 1753872000_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
 * 
 * @param {string} sapisid - 从 Google Cookie 中提取的 SAPISID 值
 * @returns {Promise<string>} 认证哈希字符串
 */
export async function makeSapisidHash(sapisid) {
  // 获取当前时间戳
  var ts = timestamp();
  // 构造哈希输入（与 Google Web 前端完全一致的格式）
  var input = ts + ' ' + sapisid + ' https://gemini.google.com';

  // 将输入字符串编码为 UTF-8 字节数组
  var encoder = new TextEncoder();
  var data = encoder.encode(input);

  // 使用 Web Crypto API 进行 SHA-1 哈希
  var hashBuffer = await crypto.subtle.digest('SHA-1', data);

  // 将哈希结果（ArrayBuffer）转换为十六进制字符串
  var hashArray = Array.from(new Uint8Array(hashBuffer));
  var hashHex = hashArray.map(function (b) {
    // 每个字节转换为两位十六进制数
    return b.toString(16).padStart(2, '0');
  }).join('');

  // 返回格式化的认证字符串
  return 'SAPISIDHASH ' + ts + '_' + hashHex;
}

/**
 * 获取多账户 URL 前缀
 * 
 * Google 支持在同一个浏览器中登录多个 Google 账号。
 * 当使用非默认账户时，Gemini 的 URL 路径会包含账户索引：
 * - 默认账户: https://gemini.google.com/app
 * - 第二个账户: https://gemini.google.com/u/1/app
 * - 第三个账户: https://gemini.google.com/u/2/app
 * 
 * @param {Object} config - 请求级配置对象
 * @returns {string} URL 前缀，如 "/u/1"，默认账户返回空字符串 ""
 */
export function getAccountPrefix(config) {
  var authUser = config.authUser;
  // 如果 authUser 为 null、undefined 或空字符串，使用默认账户
  if (authUser === null || authUser === undefined || authUser === '') {
    return '';
  }
  // 返回带前导斜杠的账户前缀
  return '/u/' + authUser;
}
