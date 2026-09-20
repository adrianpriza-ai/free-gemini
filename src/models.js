// 🤖 模型目录
// Gemini 模型定义（mode/think 枚举与别名），平台无关。
// Model catalog shared by every platform bundle.

// 🤖 模型定义
//
// 映射自 Gemini Web 前端 JS 源码中的 MODE_CATEGORY 枚举
// 
// mode 字段含义（MODE_CATEGORY 枚举值）：
//   1 = FAST（快速模式）- Gemini Flash 系列，速度最快
//   2 = THINKING（深度思考）- 启用深度推理，输出质量更高
//   3 = PRO（专业版）- 最强模型，需要有效 Cookie 才能正确路由
//   4 = AUTO（自动选择）- 由 Gemini 自动选择最合适的模型
//   5 = FAST_DYNAMIC_THINKING（动态思考）- 自适应思考深度
//   6 = FLASH_LITE（轻量快速）- 最轻量模型，速度最快但质量较低
// 
// think 字段含义（思考模式）：
//   0 = 启用深度思考（模型会花更多时间推理）
//   4 = AUTO（自动选择思考深度，由 Gemini 决定）

export var MODELS = {
  'gemini-3.8-flash': {
    mode: 1,        // FAST - 快速模式
    think: 4,       // AUTO - 自动选择思考深度
    desc: 'Latest workhorse model, best reasoning & coding (Sep 2026)',
  },
  'gemini-3.8-flash-thinking': {
    mode: 2,        // THINKING - 深度思考模式
    think: 0,       // 启用深度思考
    desc: 'Deep thinking mode on the latest Flash backend',
  },
  'gemini-3.7-flash': {
    mode: 1,        // FAST - 快速模式
    think: 4,       // AUTO - 自动选择思考深度
    desc: 'All-around model (Gemini 3.7 Flash)',
  },
  'gemini-3.6-flash': {
    mode: 1,        // FAST - 快速模式
    think: 4,       // AUTO - 自动选择思考深度
    desc: 'All-around model (Gemini 3.6 Flash)',
  },
  'gemini-3.5-flash': {
    mode: 1,        // FAST
    think: 4,       // AUTO
    desc: 'All-around model (Gemini 3.5 Flash)',
  },
  'gemini-3.5-flash-lite': {
    mode: 6,        // FLASH_LITE - 轻量快速
    think: 4,       // AUTO
    desc: 'Cost-efficient high-capacity model (Gemini 3.5 Flash-Lite)',
  },
  'gemini-3.1-flash-lite': {
    mode: 6,        // FLASH_LITE - 轻量快速
    think: 4,       // AUTO
    desc: 'Cost-efficient high-capacity model (Gemini 3.1 Flash-Lite)',
  },
  'gemini-3.5-flash-thinking': {
    mode: 2,        // THINKING - 深度思考模式
    think: 0,       // 启用深度思考
    desc: 'Deep thinking mode, longest output (~20k chars)',
  },
  'gemini-3.1-pro': {
    mode: 3,        // PRO - 专业版
    think: 4,       // AUTO
    desc: 'Pro model (requires cookie for real routing)',
  },
  'gemini-3.1-pro-enhanced': {
    mode: 3,        // PRO - 专业版
    think: 4,       // AUTO
    extra: { 31: 2, 80: 3 },  // 附加 payload 字段（增强输出开关，实验性）
    desc: 'Pro with enhanced output (experimental)',
  },
  'gemini-auto': {
    mode: 4,        // AUTO - 自动模型选择
    think: 4,       // AUTO
    desc: 'Auto model selection',
  },
  'gemini-3.5-flash-thinking-lite': {
    mode: 5,        // FAST_DYNAMIC_THINKING - 动态思考
    think: 0,       // 启用思考
    desc: 'Dynamic thinking with adaptive depth',
  },
  'gemini-flash-lite': {
    mode: 6,        // FLASH_LITE - 轻量快速
    think: 4,       // AUTO
    desc: 'Lightweight fast model',
  },
  // -- Popular aliases for broad client compatibility
  'gemini-2.5-flash': {
    mode: 1,
    think: 4,
    desc: 'Alias → gemini-3.6-flash (client compatibility)',
  },
  'gemini-2.5-flash-preview-04-17': {
    mode: 1,
    think: 4,
    desc: 'Alias → gemini-3.6-flash (client compatibility)',
  },
  'gemini-2.5-pro': {
    mode: 3,
    think: 4,
    desc: 'Alias → gemini-3.1-pro (client compatibility)',
  },
  'gemini-2.0-flash': {
    mode: 1,
    think: 4,
    desc: 'Alias → gemini-3.6-flash (client compatibility)',
  },
  'gemini-2.0-flash-exp': {
    mode: 1,
    think: 4,
    desc: 'Alias → gemini-3.6-flash (client compatibility)',
  },
};
