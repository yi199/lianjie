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

/**
 * 造最近五周的假记录（含今天），让数据页第一眼就有东西看。
 * 按新的排法：每周练 target 次，模板顺序循环，重量逐周微增。
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

  let k = 0;   // 模板按顺序取

  for (let w = 4; w >= 0; w--) {
    const progress = 1 + (4 - w) * 0.02;    // 越近的周越重，看得出进步

    offsets.forEach(function (off) {
      const day = D.shift(today, -(off + w * 7));
      if (day > today) return;              // 兜底，正常到不了

      const p = plans[k % plans.length];
      k++;

      // 过去的训练日 18:00 开练，一组约 2.5 分钟（含组间休息），给完成时刻排出先后。
      // 今天的这次不能排到 18:00——用户可能上午就点了「示例数据」，
      // 所以从此刻往回推最长可能时长，保证不出现「未来的记录」。
      const totalMs = p.items.reduce(function (a, it) { return a + it.sets; }, 0) * 150000;
      const start = day === today
        ? now - totalMs - 60000
        : new Date(day + 'T18:00:00').getTime();
      let idx = 0;

      p.items.forEach(function (it, slot) {
        // 兜底 part 给空串，不要静默归到腿（会污染部位统计）
        const ex = CAT.find(it.exId) || { cn: it.exId, part: '' };
        for (let s = 0; s < it.sets; s++) {
          out.push({
            id: day + '-' + it.exId + '-' + (s + 1),
            date: day,
            exId: it.exId,
            exCn: ex.cn,
            part: ex.part,
            planKey: p.key,
            slot: slot,
            setNo: s + 1,
            weight: it.weight ? roundWeight(it.weight * progress) : 0,
            reps: it.reps,
            unit: it.unit || 'kg',
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
