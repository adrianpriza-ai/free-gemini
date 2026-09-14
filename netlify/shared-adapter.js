// 🚀 Netlify 共享适配器 (Shared Netlify adapter)
//
// netlify/functions/gemini.js 与 netlify/edge-functions/gemini.js 是两个完全
// 相同的薄入口，共同加载 src/ 下的共享核心模块。
// netlify/functions/gemini.js and netlify/edge-functions/gemini.js are two
// identical thin entries that load the shared core in src/.
//
// 平台特性 / Platform traits:
//   - 无原始 TCP socket（connect = null）→ 代理池自动降级为直连
//   - Deno fetch 原生读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 静态出站代理
//   - 非流式请求响应头截止时间 30s（Netlify Edge 40s 平台限制预留余量）
//   - 默认关闭代理池（边缘网络可直连 gemini.google.com）

import {
  setPlatformConnect,
  setPreresponseDeadline,
  setProxyPoolDefaultEnabled,
} from '../src/platform.js';
import { handleRequestSafe as run, handleScheduled } from '../src/router.js';

// 注入平台能力（必须在加载业务模块前完成）
// Inject platform capabilities (must happen before the core modules are used).
setProxyPoolDefaultEnabled(false);
setPreresponseDeadline(30 * 1000);
setPlatformConnect(null, 'Netlify Edge Functions');

// 🚀 导出 Netlify 标准处理器
// Netlify 对未捕获异常会返回通用的 "Error - Request ID: ..." 错误页（非 JSON），
// handleRequestSafe 会把所有未处理异常转换为结构化的 500 JSON 响应。
export default async function handler(request, context) {
  return run(request, null, context);
}

// 附加 fetch 属性，使其在 Cloudflare Workers 等环境也能直接运行
handler.fetch = async function fetch(request, env, ctx) {
  return run(request, env, ctx);
};

// 定时任务调度器（在支持的环境下可用）
handler.scheduled = handleScheduled;

// Netlify 路由配置：全路径拦截
export const config = {
  path: '/*',
};
