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
  const users = {};   // openid → { rev, rows, workouts, exercises, catalog, catalogRev, config }
  const calls = [];
  // 官方动作清单是全局内容（不按用户分），测试里手动 setCatalog 推进版本
  const catalog = { rev: 0, exercises: [] };

  function stateOf(openid) {
    if (!users[openid]) {
      users[openid] = {
        rev: 0, rows: {}, workouts: {}, config: null,
        exercises: {},            // 自建动作：exId → row
        catalog: null,            // 官方清单（整份）
        catalogRev: 0
      };
    }
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

    /** 测试用：换一份官方清单并推进版本 */
    setCatalog(rev, list) {
      catalog.rev = rev;
      catalog.exercises = list || [];
    },

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

      // 删除账号：真服务端是一条 delete + on delete cascade，这里直接把人整个删掉
      if (path === '/account') {
        if ((opt.method || 'GET') !== 'DELETE') {
          return Promise.resolve({ statusCode: 405, data: {}, header: {} });
        }
        const auth = String((opt.header && opt.header.Authorization) || '').replace(/^Bearer\s+/, '');
        const openid = auth.replace(/^tok-/, '');
        const had = Object.prototype.hasOwnProperty.call(users, openid);
        delete users[openid];
        return Promise.resolve({ statusCode: 200, data: { deleted: had }, header: {} });
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

        // 自建动作：整行 LWW + 墓碑，规则和 sets 一致
        const rejectCustom = (server.rejectNext && server.rejectNext.kind === 'customExercise')
          ? server.rejectNext.index : -1;
        (body.customExercises || []).forEach(function (x, i) {
          if (i === rejectCustom) {
            rejected.push({
              kind: 'customExercise', index: i,
              reason: (server.rejectNext && server.rejectNext.reason) || 'bad'
            });
            return;
          }
          st.rev++;
          st.exercises[x.exId] = Object.assign({}, x, { rev: st.rev });
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
        Object.keys(st.exercises).forEach(function (k) {
          if (st.exercises[k].rev > cursor) all.push({ t: 'x', v: st.exercises[k] });
        });
        if (st.config && st.config.rev > cursor) all.push({ t: 'c', v: st.config });
        all.sort(function (a, b) { return a.v.rev - b.v.rev; });

        const page = all.slice(0, 1000);
        const out = {
          cursor: page.length ? page[page.length - 1].v.rev : st.rev,
          hasMore: all.length > page.length,
          applied: 0,
          rejected: rejected,
          sets: [], workouts: [], metrics: [], customExercises: [], config: null,
          catalogRev: catalog.rev,
          serverTime: new Date().toISOString()
        };
        page.forEach(function (x) {
          if (x.t === 's') out.sets.push(x.v);
          else if (x.t === 'w') out.workouts.push(x.v);
          else if (x.t === 'x') out.customExercises.push(x.v);
          else out.config = x.v;
        });
        return Promise.resolve({ statusCode: 200, data: out, header: {} });
      }

      // 官方动作清单：since >= rev 返回 304，否则整份
      if (path.indexOf('/catalog') === 0) {
        const q = path.split('?')[1] || '';
        const m = /since=(\d+)/.exec(q);
        const since = m ? Number(m[1]) : -1;
        if (since >= catalog.rev) {
          return Promise.resolve({ statusCode: 304, data: {}, header: {} });
        }
        return Promise.resolve({
          statusCode: 200,
          data: { rev: catalog.rev, exercises: catalog.exercises },
          header: {}
        });
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

  /* ---- 13. 动作库：自建动作同步 + 官方清单 ---- */
  console.log('\n=== 动作库同步 ===');

  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });

  // 13.1 建一个自建动作 → 上传；换设备能拉回来
  const ce = db.saveCustomExercise({ cn: '绳索夹胸', part: 'chest', place: 'gym', unit: 'kg', tips: '肘部固定' });
  let rr = await sync.kick();
  sync.stop();
  ok('自建动作同步没报错', !rr.error, JSON.stringify(rr));
  ok('上传后待上传队列清空', db.syncPending() === 0, 'pending=' + db.syncPending());

  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  rr = await sync.kick();
  sync.stop();
  ok('新设备拉回自建动作', db.customExercises().some(function (e) { return e.id === ce.exId; }),
    db.customExercises().map(function (e) { return e.id; }).join(','));

  // 13.2 被服务端拒绝的自建动作：要出队，否则一条坏数据让队列永远卡住
  db.saveCustomExercise({ exId: 'u-badpart', cn: '部位乱写', part: 'glutes', place: 'gym', unit: 'kg' });
  srv.rejectNext = { kind: 'customExercise', index: 0, reason: 'part 必须是六个部位之一' };
  rr = await sync.kick();
  sync.stop();
  ok('被拒绝的自建动作也出队（不卡队列）', db.syncPending() === 0, 'pending=' + db.syncPending());
  // §7.4：被拒的行不能静默消失——留在「我的动作」里，行上带原因，界面标红
  const badRow = db.customExercises().filter(function (e) { return e.id === 'u-badpart'; })[0];
  ok('被拒的动作留在本地（不是删掉）', !!badRow);
  ok('拒绝原因记在行上（界面能标红）', !!badRow && !!badRow.syncError, badRow && badRow.syncError);

  // 13.3 catalogRev 变了 → 自动拉整份清单
  srv.setCatalog(9, [{
    id: 'g1', cn: '卧推（服务端）', en: 'Bench Press', part: 'chest', place: 'gym',
    unit: 'kg', tips: '肩胛下沉', hot: true, imgThumb: '', retired: false
  }]);
  db.applyCatalog(0, []);          // 本地版本清零，确保这次会触发拉取
  rr = await sync.kick();
  await new Promise(function (r2) { setTimeout(r2, 50); });   // refreshCatalog 故意不 await，给它一拍
  sync.stop();
  ok('catalogRev 变化后拉到了清单',
    db.exercises().length === 1 && db.exerciseById('g1').cn === '卧推（服务端）',
    db.exercises().length + ' 条 / ' + (db.exerciseById('g1') || {}).cn);
  ok('本地 catalogRev 跟上服务端', db.catalogRev() === 9, db.catalogRev());

  // 13.4 版本相等 → 不再重复拉
  const catCallsBefore = srv.calls.filter(function (c) { return c.url.indexOf('/catalog') >= 0; }).length;
  rr = await sync.kick();
  await new Promise(function (r2) { setTimeout(r2, 50); });
  sync.stop();
  const catCallsAfter = srv.calls.filter(function (c) { return c.url.indexOf('/catalog') >= 0; }).length;
  ok('清单版本没变时不重复拉', catCallsAfter === catCallsBefore,
    catCallsBefore + ' → ' + catCallsAfter);

  // 13.5 本地 rev 比服务端大（服务端被重置）→ 按 0 处理，强制全量自愈
  db.applyCatalog(999, []);
  rr = await sync.kick();
  await new Promise(function (r2) { setTimeout(r2, 50); });
  sync.stop();
  ok('本地 rev 超大时自愈（强制全量拉回来）',
    db.catalogRev() === 9 && db.exercises().length === 1, db.catalogRev());

  /* ---- 14. 删除账号（合规：删除个人信息） ---- */
  console.log('\n=== 删除账号 ===');
  CFG.setApiBase('http://fake');
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  set(T, 'g1', 1, 50);
  await sync.kick();                                   // 推到「云端」

  ok('删除前云端有数据', db.syncPending() === 0);

  const delOk = await sync.deleteAccount();
  ok('删除账号返回成功', delOk === true, String(delOk));
  ok('删完清掉本地 token（否则下次请求会重登建新号）', !mem['lj.auth'],
    JSON.stringify(mem['lj.auth'] || null));
  ok('删完清掉游标', !mem['lj.sync.cursor'], String(mem['lj.sync.cursor']));

  // 换设备 = 清本地 + 用同一个 code 重新登录：如果级联没生效，旧记录会被拉回来
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  await sync.kick();
  ok('删完换设备拉不回旧记录', db.allSets().length === 0, 'sets=' + db.allSets().length);

  // 纯本地模式没有云端可删，直接拒绝（页面自己走「只清本机」那条路）
  CFG.setApiBase(null);
  let rejected = false;
  try { await sync.deleteAccount(); } catch (e) { rejected = true; }
  ok('纯本地模式删账号直接拒绝', rejected);
  CFG.setApiBase('http://fake');

  /* ---- 15. 客户端错误上报（兜底钩子） ---- */
  console.log('\n=== 客户端错误上报 ===');
  const report = require('./utils/report');
  const posted = [];
  global.wx.request = function (opt) {
    posted.push(opt);
    if (opt.success) opt.success({ statusCode: 204 });
  };

  CFG.setApiBase(null);
  report.reset();
  posted.length = 0;
  ok('本地模式不上报（一行请求都不发）',
    report.send('onError', { msg: 'x' }) === false && posted.length === 0);

  // 纯本地：没有服务端可发，但错误必须留在本机（「我的 → 诊断信息」能贴出来）
  const diagMod = require('./utils/diag');
  diagMod.clear();
  report.reset();
  report.crash(new Error('纯本地的错误'));
  ok('纯本地：错误也留在本机',
    diagMod.list().length === 1 && diagMod.list()[0].msg.indexOf('纯本地的错误') >= 0,
    JSON.stringify(diagMod.list()));
  ok('纯本地：诊断文本里能看到这条错误', diagMod.text([]).indexOf('纯本地的错误') >= 0);
  diagMod.clear();

  CFG.setApiBase('http://fake');
  report.reset();
  posted.length = 0;
  ok('连上云端才上报', report.crash(new Error('炸了')) === true && posted.length === 1);
  const firstErr = posted[0] || { data: {} };
  ok('打到 /client-error，带 kind 和 sid',
    /\/client-error$/.test(firstErr.url || '') && firstErr.data.kind === 'onError' && !!firstErr.data.sid,
    firstErr.url);
  ok('同一条错误 60 秒内不重复报', report.crash(new Error('炸了')) === false);
  ok('不同错误照常上报', report.rejection({ reason: new Error('另一个') }) === true);

  report.reset();
  posted.length = 0;
  for (let i = 0; i < 30; i++) report.send('onError', { msg: 'e' + i });
  ok('一次启动最多 20 条（不刷屏）', posted.length === 20, posted.length);

  /* ---- 16. 纯本地 → 开云端：本机历史要自动全量上云（可扩展性） ---- */
  console.log('\n=== 纯本地转云端（历史不能丢） ===');
  CFG.setApiBase(null);
  anotherDevice();
  delete mem['lj.sync.backfilled'];          // 模拟「这个版本之前一直在纯本地用」
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  set(T, 'g1', 1, 50);
  set(T, 'g1', 2, 50);
  set(T, 'g2', 1, 40);
  ok('纯本地时行不进上传队列（所以必须有 backfill）', db.syncPending() === 0, db.syncPending());

  CFG.setApiBase('http://fake');
  await sync.kick();
  ok('接上云端后历史全传上去', db.syncPending() === 0, db.syncPending());
  ok('backfill 标记已写入', !!mem['lj.sync.backfilled'], String(mem['lj.sync.backfilled']).slice(0, 10));

  // 换设备：云端真的有了才拉得回来
  anotherDevice();
  db.finishOnboarding({ level: 'some', days: 3, place: 'gym' });
  await sync.kick();
  ok('新设备拉回纯本地时期记的 3 组', db.allSets().length === 3, db.allSets().length);

  // 只做一次：之后不能把历史重推一遍
  const pushSizes = [];
  const origTransport = srv.transport;
  sync.setTransport(function (opt) {
    if (opt.url.indexOf('/sync') >= 0) pushSizes.push(((opt.data || {}).sets || []).length);
    return origTransport(opt);
  });
  set(T, 'g2', 2, 40);
  await sync.kick();
  ok('第二次同步只推新改的那 1 行，不重推历史',
    pushSizes.length > 0 && pushSizes.every(function (n) { return n <= 1; }), JSON.stringify(pushSizes));
  sync.setTransport(origTransport);

  sync.stop();
}

main().then(function () {
  console.log('\n' + (failed ? ('有 ' + failed + ' 项失败') : '同步调度测试全部通过') + '\n');
  if (failed) process.exitCode = 1;
}).catch(function (e) {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
