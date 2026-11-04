/**
 * 本地存储的安全写入入口
 *
 * 为什么需要单独一个模块：
 *   storage.js（训练记录）和 catalog.js（自建动作 / 动作清单缓存）都要写本地存储，
 *   而 storage.js 依赖 catalog.js（依赖方向 storage → catalog），catalog 不能再反过来
 *   依赖 storage，所以写保护必须放在两者下面这一层。本文件不 require 任何东西。
 *
 * 背景：微信本地存储单 key 上限 1MB、总共 10MB，满了 wx.setStorageSync 会**直接抛异常**。
 * 裸调用的话异常会一路冒到页面 onLoad —— 用户看到的是白屏，而且完全不知道数据没存上。
 *
 * 这里的规矩：
 *   1. 失败不抛异常，返回 false，由调用方决定要不要回滚自己的内存缓存
 *   2. 只提示一次（每次写都弹窗等于骚扰，用户反而学会无视）
 *   3. 提示里带上真实用量，用户知道该清多少
 */

let warned = false;

function set(key, val) {
  try {
    wx.setStorageSync(key, val);
    return true;
  } catch (e) {
    fail(key, e);
    return false;
  }
}

function fail(key, e) {
  const msg = (e && (e.errMsg || e.message)) || 'unknown';
  try { console.warn('[storage] 写入失败 ' + key + '：' + msg); } catch (x) { /* 忽略 */ }

  if (warned) return;
  warned = true;

  let usage = '';
  try {
    const info = wx.getStorageInfoSync ? wx.getStorageInfoSync() : null;
    if (info && info.limitSize) {
      usage = '（本地已用 ' + Math.round((info.currentSize || 0) / 102.4) / 10 +
        'MB / ' + Math.round(info.limitSize / 1024) + 'MB）';
    }
  } catch (x) { /* 拿不到用量就算了，不影响提示 */ }

  try {
    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: '本地空间不足',
        content: '这条记录没能保存到手机' + usage +
          '。可以先到「我的 → 清空训练记录」腾出空间，再重新记录一次。',
        showCancel: false,
        confirmText: '知道了'
      });
    }
  } catch (x) { /* 忽略 */ }
}

/** 测试用：把「只提示一次」的标记清掉 */
function resetWarn() {
  warned = false;
}

module.exports = { set, resetWarn };
