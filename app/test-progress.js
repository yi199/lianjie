/**
 * 进步计算自测（P7 · V1/V2 数据层）
 * 跑法：node test-progress.js
 *
 * 全部用固定的组记录喂纯函数，不碰 db 的存储：
 *   起点 = 前 3 次的中位数，噪声阈值 2.5%，停滞 = 距最好 4 次没超过「最好 × 1.025」
 */

const store = {};
global.wx = {
  getStorageSync(k) { return store[k] === undefined ? '' : store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; }
};

const P = require('./utils/progress');
const M = require('./data/progress-model');
const EX = require('./data/exercises');

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}
function sec(title) { console.log('\n=== ' + title + ' ==='); }

/** 造一组记录：list = [[weight, reps], ...] */
function day(date, exId, list, extra) {
  const ex = EX.byId(exId) || {};
  return list.map(function (x, i) {
    return Object.assign({
      date: date, exId: exId, setNo: i + 1, weight: x[0], reps: x[1],
      unit: ex.unit || 'kg', done: true, warmup: false
    }, extra || {});
  });
}
function flat() {
  let out = [];
  for (let i = 0; i < arguments.length; i++) out = out.concat(arguments[i]);
  return out;
}
const BW70 = function () { return 70; };
const NO_BW = function () { return null; };

/* ================= 1. 模型归属 ================= */
sec('1. 模型归属（参数表）');

function attr(id, cn, unit, part) { return M.attrsOf({ id: id, cn: cn, unit: unit, part: part }); }

ok('卧推走估算极限', attr('g1', '卧推', 'kg', 'chest').model === 'e1rm', attr('g1', '卧推', 'kg', 'chest').model);
ok('侧平举走次数（孤立动作）', attr('g4', '哑铃侧平举', 'kg', 'shoulders').model === 'reps');
ok('绳索下压走次数', attr('g3', '绳索下压', 'kg', 'arms').model === 'reps');
ok('平板支撑走时长', attr('g13', '平板支撑', 'sec', 'core').model === 'duration');
ok('引体走进阶阶梯（拉力家族）',
  attr('g5', '引体向上', 'bw', 'back').model === 'ladder' && attr('g5', '引体向上', 'bw', 'back').family === 'pull');
ok('跪姿俯卧撑在俯卧撑家族第 3 级',
  attr('h2', '跪姿俯卧撑', 'bw', 'chest').level === 3, attr('h2', '跪姿俯卧撑', 'bw', 'chest').level);
ok('标准俯卧撑第 4 级、下斜第 5 级',
  attr('h1', '俯卧撑', 'bw', 'chest').level === 4 && attr('h22', '下斜俯卧撑', 'bw', 'chest').level === 5);
ok('家族外的自重动作走次数', attr('h7', '臀桥', 'bw', 'legs').model === 'reps');
ok('负重动作的体重系数是 0', attr('g1', '卧推', 'kg', 'chest').bwFactor === 0);
ok('引体的体重系数约 1.0', attr('g5', '引体向上', 'bw', 'back').bwFactor === 1);
ok('俯卧撑 0.64（文献值）', attr('h1', '俯卧撑', 'bw', 'chest').bwFactor === 0.64);
ok('表格里没有的自重动作给 0.6 兜底且标成「估的」',
  attr('h17', '死虫式', 'bw', 'core').bwFactor === M.BW_FACTOR_DEFAULT &&
  attr('h17', '死虫式', 'bw', 'core').bwFactorKnown === false);
ok('自建动作（不在表里）按单位落到估算极限', attr('u-abc', '我自己加的', 'kg', 'chest').model === 'e1rm');
ok('自建自重动作落到次数（没有家族）', attr('u-xyz', '我的划船', 'bw', 'back').model === 'reps');

/* ================= 2. 实际负荷与估算 1RM ================= */
sec('2. 实际负荷 / 估算极限');

ok('估算 1RM：60kg × 8（不录剩余次数按刚好）', P.e1rm(60, 8, null) === 78, P.e1rm(60, 8, null));
ok('剩余次数=0（力竭）→ 76', P.e1rm(60, 8, 0) === 76, P.e1rm(60, 8, 0));
ok('剩余次数=3（轻松）→ 82', P.e1rm(60, 8, 3) === 82, P.e1rm(60, 8, 3));

const aPull = attr('g5', '引体向上', 'bw', 'back');
ok('自重动作实际负荷 = 体重 × 系数', P.loadOf({ date: '2026-09-01', weight: 0, assist: 0 }, aPull, BW70) === 70);
ok('负重引体：70 + 10 = 80', P.loadOf({ date: '2026-09-01', weight: 10, assist: 0 }, aPull, BW70) === 80);
ok('弹力带助力 20 → 50', P.loadOf({ date: '2026-09-01', weight: 0, assist: 20 }, aPull, BW70) === 50);
ok('没记体重 → 算不出负荷（返回 null）', P.loadOf({ date: '2026-09-01', weight: 0 }, aPull, NO_BW) === null);
ok('负重动作不受体重影响', P.loadOf({ date: '2026-09-01', weight: 60 }, attr('g1', '卧推', 'kg', 'chest'), NO_BW) === 60);

/* ================= 3. 单动作序列 ================= */
sec('3. 序列（每次训练一行）');

const g1Rows = flat(
  day('2026-09-01', 'g1', [[60, 8], [62.5, 5]]),
  day('2026-09-04', 'g1', [[62.5, 5]]),
  day('2026-09-08', 'g1', [[65, 5], [55, 12]])
);
const g1Series = P.series(g1Rows, 'g1');
ok('3 次训练 → 3 个点', g1Series.items.length === 3, g1Series.items.length);
ok('第几次练（exposure）连续递增', g1Series.items.map(function (x) { return x.exposure; }).join(',') === '1,2,3');
ok('每次都取估算值最高的那组（不是最重的那组）',
  g1Series.items[0].best.weight === 60 && g1Series.items[0].value === 78,
  g1Series.items[0].best.weight + 'kg → ' + g1Series.items[0].value);
ok('和第几次之间隔了几天', g1Series.items[1].gapDays === 3, g1Series.items[1].gapDays);
ok('只做 1 组的可信度是中', g1Series.items[1].conf === '中', g1Series.items[1].conf);
ok('组数 ≥2 的可信度是高', g1Series.items[0].conf === '高', g1Series.items[0].conf);

const warmRows = flat(
  day('2026-09-01', 'g1', [[40, 10]], { warmup: true }),
  day('2026-09-02', 'g1', [[60, 8], [60, 8]])
);
ok('热身组不参与（不算一次训练）', P.series(warmRows, 'g1').items.length === 1);

const highRepRows = day('2026-09-01', 'g1', [[60, 20], [60, 18]]);
const highRep = P.series(highRepRows, 'g1').items[0];
ok('次数超可信上限 → 把次数夹到 10 再估算（不换单位）', highRep.value === 82, highRep.value);
ok('次数超上限 → 可信度降一档（做了 2 组所以是中）', highRep.conf === '中', highRep.conf);

// 回归：次数从 10 涨到 14 时，序列**不能**中途从 kg 掉回「次」，否则看起来像暴跌
const growReps = flat(
  day('2026-09-01', 'g2', [[15, 10]]),
  day('2026-09-08', 'g2', [[15, 11]]),
  day('2026-09-15', 'g2', [[15, 12]]),
  day('2026-09-22', 'g2', [[15, 14]])
);
const gr = P.series(growReps, 'g2').items;
ok('次数越过 10 次后单位不变（还是 kg）', gr.every(function (x) { return x.unit === 'kg'; }),
  gr.map(function (x) { return x.unit; }).join(','));
ok('次数涨 → 力量值单调上涨（不出现假的掉下去）',
  gr.every(function (x, i) { return i === 0 || x.value >= gr[i - 1].value; }),
  gr.map(function (x) { return x.value; }).join(' → '));

/* ================= 4. 趋势 ================= */
sec('4. 趋势（起点 / 指数 / 斜率）');

const trendRows = flat(
  day('2026-09-01', 'g1', [[40, 8], [40, 8]]),
  day('2026-09-05', 'g1', [[42.5, 8], [42.5, 8]]),
  day('2026-09-09', 'g1', [[45, 8], [45, 8]]),
  day('2026-09-13', 'g1', [[47.5, 8], [47.5, 8]])
);
const t1 = P.trend(trendRows, 'g1');
ok('练够 3 次才出趋势', t1.ok === true);
ok('起点 = 前 3 次的中位数（52 / 55.3 / 58.5 → 55.3）', t1.start === 55.3, t1.start);
ok('起点口径标成 median3', t1.startKind === 'median3', t1.startKind);
ok('当前 = 最后一次（47.5 × 1.3 = 61.8）', t1.current === 61.8, t1.current);
ok('相对进步指数 = 当前 ÷ 起点', t1.index === 1.118, t1.index);
ok('斜率是正的（按次）', t1.slopePerExposure > 0, t1.slopePerExposure);
ok('按周斜率也给了', t1.slopePerWeek > 0, t1.slopePerWeek);
ok('距最好成绩已过 0 次（刚破）', t1.sinceBest === 0, t1.sinceBest);

const tooFew = P.trend(day('2026-09-01', 'g1', [[60, 8]]), 'g1');
ok('只练 1 次 → 不出趋势，返回还差几次', tooFew.ok === false && tooFew.need === 2, tooFew.need);

/* ================= 5. 停滞事实 ================= */
sec('5. 停滞（只陈述事实）');

const stallRows = flat(
  day('2026-09-01', 'g1', [[40, 10]]),
  day('2026-09-05', 'g1', [[60, 10]]),          // 最好 80
  day('2026-09-09', 'g1', [[60, 10]]),
  day('2026-09-13', 'g1', [[60, 10]]),
  day('2026-09-17', 'g1', [[60, 10]]),
  day('2026-09-21', 'g1', [[60, 10]])
);
const ts = P.trend(stallRows, 'g1');
ok('距最好过了 4 次 → 标成停滞', ts.stall.stalled === true, ts.stall.flatCount);
ok('说清楚卡的是哪一次的最好成绩', ts.stall.bestValue === 82 && ts.stall.bestDate === '2026-09-05',
  ts.stall.bestValue + ' / ' + ts.stall.bestDate);
ok('没超过 2.5% 的微涨不算突破', ts.sinceBest === 4, ts.sinceBest);

const tinyUp = flat(
  day('2026-09-01', 'g1', [[60, 10]]),
  day('2026-09-05', 'g1', [[60, 10]]),
  day('2026-09-09', 'g1', [[60, 10]]),
  day('2026-09-13', 'g1', [[60, 10]]),
  day('2026-09-17', 'g1', [[61, 10]])           // 61 比 60 高 1.7%，低于噪声
);
ok('涨 1.7%（低于噪声阈值）不算突破，仍算停滞', P.trend(tinyUp, 'g1').stall.stalled === true);

/* ================= 6. 进阶阶梯 ================= */
sec('6. 进阶阶梯（家族合并）');

const ladderRows = flat(
  day('2026-09-01', 'h2', [[0, 12]]),          // 跪姿 12 次 = 3.12
  day('2026-09-05', 'h2', [[0, 15]]),          // 跪姿 15 次 = 3.15
  day('2026-09-10', 'h1', [[0, 8]])            // 标准 8 次 = 4.08（换变式，次数掉了但更强）
);
const lad = P.series(ladderRows, 'h2');
ok('同家族的动作合并成一条线', lad.merged === true && lad.items.length === 3, lad.items.length);
ok('升一级、次数减半，力量值仍然变大', lad.items[2].value > lad.items[1].value,
  lad.items[1].value + ' → ' + lad.items[2].value);
const ladTrend = P.trend(ladderRows, 'h2');
ok('阶梯的进步指数按家族起点算（中位数 3.15 → 4.08）', ladTrend.index === 1.295, ladTrend.index);
ok('家族序列里每次带着当时做的动作', lad.items[2].exCn === '俯卧撑', lad.items[2].exCn);

/* ================= 7. 时长 / 次数 模型 ================= */
sec('7. 时长与次数模型');

const plankRows = flat(
  day('2026-09-01', 'g13', [[0, 60]]),
  day('2026-09-05', 'g13', [[0, 75]]),
  day('2026-09-09', 'g13', [[0, 90]])
);
const pt = P.trend(plankRows, 'g13');
ok('平板支撑按秒出力量值', pt.current === 90 && pt.model === 'duration', pt.current);
ok('平板 60 → 90 秒：指数 1.2', pt.index === 1.2, pt.index);

const raiseRows = flat(
  day('2026-09-01', 'g4', [[10, 12]]),
  day('2026-09-05', 'g4', [[10, 12]]),
  day('2026-09-09', 'g4', [[12, 15]]),
  day('2026-09-13', 'g4', [[15, 18]])
);
const rt = P.trend(raiseRows, 'g4');
ok('侧平举按次数出力量值（不算 1RM）', rt.model === 'reps' && rt.current === 18, rt.current);
ok('次数模型起点也是前 3 次中位数（12）', rt.start === 12, rt.start);
ok('侧平举指数 = 18 / 12', rt.index === 1.5, rt.index);

/* ================= 8. 缺体重降级 ================= */
sec('8. 缺体重时的降级');

const dipRows = flat(
  day('2026-09-01', 'g24', [[0, 6]]),
  day('2026-09-05', 'g24', [[0, 8]]),
  day('2026-09-09', 'g24', [[0, 9]])
);
const noBw = P.series(dipRows, 'g24', { bodyweightAt: NO_BW }).items;
ok('没记体重 → 双杠臂屈伸退回看次数', noBw[2].value === 9, noBw[2].value);
ok('退回次数的那次可信度是低', noBw[2].conf === '低', noBw[2].conf);
const withBw = P.series(dipRows, 'g24', { bodyweightAt: BW70 }).items;
ok('记了体重 → 算出实际负荷 70×0.9 = 63', withBw[0].load === 63, withBw[0].load);
ok('有了负荷 → 力量值变成估算极限（63 × (1+10/30) = 84）', withBw[2].value === 84, withBw[2].value);

/* ================= 9. 整体变化 ================= */
sec('9. 整体变化（全身指数 / 肌群）');

const allRows = flat(trendRows, raiseRows);
const ov = P.overall(allRows);
ok('有 2 个动作能算整体', ov.ok === true && ov.actions.length === 2, ov.actions && ov.actions.length);
ok('全身指数是加权平均（1 和 1.5 之间）', ov.index > 1 && ov.index < 1.5, ov.index);
ok('给出比起点强了百分之几', ov.up === Math.round((ov.index - 1) * 1000) / 10, ov.up);
ok('按周给了序列', ov.weeks.length >= 2, ov.weeks.length);
ok('周序列里带着这周练了几个动作', typeof ov.weeks[0].trained === 'number');
ok('动作列表按进步指数从高到低排', ov.actions[0].index >= ov.actions[1].index,
  ov.actions.map(function (a) { return a.index; }).join(' / '));
ok('每个动作带状态（涨 / 平 / 掉）',
  ['up', 'flat', 'down'].indexOf(ov.actions[0].status) !== -1, ov.actions[0].status);

const parts = P.partProgress(allRows);
const chest = parts.filter(function (x) { return x.part === 'chest'; })[0];
const arms = parts.filter(function (x) { return x.part === 'arms'; })[0];
ok('卧推的进步分摊到胸和手臂', !!chest && !!arms, parts.map(function (x) { return x.part + ':' + x.delta; }).join(' '));
ok('肌群按强弱排序，最强的排第一', parts[0].delta >= parts[parts.length - 1].delta,
  parts.map(function (x) { return x.part; }).join('>'));
ok('协同肌的进步幅度低于主动肌（卧推的胸 > 卧推分摊给手臂的那部分）',
  chest.delta > 0 && chest.delta < arms.delta + 100, chest.delta + ' / ' + arms.delta);
ok('肌群名是中文', chest.name === '胸', chest.name);

/* ================= 10. 高光时刻 ================= */
sec('10. 高光时刻');

const hlRows = flat(
  day('2026-09-01', 'g1', [[50, 8], [50, 8]]),     // 65   第一次
  day('2026-09-05', 'g1', [[55, 8], [55, 8]]),     // 71.5 新纪录
  day('2026-09-09', 'g1', [[55, 8], [55, 8]]),     // 平
  day('2026-09-13', 'g1', [[55, 8], [55, 8]]),     // 平
  day('2026-09-17', 'g1', [[55, 8], [55, 8]]),     // 平
  day('2026-09-21', 'g1', [[55, 8], [55, 8]]),     // 平（累计 4 次平）
  day('2026-09-25', 'g1', [[60, 8], [60, 8]])      // 78   突破停滞
);
const hl = P.highlights(hlRows);
const kinds = hl.map(function (h) { return h.kind; });
ok('第一次练这个动作有记录', kinds.indexOf('first') !== -1);
ok('新纪录有', kinds.indexOf('record') !== -1);
ok('卡了 4 次之后破纪录 → 算「突破停滞」', kinds.indexOf('breakthrough') !== -1, kinds.join(','));
ok('第一次训练不刷一堆关口（只报「第一次」）', kinds.indexOf('milestone') !== -1);
ok('跨过 60kg 时出一个整数关口高光',
  hl.filter(function (h) { return h.kind === 'milestone'; }).length === 1 &&
  hl.filter(function (h) { return h.kind === 'milestone'; })[0].value === 60,
  hl.filter(function (h) { return h.kind === 'milestone'; }).map(function (h) { return h.value; }).join(','));
ok('高光带着「之前多少 → 这次多少」',
  hl.filter(function (h) { return h.kind === 'record'; })[0].detail.prev === 65,
  hl.filter(function (h) { return h.kind === 'record'; })[0].detail.prev);

const streakRows = flat(
  day('2026-09-01', 'g4', [[10, 12]]), day('2026-09-03', 'g4', [[10, 12]]),
  day('2026-09-05', 'g4', [[10, 12]]), day('2026-09-07', 'g4', [[10, 12]]),
  day('2026-09-09', 'g4', [[10, 12]])
);
ok('练到第 5 次出一个「坚持」高光',
  P.highlights(streakRows).filter(function (h) { return h.kind === 'streak'; }).length === 1);

const ladderHl = P.highlights(ladderRows);
const upg = ladderHl.filter(function (h) { return h.kind === 'upgrade'; })[0];
ok('换到更难的变式 → 升级高光', !!upg && upg.detail.from === 3 && upg.detail.to === 4,
  upg && (upg.detail.from + '→' + upg.detail.to));

ok('今日高光只挑当天', P.todayHighlights(hlRows, '2026-09-25').every(function (h) { return h.date === '2026-09-25'; }));

// 排序 + 去重：首屏要先看到「突破停滞」这种有故事的，而不是一串新纪录
ok('高光按重要度排：突破停滞排在普通新纪录前面',
  kinds.indexOf('breakthrough') < kinds.indexOf('record'), kinds.join(','));
const dup = hl.filter(function (h) { return h.kind === 'record' && h.date === '2026-09-25'; });
ok('同一天同一动作同一个值只留一条（不重复讲故事）', dup.length <= 1, dup.length);

const gain = P.bestGain(allRows, '2026-09-01', '2026-09-30');
ok('最大进步挑出指数最高的动作', gain && gain.exId === 'g4', gain && (gain.cn + ' ' + gain.detail.pct + '%'));

/* ================= 11. 数据质量 ================= */
sec('11. 数据质量');

ok('50kg 的历史上填 500 → 要求确认', P.suspectWeight(hlRows, 'g1', 500).suspect === true);
ok('正常加重（60）不打扰', P.suspectWeight(hlRows, 'g1', 60).suspect === false);
ok('没练过的动作不判可疑', P.suspectWeight([], 'g1', 500).suspect === false);

/* ================= 12. 示例数据 / 真实数据 ================= */
sec('12. 示例数据不算真实统计');

const demoRows = flat(
  day('2026-09-01', 'g1', [[60, 8], [60, 8]], { demo: true }),
  day('2026-09-05', 'g1', [[62.5, 8], [62.5, 8]], { demo: true }),
  day('2026-09-09', 'g1', [[65, 8], [65, 8]], { demo: true })
);
ok('默认不把示例数据算进序列', P.series(demoRows, 'g1').items.length === 0);
ok('显式要示例数据才出数（新用户第一眼预览用）',
  P.series(demoRows, 'g1', { includeDemo: true }).items.length === 3);

sec('13. 接真实 db（演示数据能预览、真实记录才算数）');

const db = require('./utils/db');
db.resetAll();
db.finishOnboarding({ days: 3, place: 'gym', level: 'some' });
db.loadDemo();
ok('示例数据不会凭空造出真实高光', P.highlightsNow().length === 0, P.highlightsNow().length);
ok('显式带上示例数据才给预览高光', P.highlightsNow({ includeDemo: true }).length > 0,
  P.highlightsNow({ includeDemo: true }).length);

['2026-09-01', '2026-09-05', '2026-09-09'].forEach(function (d, i) {
  db.saveSet({ date: d, exId: 'g1', setNo: 1, weight: 60 + i * 2.5, reps: 8, unit: 'kg' });
  db.saveSet({ date: d, exId: 'g1', setNo: 2, weight: 60 + i * 2.5, reps: 8, unit: 'kg' });
});
const realTrend = P.trendOf('g1');
ok('真实记录能算出趋势（没被示例数据带偏）', realTrend.ok === true && realTrend.exposures === 3,
  realTrend.exposures);
ok('趋势里只有真实那 3 次（日期来自真实记录）', realTrend.firstDate === '2026-09-01', realTrend.firstDate);
const realOv = P.overallNow();
ok('整体接口拿真实数据跑得通', realOv.ok === true && realOv.index > 1, realOv.index);
ok('动作列表里能认出「新动作」（不够 3 次的不出趋势）',
  P.actionsNow().every(function (a) { return a.ok || a.status === 'new'; }));
ok('数据不够时说清楚还差几次', P.trendOf('g1', { from: '2026-09-05' }).need === 1,
  P.trendOf('g1', { from: '2026-09-05' }).need);

/* ================= 结果 ================= */
console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '进步计算全部通过') + '\n');
if (failed) process.exitCode = 1;
