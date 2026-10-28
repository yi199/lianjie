/** 日期工具：全部返回本地时区的「自然日」概念 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** '2026-10-28' */
function dateStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

/** 今天 */
function today() {
  return dateStr(new Date());
}

/** 本月：{ y, m }，m 从 1 开始 */
function thisMonth() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

/** 某月天数 */
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

/** 某月 1 号是周几，周一=0 ... 周日=6 */
function firstWeekdayMon(y, m) {
  const w = new Date(y, m - 1, 1).getDay(); // 0=周日
  return (w + 6) % 7;
}

/** 今天周几，周一=0 */
function weekdayMon(d) {
  const x = d || new Date();
  return (x.getDay() + 6) % 7;
}

/** '周三' */
function weekdayCN(d) {
  return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekdayMon(d)];
}

/** '10 月 28 日' */
function prettyDate(d) {
  const x = d || new Date();
  return (x.getMonth() + 1) + ' 月 ' + x.getDate() + ' 日';
}

/** 两个日期相差天数（a - b） */
function diffDays(a, b) {
  const pa = new Date(a + 'T00:00:00');
  const pb = new Date(b + 'T00:00:00');
  return Math.round((pa - pb) / 86400000);
}

/** 往前推 n 天 */
function shift(dateS, n) {
  const d = new Date(dateS + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

module.exports = {
  pad, dateStr, today, thisMonth, daysInMonth,
  firstWeekdayMon, weekdayMon, weekdayCN, prettyDate, diffDays, shift
};
