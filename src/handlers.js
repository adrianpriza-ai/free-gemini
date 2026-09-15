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
  googleContentsToPrompt,
} from './gemini.js';
import { geminiFetch, globalProxyState, refreshProxyPool } from './proxy.js';
import { sendJSON, sendSSE, resolveModel } from './http.js';

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
      var raw = await geminiStreamGenerate(prompt, modelId, thinkMode, config);

      // 提取并清理响应文本
      var text = extractResponseText(raw);
      var toolCalls = null;

      // 如果启用了工具，解析工具调用
      if (tools && text) {
        var parsed = parseToolCalls(text);
        text = parsed.cleanText;
        toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : null;
      }

      // 构建响应消息
      var msg = { role: 'assistant', content: text || null };
      if (toolCalls) {
        msg.tool_calls = toolCalls;
      }

      var finishReason = toolCalls ? 'tool_calls' : 'stop';

      // 如果要求流式但有工具调用，以单块 SSE 的方式返回
      if (stream) {
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
          var reqBody = buildPayload(prompt, modelId, thinkMode, config);
          var url = buildUrl(config);

          // 🎭 请求前随机延迟（与非流式保持一致）
          if (config.fingerprintJitterMs > 0) {
            var streamJitter = Math.random() * config.fingerprintJitterMs;
            await new Promise(function (resolve) { setTimeout(resolve, streamJitter); });
          }

          var response = null;
          var lastStreamError = null;

          // 重试循环（与非流式路径保持一致）
          for (var streamAttempt = 0; streamAttempt < config.retryAttempts; streamAttempt++) {
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
            var fetchController = new AbortController();
            var fetchTimeout = setTimeout(function () {
              fetchController.abort();  // 超时后中止 fetch 请求
            }, (config.requestTimeoutSec - 2) * 1000);

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
                log('流式请求异常，重试 ' + (streamAttempt + 1) + '/' + config.retryAttempts + ': ' + fetchErr.message, 'WARN', config);
                await new Promise(function (resolve) { setTimeout(resolve, fetchDelay); });
              }
            }
          }

          // 所有重试失败，抛出最后的错误
          if (!response) {
            throw lastStreamError || new Error('流式请求失败，所有重试已耗尽');
          }

          // -- 第四步：读取流式响应并实时转发增量数据
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';      // 行缓冲区（处理不完整的行）
          var prevText = '';    // 记录之前已发送的完整文本

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

          // -- 第五步：正常结束流
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
    var raw = await geminiStreamGenerate(prompt, modelId, thinkMode, config);
    var text = extractResponseText(raw);
    var toolCalls = null;

    // 解析工具调用
    if (tools && text) {
      var parsed = parseToolCalls(text);
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

  // 转换 Google 格式为提示文本
  var prompt = googleContentsToPrompt(body);
  if (!prompt.trim()) {
    return sendJSON({ error: { message: 'empty content' } }, 400);
  }

  try {
    var raw = await geminiStreamGenerate(prompt, modelId, thinkMode, config);
    var text = extractResponseText(raw);

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
