// 🌐 代理池系统
// 子请求预算、代理解析/TCP 隧道、连通性测试、池刷新与 geminiFetch 路由。
// Subrequest budget, proxy tunnels, pool refresh and geminiFetch routing.
// 依赖 src/platform.js 注入的 connect（Netlify/Vercel 上自动降级直连）。

import { connect } from './platform.js';
import { log } from './utils.js';

// 🌐 代理池系统 (ProxyScrape 自动获取 + 连通性测试 + 24小时自动更新)

// ============================================================
// 📊 Cloudflare Workers 子请求预算管理器
//
// 【为什么需要这个？】
// CF Workers 限制单次请求调用（invocation）最多发起约 50 个子请求
// （免费计划实测约 50 个，付费计划约 1000 个）。每个 fetch() 和每个
// TCP socket（connect()）都算一个子请求。
//
// 之前的冷启动路径会一次性测试多达 60 个代理 + 拉取代理源 + 真正的
// Gemini 请求，预算必然耗尽，剩余的 fetch() 直接抛出
// "Too many subrequests by single Worker invocation"。
//
// ============================================================
// 之前每批 6 个、最多测 60 个代理，加上拉源 fetch 和 Gemini 主请求本身，
// 预算必然耗尽，剩余的 fetch() 直接抛出
// "Too many subrequests by single Worker invocation"。
//
// 【预算分配策略】
//   代理池刷新（拉源+测试）上限: 32   ← 拉源 2 个 + 测试约 30 个 = 最多验证约 15 个
//   为 Gemini 主请求保留:       ≥18  ← 重试与直连降级永远有余量
//
// 超预算时的行为：不抛错、不中断，而是"未雨绸缪"——提前停止测试代理，
// 保证真正的业务请求（Gemini）永远有子请求额度可用。
// ============================================================
var SUBREQUEST_BUDGET = {
  // 每个请求调用允许的最大子请求数（保守估计免费计划约 50）
  perInvocationLimit: 50,
  // 代理池刷新（拉取源 + 连通性测试）的子请求上限
  proxyRefreshCap: 32,
  // 为 Gemini 主请求（含重试与直连降级）保留的子请求数
  mainRequestReserve: 18,
};

// ⏱️ 挂起防护超时（毫秒）
//
// 【为什么需要这些？】
// workerd 的全局 fetch() 与底层 socket read() 都没有默认超时：
//   - 代理源站点（或中间链路）不响应 → await fetch() 无限期挂起
//   - 死代理接受 TCP 连接后不回握手 → await reader.read() 无限期挂起
//   - 冷启动同步刷新代理池最坏要测 30+ 个代理 → 第一个请求可能等数十秒
// 任何一处不设超时，请求都会表现为"发出后永远没有回复"。
//
// 【可通过环境变量调优】（src/config.js 解析后放入 config.proxy，调用点优先读
// config，无值时回退到这里的默认值，保证单一事实来源）：
//   PROXY_SOURCE_FETCH_TIMEOUT_MS → config.proxy.sourceFetchTimeoutMs（默认 8000）
//   PROXY_HANDSHAKE_TIMEOUT_MS    → config.proxy.handshakeTimeoutMs（默认 6000）
//   PROXY_REFRESH_SYNC_MS         → config.proxy.refreshSyncMs（默认 8000）
var PROXY_SOURCE_FETCH_TIMEOUT_MS = 8000; // 拉取代理列表源的硬超时
var TUNNEL_HANDSHAKE_TIMEOUT_MS = 6000;   // 与代理建立 CONNECT/SOCKS 隧道的硬超时
var POOL_REFRESH_MAX_SYNC_MS = 8000;      // 冷启动同步等待代理池刷新的上限，超时转后台

/**
 * 读取挂起防护超时的默认值（src/config.js 构建 DEFAULT_CONFIG 时消费）
 * Read the hang-guard timeout defaults (consumed by src/config.js when
 * building DEFAULT_CONFIG, keeping a single source of truth in this module).
 *
 * @returns {Object} { sourceFetchMs, handshakeMs, refreshSyncMs }
 */
export function getProxyTimeoutDefaults() {
  return {
    sourceFetchMs: PROXY_SOURCE_FETCH_TIMEOUT_MS,
    handshakeMs: TUNNEL_HANDSHAKE_TIMEOUT_MS,
    refreshSyncMs: POOL_REFRESH_MAX_SYNC_MS,
  };
}

/**
 * 带硬超时的文本拉取（用于代理源列表等无外部超时保护的子请求）
 *
 * 用 AbortController 强制在 timeoutMs 内完成（含响应体读取），
 * 超时/失败/非 200 一律返回空字符串，由调用方决定是否走备用源。
 *
 * @param {string} url - 请求 URL
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<string>} 响应文本（失败/超时时为 ''）
 */
async function fetchTextWithTimeout(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    try { controller.abort(); } catch (e) {}
  }, timeoutMs || 10000);
  try {
    var res = await fetch(url, {
      headers: { 'User-Agent': 'curl/8.0.0' },
      signal: controller.signal,
    });
    if (!res.ok) return '';
    return await res.text();
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 建立到 gemini.google.com:443 的代理隧道（带握手硬超时）
 *
 * 死代理的典型行为：TCP 三次握手成功，但对 CONNECT/SOCKS 请求静默
 * 不回应 —— await reader.read() 会永远挂起。这里给整个握手过程
 * 包一层超时，超时即抛错，由上层轮换到下一个代理或降级直连。
 *
 * @param {Socket} socket - 已连接到代理的原始 TCP socket
 * @param {Object} proxy - 代理对象
 * @param {number} timeoutMs - 握手超时毫秒数
 */
async function establishTunnelWithTimeout(socket, proxy, timeoutMs) {
  var tunnelPromise;
  if (proxy.protocol === 'socks5') {
    tunnelPromise = establishSocks5Tunnel(socket, 'gemini.google.com', 443, proxy.auth);
  } else if (proxy.protocol === 'socks4') {
    tunnelPromise = establishSocks4Tunnel(socket, 'gemini.google.com', 443, proxy.auth);
  } else {
    tunnelPromise = establishHttpConnectTunnel(socket, 'gemini.google.com', 443, proxy.auth);
  }

  var timer = null;
  var timeoutPromise = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      reject(new Error('代理隧道握手超时 (' + timeoutMs + 'ms)，目标 ' + proxy.host + ':' + proxy.port));
    }, timeoutMs);
  });

  try {
    await Promise.race([tunnelPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 子请求预算状态（请求级）
 *
 * config 是每个请求独立的对象（getRequestConfig 创建），整个调用生命周期
 * 内贯穿所有函数，因此把计数器直接挂在 config 上即可精确关联到单次调用，
 * 无需 WeakMap。
 *
 * refreshBudget: 代理池刷新（拉源 + 测试）最多还能消耗多少个子请求
 * totalUsed:     本次调用累计已消耗的子请求数（含 Gemini 主请求）
 */
function getBudgetState(config) {
  if (!config._subrequestBudget) {
    config._subrequestBudget = { totalUsed: 0, refreshSpent: 0 };
  }
  return config._subrequestBudget;
}

/**
 * 记录一个即将/已经发出的子请求
 * @returns {boolean} 是否仍在代理刷新预算内
 */
function trackSubrequest(config, kind) {
  var b = getBudgetState(config);
  b.totalUsed += 1;
  if (kind === 'refresh') {
    b.refreshSpent += 1;
    return b.refreshSpent <= SUBREQUEST_BUDGET.proxyRefreshCap;
  }
  return true; // 主请求等非刷新子请求不受刷新预算约束，但仍计入总数用于观测
}

/**
 * 全局代理状态管理器（在 Isolate 存活期间常驻）
 */
export var globalProxyState = {
  proxies: [],            // 已验证可用代理列表 [{ raw, protocol, host, port, auth, latency, fails }]
  lastUpdated: 0,         // 上次更新时间戳 (ms)
  isUpdating: false,      // 防并发刷新互斥锁
  currentIndex: 0,        // 轮询计数器
  candidatesCache: null,  // 候选代理列表缓存 (Isolate 级,免费,避免重复打主/备源)
  candidatesCacheTime: 0, // 候选缓存时间戳 (ms)
};

/**
 * 解析代理字符串
 * 支持格式:
 * - http://ip:port 或 https://ip:port
 * - socks5://ip:port 或 socks4://ip:port
 * - 带认证: http://user:pass@ip:port
 * - 纯 ip:port（默认解析为 http）
 * 
 * @param {string} proxyStr - 原始代理字符串
 * @returns {Object|null} 解析后的代理对象
 */
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  var str = String(proxyStr).trim();
  if (!str) return null;

  var protocol = 'http';
  if (str.indexOf('socks5://') === 0) {
    protocol = 'socks5';
    str = str.substring(9);
  } else if (str.indexOf('socks4://') === 0) {
    protocol = 'socks4';
    str = str.substring(9);
  } else if (str.indexOf('http://') === 0) {
    protocol = 'http';
    str = str.substring(7);
  } else if (str.indexOf('https://') === 0) {
    protocol = 'https';
    str = str.substring(8);
  }

  var auth = null;
  var atIdx = str.indexOf('@');
  if (atIdx !== -1) {
    auth = str.substring(0, atIdx);
    str = str.substring(atIdx + 1);
  }

  // 移除尾部斜杠或路径
  var slashIdx = str.indexOf('/');
  if (slashIdx !== -1) {
    str = str.substring(0, slashIdx);
  }

  var colonIdx = str.lastIndexOf(':');
  if (colonIdx === -1) return null;

  var host = str.substring(0, colonIdx).trim();
  var port = parseInt(str.substring(colonIdx + 1).trim(), 10);
  if (!host || isNaN(port) || port <= 0 || port > 65535) return null;

  return {
    raw: proxyStr.trim(),
    protocol: protocol,
    host: host,
    port: port,
    auth: auth,
  };
}

/**
 * 缓冲区流读取器，用于解析底层 TCP Socket 字节流
 * 解决数据包分片与拆包粘包问题
 * 
 * @param {ReadableStreamDefaultReader} reader - 底层 reader
 */
function BufferedStreamReader(reader) {
  this.reader = reader;
  this.buffer = new Uint8Array(0);
}

BufferedStreamReader.prototype.readBytes = async function (n) {
  while (this.buffer.length < n) {
    var res = await this.reader.read();
    if (res.done) throw new Error('流已意外终止，未读满 ' + n + ' 字节');
    var next = new Uint8Array(this.buffer.length + res.value.length);
    next.set(this.buffer);
    next.set(res.value, this.buffer.length);
    this.buffer = next;
  }
  var result = this.buffer.subarray(0, n);
  this.buffer = this.buffer.subarray(n);
  return result;
};

BufferedStreamReader.prototype.readUntil = async function (delimiter) {
  var delimBytes = typeof delimiter === 'string' ? new TextEncoder().encode(delimiter) : delimiter;
  while (true) {
    var idx = this.indexOf(delimBytes);
    if (idx !== -1) {
      var found = this.buffer.subarray(0, idx + delimBytes.length);
      this.buffer = this.buffer.subarray(idx + delimBytes.length);
      return found;
    }
    var res = await this.reader.read();
    if (res.done) throw new Error('流已关闭，未匹配到分隔符');
    var next = new Uint8Array(this.buffer.length + res.value.length);
    next.set(this.buffer);
    next.set(res.value, this.buffer.length);
    this.buffer = next;
  }
};

BufferedStreamReader.prototype.indexOf = function (needle) {
  if (needle.length === 0 || this.buffer.length < needle.length) return -1;
  for (var i = 0; i <= this.buffer.length - needle.length; i++) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (this.buffer[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
};

BufferedStreamReader.prototype.getRemainingBuffer = function () {
  return this.buffer;
};

/**
 * 建立 HTTP CONNECT 隧道 (代理协议)
 */
async function establishHttpConnectTunnel(socket, targetHost, targetPort, auth) {
  var writer = socket.writable.getWriter();
  var reader = socket.readable.getReader();
  var bufReader = new BufferedStreamReader(reader);

  var connectReq = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\n' +
    'Host: ' + targetHost + ':' + targetPort + '\r\n' +
    'Proxy-Connection: Keep-Alive\r\n';
  if (auth) {
    connectReq += 'Proxy-Authorization: Basic ' + btoa(auth) + '\r\n';
  }
  connectReq += '\r\n';

  await writer.write(new TextEncoder().encode(connectReq));

  var headerBytes = await bufReader.readUntil('\r\n\r\n');
  var headerStr = new TextDecoder().decode(headerBytes);
  var statusLine = headerStr.split('\r\n')[0] || '';
  var statusMatch = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/i);
  if (!statusMatch || statusMatch[1] !== '200') {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error('HTTP CONNECT 握手失败: ' + statusLine);
  }

  var remaining = bufReader.getRemainingBuffer();
  writer.releaseLock();
  reader.releaseLock();
  return { remaining: remaining };
}

/**
 * 建立 SOCKS5 隧道
 */
async function establishSocks5Tunnel(socket, targetHost, targetPort, auth) {
  var writer = socket.writable.getWriter();
  var reader = socket.readable.getReader();
  var bufReader = new BufferedStreamReader(reader);

  var user = '';
  var pass = '';
  if (auth) {
    var colon = auth.indexOf(':');
    if (colon !== -1) {
      user = auth.substring(0, colon);
      pass = auth.substring(colon + 1);
    } else {
      user = auth;
    }
  }

  // 1. 认证协商: 0x00=无认证, 0x02=用户密码认证
  if (user && pass) {
    await writer.write(new Uint8Array([0x05, 0x02, 0x00, 0x02]));
  } else {
    await writer.write(new Uint8Array([0x05, 0x01, 0x00]));
  }

  var authReply = await bufReader.readBytes(2);
  if (authReply[0] !== 0x05) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error('无效的 SOCKS5 响应版本: ' + authReply[0]);
  }

  if (authReply[1] === 0x02) {
    // RFC 1929 用户名密码认证
    var userBytes = new TextEncoder().encode(user);
    var passBytes = new TextEncoder().encode(pass);
    var authBuf = new Uint8Array(3 + userBytes.length + passBytes.length);
    authBuf[0] = 0x01;
    authBuf[1] = userBytes.length;
    authBuf.set(userBytes, 2);
    authBuf[2 + userBytes.length] = passBytes.length;
    authBuf.set(passBytes, 3 + userBytes.length);
    await writer.write(authBuf);

    var authResult = await bufReader.readBytes(2);
    if (authResult[1] !== 0x00) {
      writer.releaseLock();
      reader.releaseLock();
      throw new Error('SOCKS5 用户名密码认证失败');
    }
  } else if (authReply[1] !== 0x00) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error('SOCKS5 认证方式被拒绝: ' + authReply[1]);
  }

  // 2. 发起 CONNECT 请求 (域名寻址 ATYP=0x03)
  var hostBytes = new TextEncoder().encode(targetHost);
  var req = new Uint8Array(4 + 1 + hostBytes.length + 2);
  req[0] = 0x05; // VER
  req[1] = 0x01; // CMD: CONNECT
  req[2] = 0x00; // RSV
  req[3] = 0x03; // ATYP: DOMAINNAME
  req[4] = hostBytes.length;
  req.set(hostBytes, 5);
  req[5 + hostBytes.length] = (targetPort >> 8) & 0xff;
  req[6 + hostBytes.length] = targetPort & 0xff;
  await writer.write(req);

  // 3. 读取连接响应
  var reply = await bufReader.readBytes(4);
  if (reply[0] !== 0x05) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error('SOCKS5 无效的连接应答: ' + reply[0]);
  }
  if (reply[1] !== 0x00) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error('SOCKS5 连接目标失败，状态码: ' + reply[1]);
  }

  // 读取并消耗绑定的地址和端口
  var atyp = reply[3];
  if (atyp === 0x01) {
    await bufReader.readBytes(4 + 2); // IPv4
  } else if (atyp === 0x03) {
    var dlen = await bufReader.readBytes(1);
    await bufReader.readBytes(dlen[0] + 2); // 域名 + 端口
  } else if (atyp === 0x04) {
    await bufReader.readBytes(16 + 2); // IPv6
  }

  var remaining = bufReader.getRemainingBuffer();
  writer.releaseLock();
  reader.releaseLock();
  return { remaining: remaining };
}

/**
 * 建立 SOCKS4a 隧道
 */
async function establishSocks4Tunnel(socket, targetHost, targetPort, auth) {
  var writer = socket.writable.getWriter();
  var reader = socket.readable.getReader();
  var bufReader = new BufferedStreamReader(reader);

  var hostBytes = new TextEncoder().encode(targetHost);
  var userBytes = auth ? new TextEncoder().encode(auth.split(':')[0]) : new Uint8Array(0);

  // SOCKS4a 数据包: VN(4) + CD(1) + DSTPORT(2) + DSTIP(4=0.0.0.1) + USERID + NULL + HOST + NULL
  var packet = new Uint8Array(9 + userBytes.length + hostBytes.length + 1);
  packet[0] = 0x04;
  packet[1] = 0x01;
  packet[2] = (targetPort >> 8) & 0xff;
  packet[3] = targetPort & 0xff;
  packet[4] = 0; packet[5] = 0; packet[6] = 0; packet[7] = 1; // SOCKS4a 标记
  packet.set(userBytes, 8);
  packet[8 + userBytes.length] = 0x00;
  packet.set(hostBytes, 9 + userBytes.length);
  packet[packet.length - 1] = 0x00;

  await writer.write(packet);

  var reply = await bufReader.readBytes(8);
  if (reply[1] !== 0x5a) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error('SOCKS4 连接被拒绝，应答码: ' + reply[1]);
  }

  var remaining = bufReader.getRemainingBuffer();
  writer.releaseLock();
  reader.releaseLock();
  return { remaining: remaining };
}

/**
 * 带空闲看门狗的读取器包装
 *
 * 问题：await reader.read() 会无限期挂起。如果代理在响应中途断流
 * （黑名单代理常见行为：TLS 握手成功、响应头正常，然后静默丢弃连接），
 * 客户端会永远收不到任何数据，表现为"请求卡死"。
 *
 * 解决：每次 read() 外包一层 race 超时。空闲超过 idleTimeoutMs 就抛出错误，
 * 由上层（geminiFetch 重试循环 / 直连降级）接管处理。
 *
 * @param {ReadableStreamDefaultReader} rawReader - 底层 socket reader
 * @param {Function|undefined} watchdogFn - 返回空闲超时毫秒数的回调（可选）
 * @returns {Promise<{done: boolean, value?: Uint8Array}>} 与 reader.read() 同构的结果
 */
async function readWithWatchdog(rawReader, watchdogFn) {
  if (typeof watchdogFn !== 'function') {
    return rawReader.read();
  }
  var idleTimeoutMs = watchdogFn();
  if (!idleTimeoutMs || idleTimeoutMs <= 0) {
    return rawReader.read();
  }
  var idleTimer = null;
  try {
    return await Promise.race([
      rawReader.read(),
      new Promise(function (_, reject) {
        idleTimer = setTimeout(function () {
          reject(new Error('代理响应流空闲超时 (' + idleTimeoutMs + 'ms)，可能已断流'));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/**
 * 创建 HTTP 分块传输解码流 (Chunked Transfer Decoder)
 * 支持打字机 SSE 流式实时解包
 */
function createChunkedDecoderStream(initialBuffer, rawReader, watchdogFn) {
  var buffer = initialBuffer ? new Uint8Array(initialBuffer) : new Uint8Array(0);
  var streamClosed = false;

  function appendBuffer(a, b) {
    var res = new Uint8Array(a.length + b.length);
    res.set(a);
    res.set(b, a.length);
    return res;
  }

  return new ReadableStream({
    async pull(controller) {
      if (streamClosed) {
        controller.close();
        return;
      }

      while (true) {
        var crlfIdx = -1;
        for (var i = 0; i < buffer.length - 1; i++) {
          if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
            crlfIdx = i;
            break;
          }
        }

        if (crlfIdx === -1) {
          var res = await readWithWatchdog(rawReader, watchdogFn);
          if (res.done) {
            streamClosed = true;
            if (buffer.length > 0) controller.enqueue(buffer);
            controller.close();
            return;
          }
          buffer = appendBuffer(buffer, res.value);
          continue;
        }

        var lineStr = new TextDecoder().decode(buffer.subarray(0, crlfIdx)).trim();
        var semiIdx = lineStr.indexOf(';');
        if (semiIdx !== -1) lineStr = lineStr.substring(0, semiIdx).trim();
        var chunkSize = parseInt(lineStr, 16);

        if (isNaN(chunkSize)) {
          streamClosed = true;
          if (buffer.length > 0) controller.enqueue(buffer);
          controller.close();
          return;
        }

        if (chunkSize === 0) {
          streamClosed = true;
          controller.close();
          return;
        }

        var totalNeeded = crlfIdx + 2 + chunkSize + 2;
        while (buffer.length < totalNeeded) {
          var more = await readWithWatchdog(rawReader, watchdogFn);
          if (more.done) {
            var partial = buffer.subarray(crlfIdx + 2);
            if (partial.length > 0) controller.enqueue(partial);
            streamClosed = true;
            controller.close();
            return;
          }
          buffer = appendBuffer(buffer, more.value);
        }

        var chunkData = buffer.subarray(crlfIdx + 2, crlfIdx + 2 + chunkSize);
        controller.enqueue(chunkData);
        buffer = buffer.subarray(totalNeeded);
        return;
      }
    },
    cancel() {
      streamClosed = true;
      try { rawReader.cancel(); } catch (e) {}
    }
  });
}

/**
 * 创建非分块传输原始解码流
 */
function createRawDecoderStream(initialBuffer, rawReader, contentLength, watchdogFn) {
  var buffer = initialBuffer ? new Uint8Array(initialBuffer) : new Uint8Array(0);
  var emitted = 0;
  var streamClosed = false;

  return new ReadableStream({
    async pull(controller) {
      if (streamClosed) {
        controller.close();
        return;
      }

      if (buffer.length > 0) {
        var toSend = buffer;
        if (contentLength !== null && emitted + toSend.length > contentLength) {
          toSend = toSend.subarray(0, contentLength - emitted);
          streamClosed = true;
        }
        emitted += toSend.length;
        buffer = new Uint8Array(0);
        controller.enqueue(toSend);
        if (contentLength !== null && emitted >= contentLength) {
          streamClosed = true;
          controller.close();
        }
        return;
      }

      var res = await readWithWatchdog(rawReader, watchdogFn);
      if (res.done) {
        streamClosed = true;
        controller.close();
        return;
      }
      var data = res.value;
      if (contentLength !== null && emitted + data.length > contentLength) {
        data = data.subarray(0, contentLength - emitted);
        streamClosed = true;
      }
      emitted += data.length;
      controller.enqueue(data);
      if (contentLength !== null && emitted >= contentLength) {
        streamClosed = true;
        controller.close();
      }
    },
    cancel() {
      streamClosed = true;
      try { rawReader.cancel(); } catch (e) {}
    }
  });
}

/**
 * 自动连通性测试单个代理
 * 真实建立到 gemini.google.com:443 的握手隧道，测试延迟并验证连通性
 * 
 * @param {Object} proxy - 代理对象
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<{ok: boolean, latency?: number, error?: string}>}
 */
async function testProxy(proxy, timeoutMs) {
  if (!connect) {
    return { ok: false, error: 'Raw TCP sockets not supported on this platform' };
  }
  timeoutMs = timeoutMs || 2000;
  var socket = null;
  var startTime = Date.now();
  var timer = null;

  try {
    var testPromise = (async function () {
      // 🔧 关键修复：secureTransport 必须为 'starttls'。
      // startTls() 只允许在 secureTransport='starttls' 的 socket 上调用，
      // 否则会抛出异常/挂起，导致代理测试永远失败。
      socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'starttls' });
      if (proxy.protocol === 'socks5') {
        await establishSocks5Tunnel(socket, 'gemini.google.com', 443, proxy.auth);
      } else if (proxy.protocol === 'socks4') {
        await establishSocks4Tunnel(socket, 'gemini.google.com', 443, proxy.auth);
      } else {
        await establishHttpConnectTunnel(socket, 'gemini.google.com', 443, proxy.auth);
      }
      return true;
    })();

    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('测试超时 (' + timeoutMs + 'ms)'));
      }, timeoutMs);
    });

    await Promise.race([testPromise, timeoutPromise]);
    clearTimeout(timer);
    var latency = Date.now() - startTime;
    try { socket.close(); } catch (e) {}
    return { ok: true, latency: latency };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (socket) {
      try { socket.close(); } catch (e) {}
    }
    return { ok: false, error: err.message };
  }
}

/**
 * 通过指定代理发送 HTTP 请求
 * 支持流式与非流式
 * 
 * @param {string} url - 目标 URL
 * @param {Object} options - fetch 选项 (method, headers, body, signal)
 * @param {Object} proxy - 代理对象
 * @param {Object} config - 配置对象
 * @returns {Promise<Response>} HTTP 响应对象
 */
async function fetchViaProxy(url, options, proxy, config) {
  if (!connect) {
    throw new Error('Raw TCP sockets not supported on this platform');
  }
  var socket = null;
  var tlsSocket = null;
  var timer = null;
  var socketClosed = false;
  var timeoutMs = (config.requestTimeoutSec || 28) * 1000;

  // 🔌 统一关闭底层连接（明文 socket + TLS socket）。
  // 必须在响应体读尽/取消后调用，否则每个请求都会在代理上留下一条
  // 半开连接，Isolate 很快就会积累大量泄漏的 socket。
  var closeAll = function () {
    if (socketClosed) return;
    socketClosed = true;
    try { if (tlsSocket) tlsSocket.close(); } catch (e) {}
    try { if (socket) socket.close(); } catch (e) {}
  };

  try {
    var run = async function () {
      // 🔧 关键修复：secureTransport 必须为 'starttls'（见 testProxy 内注释）。
      socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'starttls' });

      if (options.signal) {
        if (options.signal.aborted) {
          try { socket.close(); } catch (e) {}
          throw new Error('请求已取消');
        }
        options.signal.addEventListener('abort', function () {
          try { socket.close(); } catch (e) {}
        });
      }

      // 建立到 gemini.google.com:443 的隧道（带握手硬超时，防止死代理挂起；
      // PROXY_HANDSHAKE_TIMEOUT_MS 可调）
      await establishTunnelWithTimeout(
        socket,
        proxy,
        (config.proxy && config.proxy.handshakeTimeoutMs) || TUNNEL_HANDSHAKE_TIMEOUT_MS,
      );

      // 升级 TLS 会话
      // 🔧 修复：workerd 的 TlsOptions 只认 expectedServerHostname（servername 是 Node 风格的写法，
      // 会被静默忽略），显式指定 SNI 以便证书校验通过。
      tlsSocket = socket.startTls({ expectedServerHostname: 'gemini.google.com' });

      // 构建 HTTP/1.1 请求报文
      var urlObj = new URL(url);
      var pathAndQuery = urlObj.pathname + urlObj.search;
      var reqLines = [
        (options.method || 'POST') + ' ' + pathAndQuery + ' HTTP/1.1',
        'Host: ' + urlObj.host,
      ];

      var headers = options.headers || {};
      var entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
      for (var entry of entries) {
        var k = entry[0];
        var v = entry[1];
        if (k.toLowerCase() === 'host') continue;
        reqLines.push(k + ': ' + v);
      }

      var bodyBytes = null;
      if (options.body) {
        if (typeof options.body === 'string') {
          bodyBytes = new TextEncoder().encode(options.body);
        } else if (options.body instanceof Uint8Array) {
          bodyBytes = options.body;
        }
      }

      if (bodyBytes) {
        reqLines.push('Content-Length: ' + bodyBytes.length);
      }
      reqLines.push('Connection: close');
      reqLines.push('');
      reqLines.push('');

      var reqHeaderBytes = new TextEncoder().encode(reqLines.join('\r\n'));
      var writer = tlsSocket.writable.getWriter();
      if (bodyBytes) {
        var fullBytes = new Uint8Array(reqHeaderBytes.length + bodyBytes.length);
        fullBytes.set(reqHeaderBytes);
        fullBytes.set(bodyBytes, reqHeaderBytes.length);
        await writer.write(fullBytes);
      } else {
        await writer.write(reqHeaderBytes);
      }
      writer.releaseLock();

      // 读取响应
      var reader = tlsSocket.readable.getReader();
      var bufReader = new BufferedStreamReader(reader);

      var resHeaderBytes = await bufReader.readUntil('\r\n\r\n');
      var resHeaderStr = new TextDecoder().decode(resHeaderBytes);
      var lines = resHeaderStr.split('\r\n');
      var statusLine = lines[0] || '';
      var statusMatch = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)/i);
      var statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;
      var statusText = statusMatch ? statusMatch[2].trim() : 'OK';

      var respHeaders = new Headers();
      for (var i = 1; i < lines.length; i++) {
        var line = lines[i];
        if (!line.trim()) continue;
        var colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          respHeaders.append(line.substring(0, colonIdx).trim(), line.substring(colonIdx + 1).trim());
        }
      }

      var remaining = bufReader.getRemainingBuffer();
      var isChunked = (respHeaders.get('transfer-encoding') || '').toLowerCase().indexOf('chunked') !== -1;
      var clHeader = respHeaders.get('content-length');
      var contentLength = clHeader ? parseInt(clHeader, 10) : null;

      var bodyStream;
      // 空闲看门狗：流式转发期间如果代理长时间不再吐数据（断流/黑洞），
      // 抛错而不是永久挂起。取单次请求超时的 2 倍作为空闲上限。
      var idleWatchdog = function () {
        return (config.requestTimeoutSec || 28) * 1000 * 2;
      };
      if (isChunked) {
        bodyStream = createChunkedDecoderStream(remaining, reader, idleWatchdog);
      } else {
        bodyStream = createRawDecoderStream(remaining, reader, contentLength, idleWatchdog);
      }

      var contentEncoding = (respHeaders.get('content-encoding') || '').toLowerCase();
      if (contentEncoding === 'gzip' && typeof DecompressionStream !== 'undefined') {
        bodyStream = bodyStream.pipeThrough(new DecompressionStream('gzip'));
      } else if (contentEncoding === 'deflate' && typeof DecompressionStream !== 'undefined') {
        bodyStream = bodyStream.pipeThrough(new DecompressionStream('deflate'));
      }

      // 🔌 套接字生命周期：经管道转发到下游，pipeTo 在下游读尽或被取消时
      // 结束，届时关闭底层 socket。pipeTo 保留背压语义（下游不读则不拉），
      // 清理动作通过 waitUntil 挂到请求生命周期上，避免被提前回收。
      var downstream = new TransformStream();
      var pipePromise = bodyStream.pipeTo(downstream.writable);
      var onPipeSettled = function () { closeAll(); };
      pipePromise.then(onPipeSettled, onPipeSettled);
      if (config._ctx && typeof config._ctx.waitUntil === 'function') {
        config._ctx.waitUntil(pipePromise.catch(function () {}));
      }

      return new Response(downstream.readable, {
        status: statusCode,
        statusText: statusText,
        headers: respHeaders,
      });
    };

    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('代理请求超时 (' + timeoutMs + 'ms)'));
      }, timeoutMs);
    });

    var resp = await Promise.race([run(), timeoutPromise]);
    clearTimeout(timer);
    return resp;
  } catch (err) {
    if (timer) clearTimeout(timer);
    closeAll();
    throw err;
  }
}

/**
 * 获取候选代理列表（从源 URL 与静态配置中拉取）
 */
async function fetchProxyCandidates(config, force) {
  // Isolate 级候选缓存:在 updateInterval 周期内复用上次结果,避免反复打主/备源消耗 Worker 子请求配额
  var cacheTtlMs = (config.proxy && config.proxy.updateIntervalHours ? config.proxy.updateIntervalHours : 24) * 3600 * 1000;
  if (!force && globalProxyState.candidatesCache && (Date.now() - globalProxyState.candidatesCacheTime) < cacheTtlMs) {
    log('复用代理候选缓存 (剩余 ' + Math.round((cacheTtlMs - (Date.now() - globalProxyState.candidatesCacheTime)) / 1000) + 's),size=' + globalProxyState.candidatesCache.length, 'INFO', config);
    return globalProxyState.candidatesCache.slice();
  }

  var proxies = [];
  var seen = new Set();

  // 1. 用户自定义固定静态代理（零子请求成本，不计入预算）
  if (config.proxy && config.proxy.staticProxies && config.proxy.staticProxies.length > 0) {
    for (var sp of config.proxy.staticProxies) {
      var parsed = parseProxy(sp);
      if (parsed) {
        var key = parsed.host + ':' + parsed.port;
        if (!seen.has(key)) {
          seen.add(key);
          proxies.push(parsed);
        }
      }
    }
  }

  // 2. 从主代理源拉取 (ProxyScrape 200ms timeout API)
  // 📊 每次上游拉取计为 1 个刷新子请求
  // ⏱️ 带硬超时（PROXY_SOURCE_FETCH_TIMEOUT_MS 可调）：源站不响应时决不能拖住整个请求
  var sourceFetchTimeoutMs = (config.proxy && config.proxy.sourceFetchTimeoutMs) || PROXY_SOURCE_FETCH_TIMEOUT_MS;
  var fetchedText = '';
  if (config.proxy && config.proxy.sourceUrl) {
    trackSubrequest(config, 'refresh');
    fetchedText = await fetchTextWithTimeout(config.proxy.sourceUrl, sourceFetchTimeoutMs);
    if (!fetchedText) {
      log('获取主代理源失败（超时 ' + sourceFetchTimeoutMs + 'ms 或非 200），尝试备用源...', 'WARN', config);
    }
  }

  // 3. 若主代理源为空，拉取备用源 (GitHub raw 完整列表)
  if (!fetchedText.trim() && config.proxy && config.proxy.fallbackSourceUrl) {
    trackSubrequest(config, 'refresh');
    fetchedText = await fetchTextWithTimeout(config.proxy.fallbackSourceUrl, sourceFetchTimeoutMs);
    if (!fetchedText) {
      log('获取备用代理源失败（超时或非 200）', 'WARN', config);
    }
  }

  // 解析并去重
  if (fetchedText) {
    var lines = fetchedText.split('\n');
    for (var line of lines) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      var p = parseProxy(trimmed);
      if (p) {
        var pkey = p.host + ':' + p.port;
        if (!seen.has(pkey)) {
          seen.add(pkey);
          proxies.push(p);
        }
      }
    }
  }

  // 仅当本次拉取到候选代理时才更新缓存,空结果不污染缓存(避免主源偶尔失败时锁定空池)
  if (proxies.length > 0) {
    globalProxyState.candidatesCache = proxies.slice();
    globalProxyState.candidatesCacheTime = Date.now();
  }

  return proxies;
}

/**
 * 刷新代理池：获取、测试、排序并持久化（支持 24 小时更新）
 * 
 * @param {Object} config - 配置对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - 上下文
 * @param {boolean} force - 是否强制刷新（忽略缓存）
 * @returns {Promise<Array>} 刷新后的可用代理列表
 */
export async function refreshProxyPool(config, env, ctx, force) {
  if (globalProxyState.isUpdating) {
    return globalProxyState.proxies;
  }
  globalProxyState.isUpdating = true;

  try {
    var kv = env ? (env.PROXY_KV || env.PROXIES_KV || null) : null;

    // 非强制刷新时尝试从 KV 缓存加载
    if (kv && !force) {
      try {
        var cachedData = await kv.get('active_proxies', 'json');
        var cachedTime = await kv.get('active_proxies_time');
        var age = cachedTime ? (Date.now() - parseInt(cachedTime, 10)) : Infinity;
        var maxAge = (config.proxy.updateIntervalHours || 24) * 3600 * 1000;
        if (cachedData && Array.isArray(cachedData) && cachedData.length > 0 && age < maxAge) {
          globalProxyState.proxies = cachedData;
          globalProxyState.lastUpdated = parseInt(cachedTime, 10);
          log('从 KV 缓存加载 ' + cachedData.length + ' 个已验证代理', 'INFO', config);
          globalProxyState.isUpdating = false;
          return globalProxyState.proxies;
        }
      } catch (kvErr) {
        log('读取代理 KV 缓存失败: ' + kvErr.message, 'WARN', config);
      }
    }

    log('正在获取并更新代理池...', 'INFO', config);
    var candidates = await fetchProxyCandidates(config, force);
    log('共获取到 ' + candidates.length + ' 个候选代理', 'INFO', config);

    if (candidates.length === 0) {
      log('未能获取到任何候选代理', 'WARN', config);
      globalProxyState.isUpdating = false;
      return globalProxyState.proxies;
    }

    // 自动测试连通性
    if (config.proxy && config.proxy.autoTest) {
      var verified = [];
      var batchSize = 6;
      var maxPool = config.proxy.maxPoolSize || 12;
      var testTimeout = config.proxy.testTimeoutMs || 1000;

      // 限制测试候选数量，防止超量消耗 Worker 资源
      var toTest = candidates.slice(0, Math.min(candidates.length, maxPool * 2));

      // 📊 预算状态：刷新子请求（拉源 fetch + 每个代理测试的 connect()）共享一个上限，
      // 且整个调用有硬上限。触及任一上限即停止测试，把子请求额度留给真正的 Gemini 请求。
      var refreshSpent = 0;
      var budgetState = getBudgetState(config);

      for (var i = 0; i < toTest.length && verified.length < maxPool; i += batchSize) {
        // 预算检查（按批次粒度）：刷新预算耗尽，或整个调用的子请求总数逼近平台硬上限时停止
        if (refreshSpent + batchSize > SUBREQUEST_BUDGET.proxyRefreshCap ||
            budgetState.totalUsed + batchSize > SUBREQUEST_BUDGET.perInvocationLimit - SUBREQUEST_BUDGET.mainRequestReserve) {
          log('子请求预算已耗尽（刷新已用 ' + refreshSpent + '，调用总计 ' + budgetState.totalUsed + '），提前停止代理测试以保住 Gemini 请求额度', 'WARN', config);
          break;
        }

        var batch = toTest.slice(i, i + batchSize);
        // 每个代理测试各消耗 1 个子请求（connect()），按批记账
        refreshSpent += batch.length;
        budgetState.refreshSpent = refreshSpent;
        budgetState.totalUsed += batch.length;
        var testResults = await Promise.allSettled(batch.map(function (c) {
          return testProxy(c, testTimeout).then(function (res) {
            return { candidate: c, result: res };
          });
        }));

        for (var tr of testResults) {
          if (tr.status === 'fulfilled' && tr.value.result.ok) {
            var cand = tr.value.candidate;
            cand.latency = tr.value.result.latency;
            cand.fails = 0;
            verified.push(cand);
          }
        }
      }

      // 按延迟从低到高升序排列（优选低延迟代理）
      verified.sort(function (a, b) { return a.latency - b.latency; });
      globalProxyState.proxies = verified;
      log('代理测试完成，有效代理数量: ' + verified.length, 'INFO', config);
    } else {
      globalProxyState.proxies = candidates.slice(0, config.proxy.maxPoolSize || 12).map(function (c) {
        c.latency = 0;
        c.fails = 0;
        return c;
      });
      log('已加载 ' + globalProxyState.proxies.length + ' 个代理（未开启预测试）', 'INFO', config);
    }

    globalProxyState.lastUpdated = Date.now();

    // 持久化到 Cloudflare KV
    if (kv && globalProxyState.proxies.length > 0) {
      try {
        var ttl = (config.proxy.updateIntervalHours || 24) * 3600 * 2;
        await kv.put('active_proxies', JSON.stringify(globalProxyState.proxies), { expirationTtl: ttl });
        await kv.put('active_proxies_time', String(globalProxyState.lastUpdated), { expirationTtl: ttl });
      } catch (kvPutErr) {
        log('写入代理 KV 失败: ' + kvPutErr.message, 'WARN', config);
      }
    }
  } catch (err) {
    log('刷新代理池失败: ' + err.message, 'ERROR', config);
  } finally {
    globalProxyState.isUpdating = false;
  }

  return globalProxyState.proxies;
}

/**
 * 确保代理池就绪或在 24 小时到期时触发静默后台刷新
 */
async function ensureProxyReady(config) {
  if (!config.proxy || !config.proxy.enabled) return;
  var now = Date.now();
  var intervalMs = (config.proxy.updateIntervalHours || 24) * 3600 * 1000;

  // 冷启动且代理池为空：同步初始化，但设置严格上限
  //
  // 【修复"请求挂起"】冷启动刷新最坏要拉取源 + 分批测试 30+ 个代理，
  // 可能耗时数十秒；无限等待会让第一个请求永远得不到回复。
  // 同步等待 refreshSyncMs（PROXY_REFRESH_SYNC_MS 可调）后：
  //   - 刷新转由 waitUntil 后台继续（结果写入 Isolate 级/KV 缓存）
  //   - 本次请求立即放行 → geminiFetch 走 fallbackDirect 直连
  if (globalProxyState.proxies.length === 0 && !globalProxyState.isUpdating) {
    var maxSyncMs = (config.proxy && config.proxy.refreshSyncMs) || POOL_REFRESH_MAX_SYNC_MS;
    var refreshTask = refreshProxyPool(config, config._env, config._ctx, false);
    var timerId = null;
    var guard = new Promise(function (resolve) {
      timerId = setTimeout(function () { resolve('timeout'); }, maxSyncMs);
    });
    var outcome = await Promise.race([
      refreshTask.then(function () { return 'done'; }),
      guard,
    ]);
    if (timerId) clearTimeout(timerId);
    if (outcome === 'timeout') {
      log('冷启动代理池刷新超时（' + maxSyncMs + 'ms），转后台继续，本次请求降级直连', 'WARN', config);
      if (config._ctx && typeof config._ctx.waitUntil === 'function') {
        config._ctx.waitUntil(refreshTask.catch(function () {}));
      }
    }
    return;
  }

  // 超过 24 小时更新间隔，后台异步触发刷新
  if (now - globalProxyState.lastUpdated >= intervalMs && !globalProxyState.isUpdating) {
    var task = refreshProxyPool(config, config._env, config._ctx, true);
    if (config._ctx && typeof config._ctx.waitUntil === 'function') {
      config._ctx.waitUntil(task);
    }
  }
}

/**
 * 统一出站请求包装器 (geminiFetch)
 * 具备自动代理路由、多代理故障轮换与降级回退直连功能
 * 
 * @param {string} url - 请求 URL
 * @param {Object} options - 请求选项
 * @param {Object} config - 配置对象
 * @returns {Promise<Response>}
 */
export async function geminiFetch(url, options, config) {
  // 未开启代理或当前平台不支持 TCP Sockets 时，直接使用标准直连 fetch
  if (!config.proxy || !config.proxy.enabled || !connect) {
    trackSubrequest(config, 'main');
    return fetch(url, options);
  }

  try {
    await ensureProxyReady(config);
  } catch (initErr) {
    log('代理池初始化异常: ' + initErr.message, 'WARN', config);
  }

  var usableProxies = globalProxyState.proxies;
  var budgetState = getBudgetState(config);

  // 📊 无代理时优先走直连（计 1 个子请求）
  if (!usableProxies || usableProxies.length === 0) {
    if (config.proxy.fallbackDirect) {
      log('代理池暂无可用代理，自动降级回退到直连', 'WARN', config);
      trackSubrequest(config, 'main');
      return fetch(url, options);
    }
    throw new Error('代理池无可用代理且 fallbackDirect 已禁用');
  }

  var maxTries = Math.min(3, usableProxies.length);
  var lastError = null;

  for (var i = 0; i < maxTries; i++) {
    var proxy;
    var mode = config.proxy.rotationMode;
    var n = usableProxies.length;

    if (n === 0) {
      break;
    }

    // 评分函数: reliability(失败冷却) × (1 / (延迟 + ε))
    // - 延迟为 0/undefined 时回退到 1000ms,避免除零
    // - 每次失败把可靠性折半,成功后重置,代理可恢复
    var scoreOf = function (p) {
      var lat = (typeof p.latency === 'number' && p.latency > 0) ? p.latency : 1000;
      var fails = p.fails || 0;
      var reliability = fails === 0 ? 1 : Math.pow(0.5, fails);
      return reliability / (lat + 1);
    };

    if (mode === 'random') {
      // 纯均匀随机 — 调试或对照基线
      proxy = usableProxies[Math.floor(Math.random() * n)];
    } else if (mode === 'round-robin') {
      // 真正的顺序轮询,代理列表收缩时通过取模自适应
      var ci = globalProxyState.currentIndex % n;
      proxy = usableProxies[ci];
      globalProxyState.currentIndex = (ci + 1) % n;
    } else if (mode === 'weighted') {
      // 反向延迟加权轮盘赌,带 10% 探索底量 (兼容旧 "Smart Round Robin")
      // 探索底量保证最慢代理也会被周期性探活
      var EXPLORE = 0.1;
      var totalW = EXPLORE * n;
      for (var s = 0; s < n; s++) totalW += scoreOf(usableProxies[s]);
      var rw = Math.random() * totalW;
      var cumW = 0;
      var pickedW = n - 1;
      for (var s2 = 0; s2 < n; s2++) {
        cumW += scoreOf(usableProxies[s2]) + EXPLORE;
        if (rw < cumW) { pickedW = s2; break; }
      }
      proxy = usableProxies[pickedW];
      globalProxyState.currentIndex = (pickedW + 1) % n;
    } else {
      // 'best-of-2' (默认): 二次幂选择 — 抽 2 个不同的代理,选评分高的
      // O(1),天然避免轮盘赌把流量集中到单代理,近乎最优
      var a = Math.floor(Math.random() * n);
      var b = Math.floor(Math.random() * n);
      if (b === a) b = (a + 1) % n;
      proxy = scoreOf(usableProxies[a]) >= scoreOf(usableProxies[b])
        ? usableProxies[a]
        : usableProxies[b];
      globalProxyState.currentIndex = (usableProxies.indexOf(proxy) + 1) % n;
    }

    // 📊 平台子请求硬上限保护：直连降级（1 个）+ 已用数不能逼近平台限制，
    // 否则干脆跳过代理尝试，直接降级，避免耗尽后连直连都发不出去
    var remainingBeforeProxy = SUBREQUEST_BUDGET.perInvocationLimit - SUBREQUEST_BUDGET.mainRequestReserve - budgetState.totalUsed;
    if (remainingBeforeProxy < 2 && config.proxy.fallbackDirect) {
      log('子请求预算接近平台上限（已用 ' + budgetState.totalUsed + '），跳过代理尝试，直接降级直连', 'WARN', config);
      trackSubrequest(config, 'main');
      return fetch(url, options);
    }

    try {
      log('通过代理 [' + proxy.protocol + '://' + proxy.host + ':' + proxy.port + '] 发送请求', 'INFO', config);
      budgetState.totalUsed += 1; // 每次代理尝试消耗 1 个子请求（connect()）
      var t0 = Date.now();
      var resp = await fetchViaProxy(url, options, proxy, config);
      // EWMA 延迟更新: α=0.3,新样本足以追踪变化,又不会被单次抖动主导
      // 成功后清零失败计数,代理可完全恢复
      var sample = Date.now() - t0;
      proxy.latency = proxy.latency > 0
        ? Math.round(proxy.latency * 0.7 + sample * 0.3)
        : sample;
      proxy.fails = 0;
      return resp;
    } catch (err) {
      log('代理请求失败 [' + proxy.protocol + '://' + proxy.host + ':' + proxy.port + ']: ' + err.message, 'WARN', config);
      lastError = err;
      proxy.fails = (proxy.fails || 0) + 1;
      if (proxy.fails >= 2) {
        globalProxyState.proxies = globalProxyState.proxies.filter(function (p) {
          return p !== proxy;
        });
      }
    }
  }

  if (config.proxy.fallbackDirect) {
    log('所有代理尝试失败，自动降级回退到直连: ' + (lastError ? lastError.message : ''), 'WARN', config);
    trackSubrequest(config, 'main');
    return fetch(url, options);
  }

  throw lastError || new Error('所有可用代理连接均失败');
}
