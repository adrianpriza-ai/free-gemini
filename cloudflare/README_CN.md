# Gemini Web2API - Cloudflare Workers 部署文档

[English](README.md) | ⚡ **[快速部署指南（SETUP.md）](SETUP.md)**（约 5 分钟，从零到部署完成）

> 🚀 **第一次使用？** 跟随 [快速部署指南](SETUP.md)：Cookie 获取 → KV 创建 → 密钥配置 → 部署 → 验证 → 第一次请求。

## 📖 项目简介

Gemini Web2API 是一个部署在 Cloudflare Workers 上的无服务器代理服务，将 Google Gemini 的 Web 界面转换为 OpenAI 兼容的 API 接口。无需服务器、无需 API Key（可选），开箱即用。

### 核心特性

- **零成本部署**：基于 Cloudflare Workers 免费计划（每日 10 万次请求）
- **全球加速**：自动部署到 Cloudflare 全球 300+ 边缘节点
- **OpenAI 兼容**：完全兼容 `/v1/chat/completions` 和 `/v1/models` 端点
- **打字机流式输出**：真正的 SSE（Server-Sent Events）流式响应
- **多指纹轮换**：8 种浏览器指纹 + 6 种语言偏好随机轮换，降低被识别概率
- **多 Cookie 轮换**：支持配置多个 Google 账号 Cookie，随机选择使用
- **并发安全**：请求级配置隔离，彻底消除高并发场景下的配置串扰
- **工具调用支持**：兼容 OpenAI Function Calling 格式
- **ProxyScrape 自动代理池**：自动拉取 ProxyScrape 免费代理（默认 <=200ms 低延迟 API 或 GitHub 完整源），支持通过 `cloudflare:sockets` 自动连通性测试（HTTP CONNECT、SOCKS5、SOCKS4）。采用 **best-of-2 评分选路**，最快代理获得最高选中概率，慢速代理仍周期性健康检测；每 24 小时自动静默刷新（Cron 定时触发与请求后台更新），候选列表按 Isolate 内存缓存（免费）避免重复打源，失败时自动故障转移并直连兜底。

### 适用场景

- 为 NextChat、Cherry Studio、ChatBox 等客户端提供免费的 Gemini API
- 在 WorkBuddy 等工具中作为 Gemini 模型的后端
- 个人学习、研究和小型项目的 AI 能力接入

---

## 🚀 快速部署

### 第一步：登录 Cloudflare

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 登录你的 Cloudflare 账号（没有账号可以免费注册）
3. 进入左侧菜单 **Workers & Pages**

### 第二步：创建 Worker

1. 点击 **创建应用程序** → **创建 Worker**
2. 给 Worker 起一个名字（例如 `api`）
3. 点击 **部署** 按钮
4. 点击 **编辑代码** 按钮
5. 清空编辑器中的默认代码
6. 将本项目完整代码粘贴到编辑器中
7. 点击右上角 **保存并部署**

### 第三步：获取测试地址

部署成功后，你的 API 地址为：

```
https://你的worker名称.你的账户名.workers.dev
```

例如：`https://api.geminai.workers.dev`

### 第四步：验证部署

在浏览器中访问以下地址：

```
https://你的worker.workers.dev/health
```

如果看到类似以下 JSON 响应，说明部署成功：

```json
{
  "status": "ok",
  "version": "1.7.3-cf-autoproxy",
  "platform": "Cloudflare Workers",
  "models": ["gemini-3.6-flash", "gemini-3.5-flash", "..."],
  "hasCookie": false,
  "hasSapisid": false
}
```

---

## 🔧 客户端配置

### NextChat (ChatGPT-Next-Web)

| 配置项 | 值 |
|-|-|
| 接口类型 | OpenAI |
| 接口地址 | `https://你的worker.workers.dev/v1` |
| API Key | `sk-gemini`（默认密钥） |
| 模型 | `gemini-3.6-flash` |

### Cherry Studio

| 配置项 | 值 |
|-|-|
| API 地址 | `https://你的worker.workers.dev/v1` |
| API 密钥 | `sk-gemini` |
| 模型 | `gemini-3.6-flash` |

### ChatBox

| 配置项 | 值 |
|-|-|
| API 模式 | OpenAI API |
| API 域名 | `https://你的worker.workers.dev` |
| API 路径 | `/v1/chat/completions` |
| API Key | `sk-gemini` |

### 使用 curl 测试

```bash
# 非流式请求
curl https://你的worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'

# 流式请求（打字机效果）
curl -N https://你的worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gemini" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "讲个故事"}],
    "stream": true
  }'
```

---

## ⚙️ 环境变量配置（可选）

在 Cloudflare Dashboard → Workers → 你的 Worker → 设置 → 变量 → 环境变量中配置：

### 认证相关

| 变量名 | 说明 | 示例值 |
|-|-|-|
| `COOKIE_STRING` | Gemini Cookie，多个用 `\|` 分隔 | `cookie1\| cookie2\| cookie3` |
| `SAPISID` | SAPISID 值，多个用 `\|` 分隔 | `sapisid1\| sapisid2\| sapisid3` |
| `API_KEY` / `API_KEYS` | API 密钥，支持单个字符串、逗号/竖线分隔多密钥、或 JSON 数组 | `my-secret-key` 或 `key1, key2` 或 `["sk-gemini", "my-key"]` |

### Gemini 配置

| 变量名 | 说明 | 示例值 |
|-|-|-|
| `GEMINI_BL` | Gemini 构建标签（遇到 405 时更新） | `boq_assistant-bard-web-server_20260907.07_p0` |
| `DEFAULT_MODEL` | 默认模型 | `gemini-3.6-flash` |
| `AUTH_USER` | 多账户索引 | `0` |

### 性能调优

| 变量名 | 说明 | 默认值 |
|-|-|-|
| `RETRY_ATTEMPTS` | 重试次数 | `3` |
| `RETRY_DELAY_SEC` | 重试间隔（秒） | `2` |
| `REQUEST_TIMEOUT_SEC` | 请求超时（秒） | `28` |
| `FINGERPRINT_JITTER_MS` | 随机延迟最大值（毫秒） | `1500` |
| `RATE_LIMIT_MAX` | 速率限制最大请求数 | `3000` |
| `RATE_LIMIT_WINDOW` | 速率限制时间窗口（秒） | `60` |

### 🌐 代理池与 24 小时更新配置

| 变量名 | 说明 | 默认值 |
|-|-|-|
| `ENABLE_PROXY` | 是否启用代理轮换 | `true` |
| `PROXY_SOURCE_URL` | 主代理源 URL（ProxyScrape 200ms API） | `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=200` |
| `PROXY_FALLBACK_SOURCE_URL` | 备用代理源 URL（GitHub 完整源） | `https://raw.githubusercontent.com/ProxyScrape/free-proxy-list/refs/heads/main/proxies/all/data.txt` |
| `STATIC_PROXIES` / `PROXY_URL` | 自定义固定代理（逗号或换行分隔，如 `http://user:pass@ip:port`, `socks5://ip:port`） | 空 |
| `AUTO_TEST_PROXY` | 加入代理池前自动进行连通性测试 | `true` |
| `PROXY_TEST_TIMEOUT_MS` | 单个代理测试握手超时时间（毫秒） | `1000` |
| `PROXY_UPDATE_INTERVAL_HOURS` | 代理池自动更新周期（小时） | `24` |
| `PROXY_MAX_POOL_SIZE` | 代理池保留的最大可用代理数 | `12` |
| `PROXY_FALLBACK_DIRECT` | 代理全部失效时是否自动降级回退到直连 | `true` |
| `PROXY_ROTATION_MODE` | 代理选择算法 — 见下方 [代理轮询模式](#代理轮询模式) | `best-of-2` |

#### 代理轮询模式

通过 `PROXY_ROTATION_MODE` 环境变量指定代理选择算法。所有模式共用一套**自适应评分层**：每次成功请求会用 EWMA（α = 0.3）更新代理延迟，并把失败计数清零；代理变慢会在约 3 次请求后掉排名，恢复后也能自动回升。每次失败把 `fails` 加 1，使评分减半（指数冷却）；累计 2 次失败则从池中淘汰。

| 模式 | 选路规则 | 开销 | 适用场景 |
|---|---|---|---|
| `best-of-2` *(默认)* | 随机抽 2 个不同代理，返回评分高的那个 | O(1) | **生产环境** — 接近最优的负载均衡，天然避免轮盘赌把流量集中到单代理 |
| `round-robin` | 严格顺序遍历池，到尾回头 | O(1) | 想要绝对公平、不要质量信号 |
| `random` | 纯均匀随机，忽略延迟与失败 | O(1) | 调试 / 对照基线 |
| `weighted` | 反向延迟加权轮盘赌，带 10% 探索底量（最慢代理也会被周期性探活） | O(n) | 兼容旧版 "Smart Round Robin"；需要显式按概率分配流量时使用 |

**评分公式**（`best-of-2` 与 `weighted` 共用）：

```
score = reliability / (latency + 1)
reliability = 1           若 fails == 0
            = 0.5 ^ fails  否则
```

- 延迟缺失或非正时回退到 1000ms，因此 `latency=0`（关闭预测试时）的旧 `1/0 = Infinity` 崩溃已修复。
- `fails` 在首次成功时清零，代理一次成功即可完全恢复。

**示例：**

```bash
# 默认：二次幂选择
PROXY_ROTATION_MODE=best-of-2

# 严格顺序轮询，忽略质量
PROXY_ROTATION_MODE=round-robin

# 纯随机，用于 A/B 测试
PROXY_ROTATION_MODE=random

# 旧版反向延迟加权
PROXY_ROTATION_MODE=weighted
```

非法值会被忽略并输出 `WARN` 日志，Worker 继续使用默认值（`best-of-2`）。

#### 24 小时更新运行原理：
1. **Cloudflare Cron 定时任务（推荐）**：
   - 使用 Wrangler 部署时，`wrangler.jsonc` 已自动配置 `"triggers": { "crons": ["0 0 * * *"] }`。
   - 在 Cloudflare 控制台：进入 **Workers & Pages** → 你的 Worker → **Triggers**（触发器） → **Cron Triggers** → **Add Cron Trigger** → 填写 `0 0 * * *`（每天 UTC 00:00 自动触发）。
2. **按需后台更新**：
   - 即使未在控制台配置 Cron 定时器，Worker 在收到请求时也会比对时间戳。若距离上次更新已超过 24 小时，会自动使用 `ctx.waitUntil()` 在后台静默刷新代理池，完全不阻塞当前客户端请求！
3. **Cloudflare KV 持久化（配合 Cron 强烈推荐）**：
   - 为 Worker 绑定名为 `PROXY_KV` 的 KV 命名空间，测速通过的代理池将持久化保存，并在全球各边缘节点间共享，降低冷启动开销。
   - **这是让 Cron 定时任务真正生效的关键**：每日 Cron 刷新在独立调用中运行（拥有独立子请求预算），完成测速后把验证结果写入 KV —— 各隔离实例上的用户请求可直接从 KV 加载热池，无需再付出冷启动测试成本。
   - 配置方法：执行 `npx wrangler kv namespace create PROXY_KV`，然后把返回的命名空间 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces` 块（已有占位符）。
   - 不绑定 KV 时，Cron 刷新只能温暖 Cron 自身的临时隔离实例；各用户请求隔离实例仍需各自执行冷启动刷新。
4. **管理端点**（均需要有效的 API 密钥 —— 与 `/v1` 端点相同的认证方式）：
    - `GET /proxies`：查看当前代理池状态、存活代理列表、各节点延迟及下次更新时间。
    - `POST /proxies/refresh` 或 `GET /proxies/refresh`：强制立即重新拉取并测试代理池。
    - `GET /debug/proxies`：代理池详细诊断 —— 每个代理的健康状态（`healthy`/`flaky`）、延迟、失败计数、轮换评分（按评分降序排列）及内部状态（候选缓存、是否到期刷新、轮换模式）。
    - `GET /health`：健康检查响应中已包含代理运行状态。
5. **Isolate 级候选缓存（免费）**：
   - 解析后的候选代理列表会在 **当前 Worker Isolate 内存** 中缓存，TTL 与 `PROXY_UPDATE_INTERVAL_HOURS` 相同（默认 24 小时）。
   - 在一个刷新周期内重复刷新会直接复用缓存，完全跳过 ProxyScrape 与 GitHub raw 两次上游请求。
   - 手动调用 `/proxies/refresh` 时会强制绕过缓存（`force=true`），始终重新拉取。
   - 拉取结果为空时不会写入缓存，避免主源偶发失败时锁定空池。

---


## 🍪 获取 Gemini Cookie

### 为什么需要 Cookie？

匿名请求很快就会撞上 Gemini 的限流（HTTP 429）。配置有效的 Cookie 可以降低被限流的概率，并改善 Pro 模型的路由。

### 获取步骤

1. 打开 Chrome/Edge 浏览器
2. 访问 https://gemini.google.com/app 并登录 Google 账号
3. 按 **F12** 打开开发者工具
4. 进入 **Application**（应用程序）标签
5. 左侧选择 **Cookies** → `https://gemini.google.com`
6. 找到以下 Cookie 并复制其值：
   - `__Secure-1PSID`
   - `__Secure-3PSID`
   - `SAPISID`
7. 组合为完整 Cookie 字符串：
   ```
   __Secure-1PSID=你的值; __Secure-3PSID=你的值; SAPISID=你的值
   ```

### 多账号配置

如果你有多个 Google 账号，可以用 `|` 分隔多个 Cookie：

```
COOKIE_STRING = "cookie_账号1| cookie_账号2| cookie_账号3"
SAPISID = "sapisid_1| sapisid_2| sapisid_3"
```

每次请求会随机选择一个 Cookie 使用，大幅降低单个账号被限流的概率。

---

## 🔄 更新 BL 版本

如果遇到 `HTTP 405: Method Not Allowed` 错误，说明 Gemini 前端已更新，需要同步更新构建标签：

1. 浏览器打开 https://gemini.google.com/app
2. 按 **F12** → **Network**（网络）标签
3. 在任意请求的 URL 中搜索 `boq_assistant`
4. 复制最新的版本号，例如：
   ```
   boq_assistant-bard-web-server_20260730.02_p0
   ```
5. 更新环境变量 `GEMINI_BL` 或代码中的 `geminiBl` 配置项

---

## 🎭 多指纹轮换机制

本程序内置了浏览器指纹轮换系统，每次请求会随机选择不同的浏览器标识：

| 指纹类型 | 池大小 | 说明 |
|-|-|-|
| User-Agent | 8 种 | 加权随机，模拟真实浏览器市场份额 |
| Accept-Language | 6 种 | 均匀随机，模拟不同地区用户 |
| Sec-Ch-Ua | 3 种 | Chrome 版本标识（仅 Chrome UA 时添加） |
| 随机延迟 | 0-1500ms | 请求前添加随机延迟，模拟人类操作 |

---

## 🛡️ 安全建议

1. **修改默认 API Key**：将 `apiKeys` 中的 `sk-gemini` 改为你自己的密钥
2. **设置速率限制**：根据实际使用量调整 `RATE_LIMIT_MAX`
3. **定期更新 Cookie**：Google Cookie 会过期，需要定期更换
4. **不要分享 Cookie**：Cookie 等同于你的 Google 账号凭证

---

## ❓ 常见问题

### Q: 返回 `empty response from server`

**原因**：NextChat 流式解析问题。  
**解决**：确认使用的是最新版代码（已修复 SSE 格式）。

### Q: 返回 `HTTP 429: Too Many Requests`

**原因**：Gemini 限流，匿名请求频率限制更严格。  
**解决**：配置有效的 `COOKIE_STRING` 和 `SAPISID`。

### Q: 返回 `HTTP 405: Method Not Allowed`

**原因**：BL 版本过期。  
**解决**：更新 `geminiBl` 配置（参见上文「更新 BL 版本」章节）。

### Q: 返回 `invalid api key`

**原因**：客户端密钥配置错误。  
**解决**：检查客户端是否配置了正确的 API Key（默认 `sk-gemini`）。

### Q: WorkBuddy 中使用出现串扰

**原因**：多模型并发请求共享全局配置。  
**解决**：当前版本已通过请求级配置隔离解决此问题。

---

## 📊 支持模型列表

| 模型 ID | 类型 | 说明 |
|-|-|-|
| `gemini-3.8-flash` | FAST | 最新全能模型（Gemini 3.8 Flash） |
| `gemini-3.7-flash` | FAST | 最新全能模型（Gemini 3.7 Flash） |
| `gemini-3.6-flash` | FAST | 全能模型（Gemini 3.6 Flash） |
| `gemini-3.5-flash` | FAST | 3.6 Flash 的别名 |
| `gemini-3.5-flash-thinking` | THINKING | 深度思考模式 |
| `gemini-3.1-pro` | PRO | 专业版（需 Cookie） |
| `gemini-auto` | AUTO | 自动模型选择 |
| `gemini-3.5-flash-thinking-lite` | DYNAMIC | 自适应动态思考 |
| `gemini-flash-lite` | LITE | 轻量级快速模型 |
| `gemini-2.5-flash` | FAST | 客户端兼容别名（路由至 3.6 Flash） |
| `gemini-2.0-flash` | FAST | 客户端兼容别名（路由至 3.6 Flash） |
| `gemini-2.5-pro` | PRO | 客户端兼容别名（路由至 3.1 Pro） |

支持通过 `@think=` 参数覆盖思考模式：
- `gemini-3.6-flash@think=0` — Flash 模型 + 深度思考
- `gemini-3.1-pro@think=4` — Pro 模型 + 自动思考

---

## 📝 更新日志

| 版本 | 日期 | 更新内容 |
|-|-|-|
| 1.7.3 | 2026-09-11 | 默认 `PROXY_MAX_POOL_SIZE` 由 30 降至 12，冷启动代理池刷新消耗的子请求进一步减少（约 14 个，此前约 32 个） |
| 1.7.2 | 2026-09-11 | 修复 `Too many subrequests by single Worker invocation`：新增每次调用的子请求预算管理 —— 代理池刷新（拉源 + 测试）上限 32 个子请求，触顶即停，为 Gemini 主请求预留额度；代理尝试与直连降级均纳入预算追踪；修复 `startTls()` 从未生效的问题（`connect` 缺少 `secureTransport: 'starttls'`，导致所有代理请求永久挂起） |
| 1.7.1 | 2026-09-10 | 代理选择切换为 **Smart Round Robin 智能轮询**（按反向延迟加权）；`PROXY_TEST_TIMEOUT_MS` 默认值由 2000 调优为 1000；新增 Isolate 级候选代理缓存（TTL = 更新周期）避免重复打源 |
| 1.7.0 | 2026-09-10 | 新增 ProxyScrape 免费代理池自动抓取（默认 <=200ms API 与 GitHub 完整源）、基于 cloudflare:sockets 的代理连通性真实测试系统（HTTP CONNECT、SOCKS5、SOCKS4）、24 小时定时更新与 Cron 触发器支持（`0 0 * * *`）、故障自动轮换与直连降级兜底、新增 `/proxies` 与 `/proxies/refresh` 管理端点 |
| 1.6.0 | 2026-09-09 | 升级至 Chrome 132-134 指纹库、流式请求 429 自动指数退避重试、支持灵活的环境变量 `API_KEY`（字符串/逗号分隔/JSON）、新增 `gemini-3.7-flash` 及 2.0/2.5 兼容别名、健康检查返回详细状态 |
| 1.5.0 | 2026-07-31 | 新增多指纹轮换、多Cookie轮换、随机延迟机制 |
| 1.4.0 | 2026-07-30 | 修复并发串扰、速率限制内存安全 |
| 1.3.0 | 2026-07-29 | 修复 SSE 流式格式、NextChat 兼容性 |
| 1.0.0 | 2026-07-16 | 初始版本，基于 gemini-web2api v1.1.0 移植 |

---

## 📄 许可证

本项目基于原项目 [gemini-web2api](https://github.com/Sophomoresty/gemini-web2api) 移植，遵循原项目的开源协议。
