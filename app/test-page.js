/**
 * 页面级自测：mock 掉小程序运行时，直接跑 today / record 的页面逻辑
 * 跑法：node test-page.js
 *
 * 数据层有 test.js，这个文件补的是「页面到底渲染出什么」——
 * 恢复已勾选组、从哪个动作开始、文案四态、按钮跳哪。
 */

const store = {};
const calls = [];

global.wx = {
  getStorageSync(k) { return store[k] === undefined ? '' : store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; },
  showToast(o) { calls.push(['toast', o.title]); },
  navigateTo(o) { calls.push(['nav', o.url]); },
  redirectTo(o) { calls.push(['redirect', o.url]); },
  switchTab(o) { calls.push(['tab', o.url]); },
  navigateBack() { calls.push(['back']); },
  vibrateShort() { },
  pageScrollTo() { },
  showActionSheet() { }
};

global.getApp = function () { return { globalData: { statusBarHeight: 20 } }; };

let captured = null;
global.Page = function (obj) {
  captured = obj;
  obj.setData = function (patch) {
    const d = this.data;
    Object.keys(patch).forEach(function (k) { d[k] = patch[k]; });
  };
};

const db = require('./utils/db');
const D = require('./utils/date');

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}

/** 重新加载页面模块（拿一份干净的 data） */
function loadPage(rel) {
  const p = require.resolve(rel);
  delete require.cache[p];
  captured = null;
  require(p);
  return captured;
}

const today = D.today();

function rec(it, no, weight, planKey, date) {
  return db.saveSet({
    date: date || today,
    exId: it.exId,
    exCn: it.cn,
    part: it.part,
    planKey: planKey || 'A',
    setNo: no,
    weight: weight === undefined ? (it.weight || 0) : weight,
    reps: it.reps,
    unit: it.unit,
    // 造历史数据要带上当天的完成时刻：不带的话默认是「现在」，
    // 昨天的训练就会被当成跨零点还没练完的那次（trainingDate 会返回昨天）
    completedAt: date ? date + 'T18:00:00.000Z' : undefined
  });
}

/* ================= 1. record 页：恢复已勾选的组 ================= */
console.log('\n=== 1. record 页恢复进度 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const planA = db.todaySession(today).plan;
ok('今天该练 A 推日', planA.key === 'A', planA.key + ' ' + planA.name);

const cur = planA.items[0];
rec(cur, 1);                     // 只勾了第 1 组

let page = loadPage('./pages/record/index');
page.onLoad({});
ok('从第一个没做完的动作开始', page.data.idx === 1, 'idx=' + page.data.idx);

page.loadEx(0);
ok('已勾的第 1 组还原成已勾', page.data.sets[0].done === true,
  page.data.sets[0].weight + 'kg × ' + page.data.sets[0].reps);
ok('没做的第 2 组仍是未勾', page.data.sets[1].done === false);
ok('组数按计划 4 组', page.data.sets.length === 4, page.data.sets.length + ' 组');

let pageDirect = loadPage('./pages/record/index');
pageDirect.onLoad({ i: '2' });
ok('URL 指定第 3 个动作时直达', pageDirect.data.idx === 2, 'idx=' + pageDirect.data.idx + ' ' + pageDirect.data.ex.cn);

/* ================= 2. record 页：组数不够的提示 ================= */
console.log('\n=== 2. record 页组数提示 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const p2 = db.todaySession(today).plan;
// 昨天只做了 1 组（planKey 写个不存在的，免得把今天的训练日推进掉）
rec(p2.items[0], 1, 50, 'X', D.shift(today, -1));
ok('历史记录不影响今天还是 A', db.todaySession(today).plan.key === 'A', db.todaySession(today).plan.key);

let page3 = loadPage('./pages/record/index');
page3.onLoad({});
ok('上次只做 1 组会有提示', page3.data.sugHint.indexOf('只做了 1 组') >= 0, page3.data.sugHint);
ok('提示里说明计划组数', page3.data.sugHint.indexOf('计划 4 组') >= 0, page3.data.sugHint);
ok('重量保持上次的 50kg', page3.data.sets[0].weight === 50, page3.data.sets[0].weight + 'kg');
ok('今天还没有已勾的组', page3.data.sets[0].done === false);

/* ================= 3. today 页：四态与时长 ================= */
console.log('\n=== 3. today 页状态 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const planT = db.todaySession(today).plan;
rec(planT.items[0], 1);

let tp = loadPage('./pages/today/index');
tp.refresh();
ok('只做 1/4 个动作 → 未完成', tp.data.allDone === false, tp.data.h1);
ok('文案「今天练了 1/4 个动作」', tp.data.h1 === '今天练了 1/4 个动作。', tp.data.h1);
ok('时长按组数算，不是写死的 45', tp.data.minutes > 0 && tp.data.minutes !== 45, tp.data.minutes + ' 分钟');
ok('清单里第 1 个动作打了勾', tp.data.items[0].done === true);
ok('清单里第 2 个动作没打勾', tp.data.items[1].done === false);

// 补完剩下三个动作
planT.items.slice(1).forEach(function (it) { rec(it, 1); });

let tp2 = loadPage('./pages/today/index');
tp2.refresh();
ok('全部动作做完 → allDone', tp2.data.allDone === true, tp2.data.h1);
ok('文案变成「练完了」', tp2.data.h1.indexOf('练完了') >= 0, tp2.data.h1);
ok('清单四个动作全打勾', tp2.data.items.every(function (x) { return x.done; }));

calls.length = 0;
tp2.mainAction();
ok('练完后主按钮跳今日战报', calls.length === 1 && calls[0][1].indexOf('/pages/report/index') === 0, JSON.stringify(calls));

let tp3 = loadPage('./pages/today/index');
tp3.refresh();
calls.length = 0;
tp3.openEx({ currentTarget: { dataset: { i: 2 } } });
ok('点动作清单直接跳记录页对应动作', calls.length === 1 && calls[0][1] === '/pages/record/index?i=2', JSON.stringify(calls));

/* ================= 4. today 页：换过动作也能对上勾 ================= */
console.log('\n=== 4. 换动作后首页对得上 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const planS = db.todaySession(today).plan;
db.setSwap(planS.key, 0, 'g15');           // 卧推 → 上斜卧推
const sp = db.todaySession(today).plan;
rec(sp.items[0], 1, 40);                   // 练的是上斜卧推

let tp4 = loadPage('./pages/today/index');
tp4.refresh();
ok('首页清单显示的是换过的动作', tp4.data.items[0].cn === '上斜卧推', tp4.data.items[0].cn);
ok('换过的动作做过 → 打勾（旧版这里永远不打勾）', tp4.data.items[0].done === true);
ok('清单上有「已换」标记', tp4.data.items[0].swapped === true);

/* ================= 5. 训练页视觉层：杠铃 / 大数字 / 按钮 ================= */
console.log('\n=== 5. 训练页视觉层 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

let rv = loadPage('./pages/record/index');
rv.onLoad({});
ok('杠铃片数按重量算（50kg → 5 片）', rv.data.leftPlates.length === 5, rv.data.leftPlates.length + ' 片');
ok('两侧片数对称', rv.data.rightPlates.length === rv.data.leftPlates.length);
ok('还没练 → 一片都不亮', rv.data.leftPlates.every(function (x) { return !x.on; }));
ok('大数字是重量', rv.data.bigNum === 50 && rv.data.bigUnit === 'kg', rv.data.bigNum + rv.data.bigUnit);
ok('组进度点 = 计划组数', rv.data.setDots.length === 4, rv.data.setDots.length + ' 个');
ok('目标文案', rv.data.targetText === '4 组 × 10 次', rv.data.targetText);
ok('动作要点来自动作库', String(rv.data.ex.tips).indexOf('肩胛') === 0, rv.data.ex.tips);
ok('按钮是「完成第 1 组」', rv.data.btnText.indexOf('完成第 1 组') === 0, rv.data.btnText);

rv.mainAction();
ok('点一次按钮 = 完成一组', rv.data.doneCount === 1, rv.data.doneCount + ' 组');
ok('杠铃亮了至少一片', rv.data.leftPlates.filter(function (x) { return x.on; }).length >= 1,
  rv.data.leftPlates.filter(function (x) { return x.on; }).length + ' 片亮');
ok('完成后自动进入组间休息', rv.data.resting === true);
rv.stopRest();

rv.mainAction(); rv.stopRest();
rv.mainAction(); rv.stopRest();
rv.mainAction(); rv.stopRest();
ok('4 组全部完成', rv.data.doneCount === 4, rv.data.doneCount + ' 组');
ok('杠铃全亮', rv.data.leftPlates.every(function (x) { return x.on; }));
ok('按钮推进到下一个动作', rv.data.btnText === '下一个动作 →', rv.data.btnText);
ok('本次容量 = 50×10×4', rv.data.volumeText === '2000 kg', rv.data.volumeText);

/* ================= 6. PR 组亮陶土色 ================= */
console.log('\n=== 6. PR 片 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const pp = db.todaySession(today).plan;
// 昨天同一动作 40kg 做满 4 组（planKey 写个不存在的，免得推进训练日）
[1, 2, 3, 4].forEach(function (no) { rec(pp.items[0], no, 40, 'X', D.shift(today, -1)); });

let prPage = loadPage('./pages/record/index');
prPage.onLoad({});
ok('上次 40kg 做满 → 今天建议 42.5kg', prPage.data.sets[0].weight === 42.5, prPage.data.sets[0].weight + 'kg');
ok('还没完成 → 没有 PR 片', prPage.data.leftPlates.some(function (x) { return x.pr; }) === false);

prPage.mainAction();
prPage.stopRest();
ok('完成一组后出现陶土色 PR 片', prPage.data.leftPlates.some(function (x) { return x.pr; }) === true,
  prPage.data.leftPlates.map(function (x) { return x.on ? (x.pr ? 'PR' : '亮') : '·'; }).join(''));

/* ================= 结果 ================= */
console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '页面测试全部通过') + '\n');
if (failed) process.exitCode = 1;
