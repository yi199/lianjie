/**
 * 本地自测：用 mock 的 wx 存储跑一遍数据层
 * 跑法：node test.js
 *
 * 固定用 2026-10 这一周做样本：
 *   2026-10-26 周一  2026-10-27 周二  2026-10-28 周三
 *   2026-10-29 周四  2026-10-30 周五  2026-11-01 周日
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

function set(date, exId, planKey, no, weight, reps, unit) {
  const ex = EX.byId(exId);
  return db.saveSet({
    date, exId, exCn: ex.cn, part: ex.part, planKey,
    setNo: no, weight, reps, unit: unit || ex.unit
  });
}

/* ================= 1. 动作库 ================= */
console.log('\n=== 1. 动作库 ===');
const gym = EX.byPlace('gym');
const home = EX.byPlace('home');
ok('健身房动作', gym.length >= 18, gym.length + ' 个');
ok('居家动作', home.length >= 18, home.length + ' 个');
ok('动作 id 不重复', new Set(EX.EXERCISES.map(e => e.id)).size === EX.EXERCISES.length, EX.EXERCISES.length + ' 个');
ok('每个动作都有部位分类', EX.EXERCISES.every(e => !!EX.PART_CN[e.part]));

/* ================= 2. 计划模板 ================= */
console.log('\n=== 2. 计划模板 ===');
const p3 = P.buildPlan(3, 'gym', 'some');
ok('返回数组', Array.isArray(p3), '数组');
ok('3 练 → 3 个训练日', p3.length === 3);
ok('按 A/B/C 编号', p3.map(x => x.key).join('') === 'ABC', p3.map(x => x.key).join(''));
ok('训练日名称', p3.map(x => x.name).join('/') === '推日/拉日/腿日', p3.map(x => x.name).join('/'));
ok('每天都有动作', p3.every(x => x.items.length >= 3));

const p4 = P.buildPlan(4, 'gym', 'some');
ok('4 练 → 4 个训练日', p4.length === 4);
ok('4 练的四天内容不重复', new Set(p4.map(x => x.type)).size === 4, p4.map(x => x.type).join(','));

const p2 = P.buildPlan(2, 'home', 'some');
ok('2 练 → 2 个训练日（全身）', p2.length === 2 && p2[0].name.indexOf('全身') === 0, p2.map(x => x.name).join('/'));
ok('居家计划没有任何负重', p2.every(x => x.items.every(i => i.weight === 0)));

const wNew = P.buildPlan(3, 'gym', 'new')[0].items.filter(i => i.unit === 'kg')[0].weight;
const wPro = P.buildPlan(3, 'gym', 'trained')[0].items.filter(i => i.unit === 'kg')[0].weight;
ok('水平越高起始重量越大', wPro > wNew, wNew + ' → ' + wPro + ' kg');

/* ================= 3. 首次引导 ================= */
console.log('\n=== 3. 首次引导 ===');
ok('一开始未引导', !db.hasOnboarded());
ok('一开始没有计划', db.plans().length === 0);
ok('一开始没有记录', !db.hasAnyRecord());

db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
ok('走完引导后已标记', db.hasOnboarded());
ok('计划已生成', db.plans().length === 3);
ok('摘要文案', db.profileText() === '一周 3 练 · 健身房', db.profileText());

/* ================= 4. 周循环：按次排队，不绑星期 ================= */
console.log('\n=== 4. 周循环 ===');

let s = db.todaySession('2026-10-26');           // 周一
ok('周一开始是 A', s.plan && s.plan.key === 'A', s.plan ? s.plan.key + ' ' + s.plan.name : '无');
ok('本周 0/3', s.week.done === 0 && s.week.target === 3, s.week.done + '/' + s.week.target);

set('2026-10-26', 'g1', 'A', 1, 50, 10);
ok('练完 A 后本周 1/3', db.weeklyProgress().done === 1, db.weeklyProgress().done + '/3');

ok('周二该练 B', db.todaySession('2026-10-27').plan.key === 'B');
ok('周三没练还是 B（自动顺延）', db.todaySession('2026-10-28').plan.key === 'B', '顺延 ✓');

set('2026-10-28', 'g5', 'B', 1, 0, 6);
ok('周三练完 B，周四该练 C', db.todaySession('2026-10-29').plan.key === 'C');
ok('同一天再查还是 B（不跳）', db.todaySession('2026-10-28').plan.key === 'B', 'resumed');

set('2026-10-30', 'g9', 'C', 1, 24, 10);
const s4 = db.todaySession('2026-10-30');
ok('练满 3 次 → finished', s4.finished === true, s4.week.done + '/' + s4.week.target);
ok('达标后仍给一个模板（允许加练）', !!s4.plan, s4.plan ? s4.plan.key : '无');

const nextWeek = db.todaySession('2026-11-02');  // 下周一
ok('下周一重新从 A 开始', nextWeek.plan.key === 'A' && nextWeek.week.done === 0, nextWeek.plan.key + ' / 0/3');

/* ================= 5. 重量建议（渐进超负荷） ================= */
console.log('\n=== 5. 重量建议 ===');
ok('从没练过 → first', db.suggestWeight('g21', 10, '2026-10-20').reason === 'first');

// 10-19 卧推 50kg × 10 次 × 3 组，全部达标
set('2026-10-19', 'g1', 'A', 1, 50, 10);
set('2026-10-19', 'g1', 'A', 2, 50, 10);
set('2026-10-19', 'g1', 'A', 3, 50, 10);
const sugUp = db.suggestWeight('g1', 10, '2026-10-20');
ok('全部做满 → 加重', sugUp.reason === 'up' && sugUp.weight === 52.5, sugUp.prev + ' → ' + sugUp.weight + ' kg');

// 下肢加 5kg
set('2026-10-19', 'g9', 'C', 1, 24, 10);
set('2026-10-19', 'g9', 'C', 2, 24, 10);
const sugLeg = db.suggestWeight('g9', 10, '2026-10-20');
ok('下肢加 5kg（并取到 2.5 的倍数）', sugLeg.weight === 30, sugLeg.prev + ' + 5 → 29 → 取整 ' + sugLeg.weight + ' kg');

// 没做满 → 保持
set('2026-10-21', 'g6', 'B', 1, 40, 6);
const sugKeep = db.suggestWeight('g6', 10, '2026-10-22');
ok('没做满 → 保持原重量', sugKeep.reason === 'keep' && sugKeep.weight === 40, sugKeep.weight + ' kg');

/* ================= 6. 换动作 ================= */
console.log('\n=== 6. 换动作 ===');
const alts = db.alternatives('g1');
ok('卧推有可替换动作', alts.length >= 2, alts.map(a => a.cn).join('/'));
ok('替换的都是同部位', alts.every(a => a.part === 'chest'));
ok('不含自己', alts.every(a => a.id !== 'g1'));

const homeAlts = db.alternatives('h1');
ok('居家也有可换的', homeAlts.length >= 2, homeAlts.map(a => a.cn).join('/'));

/* ================= 7. 记录与战报 ================= */
console.log('\n=== 7. 记录与战报 ===');
const rep = db.todayReport('2026-10-28');
ok('战报计划名来自 planKey', rep.planName === '拉日', rep.planName);
ok('战报组数', rep.sets === 1, rep.sets + ' 组');
ok('战报动作数', rep.exercises === 1, rep.exercises + ' 个');

// PR：10-19 卧推 50kg，10-26 提到 60kg
set('2026-10-26', 'g1', 'A', 1, 60, 10);
const prs = db.detectPRs('2026-10-26');
ok('识别出 PR', prs.length === 1 && prs[0].weight === 60, prs.map(p => p.cn + ' ' + p.weight).join(','));
ok('PR 增量', prs.length && prs[0].delta === 10, prs.length ? '+' + prs[0].delta : '-');

// 第一次做的不算 PR
const rep2 = db.todayReport('2026-10-28');
ok('第一次做的动作不算 PR', rep2.prs.length === 0, rep2.prs.length + ' 个');

/* ================= 8. 统计 ================= */
console.log('\n=== 8. 统计 ===');
const st = db.monthlyStats(2026, 10);
ok('训练天数', st.days >= 4, st.days + ' 天');
ok('日历格子数 = 当月天数', st.calendar.length === 31, st.calendar.length + ' 格');
ok('部位占比合计 ≈ 100%',
  Math.abs(st.parts.reduce((a, p) => a + p.pct, 0) - 100) <= 2,
  st.parts.map(p => p.name + p.pct + '%').join(' '));
ok('累计吨数 > 0', st.ton > 0, st.ton + ' 吨');
ok('动作 TOP 不超过 5 条', st.top.length <= 5, st.top.map(t => t.cn + ':' + t.count).join(' '));

/* ================= 9. 示例数据 ================= */
console.log('\n=== 9. 示例数据 ===');
db.clearSets();
ok('清空后没有记录', !db.hasAnyRecord());
const n = db.loadDemo();
ok('示例数据生成', n > 0, n + ' 条');
ok('示例数据带 planKey', db.allSets().every(x => !!x.planKey), db.allSets()[0].planKey);
const st2 = db.monthlyStats(D.thisMonth().y, D.thisMonth().m);
ok('示例数据让数据页有内容', st2.days > 1, st2.days + ' 天');

/* ================= 10. 旧数据迁移 ================= */
console.log('\n=== 10. 旧数据迁移 ===');
// 旧版的 plans 是按星期的对象
store['lj.plans'] = { 0: { name: '旧计划', en: 'Old', items: [] } };
store['lj.profile'] = { days: 3, place: 'gym', level: 'some' };
const migrated = db.migrate();
ok('对象格式的计划被迁移成数组', migrated === true && Array.isArray(db.plans()), Array.isArray(db.plans()) ? '数组' : typeof db.plans());
ok('迁移后条数正确', db.plans().length === 3, db.plans().length + ' 个训练日');
ok('再次调用不重复迁移', db.migrate() === false);

/* ================= 11. 容量计算 ================= */
console.log('\n=== 11. 容量计算 ===');
ok('单组容量', V.setVolume({ weight: 24, reps: 12 }) === 288, V.setVolume({ weight: 24, reps: 12 }));
ok('吨换算', V.toTon(1240) === 1.2, V.toTon(1240));

console.log('\n' + (process.exitCode ? '有失败项' : '全部通过') + '\n');
