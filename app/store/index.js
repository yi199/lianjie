/** 极简状态：小程序没有 Pinia，跨页共享只需要「变更通知」这一件事 */

const listeners = [];
const state = {
  // 记录有新数据时 +1，页面 listen 到变化后自己刷新
  setsVersion: 0
};

function get(key) {
  return state[key];
}

function set(key, val) {
  state[key] = val;
  listeners.slice().forEach(function (fn) {
    try { fn(key, val); } catch (e) { /* 单个监听器出错不影响其他 */ }
  });
}

/** 页面 onLoad 里注册，onUnload 里取消 */
function on(fn) {
  listeners.push(fn);
}

function off(fn) {
  const i = listeners.indexOf(fn);
  if (i >= 0) listeners.splice(i, 1);
}

/** 通知「记录变了」 */
function touchSets() {
  set('setsVersion', state.setsVersion + 1);
}

module.exports = { get, set, on, off, touchSets };
