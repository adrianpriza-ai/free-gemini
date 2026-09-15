// 🚀 Deno Deploy 适配器 (Deno Deploy adapter)
//
// deno/deploy.js 是薄入口，加载 src/ 下的共享核心模块。
// deno/deploy.js is a thin entry that loads the shared core in src/.
//
// 运行环境 / Runtime:
//   - 新版 Deno Deploy (console.deno.com, Deno 2.x)：入口文件用 Deno.serve()
//     启动 HTTP 服务（旧版 Deploy Classic 已于 2026-07-20 停服）
//   - 本地开发：deno run --allow-net --allow-env deno/deploy.js
//
// 平台特性 / Platform traits:
//   - 提供原始 TCP socket（Deno.connect，经 deno/sockets.js 包装）→ 支持完整代理池
//   - Deno fetch 原生读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 静态出站代理
//   - Deploy 平台无响应头截止时间的硬限制（Deno.serve 流式输出无 502 截断），
//     保守设 55s 只约束非流式请求的响应头，防挂起兜底
//   - 默认关闭代理池（边缘网络可直连 gemini.google.com；ENABLE_PROXY=true 开启）

import {
  setPlatformConnect,
  setPreresponseDeadline,
  setProxyPoolDefaultEnabled,
} from '../src/platform.js';
import { connect } from './sockets.js';
import { handleRequestSafe as run, handleScheduled } from '../src/router.js';

// 注入平台能力（必须在加载业务模块前完成）
// Inject platform capabilities (must happen before the core modules are used).
setProxyPoolDefaultEnabled(false);
setPreresponseDeadline(55 * 1000);
setPlatformConnect(connect, 'Deno Deploy');

// 🚀 Deno.serve 处理器
// Deno.serve 不会因未捕获异常自动返回结构化 JSON（客户端只会看到连接重置或
// 空响应），handleRequestSafe 会把所有未处理异常转换为结构化的 500 JSON 响应。
export async function handler(request) {
  // Deno 不传 env 对象：环境变量经 mergePlatformEnv 从 Deno.env 全局读取。
  // Deno passes no env object; env vars are read from the global Deno.env.
  return run(request, null, null);
}

// 🚀 HTTP 服务入口（Deno Deploy 与本地开发共用）
// HTTP server entry, shared by Deno Deploy and local development.
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(handler);
}

// ⏰ 定时任务调度器（Deno Deploy 的 Cron 触发器会调用 handleScheduled）
// Scheduled trigger handler (invoked by Deno Deploy cron triggers).
export { handleScheduled };

// 与 api/gemini.js / netlify/shared-adapter.js 同一约定：默认导出 handler 函数，
// 附加 .scheduled 供跨环境复用（导出 { fetch } 对象会触发 Deno 的误判告警）。
// Same convention as api/gemini.js / netlify/shared-adapter.js: default-export
// the handler function with .scheduled attached (exporting a { fetch } object
// triggers Deno's "did you mean deno serve" warning).
handler.scheduled = handleScheduled;
export default handler;

// 在支持 Deno.cron 的环境（Deno Deploy；本地需 --unstable-cron）注册每日
// 代理池刷新。不支持的环境自动跳过，与 Cloudflare Workers 的 Cron Trigger
// (wrangler.jsonc "0 0 * * *") 行为对齐。
// Register a daily proxy-pool refresh where Deno.cron exists (Deno Deploy;
// locally requires --unstable-cron). Skipped elsewhere, mirroring the
// Cloudflare Workers Cron Trigger in wrangler.jsonc.
if (typeof Deno !== 'undefined' && typeof Deno.cron === 'function') {
  Deno.cron('refresh proxy pool', '0 0 * * *', function () {
    return handleScheduled({ cron: '0 0 * * *' }, null, null);
  });
}
