Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/today/index', text: '训练', icon: '/images/tabbar/tab-train.png', on: '/images/tabbar/tab-train-on.png' },
      { pagePath: '/pages/stats/index', text: '数据', icon: '/images/tabbar/tab-data.png', on: '/images/tabbar/tab-data-on.png' },
      { pagePath: '/pages/my/index', text: '我的', icon: '/images/tabbar/tab-my.png', on: '/images/tabbar/tab-my-on.png' }
    ]
  },

  methods: {
    switchTab(e) {
      const i = Number(e.currentTarget.dataset.i);
      const item = this.data.list[i];
      if (!item || i === this.data.selected) return;
      wx.switchTab({ url: item.pagePath });
    }
  }
});
