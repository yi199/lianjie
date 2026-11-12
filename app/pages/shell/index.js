/**
 * tab 容器页
 *
 * 为什么要有这一页：微信的页面之间不能自定义转场（旧页销毁、新页创建，两者不可能同屏），
 * 所以「横滑切换」只能把三个 tab 塞进同一个页面的 swiper 里自己做。
 * 代价是三个 tab 从「页面」变成了「组件」（见 components/tab-*），
 * 好处是切换零延迟、状态天然保留、可以跟手左右拖。
 */
Page({
  data: { cur: 0 },

  onLoad(q) {
    const t = Number((q && q.tab) || 0);
    if (t > 0 && t < 3) this.setData({ cur: t });
  },

  /** 手指滑动后同步底栏 */
  onSwipe(e) {
    const i = e.detail.current;
    if (i !== this.data.cur) this.setData({ cur: i });
  },

  /** 点底栏：改 current，swiper 自己会带过渡滑过去 */
  onBar(e) {
    this.swipeTo(e.detail.i);
  },

  /** 给组件里调用（utils/tabkit.goTab） */
  swipeTo(i) {
    const n = Number(i);
    if (n < 0 || n > 2 || n === this.data.cur) return;
    this.setData({ cur: n });
  },

  /** 下拉刷新交给当前这个 tab 自己处理（每个 tab 内是 scroll-view） */
  onPullDownRefresh() {
    const c = this.selectComponent('#tab' + this.data.cur);
    if (c && typeof c.refresh === 'function') c.refresh();
    wx.stopPullDownRefresh();
  }
});
