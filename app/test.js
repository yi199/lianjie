/** 本地自测：用 mock 的 wx 存储跑一遍数据层，验证统计逻辑 */

const store = {};
global.wx = {
  getStorageSync(k) { return store[k] === undefined ? '' : store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; }
};

const db = require('./utils/db');
const D = require('./utils/date');
const V = require('./utils/volume');

function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
}

console.log('\n=== 1. 初始化 ===');
db.initSeed();
const sets = db.allSets();
ok('示例记录已写入', sets.length > 0, sets.length + ' 条组记录');
ok('动作字典可读', db.exercises().length === 8, db.exercises().length + ' 个动作');

console.log('\n=== 2. 今天练什么 ===');
const plan = db.todayPlan();
ok('返回计划对象', !!plan, plan.rest ? '今天休息' : plan.name + ' / ' + plan.items.length + ' 个动作');
if (!plan.rest) {
  ok('动作已展开中文名', !!plan.items[0].cn, plan.items[0].cn + ' ' + plan.items[1].cn);
}

console.log('\n=== 3. 上次记录 ===');
if (!plan.rest) {
  const last = db.lastRecord(plan.items[0].exId);
  ok('能查到上次', !!last, last ? (last.weight + 'kg × ' + last.reps + ' × ' + last.sets + '（' + last.daysAgo + ' 天前）') : '无');
}

console.log('\n=== 4. 月度统计 ===');
const m = D.thisMonth();
const st = db.monthlyStats(m.y, m.m);
ok('训练天数', st.days > 0, st.days + ' 天');
const wk = db.weeklyProgress();
ok('本周进度', wk.planned > 0 && wk.done >= 0, wk.done + '/' + wk.planned);
ok('累计吨数', st.ton >= 0, st.ton + ' 吨');
ok('日历格子数 = 当月天数', st.calendar.length === D.daysInMonth(m.y, m.m), st.calendar.length + ' 格');
ok('日历有「练过」的格子', st.calendar.filter(c => c.on).length === st.days, st.calendar.filter(c => c.on).length + ' 个深色格');
ok('部位占比有数据', st.parts.length > 0, st.parts.map(p => p.name + p.pct + '%').join(' '));
ok('部位占比合计 ≈ 100%', Math.abs(st.parts.reduce((a, p) => a + p.pct, 0) - 100) <= 2, st.parts.reduce((a, p) => a + p.pct, 0) + '%');
ok('动作 TOP 不超过 5 条', st.top.length <= 5, st.top.map(t => t.cn + ':' + t.count).join(' '));

console.log('\n=== 5. 写入一组 ===');
if (!plan.rest) {
  const before = db.todaySets().length;
  db.saveSet({
    date: D.today(),
    exId: plan.items[0].exId,
    exCn: plan.items[0].cn,
    part: plan.items[0].part,
    setNo: 1,
    weight: 30,
    reps: 10,
    unit: 'kg'
  });
  const after = db.todaySets().length;
  const today = db.todaySets();
  const target = today.filter(s => s.exId === plan.items[0].exId && s.setNo === 1)[0];
  ok('今日记录 +1', after === before + 1, before + ' → ' + after);
  ok('重量写对了', target && target.weight === 30, target ? target.weight + ' kg' : '未找到');

  // 再存一次同一天同一组号，应该覆盖而不是新增
  db.saveSet({
    date: D.today(),
    exId: plan.items[0].exId,
    exCn: plan.items[0].cn,
    part: plan.items[0].part,
    setNo: 1,
    weight: 32,
    reps: 10,
    unit: 'kg'
  });
  const again = db.todaySets().filter(s => s.exId === plan.items[0].exId && s.setNo === 1);
  ok('同组号覆盖而非重复', again.length === 1 && again[0].weight === 32, again.length + ' 条，重量 ' + again[0].weight);
}

console.log('\n=== 6. 容量计算 ===');
ok('单组容量', V.setVolume({ weight: 24, reps: 12 }) === 288, V.setVolume({ weight: 24, reps: 12 }));
ok('吨换算', V.toTon(1240) === 1.2, V.toTon(1240));

console.log('\n' + (process.exitCode ? '有失败项' : '全部通过') + '\n');
