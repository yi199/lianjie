const sync = require('./utils/sync');
const fonts = require('./data/fonts');
const report = require('./utils/report');

/**
 * 右上角胶囊（微信菜单按钮）的几何。
 *
 * 全站是自定义导航（app.json `navigationStyle: custom`），头部第一行如果**右侧**放了东西
 * （记录页的「换一个」、动作页/进步页的英文小标），在 iPhone 上会被胶囊直接压住 ——
 * 胶囊是系统层，会吃掉那部分点击，用户点了没反应。
 *
 * 返回「右侧要让出多少 px」：让内容右边界落在胶囊左边缘再往左 8px。
 * 拿不到真几何（低版本基础库）时按官方经验值兜底：胶囊右边距 7px、宽 87px。
 */
function capsulePad() {
  try {
    const win = (wx.getWindowInfo && wx.getWindowInfo()) || {};
    const w = win.windowWidth || 375;
    const r = (wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect()) || null;
    const left = r && r.width > 0 ? r.right - r.width : w - 7 - 87;
    return Math.round(w - left) + 8;
  } catch (e) {
    return 102;      // 兜底：375 宽下胶囊左边约 281px，让出 94 + 8
  }
}

App({
  globalData: {
    // 自定义导航栏需要自己让出状态栏高度
    statusBarHeight: 20,
    // 顶行右侧要给胶囊让出的像素（见 capsulePad）
    capsulePad: 102,
    // 上一次选中的 tab（0/1/2）：自定义 tabBar 每个页面都是新实例，靠它决定滑块从哪滑过来
    tabFrom: undefined
  },

  onLaunch() {
    try {
      const info = wx.getWindowInfo();
      this.globalData.statusBarHeight = info.statusBarHeight || 20;
    } catch (e) {
      // 低版本基础库没有 getWindowInfo，退回 20
    }
    this.globalData.capsulePad = capsulePad();

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
  },

  /** JS 未捕获异常。以前这里什么都没有：线上白屏时零线索，只能靠用户描述 */
  onError(err) {
    report.crash(err);
  },

  /** 没人 catch 的 Promise。同步层大量用 Promise，这条最容易被漏掉 */
  onUnhandledRejection(res) {
    report.rejection(res);
  },

  /** 跳到不存在的页面（分享卡片指向已删页面、路径写错）→ 上报 + 回首页，别把用户停在白屏 */
  onPageNotFound(res) {
    report.send('onPageNotFound', { path: (res && res.path) || '', msg: 'page not found' });
    wx.reLaunch({ url: '/pages/today/index' });
  }
});
