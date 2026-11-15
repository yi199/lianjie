/**
 * 战报分享快照自测：node test-share-snapshot.js
 * 不依赖 wx 环境（模块本身是纯函数）。
 */

const S = require('./utils/share-snapshot');

let fails = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) { fails++; process.exitCode = 1; }
}
function eq(label, a, b) { ok(label, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' vs ' + JSON.stringify(b)); }

/* 模拟 db.todayReport() 的返回形状（页面实际用到的字段） */
function sampleR(over) {
  return Object.assign({
    date: '2026-11-13',
    planName: '推日',
    sets: 18,
    plannedSets: 20,
    exercises: 5,
    unit: 'kg',
    ton: 4.25,
    reps: 0,
    seconds: 0,
    parts: [
      { key: 'chest', name: '胸', pct: 44 },
      { key: 'shoulders', name: '肩', pct: 33 },
      { key: 'triceps', name: '手臂', pct: 23 }
    ],
    prs: [
      { exId: 'bench-press', cn: '平板卧推', weight: 80, prev: 77.5, delta: 2.5 }
    ]
  }, over || {});
}
const sampleTexts = {
  dateText: '周五 · 2026.11.13',
  head: '今天练完了。',
  comment: '计划 20 组，完成 18 组。留点力气给下次也好。',
  dayWord: '今天'
};

console.log('\n=== 1. 基本往返 ===');
const r = sampleR();
const token = S.encode(r, sampleTexts);
ok('encode 返回非空字符串', typeof token === 'string' && token.length > 0, token.length + ' chars');
ok('token 只含 base64url 字符（URL 安全，无需转义也不炸 query）', /^[A-Za-z0-9_-]+$/.test(token));
ok('token 在长度上限内', token.length <= S.MAX_TOKEN);

const back = S.decode(token);
ok('decode 非空', !!back);
eq('planName 往返', back.r.planName, '推日');
eq('组数/动作数往返', [back.r.sets, back.r.exercises, back.r.plannedSets], [18, 5, 20]);
eq('吨数往返（保留两位小数）', back.r.ton, 4.25);
eq('unit 往返', back.r.unit, 'kg');
eq('部位往返', back.r.parts, r.parts.map(function (p) { return { name: p.name, pct: p.pct }; }));
eq('PR 往返（补 exId 供 wx:key）', back.r.prs, [{ exId: 's0', cn: '平板卧推', weight: 80, delta: 2.5 }]);
eq('文案往返', [back.dateText, back.head, back.comment, back.dayWord],
  [sampleTexts.dateText, sampleTexts.head, sampleTexts.comment, '今天']);
eq('date 往返', back.date, '2026-11-13');

console.log('\n=== 2. 三种 unit 口径 ===');
['kg', 'bw', 'sec'].forEach(function (u) {
  const over = { unit: u };
  if (u === 'bw') over.reps = 120;
  if (u === 'sec') over.seconds = 360;
  const t2 = S.encode(sampleR(over), sampleTexts);
  const b2 = S.decode(t2);
  ok(u + ' 口径 unit 正确', b2.r.unit === u);
  if (u === 'bw') ok('自重次数往返', b2.r.reps === 120);
  if (u === 'sec') ok('计时秒数往返', b2.r.seconds === 360);
});

console.log('\n=== 3. 中文 / 个别符号 UTF-8 往返 ===');
const cnR = sampleR({ planName: '腿日（深蹲主项）', prs: [{ exId: 'x', cn: '杠铃深蹲', weight: 100, delta: 5 }] });
const cnBack = S.decode(S.encode(cnR, { dateText: '周日 · 2026.11.01', head: '那天练完了。', comment: '冲了一把 PR！#1 & a=b?c', dayWord: '那天' }));
ok('中文计划名往返', cnBack.r.planName === '腿日（深蹲主项）', cnBack.r.planName);
ok('中文 PR 名往返', cnBack.r.prs[0].cn === '杠铃深蹲');
ok('个别符号文案往返', cnBack.comment.indexOf('a=b?c') >= 0, cnBack.comment);
// encodeURIComponent 之后的真实链接长度（模拟 onShareAppMessage 拼 path）
const urlLen = ('/pages/report/index?snap=' + encodeURIComponent(token)).length;
ok('真实分享 path 长度合理（< 1024）', urlLen < 1024, urlLen + ' chars');

console.log('\n=== 4. 坏数据一律回退 null（绝不白屏） ===');
ok('null', S.decode(null) === null);
ok('空串', S.decode('') === null);
ok('坏串 base64', S.decode('!!!@@@###') === null);
ok('合法 base64 但内容不是 JSON', S.decode(S.encode ? b64('not-json') : '') === null);
ok('JSON 但版本不对', S.decode(b64(JSON.stringify({ v: 99 }))) === null);
ok('JSON 但缺字段', S.decode(b64(JSON.stringify({ v: S.VER }))) !== null && S.decode(b64(JSON.stringify({ v: S.VER }))).r.sets === 0);
ok('超长 token 直接拒', S.decode(new Array(S.MAX_TOKEN * 3).join('A')) === null);
function b64(s) {
  // 测试里用模块同款编码不方便导出，直接用 Buffer 的 base64url
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

console.log('\n=== 5. 字段校验：好友端不信任卡片内容 ===');
const evil = S.decode(b64(JSON.stringify({
  v: S.VER, d: '2026-11-13', p: 'x', s: 99999, u: 'hack',
  t: -50, rp: 'abc', pt: [{ name: 'verylongname!!', pct: 888 }],
  pr: [{ cn: '卧推<script>', weight: 999999 }],
  dt: 'd', h: 'h', c: 'c', dw: '今天'
})));
ok('非法 unit 回退 kg', evil.r.unit === 'kg');
ok('组数 clamp 到 999', evil.r.sets === 999);
ok('负数吨数回退 0', evil.r.ton === 0);
ok('非数字次数回退 0', evil.r.reps === 0);
ok('部位 pct clamp 到 100、名字截断', evil.r.parts[0].pct === 100 && evil.r.parts[0].name.length <= 8);
ok('PR 重量 clamp 到 1000', evil.r.prs[0].weight === 1000);
ok('PR 名字截断到 12 字', evil.r.prs[0].cn.length <= 12);

console.log('\n=== 6. 超长裁剪：再多数据也能发出 ===');
const big = sampleR({
  planName: new Array(20).join('超长计划名'),
  parts: Array.from({ length: 10 }, function (_, i) { return { key: 'k' + i, name: '部位' + i, pct: 10 }; }),
  prs: Array.from({ length: 9 }, function (_, i) { return { exId: 'e' + i, cn: '动作' + i, weight: 50 + i, delta: 1 }; })
});
const bigTexts = Object.assign({}, sampleTexts, { comment: new Array(30).join('重复的评语。') });
const bigToken = S.encode(big, bigTexts);
ok('极端数据仍有 token', bigToken.length > 0 && bigToken.length <= S.MAX_TOKEN, bigToken.length + ' chars');
const bigBack = S.decode(bigToken);
ok('裁剪后仍能解出', !!bigBack);
ok('部位最多 6 个', bigBack.r.parts.length <= 6);
ok('PR 最多 5 个', bigBack.r.prs.length <= 5);
ok('核心数字永远不被裁掉', bigBack.r.sets === 18 && bigBack.r.exercises === 5);

console.log('\n=== 7. 空训练日也能分享 ===');
const empty = sampleR({ sets: 0, parts: [], prs: [], ton: 0, exercises: 0, planName: '自由训练' });
const emptyBack = S.decode(S.encode(empty, { dateText: '周五 · 2026.11.13', head: '今天还没开练。', comment: '今天还没有记录。', dayWord: '今天' }));
ok('空战报可往返', emptyBack.r.sets === 0 && emptyBack.r.parts.length === 0 && emptyBack.r.prs.length === 0);

console.log(fails ? '\n❌ ' + fails + ' 项失败\n' : '\n✅ 全部通过\n');
