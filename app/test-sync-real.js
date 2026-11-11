/**
 * 真后端同步测试：**连真的 Go 后端 + 真的 Postgres**
 *
 * 跑法：
 *   bash _cache/run_api.sh                       # 先把后端起来
 *   cd app && API=http://127.0.0.1:18081/api node test-sync-real.js
 *
 * 和 test-sync.js 的分工：
 *   test-sync.js       内存假服务端，跑语义（快、随时能跑、不需要后端）
 *   test-sync-real.js  真服务端，跑「契约真的对得上」和 C6 那几项：
 *                      换设备拉回 / 时钟偏差不丢不覆盖 / 分页拉全 / 断网补传
 *
 * 每次跑用一个新用户（openid 带时间戳），可以反复跑不互相污染。
 */

const mem = {};
const CODE = 'real-' + Date.now();

global.wx = {
  getStorageSync(k) { return mem[k] === undefined ? '' : mem[k]; },
  setStorageSync(k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync(k) { delete mem[k]; },
  login(o) { o.success({ code: CODE }); }
};

const db = require('./utils/db');
const S = require('./utils/storage');
const CFG = require('./utils/config');
const sync = require('./utils/sync');

const API = process.env.API || 'http://127.0.0.1:18081/api';
CFG.setApiBase(API);

/* ---------------- 真 HTTP transport ---------------- */

function httpTransport(opt) {
  const url = new URL(opt.url);
  const lib = url.protocol === 'https:' ? require('https') : require('http');
  return new Promise(function (resolve, reject) {
    const body = opt.data === undefined || opt.data === null ? null : JSON.stringify(opt.data);
    const header = Object.assign({ 'Content-Type': 'application/json' }, opt.header || {});
    if (body) header['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: opt.method || 'POST',
      headers: header
    }, function (res) {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        let data = {};
        try { data = buf ? JSON.parse(buf) : {}; } catch (e) { data = { raw: buf }; }
        resolve({ statusCode: res.statusCode, data: data, header: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

sync.setTransport(httpTransport);

/* ---------------- 小工具 ---------------- */

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}

/** 换一台设备：清空本地 + 清掉登录态和游标 */
function anotherDevice() {
  db.resetAll();
  S.reset();
  delete mem['lj.auth'];
  delete mem['lj.sync.cursor'];
  delete mem['lj.sync.dirty'];
}

function setsOn(date) {
  return db.allSets().filter(function (s) { return s.date === date; });
}

/* ---------------- 用例 ---------------- */

async function main() {
  console.log('后端：' + API);
  console.log('用户：' + CODE);

  /* ---- 1. 第一次同步：登录 + 推 ---- */
  console.log('\n=== 1. 登录与推送（真库）===');
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  for (let i = 1; i <= 3; i++) {
    db.saveSet({ date: '2026-11-03', exId: 'g1', setNo: i, weight: 60, reps: 8, unit: 'kg' });
  }
  sync.stop();
  let r = await sync.kick();
  ok('同步无报错', !r || !r.error, JSON.stringify(r && r.error));
  ok('待上传队列清空', db.syncPending() === 0, db.syncPending());

  /* ---- 2. 换设备拉回 ---- */
  console.log('\n=== 2. 换设备（清空本地后从服务端拉回）===');
  anotherDevice();
  ok('本地已清空', db.allSets().length === 0, db.allSets().length);
  r = await sync.kick();
  ok('拉回 3 组', setsOn('2026-11-03').length === 3, setsOn('2026-11-03').length);
  const back = setsOn('2026-11-03')[0];
  ok('内容和推上去的一致（60kg × 8）', back && back.weight === 60 && back.reps === 8,
    back && back.weight + 'kg × ' + back.reps);
  ok('训练日也回来了', db.hasOnboarded(), db.profile() && db.profile().level);

  /* ---- 2.5 身体指标也要能同步 ---- */
  console.log('\n=== 2.5 身体指标（P5）跨设备 ===');
  db.saveMetric({ kind: 'weight', date: '2026-11-03', value: 74.6 });
  r = await sync.kick();
  ok('指标上传无报错', !r || !r.error, JSON.stringify(r && r.error));
  ok('指标上传后队列清空', db.syncPending() === 0, db.syncPending());

  anotherDevice();
  r = await sync.kick();
  const m = db.metricOf('weight', '2026-11-03');
  ok('换设备能拉回体重', m && m.value === 74.6, m && m.value);

  /* ---- 3. 时钟偏差：慢时钟设备写旧值，不能覆盖 ---- */
  console.log('\n=== 3. 时钟偏差（旧 updatedAt 不能覆盖新值）===');
  const id = '2026-11-03-g1-1';
  // 直接把一条「昨天写的」记录塞进本地并标脏，模拟时钟慢一天的设备
  S.putMany([{
    date: '2026-11-03', exId: 'g1', setNo: 1, exCn: '杠铃卧推', part: 'chest',
    planKey: 'A', weight: 999, reps: 1, unit: 'kg', done: true,
    updatedAt: '2026-11-02T01:00:00.000Z'
  }]);
  S.markAllDirty();
  r = await sync.kick();
  ok('上传没报错', !r || !r.error, JSON.stringify(r && r.error));
  ok('服务端没被旧值覆盖（仍 60kg）', S.get(id) && S.get(id).weight === 60,
    S.get(id) && S.get(id).weight);
  ok('队列没卡住', db.syncPending() === 0, db.syncPending());

  /* ---- 4. 分页：一次推 1200 行，新设备要能拉全 ---- */
  console.log('\n=== 4. 分页（推 1200 行，新设备拉全）===');
  anotherDevice();
  const bulk = [];
  for (let d = 1; d <= 30; d++) {
    const day = '2026-10-' + String(d).padStart(2, '0');
    for (let e = 1; e <= 10; e++) {
      for (let s = 1; s <= 4; s++) {
        bulk.push({
          date: day, exId: 'g' + e, setNo: s, exCn: '动作' + e, part: 'chest',
          planKey: 'A', weight: 20 + e, reps: 10, unit: 'kg', done: true,
          updatedAt: '2026-10-' + String(d).padStart(2, '0') + 'T10:00:00.000Z'
        });
      }
    }
  }
  S.putMany(bulk);
  S.markAllDirty();
  r = await sync.kick();
  ok('1200 行全部上传完（分批）', db.syncPending() === 0, '剩 ' + db.syncPending());
  const totalAfterPush = db.allSets().length;
  ok('本地至少有这 1200 行', totalAfterPush >= 1200, totalAfterPush);

  anotherDevice();
  await sync.kick();
  // 服务端此时还有前面几步留下的 3 组，所以对的是「新设备拉到的 == 上传设备手里的」
  ok('新设备分页拉全（一行不漏）', db.allSets().length === totalAfterPush,
    db.allSets().length + ' / ' + totalAfterPush);

  /* ---- 5. 断网：队列保留，恢复后补传 ---- */
  console.log('\n=== 5. 断网与恢复 ===');
  db.saveSet({ date: '2026-11-04', exId: 'g2', setNo: 1, weight: 40, reps: 10, unit: 'kg' });
  const pendingBefore = db.syncPending();
  sync.setTransport(function () { return Promise.reject(new Error('offline')); });
  r = await sync.kick();
  ok('断网时不抛异常', !!(r && r.error), JSON.stringify(r && r.error));
  ok('断网时队列保留', db.syncPending() === pendingBefore && pendingBefore > 0,
    db.syncPending() + '/' + pendingBefore);

  sync.setTransport(httpTransport);
  r = await sync.kick();
  ok('恢复后补传成功', !r || !r.error, JSON.stringify(r && r.error));
  ok('队列清空', db.syncPending() === 0, db.syncPending());

  /* ---- 6. 另一个用户看不到 ---- */
  console.log('\n=== 6. 用户隔离 ===');
  const other = await httpTransport({
    url: API + '/login', method: 'POST', data: { code: 'other-' + Date.now() },
    header: { 'Content-Type': 'application/json' }
  });
  const token = (other.data || {}).token;
  const pull = await httpTransport({
    url: API + '/sync', method: 'POST',
    data: { cursor: 0, sets: [], workouts: [], metrics: [], config: null },
    header: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  });
  const rows = (pull.data && pull.data.sets) || [];
  ok('别的用户拉不到我的数据', rows.length === 0, rows.length);

  /* ---- 7. 纯本地 → 开云端：本机历史自动全量上云（可扩展性） ---- */
  console.log('\n=== 7. 纯本地转云端（历史不能丢）===');
  anotherDevice();
  delete mem['lj.sync.backfilled'];          // 模拟「这个版本之前一直在纯本地用」
  CFG.setApiBase(null);                      // config.js 的 release 留空 = 纯本地
  const LB = '2026-09-15';
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  for (let i = 1; i <= 3; i++) {
    db.saveSet({ date: LB, exId: 'g2', setNo: i, weight: 30, reps: 12, unit: 'kg' });
  }
  ok('纯本地时行不进上传队列（所以必须有 backfill）', db.syncPending() === 0, db.syncPending());

  // 现在等于「发布时给 config.js 的 release 填上域名」
  CFG.setApiBase(API);
  const pushSizes = [];
  sync.setTransport(function (opt) {
    if (opt.url.indexOf('/sync') >= 0) pushSizes.push(((opt.data || {}).sets || []).length);
    return httpTransport(opt);
  });
  sync.stop();
  r = await sync.kick();
  ok('同步没报错', !r || !r.error, JSON.stringify(r && r.error));
  ok('队列清空（历史都推上去了）', db.syncPending() === 0, db.syncPending());
  ok('第一批就把 3 组推出去了', pushSizes.indexOf(3) >= 0, JSON.stringify(pushSizes));
  ok('backfill 标记已写', !!mem['lj.sync.backfilled'], String(mem['lj.sync.backfilled']).slice(0, 10));

  // 换设备：云端真的有，才拉得回来
  const beforeSwitch = db.allSets().length;
  anotherDevice();
  await sync.kick();
  ok('换设备拉回纯本地时期记的 3 组', setsOn(LB).length === 3, setsOn(LB).length);
  ok('组数对得上（不多不少）', db.allSets().length === beforeSwitch,
    db.allSets().length + ' / ' + beforeSwitch);

  // 只做一次：再同步不许把历史重推一遍
  pushSizes.length = 0;
  db.saveSet({ date: LB, exId: 'g2', setNo: 4, weight: 30, reps: 12, unit: 'kg' });
  await sync.kick();
  ok('之后只推新改的那 1 行', pushSizes.length > 0 && pushSizes.every(function (n) { return n <= 1; }),
    JSON.stringify(pushSizes));
  sync.setTransport(httpTransport);

  sync.stop();

  console.log(failed === 0 ? '\n全部通过' : '\n有 ' + failed + ' 项失败');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('\n跑挂了：' + (e && e.stack || e));
  process.exit(1);
});
