/**
 * 本地自测：用 mock 的 wx 存储跑一遍数据层
 * 跑法：node test.js
 */

const store = {};
global.wx = {
  getStorageSync(k) { return store[k] === undefined ? '' : store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; }
};

const db = require('./utils/db');
const D = require('./utils/date');
const V = require('./utils/volume');
const P = require('./data/plan');
const EX = require('./data/exercises');

function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
}

/* ================= 1. 动作库 ================= */
console.log('\n=== 1. 动作库 ===');
const gym = EX.byPlace('gym');
const home = EX.byPlace('home');
ok('健身房动作', gym.length >= 10, gym.length + ' 个');
ok('居家动作', home.length >= 8, home.length + ' 个');
ok('动作 id 不重复', new Set(EX.EXERCISES.map(e => e.id)).size === EX.EXERCISES.length, EX.EXERCISES.length + ' 个');
ok('每个动作都有部位分类', EX.EXERCISES.every(e => !!EX.PART_CN[e.part]));

/* ================= 2. 计划生成 ================= */
console.log('\n=== 2. 计划生成 ===');
const p3 = P.buildPlan(3, 'gym', 'some');
ok('一周 3 练 → 3 个训练日', Object.keys(p3).length === 3, Object.keys(p3).join(',') + '（周一=0）');
ok('每个训练日都有动作', Object.keys(p3).every(k => p3[k].items.length >= 3));

const p2 = P.buildPlan(2, 'gym', 'some');
ok('一周 2 练 → 2 个训练日', Object.keys(p2).length === 2);

const p4 = P.buildPlan(4, 'home', 'some');
ok('一周 4 练 → 4 个训练日', Object.keys(p4).length === 4);

ok('健身房计划里有负重动作', Object.keys(p3).some(k => p3[k].items.some(i => i.unit === 'kg' && i.weight > 0)));
ok('居家计划里没有任何负重', Object.keys(p4).every(k => p4[k].items.every(i => i.weight === 0)));
ok('计时动作单位是秒', Object.keys(p4).some(k => p4[k].items.some(i => i.unit === 'sec')));

const lvNew = P.buildPlan(3, 'gym', 'new');
const lvPro = P.buildPlan(3, 'gym', 'trained');
const wNew = lvNew[0].items.filter(i => i.unit === 'kg')[0].weight;
const wPro = lvPro[0].items.filter(i => i.unit === 'kg')[0].weight;
ok('水平越高起始重量越大', wPro > wNew, wNew + ' kg → ' + wPro + ' kg');

ok('重量取到 2.5 的整数倍', P.roundWeight(23.7) === 22.5 || P.roundWeight(23.7) === 25, P.roundWeight(23.7));

/* ================= 3. 首次引导 ================= */
console.log('\n=== 3. 首次引导 ===');
ok('一开始未标记已引导', !db.hasOnboarded());
ok('一开始没有计划', Object.keys(db.plans()).length === 0);
ok('一开始没有记录', !db.hasAnyRecord());

db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
ok('走完引导后已标记', db.hasOnboarded());
ok('profile 存下来了', db.profile() && db.profile().days === 3, JSON.stringify(db.profile()));
ok('计划已生成', Object.keys(db.plans()).length === 3, Object.keys(db.plans()).join(','));
ok('摘要文案', db.profileText() === '一周 3 练 · 健身房', db.profileText());

/* ================= 4. 今天练什么 ================= */
console.log('\n=== 4. 今天练什么 ===');
const mon = db.todayPlan('2026-10-26');       // 周一，3 练计划里一定有
ok('周一有训练', !mon.rest, mon.rest ? '休息' : mon.name);
ok('动作已展开中文名', !mon.rest && !!mon.items[0].cn, mon.rest ? '-' : mon.items[0].cn + ' / ' + mon.items[0].en);
ok('动作带部位', !mon.rest && !!mon.items[0].part);

const sun = db.todayPlan('2026-11-01');       // 周日，3 练计划里没有
ok('周日休息', sun.rest === true, sun.rest ? 'rest' : '有训练');

ok('没练过时 lastRecord 为空', db.lastRecord(mon.items[0].exId, '2026-10-26') === null);

/* ================= 5. 写一组 ================= */
console.log('\n=== 5. 写一组记录 ===');
const ex0 = mon.items[0];
const before = db.allSets().length;

db.saveSet({
  date: '2026-10-26', exId: ex0.exId, exCn: ex0.cn, part: ex0.part,
  setNo: 1, weight: 30, reps: 10, unit: 'kg'
});
ok('记录 +1', db.allSets().length === before + 1);

const row = db.allSets()[0];
ok('重量写对了', row.weight === 30, row.weight + ' kg');

db.saveSet({
  date: '2026-10-26', exId: ex0.exId, exCn: ex0.cn, part: ex0.part,
  setNo: 1, weight: 32.5, reps: 8, unit: 'kg'
});
const again = db.allSets().filter(s => s.exId === ex0.exId && s.setNo === 1);
ok('同组号覆盖而非重复', again.length === 1, again.length + ' 条');
ok('覆盖后重量更新', again[0].weight === 32.5, again[0].weight + ' kg');
ok('覆盖后次数更新', again[0].reps === 8, again[0].reps + ' 次');

ok('有记录了', db.hasAnyRecord());
ok('那天的记录能查到', db.todaySets('2026-10-26').length === 1);

/* ================= 6. 统计 ================= */
console.log('\n=== 6. 统计 ===');
const st = db.monthlyStats(2026, 10);
ok('训练天数 = 1', st.days === 1, st.days + ' 天');
ok('日历格子数 = 当月天数', st.calendar.length === 31, st.calendar.length + ' 格');
ok('日历上那天是深色', st.calendar.filter(c => c.on).length === 1);
ok('部位占比合计 ≈ 100%',
  Math.abs(st.parts.reduce((a, p) => a + p.pct, 0) - 100) <= 2,
  st.parts.map(p => p.name + p.pct + '%').join(' '));
ok('累计吨数 > 0', st.ton > 0, st.ton + ' 吨');

const wk = db.weeklyProgress();
ok('本周进度有计划数', wk.planned === 3, wk.done + '/' + wk.planned);

/* ================= 7. 示例数据 ================= */
console.log('\n=== 7. 示例数据（用户主动点才生成） ===');
const n = db.loadDemo();
ok('示例数据生成成功', n > 0, n + ' 条组记录');

const st2 = db.monthlyStats(D.thisMonth().y, D.thisMonth().m);
ok('本月训练天数 > 1', st2.days > 1, st2.days + ' 天');
ok('部位占比有多个部位', st2.parts.length >= 3, st2.parts.map(p => p.name + p.pct + '%').join(' '));
ok('动作 TOP 不超过 5 条', st2.top.length <= 5, st2.top.map(t => t.cn + ':' + t.count).join(' '));

/* ================= 8. 清空 ================= */
console.log('\n=== 8. 清空与重来 ===');
db.clearSets();
ok('清空后没有记录', !db.hasAnyRecord());
db.resetAll();
ok('resetAll 后回到未引导状态', !db.hasOnboarded());
ok('resetAll 后没有计划', Object.keys(db.plans()).length === 0);

/* ================= 9. 旧版本数据迁移 ================= */
console.log('\n=== 9. 旧版本数据迁移 ===');
store['lj.seeded'] = 1;
store['lj.sets'] = [{
  id: 'old-1', date: '2026-01-01', exId: 'g1', exCn: '旧记录', part: 'chest',
  setNo: 1, weight: 24, reps: 12, unit: 'kg', done: true
}];
store['lj.plans'] = { 0: { name: '旧计划', en: 'Old', items: [] } };
delete store['lj.onboarded'];

const migrated = db.migrate();
ok('检测到旧版本存储', migrated === true);
ok('旧记录已清除', !db.hasAnyRecord());
ok('旧计划已清除', Object.keys(db.plans()).length === 0);
ok('旧标记已删除', store['lj.seeded'] === undefined);
ok('再次调用不重复清理', db.migrate() === false);

/* ================= 10. 容量计算 ================= */
console.log('\n=== 10. 容量计算 ===');
ok('单组容量', V.setVolume({ weight: 24, reps: 12 }) === 288, V.setVolume({ weight: 24, reps: 12 }));
ok('吨换算', V.toTon(1240) === 1.2, V.toTon(1240));

console.log('\n' + (process.exitCode ? '有失败项' : '全部通过') + '\n');
