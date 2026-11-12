/**
 * swiper 容器的胶水层
 *
 * 为什么需要这一层：三个 tab 原来是三个独立页面（Page 配置），现在要塞进同一个页面的
 * `<swiper>` 里 —— 也就是变成自定义组件（Component 配置）。两边配置形状不同：
 *   Page      : 生命周期（onLoad/onShow/onHide/onUnload）+ 方法，全部平铺在顶层
 *   Component : data + methods:{...} + lifetimes:{attached/ready/detached} + pageLifetimes:{show/hide}
 * 这个文件负责搬运，避免把三个页面的业务代码重写一遍。
 *
 * 注意一个坑：组件在 swiper 里**不会**收到 pageLifetimes.show —— 那是「页面显示」，
 * 三个 tab 同处一个页面，页面显示时三个都会收到。所以「成为当前 tab」这件事由
 * `active` 属性驱动（见 components/tab-xx/index.js），这里只提供 callShow()。
 */

const LIFETIMES = { onLoad: 'attached', onReady: 'ready', onUnload: 'detached' };

/**
 * Page 配置 → Component 配置
 * @param {object} cfg 页面配置对象（pages 下各个 index.js 导出的那个）
 */
function asComponent(cfg) {
  const out = { data: cfg.data || {}, methods: {} };

  Object.keys(cfg).forEach(function (key) {
    if (key === 'data') return;
    if (LIFETIMES[key]) {
      out.lifetimes = out.lifetimes || {};
      out.lifetimes[LIFETIMES[key]] = cfg[key];
      return;
    }
    if (key === 'onShow' || key === 'onHide') return;   // 由 active 属性驱动，见文件头说明
    out.methods[key] = cfg[key];
  });

  return out;
}

/** 手动触发一次原来页面的 onShow（成为当前 tab 时调） */
function callShow(cfg, ctx) {
  if (cfg && typeof cfg.onShow === 'function') cfg.onShow.call(ctx);
}

/**
 * 切到第 i 个 tab。
 * 优先让 shell 页面去滑 swiper（这样才有动画）；栈里没有 shell（比如从深链进来）
 * 就 reLaunch 过去并带上目标 tab。
 */
function goTab(i) {
  const pages = (typeof getCurrentPages === 'function') ? getCurrentPages() : [];
  for (let k = pages.length - 1; k >= 0; k--) {
    const p = pages[k];
    if (p && p.route === 'pages/shell/index' && typeof p.swipeTo === 'function') {
      p.swipeTo(i);
      return true;
    }
  }
  wx.reLaunch({ url: '/pages/shell/index?tab=' + i });
  return false;
}

/** 从详情页回到 tab 容器 */
function backToShell(tab) {
  const pages = (typeof getCurrentPages === 'function') ? getCurrentPages() : [];
  if (pages.length > 1) {
    wx.navigateBack();
    return true;
  }
  wx.reLaunch({ url: '/pages/shell/index' + (typeof tab === 'number' ? '?tab=' + tab : '') });
  return false;
}

module.exports = { asComponent, callShow, goTab, backToShell };
