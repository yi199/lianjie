/**
 * 进步模型 · 参数表（V1 初版，待专业校准）
 *
 * 依据：docs/设计文档/进步可视化.md §4（统一动作模型）、§11（专业体系）
 *
 * 这个文件里只有**数据**，没有算法：V4 专业体系校准的时候替换表里的值，
 * `utils/progress.js` 一行都不用改。所以别把「卧推属于复合动作」这类判断写进 if 里。
 *
 * 表里的数值来源标注：
 *   [文献] 有公开研究支撑（俯卧撑系列的体重系数来自 Ebben 2011 一类测力台研究）
 *   [估]   保守估计，等 V4 校准
 */

const MODEL = {
  E1RM: 'e1rm',          // 复合动作：估算极限
  REPS: 'reps',          // 孤立 / 器械 / 弹力带：单组最多次数
  DURATION: 'duration',  // 静力：单次最长秒数
  LADDER: 'ladder'       // 自重进阶家族：级别 + 该级别次数
};

/* ---------------- 全局参数 ---------------- */

const PARAMS = {
  credReps: 10,        // [文献] 超过 10 次的组不参与估算 1RM（LeSuer 1997 / Reynolds 2006）
  defaultRir: 1,       // 产品决定：不录剩余次数时按「刚好」（约还能做 1 次）
  noise: 0.025,        // 噪声阈值 2.5%（§5.5 暂定，规划层上线后按水平传入）
  stallAfter: 4,       // 距最好成绩已经过几次训练算「停滞事实」（§6.3 默认）
  startN: 3,           // 起点取前 3 次的【中位数】（§13 待讨论 #3，先这么定）
  minExposures: 3      // 少于此数不出趋势（§10 数据质量）
};

/* ---------------- 进步模型归属 ---------------- */

/**
 * 用「次数」而不是估算极限的动作。
 * 判定依据 §5.1：孤立动作和器械上相同 %1RM 能做的次数差太多，Epley 在这些动作上不准。
 * 命中这张表、或者命中下面的关键词，就走 REPS 模型。
 */
const REPS_IDS = [
  'g3', 'g4', 'g7', 'g8', 'g16', 'g19', 'g20', 'g22', 'g25', 'g26',
  'g29', 'g31', 'g34', 'g35', 'g36', 'g37', 'g39', 'g45', 'g46', 'g47', 'g49', 'g50'
];

/**
 * 兜底关键词：表里漏了的动作靠它落到 REPS；宁可退回次数，也不要给出假 e1RM。
 * 注意别把「臂屈伸」写进来——双杠臂屈伸是复合动作，走估算极限更准（见 BW_COMPOUND_IDS）。
 */
const REPS_WORDS = /弯举|平举|飞鸟|夹胸|下压|提踵|腿屈伸|弯腿|耸肩|面拉|卷腹|转体/;

/** 自重复合动作：有体重系数、也能算估算极限（引体那类已经在阶梯里了） */
const BW_COMPOUND_IDS = ['g24'];

/** 静力动作：按秒记，模型固定 duration（unit=sec 也会兜到这儿） */
const SEC_IDS = ['g13', 'g51', 'h9', 'h10', 'h15', 'h45', 'h50', 'h51', 'h52', 'h53'];

/* ---------------- 体重系数（实际负荷用） ---------------- */

/**
 * 自重动作的体重系数 [估]/[文献]；负重动作不在这张表里（系数 0，公式自动退化成外加重量）。
 * 没记录的按 0.6 兜底，并在可信度上扣一档——别让缺数据看起来像准的。
 */
const BW_FACTOR = {
  // 俯卧撑家族 [文献]
  h21: 0.30,   // 墙壁俯卧撑
  h12: 0.45,   // 上斜俯卧撑
  h2: 0.49,    // 跪姿俯卧撑（Ebben 2011 量级）
  h1: 0.64,    // 标准俯卧撑（Ebben 2011）
  h13: 0.64,   // 宽距
  h20: 0.70,   // 钻石
  h22: 0.75,   // 下斜
  // 引体家族 [估]
  g5: 1.00,    // 引体向上
  g30: 0.95,   // 反手引体
  h4: 0.55,    // 反向划船
  // 臂屈伸 / 蹲类 [估]
  g24: 0.90,   // 双杠臂屈伸
  h3: 0.40,    // 板凳臂屈伸
  h37: 0.70,   // 相扑深蹲
  h6: 0.70,    // 徒手深蹲
  h8: 0.65,    // 弓步蹲
  h18: 0.65,   // 后撤步弓步
  h39: 0.60,   // 侧向弓步
  h40: 0.65,   // 保加利亚分腿蹲（居家）
  h7: 0.50,    // 臀桥
  h44: 0.50,   // 靠墙臀桥
  h16: 0.60,   // 单腿臀桥
  h38: 0.65,   // 单腿硬拉
  g52: 0.55,   // 健腹轮
  h11: 0.45,   // 仰卧举腿
  g48: 0.45,   // 悬垂举腿
  h14: 0.35,   // 俯卧挺身
  h26: 0.30    // 游泳式
};

const BW_FACTOR_DEFAULT = 0.60;

/* ---------------- 进阶阶梯 ---------------- */

/**
 * 自重进阶家族：级别越高越难。同一个家族的动作**合并成一条序列**（§10：换变式不算换动作）。
 * 级别内并列的动作（宽距/标准俯卧撑）算同一级，谁先做都行。
 */
const LADDERS = {
  pushup: {
    name: '俯卧撑',
    levels: [
      { level: 1, cn: '墙壁俯卧撑', ids: ['h21'] },
      { level: 2, cn: '上斜俯卧撑', ids: ['h12'] },
      { level: 3, cn: '跪姿俯卧撑', ids: ['h2'] },
      { level: 4, cn: '标准俯卧撑', ids: ['h1', 'h13'] },
      { level: 5, cn: '下斜 / 钻石', ids: ['h22', 'h20'] }
    ]
  },
  pull: {
    name: '拉力',
    levels: [
      { level: 1, cn: '反向划船', ids: ['h4', 'h5', 'h24'] },
      { level: 2, cn: '引体向上', ids: ['g5', 'g30'] }
    ]
  },
  squat: {
    name: '下肢蹲',
    levels: [
      { level: 1, cn: '徒手深蹲', ids: ['h6', 'h37'] },
      { level: 2, cn: '弓步蹲', ids: ['h8', 'h18', 'h39'] },
      { level: 3, cn: '保加利亚分腿蹲', ids: ['h40'] }
    ]
  }
};

/* ---------------- 肌群参与度 ---------------- */

/**
 * 主动肌 1.0 + 协同肌分摊（§4.5）。按「部位 → 协同」的规则表给默认值，
 * 再允许单个动作覆盖（卧推这类有明确共识的先写死）。
 * 用途：把动作的进步分摊到肌群（§7.3），不是给单次训练算功劳。
 */
const SECONDARY_BY_PART = {
  chest: { arms: 0.40, shoulders: 0.25 },
  back: { arms: 0.50 },
  shoulders: { arms: 0.30, chest: 0.10 },
  legs: { core: 0.30 },
  arms: { shoulders: 0.10 },
  core: {}
};

/** 单个动作的精确覆盖（主动肌可以是别的部位，比如双杠臂屈伸主练胸） */
const PART_WEIGHT_OVERRIDE = {
  g1: { chest: 1.0, arms: 0.50, shoulders: 0.30 },   // 卧推
  g40: { legs: 1.0, core: 0.40 },                    // 杠铃深蹲
  g42: { legs: 1.0, back: 0.50, core: 0.30 },        // 硬拉
  g5: { back: 1.0, arms: 0.60 },                     // 引体
  g24: { chest: 1.0, arms: 0.60 },                   // 双杠臂屈伸
  h1: { chest: 1.0, arms: 0.45, shoulders: 0.25 },   // 俯卧撑
  h6: { legs: 1.0, core: 0.25 }                      // 徒手深蹲
};

/* ---------------- 里程碑（高光用） ---------------- */

/**
 * 「整数关口」的具体数值表（§13 待讨论 #4，V2 再细化）。
 * 只在**第一次跨过**时出高光，不是每次达到都出。
 */
const MILESTONES = {
  kg: [20, 30, 40, 50, 60, 80, 100, 120, 140, 160, 180, 200],
  reps: [5, 8, 10, 15, 20, 25, 30, 40, 50],
  sec: [30, 45, 60, 90, 120, 180, 240, 300],
  ladder: []          // 阶梯的里程碑就是「升级」，单独算
};

/** 「坚持」高光：某个动作累计练到这些次数 */
const EXPOSURE_MILESTONES = [5, 10, 25, 50, 100, 200];

/* ---------------- 查表 ---------------- */

function inList(id, list) {
  return list.indexOf(id) !== -1;
}

/** 找 id 属于哪个进阶家族 + 级别；不在任何家族返回 null */
function ladderOf(id) {
  const keys = Object.keys(LADDERS);
  for (let i = 0; i < keys.length; i++) {
    const fam = LADDERS[keys[i]];
    for (let j = 0; j < fam.levels.length; j++) {
      const lv = fam.levels[j];
      if (inList(id, lv.ids)) {
        return { family: keys[i], familyName: fam.name, level: lv.level, levelCn: lv.cn, maxLevel: fam.levels.length };
      }
    }
  }
  return null;
}

/** 该家族的所有动作 id（合并序列用） */
function familyIds(family) {
  const fam = LADDERS[family];
  if (!fam) return [];
  return fam.levels.reduce(function (a, lv) { return a.concat(lv.ids); }, []);
}

/**
 * 一个动作的进步属性。官方动作和自建动作都走这里——
 * 自建动作没有 id 配置，就按 unit/部位/关键词落默认值（并且在可信度上不额外惩罚，
 * 因为用户自己建的动作本来就只能看趋势）。
 */
function attrsOf(ex) {
  const id = ex && ex.id ? ex.id : '';
  const cn = (ex && ex.cn) || '';
  const unit = (ex && ex.unit) || 'kg';
  const part = (ex && ex.part) || '';

  let model;
  let ladder = null;

  if (unit === 'sec' || inList(id, SEC_IDS)) {
    model = MODEL.DURATION;
  } else if (unit === 'bw') {
    ladder = ladderOf(id);
    // 家族里的动作走阶梯；家族外的自重复合动作能算估算极限，其余按次数记
    if (ladder) model = MODEL.LADDER;
    else if (inList(id, BW_COMPOUND_IDS)) model = MODEL.E1RM;
    else model = MODEL.REPS;
  } else if (inList(id, REPS_IDS) || REPS_WORDS.test(cn)) {
    model = MODEL.REPS;
  } else {
    model = MODEL.E1RM;
  }

  return {
    id: id,
    cn: cn,
    part: part,
    unit: unit,
    model: model,
    // 体重系数只对「要靠体重才有负荷」的动作有意义
    bwFactor: unit === 'bw' ? (BW_FACTOR[id] || BW_FACTOR_DEFAULT) : 0,
    bwFactorKnown: unit === 'bw' ? Object.prototype.hasOwnProperty.call(BW_FACTOR, id) : true,
    family: ladder ? ladder.family : '',
    familyName: ladder ? ladder.familyName : '',
    level: ladder ? ladder.level : 0,
    levelCn: ladder ? ladder.levelCn : '',
    credReps: PARAMS.credReps
  };
}

/** 肌群参与度：{ chest: 1, arms: 0.5, ... } */
function partWeights(ex) {
  const id = ex && ex.id;
  if (PART_WEIGHT_OVERRIDE[id]) return PART_WEIGHT_OVERRIDE[id];
  const own = (ex && ex.part) || '';
  if (!own) return {};
  const w = {};
  w[own] = 1;
  const sec = SECONDARY_BY_PART[own] || {};
  Object.keys(sec).forEach(function (k) {
    if (k !== own) w[k] = sec[k];
  });
  return w;
}

module.exports = {
  MODEL, PARAMS, LADDERS, MILESTONES, EXPOSURE_MILESTONES,
  BW_FACTOR, BW_FACTOR_DEFAULT, REPS_IDS, REPS_WORDS, SEC_IDS,
  SECONDARY_BY_PART, PART_WEIGHT_OVERRIDE,
  attrsOf, ladderOf, familyIds, partWeights
};
