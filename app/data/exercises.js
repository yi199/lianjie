/**
 * 动作字典
 *
 * place: gym = 健身房（需要器械），home = 居家（徒手/一条毛巾即可）
 * unit:  kg = 记重量, bw = 自重（记次数）, sec = 计时（记秒数）
 *
 * 表里只放「动作是什么」，不放重量——重量是计划模板决定的。
 */

const EXERCISES = [
  /* ---------------- 健身房 ---------------- */
  { id: 'g1',  cn: '卧推',       en: 'Bench Press',    part: 'chest',     place: 'gym', unit: 'kg'  },
  { id: 'g2',  cn: '哑铃推举',   en: 'Shoulder Press', part: 'shoulders', place: 'gym', unit: 'kg'  },
  { id: 'g3',  cn: '绳索下压',   en: 'Triceps Push',   part: 'arms',      place: 'gym', unit: 'kg'  },
  { id: 'g4',  cn: '哑铃侧平举', en: 'Lateral Raise',  part: 'shoulders', place: 'gym', unit: 'kg'  },
  { id: 'g5',  cn: '引体向上',   en: 'Pull-up',        part: 'back',      place: 'gym', unit: 'bw'  },
  { id: 'g6',  cn: '俯身划船',   en: 'Barbell Row',    part: 'back',      place: 'gym', unit: 'kg'  },
  { id: 'g7',  cn: '面拉',       en: 'Face Pull',      part: 'back',      place: 'gym', unit: 'kg'  },
  { id: 'g8',  cn: '哑铃弯举',   en: 'Biceps Curl',    part: 'arms',      place: 'gym', unit: 'kg'  },
  { id: 'g9',  cn: '高脚杯深蹲', en: 'Goblet Squat',   part: 'legs',      place: 'gym', unit: 'kg'  },
  { id: 'g10', cn: '壶铃摆荡',   en: 'Kettlebell Swing', part: 'legs',    place: 'gym', unit: 'kg'  },
  { id: 'g11', cn: '箭步蹲',     en: 'Lunge',          part: 'legs',      place: 'gym', unit: 'kg'  },
  { id: 'g12', cn: '腿举',       en: 'Leg Press',      part: 'legs',      place: 'gym', unit: 'kg'  },
  { id: 'g13', cn: '平板支撑',   en: 'Plank',          part: 'core',      place: 'gym', unit: 'sec' },
  { id: 'g14', cn: '卷腹',       en: 'Crunch',         part: 'core',      place: 'gym', unit: 'bw'  },

  /* ---------------- 居家 ---------------- */
  { id: 'h1',  cn: '俯卧撑',     en: 'Push-up',        part: 'chest',     place: 'home', unit: 'bw'  },
  { id: 'h2',  cn: '跪姿俯卧撑', en: 'Knee Push-up',   part: 'chest',     place: 'home', unit: 'bw'  },
  { id: 'h3',  cn: '板凳臂屈伸', en: 'Bench Dip',      part: 'arms',      place: 'home', unit: 'bw'  },
  { id: 'h4',  cn: '反向划船',   en: 'Inverted Row',   part: 'back',      place: 'home', unit: 'bw'  },
  { id: 'h5',  cn: '毛巾划船',   en: 'Towel Row',      part: 'back',      place: 'home', unit: 'bw'  },
  { id: 'h6',  cn: '徒手深蹲',   en: 'Bodyweight Squat', part: 'legs',    place: 'home', unit: 'bw'  },
  { id: 'h7',  cn: '臀桥',       en: 'Glute Bridge',   part: 'legs',      place: 'home', unit: 'bw'  },
  { id: 'h8',  cn: '弓步蹲',     en: 'Split Squat',    part: 'legs',      place: 'home', unit: 'bw'  },
  { id: 'h9',  cn: '平板支撑',   en: 'Plank',          part: 'core',      place: 'home', unit: 'sec' },
  { id: 'h10', cn: '登山跑',     en: 'Mountain Climber', part: 'core',    place: 'home', unit: 'sec' },
  { id: 'h11', cn: '仰卧举腿',   en: 'Leg Raise',      part: 'core',      place: 'home', unit: 'bw'  }
];

const PART_CN = {
  chest: '胸', back: '背', shoulders: '肩', arms: '手臂', legs: '腿', core: '核心'
};

function byId(id) {
  return EXERCISES.filter(function (e) { return e.id === id; })[0] || null;
}

/** 按场所筛选 */
function byPlace(place) {
  return EXERCISES.filter(function (e) { return e.place === place; });
}

module.exports = { EXERCISES, PART_CN, byId, byPlace };
