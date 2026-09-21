// 📋 API 端点处理器
// /v1/chat/completions、/v1/responses 与 Google 原生 generateContent 的实现。
// Endpoint implementations for the OpenAI- and Google-compatible APIs.

import {
  log,
  generateUUID,
  generateShortId,
  timestamp,
  estimateTokens,
  getAccountPrefix,
} from './utils.js';
import { MODELS } from './models.js';
import {
  geminiStreamGenerate,
  buildPayload,
  buildUrl,
  buildHeaders,
  cleanGeminiText,
  extractResponseText,
  messagesToPrompt,
  parseToolCalls,
  toolNames,
  googleContentsToPrompt,
} from './gemini.js';
import { geminiFetch, globalProxyState, refreshProxyPool } from './proxy.js';
import { sendJSON, sendSSE, resolveModel } from './http.js';

// 🛡️ 空响应防护 - 上游返回 200 但正文无可提取文本
//
// Gemini 对匿名 / 数据中心出口 IP（Deno Deploy 的共享边缘 IP 是典型场景）
// 会静默限流：以 200 + 空正文（或不含任何可提取文本的正文）作答，而不是
// 返回 429/5xx。extractResponseText 对这类正文返回空字符串，若直接沿用，
// 上层会把"上游失败"当成"成功的空回答"返回 200 —— 客户端只收到
// { content: null, completion_tokens: 0, finish_reason: 'stop' }，
// 既拿不到答案，也看不到任何可定位的错误。
//
// 这里把空正文提升为显式错误：调用方的 catch 会转成带指引的 502，
// 而不是伪造一个成功的空响应。
//
// Empty-response guard. Gemini silently throttles anonymous / datacenter
// egress (Deno Deploy's shared edge IPs are the common case) by answering 200
// with an empty body — or a body with no extractable text — instead of
// 429/5xx. extractResponseText yields '' for such bodies; passing it through
// made the caller return 200 { content: null, completion_tokens: 0 }, i.e. a
// bogus successful empty completion that hides the real upstream failure.
// Promote it to an explicit error so the caller's catch turns it into an
// actionable 502.
//
// @param {string} raw - Gemini StreamGenerate 原始响应文本
// @returns {string} 提取出的非空文本
// @throws {Error} 上游返回空响应时抛出（调用方应转为 502）
function extractRequiredText(raw) {
  var text = extractResponseText(raw);
  if (text.trim()) return text;
  throw new Error(
    'Gemini 返回空响应（无可提取文本）。这通常是上游对当前出口 IP 的静默限流：' +
    '请设置 COOKIE_STRING（最有效），或启用 ENABLE_PROXY=true / HTTPS_PROXY 更换出口 IP；' +
    '若已配置 Cookie 仍出现，请降低请求频率。 ' +
    'Empty upstream response (no extractable text) — usually silent throttling of this egress IP: ' +
    'set COOKIE_STRING (most effective), or enable ENABLE_PROXY=true / HTTPS_PROXY to rotate egress.',
  );
}

// 📋 流式工具调用 - OpenAI 规范的增量块
//
// gemini_web2api/server.py 中 _stream_tool_calls 的等价实现。
// 每个 tool_call 拆分为:
//   1. 角色块  { delta: { role: 'assistant' } }
//   2. 头块    { delta: { tool_calls: [{ index, id, type, function: { name, arguments: '' } }] } }
//   3. 参数切片 { delta: { tool_calls: [{ index, function: { arguments: '...' } }] } }
//   4. 结束块  finish_reason: 'tool_calls'，随后 [DONE]
// index 是必需的 —— 客户端靠它把分片的 arguments 重新组装成完整 JSON。

var CHUNK_ARG_SLICE = 120;  // 每片 arguments 的最大字符数

/**
 * 构建一个符合 OpenAI 规范的 chat.completion.chunk 对象。
 *
 * @param {string} chatId - 会话 ID
 * @param {string} modelName - 模型名
 * @param {Object} delta - 增量内容
 * @param {string|null} [finishReason] - 结束原因；未传时为 null
 */
function buildChunk(chatId, modelName, delta, finishReason) {
  return {
    id: chatId,
    object: 'chat.completion.chunk',
    created: timestamp(),
    model: modelName,
    choices: [{ index: 0, delta: delta, finish_reason: finishReason === undefined ? null : finishReason }],
  };
}

/**
 * 将完整解析出的 tool_calls 以 OpenAI 规范的流式增量返回。
 *
 * @param {string} chatId - 会话 ID
 * @param {string} modelName - 模型名
 * @param {Array} toolCalls - OpenAI 格式的工具调用数组
 * @param {number} [argSlice] - 每片 arguments 的字符数（默认 120）
 * @returns {ReadableStream} SSE 流
 */
export function streamToolCallsSSE(chatId, modelName, toolCalls, argSlice) {
  var slice = typeof argSlice === 'number' && argSlice > 0 ? argSlice : CHUNK_ARG_SLICE;
  var encoder = new TextEncoder();

  return new ReadableStream({
    start: function (controller) {
      var write = function (delta, finishReason) {
        var chunk = buildChunk(chatId, modelName, delta, finishReason);
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
      };

      // 首块：声明 assistant 角色
      write({ role: 'assistant' });

      for (var i = 0; i < toolCalls.length; i++) {
        var tc = toolCalls[i];
        var fn = tc.function || {};

        // 头块：index + id + 函数名（arguments 置空）
        write({
          role: 'assistant',
          tool_calls: [{
            index: i,
            id: tc.id,
            type: 'function',
            function: { name: fn.name || '', arguments: '' },
          }],
        });

        // 参数切片：客户端按 index 拼接
        var args = fn.arguments || '';
        for (var j = 0; j < args.length; j += slice) {
          write({
            tool_calls: [{ index: i, function: { arguments: args.slice(j, j + slice) } }],
          });
        }
      }

      // 结束块 + [DONE]
      write({}, 'tool_calls');
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// 📋 核心请求处理 - /v1/chat/completions

/**
 * 处理 /v1/chat/completions 请求
 * 
 * 这是 OpenAI 兼容 API 的核心端点，也是整个程序最关键的函数。
 * 负责将 OpenAI 格式的聊天请求转换为 Gemini 格式，并返回响应。
 * 
 * 【支持两种模式】
 * 1. 非流式（stream=false）: 
 *    - 等待 Gemini 返回完整响应
 *    - 一次性解析并返回 JSON 格式的响应
 *    - 适用于工具调用（需要完整响应来解析 tool_call 代码块）
 * 
 * 2. 流式（stream=true）:
 *    - 实时读取 Gemini 的流式数据
 *    - 计算增量文本（当前全量 - 之前全量）
 *    - 立即将增量推送给客户端（打字机效果）
 *    - 包含心跳保活机制（每 2 秒发送 SSE 注释）
 * 
 * 【SSE 格式严格遵循 OpenAI 标准】
 * 首块:    { delta: { role: 'assistant' }, finish_reason: null }
 * 内容块:  { delta: { content: '增量文本' }, finish_reason: null }
 * 结束块:  { delta: { content: "" }, finish_reason: 'stop' }
 * 
 * @param {Request} request - HTTP 请求对象
 * @param {Object} body - 解析后的请求体（OpenAI Chat Completions 格式）
 * @param {Object} config - 请求级配置对象
 * @returns {Promise<Response>} HTTP 响应对象
 */
export async function handleChatCompletions(request, body, config) {
  // -- 第一步：解析模型
  var resolved = resolveModel(body.model || config.defaultModel);
  if (resolved.error) {
    return sendJSON({ error: { message: resolved.error } }, 400);
  }

  var modelName = resolved.modelName;
  var modelId = resolved.modelId;
  var thinkMode = resolved.thinkMode;
  var extraFields = resolved.extra;   // 附加 payload 字段（gemini-3.1-pro-enhanced 等）
  var tools = body.tools || null;

  // -- 第二步：转换消息为提示文本
  var prompt = messagesToPrompt(body.messages || [], tools);
  if (!prompt.trim()) {
    return sendJSON({ error: { message: 'empty prompt' } }, 400);
  }

  var stream = body.stream === true;
  var chatId = 'chatcmpl-' + generateShortId(12);

  log('Chat: model=' + modelName + ', stream=' + stream + ', tokens≈' + estimateTokens(prompt), 'INFO', config);

  // 情况 A：非流式或带工具调用
  //
  // 工具调用需要完整的响应文本才能解析 tool_call 代码块
  // 所以即使请求了 stream=true，如果有 tools 也强制使用非流式
  if (!stream || tools) {
    try {
      // 调用 Gemini API 获取完整响应
      var raw = await geminiStreamGenerate(prompt, modelId, thinkMode, config, extraFields);

      // 提取并清理响应文本（空正文视为上游失败，转 502，见 extractRequiredText）
      var text = extractRequiredText(raw);
      var toolCalls = null;

      // 如果启用了工具，解析工具调用（validNames 过滤幻觉出的工具名）
      if (tools && text) {
        var parsed = parseToolCalls(text, toolNames(tools));
        text = parsed.cleanText;
        toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : null;
      }

      // 🛡️ 与 extractRequiredText 同一不变量：绝不返回 200 + content: null。
      // 工具解析可能把整段文本当作幻觉工具调用剥离，最终既无文本也无
      // tool_calls —— 同样按上游失败处理，而不是伪造一个成功的空消息。
      // Same invariant as extractRequiredText: never return 200 with a null
      // content. Tool parsing can strip the whole text as a hallucinated call,
      // leaving neither text nor tool_calls — treat that as an upstream
      // failure too instead of a bogus successful empty message.
      if (!toolCalls && !text.trim()) {
        throw new Error('Gemini 返回的响应没有可用文本或工具调用（可能被上游限流或工具解析失败）。Empty upstream response: no usable text or tool_calls.');
      }

      // 构建响应消息
      var msg = { role: 'assistant', content: text || null };
      if (toolCalls) {
        msg.tool_calls = toolCalls;
      }

      var finishReason = toolCalls ? 'tool_calls' : 'stop';

      // 流式模式：按 OpenAI 规范把工具调用拆成增量块
      if (stream) {
        if (toolCalls) {
          return sendSSE(streamToolCallsSSE(chatId, modelName, toolCalls));
        }
        var encoder = new TextEncoder();
        var nonStreamSSE = new ReadableStream({
          start: function (controller) {
            var chunk = {
              id: chatId,
              object: 'chat.completion.chunk',
              created: timestamp(),
              model: modelName,
              choices: [{ index: 0, delta: msg, finish_reason: finishReason }],
            };
            controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return sendSSE(nonStreamSSE);
      }

      // 标准非流式 JSON 响应
      return sendJSON({
        id: chatId,
        object: 'chat.completion',
        created: timestamp(),
        model: modelName,
        choices: [{ index: 0, message: msg, finish_reason: finishReason }],
        usage: {
          prompt_tokens: estimateTokens(prompt),
          completion_tokens: estimateTokens(text),
          total_tokens: estimateTokens(prompt + text),
        },
      });

    } catch (error) {
      log('Upstream error: ' + error.message, 'ERROR', config);
      return sendJSON({ error: { message: 'upstream error: ' + error.message } }, 502);
    }
  }

  // 情况 B：真流式 SSE 响应（打字机效果）
  var streamEncoder = new TextEncoder();

  var streamBody = new ReadableStream({
    start: function (controller) {
      // -- 状态管理变量
      var heartbeatTimer = null;  // 心跳定时器 ID
      var isFinished = false;      // 流是否已经结束（防止重复关闭）

      /**
       * 清理心跳定时器
       * 在流结束或出错时调用，确保定时器被正确清除
       */
      var clearHeartbeat = function () {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      /**
       * 安全结束流
       * 确保发送结束块和 [DONE] 标记后才关闭流
       * 防止重复关闭导致错误
       * 
       * @param {string} reason - 结束原因，'stop' 表示正常结束，'error' 表示异常结束
       */
      var finishStream = function (reason) {
        // 防止重复结束（可能同时触发 error 和 close 事件）
        if (isFinished) return;
        clearHeartbeat();
        isFinished = true;
        try {
          // 发送符合 OpenAI 标准的结束块
          // ⚠️ 重要：delta.content 必须为 ""（空字符串），不能是空对象 {}
          // NextChat 等客户端会检查 delta.content 是否存在
          controller.enqueue(streamEncoder.encode('data: ' + JSON.stringify({
            id: chatId,
            object: 'chat.completion.chunk',
            created: timestamp(),
            model: modelName,
            choices: [{
              index: 0,
              delta: { content: "" },
              finish_reason: reason || 'stop'
            }],
          }) + '\n\n'));
          // 发送 [DONE] 标记（SSE 协议规定的流结束信号）
          controller.enqueue(streamEncoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (e) {
          log('Failed to finish stream: ' + e.message, 'ERROR', config);
        }
      };

      // 使用异步立即执行函数（IIFE）处理流式逻辑
      // 因为 ReadableStream 的 start 不能是 async 函数
      (async function () {
        try {
          // -- 第一步：发送 role 声明块
          // 符合 OpenAI 标准：首块只包含 role，不包含 content
          // 这告诉客户端："接下来是 assistant 角色的消息"
          controller.enqueue(streamEncoder.encode('data: ' + JSON.stringify({
            id: chatId,
            object: 'chat.completion.chunk',
            created: timestamp(),
            model: modelName,
            choices: [{
              index: 0,
              delta: { role: 'assistant' },
              finish_reason: null
            }],
          }) + '\n\n'));

          // -- 第二步：启动心跳定时器
          // 每 2 秒发送一次 SSE 注释（以冒号开头的行）
          // 客户端会忽略注释行，但连接保持活跃
          // 这防止了长时间无数据时连接被中间代理断开
          heartbeatTimer = setInterval(function () {
            if (!isFinished) {
              try {
                // SSE 注释格式：以冒号开头，客户端忽略
                controller.enqueue(streamEncoder.encode(': heartbeat\n\n'));
              } catch (e) {
                clearHeartbeat();  // 写入失败，停止心跳
              }
            } else {
              clearHeartbeat();
            }
          }, 2000);

          // -- 第三步：构建并发送 Gemini 请求（含重试逻辑）
          var reqBody = buildPayload(prompt, modelId, thinkMode, config, extraFields);
          var url = buildUrl(config);

          // 🎭 请求前随机延迟（与非流式保持一致）
          if (config.fingerprintJitterMs > 0) {
            var streamJitter = Math.random() * config.fingerprintJitterMs;
            await new Promise(function (resolve) { setTimeout(resolve, streamJitter); });
          }

          var response = null;
          var lastStreamError = null;

          // ⏱️ 路由层总截止（REQUEST_DEADLINE_MS）：与非流式路径一致，流式
          // 重试（含 429 Retry-After 等待与指数退避）同样必须在此前完成。
          // 否则大 Retry-After / 长退避会吃光预算，真实的上游错误被笼统的
          // upstream_timeout 502 掩盖。0 = 无约束（未启用截止）。
          // Router-level deadline (REQUEST_DEADLINE_MS): streaming retries —
          // including Retry-After waits and exponential backoff — must also
          // finish before it, otherwise a large Retry-After/long backoff eats
          // the budget and the real upstream error is masked by the generic
          // upstream_timeout 502. 0 = unconstrained.
          var STREAM_DEADLINE_MARGIN_MS = 3000;
          var streamDeadline = 0;
          if (config._requestStartMs > 0 && config.requestDeadlineMs > 0) {
            streamDeadline = config._requestStartMs + config.requestDeadlineMs - STREAM_DEADLINE_MARGIN_MS;
          }

          // 重试循环（与非流式路径保持一致）
          for (var streamAttempt = 0; streamAttempt < config.retryAttempts; streamAttempt++) {
            // ⏱️ 剩余预算不足以完成一次有意义的尝试时停止重试
            // Stop when the remaining budget cannot fit a meaningful attempt.
            if (streamDeadline > 0 && streamDeadline - Date.now() < 3000) {
              log('流式请求响应截止时间将耗尽，停止重试', 'WARN', config);
              break;
            }
            // 每次尝试重新构建请求头（不同指纹）
            var headers = await buildHeaders(config);
            if (streamAttempt > 0) {
              // 重试时也添加随机延迟
              if (config.fingerprintJitterMs > 0) {
                var retryStreamJitter = Math.random() * config.fingerprintJitterMs;
                await new Promise(function (resolve) { setTimeout(resolve, retryStreamJitter); });
              }
            }

            // 创建独立的 AbortController 用于超时控制
            // 单次尝试超时不得超过剩余截止预算（最多再留 1s 余量）
            var fetchTimeoutMs = (config.requestTimeoutSec - 2) * 1000;
            if (streamDeadline > 0) {
              fetchTimeoutMs = Math.max(1000, Math.min(fetchTimeoutMs, streamDeadline - Date.now() - 1000));
            }
            var fetchController = new AbortController();
            var fetchTimeout = setTimeout(function () {
              fetchController.abort();  // 超时后中止 fetch 请求
            }, fetchTimeoutMs);

            try {
              // 发送 HTTP POST 请求到 Gemini（通过代理池或直连）
              var attemptResponse = await geminiFetch(url, {
                method: 'POST',
                headers: headers,
                body: reqBody,
                signal: fetchController.signal,
              }, config);
              clearTimeout(fetchTimeout);

              // 检查响应状态码
              if (attemptResponse.status === 405) {
                lastStreamError = new Error('HTTP 405: Method Not Allowed - 可能 BL 版本过期，请更新 GEMINI_BL');
                break; // 405 无法通过重试解决
              }

              if (attemptResponse.status === 429) {
                var retryAfter = parseInt(attemptResponse.headers.get('Retry-After') || '5', 10);
                log('流式请求收到 429，等待 ' + retryAfter + ' 秒后重试...', 'WARN', config);
                lastStreamError = new Error('HTTP 429: Too Many Requests - 请添加有效的 Cookie 或降低请求频率');
                if (streamAttempt < config.retryAttempts - 1) {
                  // ⏱️ 等待 Retry-After 后必须仍留 ≥3s 的有效尝试时间，否则
                  // 直接跳出并抛出真实的 429 —— 白等会把预算耗光，真实的 429
                  // 反而被笼统的 upstream_timeout 502 掩盖。
                  // After honoring Retry-After there must be ≥3s left for a
                  // meaningful attempt; otherwise bail out with the real 429
                  // instead of letting the generic upstream_timeout mask it.
                  if (streamDeadline > 0 && (streamDeadline - Date.now()) - retryAfter * 1000 < 3000) {
                    break;
                  }
                  await new Promise(function (resolve) { setTimeout(resolve, retryAfter * 1000); });
                  continue;
                }
                break;
              }

              if (!attemptResponse.ok) {
                var errorText = '';
                try {
                  errorText = await attemptResponse.text();
                } catch (e) {
                  errorText = '无法读取错误信息';
                }
                lastStreamError = new Error('HTTP ' + attemptResponse.status + ': ' + errorText.substring(0, 200));
                // 对于其他错误，也进行指数退避重试
                if (streamAttempt < config.retryAttempts - 1) {
                  var errDelay = config.retryDelaySec * Math.pow(2, streamAttempt) * 1000;
                  // ⏱️ 预算装不下这次退避时直接跳出，抛出真实的上游错误
                  if (streamDeadline > 0 && (streamDeadline - Date.now()) - errDelay < 3000) {
                    break;
                  }
                  log('流式请求失败，重试 ' + (streamAttempt + 1) + '/' + config.retryAttempts, 'WARN', config);
                  await new Promise(function (resolve) { setTimeout(resolve, errDelay); });
                  continue;
                }
                break;
              }

              // 请求成功，退出重试循环
              response = attemptResponse;
              lastStreamError = null;
              break;

            } catch (fetchErr) {
              clearTimeout(fetchTimeout);
              lastStreamError = fetchErr;
              if (streamAttempt < config.retryAttempts - 1) {
                var fetchDelay = config.retryDelaySec * Math.pow(2, streamAttempt) * 1000;
                // ⏱️ 预算装不下这次退避时直接跳出，抛出真实的异常
                if (streamDeadline > 0 && (streamDeadline - Date.now()) - fetchDelay < 3000) {
                  break;
                }
                log('流式请求异常，重试 ' + (streamAttempt + 1) + '/' + config.retryAttempts + ': ' + fetchErr.message, 'WARN', config);
                await new Promise(function (resolve) { setTimeout(resolve, fetchDelay); });
              }
            }
          }

          // 所有重试失败，抛出最后的错误
          if (!response) {
            throw lastStreamError || new Error('流式请求失败，所有重试已耗尽（若接近 REQUEST_DEADLINE_MS 截止，可调大该值或减少重试次数）');
          }

          // -- 第四步：读取流式响应并实时转发增量数据
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';      // 行缓冲区（处理不完整的行）
          var prevText = '';    // 记录之前已发送的完整文本
          var emittedAny = false; // 是否已向客户端发送过任何内容（见下方空响应防护）

          while (true) {
            var readResult = await reader.read();
            if (readResult.done) break;  // 流结束

            // 解码新数据并追加到缓冲区
            buffer += decoder.decode(readResult.value, { stream: true });

            // 检查 Gemini 错误信息
            if (buffer.indexOf('BardErrorInfo') !== -1) {
              var match = buffer.match(/BardErrorInfo\s*\[(\d+)\]/);
              if (match) {
                throw new Error('Gemini upstream rejected request: BardErrorInfo [' + match[1] + ']');
              }
            }

            // 按行分割处理（Gemini 的响应是每行一个 JSON）
            var lines = buffer.split('\n');
            // 最后一行可能不完整，保留在缓冲区中
            buffer = lines.pop() || '';

            // 遍历每一行完整的数据
            for (var li = 0; li < lines.length; li++) {
              var line = lines[li];
              // 跳过不包含数据标记的行或太短的行
              if (line.indexOf('"wrb.fr"') === -1 || line.length < 200) continue;

              try {
                // 解析 Gemini 的嵌套 JSON 响应
                var arr = JSON.parse(line);
                var innerStr = arr[0][2];
                if (!innerStr || innerStr.length < 50) continue;

                var inner2 = JSON.parse(innerStr);

                // 提取文本内容
                if (Array.isArray(inner2) && inner2.length > 4 && inner2[4]) {
                  var parts = inner2[4];
                  for (var pi = 0; pi < parts.length; pi++) {
                    var part = parts[pi];
                    if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
                      var textItems = part[1];
                      for (var ti = 0; ti < textItems.length; ti++) {
                        var t = textItems[ti];
                        // 检查是否有新内容（文本长度增加了）
                        if (typeof t === 'string' && t.length > prevText.length) {
                          // 🔑 计算增量文本
                          // 增量 = 当前完整文本 - 之前已发送的完整文本
                          var delta = t.slice(prevText.length);
                          // 清理代码执行痕迹（不 trim，保留空白格式）
                          var cleaned = cleanGeminiText(delta, false);
                          if (cleaned) {
                            // 立即将增量块推送给客户端（打字机效果）
                            controller.enqueue(streamEncoder.encode('data: ' + JSON.stringify({
                              id: chatId,
                              object: 'chat.completion.chunk',
                              created: timestamp(),
                              model: modelName,
                              choices: [{
                                index: 0,
                                delta: { content: cleaned },
                                finish_reason: null
                              }],
                            }) + '\n\n'));
                            emittedAny = true;
                          }
                          // 更新已发送的文本记录
                          prevText = t;
                        }
                      }
                    }
                  }
                }
              } catch (e) {
                // JSON 解析错误，继续处理下一行
                // Gemini 的响应可能在传输中被截断
              }
            }
          }

          // -- 第五步：空响应防护后正常结束流
          //
          // 与非流式路径（extractRequiredText）同一不变量：上游以 200 +
          // 空正文（或无可提取文本的正文）静默限流时，整条流会没有任何
          // 内容块。此时必须报错，而不是发一个空的 finish_reason: 'stop'，
          // 否则客户端同样只看到一个"成功的空回答"。
          // Same invariant as the non-streaming path: when the upstream
          // silently throttles with a 200 + empty (or text-free) body, the
          // whole stream carries no content chunk — surface an error instead
          // of an empty finish_reason: 'stop'.
          if (!emittedAny) {
            throw new Error(
              'Gemini 返回空响应（流中无可提取文本）。这通常是上游对当前出口 IP 的静默限流：' +
              '请设置 COOKIE_STRING（最有效），或启用 ENABLE_PROXY=true / HTTPS_PROXY 更换出口 IP。 ' +
              'Empty upstream stream (no extractable text) — usually silent throttling of this egress IP: ' +
              'set COOKIE_STRING (most effective), or enable ENABLE_PROXY=true / HTTPS_PROXY to rotate egress.',
            );
          }
          finishStream('stop');

        } catch (error) {
          // 错误处理：记录日志并尝试通知客户端
          log('Stream error: ' + error.message, 'ERROR', config);
          try {
            if (!isFinished) {
              controller.enqueue(streamEncoder.encode('data: ' + JSON.stringify({
                error: { message: error.message, type: 'upstream_error' }
              }) + '\n\n'));
            }
          } catch (e) {
            // 发送错误信息失败，可能客户端已断开
          }
          finishStream('error');
        }
      })();  // 立即执行异步函数
    },

    /**
     * 客户端断开连接时的回调
     * 当用户关闭页面或网络中断时触发
     * 清理资源，停止心跳
     */
    cancel: function () {
      log('Client disconnected from stream', 'INFO', config);
    },
  });

  return sendSSE(streamBody);
}

/**
 * 处理 /v1/responses 请求（OpenAI Responses API）
 * 
 * 这是 OpenAI 新的 Responses API（用于 Codex CLI 等工具）。
 * 与 Chat Completions API 类似，但消息格式略有不同。
 * 
 * Responses API 格式:
 * {
 *   "model": "gpt-4o",
 *   "input": [
 *     {"role": "user", "content": "Hello"},
 *     {"type": "function_call_output", "call_id": "...", "output": "..."}
 *   ],
 *   "instructions": "系统指令（可选）",
 *   "tools": [...]
 * }
 * 
 * 本函数负责将 Responses API 格式转换为 Chat Completions 格式，
 * 然后复用 handleChatCompletions 的逻辑。
 * 
 * @param {Request} request - HTTP 请求对象
 * @param {Object} body - 解析后的请求体
 * @param {Object} config - 请求级配置对象
 * @returns {Promise<Response>} HTTP 响应对象
 */
export async function handleResponses(request, body, config) {
  // 解析模型
  var resolved = resolveModel(body.model || config.defaultModel);
  if (resolved.error) {
    return sendJSON({ error: { message: resolved.error } }, 400);
  }

  var modelName = resolved.modelName;
  var modelId = resolved.modelId;
  var thinkMode = resolved.thinkMode;
  var extraFields = resolved.extra;   // 附加 payload 字段（gemini-3.1-pro-enhanced 等）
  var messages = [];

  // 添加系统指令（instructions 字段）
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // 处理输入项（input 字段）
  var inputs = body.input || [];
  // 兼容字符串格式的 input
  if (typeof inputs === 'string') {
    inputs = [inputs];
  }
  for (var i = 0; i < inputs.length; i++) {
    var item = inputs[i];
    if (typeof item === 'string') {
      // 简单字符串 → user 消息
      messages.push({ role: 'user', content: item });
    } else if (item.type === 'function_call_output') {
      // 函数调用输出 → tool 消息
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        name: item.name,
        content: item.output,
      });
    } else {
      // 其他格式的消息
      var content = item.content;
      if (Array.isArray(content)) {
        var textParts = [];
        for (var j = 0; j < content.length; j++) {
          var c = content[j];
          if (c.type === 'output_text') textParts.push(c.text || '');
        }
        content = textParts.join(' ');
      }
      messages.push({ role: item.role || 'user', content: content });
    }
  }

  // 标准化工具定义
  var tools = body.tools;
  if (tools) {
    var normalizedTools = [];
    for (var ti = 0; ti < tools.length; ti++) {
      var t = tools[ti];
      if (t.type === 'function' && !t.function) {
        // 简写格式 → 完整格式
        normalizedTools.push({
          type: 'function',
          function: { name: t.name, description: t.description || '', parameters: t.parameters || {} },
        });
      } else {
        normalizedTools.push(t);
      }
    }
    tools = normalizedTools;
  }

  // 转换消息为提示文本
  var prompt = messagesToPrompt(messages, tools);
  if (!prompt.trim()) {
    return sendJSON({ error: { message: 'empty input' } }, 400);
  }

  try {
    // 调用 Gemini API
    var raw = await geminiStreamGenerate(prompt, modelId, thinkMode, config, extraFields);
    var text = extractRequiredText(raw);
    var toolCalls = null;

    // 解析工具调用（validNames 过滤幻觉出的工具名）
    if (tools && text) {
      var parsed = parseToolCalls(text, toolNames(tools));
      text = parsed.cleanText;
      toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : null;
    }

    // 构建 Responses API 格式的输出
    var responseId = 'resp_' + generateShortId(16);
    var messageId = 'msg_' + generateShortId(12);
    var output = [];

    // 添加工具调用输出
    if (toolCalls) {
      for (var tci = 0; tci < toolCalls.length; tci++) {
        var tc = toolCalls[tci];
        output.push({
          type: 'function_call',
          id: tc.id,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: 'completed',
        });
      }
    }

    // 添加文本输出
    if (text || !toolCalls) {
      output.push({
        type: 'message',
        id: messageId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: text || '', annotations: [] }],
      });
    }

    return sendJSON({
      id: responseId,
      object: 'response',
      created_at: timestamp(),
      status: 'completed',
      model: modelName,
      output: output,
      usage: {
        input_tokens: estimateTokens(prompt),
        output_tokens: estimateTokens(text),
        total_tokens: estimateTokens(prompt + text),
      },
    });
  } catch (error) {
    return sendJSON({ error: { message: 'upstream error: ' + error.message } }, 502);
  }
}

/**
 * 处理 Google 原生 API（Gemini CLI 兼容）
 * 
 * 支持 Google Gemini CLI 的原生 generateContent 和 streamGenerateContent 格式。
 * URL 格式: /v1beta/models/{model}:generateContent
 * 
 * @param {Request} request - HTTP 请求对象
 * @param {Object} body - 解析后的请求体（Google 格式）
 * @param {boolean} stream - 是否使用流式传输
 * @param {Object} config - 请求级配置对象
 * @returns {Promise<Response>} HTTP 响应对象
 */
export async function handleGoogleAPI(request, body, stream, config) {
  // 从 URL 路径中提取模型名称
  // 例如: /v1beta/models/gemini-3.6-flash:generateContent → "gemini-3.6-flash"
  var requestUrl = new URL(request.url);
  var match = requestUrl.pathname.match(/\/v1beta\/models\/([^:]+)/);
  var modelName = match ? match[1] : null;

  if (!modelName) {
    return sendJSON({ error: { message: 'model not specified in path' } }, 400);
  }

  var resolved = resolveModel(modelName);
  if (resolved.error) {
    return sendJSON({ error: { message: resolved.error } }, 400);
  }

  var modelId = resolved.modelId;
  var thinkMode = resolved.thinkMode;
  var extraFields = resolved.extra;   // 附加 payload 字段（gemini-3.1-pro-enhanced 等）

  // 转换 Google 格式为提示文本
  var prompt = googleContentsToPrompt(body);
  if (!prompt.trim()) {
    return sendJSON({ error: { message: 'empty content' } }, 400);
  }

  try {
    var raw = await geminiStreamGenerate(prompt, modelId, thinkMode, config, extraFields);
    var text = extractRequiredText(raw);

    // 构建 Google 格式的响应
    var response = {
      candidates: [{
        content: { parts: [{ text: text || '' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      }],
      usageMetadata: {
        promptTokenCount: estimateTokens(prompt),
        candidatesTokenCount: estimateTokens(text),
        totalTokenCount: estimateTokens(prompt + text),
      },
      modelVersion: modelName,
    };

    if (stream) {
      return new Response('data: ' + JSON.stringify(response) + '\n\n', {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return sendJSON(response);
  } catch (error) {
    return sendJSON({ error: { message: 'upstream error: ' + error.message } }, 502);
  }
}
