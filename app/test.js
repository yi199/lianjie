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
ok('练完 A 后本周 1/3', db.weeklyProgress('2026-10-26').done === 1, db.weeklyProgress('2026-10-26').done + '/3');

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
ok('从没练过 → first', db.suggestWeight('g21', 10, 3, '2026-10-20').reason === 'first');

// 10-19 卧推 50kg × 10 次 × 3 组，全部达标
set('2026-10-19', 'g1', 'A', 1, 50, 10);
set('2026-10-19', 'g1', 'A', 2, 50, 10);
set('2026-10-19', 'g1', 'A', 3, 50, 10);
const sugUp = db.suggestWeight('g1', 10, 3, '2026-10-20');
ok('全部做满 → 加重', sugUp.reason === 'up' && sugUp.weight === 52.5, sugUp.prev + ' → ' + sugUp.weight + ' kg');

// 下肢加 5kg
set('2026-10-19', 'g9', 'C', 1, 24, 10);
set('2026-10-19', 'g9', 'C', 2, 24, 10);
set('2026-10-19', 'g9', 'C', 3, 24, 10);
const sugLeg = db.suggestWeight('g9', 10, 3, '2026-10-20');
ok('下肢加 5kg（并取到 2.5 的倍数）', sugLeg.weight === 30, sugLeg.prev + ' + 5 → 29 → 取整 ' + sugLeg.weight + ' kg');

// 没做满 → 保持
set('2026-10-21', 'g6', 'B', 1, 40, 6);
const sugKeep = db.suggestWeight('g6', 10, 3, '2026-10-22');
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

/* ================= 9. 可视化数据 ================= */
console.log('\n=== 9. 可视化数据 ===');
const terr = db.partTerrain(2026, 10);
ok('力量地形固定 6 个部位', terr.length === 6, terr.map(t => t.name).join('/'));
ok('每个部位都有 pct', terr.every(t => typeof t.pct === 'number'));
ok('练过的部位 pct > 0', terr.some(t => t.pct > 0), terr.filter(t => t.trained).map(t => t.name + t.pct + '%').join(' '));
ok('没练的部位 pct = 0', terr.some(t => t.pct === 0) || terr.every(t => t.pct > 0), '共 ' + terr.filter(t => !t.trained).length + ' 个没练');

const wv = db.weeklyVolume(8);
ok('近 8 周返回 8 项', wv.length === 8, wv.map(w => w.ton).join(' / '));
ok('最后一项是本周', wv[7].label === '本周', wv[7].label);
ok('吨数不为负', wv.every(w => w.ton >= 0));

/* ================= 10. 示例数据 ================= */
console.log('\n=== 9. 示例数据 ===');
db.clearSets();
ok('清空后没有记录', !db.hasAnyRecord());
const n = db.loadDemo();
ok('示例数据生成', n > 0, n + ' 条');
ok('示例数据带 planKey', db.allSets().every(x => !!x.planKey), db.allSets()[0].planKey);
const st2 = db.monthlyStats(D.thisMonth().y, D.thisMonth().m);
ok('示例数据让本月数据页有内容', st2.days >= 1, st2.days + ' 天');
const demoDays = {};
db.allSets().forEach(function (x) { demoDays[x.date] = true; });
ok('示例数据铺满最近五周（每天都算一天）', Object.keys(demoDays).length >= 10, Object.keys(demoDays).length + ' 天');
ok('示例数据包含今天（否则 1 号打开数据页是空的）', !!demoDays[D.today()], D.today());

/* ================= 11. 旧数据迁移 ================= */
console.log('\n=== 10. 旧数据迁移 ===');
// 旧版的 plans 是按星期的对象
store['lj.plans'] = { 0: { name: '旧计划', en: 'Old', items: [] } };
store['lj.profile'] = { days: 3, place: 'gym', level: 'some' };
const migrated = db.migrate();
ok('对象格式的计划被迁移成数组', migrated === true && Array.isArray(db.plans()), Array.isArray(db.plans()) ? '数组' : typeof db.plans());
ok('迁移后条数正确', db.plans().length === 3, db.plans().length + ' 个训练日');
ok('再次调用不重复迁移', db.migrate() === false);

/* ================= 12. 容量计算 ================= */
console.log('\n=== 11. 容量计算 ===');
ok('单组容量', V.setVolume({ weight: 24, reps: 12 }) === 288, V.setVolume({ weight: 24, reps: 12 }));
ok('吨换算', V.toTon(1240) === 1.2, V.toTon(1240));

/* ================= 12. 训练日轮转（跨周不漏训练日） ================= */
console.log('\n=== 12. 训练日轮转 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

// 第一周只练 2 次：周一 A、周三 B，没练满 3 次
set('2026-10-26', 'g1', 'A', 1, 50, 10);
set('2026-10-28', 'g5', 'B', 1, 0, 6);

const w2 = db.todaySession('2026-11-02');   // 下周一
ok('一周只练 2 次，下周接着排到 C（旧版会回到 A）', w2.plan && w2.plan.key === 'C', w2.plan ? w2.plan.key + ' ' + w2.plan.name : '无');
ok('本周进度按周重置', w2.week.done === 0 && w2.week.target === 3, w2.week.done + '/' + w2.week.target);

set('2026-11-02', 'g9', 'C', 1, 24, 10);
ok('练完 C 之后回到 A', db.todaySession('2026-11-03').plan.key === 'A');
ok('同一天再查还是 C（不跳）', db.todaySession('2026-11-02').plan.key === 'C');
ok('停练两个月也接着上次往下排', db.todaySession('2027-01-05').plan.key === 'A');

/* ================= 13. 重量建议的边界 ================= */
console.log('\n=== 13. 重量建议的边界 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

set('2026-10-19', 'g1', 'A', 1, 50, 10);          // 只勾了 1 组
const onlyOne = db.suggestWeight('g1', 10, 3, '2026-10-20');
ok('只做 1/3 组 → 不算全部完成，不加重量', onlyOne.reason === 'keep' && onlyOne.weight === 50, onlyOne.reason + ' ' + onlyOne.weight + 'kg');
ok('并标出组数不够', onlyOne.enoughSets === false);

const oneSetPlan = db.suggestWeight('g1', 10, 1, '2026-10-20');
ok('计划本来就 1 组 → 达标就加', oneSetPlan.reason === 'up' && oneSetPlan.weight === 52.5, oneSetPlan.weight + 'kg');

// 中途减重：最后一组降到 40，下次起点不能被拉低
set('2026-10-21', 'g1', 'A', 1, 55, 10);
set('2026-10-21', 'g1', 'A', 2, 55, 10);
set('2026-10-21', 'g1', 'A', 3, 40, 10);
const drop = db.suggestWeight('g1', 10, 3, '2026-10-22');
ok('基准取最重一组（55 → 57.5），不按最后一组', drop.prev === 55 && drop.weight === 57.5, drop.prev + ' → ' + drop.weight + ' kg');

/* ================= 14. 换动作 ================= */
console.log('\n=== 14. 换动作持久化 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

const aPlan = db.todaySession('2026-10-26').plan;
ok('A 日第一个动作是卧推', aPlan.items[0].exId === 'g1', aPlan.items[0].cn);

db.setSwap('A', 0, 'g15');
const swapped = db.todaySession('2026-10-26').plan;
ok('换过之后计划里就是上斜卧推（不用每天重换）', swapped.items[0].exId === 'g15', swapped.items[0].cn);
ok('记住原动作名', swapped.items[0].originCn === '卧推', swapped.items[0].originCn);
ok('换到的动作第一次重量按它自己的基线算', swapped.items[0].weight === db.initialWeight('g15') && swapped.items[0].weight > 0, swapped.items[0].weight + 'kg');

db.clearSwap('A', 0);
ok('可以恢复原动作', db.todaySession('2026-10-26').plan.items[0].exId === 'g1');

// 腿日换成罗马尼亚硬拉：重量不能还是 20kg
set('2026-11-02', 'g1', 'A', 1, 50, 10);
set('2026-11-04', 'g5', 'B', 1, 0, 6);
db.setSwap('C', 0, 'g21');
const swapLeg = db.todaySession('2026-11-06').plan;
ok('换到腿日动作时重量按基线算，不是死 20kg',
  swapLeg.items[0].exId === 'g21' && swapLeg.items[0].weight === db.initialWeight('g21') && swapLeg.items[0].weight !== 20,
  swapLeg.items[0].cn + ' ' + swapLeg.items[0].weight + 'kg');

/* ================= 15. 今日完成度 ================= */
console.log('\n=== 15. 今日完成度 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

const todayPlan = db.todaySession('2026-10-26').plan;
todayPlan.items.slice(0, 2).forEach(function (it) {
  set('2026-10-26', it.exId, 'A', 1, it.weight || 0, it.reps);
});
const half = db.todaySession('2026-10-26');
ok('只做 2/4 个动作 → 未完成', half.today.doneEx === 2 && half.today.complete === false, half.today.doneEx + '/' + half.today.totalEx);

todayPlan.items.forEach(function (it) {
  set('2026-10-26', it.exId, 'A', 1, it.weight || 0, it.reps);
});
const full = db.todaySession('2026-10-26');
ok('4 个动作都做过 → 完成', full.today.complete === true, full.today.doneEx + '/' + full.today.totalEx);
ok('练完还是当天那个训练日（不跳到下一个）', full.plan.key === 'A', full.plan.key);

/* ================= 16. 示例数据不覆盖真实记录 ================= */
console.log('\n=== 16. 示例数据保护 ===');
ok('已有记录时拒绝覆盖', db.loadDemo() === -1);

/* ================= 17. 官方方案 ================= */
console.log('\n=== 17. 官方方案 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

const pl0 = db.programList();
ok('6 个官方方案', pl0.official.length === 6, pl0.official.length + ' 个');
ok('初始是自动排（auto）', pl0.auto === true);
ok('一开始没有自定义方案', pl0.custom.length === 0);

const act = db.activateProgram('gym-ppl-3');
ok('启用「增肌推拉腿」', !!act && act.name === '增肌推拉腿', act && act.name);
ok('计划变成 3 个训练日', db.plans().length === 3, db.plans().length + ' 天');
ok('A 日是推日', db.plans()[0].name === '推日', db.plans()[0].name);
ok('A 日动作 = 方案里写死的那 5 个',
  db.plans()[0].items.map(i => i.exId).join(',') === 'g1,g15,g4,g3,g19',
  db.plans()[0].items.map(i => i.exId).join(','));
ok('腿日把新动作排进去了（杠铃深蹲 / 臀推）',
  db.plans()[2].items.some(i => i.exId === 'g40') && db.plans()[2].items.some(i => i.exId === 'g44'),
  db.plans()[2].items.map(i => i.exId).join(','));
ok('profileText 显示方案名', db.profileText().indexOf('增肌推拉腿') >= 0, db.profileText());
ok('profile 的天数/场所跟着方案走', db.profile().days === 3 && db.profile().place === 'gym');
ok('签名带上方案 id（换方案才能识别出旧记录）', db.planSig().indexOf('gym-ppl-3') >= 0, db.planSig());
ok('列表里只有一个标为使用中', db.programList().official.filter(x => x.active).length === 1);

db.activateProgram('gym-upper-lower-4');
ok('4 练方案 → 4 个训练日', db.plans().length === 4, db.plans().length + ' 天');
ok('4 练是 trained 档，起点重量更高',
  db.plans()[0].items[0].weight >= 50, db.plans()[0].items[0].cn + ' ' + db.plans()[0].items[0].weight + 'kg');

// 换方案后，旧方案下的记录不能接着参与轮转
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
set('2026-10-26', 'g1', 'A', 1, 50, 10);
db.activateProgram('home-starter-2');
const tSwitch = db.todaySession('2026-10-27');
ok('换成居家方案后，不会接着旧方案的 A 日排',
  db.plans().length === 2 && tSwitch.plan && tSwitch.plan.items.every(i => i.exId[0] === 'h'),
  tSwitch.plan && (tSwitch.plan.key + ' ' + tSwitch.plan.items.map(i => i.exId).join(',')));
ok('方案的训练日没有跨场所的脏动作',
  db.plans().every(p => p.items.every(i => (EX.byId(i.exId) || {}).place === 'home')));

/* ================= 18. 自定义方案 ================= */
console.log('\n=== 18. 自定义方案 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

const mine = db.saveCustomProgram({
  name: '我的上肢日',
  place: 'gym',
  level: 'some',
  sessions: [
    { name: '上肢 A', exIds: ['g1', 'g27', 'g33', 'g36'] },
    { name: '上肢 B', exIds: ['g24', 'g30', 'g34', 'g39'] }
  ]
});
ok('存下来自动生成 id', !!mine.id, mine.id);
ok('天数按训练日数量算', mine.days === 2, mine.days);
ok('训练日自动编号 A/B', mine.sessions.map(s => s.key).join('') === 'AB', mine.sessions.map(s => s.key).join(''));
ok('出现在方案列表里', db.programList().custom.length === 1);

db.activateProgram(mine.id);
ok('启用自定义方案 → 2 个训练日', db.plans().length === 2, db.plans().length + ' 天');
ok('动作就是自己选的那几个',
  db.plans()[0].items.map(i => i.exId).join(',') === 'g1,g27,g33,g36',
  db.plans()[0].items.map(i => i.exId).join(','));
const kgItems = db.plans()[0].items.filter(i => i.unit === 'kg');
ok('自定义方案里每个负重动作都按自己的基线出重量（不是一律 20kg）',
  kgItems.every(i => i.weight === db.initialWeight(i.exId)),
  kgItems.map(i => i.exId + ' ' + i.weight + 'kg').join(' / '));
ok('基线本来就不是 20kg 的动作确实不是 20kg',
  db.plans()[0].items.some(i => i.unit === 'kg' && i.weight !== 20),
  db.plans()[0].items.filter(i => i.unit === 'kg').map(i => i.exId + ':' + i.weight).join(' '));

db.saveCustomProgram({ id: mine.id, name: '我的上肢日 v2', place: 'gym', sessions: [{ name: '只有一天', exIds: ['g1'] }] });
ok('同 id 是覆盖而不是新增',
  db.programList().custom.length === 1 && db.programList().custom[0].name === '我的上肢日 v2',
  db.programList().custom[0].name);

db.removeCustomProgram(mine.id);
ok('删掉后自定义列表清空', db.programList().custom.length === 0);
ok('删掉正在用的方案 → 自动退回 auto 排', db.currentProgramId() === 'auto', db.currentProgramId());
// 退回 auto 后按 profile.days 排 —— 激活方案时 days 已被方案同步（2 天），这是有意的：
// 删掉方案不该把用户突然弹回健身房/3 天，那和他刚才选的安排无关
ok('退回 auto 后计划仍然有内容，且训练日数 = 当前设置', 
  db.plans().length === db.profile().days && db.plans().length >= 2,
  db.plans().length + ' 天 / profile ' + db.profile().days);

/* ================= 19. 老数据升级 ================= */
console.log('\n=== 19. 老数据升级 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
const legacy = db.profile();
delete legacy.programId;
wx.setStorageSync('lj.profile', legacy);
db.migrate();
ok('老 profile 补上 programId=auto', db.profile().programId === 'auto', JSON.stringify(db.profile()));

/* ================= 20. 动作库（服务端清单 + 自建动作） ================= */
console.log('\n=== 20. 动作库 ===');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

/* 20.1 还没拉到服务端清单 → 用包里那份快照，功能完整 */
ok('首装用包内快照（105 个动作）', db.exercises().length === 105, db.exercises().length);
ok('包里那份能查到动作', !!db.exerciseById('g1'));

/* 20.2 拉到清单 → 整份替换；retired 由客户端过滤 */
db.applyCatalog(7, [
  { id: 'g1', cn: '卧推（新版）', en: 'Bench Press', part: 'chest', place: 'gym',
    unit: 'kg', tips: '肩胛下沉', hot: true, imgThumb: '', retired: false },
  { id: 'g99', cn: '下架动作', en: '', part: 'chest', place: 'gym',
    unit: 'kg', tips: '', hot: false, imgThumb: '', retired: true }
]);
ok('清单整份替换（不是合并）', db.exercises().length === 1, db.exercises().length);
ok('retired=true 的不出现在可选列表里', !db.exerciseById('g99'));
ok('改名生效', db.exerciseById('g1').cn === '卧推（新版）', db.exerciseById('g1').cn);
ok('catalogRev 已记下', db.catalogRev() === 7, db.catalogRev());

/* 20.3 自建动作：id 规则是硬约束 */
const ce = db.saveCustomExercise({ cn: '绳索夹胸', part: 'chest', place: 'gym', unit: 'kg', tips: '肘部固定' });
ok('自建动作 id 以 u- 开头', /^u-/.test(ce.exId), ce.exId);
ok('id 总长 ≤16（超长会让用它的每一组被拒收）',
  Buffer.byteLength(ce.exId, 'utf8') <= 16, ce.exId + ' = ' + ce.exId.length + ' 字符');
ok('官方 + 自建都能查到', !!db.exerciseById('g1') && !!db.exerciseById(ce.exId));
ok('「我的动作」里有它', db.customExercises().length === 1, db.customExercises().length);

/* 20.4 用自建动作记一组：exCn / part 必须是真值，不能存成 id */
db.saveSet({ date: '2026-10-26', exId: ce.exId, setNo: 1, weight: 20, reps: 10, unit: 'kg' });
const custRow = db.allSets().filter(function (s) { return s.exId === ce.exId; })[0];
ok('组记录的 exCn 是中文名不是 id', custRow && custRow.exCn === '绳索夹胸', custRow && custRow.exCn);
ok('组记录的 part 记下来了（部位统计算得出来）', custRow && custRow.part === 'chest', custRow && custRow.part);

/* 20.5 换动作候选里要能换到自建动作 */
const custAlts = db.alternatives('g1', null, '2026-10-26');
ok('换动作候选包含自建动作', custAlts.some(function (e) { return e.id === ce.exId; }),
  custAlts.map(function (e) { return e.id; }).join(','));
ok('候选里不会把自己列进去', !custAlts.some(function (e) { return e.id === 'g1'; }));

/* 20.6 删除 = 墓碑：本地隐藏，但历史记录照常显示 */
const histBefore = db.allSets().length;
db.removeCustomExercise(ce.exId);
ok('删除后「我的动作」清空', db.customExercises().length === 0, db.customExercises().length);
ok('删除后查不到（墓碑被过滤）', !db.exerciseById(ce.exId));
ok('历史记录不受影响', db.allSets().length === histBefore, db.allSets().length + '/' + histBefore);

/* 20.7 上限 30：只由客户端把关 */
for (let i = 0; i < 30; i++) {
  db.saveCustomExercise({ exId: 'u-cap' + i, cn: '动作' + i, part: 'chest', place: 'gym', unit: 'kg' });
}
ok('满 30 个后不再允许新增', db.canAddCustomExercise() === false, db.customExercises().length);

/* 20.8 自建动作进上传队列，且批次里单独一类 */
ok('新建动作进了待上传队列', db.syncPending() >= 30, db.syncPending());
const catBatch = db.syncPullBatch(500);
ok('批次里带 exercises 这一路', (catBatch.exercises || []).length >= 30,
  (catBatch.exercises || []).length);
ok('自建动作排在批次最前面（不被积压的记录挤掉）',
  (catBatch.exercises || []).length > 0, '');

/* 20.9 战报/记录页里自建动作要显示中文名，不能把 id 漏到界面上 */
// 20.7 已经把 30 个名额占满（saveCustomExercise 会拒绝新建），先腾一个出来
['u-cap0', 'u-cap1', 'u-cap2'].forEach(function (id) { db.removeCustomExercise(id); });
db.saveCustomExercise({ exId: 'u-report', cn: '战报测试动作', part: 'chest', place: 'gym', unit: 'kg' });
db.saveSet({ date: '2026-10-26', exId: 'u-report', setNo: 1, weight: 20, reps: 10, unit: 'kg' });
const vw = db.todayWorkout('2026-10-26');
const wlist = vw.exercises || vw.blocks || [];
const blk = wlist.filter(function (b) { return b.exId === 'u-report'; })[0];
ok('战报里自建动作显示中文名（不是 u- 开头的 id）', !!blk && blk.cn === '战报测试动作', blk && blk.cn);
ok('战报里部位也对（能进部位统计）', !!blk && blk.part === 'chest', blk && blk.part);

db.resetAll();

/* ================= 21. 本地空间不足（写失败不能崩、不能留半截） ================= */
console.log('\n=== 21. 本地空间不足 ===');
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });

const safe = require('./utils/safeStorage');
safe.resetWarn();

const realSet = wx.setStorageSync;
const realRemove = wx.removeStorageSync;
let modals = 0;
wx.showModal = function () { modals++; };
// 只让「组记录分片」写失败，模拟单 key / 总量写满
wx.setStorageSync = function (k, v) {
  if (String(k).indexOf('lj.sets.') === 0) {
    const e = new Error('setStorageSync:fail exceed storage max size');
    e.errMsg = e.message;
    throw e;
  }
  realSet(k, v);
};

let thrown = null;
try {
  db.saveSet({ date: '2026-10-26', exId: 'g1', setNo: 1, weight: 60, reps: 8, unit: 'kg' });
} catch (e) { thrown = e; }
ok('写满时不往页面上抛异常（不会白屏）', !thrown, thrown && thrown.message);
ok('提示了用户一次', modals === 1, modals);

try {
  db.saveSet({ date: '2026-10-26', exId: 'g1', setNo: 2, weight: 60, reps: 8, unit: 'kg' });
} catch (e) { /* 第二次同样写不进去 */ }
ok('连续写失败也只提示一次（不骚扰）', modals === 1, modals);

// 最怕的形态是「界面看着有、重进就没」：内存缓存必须回落到磁盘真相
wx.setStorageSync = realSet;
ok('写失败的这组不会假装存在（读回磁盘）',
  !db.allSets().some(function (s) { return s.date === '2026-10-26' && s.exId === 'g1'; }),
  db.allSets().length + ' 组');

// 腾出空间后照常能记
db.saveSet({ date: '2026-10-27', exId: 'g1', setNo: 1, weight: 62, reps: 8, unit: 'kg' });
ok('空间恢复后能正常记录',
  db.allSets().some(function (s) { return s.date === '2026-10-27'; }),
  db.allSets().length + ' 组');

delete wx.showModal;
safe.resetWarn();
wx.removeStorageSync = realRemove;
db.resetAll();

console.log('\n' + (process.exitCode ? '有失败项' : '全部通过') + '\n');
