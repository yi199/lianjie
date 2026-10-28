/** 初始数据：动作字典 + 一周计划 + 一份示例记录（首次启动时写入本地） */

const EXERCISES = [
  { id: 'e1', cn: '高脚杯深蹲', en: 'Goblet Squat', part: 'legs', icon: 'dumbbell' },
  { id: 'e2', cn: '壶铃摆荡', en: 'Kettlebell Swing', part: 'legs', icon: 'kettlebell' },
  { id: 'e3', cn: '箭步蹲', en: 'Lunge', part: 'legs', icon: 'kettlebell' },
  { id: 'e4', cn: '平板支撑', en: 'Plank', part: 'core', icon: 'plank' },
  { id: 'e5', cn: '卧推', en: 'Bench Press', part: 'chest', icon: 'barbell' },
  { id: 'e6', cn: '引体向上', en: 'Pull-up', part: 'back', icon: 'bar' },
  { id: 'e7', cn: '哑铃推举', en: 'Shoulder Press', part: 'shoulders', icon: 'dumbbell' },
  { id: 'e8', cn: '俯身划船', en: 'Barbell Row', part: 'back', icon: 'barbell' }
];

/** 周一=0 ... 周日=6；没有配置的日子就是休息日 */
const PLANS = {
  0: {
    name: '下肢日', en: 'Lower',
    items: [
      { exId: 'e1', sets: 4, reps: 12, weight: 24 },
      { exId: 'e2', sets: 4, reps: 15, weight: 16 },
      { exId: 'e3', sets: 3, reps: 12, weight: 20 },
      { exId: 'e4', sets: 3, reps: 45, weight: 0, unit: 'sec' }
    ]
  },
  2: {
    name: '上肢日', en: 'Upper',
    items: [
      { exId: 'e5', sets: 4, reps: 8, weight: 60 },
      { exId: 'e6', sets: 4, reps: 6, weight: 0, unit: 'bw' },
      { exId: 'e7', sets: 3, reps: 10, weight: 14 },
      { exId: 'e8', sets: 3, reps: 12, weight: 40 }
    ]
  },
  4: {
    name: '全身日', en: 'Full Body',
    items: [
      { exId: 'e1', sets: 4, reps: 10, weight: 24 },
      { exId: 'e5', sets: 4, reps: 8, weight: 55 },
      { exId: 'e6', sets: 3, reps: 6, weight: 0, unit: 'bw' },
      { exId: 'e4', sets: 3, reps: 50, weight: 0, unit: 'sec' }
    ]
  }
};

const PART_CN = {
  legs: '腿', chest: '胸', back: '背', shoulders: '肩', core: '核心'
};

/**
 * 示例记录：让第一次打开「数据」页不是空的。
 * 规则：
 *  1. 只在有计划的日子生成（不会把休息日算成训练）
 *  2. 最近 3 天一定有记录（这样「连续天数」不是 0）
 *  3. 今天不生成，留给用户自己练
 */
function makeDemoSets() {
  const D = require('../utils/date');
  const out = [];
  let seedNum = 7;
  const rnd = function () {
    seedNum = (seedNum * 9301 + 49297) % 233280;
    return seedNum / 233280;
  };

  const today = D.today();
  const dates = [];

  for (let i = 24; i >= 1; i--) {
    const day = D.shift(today, -i);
    const wd = D.weekdayMon(new Date(day + 'T00:00:00'));
    if (!PLANS[wd]) continue;                 // 休息日，跳过
    const force = i <= 3;                     // 最近 3 天必练
    if (!force && rnd() >= 0.72) continue;    // 其余按概率
    dates.push(day);
  }

  dates.forEach(function (day, di) {
    const wd = D.weekdayMon(new Date(day + 'T00:00:00'));
    const plan = PLANS[wd];
    const bump = di > dates.length / 2 ? 1.06 : 1;   // 后半段稍重，让「进步」看得出来

    plan.items.forEach(function (it) {
      const ex = EXERCISES.filter(function (e) { return e.id === it.exId; })[0];
      for (let k = 0; k < it.sets; k++) {
        out.push({
          id: day + '-' + it.exId + '-' + k,
          date: day,
          exId: it.exId,
          exCn: ex.cn,
          part: ex.part,
          setNo: k + 1,
          weight: Math.round(it.weight * bump),
          reps: it.reps,
          unit: it.unit || 'kg',
          done: true
        });
      }
    });
  });

  return out;
}

module.exports = { EXERCISES, PLANS, PART_CN, makeDemoSets };
