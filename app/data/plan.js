/**
 * 计划模板
 *
 * 模型变了：不再是「周一练推日」，而是「本周 N 次，按 A → B → C 排队」。
 *
 *   今天该练什么 = 本周还没练的下一个训练日
 *   周一没练 → 周二还是 A（自动顺延，不需要手动补）
 *   本周练完 N 次 → 剩下几天显示「本周已完成」，下周一从 A 重新开始
 *
 * 输出是一串训练日模板，按顺序用：
 *   [{ key:'A', type:'push', name:'推日', en:'Push', items:[{exId,sets,reps,weight,unit}] }, ...]
 */

const CAT = require('../utils/catalog');   // 动作查表统一走它（官方清单 + 自建动作）

/* ---------------- 水平 → 组数次数 ---------------- */

const LEVEL = {
  new:     { sets: 3, repsKg: 12, repsBw: 10, sec: 30, wf: 0.6  },
  some:    { sets: 4, repsKg: 10, repsBw: 12, sec: 45, wf: 1.0  },
  trained: { sets: 4, repsKg: 8,  repsBw: 15, sec: 60, wf: 1.25 }
};

/* ---------------- 健身房动作的基线重量（some 水平） ---------------- */

const BASE_WEIGHT = {
  g1: 50, g2: 14, g3: 25, g4: 8, g6: 40, g7: 20, g8: 10,
  g9: 24, g10: 16, g11: 20, g12: 80,
  g15: 40, g16: 10, g17: 45, g18: 40, g19: 6, g20: 10, g21: 50, g22: 40,
  /* g23–g52（新增动作）。口径：some 水平、每组 10 次左右的合理起点；
     哑铃类记「单只」重量，和 g2/g4 一致。缺省的按 20kg 兜底，所以这里要补全。 */
  g23: 16, g25: 25, g26: 10, g27: 20, g28: 35, g29: 15, g31: 40,
  g32: 25, g33: 10, g34: 6, g35: 20, g36: 20, g37: 12, g38: 40,
  g39: 8, g40: 50, g41: 40, g42: 60, g43: 12, g44: 50, g45: 30,
  g46: 25, g47: 30, g49: 25, g50: 6
};

/* ---------------- 日类型 ---------------- */

const DAY_TYPES = {
  gym: {
    push:   { name: '推日',   en: 'Push',   ex: ['g1', 'g2', 'g4', 'g3'] },
    pull:   { name: '拉日',   en: 'Pull',   ex: ['g5', 'g6', 'g7', 'g8'] },
    legs:   { name: '腿日',   en: 'Legs',   ex: ['g9', 'g11', 'g12', 'g13'] },

    upperA: { name: '上肢 A', en: 'Upper A', ex: ['g1', 'g6', 'g2', 'g3'] },
    upperB: { name: '上肢 B', en: 'Upper B', ex: ['g5', 'g18', 'g4', 'g8'] },
    lowerA: { name: '下肢 A', en: 'Lower A', ex: ['g9', 'g12', 'g22', 'g13'] },
    lowerB: { name: '下肢 B', en: 'Lower B', ex: ['g11', 'g21', 'g10', 'g14'] },

    fullA:  { name: '全身 A', en: 'Full A', ex: ['g9', 'g1', 'g6', 'g13'] },
    fullB:  { name: '全身 B', en: 'Full B', ex: ['g11', 'g2', 'g5', 'g10'] }
  },
  home: {
    push:   { name: '推日',   en: 'Push',   ex: ['h1', 'h3', 'h2'] },
    pull:   { name: '拉日',   en: 'Pull',   ex: ['h4', 'h5', 'h14'] },
    legs:   { name: '腿日',   en: 'Legs',   ex: ['h6', 'h8', 'h7', 'h9'] },

    upperA: { name: '上肢 A', en: 'Upper A', ex: ['h1', 'h5', 'h19'] },
    upperB: { name: '上肢 B', en: 'Upper B', ex: ['h2', 'h4', 'h3'] },
    lowerA: { name: '下肢 A', en: 'Lower A', ex: ['h6', 'h7', 'h9'] },
    lowerB: { name: '下肢 B', en: 'Lower B', ex: ['h8', 'h16', 'h10'] },

    fullA:  { name: '全身 A', en: 'Full A', ex: ['h6', 'h1', 'h5', 'h9'] },
    fullB:  { name: '全身 B', en: 'Full B', ex: ['h8', 'h2', 'h4', 'h10'] }
  }
};

/* ---------------- 一周几次 → 用哪几个训练日模板，按什么顺序 ---------------- */

const SCHEDULE = {
  2: ['fullA', 'fullB'],
  3: ['push', 'pull', 'legs'],
  4: ['upperA', 'lowerA', 'upperB', 'lowerB']
};

/* ---------------- 生成 ---------------- */

/** 重量取到 2.5kg 的整数倍（杠铃片最小单位） */
function roundWeight(w) {
  return Math.max(0, Math.round(w / 2.5) * 2.5);
}

function makeItems(exIds, lv) {
  const out = [];
  exIds.forEach(function (id) {
    const ex = CAT.find(id);
    if (!ex) return;

    if (ex.unit === 'sec') {
      out.push({ exId: id, sets: 3, reps: lv.sec, weight: 0, unit: 'sec' });
      return;
    }
    if (ex.unit === 'bw') {
      out.push({ exId: id, sets: lv.sets, reps: lv.repsBw, weight: 0, unit: 'bw' });
      return;
    }
    const base = BASE_WEIGHT[id] || 20;
    out.push({
      exId: id,
      sets: lv.sets,
      reps: lv.repsKg,
      weight: roundWeight(base * lv.wf),
      unit: 'kg'
    });
  });
  return out;
}

/**
 * 生成训练日模板队列
 * @returns {Array} [{ key, type, name, en, items }]
 */
function buildPlan(days, place, level) {
  const order = SCHEDULE[days] || SCHEDULE[3];
  const types = DAY_TYPES[place === 'home' ? 'home' : 'gym'];
  const lv = LEVEL[level] || LEVEL.some;

  return order.map(function (k, i) {
    const t = types[k] || types.fullA;
    return {
      key: String.fromCharCode(65 + i),   // A / B / C / D
      type: k,
      name: t.name,
      en: t.en,
      items: makeItems(t.ex, lv)
    };
  });
}

/** 「一周 3 练 · 健身房」 */
function describe(profile) {
  if (!profile) return '';
  return '一周 ' + profile.days + ' 练 · ' + (profile.place === 'home' ? '居家' : '健身房');
}

/**
 * 计划签名。
 * 设置一变（水平/频率/场所），旧记录里的 A/B/C 就不再指同一套动作了，
 * 所以记录要带上签名，推进训练日时只认当前这套。
 */
function planSig(profile) {
  if (!profile) {
    profile = {};
  }
  return (profile.level || 'some') + '|' +
    (Number(profile.days) || 3) + '|' +
    (profile.place === 'home' ? 'home' : 'gym');
}

/**
 * 某个动作「第一次做」该上多重。
 * 换动作时必须用它，不能一律给 20kg（腿举和弯举的起点差 4 倍）。
 */
function initialWeight(exId, level) {
  const ex = CAT.find(exId);
  if (!ex || ex.unit !== 'kg') return 0;
  const lv = LEVEL[level] || LEVEL.some;
  const base = BASE_WEIGHT[exId] || 20;
  return roundWeight(base * lv.wf);
}

/* ---------------- 示例数据（用户主动点了才生成） ---------------- */

const DEMO_WEEKS = 12;      // 示例数据铺 12 周：进步曲线、周走势、停滞与突破都要够长才看得出来

// 每周实际练了几次（索引 = 周序号，0 是最早，11 是本周）。
// 只影响「那一周排几次课」，不影响重量递增的节奏——重量仍按周序号走。
// 为什么不全是 3：地形图的高度就是每周组数，十二周一样高会画成一块砖。
// 为什么不是「整齐地每三周漏一次」：那样会变成一把等距锯齿，一眼假。
const DEMO_ATTEND = [3, 3, 3, 2, 3, 3, 3, 1, 3, 3, 2, 3];

/** 示例数据的「故事节奏」：前 5 周涨 → 第 6–9 周卡住 → 第 10 周起突破（§7.4 要能产生这些事件） */
function demoPace(week) {
  if (week <= 4) return 1 + week * 0.018;               // 稳步加重
  if (week <= 8) return 1 + 4 * 0.018;                  // 停滞：重量不再动
  return 1 + 4 * 0.018 + (week - 8) * 0.030;            // 突破：涨得比之前更猛
}

/** 不同部位涨得快慢不同，肌群榜才不会一条直线 */
const DEMO_SPEED = { legs: 1.7, back: 1.5, chest: 1.2, shoulders: 0.8, arms: 0.7, core: 0.5 };

/** 前 3 周让俯卧撑还停在跪姿，第 4 周「升级」到标准 —— 进阶阶梯要有真实故事 */
function demoExId(exId, week) {
  if (exId === 'h1' && week < 3) return 'h2';
  return exId;
}

/** 这两个动作最后几周一直没长：「卡住了」的样子也得在示例数据里看得到 */
const DEMO_STALLED = ['g5', 'g13'];

/**
 * 造最近 12 周的假记录（含今天），让数据页/进步页第一眼就有东西看。
 * 重量不是线性涨：中间有一段停滞、后面一次突破，这样「停滞提示」「突破高光」都能被看见。
 */
function makeDemoSets(plans, target) {
  const D = require('../utils/date');
  const out = [];
  if (!plans || !plans.length) return out;

  const n = Number(target) || plans.length;
  // 距「今天」几天练一次（0 = 今天）。必须含今天和昨天：
  // 今天正好是月初的周一时，若按「周一起算」排，最近一周全落在上个月，
  // 本月一条记录都没有，数据页是空的——示例数据就白点了。
  const offsets = n >= 4 ? [0, 1, 3, 5] : (n === 3 ? [0, 1, 3] : [0, 1]);

  const today = D.today();
  const now = Date.now();

  // 同一个动作在不同训练日可能给了不同的计划重量。示例数据统一用它的「最大计划重量」做基准，
  // 否则序列会忽高忽低，进步页上看起来像「掉了一大截」——那是模板差异，不是退步。
  const base = {};
  plans.forEach(function (p) {
    p.items.forEach(function (it) {
      const cur = base[it.exId];
      if (!cur || (it.weight || 0) > cur.weight) {
        base[it.exId] = { weight: it.weight || 0, reps: it.reps, unit: it.unit || 'kg' };
      }
    });
  });

  let k = 0;   // 模板按顺序取

  for (let w = DEMO_WEEKS - 1; w >= 0; w--) {
    const week = DEMO_WEEKS - 1 - w;        // 0 = 最早的一周，11 = 本周

    // 每周实际练几次：真实的人会漏课（出差 / 加班），而且漏得不规律。
    // 这张表是给**地形图**用的——地形画的是「每周完成组数」，如果十二周都是
    // 同样几节课，画出来就是一块砖；整齐地每三周漏一次，又像假数据。
    // 不跳本周（最后一项），用户点「示例数据」时本周应该有东西。
    const attend = Math.min(DEMO_ATTEND[week] || offsets.length, offsets.length);

    offsets.forEach(function (off, oi) {
      const day = D.shift(today, -(off + w * 7));
      if (day > today) return;              // 兜底，正常到不了

      // 这一周实际练了几次（见 DEMO_ATTEND）。不规律的漏课才是真实的，
      // 漏成每三周一次的话，地形会变成一把整齐的锯齿——一眼就是假数据。
      if (oi >= attend) return;

      const p = plans[k % plans.length];
      k++;
      // 这一次少做几组（0 / 1 / 2）。表达式是「确定性抖动」，不用随机数，
      // 保证每次生成的数据一模一样（否则测试和截图都没法对比）。
      const cut = (week * 7 + oi * 3) % 5 === 0 ? 2 : ((week + oi * 2) % 3 === 0 ? 1 : 0);

      // 过去的训练日 18:00 开练，一组约 2.5 分钟（含组间休息），给完成时刻排出先后。
      // 今天的这次不能排到 18:00——用户可能上午就点了「示例数据」，
      // 所以从此刻往回推最长可能时长，保证不出现「未来的记录」。
      const totalMs = p.items.reduce(function (a, it) { return a + it.sets; }, 0) * 150000;
      const start = day === today
        ? now - totalMs - 60000
        : new Date(day + 'T18:00:00').getTime();
      let idx = 0;

      p.items.forEach(function (it, slot) {
        const exId = demoExId(it.exId, week);
        // 兜底 part 给空串，不要静默归到腿（会污染部位统计）
        const ex = CAT.find(exId) || { cn: exId, part: '' };
        // 卡住的动作从第 8 周起就不再进步（停滞提示才有东西可说）
        const pace = DEMO_STALLED.indexOf(exId) !== -1 ? demoPace(Math.min(week, 7)) : demoPace(week);
        const speed = DEMO_SPEED[ex.part] || 1;
        // 每个动作按自己的部位涨速乘上去，越到后面差距越明显
        const mult = 1 + (pace - 1) * speed;
        const unit = it.unit || 'kg';
        const b = base[exId] || { weight: it.weight || 0, reps: it.reps };
        // 自重 / 计时动作没有重量，进步体现在次数和秒数上（不然这些动作永远是「持平 1.00×」）。
        // 幅度要克制：12 周自重动作涨 2–3 次、静力涨几秒，比重量动作的 +20% 更接近真实。
        // 次数也跟着涨一点点（轻重量 10→12.5 这种小步长，光靠加重量看不出进步）
        const extra = Math.round((pace - 1) * speed * (unit === 'sec' ? 45 : 18));
        const reps = Math.max(1, (b.reps || it.reps) + extra);
        const w0 = b.weight || 0;
        // 最后一组偶尔少做 1–2 组：谁都不是每次都把计划做满。
        // 纯为地形好看——十二周每周都精确 47 组的话，峰顶会变成一条条平顶，
        // 一看就是拼出来的。这里的抖动是确定性的（不随每次生成变），方便测试。
        const nsets = Math.max(1, it.sets - (slot === p.items.length - 1 ? cut : 0));
        for (let s = 0; s < nsets; s++) {
          out.push({
            id: day + '-' + exId + '-' + (s + 1),
            date: day,
            exId: exId,
            exCn: ex.cn,
            part: ex.part,
            planKey: p.key,
            slot: slot,
            setNo: s + 1,
            weight: w0 ? roundWeight(w0 * mult) : 0,
            reps: reps,
            unit: unit,
            targetReps: it.reps,
            targetSets: it.sets,
            completedAt: new Date(start + (idx++) * 150000).toISOString(),
            demo: true,            // 示例数据：永不上传
            done: true
          });
        }
      });
    });
  }

  return out;
}

module.exports = {
  LEVEL, BASE_WEIGHT, SCHEDULE, DAY_TYPES,
  buildPlan, describe, makeDemoSets, roundWeight, makeItems,
  planSig, initialWeight
};
