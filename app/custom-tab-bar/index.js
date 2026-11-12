/**
 * 自定义底栏
 *
 * 两种皮肤，用「我的 → 页脚版本号连点 5 次」切换（存在本地，只影响底栏样式）：
 *   pill —— 深绿胶囊滑过去，选中项图标/文字反白（默认）
 *   card —— 浅色胶囊浮起来，图标下沉让位，底部一颗陶土小点
 *
 * ⚠️ 关键坑：自定义 tabBar 在**每个 tab 页都是一份独立实例**。
 * switchTab 时旧实例销毁、新实例创建，所以直接写 CSS transition 只会「闪一下」
 * ——胶囊在新实例里一出生就在目标位置。要真的滑起来必须「接力」：
 *   1. 点 tab 的时候，把当前 selected 存进 globalData.tabFrom
 *   2. 新实例 attached 时先把胶囊摆到 tabFrom（无过渡）
 *   3. 页面 onShow 里 setData({selected}) 触发 observers，下一帧滑到新位置
 */

const SKIN_KEY = 'lj.tabSkin';     // 'pill' | 'card'

Component({
  data: {
    selected: 0,
    pos: 0,          // 胶囊当前所在的格：和 selected 分开，两者不等的那一瞬间才有滑动
    skin: 'pill',
    noFx: false,     // true = 这一帧不要过渡（用来把胶囊「瞬移」到来时的位置）
    list: [
      { pagePath: '/pages/today/index', text: '训练', icon: '/images/tabbar/tab-train.png', on: '/images/tabbar/tab-train-on.png' },
      { pagePath: '/pages/stats/index', text: '数据', icon: '/images/tabbar/tab-data.png', on: '/images/tabbar/tab-data-on.png' },
      { pagePath: '/pages/my/index', text: '我的', icon: '/images/tabbar/tab-my.png', on: '/images/tabbar/tab-my-on.png' }
    ]
  },

  observers: {
    selected: function (n) {
      this.relay(Number(n) || 0);
    }
  },

  lifetimes: {
    attached() {
      let skin = 'pill';
      try { skin = wx.getStorageSync(SKIN_KEY) || 'pill'; } catch (e) { /* 读不到就用默认 */ }

      const app = getApp();
      const from = app && app.globalData ? app.globalData.tabFrom : undefined;
      // 新实例第一帧就把胶囊摆在「来时的那个 tab」上，否则它会在目标位置直接出现
      this.setData({
        skin: skin,
        pos: (typeof from === 'number' ? from : 0)
      });
    }
  },

  methods: {
    /** 把胶囊从「来时的 tab」滑到 n；不是跨 tab 跳转就不播动画 */
    relay(n) {
      const app = getApp();
      const from = app && app.globalData ? app.globalData.tabFrom : undefined;
      const moving = typeof from === 'number' && from !== n;

      if (!moving) {
        this.setData({ pos: n, noFx: false });
        return;
      }

      // 先无过渡地落到 from，隔一帧再落到 n —— 这一帧的差才会被 transition 补上
      const self = this;
      this.setData({ pos: from, noFx: true }, function () {
        setTimeout(function () {
          self.setData({ noFx: false });
          self.setData({ pos: n });
        }, 24);
      });
    },

    switchTab(e) {
      const i = Number(e.currentTarget.dataset.i);
      const item = this.data.list[i];
      if (!item || i === this.data.selected) return;

      // 记下「从哪来的」，下一个页面的 tabBar 实例靠它决定胶囊起点
      const app = getApp();
      if (app && app.globalData) app.globalData.tabFrom = this.data.selected;

      // 轻震一下：真机上才有，是「按到了」最便宜的确认
      try { wx.vibrateShort({ type: 'light' }); } catch (err) { /* 部分机型不支持，忽略 */ }

      wx.switchTab({ url: item.pagePath });
    },

    /** 换皮肤：只有「我的」页的隐藏手势会调它 */
    setSkin(skin) {
      if (!skin) return;
      try { wx.setStorageSync(SKIN_KEY, skin); } catch (e) { /* 存不下也不影响本次 */ }
      this.setData({ skin: skin });
    }
  }
});
