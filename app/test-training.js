/**
 * 训练记录数据层自测：先选动作再记组、取消（墓碑）、热身组、跨零点、按月分片、待上传队列
 * 跑法：node test-training.js
 *
 * 对应 docs/设计文档/训练记录.md v0.2 与 训练记录-前端接口.md。
 */

const mem = {};
global.wx = {
  getStorageSync(k) { return mem[k] === undefined ? '' : mem[k]; },
  setStorageSync(k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync(k) { delete mem[k]; }
};

const db = require('./utils/db');
const S = require('./utils/storage');
const CFG = require('./utils/config');
const D = require('./utils/date');

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}

/** 本地时间的 ISO 串：new Date(2026, 9, 31, 10, 0) 这种，避免受时区影响 */
function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi || 0).toISOString();
}

function fresh(opts) {
  CFG.setApiBase(null);
  db.resetAll();
  if (!opts || !opts.noPlan) db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
}

function set(date, exId, no, weight, reps, extra) {
  return db.saveSet(Object.assign({ date: date, exId: exId, setNo: no, weight: weight, reps: reps,
    unit: (db.exerciseById(exId) || {}).unit || 'kg' }, extra || {}));
}

const T = '2026-10-31';    // 固定一天做样本（周六）

/* ================= 1. 按月分片存储 ================= */
console.log('\n=== 1. 按月分片存储 ===');
fresh();
set('2026-09-30', 'g1', 1, 50, 10, { completedAt: at(2026, 9, 30, 18) });
set(T, 'g1', 1, 52.5, 10, { completedAt: at(2026, 10, 31, 10) });
ok('组记录按月分 key', Array.isArray(mem['lj.sets.2026-09']) && Array.isArray(mem['lj.sets.2026-10']),
  Object.keys(mem).filter(function (k) { return k.indexOf('lj.sets.') === 0; }).join(' '));
ok('不再写老的 lj.sets', mem['lj.sets'] === undefined);
ok('月份清单', JSON.stringify(mem['lj.sets.months']) === '["2026-09","2026-10"]', JSON.stringify(mem['lj.sets.months']));
ok('一次训练按年分 key', Array.isArray(mem['lj.workouts.2026']) && mem['lj.workouts.2026'].length === 2);

// 老版本：全部记录一个 key；示例数据的 id 组号从 0 起
fresh();
mem['lj.sets'] = [
  { id: '2026-10-01-g1-1', date: '2026-10-01', exId: 'g1', setNo: 1, weight: 50, reps: 10, unit: 'kg', done: true },
  { id: '2026-10-02-g6-0', date: '2026-10-02', exId: 'g6', setNo: 1, weight: 40, reps: 10, unit: 'kg', done: true }
];
S.reset();
ok('老数据迁移后条数不变', db.allSets().length === 2, db.allSets().length);
ok('老 key 已删除', mem['lj.sets'] === undefined);
ok('组号从 0 起的老示例数据被认出来', db.allSets().filter(function (s) { return s.demo; }).length === 1);

/* ================= 2. 选动作：计划推荐 + 自己选 ================= */
console.log('\n=== 2. 先选动作再记组 ===');
fresh();
let w = db.todayWorkout(T);
ok('有计划 → plan 模式', w.mode === 'plan' && w.plan.key === 'A', w.mode + ' ' + (w.plan && w.plan.name));
ok('今天还没练 → idle', w.status === 'idle');
ok('推荐的是计划动作，都还没练', w.exercises.length === 4 && w.exercises.every(function (b) { return b.status === 'todo' && b.source === 'plan'; }));
ok('当前动作 = 第一个计划动作', w.current === w.exercises[0].exId, w.current);

// 先做一个计划外的动作：上斜卧推（g15）3 组
const g15 = db.exercisePrefill('g15', T);
ok('自选动作没练过 → 基线重量 × 水平', g15.reason === 'first' && g15.weight === db.initialWeight('g15'), g15.weight + 'kg');
ok('第一组组号是 1', g15.nextSetNo === 1);
[1, 2, 3].forEach(function (n) { set(T, 'g15', n, 40, 10, { completedAt: at(2026, 10, 31, 10, n) }); });

// 再做计划里的卧推（g1）2 组
set(T, 'g1', 1, 50, 10, { slot: 0, targetReps: 10, targetSets: 4, completedAt: at(2026, 10, 31, 10, 20) });
set(T, 'g1', 2, 50, 10, { slot: 0, targetReps: 10, targetSets: 4, completedAt: at(2026, 10, 31, 10, 22) });

// 回到上斜卧推再加一组
ok('回到做过的动作，组号接着往下编', db.nextSetNo('g15', T) === 4 && db.exercisePrefill('g15', T).nextSetNo === 4);
set(T, 'g15', 4, 40, 8, { completedAt: at(2026, 10, 31, 10, 30) });

w = db.todayWorkout(T);
const ids = w.exercises.map(function (b) { return b.exId; });
ok('顺序按第一组完成时刻：上斜卧推在卧推前', ids[0] === 'g15' && ids[1] === 'g1', ids.join(','));
ok('上斜卧推 4 组，组号 1–4', w.exercises[0].sets.map(function (s) { return s.setNo; }).join('') === '1234');
ok('自己选的动作 source=manual、slot=null', w.exercises[0].source === 'manual' && w.exercises[0].slot === null);
ok('计划动作 source=plan，做了 2/4 组 → doing', w.exercises[1].source === 'plan' && w.exercises[1].status === 'doing');
ok('没练的计划动作排在后面', w.exercises.slice(2).every(function (b) { return b.status === 'todo'; }), w.exercises.length + ' 个');
ok('当前动作 = 第一个还没练的计划动作', w.current === w.exercises[2].exId, w.current);
ok('练了 → active', w.status === 'active');
ok('totals：6 组、2 个动作', w.totals.sets === 6 && w.totals.exercises === 2, JSON.stringify(w.totals));
ok('训练时长 = 最后一组 − 第一组 + 1 分钟', w.minutes === 30, w.minutes + ' 分钟');

// 组数不限
fresh();
for (let n = 1; n <= 15; n++) set(T, 'g1', n, 50, 5, { completedAt: at(2026, 10, 31, 9, n) });
ok('一个动作连做 15 组都能记录', db.todaySets(T).length === 15);

// 没有任何计划的用户：自由训练
fresh({ noPlan: true });
w = db.todayWorkout(T);
ok('没计划 → free 模式', w.mode === 'free' && w.plan === null && w.exercises.length === 0);
ok('没计划且没练 → 没有当前动作（页面直接打开选动作）', w.current === null);
set(T, 'g16', 1, 10, 12, { completedAt: at(2026, 10, 31, 9) });
w = db.todayWorkout(T);
ok('自由训练记一组后，当前动作就是它', w.current === 'g16' && w.exercises[0].status === 'done');
ok('自由训练的战报叫「自由训练」', db.todayReport(T).planName === '自由训练');

/* ================= 3. 一次训练 ================= */
console.log('\n=== 3. 一次训练 ===');
fresh();
ok('一组都没有不能完成训练', db.finishWorkout(T) === false);
const first = set(T, 'g1', 1, 50, 10, { completedAt: at(2026, 10, 31, 10) });
let wk = db.workout(T);
ok('第一组完成时自动创建训练', !!wk && wk.startedAt === first.completedAt);
ok('训练记下训练日和名称', wk.planKey === 'A' && wk.planName === '推日', wk.planKey + ' ' + wk.planName);
ok('还没点完成 → finishedAt 为空', wk.finishedAt === null);
ok('完成训练', db.finishWorkout(T) === true && !!db.workout(T).finishedAt);
ok('完成后状态 finished', db.todayWorkout(T).status === 'finished');

/* ================= 4. 修改与取消 ================= */
console.log('\n=== 4. 修改与取消 ===');
fresh();
const s1 = set(T, 'g1', 1, 50, 10, { completedAt: at(2026, 10, 31, 10) });
set(T, 'g1', 2, 50, 10, { completedAt: at(2026, 10, 31, 10, 3) });
const edited = set(T, 'g1', 1, 52.5, 8);
ok('改已完成组的数字，完成时刻不变', edited.completedAt === s1.completedAt && edited.weight === 52.5);

// 纯本地：取消 = 直接删
ok('取消一组', db.uncheckSet({ date: T, exId: 'g1', setNo: 2 }) === true);
ok('取消后统计不再算它', db.todaySets(T).length === 1 && db.todayReport(T).sets === 1);
ok('纯本地模式不留墓碑', S.rows().length === 1);
ok('取消不存在的组返回 false', db.uncheckSet({ date: T, exId: 'g1', setNo: 9 }) === false);
db.uncheckSet({ date: T, exId: 'g1', setNo: 1 });
ok('当天组全部取消 → 训练也取消', db.workout(T) === null);
ok('今天页回到 idle', db.todayWorkout(T).status === 'idle');

// 同步打开：取消 = 墓碑
fresh();
CFG.setApiBase('http://test');
set(T, 'g1', 1, 50, 10, { completedAt: at(2026, 10, 31, 10) });
db.uncheckSet({ date: T, exId: 'g1', setNo: 1 });
const tomb = S.get(S.rowId({ date: T, exId: 'g1', setNo: 1 }));
ok('同步模式写墓碑 done=false', tomb && tomb.done === false);
ok('墓碑不参与统计', db.todaySets(T).length === 0 && db.todayReport(T).sets === 0);
ok('墓碑进待上传队列', !!S.dirtyMap()[tomb.id]);
ok('训练也写成墓碑', S.workout(T) && S.workout(T).done === false && db.workout(T) === null);
set(T, 'g1', 1, 50, 10);
ok('再完成同一组 → 恢复', db.todaySets(T).length === 1 && db.workout(T) !== null);
CFG.setApiBase(null);

/* ================= 5. 热身组 ================= */
console.log('\n=== 5. 热身组 ===');
fresh();
// 昨天：热身 60kg × 3（比正式组还重），正式 50kg × 10 × 4 组做满
const Y = '2026-10-30';
set(Y, 'g1', 1, 60, 3, { warmup: true, completedAt: at(2026, 10, 30, 18) });
[2, 3, 4, 5].forEach(function (n) {
  set(Y, 'g1', n, 50, 10, { slot: 0, targetReps: 10, targetSets: 4, completedAt: at(2026, 10, 30, 18, n) });
});
ok('上次成绩不算热身组', db.lastRecord('g1', T).weight === 50 && db.lastRecord('g1', T).sets === 4,
  JSON.stringify(db.lastRecord('g1', T)));
ok('最大重量不算热身组', db.maxWeightBefore('g1', T) === 50);
const sugW = db.suggestWeight('g1', 10, 4, T);
ok('加重建议以正式组为基准：50 → 52.5', sugW.reason === 'up' && sugW.weight === 52.5, sugW.weight);
ok('战报组数、吨数不算热身组', db.todayReport(Y).sets === 4 && db.todayReport(Y).ton === 2, db.todayReport(Y).ton + ' 吨');
set(T, 'g1', 1, 55, 3, { warmup: true, completedAt: at(2026, 10, 31, 10) });
ok('今天热身组比历史重也不算 PR', db.detectPRs(T).length === 0);
ok('热身组在明细里带标记、不标 PR', (function () {
  const st = db.todayWorkout(T).exercises[0].sets[0];
  return st.warmup === true && st.pr === false;
})());

/* ================= 6. 预填与加重提示 ================= */
console.log('\n=== 6. 预填与加重提示 ===');
// 来自计划：拿当时存的目标判断，不拿现在的计划
fresh();
// planKey 写个不存在的：不推进训练日，今天仍然是含卧推的 A
[1, 2, 3].forEach(function (n) {
  set(Y, 'g1', n, 50, 8, { planKey: 'X', slot: 0, targetReps: 8, targetSets: 3, completedAt: at(2026, 10, 30, 18, n) });
});
const byOld = db.suggestWeight('g1', 10, 4, T);   // 现在的计划是 4 × 10
ok('当时目标 3 × 8 做满了 → 加重（不按现在的 4 × 10 判）', byOld.reason === 'up', byOld.reason);
const pf = db.exercisePrefill('g1', T);
ok('计划动作预填加一档', pf.reason === 'up' && pf.weight === 52.5 && pf.hintText.indexOf('加 2.5') >= 0, pf.hintText);
ok('上次成绩文案', pf.lastText === '上次 50 kg × 8 × 3 组', pf.lastText);

// 自己选的动作：只提示，不自动加
fresh();
[1, 2, 3].forEach(function (n) { set(Y, 'g16', n, 10, 12, { completedAt: at(2026, 10, 30, 18, n) }); });
const hint = db.exercisePrefill('g16', T);
ok('自选动作每组都 ≥ 10 次 → 提示可以加', hint.reason === 'hint' && hint.step === 2.5, hint.hintText);
ok('提示但不自动加：预填仍是上次的 10kg × 12', hint.weight === 10 && hint.reps === 12);
ok('建议组数 = 上次组数', hint.sets === 3);
fresh();
[1, 2].forEach(function (n) { set(Y, 'g16', n, 12.5, 8, { completedAt: at(2026, 10, 30, 18, n) }); });
const keep = db.exercisePrefill('g16', T);
ok('自选动作没到 10 次 → 保持，不提示', keep.reason === 'keep' && keep.hintText === '' && keep.weight === 12.5);
ok('自选的自重动作没历史 → 按水平给默认次数', db.exercisePrefill('h1', T).reps > 0 && db.exercisePrefill('h1', T).weight === 0);

/* ================= 7. 跨零点 ================= */
console.log('\n=== 7. 跨零点 ===');
fresh();
set('2026-10-30', 'g1', 1, 50, 10, { completedAt: at(2026, 10, 30, 23, 50) });
ok('00:20 打开：昨晚没点完成、3 小时内 → 仍记在昨天',
  db.trainingDate(new Date(2026, 9, 31, 0, 20).getTime()) === '2026-10-30');
ok('08:00 打开 → 今天', db.trainingDate(new Date(2026, 9, 31, 8, 0).getTime()) === '2026-10-31');
db.finishWorkout('2026-10-30');
ok('昨晚点了完成 → 零点后就是今天', db.trainingDate(new Date(2026, 9, 31, 0, 20).getTime()) === '2026-10-31');

/* ================= 8. 换动作与选动作面板 ================= */
console.log('\n=== 8. 换动作与选动作面板 ===');
fresh();
const planA = db.todaySession(T).plan;
const inPlan = planA.items.map(function (it) { return it.exId; });
set(T, 'g16', 1, 10, 12, { completedAt: at(2026, 10, 31, 10) });   // 今天练过哑铃飞鸟
const alts = db.alternatives('g1', 'A').map(function (e) { return e.id; });
ok('换动作候选排除训练日里已有的动作', alts.every(function (id) { return inPlan.indexOf(id) < 0; }), alts.join(','));
ok('换动作候选排除今天已练的动作', alts.indexOf('g16') < 0);
ok('不传训练日时行为不变', db.alternatives('g1').some(function (e) { return e.id === 'g16'; }));

set(T, 'g1', 1, 50, 10, { slot: 0, completedAt: at(2026, 10, 31, 10, 5) });
const pick = db.pickableExercises({ date: T });
ok('推荐里没有今天已练的计划动作', pick.recommended.every(function (r) { return r.exId !== 'g1'; }) && pick.recommended.length === 3,
  pick.recommended.map(function (r) { return r.cn; }).join(' / '));
ok('动作库按部位分组', pick.groups.length > 0 && pick.groups.every(function (g) { return g.items.length > 0; }));
ok('默认只列用户设置的场所（健身房）', pick.groups.every(function (g) { return g.items.every(function (i) { return i.place === 'gym'; }); }));
const chest = pick.groups.filter(function (g) { return g.part === 'chest'; })[0];
ok('今天练过的标出来', chest.items.filter(function (i) { return i.exId === 'g16'; })[0].doneToday === true);
ok('按部位筛选', db.pickableExercises({ date: T, part: 'back' }).groups.every(function (g) { return g.part === 'back'; }));
ok('按关键词搜', db.pickableExercises({ date: T, keyword: '飞鸟' }).groups.reduce(function (a, g) { return a + g.items.length; }, 0) >= 1);
ok('place=all 包含居家动作', db.pickableExercises({ date: T, place: 'all' }).groups.some(function (g) {
  return g.items.some(function (i) { return i.place === 'home'; });
}));

/* ================= 9. 战报 ================= */
console.log('\n=== 9. 战报 ===');
fresh();
set(T, 'g16', 1, 10, 12, { completedAt: at(2026, 10, 31, 10, 0) });
set(T, 'g1', 1, 50, 10, { slot: 0, completedAt: at(2026, 10, 31, 10, 10) });
set(T, 'g1', 2, 50, 10, { slot: 0, completedAt: at(2026, 10, 31, 10, 14) });
const rep = db.todayReport(T);
ok('战报有训练时长', rep.minutes === 15, rep.minutes + ' 分钟');
ok('战报动作按完成先后', rep.blocks.map(function (b) { return b.exId; }).join(',') === 'g16,g1');
ok('战报的训练日名称', rep.planName === '推日');

/* ================= 10. 示例数据 ================= */
console.log('\n=== 10. 示例数据 ===');
fresh();
const n = db.loadDemo();
ok('示例数据生成', n > 0, n + ' 条');
ok('示例数据都带 demo 标记和完成时刻', db.allSets().every(function (s) { return s.demo && !!s.completedAt; }));
ok('示例数据组号从 1 起', db.allSets().every(function (s) { return s.id === s.date + '-' + s.exId + '-' + s.setNo && s.setNo >= 1; }));
ok('示例训练日都有「一次训练」', S.workouts().length > 0 && S.workouts().every(function (x) { return x.demo && x.finishedAt; }));
S.markAllDirty();
ok('示例数据永不进上传队列', S.pendingCount() === 0);

/* ================= 11. 待上传队列 ================= */
console.log('\n=== 11. 待上传队列 ===');
fresh();
set(T, 'g1', 1, 50, 10);
ok('同步关闭时不进队列', S.pendingCount() === 0);
CFG.setApiBase('http://test');
set(T, 'g1', 2, 50, 10);
const batch = S.dirtyBatch(500);
ok('同步打开：组记录进队列', batch.rows.length === 1 && batch.rows[0].setNo === 2);
ok('第一组时创建的训练不在队列里（那时同步还没开），之后的改动会进', batch.workouts.length === 0);
db.finishWorkout(T);
const batch2 = S.dirtyBatch(500);
ok('训练改动进队列', batch2.workouts.length === 1 && batch2.workouts[0].date === T);

set(T, 'g1', 2, 55, 10);           // 上传途中又改了
S.ack(batch2.sent);
ok('上传途中又改过的行留在队列', !!S.dirtyMap()[S.rowId({ date: T, exId: 'g1', setNo: 2 })]);
ok('没再改过的训练出队', !S.dirtyMap()['w:' + T]);

const b3 = S.dirtyBatch(500);
db.uncheckSet({ date: T, exId: 'g1', setNo: 1 });
S.ack(S.dirtyBatch(500).sent);
ok('确认上传的墓碑在本地物理删除', S.get(S.rowId({ date: T, exId: 'g1', setNo: 1 })) === null);
ok('队列清空', S.pendingCount() === 0, b3.rows.length);

// 服务端下发
S.applyRemote([{ date: T, exId: 'g6', setNo: 1, weight: 40, reps: 10, unit: 'kg', done: true }]);
ok('应用其他设备的组记录', db.todaySets(T).some(function (s) { return s.exId === 'g6'; }));
set(T, 'g1', 2, 60, 10);           // 本地有未上传的改动
S.applyRemote([{ date: T, exId: 'g1', setNo: 2, weight: 45, reps: 10, unit: 'kg', done: true }]);
ok('本地有未上传改动时不被服务端旧值覆盖', S.get(S.rowId({ date: T, exId: 'g1', setNo: 2 })).weight === 60);
S.ack(S.dirtyBatch(500).sent);
S.applyRemoteWorkouts([Object.assign({}, db.workout(T), { startedAt: '2026-10-31T00:00:00.000Z' })]);
ok('应用服务端合并后的训练', db.workout(T).startedAt === '2026-10-31T00:00:00.000Z');

// 清空：同步打开时写墓碑，其他设备也会清掉
db.clearSets();
ok('同步模式清空 → 有效记录为 0', db.allSets().length === 0 && db.workout(T) === null);
ok('同步模式清空 → 墓碑进队列', S.dirtyBatch(500).rows.every(function (r) { return r.done === false; }) && S.pendingCount() > 0);
CFG.setApiBase(null);

console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '训练数据层测试全部通过') + '\n');
if (failed) process.exitCode = 1;
