/** 训练量计算：全产品只有这一处定义，别的地方调用它 */

/** 一组容量 = 重量 × 次数（只对负重有意义） */
function setVolume(set) {
  return (Number(set.weight) || 0) * (Number(set.reps) || 0);
}

/** 一组记录的总容量（kg），自重 / 计时动作为 0 —— 别用它当「今天练了多少」的唯一口径 */
function totalVolume(sets) {
  return sets.reduce(function (sum, s) { return sum + setVolume(s); }, 0);
}

/** kg → 吨，保留一位小数 */
function toTon(kg) {
  return Math.round(kg / 100) / 10;
}

/**
 * 按 unit 分开统计一组记录，返回三套口径 + 该用哪套展示。
 *
 * kg 动作记容量；bw 动作记次数（自重，填了负重则按容量算）；
 * sec 动作记秒数。unit 选「kg 有量就 kg，其次次数，再次秒数」，
 * 让战报 / 地形页在纯自重、纯计时的一天也能有个说得出口的数字。
 *
 * @returns {{kg:number, ton:number, reps:number, seconds:number, unit:'kg'|'bw'|'sec'}}
 */
function tally(sets) {
  const list = sets || [];
  let reps = 0;
  let seconds = 0;
  let loaded = 0;   // 记了重量的 bg 组，算容量而不是次数

  list.forEach(function (s) {
    const unit = s.unit || 'kg';
    const n = Number(s.reps) || 0;
    const w = Number(s.weight) || 0;

    if (unit === 'sec') {
      seconds += n;
    } else if (unit === 'bw') {
      // 自重只记次数；负重引体这类填了重量才按容量算
      if (w > 0) loaded += w * n;
      else reps += n;
    } else {
      // 负重动作没填重量（只打勾）→ 退回按次数计，别让战报显示 0 吨
      if (w > 0) loaded += w * n;
      else reps += n;
    }
  });

  const kg = loaded;
  let unit = 'kg';
  if (!(kg > 0)) unit = reps > 0 ? 'bw' : (seconds > 0 ? 'sec' : 'kg');

  return { kg: kg, ton: toTon(kg), reps: reps, seconds: seconds, unit: unit };
}

/** 分钟 → '45 分钟' */
function durationText(min) {
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
}

module.exports = { setVolume, totalVolume, toTon, tally, durationText };
