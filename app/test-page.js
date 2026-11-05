/**
 * 页面级自测：mock 掉小程序运行时，直接跑 today / record 的页面逻辑
 * 跑法：node test-page.js
 *
 * 数据层有 test.js，这个文件补的是「页面到底渲染出什么」——
 * 恢复已勾选组、从哪个动作开始、文案四态、按钮跳哪。
 */

const store = {};
const calls = [];
let modalConfirm = true;      // 测试里控制 showModal 点「确定」还是「取消」

global.wx = {
  getStorageSync(k) { return store[k] === undefined ? '' : store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; },
  showToast(o) { calls.push(['toast', o.title]); },
  showModal(o) {
    calls.push(['modal', o.title]);
    if (o.success) o.success({ confirm: modalConfirm, cancel: !modalConfirm });
  },
  navigateTo(o) { calls.push(['nav', o.url]); },
  redirectTo(o) { calls.push(['redirect', o.url]); },
  switchTab(o) { calls.push(['tab', o.url]); },
  navigateBack() { calls.push(['back']); },
  vibrateShort() { },
  createSelectorQuery() {
    const q = { in: () => q, select: () => q, fields: () => q, exec: (cb) => { if (cb) cb([]); } };
    return q;
  },
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

// 页面测试不需要真同步：dev 环境下同步默认打开，写记录会真去连本地后端，进程会挂在那儿等超时
require('./utils/config').setApiBase(null);

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

/* ---- 数据页日历：点某天 → 那天的战报 ---- */
console.log('\n=== 8b. 日历回看 ===');
calls.length = 0;
statsPage.openDay({ currentTarget: { dataset: { date: '2026-10-27', on: true } } });
ok('点练过的日子 → 跳那天的战报',
  calls.length === 1 && calls[0][1] === '/pages/report/index?date=2026-10-27', JSON.stringify(calls));

calls.length = 0;
statsPage.openDay({ currentTarget: { dataset: { date: '2026-10-03', on: false } } });
ok('点没练的日子 → 只提示、不跳转',
  calls.length === 1 && calls[0][0] === 'toast' && calls[0][1] === '这天没练', JSON.stringify(calls));

// 日历每格都带完整日期（战报页靠它跳）
const stCells = statsPage.data.cells;
ok('日历格子带 YYYY-MM-DD',
  stCells.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(stCells[0].date),
  stCells.length ? stCells[0].date : '（空）');

/* ---- 战报页：翻回去的那天不许说「今天」 ---- */
// 造一条 3 天前的记录（示例数据只铺了过去的周，本月的日子本来空着）
const pastDate = D.shift(D.today(), -3);
db.saveSet({
  date: pastDate, exId: item0.exId, setNo: 1, exCn: item0.cn, part: item0.part,
  planKey: 'A', sig: db.planSig(), weight: item0.weight || 0, reps: item0.reps,
  unit: item0.unit, done: true
});

const pastReport = loadPage('./pages/report/index');
pastReport.onLoad({ date: pastDate });
ok('过去的战报 → 标题是「那天」', pastReport.data.isToday === false && pastReport.data.head === '那天练完了。',
  pastReport.data.head);
ok('过去的战报 → 按钮是「回到数据」', pastReport.data.btnText === '回到数据', pastReport.data.btnText);
calls.length = 0;
pastReport.done();
ok('过去的战报 → 退回上一页，不跳「今天」', calls.length === 1 && calls[0][0] === 'back', JSON.stringify(calls));

const emptyPast = loadPage('./pages/report/index');
emptyPast.onLoad({ date: D.shift(D.today(), -9) });
ok('过去那天没记录 → 说「那天没有记录」', emptyPast.data.head === '那天没有记录。', emptyPast.data.head);

const todayReport = loadPage('./pages/report/index');
todayReport.onLoad({ date: D.today() });
ok('今天的战报不受影响（今天 + 完成）',
  todayReport.data.isToday === true && todayReport.data.btnText === '完成', todayReport.data.head);
calls.length = 0;
todayReport.done();
ok('今天的战报 → 仍然回今天的训练页', calls.length === 1 && calls[0][0] === 'tab', JSON.stringify(calls));

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
  ok('没有 loader 时页面不卡（要点本地就有）', !!ep.data.ex.tips);

  /* ---- 9.2 拉到 steps + 大图 ---- */
  fakeDetail({ steps: ['躺下，肩胛后收', '起杠，落到胸口', '推起，别锁死肘'], imgDetail: 'https://cdn.example.com/g1.jpg' });
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g1' });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('请求路径是 /exercises/{id}', detailCalls.length === 1 && detailCalls[0][0] === '/exercises/g1',
    JSON.stringify(detailCalls));
  ok('现在不再渲染步骤', ep.data.steps === undefined);
  ok('大图地址进了页面', ep.data.imgUrl === 'https://cdn.example.com/g1.jpg', ep.data.imgUrl);
  ok('动作档案 5 项都在（难度/器材/肌群/单双侧/类型）',
    ep.data.metaRows.length === 5 && ep.data.metaRows[4].k === '类型',
    ep.data.metaRows.map(function (x) { return x.k + '=' + x.v; }).join(' · '));
  ok('页面不再有加载/失败态字段', ep.data.loading === undefined && ep.data.failed === undefined);

  /* ---- 9.2b 再进来一次走缓存，不重复打后端 ---- */
  const callsBefore = detailCalls.length;
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g1' });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('7 天内再进同一个动作不重复请求（走详情缓存）', detailCalls.length === callsBefore,
    callsBefore + ' → ' + detailCalls.length);
  ok('缓存里也能拿到插画地址', ep.data.imgUrl === 'https://cdn.example.com/g1.jpg', ep.data.imgUrl);

  /* ---- 9.3 请求失败：不阻塞，要点照旧（换一个没缓存的 id） ---- */
  CAT.setDetailLoader(function () { return Promise.reject(new Error('network')); });
  ep = loadPage('./pages/exercise/index');
  ep.onLoad({ id: 'g15' });
  await new Promise(function (r) { setTimeout(r, 0); });
  ok('拉不到讲解不崩、也不留破图框', ep.data.imgUrl === '');
  ok('拉不到讲解时标题和要点没丢', ep.data.ex.cn === '上斜卧推' && !!ep.data.ex.tips, ep.data.ex.cn);
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
  ok('自建动作不额外打后端、页面照常', ep.data.ex.cn === '绳索夹胸');
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

  /* ---- 11. 打勾校验 / 撤销要确认 ---- */
  console.log('\n=== 11. 打勾校验 / 撤销确认 ===');

  db.resetAll();
  db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
  const rc = loadPage('./pages/record/index');
  rc.onLoad({});
  const exIdNow = rc.data.ex.exId;

  ok('负重动作：没重量不许打勾（提示先填重量）',
    rc.validateSet({ unit: 'kg', weight: 0, reps: 8 }) === '先填这组的重量');
  ok('自重动作：没重量可以打勾（只要填了次数）',
    rc.validateSet({ unit: 'bw', weight: 0, reps: 8 }) === '');
  ok('计时动作：没秒数不许打勾',
    rc.validateSet({ unit: 'sec', weight: 0, reps: 0 }) === '先填这组撑了几秒');
  ok('次数为 0 一律不许打勾',
    rc.validateSet({ unit: 'kg', weight: 50, reps: 0 }) === '先填这组做了几次');

  rc.onWeightChange({ detail: { no: 1, value: 0 } });
  rc.onRepsChange({ detail: { no: 1, value: 8 } });
  calls.length = 0;
  rc.onToggle({ detail: { no: 1 } });
  ok('重量空着点勾 → 只有提示，不算完成',
    rc.data.sets[0].done === false && calls.some(function (c) { return c[0] === 'toast'; }),
    JSON.stringify(calls));
  ok('被拦下的那组没有写进库', db.todaySets(rc.date).length === 0, db.todaySets(rc.date).length);

  rc.onWeightChange({ detail: { no: 1, value: 50 } });
  rc.onRepsChange({ detail: { no: 1, value: 0 } });
  rc.onToggle({ detail: { no: 1 } });
  ok('次数空着点勾 → 也不算完成', rc.data.sets[0].done === false && db.todaySets(rc.date).length === 0);

  rc.onRepsChange({ detail: { no: 1, value: 8 } });
  rc.onToggle({ detail: { no: 1 } });
  ok('数字填好之后才能打勾', rc.data.sets[0].done === true && db.todaySets(rc.date).length === 1,
    db.todaySets(rc.date).length + ' 组');

  // 撤销：默认「不动它」
  modalConfirm = false;
  calls.length = 0;
  rc.onToggle({ detail: { no: 1 } });
  ok('点已完成的勾 → 弹确认，不是直接删',
    calls.some(function (c) { return c[0] === 'modal'; }) && db.todaySets(rc.date).length === 1,
    JSON.stringify(calls));
  ok('选了「不动它」那组还在', rc.data.sets[0].done === true && db.todaySets(rc.date).length === 1);

  // 确认撤销
  modalConfirm = true;
  rc.onToggle({ detail: { no: 1 } });
  ok('确认之后才真的撤销（记录也跟着删掉）',
    db.todaySets(rc.date).length === 0 && rc.data.sets[0].done === false);

  // 底部按钮走同一条校验
  rc.onWeightChange({ detail: { no: 1, value: 0 } });
  rc.onRepsChange({ detail: { no: 1, value: 8 } });
  calls.length = 0;
  rc.mainAction();
  ok('底部「完成这组」也拦：没重量不算完成',
    rc.data.sets[0].done === false && calls.some(function (c) { return c[0] === 'toast'; }),
    JSON.stringify(calls));
  ok('底部按钮被拦时也没有落库', db.todaySets(rc.date).length === 0);

  // 已完成的组不能被改成不合法值
  rc.onWeightChange({ detail: { no: 1, value: 50 } });
  rc.onRepsChange({ detail: { no: 1, value: 8 } });
  rc.onToggle({ detail: { no: 1 } });
  calls.length = 0;
  rc.onWeightChange({ detail: { no: 1, value: 0 } });
  const kept = db.todaySets(rc.date)[0];
  ok('已完成的组把重量改成空 → 拒绝，并保留原值',
    !!kept && kept.weight === 50 && calls.some(function (c) { return c[0] === 'toast'; }),
    kept && kept.weight);

  /* ---- 12. 进步页（P7 · V2） ---- */
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

  /* ================= 指标补录（可以往回录） ================= */
  console.log('\n=== 8c. 指标补录 ===');
  const MP = loadPage('./pages/metrics/index');
  MP.onLoad();
  MP.onShow();
  ok('默认选中今天', MP.data.pickDate === D.today() && MP.data.pickLabel === '今天',
    MP.data.pickDate + ' / ' + MP.data.pickLabel);

  const yDay = D.shift(D.today(), -1);
  MP.onPickDate({ detail: { value: yDay } });
  ok('选昨天 → 标签变「昨天」', MP.data.pickLabel === '昨天', MP.data.pickLabel);

  MP.onInput({ detail: { value: '71.4' } });
  MP.save();
  const yRow = db.metricOf('weight', yDay);
  ok('补录的值落在选中的那天', !!yRow && yRow.value === 71.4, yRow ? String(yRow.value) : 'null');
  ok('不会顺手把今天也写脏', !db.metricOf('weight', D.today()), JSON.stringify(db.metricOf('weight', D.today())));

  MP.pickRow({ currentTarget: { dataset: { date: yDay } } });
  ok('点记录行 → 切到那天', MP.data.pickDate === yDay, MP.data.pickDate);
  ok('切到那天后输入框是那天的值', MP.data.inputValue === '71.4', MP.data.inputValue);

  MP.removeAt({ currentTarget: { dataset: { date: yDay } } });
  ok('× 能删掉指定那天的值', !db.metricOf('weight', yDay), JSON.stringify(db.metricOf('weight', yDay)));

  /* ================= 同步状态（我的页那一栏） ================= */
  console.log('\n=== 8d. 同步状态 ===');
  const CFG = require('./utils/config');
  const myPage = loadPage('./pages/my/index');
  myPage.onLoad();
  myPage.onShow();
  ok('没接后端 → 说「本地模式」', myPage.data.syncState === 'local' && myPage.data.syncTitle === '本地模式',
    myPage.data.syncState + ' / ' + myPage.data.syncTitle);

  CFG.setApiBase('http://fake.local/api');
  myPage.refresh();
  ok('接了后端 → 不再说本地模式', myPage.data.syncState !== 'local',
    myPage.data.syncState + ' / ' + myPage.data.syncTitle);

  CFG.setApiBase(null);
  myPage.refresh();
  calls.length = 0;
  myPage.tapSync();
  ok('本地模式点同步 → 只说实话，不发请求', calls.length === 1 && calls[0][0] === 'toast', JSON.stringify(calls));

  CAT.setDetailLoader(null);
  runResult();
})();

/* ================= 结果 ================= */
function runResult() {
  // 同步层会留轮询 / 退避定时器，dev 环境还可能挂着未完成请求；测试跑完直接退出，别让 node 挂着等超时
  try { require('./utils/sync').stop(); } catch (e) { /* 忽略 */ }
  console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '页面测试全部通过') + '\n');
  process.exit(failed ? 1 : 0);
}
