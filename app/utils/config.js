/**
 * 后端地址
 *
 * 按小程序运行环境区分（开发版 / 体验版 / 正式版）。**留空 = 不同步，纯本地运行**，
 * 行为和接后端之前完全一样——备案下来之前 trial / release 保持留空。
 *
 * ⚠️ 地址必须带 `/api`：同步层拼的是 `apiBase() + '/login'`，
 *    而服务端路由是 `/api/login`。少写 `/api` 会 404。
 *
 * 本地联调：
 *   1. cd server && DATABASE_URL=... DEV_MODE=true go run .
 *      （或者 docker compose up，但要先建好 api 镜像）
 *   2. develop 用下面的默认值即可（本机 8080）
 *   3. 开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 证书」
 *      不勾的话 http:// 请求会被直接拦掉
 *   4. 真机预览不能用 127.0.0.1，要换成电脑的局域网地址，
 *      例如 http://192.168.1.5:8080/api（手机与电脑同一个 WiFi，真机需开调试模式）
 */
const API_BASE = {
  develop: 'http://127.0.0.1:8080/api',
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
  cached = null;        // 换环境之后不能拿旧缓存，否则测试里切换环境不生效
}

module.exports = { apiBase, syncEnabled, setApiBase };
