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
  // 本机用 18081 而不是 8080：Docker Desktop 会占用 8080，而本项目要用 Docker 跑 Postgres
  develop: 'http://127.0.0.1:18081/api',
  trial: '',
  release: ''
};

let override = null;   // 测试用：node 环境没有 wx.getAccountInfoSync

/**
 * 开发版联调用的固定登录 code。
 *
 * 为什么需要：wx.login 每次返回的 code 都不一样，而服务端 DEV_MODE 把 openid
 * 映射成 "dev-" + code —— 每次重新登录就成了一个新用户，清缓存 / 换设备之后
 * 再也拿不回之前的数据，「多设备同步」根本没法手动验证。
 * 所以 develop 环境固定一个 code；体验版 / 正式版仍然走真实 wx.login。
 */
const DEV_LOGIN_CODE = 'local-1';   // 服务端 DEV_MODE 会拼成 openid = "dev-local-1"

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

/**
 * 开发版返回固定 code（见上面 DEV_LOGIN_CODE 的说明），其它环境返回空串
 * → 同步层据此决定「用固定身份」还是「走真实 wx.login」。
 */
function devCode() {
  return envVersion() === 'develop' ? DEV_LOGIN_CODE : '';
}

/** 测试里打开 / 关闭同步：setApiBase('http://fake') / setApiBase(null) */
function setApiBase(base) {
  override = base;
  cached = null;        // 换环境之后不能拿旧缓存，否则测试里切换环境不生效
}

module.exports = { apiBase, syncEnabled, setApiBase, devCode };
