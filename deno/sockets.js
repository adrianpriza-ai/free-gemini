// 🔌 Deno TCP 适配层 (Deno TCP socket adapter)
//
// src/proxy.js 的代理池针对 Cloudflare workerd 的 socket API 设计：
//   - connect(...) 同步返回 socket（secureTransport: 'starttls'）
//   - socket.startTls(...) 同步返回 TLS socket
//   - socket.readable / socket.writable / socket.close() 与 Web Streams 对齐
//
// Deno 的原生 API 与之有两处差异（本地 Deno 2.9 实测）：
//   1. Deno.connect() / Deno.startTls(conn) 是异步函数（返回 Promise<Conn>）
//   2. Conn 上没有 startTls 方法；TLS 升级要调用全局 Deno.startTls(conn, options)
//
// 本文件把 Deno.connect 包装成 workerd 风格的工厂：调用点统一 `await`
// connect(...) / await socket.startTls(...)（见 src/proxy.js），同步实现
// （Cloudflare）不受影响，异步实现（Deno）也能工作。
//
// The proxy pool in src/proxy.js targets Cloudflare workerd's socket API:
// sync connect() returning a socket with a sync startTls() method. Deno's
// APIs are async and upgrade TLS via the global Deno.startTls(conn) instead
// of a conn method. This wrapper adapts Deno.connect into the workerd-style
// factory; call sites in src/proxy.js uniformly await both, so the sync
// Cloudflare implementation is unaffected.
//
// 平台差异备注 / Platform notes (Deno Deploy):
//   - Deno Deploy 禁止对 443 端口的非 TLS 直连（TLS proxying 限制），代理池
//     连接的是代理服务器的非 443 端口，一般不受影响。
//   - outbound Proxy-CONNECT/SOCKS5 隧道在 Deploy 上未经官方测试，若受限，
//     可回退静态出站代理（Deno fetch 原生支持 HTTPS_PROXY）。

/**
 * 把 Deno.Conn 包装成 workerd 风格 socket。
 * Wrap a Deno.Conn in the workerd-style socket shape.
 *
 * @param {Deno.Conn} conn - Deno 原生 TCP 连接 / native Deno TCP connection
 * @returns {Object} { readable, writable, close(), startTls() }
 */
function wrapConn(conn) {
  return {
    readable: conn.readable,
    writable: conn.writable,
    close: function () {
      try { conn.close(); } catch (e) { /* 已关闭 / already closed */ }
    },
    /**
     * workerd 的 socket.startTls(options) → Deno.startTls(conn, options)。
     * 返回 Promise，调用点（src/proxy.js）统一 await。
     */
    startTls: function (options) {
      var tlsOptions = {};
      if (options && options.expectedServerHostname) {
        tlsOptions.hostname = options.expectedServerHostname;
      }
      return Deno.startTls(conn, tlsOptions).then(wrapConn);
    },
  };
}

/**
 * workerd 风格 connect 工厂（异步）。
 * workerd-style connect factory (async) for src/platform.js.
 *
 * @param {{ hostname: string, port: number }} addr - 目标地址 / target address
 * @param {{ secureTransport?: string }} [options] - 仅接受 'starttls'（代理池固定用法）
 * @returns {Promise<Object>} workerd 风格 socket
 */
export async function connect(addr, options) {
  if (options && options.secureTransport && options.secureTransport !== 'starttls') {
    throw new Error('deno/sockets.js 仅支持 secureTransport: \'starttls\'（代理池用法）/ only \'starttls\' is supported');
  }
  var conn = await Deno.connect({
    hostname: addr.hostname,
    port: addr.port,
  });
  return wrapConn(conn);
}
