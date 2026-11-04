/**
 * 身体指标数据层自测（P5 · M1）
 * 跑法：node test-metrics.js
 *
 * 只测数据层：存储、去重、序列、墓碑、上传队列、下发应用。
 * 页面渲染另外看（_cache/render_pages.js 会把 metrics 页也渲染出来）。
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

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}

function fresh() {
  Object.keys(mem).forEach(function (k) { delete mem[k]; });
  S.reset();
  CFG.setApiBase(null);        // 默认：纯本地（同步关）
}

/* ---------------- 1. 基本存取 ---------------- */

console.log('\n=== 1. 存取与范围校验 ===');
fresh();

const saved = db.saveMetric({ kind: 'weight', date: '2026-11-01', value: 72.34 });
ok('存一条体重', !!saved && saved.value === 72.3, saved && saved.value);
ok('单位跟着 kind 走', saved && saved.unit === 'kg', saved && saved.unit);
ok('同一天再存是覆盖不是新增', db.metricSeries('weight').length === 1, db.metricSeries('weight').length);

const over = db.saveMetric({ kind: 'weight', date: '2026-11-01', value: 500 });
ok('超范围（500kg）被拒绝', over === null, over === null ? 'null' : JSON.stringify(over));
ok('被拒绝时原来那条没被改', db.metricOf('weight', '2026-11-01').value === 72.3,
  db.metricOf('weight', '2026-11-01').value);

ok('未知 kind 被拒绝', db.saveMetric({ kind: 'nope', date: '2026-11-01', value: 1 }) === null);
ok('体脂单位是 %', db.saveMetric({ kind: 'bodyfat', date: '2026-11-01', value: 18.5 }).unit === '%');
ok('心率按 1 取整', db.saveMetric({ kind: 'hrrest', date: '2026-11-01', value: 61.6 }).value === 62);
ok('腰围按 0.5 取整', db.saveMetric({ kind: 'waist', date: '2026-11-01', value: 81.3 }).value === 81.5,
  db.metricOf('waist', '2026-11-01').value);

/* ---------------- 2. 序列与变化 ---------------- */

console.log('\n=== 2. 序列、最新值、变化量 ===');
fresh();

const days = ['2026-09-01', '2026-09-15', '2026-10-01', '2026-10-15', '2026-11-01'];
const weights = [78.0, 77.2, 76.4, 75.6, 74.9];
days.forEach(function (d, i) {
  db.saveMetric({ kind: 'weight', date: d, value: weights[i] });
});

const series = db.metricSeries('weight');
ok('序列按日期升序', series.length === 5 && series[0].date === '2026-09-01',
  series.map(function (r) { return r.date; }).join(','));
ok('序列只含 weight', series.every(function (r) { return r.kind === 'weight'; }));

const latest = db.latestMetric('weight');
ok('最新值是 11-01 的 74.9', latest && latest.date === '2026-11-01' && latest.value === 74.9,
  latest && latest.value);

const delta = db.metricDelta('weight', 30);
ok('和 30 天前比是 -1.5（74.9 vs 76.4）', delta && delta.delta === -1.5, delta && delta.delta);
ok('对比的是 10-01 那条（30 天前是 10-02，取它之前最近的一条）', delta && delta.beforeDate === '2026-10-01',
  delta && delta.beforeDate);

ok('from/to 过滤生效', db.metricSeries('weight', { from: '2026-10-01', to: '2026-10-31' }).length === 2);
ok('limit 取最近 N 条', db.metricSeries('weight', { limit: 2 }).length === 2,
  db.metricSeries('weight', { limit: 2 }).map(function (r) { return r.date; }).join(','));
ok('没有记录时 latest 返回 null', db.latestMetric('hrrest') === null);
ok('没有历史时 delta 返回 null', db.metricDelta('weight', 3000) === null);

/* ---------------- 3. 同步关：不进队列 ---------------- */

console.log('\n=== 3. 同步关闭（纯本地）===');
fresh();
db.saveMetric({ kind: 'weight', date: '2026-11-02', value: 70 });
ok('不进待上传队列', db.syncPending() === 0, db.syncPending());
ok('本地能读到', db.metricOf('weight', '2026-11-02').value === 70);

db.removeMetric('weight', '2026-11-02');
ok('同步关时删除是物理删', S.metric('weight', '2026-11-02') === null);
ok('删除后序列为空', db.metricSeries('weight').length === 0);

/* ---------------- 4. 同步开：进队列 + 墓碑 ---------------- */

console.log('\n=== 4. 同步开启（上传队列与墓碑）===');
fresh();
CFG.setApiBase('http://fake');

db.saveMetric({ kind: 'weight', date: '2026-11-02', value: 70 });
ok('进待上传队列', db.syncPending() === 1, db.syncPending());

const batch = db.syncPullBatch(500);
ok('批次里有 metrics', batch.metrics && batch.metrics.length === 1, batch.metrics && batch.metrics.length);
ok('队列 id 是 m:kind|date', Object.keys(batch.sent)[0] === 'm:weight|2026-11-02',
  Object.keys(batch.sent)[0]);
ok('组记录/训练为空，没串味', batch.rows.length === 0 && batch.workouts.length === 0);

db.syncAck(batch, []);
ok('确认后队列清空', db.syncPending() === 0, db.syncPending());

db.removeMetric('weight', '2026-11-02');
const tomb = S.metric('weight', '2026-11-02');
ok('同步开时删除写墓碑（done=false）', tomb && tomb.done === false, tomb && tomb.done);
ok('墓碑也进队列', db.syncPending() === 1, db.syncPending());
ok('墓碑不出现在序列里', db.metricSeries('weight').length === 0);

const batch2 = db.syncPullBatch(500);
db.syncAck(batch2, []);
ok('墓碑确认后本地物理删掉', S.metric('weight', '2026-11-02') === null);
ok('队列随之清空', db.syncPending() === 0, db.syncPending());

/* ---------------- 5. 服务端下发 ---------------- */

console.log('\n=== 5. 应用服务端下发的指标 ===');
fresh();
CFG.setApiBase('http://fake');

db.syncApply({
  metrics: [
    { kind: 'weight', date: '2026-10-20', value: 75.5, unit: 'kg', note: '', done: true,
      updatedAt: '2026-10-20T08:00:00.000Z' }
  ]
});
ok('下发的值落到本地', db.metricOf('weight', '2026-10-20').value === 75.5);
ok('下发不进上传队列', db.syncPending() === 0, db.syncPending());

// 本地有未上传改动 → 不能被下发覆盖
db.saveMetric({ kind: 'weight', date: '2026-10-20', value: 74.0 });
db.syncApply({
  metrics: [
    { kind: 'weight', date: '2026-10-20', value: 99.9, unit: 'kg', note: '', done: true,
      updatedAt: '2026-10-19T08:00:00.000Z' }
  ]
});
ok('本地有待上传改动时，下发不覆盖', db.metricOf('weight', '2026-10-20').value === 74.0,
  db.metricOf('weight', '2026-10-20').value);

// 下发墓碑 → 本地删
db.syncApply({
  metrics: [
    { kind: 'weight', date: '2026-10-20', value: 74.0, unit: 'kg', note: '', done: false,
      updatedAt: '2026-10-21T08:00:00.000Z' }
  ]
});
ok('下发墓碑时本地还在队列里 → 先不删', S.metric('weight', '2026-10-20') !== null);

/* ---------------- 6. 清理与容量 ---------------- */

console.log('\n=== 6. 按月分片与清空 ===');
fresh();
db.saveMetric({ kind: 'weight', date: '2026-10-31', value: 76 });
db.saveMetric({ kind: 'weight', date: '2026-11-01', value: 75.8 });
const months = mem['lj.metrics.months'];
ok('两个月份两个 key', Array.isArray(months) && months.length === 2, JSON.stringify(months));
ok('每月一个独立 key', !!mem['lj.metrics.2026-10'] && !!mem['lj.metrics.2026-11']);

db.resetAll();
ok('resetAll 后指标清空', db.metricSeries('weight').length === 0);
ok('月份索引也清空', !mem['lj.metrics.months'], mem['lj.metrics.months']);

console.log(failed === 0 ? '\n全部通过' : '\n有 ' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
