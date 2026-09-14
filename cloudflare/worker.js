// 🚀 Cloudflare Workers 适配器 (Cloudflare Workers adapter)
//
// cloudflare/worker.js 是薄入口，加载 src/ 下的共享核心模块。
// cloudflare/worker.js is a thin entry that loads the shared core in src/.
//
// 平台特性 / Platform traits:
//   - 提供原始 TCP socket（cloudflare:sockets 的 connect）→ 支持完整代理池
//   - 无响应头截止时间限制（0 = 禁用截止逻辑，流式/重试不受平台硬限）
//   - 默认开启代理池（ProxyScrape 自动获取 + 连通性测试 + 24h 刷新）

import { connect } from 'cloudflare:sockets';
import {
  setPlatformConnect,
  setPreresponseDeadline,
  setProxyPoolDefaultEnabled,
} from '../src/platform.js';
import { handleRequestSafe, handleScheduled } from '../src/router.js';

// 注入平台能力（必须在加载业务模块前完成）
// Inject platform capabilities (must happen before the core modules are used).
setProxyPoolDefaultEnabled(true);
setPreresponseDeadline(0); // CF Workers 无响应头截止限制 / no pre-response limit
setPlatformConnect(connect, 'Cloudflare Workers');

// 🚀 主入口 - Cloudflare Workers fetch 事件处理器
//
// 1. OPTIONS 预检 → 返回 CORS 头（浏览器跨域必须）
// 2. 创建请求级配置 → getRequestConfig(env, ctx)（解决并发串扰）
// 3. 速率限制检查 → checkRateLimit()（防滥用）
// 4. API 密钥验证 → checkApiKey()（安全认证）
// 5. 路由分发:
//    GET  /health              → 健康检查
//    GET  /v1/models           → 模型列表（OpenAI 格式）
//    GET  /v1beta/models       → 模型列表（Google 格式）
//    POST /v1/chat/completions → 聊天补全（OpenAI 格式）
//    POST /v1/responses        → Responses API（Codex CLI）
//    POST ...:generateContent  → 生成内容（Google 格式）
//    POST /v1/*                → 万能兜底（自动转为 chat）
export default {
  async fetch(request, env, ctx) {
    return handleRequestSafe(request, env, ctx);
  },

  /**
   * Cloudflare Workers 定时触发器（Cron Trigger）
   * 默认每 24 小时 (0 0 * * *) 自动触发一次，后台静默拉取并测试最新代理
   *
   * @param {Object} event - 定时事件元数据 (例如 event.cron)
   * @param {Object} env - 环境变量
   * @param {Object} ctx - 执行上下文 (ctx.waitUntil)
   */
  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  },
};
