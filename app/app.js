const sync = require('./utils/sync');
const fonts = require('./data/fonts');

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

    // 加载自定义字体（失败会自动回落到系统黑体，不影响使用）
    // 异步加载，不阻塞下面的同步启动
    fonts.load();

    // 这里不再写入任何数据。
    // 动作库是静态的（data/exercises.js），周计划在用户走完引导后生成。

    // 同步：没配后端地址、或引导还没走完时，init() 会自己跳过（纯本地模式）。
    // 返回的 Promise 内部已把错误都吞掉（只记日志 + 退避），不会打扰用户。
    sync.init();
  },

  onShow() {
    // 从后台切回来补一次。没有待上传、也没有远端更新时，一次请求就结束
    sync.kick();
  }
});
