App({
  globalData: {
    // 自定义导航栏需要自己让出状态栏高度
    statusBarHeight: 20
  },

  onLaunch() {
    try {
      const info = wx.getWindowInfo();
      this.globalData.statusBarHeight = info.statusBarHeight || 20;
    } catch (e) {
      // 低版本基础库没有 getWindowInfo，退回 20
    }
    // 这里不再写入任何数据。
    // 动作库是静态的（data/exercises.js），周计划在用户走完引导后生成。
  }
});
