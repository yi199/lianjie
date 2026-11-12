/**
 * 底部三个 tab 的切换条（普通组件，塞在 pages/shell 里）
 *
 * 和之前那版「自定义 tabBar」的区别：以前每个 tab 页各有一份实例，切页时旧实例销毁、
 * 新实例重建，滑块要「接力」才能滑起来；现在是同一个页面里的同一个组件，
 * 切 tab 只是 setData 改 pos —— 滑块自然顺着 transition 滑过去，不需要任何技巧。
 *
 * 两种皮肤（「我的」页脚版本号连点 5 次切换）：pill 深绿胶囊 / card 浅色浮卡。
 */
const SKIN_KEY = 'lj.tabSkin';

Component({
  properties: {
    selected: { type: Number, value: 0 }
  },

  data: {
    pos: 0,
    skin: 'pill',
    list: [
      { pagePath: '0', text: '训练', icon: '/images/tabbar/tab-train.png', on: '/images/tabbar/tab-train-on.png' },
      { pagePath: '1', text: '数据', icon: '/images/tabbar/tab-data.png', on: '/images/tabbar/tab-data-on.png' },
      { pagePath: '2', text: '我的', icon: '/images/tabbar/tab-my.png', on: '/images/tabbar/tab-my-on.png' }
    ]
  },

  observers: {
    selected: function (n) { this.setData({ pos: Number(n) || 0 }); }
  },

  lifetimes: {
    attached: function () {
      let skin = 'pill';
      try { skin = wx.getStorageSync(SKIN_KEY) || 'pill'; } catch (e) { /* 读不到就用默认 */ }
      this.setData({ skin: skin });
    }
  },

  methods: {
    tap: function (e) {
      const i = Number(e.currentTarget.dataset.i);
      if (i === this.data.selected) return;
      // 轻震一下：真机上才有，是「按到了」最便宜的确认
      try { wx.vibrateShort({ type: 'light' }); } catch (err) { /* 部分机型不支持，忽略 */ }
      this.triggerEvent('change', { i: i });
    },

    /** 换皮肤（「我的」页的隐藏手势调它） */
    setSkin: function (skin) {
      if (!skin) return;
      try { wx.setStorageSync(SKIN_KEY, skin); } catch (e) { /* 存不下也不影响本次 */ }
      this.setData({ skin: skin });
    }
  }
});
