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

/* ================= 7. 页面订阅远端变更（C5-b） ================= */
console.log('\n=== 7. 远端变更即时刷新 ===');

const bus = require('./store/index');   // 真 store（上面那个 store 是本地存储 mock）

// 造一条「另一台设备发来的」组记录，直接写存储，绕过 db 的写路径
function remoteSet(it, no) {
  return {
    date: today, exId: it.exId, setNo: no, exCn: it.cn, part: it.part,
    planKey: 'A', sig: db.planSig(),
    weight: it.weight || 0, reps: it.reps, unit: it.unit,
    done: true, updatedAt: new Date().toISOString()
  };
}

db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const item0 = db.todaySession(today).plan.items[0];

const todayPage = loadPage('./pages/today/index');
todayPage.onLoad();
todayPage.onShow();
ok('today 页初始没做任何动作', todayPage.data.doneCount === 0, 'doneCount=' + todayPage.data.doneCount);

db.syncApply({ sets: [remoteSet(item0, 1)] });
ok('只写存储、不通知时页面不会自己变', todayPage.data.doneCount === 0);

bus.touchSets();    // sync.js 应用完远端数据后就是这么通知的
ok('收到通知后 today 页即时刷新（不用切页面）', todayPage.data.doneCount === 1,
  'doneCount=' + todayPage.data.doneCount);
todayPage.onUnload();

// stats 页订阅同一个通知；它的 setData 回调在测试里不会触发，所以不会碰 canvas
const statsPage = loadPage('./pages/stats/index');
statsPage.onLoad();
statsPage.onShow();
const beforeDays = statsPage.data.days;

db.syncApply({ sets: [remoteSet(item0, 2)] });
bus.touchSets();
ok('stats 页也订阅了变更（不报错、数据可重算）',
  typeof statsPage.data.days === 'number' && statsPage.data.days >= beforeDays,
  'days ' + beforeDays + ' → ' + statsPage.data.days);
statsPage.onUnload();

/* ================= 9. 动作详情页（E4） ================= */
console.log('\n=== 9. 动作详情页 ===');

const CAT = require('./utils/catalog');

// 详情页要打后端，这里注一个假 loader，把手动控制返回
let detailCalls = [];
function fakeDetail(out) {
  CAT.setDetailLoader(function (path, opts) {
    detailCalls.push([path, opts && opts.method]);
    return Promise.resolve(out);
  });
}

(async function () {
  /* ---- 9.1 骨架：本地字段同步就位，不等网络 ---- */
  CAT.setDetailLoader(null);
  let ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g1' });
  ok('详情页标题来自本地动作库', ep.data.ex.cn === '卧推', ep.data.ex.cn);
  ok('部位 / 场所 / 记法都翻译成中文',
    ep.data.partCn === '胸' && ep.data.placeCn === '健身房' && ep.data.unitCn === '按重量记',
    [ep.data.partCn, ep.data.placeCn, ep.data.unitCn].join('/'));
  ok('点进详情时要点已经在页面上（不必等网络）', String(ep.data.ex.tips).indexOf('肩胛') === 0, ep.data.ex.tips);
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('没有 loader 时不卡在加载态（降级成「讲解还没补上」）', ep.data.loading === false && ep.data.failed === true,
    'loading=' + ep.data.loading + ' failed=' + ep.data.failed);
  ok('「怎么记」按单位给文案', ep.data.howto.indexOf('按重量记') === 0, ep.data.howto);

  /* ---- 9.2 拉到 steps + 大图 ---- */
  fakeDetail({ steps: ['躺下，肩胛后收', '起杠，落到胸口', '推起，别锁死肘'], imgDetail: 'https://cdn.example.com/g1.jpg' });
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g1' });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('请求路径是 /exercises/{id}', detailCalls.length === 1 && detailCalls[0][0] === '/exercises/g1',
    JSON.stringify(detailCalls));
  ok('步骤渲染成 01/02/03', ep.data.steps.length === 3 && ep.data.steps[2].no === '03',
    ep.data.steps.map(function (s) { return s.no; }).join(','));
  ok('大图地址进了页面', ep.data.imgUrl === 'https://cdn.example.com/g1.jpg', ep.data.imgUrl);
  ok('有内容时不算失败、不在加载态', ep.data.loading === false && ep.data.failed === false);

  /* ---- 9.2b 再进来一次走缓存，不重复打后端 ---- */
  const callsBefore = detailCalls.length;
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g1' });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('7 天内再进同一个动作不重复请求（走详情缓存）', detailCalls.length === callsBefore,
    callsBefore + ' → ' + detailCalls.length);
  ok('缓存里的步骤照样渲染', ep.data.steps.length === 3, ep.data.steps.length + ' 步');

  /* ---- 9.3 请求失败：不阻塞，要点照旧（换一个没缓存的 id） ---- */
  CAT.setDetailLoader(function () { return Promise.reject(new Error('network')); });
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g15' });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('拉不到讲解 → 标失败并给「再试一次」', ep.data.failed === true && ep.data.steps.length === 0);
  ok('失败时标题和要点没丢', ep.data.ex.cn === '上斜卧推' && !!ep.data.ex.tips, ep.data.ex.cn);
  ok('图挂了就当没图（不留破图框）', ep.data.imgUrl === '', ep.data.imgUrl);

  /* ---- 9.4 自建动作：不打后端 ---- */
  db.resetAll();
  db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
  const mine = db.saveCustomExercise({ cn: '绳索夹胸', part: 'chest', place: 'gym', unit: 'kg', tips: '肘别乱飞' });
  detailCalls = [];
  fakeDetail({ steps: ['不该被调用'], imgDetail: '' });
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: mine.exId });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('自建动作不去问服务端（服务端也没有这条）', detailCalls.length === 0, detailCalls.length + ' 次请求');
  ok('自建动作标记成 custom、直接结束加载', ep.data.custom === true && ep.data.loading === false);
  ok('自建动作显示自己的要点', ep.data.ex.tips === '肘别乱飞', ep.data.ex.tips);

  /* ---- 9.5 id 不存在 ---- */
  calls.length = 0;
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'not-exist' });
  ok('找不到动作就提示并退回上一页',
    calls.some(function (c) { return c[0] === 'toast' && c[1] === '没找到这个动作'; }),
    JSON.stringify(calls));

  /* ---- 9.6 训练页入口：动作名旁的「看讲解」跳对地址 ---- */
  db.resetAll();
  db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
  const rp = loadPage('./pages/record/index');
  rp.onLoad({});
  calls.length = 0;
  rp.gotoDetail();
  const exId = rp.data.ex.exId;
  ok('训练页「看讲解」跳到详情页并带上动作 id',
    calls.length === 1 && calls[0][1] === '/pages/exercise/index?id=' + exId,
    JSON.stringify(calls));

  /* ---- 10. 进步页（P7 · V2） ---- */
  console.log('\n=== 10. 进步页 ===');

  db.resetAll();
  db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

  const pgEmpty = loadPage('./pages/progress/index');
  pgEmpty.onLoad();
  pgEmpty.onShow();
  ok('一条记录都没有 → 空态，不画假曲线', pgEmpty.data.empty === true);

  db.loadDemo();
  const pg = loadPage('./pages/progress/index');
  pg.onLoad();
  pg.onShow();
  ok('有示例数据 → 给预览而不是空态', pg.data.empty === false && pg.data.demo === true,
    'empty=' + pg.data.empty + ' demo=' + pg.data.demo);
  ok('全身指数大于 1（练了就有进步）', Number(pg.data.indexText) > 1, pg.data.indexText);
  ok('给出比起点强了百分之几', pg.data.upText.indexOf('+') === 0, pg.data.upText);
  ok('周走势有柱子，且最后一根是本周',
    pg.data.weeks.length > 0 && pg.data.weeks[pg.data.weeks.length - 1].on === true,
    pg.data.weeks.length + ' 根');
  ok('每根柱子都有高度', pg.data.weeks.every(function (w) { return w.h > 0 && w.h <= 100; }));
  ok('肌群列表非空、带中文名', pg.data.parts.length > 0 && !!pg.data.parts[0].name,
    pg.data.parts.map(function (p) { return p.name; }).join(','));
  ok('动作榜非空、每行带状态文案', pg.data.actions.length > 0 && !!pg.data.actions[0].statusCn,
    pg.data.actions.length + ' 个动作');
  ok('高光最多给 6 条', pg.data.highlights.length <= 6 && pg.data.highlights.length > 0,
    pg.data.highlights.length);

  const firstId = pg.data.actions[0].exId;
  pg.toggle({ currentTarget: { dataset: { id: firstId } } });
  ok('点动作行 → 展开最近几次的力量值', pg.data.openId === firstId && pg.data.openSeries.length > 0,
    pg.data.openSeries.length + ' 次');
  ok('展开的数据带着日期和单位', !!pg.data.openSeries[0].date && !!pg.data.openSeries[0].unit);
  ok('展开时说明用的是什么模型', !!pg.data.openModel, pg.data.openModel);
  pg.toggle({ currentTarget: { dataset: { id: firstId } } });
  ok('再点一下收起', pg.data.openId === '' && pg.data.openSeries.length === 0);

  // 真实记录一旦有，就不再拿示例数据讲故事
  ['2026-09-01', '2026-09-05', '2026-09-09'].forEach(function (d) {
    db.saveSet({ date: d, exId: 'g1', setNo: 1, weight: 60, reps: 8, unit: 'kg' });
    db.saveSet({ date: d, exId: 'g1', setNo: 2, weight: 60, reps: 8, unit: 'kg' });
  });
  const pgReal = loadPage('./pages/progress/index');
  pgReal.onLoad();
  pgReal.onShow();
  ok('有真实记录后不再用示例数据', pgReal.data.demo === false);
  ok('真实记录也能算出全身指数', Number(pgReal.data.indexText) >= 1, pgReal.data.indexText);

  const statsEntry = loadPage('./pages/stats/index');
  statsEntry.onLoad();
  calls.length = 0;
  statsEntry.gotoProgress();
  ok('数据页的「强了多少」跳到进步页',
    calls.length === 1 && calls[0][1] === '/pages/progress/index', JSON.stringify(calls));
  statsEntry.onUnload();

  CAT.setDetailLoader(null);
  runResult();
})();

/* ================= 结果 ================= */
function runResult() {
  console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '页面测试全部通过') + '\n');
  if (failed) process.exitCode = 1;
}
