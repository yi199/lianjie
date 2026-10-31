/**
 * 同步调度自测：内存版假服务端，**不连真后端、不需要数据库**
 * 跑法：node test-sync.js
 *
 * 假服务端只实现客户端真正用到的那两个接口，语义按 docs/后端接口契约.md：
 *   POST /login  { code }  → { token, expiresAt }
 *   POST /sync   { cursor, sets, workouts, metrics, config }
 *                → { cursor, hasMore, applied, rejected, sets, workouts, metrics, config, serverTime }
 *
 * 同一个 code = 同一个用户，所以「换一台设备」= 清空本地存储 + 用同一个 code 登录。
 */

const mem = {};
global.wx = {
  getStorageSync(k) { return mem[k] === undefined ? '' : mem[k]; },
  setStorageSync(k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync(k) { delete mem[k]; },
  // 测试里所有设备都用同一个 code → 同一个 openid
  login(o) { o.success({ code: 'phone-1' }); }
};

const db = require('./utils/db');
const CFG = require('./utils/config');
const sync = require('./utils/sync');

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}

const T = '2026-10-31';

function set(date, exId, no, weight) {
  return db.saveSet({ date: date, exId: exId, setNo: no, weight: weight, reps: 10, unit: 'kg' });
}

/** 清空本机，模拟「换了一台设备」 */
function anotherDevice() {
  db.resetAll();
  delete mem['lj.auth'];
  delete mem['lj.sync.cursor'];
  delete mem['lj.sync.dirty'];
}

/* ---------------- 内存版假服务端 ---------------- */

function makeServer() {
  const users = {};   // openid → { rev, rows, workouts, config }
  const calls = [];

  function stateOf(openid) {
    if (!users[openid]) users[openid] = { rev: 0, rows: {}, workouts: {}, config: null };
    return users[openid];
  }

  function userOf(authHeader) {
    const token = String(authHeader || '').replace(/^Bearer\s+/, '').replace(/^tok-/, '');
    return users[token] || null;
  }

  const server = {
    calls: calls,
    failNext: 0,          // 接下来 N 个请求返回 500
    unauthorizedNext: 0,  // 接下来 N 个 /sync 返回 401
    rejectNext: null,     // 下一次 /sync 把指定下标的行拒绝掉

    transport(opt) {
      calls.push(opt);
      const path = opt.url.replace(/^https?:\/\/[^/]+/, '');

      if (server.failNext > 0) {
        server.failNext--;
        return Promise.resolve({ statusCode: 500, data: { error: { code: 'DB_ERROR' } }, header: {} });
      }

      if (path === '/login') {
        const openid = 'u-' + ((opt.data && opt.data.code) || '');
        stateOf(openid);
        return Promise.resolve({
          statusCode: 200,
          data: { token: 'tok-' + openid, expiresAt: '2099-01-01T00:00:00.000Z' },
          header: {}
        });
      }

      if (path === '/sync') {
        if (server.unauthorizedNext > 0) {
          server.unauthorizedNext--;
          return Promise.resolve({ statusCode: 401, data: { error: { code: 'AUTH_EXPIRED' } }, header: {} });
        }
        const st = userOf(opt.header && opt.header.Authorization);
        if (!st) {
          return Promise.resolve({ statusCode: 401, data: { error: { code: 'AUTH_EXPIRED' } }, header: {} });
        }

        const body = opt.data || {};
        const rejected = [];

        (body.sets || []).forEach(function (r, i) {
          if (server.rejectNext && server.rejectNext.kind === 'set' && server.rejectNext.index === i) {
            rejected.push({ kind: 'set', index: i, reason: server.rejectNext.reason || 'bad' });
            return;
          }
          st.rev++;
          st.rows[r.date + '|' + r.exId + '|' + r.setNo] = Object.assign({}, r, { rev: st.rev });
        });
        server.rejectNext = null;

        (body.workouts || []).forEach(function (w) {
          st.rev++;
          st.workouts[w.date] = Object.assign({}, w, { rev: st.rev });
        });
        if (body.config) {
          st.rev++;
          st.config = Object.assign({}, body.config, { rev: st.rev });
        }

        const cursor = Number(body.cursor) || 0;
        const all = [];
        Object.keys(st.rows).forEach(function (k) {
          if (st.rows[k].rev > cursor) all.push({ t: 's', v: st.rows[k] });
        });
        Object.keys(st.workouts).forEach(function (k) {
          if (st.workouts[k].rev > cursor) all.push({ t: 'w', v: st.workouts[k] });
        });
        if (st.config && st.config.rev > cursor) all.push({ t: 'c', v: st.config });
        all.sort(function (a, b) { return a.v.rev - b.v.rev; });

        const page = all.slice(0, 1000);
        const out = {
          cursor: page.length ? page[page.length - 1].v.rev : st.rev,
          hasMore: all.length > page.length,
          applied: 0,
          rejected: rejected,
          sets: [], workouts: [], metrics: [], config: null,
          serverTime: new Date().toISOString()
        };
        page.forEach(function (x) {
          if (x.t === 's') out.sets.push(x.v);
          else if (x.t === 'w') out.workouts.push(x.v);
          else out.config = x.v;
        });
        return Promise.resolve({ statusCode: 200, data: out, header: {} });
      }

      return Promise.resolve({ statusCode: 404, data: {}, header: {} });
    }
  };

  return server;
}

/* ---------------- 用例 ---------------- */

async function main() {
  const srv = makeServer();
  sync.setTransport(srv.transport);
  CFG.setApiBase('http://fake');

  /* ---- 1. 登录 + 推送 ---- */
  console.log('\n=== 登录与推送 ===');
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  set(T, 'g1', 1, 50);

  sync.stop();
  let r = await sync.kick();

  ok('第一次同步会先登录', srv.calls.some(function (c) { return c.url.indexOf('/login') >= 0; }));
  ok('然后带 token 打 /sync',
    srv.calls.some(function (c) {
      return c.url.indexOf('/sync') >= 0 && /^Bearer tok-/.test((c.header || {}).Authorization || '');
    }));
  ok('同步没有报错', !r.error, JSON.stringify(r));
  ok('队列已清空', db.syncPending() === 0, 'pending=' + db.syncPending());
  ok('token 已保存到 lj.auth', !!(mem['lj.auth'] && mem['lj.auth'].token));
  ok('游标前进', sync.status().cursor > 0, 'cursor=' + sync.status().cursor);

  /* ---- 2. 换一台设备：把数据拉回来 ---- */
  console.log('\n=== 换设备拉回 ===');
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  ok('新设备本地没有记录', db.allSets().length === 0);

  r = await sync.kick();
  ok('拉回了另一台设备记的组',
    db.allSets().some(function (s) { return s.exId === 'g1' && s.weight === 50; }),
    'sets=' + db.allSets().length);
  ok('拉取后队列也是空的', db.syncPending() === 0);

  /* ---- 3. token 失效：自动重登并重试 ---- */
  console.log('\n=== 401 自动重登 ===');
  const loginsBefore = srv.calls.filter(function (c) { return c.url.indexOf('/login') >= 0; }).length;
  set(T, 'g2', 1, 40);
  srv.unauthorizedNext = 1;
  r = await sync.kick();

  const loginsAfter = srv.calls.filter(function (c) { return c.url.indexOf('/login') >= 0; }).length;
  ok('401 后重新登录了一次', loginsAfter === loginsBefore + 1, loginsBefore + ' → ' + loginsAfter);
  ok('重登后重试成功、队列清空', !r.error && db.syncPending() === 0, JSON.stringify(r));

  /* ---- 4. 后端 500：不抛异常、不丢数据 ---- */
  console.log('\n=== 后端故障 ===');
  set(T, 'g3', 1, 30);
  const pendingBefore = db.syncPending();
  srv.failNext = 1;
  r = await sync.kick();
  sync.stop();     // 清掉退避定时器，避免影响后面的用例

  ok('后端 500 时不抛异常', !!(r && r.error), JSON.stringify(r));
  ok('lastError 有值', sync.status().lastError !== '', sync.status().lastError);
  ok('失败后队列不丢', db.syncPending() === pendingBefore && pendingBefore > 0,
    'pending=' + db.syncPending() + '/' + pendingBefore);

  /* ---- 5. 坏行被拒：要出队，否则队列永远卡住 ---- */
  console.log('\n=== 坏行处理 ===');
  srv.rejectNext = { kind: 'set', index: 0, reason: 'date 非法' };
  r = await sync.kick();
  ok('被拒的行出队，队列不卡住', db.syncPending() === 0, 'pending=' + db.syncPending());

  /* ---- 6. 网络断开：队列保留；恢复后补传 ---- */
  console.log('\n=== 断网与恢复 ===');
  set(T, 'g5', 1, 20);
  const offlinePending = db.syncPending();
  sync.setTransport(function () {
    return Promise.reject(new Error('网络错误: offline'));
  });
  r = await sync.kick();
  sync.stop();
  ok('断网时不抛异常', !!(r && r.error), JSON.stringify(r));
  ok('断网时队列保留', db.syncPending() === offlinePending && offlinePending > 0,
    'pending=' + db.syncPending() + '/' + offlinePending);

  sync.setTransport(srv.transport);
  r = await sync.kick();
  ok('恢复网络后补传成功', !r.error && db.syncPending() === 0, JSON.stringify(r));

  /* ---- 7. 未配置地址：什么都不做 ---- */
  console.log('\n=== 未配置后端 ===');
  CFG.setApiBase(null);
  const callsBefore = srv.calls.length;
  r = await sync.kick();
  ok('没配地址时不发任何请求', srv.calls.length === callsBefore && r && r.skipped === 'off',
    JSON.stringify(r));

  /* ---- 8. 环境地址选择（config.js） ---- */
  console.log('\n=== 环境地址 ===');
  function env(v) {
    return function () { return { miniProgram: { envVersion: v } }; };
  }

  // 端口是每台机器的事（Docker Desktop 常占 8080），这里只钉住「本机 + 带 /api」
  const LOCAL_API = /^http:\/\/127\.0\.0\.1:\d+\/api$/;

  global.wx.getAccountInfoSync = env('develop');
  CFG.setApiBase(null);
  ok('develop 用本机地址，且带 /api', LOCAL_API.test(CFG.apiBase()), CFG.apiBase());
  ok('develop 时同步默认打开', CFG.syncEnabled() === true);

  global.wx.getAccountInfoSync = env('trial');
  CFG.setApiBase(null);
  ok('trial 还没域名 → 纯本地', CFG.apiBase() === '' && CFG.syncEnabled() === false);

  global.wx.getAccountInfoSync = env('release');
  CFG.setApiBase(null);
  ok('release 留空 → 纯本地', CFG.apiBase() === '' && CFG.syncEnabled() === false);

  // 换完环境不能拿到旧缓存
  global.wx.getAccountInfoSync = env('develop');
  CFG.setApiBase(null);
  ok('setApiBase 换环境后不拿旧缓存', LOCAL_API.test(CFG.apiBase()), CFG.apiBase());

  /* ---- 9. 开发版固定身份 ---- */
  console.log('\n=== 开发版固定身份 ===');
  // wx.login 每次给的 code 都不同，DEV_MODE 下每次登录都会变成新用户 ——
  // 清缓存 / 换设备就拿不回数据，多设备同步没法验证。
  global.wx.getAccountInfoSync = env('develop');
  ok('develop 有固定登录 code', CFG.devCode() === 'local-1', CFG.devCode());

  global.wx.getAccountInfoSync = env('release');
  ok('release 不用固定 code（走真实 wx.login）', CFG.devCode() === '', CFG.devCode());

  // 确认登录请求里真的带的是固定 code
  global.wx.getAccountInfoSync = env('develop');
  CFG.setApiBase('http://fake');
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  set(T, 'g9', 1, 30);

  const beforeDev = srv.calls.length;
  r = await sync.kick();
  const loginCall = srv.calls.slice(beforeDev).filter(function (c) {
    return c.url.indexOf('/login') >= 0;
  })[0];
  ok('登录请求用的是固定 code',
    !!loginCall && loginCall.data.code === 'local-1',
    loginCall ? loginCall.data.code : '(没有登录请求)');
  ok('固定身份下同步成功', !r.error && db.syncPending() === 0, JSON.stringify(r));

  /* ---- 10. 清空本机时同步身份要一起清 ---- */
  console.log('\n=== 清空本机 ===');
  // 只清数据不清游标的话，客户端会以为自己已拿到服务端最新状态，
  // 重新登录后一条都不会重新拉 —— 表现就是「重新引导之后数据全没了」。
  wx.setStorageSync('lj.sync.cursor', 999);
  wx.setStorageSync('lj.auth', { token: 'tok-stale', expiresAt: '' });
  db.resetAll();
  ok('resetAll 清掉游标', wx.getStorageSync('lj.sync.cursor') === '',
    String(wx.getStorageSync('lj.sync.cursor')));
  ok('resetAll 清掉 token', wx.getStorageSync('lj.auth') === '',
    String(wx.getStorageSync('lj.auth')));

  // 清完再引导一次 → 应该重新登录并从 0 开始拉
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  const beforeReset = srv.calls.length;
  r = await sync.kick();
  const relogin = srv.calls.slice(beforeReset).filter(function (c) {
    return c.url.indexOf('/login') >= 0;
  })[0];
  ok('清空后重新登录（不是复用旧 token）', !!relogin);
  ok('清空后从 0 开始拉，拿到旧数据', !r.error && db.allSets().length > 0,
    'sets=' + db.allSets().length);

  /* ---- 11. 换设备：引导态从服务端恢复（C5-a） ---- */
  console.log('\n=== 引导态从服务端恢复 ===');

  // 没配地址时立即返回，不挡启动
  global.wx.getAccountInfoSync = env('release');   // 别让上一段留下的 develop 环境顶上来
  CFG.setApiBase(null);
  const off = await sync.ready();
  ok('没配地址时 ready() 立即返回', !!off && off.skipped === 'off', JSON.stringify(off));

  CFG.setApiBase('http://fake');

  // 模拟换设备：清空本地（连 onboarded 一起没了），但服务端有配置
  anotherDevice();
  ok('清空后本地没有引导态', db.hasOnboarded() === false);

  const readyRes = await sync.ready();
  ok('ready() 不报错', !readyRes.error, JSON.stringify(readyRes));
  ok('ready() 之后引导态从服务端恢复（不用重填引导）', db.hasOnboarded() === true);
  ok('训练日队列也跟着重推了', db.plans().length > 0, 'plans=' + db.plans().length);

  // 未引导时也要真的发请求（以前会返回 skipped:'onboard' 什么都不做）
  anotherDevice();
  const unonboarded = await sync.kick();
  ok('未引导时也会同步（不再是 skipped:onboard）',
    !(unonboarded && unonboarded.skipped === 'onboard'), JSON.stringify(unonboarded));

  /* ---- 12. 竞态：init 已在跑时，ready() 必须等那一次 ---- */
  console.log('\n=== ready() 与已在跑的同步 ===');
  // 场景：App.onLaunch 已经调了 init() 开始同步；页面紧接着调 ready()。
  // 如果 run() 在「已在跑」时返回合成的 skipped，ready() 会立刻 resolve，
  // 调用方以为同步完了 —— 表现就是「清缓存后还是看到引导页」。
  anotherDevice();
  ok('竞态前本地没有引导态', db.hasOnboarded() === false);

  const kicked = sync.kick();        // 模拟 init() 已经启动一次
  const readied = sync.ready();      // 紧接着 ready()
  const both = await Promise.all([kicked, readied]);

  ok('ready() 与 kick() 都拿到结果', !!both[0] && !!both[1], JSON.stringify(both[1]));
  ok('ready() 等到了真正那次同步：引导态已恢复', db.hasOnboarded() === true,
    'hasOnboarded=' + db.hasOnboarded());
  ok('数据也落地了', db.allSets().length > 0, 'sets=' + db.allSets().length);

  sync.stop();
}

main().then(function () {
  console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '同步调度测试全部通过') + '\n');
  if (failed) process.exitCode = 1;
}).catch(function (e) {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
