const db = require('./utils/db');

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
    // 首次启动写入动作字典、周计划与示例记录
    db.initSeed();
  }
});
