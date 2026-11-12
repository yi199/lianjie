/**
 * 页面进场动画（只做进场，退场交给系统）
 *
 * 为什么只有一个方向可用：微信在 WebView 渲染下页面转场是系统写死的「右进左出」，
 * 改不了（要自定义得切 Skyline 渲染引擎）。所以我们只在**内容层**做动画：
 *   - tab 页：整块内容往上长出来（见 app.wxss 的 .page.enter + 子元素错峰）
 *   - 详情页：内容从右侧推进来，和系统滑动同向，看起来是「接着滑进去的」
 *
 * 用法：
 *   const enterFx = require('../../utils/enter');   // 详情页在 onLoad 末尾
 *   enterFx(this);                                   // → 根节点 class 变 enter-r
 *
 * 为什么要先置空、隔一帧再挂上：小程序不会因为 setData 同值重播 CSS 动画；
 * 先清掉类（这一帧没有动画），下一帧再挂上，动画才会重新跑。
 */

const REPLAY_MS = 24;      // 大约一帧，够让上一次的 class 先落到渲染层

/**
 * 给详情页播一次「从右滑入」。
 * @param {object} page 页面实例（this）
 * @param {string} [kind] 'detail'（默认）| 'up'
 */
function enterFx(page, kind) {
  if (!page || typeof page.setData !== 'function') return;
  const cls = kind === 'up' ? 'enter' : 'enter-r';

  page.setData({ fx: '' });
  if (page.__fxTimer) clearTimeout(page.__fxTimer);
  page.__fxTimer = setTimeout(function () {
    page.setData({ fx: cls });
  }, REPLAY_MS);
}

/** 离开页面时清掉定时器，别让它往已经卸载的页面上 setData */
function clearFx(page) {
  if (page && page.__fxTimer) {
    clearTimeout(page.__fxTimer);
    page.__fxTimer = null;
  }
}

module.exports = { enterFx, clearFx, REPLAY_MS };
