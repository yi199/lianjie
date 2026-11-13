const enterFx = require('../../utils/enter').enterFx;
/**
 * 隐私政策 / 用户协议
 *
 * 上线必须有的两页：审核会看，用户也真的需要知道「数据在哪、会丢吗、练伤了算谁的」。
 * 文案口径必须与实现一致 —— 当前版本是纯本地（config.js 的 trial/release 留空），
 * **不注册、不登录、不联网上传**，所以隐私政策写的是「我们不收集个人信息，数据只在本机」。
 * 哪天给 release 填了域名、开了云同步，**这一页必须同步改**（见 HANDOFF 第 12 条）。
 */
Page({
  data: {
    sbh: 20,
    cpad: 102,
    updated: '2026 年 11 月 11 日',
    version: 'v0.1'
  },

  onLoad() {
    enterFx(this);      // 详情页：内容从右侧推进来（见 utils/enter.js）
    const app = getApp();
    this.setData({
      sbh: app.globalData.statusBarHeight,
      cpad: app.globalData.capsulePad || 102
    });
  },

  back() {
    wx.navigateBack({ animationType: 'fade-out', animationDuration: 200 });
  },

  onShareAppMessage() {
    return { title: '力见的隐私政策与用户协议', path: '/pages/welcome/index' };
  }
});
