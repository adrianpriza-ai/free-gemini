
# Gemini Web2API - Cloudflare Workers 完整并发安全修复版
 多指纹轮换 + 多Cookie轮换 + 打字机效果 + 随机延迟 + ProxyScrape 自动代理池与24h定时更新
 
 
## 项目说明
 
 本程序将 Google Gemini 的 Web 界面转换为 OpenAI 兼容的 API 接口。
 部署于 Cloudflare Workers 边缘计算平台，无需服务器即可运行。
 支持流式输出（SSE 打字机效果）、非流式输出、工具调用（Function Calling）。
 支持 ProxyScrape 免费代理池自动抓取、连通性自动测试、24小时定时更新及自动故障回退直连。
 
 
 核心功能列表:
 
 
 1. 【并发安全】彻底消除了全局 CONFIG 被异步请求并发篡改/串扰的严重隐患。
     根本原因：CF Workers 的 Isolate 在热启动（复用）时，全局作用域代码不会重新执行。
     当 WorkBuddy 等客户端在极短时间内发送多个并发请求时，
     它们会共享同一个全局 CONFIG 对象（因为复用同一个 Isolate）。
     请求 A 修改了 CONFIG.cookieString = "cookie_a"，
     请求 B 紧接着修改了 CONFIG.cookieString = "cookie_b"，
     请求 A 后续使用的却是 cookie_b，导致认证信息串扰。
     这在 WorkBuddy 的多模型并发调用场景下尤为严重。
     
     解决方案：
     每次请求通过 getRequestConfig(env) 创建全新的独立配置副本，
     所有函数通过参数接收配置对象，完全不依赖全局可变状态。
  
2. 【请求级配置隔离】实现了基于每次请求独立创建配置副本的机制。
    - DEFAULT_CONFIG 作为只读模板，永远不会被修改
    - getRequestConfig(env) 为每个请求创建独立的配置副本
    - 从 env（环境变量，每个请求由 CF 平台独立注入）加载定制配置
    - 所有函数签名都包含 config 参数，完全消除全局状态依赖
    - 使用显式赋值（env.X || null）防止 Isolate 复用时的值残留
 
 3. 【速率限制内存安全】修复全局 rateLimitStore 在 Serverless 环境下的隐式内存泄露问题。
    - Serverless 环境下 Isolate 可能长时间存活（热启动复用）
    - 如果不清理过期记录，Map 会无限增长导致内存泄漏
    - 使用随机概率清理机制（5% 概率触发全局清理）
    - 每次清理遍历所有键，删除过期或空的记录
    - 确保长期运行后内存使用保持稳定
 
 4. 【SAPISID 自动提取】增加了从 COOKIE_STRING 自动提取 SAPISID 的防御性逻辑。
    - 用户通常从浏览器复制完整 Cookie 字符串
    - Cookie 格式: "__Secure-1PSID=xxx; SAPISID=yyy; ..."
    - 如果用户设置了 COOKIE_STRING 但忘记单独设置 SAPISID
    - 程序会自动从 Cookie 字符串中正则提取 SAPISID 值
    - 正则表达式: /SAPISID=([^;]+)/
    - 提升用户体验，减少配置错误
 
 5. 【多指纹轮换】新增浏览器指纹轮换机制，降低被 Gemini 识别的概率。
    - User-Agent 轮换池（8 种真实浏览器 UA，涵盖 Windows/macOS/Linux）
    - Accept-Language 轮换池（6 种语言偏好设置）
    - Sec-Ch-Ua 轮换池（3 种 Chrome 版本标识）
    - Sec-Ch-Ua-Platform 轮换池（3 种操作系统平台）
    - 加权随机选择，模拟真实浏览器市场份额分布
    - Chrome ~72%（含 Windows/macOS/Linux）、Firefox ~8%、Safari ~8%
 
 6. 【多 Cookie 轮换】支持配置多个 Google 账号的 Cookie，随机选择使用。
    - 环境变量使用 | 分隔多个 Cookie: "cookie1| cookie2| cookie3"
    - 环境变量使用 | 分隔多个 SAPISID: "sapisid1| sapisid2| sapisid3"
    - 每次请求随机选择一个 Cookie 和对应的 SAPISID
    - 如果 SAPISID 数量与 Cookie 数量匹配，使用对应索引的 SAPISID
    - 大幅降低单个 Google 账号被限流（429）的概率
 
 7. 【随机延迟】请求前添加随机微小延迟，模拟人类操作间隔。
    - 延迟时间在 0 到 fingerprintJitterMs 之间随机（默认 1500ms）
    - 重试时也会添加新的随机延迟
    - 可配置：设置环境变量 FINGERPRINT_JITTER_MS=0 可禁用
    - 配合指纹轮换使用效果更佳
 
 8. 【SSE 打字机效果】OPTIONS 预检优先处理、实时增量输出、心跳保活。
    SSE 格式严格符合 OpenAI 标准：
    - 首块: delta: { role: 'assistant' }（只含 role，不含 content）
    - 内容块: delta: { content: '增量文本' }（实时计算并推送增量）
    - 结束块: delta: { content: "" }, finish_reason: 'stop'
    - 心跳保活：每 2 秒发送 ": heartbeat\n\n" SSE 注释
 
 9. 【完整功能保留】工具调用（Function Calling）、速率限制、API认证、
    Google原生API（Gemini CLI兼容）、Responses API（Codex CLI兼容）。
 
 10. 【自动代理池与24小时更新】
     - 自动从 ProxyScrape API 获取低延迟代理列表（默认 timeout=200 极速模式，省流量省内存）
     - 支持 GitHub raw 完整源备用回退
     - 内置自动测试系统：通过 cloudflare:sockets 真实测试目标 gemini.google.com:443 隧道连通性
     - 支持 HTTP CONNECT、SOCKS5、SOCKS4 代理协议，自动升级 TLS，支持打字机流式输出
     - Smart Round Robin 智能轮询（默认轮询模式）：按反向延迟加权选择——最快代理获得最高选中概率，慢速代理仍保留一定流量以便持续验证可用性
     - Isolate 级候选缓存：解析后的候选代理列表缓存在当前 Worker Isolate 内存中（免费，无 KV 费用），TTL 与更新周期一致，周期内重复刷新直接复用缓存、跳过 ProxyScrape 与 GitHub 两次上游请求；空结果不写入缓存
     - 每 24 小时自动静默刷新代理池（支持 Cloudflare Cron 定时触发与按需后台异步更新）
     - 支持 Cloudflare KV 持久化缓存（多实例共享已测试代理）
     - 自动故障转移：单代理请求失败自动轮换下一个，所有代理失效时自动回退直连，确保服务高可用
     - 单代理握手测试默认超时 1000ms（可通过 PROXY_TEST_TIMEOUT_MS 调整）
 

## 部署说明:

1. 登录 Cloudflare Dashboard -> Workers & Pages
2. 创建 Worker -> 粘贴此代码 -> 保存并部署
3. 配置环境变量(可选):

   【认证相关】
   - COOKIE_STRING: Cookie 字符串，多个用 | 分隔
     格式: "cookie_account1| cookie_account2| cookie_account3"
     从浏览器 F12 -> Application -> Cookies 中复制完整 Cookie
     包含 __Secure-1PSID、__Secure-3PSID、SAPISID 等
   - SAPISID: SAPISID 值，多个用 | 分隔
     格式: "sapisid_1| sapisid_2| sapisid_3"
     如果未设置，会自动从 COOKIE_STRING 中提取

   【API 安全】
   - API_KEYS: API 密钥 JSON 数组，如 ["sk-gemini", "sk-my-key"]
     留空或设为 [] 表示不验证密钥
 
   【Gemini 配置】
   - GEMINI_BL: Gemini 构建标签
     遇到 405 错误时需要更新此值
     获取方法：浏览器打开 gemini.google.com -> F12 -> Network -> 搜索 "boq_assistant"
   - DEFAULT_MODEL: 默认模型名称，如 "gemini-3.6-flash"
   - AUTH_USER: 多账户索引，0=第一个账户，1=第二个账户

   【性能调优】
   - RETRY_ATTEMPTS: 重试次数，默认 3
   - RETRY_DELAY_SEC: 重试间隔(秒)，默认 2
   - REQUEST_TIMEOUT_SEC: 请求超时(秒)，默认 28
   - FINGERPRINT_JITTER_MS: 请求前随机延迟最大值(毫秒)，默认 1500
     设为 0 可禁用随机延迟
   - RATE_LIMIT_MAX: 速率限制最大请求数，默认 3000
   - RATE_LIMIT_WINDOW: 速率限制时间窗口(秒)，默认 60
 
客户端配置:
  基础URL: https://你的worker.workers.dev/v1
  API密钥: sk-gemini (或你在配置中设置的密钥)
  模型: gemini-3.6-flash
 

## 技术架构说明:

 
 【Isolate 模型】
 Cloudflare Workers 使用 Isolate（隔离环境）处理每个请求：
 - 冷启动：全局代码重新执行，所有变量重新初始化
 - 热启动：复用已有 Isolate，全局代码不执行，变量保留上次状态
 - env 参数：每个请求由 CF 平台独立注入，始终包含最新环境变量
 
【配置隔离原理】
 1. DEFAULT_CONFIG 作为不可变模板（只读）
 2. getRequestConfig(env) 每次创建全新副本
 3. 从 env 读取配置，用 || null 显式覆盖所有字段
 4. 所有函数通过 config 参数接收配置
 5. 不存在任何全局可变状态的依赖
 
【为什么需要显式覆盖？】
 如果使用 if (env.X) CONFIG.X = env.X 的模式：
 - 当 env.X 存在时，CONFIG.X 被更新 ✓
 - 当 env.X 不存在时，if 不执行，CONFIG.X 保留上次值 ✗
 使用 CONFIG.X = env.X || null 确保始终显式赋值。
 
 基于原项目 gemini-web2api v1.1.0 移植
 原作者项目: https://github.com/your-repo/gemini-web2api
