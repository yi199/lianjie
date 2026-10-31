/**
 * 后端地址
 *
 * 按小程序运行环境区分（开发版 / 体验版 / 正式版）。留空 = 不同步，纯本地运行，
 * 行为和接后端之前完全一样——备案下来之前正式版就保持留空。
 *
 * 本地联调（sync.js 完成之后）：
 *   1. cd server && docker compose up -d
 *   2. develop 填 'http://localhost:8080'
 *   3. 开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」
 *
 * sync.js 完成之前全部留空：填了地址，取消勾选会改写墓碑，但没有人去上传它。
 */
const API_BASE = {
  develop: '',
  trial: '',
  release: ''
};

let override = null;   // 测试用：node 环境没有 wx.getAccountInfoSync

function envVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'release';
  } catch (e) {
    return 'none';
  }
}

let cached = null;

function apiBase() {
  if (override !== null) return override;
  if (cached === null) cached = API_BASE[envVersion()] || '';
  return cached;
}

function syncEnabled() {
  return !!apiBase();
}

/** 测试里打开 / 关闭同步：setApiBase('http://fake') / setApiBase(null) */
function setApiBase(base) {
  override = base;
}

module.exports = { apiBase, syncEnabled, setApiBase };
