/** 训练量计算：全产品只有这一处定义，别的地方调用它 */

/** 一组容量 = 重量 × 次数 */
function setVolume(set) {
  return (Number(set.weight) || 0) * (Number(set.reps) || 0);
}

/** 一组记录的总容量（kg） */
function totalVolume(sets) {
  return sets.reduce(function (sum, s) { return sum + setVolume(s); }, 0);
}

/** kg → 吨，保留一位小数 */
function toTon(kg) {
  return Math.round(kg / 100) / 10;
}

/** 分钟 → '45 分钟' */
function durationText(min) {
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
}

module.exports = { setVolume, totalVolume, toTon, durationText };
