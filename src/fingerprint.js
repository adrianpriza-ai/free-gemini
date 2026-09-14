// 🎭 多指纹轮换池
// User-Agent / Accept-Language / Sec-Ch-Ua 加权随机轮换，平台无关。
// Weighted browser fingerprint rotation pools shared by every platform.

// 🎭 多指纹轮换池
//
// 以下指纹池用于每次请求时随机选择不同的浏览器标识。
// 目的是让每次请求看起来来自不同的浏览器和设备，
// 降低被 Gemini 服务器识别为自动化脚本的概率。

/**
 * User-Agent 轮换池
 * 
 * 包含 8 种真实浏览器的 User-Agent 字符串。
 * 涵盖 Windows、macOS、Linux 三个操作系统平台。
 * 涵盖 Chrome 125-127、Firefox 128、Safari 17.4 等主流浏览器版本。
 * 
 * 每个 UA 都有对应的权重（UA_WEIGHTS），用于加权随机选择。
 * 权重模拟真实浏览器市场份额分布：
 *   - Chrome Windows: ~65%（两个版本合计）
 *   - Safari macOS: ~8%
 *   - Chrome macOS: ~10%
 *   - Chrome Linux: ~7%
 *   - Firefox 全平台: ~10%（三个版本合计）
 * 
 * 权重数组与 USER_AGENTS 数组一一对应，总和为 100。
 */

var USER_AGENTS = [
  // Chrome 134 on Windows 10/11（占比最高，约 35%）
  // 这是目前最主流的浏览器配置
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  // Chrome 133 on Windows 10/11（占比约 28%）
  // 上一版本的 Chrome，仍有大量用户未更新
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  // Safari 18.3 on macOS 15.3（占比约 8%）
  // Mac 用户使用系统自带浏览器
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
  // Chrome 134 on macOS 15.3（占比约 10%）
  // Mac 用户安装 Chrome 浏览器
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  // Chrome 134 on Linux（占比约 7%）
  // Linux 桌面用户（开发者群体）
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  // Firefox 135 on Windows（占比约 5%）
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
  // Firefox 135 on macOS（占比约 3%）
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.3; rv:135.0) Gecko/20100101 Firefox/135.0',
  // Firefox 135 on Linux（占比约 2%）
  'Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0',
  // Chrome 132 on Windows（占比约 7%）
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
];

// 加权权重数组，与 USER_AGENTS 一一对应
// 总和 = 35 + 28 + 8 + 10 + 7 + 5 + 3 + 2 + 7 = 105
// 模拟真实浏览器市场份额：Chrome ~72%, Safari ~8%, Firefox ~10%
var UA_WEIGHTS = [35, 28, 8, 10, 7, 5, 3, 2, 7];

/**
 * 加权随机选择 User-Agent
 * 
 * 算法步骤：
 * 1. 计算所有权重的总和（totalWeight = 100）
 * 2. 生成 0 到 totalWeight 之间的随机浮点数
 * 3. 从头开始累加权重，当累加值超过随机数时
 * 4. 返回当前索引对应的 User-Agent
 * 
 * 这种算法保证了高权重的 UA 有更高的被选中概率。
 * 
 * @returns {string} 随机选择的 User-Agent 字符串
 */
export function getRandomUserAgent() {
  // 第一步：计算总权重
  var totalWeight = 0;
  for (var i = 0; i < UA_WEIGHTS.length; i++) {
    totalWeight += UA_WEIGHTS[i];
  }
  // 第二步：生成 0 到总权重的随机数
  var random = Math.random() * totalWeight;
  // 第三步：累加权重，找到随机数落在哪个区间
  var cumulative = 0;
  for (var j = 0; j < USER_AGENTS.length; j++) {
    cumulative += UA_WEIGHTS[j];
    // 当累加值超过随机数时，返回当前 UA
    if (random < cumulative) {
      return USER_AGENTS[j];
    }
  }
  // 兜底：如果因为浮点精度问题没有命中，返回第一个
  return USER_AGENTS[0];
}

/**
 * Accept-Language 轮换池
 * 
 * 包含 6 种不同的浏览器语言偏好设置。
 * 模拟不同地区用户的浏览器配置。
 * 英语为主（美国/英国），部分包含中文、日语、韩语、西班牙语作为第二语言。
 * 
 * q 值表示优先级权重：
 *   - q=0.9 表示第二语言的高优先级
 *   - 第一语言不写 q 值（默认为 1.0）
 */
var ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',              // 纯英语用户（美国），最常见的配置
  'en-US,en;q=0.9,zh-CN;q=0.8',  // 英语为主，中文为辅（华裔或中国留学生）
  'en-GB,en;q=0.9',              // 英式英语用户（英国/英联邦国家）
  'en-US,en;q=0.9,ja;q=0.8',     // 英语为主，日语为辅（日裔或日语学习者）
  'en-US,en;q=0.9,ko;q=0.8',     // 英语为主，韩语为辅（韩裔或韩语学习者）
  'en-US,en;q=0.9,es;q=0.8',     // 英语为主，西班牙语为辅（拉丁裔）
];

/**
 * 随机选择 Accept-Language
 * 使用均匀随机分布（每种语言偏好被选中的概率相同）
 * @returns {string} 随机选择的 Accept-Language 字符串
 */
export function getRandomAcceptLanguage() {
  var idx = Math.floor(Math.random() * ACCEPT_LANGUAGES.length);
  return ACCEPT_LANGUAGES[idx];
}

/**
 * Sec-Ch-Ua 轮换池（Chrome 用户代理客户端提示）
 * 
 * Sec-Ch-Ua 是 Chrome 浏览器（Chromium 内核）发送的额外请求头，
 * 包含浏览器品牌和版本信息。只有 Chrome 系浏览器会发送此头。
 * Firefox 和 Safari 不发送此头。
 * 
 * 格式: "Brand";v="MajorVersion"
 * - "Not)A;Brand";v="99" 是 Chromium 的固定标识
 * - "Google Chrome";v="127" 表示 Chrome 主版本号
 * - "Chromium";v="127" 表示 Chromium 内核版本号
 */
var SEC_CH_UA_POOLS = [
  // Chrome 134
  '"Not(A:Brand";v="99", "Google Chrome";v="134", "Chromium";v="134"',
  // Chrome 133
  '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  // Chrome 132
  '"Not(A:Brand";v="99", "Google Chrome";v="132", "Chromium";v="132"',
];

/**
 * Sec-Ch-Ua-Platform 轮换池（操作系统平台标识）
 * 
 * 配合 Sec-Ch-Ua 使用，标识浏览器的操作系统平台。
 * 应该与 User-Agent 中的平台信息一致。
 */
var SEC_CH_UA_PLATFORMS = [
  '"Windows"',   // Windows 平台
  '"macOS"',     // macOS 平台（注意大小写）
  '"Linux"',     // Linux 平台
];

/**
 * 随机选择 Sec-Ch-Ua（Chrome 版本标识）
 * @returns {string} 随机选择的 Sec-Ch-Ua 字符串
 */
export function getRandomSecChUa() {
  var idx = Math.floor(Math.random() * SEC_CH_UA_POOLS.length);
  return SEC_CH_UA_POOLS[idx];
}

/**
 * 随机选择 Sec-Ch-Ua-Platform（操作系统平台标识）
 * @returns {string} 随机选择的平台字符串
 */
export function getRandomSecChUaPlatform() {
  var idx = Math.floor(Math.random() * SEC_CH_UA_PLATFORMS.length);
  return SEC_CH_UA_PLATFORMS[idx];
}
