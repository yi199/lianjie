/**
 * 动作库自测（动作库 v1.3 · E2 客户端数据源）
 * 跑法：node test-catalog.js
 *
 * 测的是 utils/catalog.js 这个「唯一数据源」本身：
 *   三路来源（服务端清单 / 自建 / 包内快照）、清单整份替换与 retired 过滤、
 *   自建动作的墓碑与上限、换动作候选的语义、详情缓存的 TTL 与 LRU、变更通知、清空。
 *
 * test.js 第 20 组测的是「db 层怎么用动作库」（记录、战报、批次），这里不重复。
 */

const mem = {};
global.wx = {
  getStorageSync(k) { return mem[k] === undefined ? '' : mem[k]; },
  setStorageSync(k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync(k) { delete mem[k]; },
  getStorageInfoSync() { return { keys: Object.keys(mem), currentSize: 0, limitSize: 10240 }; }
};

const CAT = require('./utils/catalog');
const db = require('./utils/db');
const S = require('./utils/storage');
const CFG = require('./utils/config');
const EX = require('./data/exercises');

let failed = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failed++;
}

let emits = 0;
CAT.onChange(function () { emits++; });

function fresh() {
  Object.keys(mem).forEach(function (k) { delete mem[k]; });
  CAT.reset();                 // 清 storage + 内存缓存 + 详情
  S.reset();
  CFG.setApiBase(null);
  emits = 0;
  CAT.setDetailLoader(null);
}

/* ---------------- 1. 三路来源：包内快照兜底 ---------------- */

console.log('\n=== 1. 没有服务端清单时，用包里那份快照 ===');
fresh();

ok('首装 list() 就是包内 105 个动作', CAT.list().length === EX.EXERCISES.length && CAT.list().length === 105,
  CAT.list().length);
ok('list() 不会把包内数组原样吐出来（下游改动不该污染快照）',
  CAT.list() !== EX.EXERCISES);
ok('没有清单时 catalogRev 是 0', CAT.catalogRev() === 0, CAT.catalogRev());
ok('包里能查到卧推', CAT.find('g1') && CAT.find('g1').cn === '卧推', CAT.find('g1') && CAT.find('g1').cn);

/* ---------------- 2. 服务端清单：整份替换 + retired ---------------- */

console.log('\n=== 2. 服务端清单整份替换，retired 在客户端过滤 ===');

CAT.applyCatalog(7, [
  { id: 'g1', cn: '卧推（新版）', en: 'Bench Press', part: 'chest', place: 'gym', unit: 'kg', tips: '', retired: false },
  { id: 'g2', cn: '上斜卧推', en: '', part: 'chest', place: 'gym', unit: 'kg', tips: '', retired: false },
  { id: 'g99', cn: '下架动作', en: '', part: 'chest', place: 'gym', unit: 'kg', tips: '', retired: true }
]);

ok('整份替换（2 可用的 + 1 下架的）', CAT.list().length === 2, CAT.list().length);
ok('retired=true 的被过滤掉', !CAT.find('g99'));
ok('清单里的改名生效', CAT.find('g1').cn === '卧推（新版）', CAT.find('g1').cn);
ok('catalogRev 记成 7', CAT.catalogRev() === 7, CAT.catalogRev());
ok('写入清单会通知订阅者', emits === 1, emits);

/* ---------------- 3. 自建动作：字段映射 / 墓碑 ---------------- */

console.log('\n=== 3. 自建动作：字段映射、墓碑、原始记录 ===');

CAT.putCustom({
  exId: 'u-test0001-aaaa', cn: '农夫行走', part: 'core', place: 'gym',
  unit: 'kg', tips: '别耸肩', done: true, updatedAt: '2026-11-04T10:00:00.000Z', rev: 0
});

const mine = CAT.custom();
ok('custom() 里有一条', mine.length === 1, mine.length);
ok('id 用 exId 映射成 id', mine[0].id === 'u-test0001-aaaa', mine[0].id);
ok('带 custom:true，下游能区分来源', mine[0].custom === true, mine[0].custom);
ok('en 补空串（自建没有英文名）', mine[0].en === '', JSON.stringify(mine[0].en));
ok('find() 能查到自建动作', CAT.find('u-test0001-aaaa') && CAT.find('u-test0001-aaaa').cn === '农夫行走');
ok('自定义动作不和官方 id 空间冲突', CAT.find('g1').custom === undefined);

CAT.putCustom({
  exId: 'u-test0001-aaaa', cn: '农夫行走（改）', part: 'core', place: 'gym',
  unit: 'kg', tips: '', done: true, updatedAt: '2026-11-04T11:00:00.000Z', rev: 0
});
ok('同 exId 再写是更新不是新增', CAT.custom().length === 1, CAT.custom().length);
ok('更新后的名字生效', CAT.find('u-test0001-aaaa').cn === '农夫行走（改）',
  CAT.find('u-test0001-aaaa').cn);

CAT.putCustom({
  exId: 'u-test0001-aaaa', cn: '农夫行走（改）', part: 'core', place: 'gym',
  unit: 'kg', tips: '', done: false, updatedAt: '2026-11-04T12:00:00.000Z', rev: 0
});
ok('墓碑（done:false）不出现在 custom()', CAT.custom().length === 0, CAT.custom().length);
ok('墓碑查不到', CAT.find('u-test0001-aaaa') === null);
ok('墓碑仍然留在 rawCustom()（同步要把它传上去）', CAT.rawCustom().length === 1, CAT.rawCustom().length);
ok('墓碑不占 30 个名额', CAT.canAddCustom() === true);

/* ---------------- 4. 换动作候选的语义 ---------------- */

console.log('\n=== 4. 换动作候选：同部位 + 同场所，自建动作放行场所 ===');
fresh();
CAT.applyCatalog(1, [
  { id: 'c1', cn: '卧推', en: '', part: 'chest', place: 'gym', unit: 'kg', tips: '', retired: false },
  { id: 'c2', cn: '上斜卧推', en: '', part: 'chest', place: 'gym', unit: 'kg', tips: '', retired: false },
  { id: 'c3', cn: '俯卧撑', en: '', part: 'chest', place: 'home', unit: 'kg', tips: '', retired: false },
  { id: 'b1', cn: '引体向上', en: '', part: 'back', place: 'gym', unit: 'kg', tips: '', retired: false }
]);
CAT.putCustom({ exId: 'u-farm', cn: '农夫行走', part: 'chest', place: 'home', unit: 'kg', tips: '', done: true, updatedAt: 'x' });
CAT.putCustom({ exId: 'u-legs', cn: '深蹲', part: 'legs', place: 'gym', unit: 'kg', tips: '', done: true, updatedAt: 'x' });

const cand = CAT.candidates('c1').map(function (e) { return e.id; });
ok('同部位同场所的官方动作进来（c2）', cand.indexOf('c2') >= 0, cand.join(','));
ok('同部位不同场所的官方动作不进来（c3 在 home）', cand.indexOf('c3') < 0, cand.join(','));
ok('不同部位的不进来（b1）', cand.indexOf('b1') < 0, cand.join(','));
ok('候选里不含自己（c1）', cand.indexOf('c1') < 0, cand.join(','));
ok('同部位的自建动作放行场所（u-farm 在 home 也要出来）', cand.indexOf('u-farm') >= 0, cand.join(','));
ok('不同部位的自建动作不进来（u-legs）', cand.indexOf('u-legs') < 0, cand.join(','));
ok('查不到的动作返回空候选', CAT.candidates('nope').length === 0, CAT.candidates('nope').length);
ok('自建动作自己换自己也不出现', CAT.candidates('u-farm').indexOf('u-farm') < 0,
  CAT.candidates('u-farm').map(function (e) { return e.id; }).join(','));

/* ---------------- 5. 选动作面板：我的动作置顶 ---------------- */

console.log('\n=== 5. 选动作面板：自建整组置顶，场所过滤 ===');

const pk = CAT.pickable('gym');
ok('第一组是自建动作', pk[0] && pk[0].custom === true, pk[0] && pk[0].id);
ok('后面才是官方（只留 gym 的）', pk.filter(function (e) { return e.custom; }).length === 2 &&
  pk.filter(function (e) { return !e.custom; }).every(function (e) { return e.place === 'gym'; }),
  pk.map(function (e) { return e.id; }).join(','));
ok('pickable("all") 不过滤场所', CAT.pickable('all').length === 6, CAT.pickable('all').length);
ok('不传场所 = 不过滤', CAT.pickable().length === 6, CAT.pickable().length);

/* ---------------- 6. 上限 30（墓碑不占名额） ---------------- */

console.log('\n=== 6. 自建动作上限 30 ===');
fresh();
for (let i = 0; i < 30; i++) {
  CAT.putCustom({ exId: 'u-cap' + i, cn: '动作' + i, part: 'chest', place: 'gym', unit: 'kg', tips: '', done: true, updatedAt: 'x' });
}
ok('30 个时不能再加', CAT.canAddCustom() === false, CAT.custom().length);
CAT.putCustom({ exId: 'u-cap0', cn: '动作0', part: 'chest', place: 'gym', unit: 'kg', tips: '', done: false, updatedAt: 'x' });
ok('删掉一个（墓碑）后又能加了', CAT.canAddCustom() === true, CAT.custom().length);

/* ---------------- 7. 详情缓存：TTL / 失败降级 / LRU ---------------- */

console.log('\n=== 7. 详情：缓存优先、7 天过期、拿不到就降级 ===');
fresh();

let calls = 0;
function loader(path, opts) {
  calls++;
  return Promise.resolve({ steps: ['躺下', '握距略比肩宽', '落到胸口'], imgDetail: 'https://x/a.png' });
}

const noLoader = CAT.detail('g1');
ok('没注入 loader 时返回 null（页面只用列表字段）', noLoader instanceof Promise, typeof noLoader);

(async function () {
  const none = await noLoader;
  ok('没 loader → 解析成 null', none === null, none);

  CAT.setDetailLoader(loader);
  const d1 = await CAT.detail('g1');
  ok('拉到了分步说明', d1 && d1.steps.length === 3, d1 && d1.steps.length);
  ok('拉到了大图', d1 && d1.imgDetail === 'https://x/a.png', d1 && d1.imgDetail);
  ok('请求路径是 /exercises/{id}', calls === 1, calls + ' 次');

  const d2 = await CAT.detail('g1');
  ok('第二次走缓存，不再发请求', calls === 1, calls + ' 次');
  ok('缓存里也是同样的内容', d2.steps.length === 3);

  // 把缓存时间改老 → 过期重拉
  const key = CAT.__const.K_DETAIL + 'g1';
  const old = JSON.parse(JSON.stringify(mem[key]));
  old.fetchedAt = Date.now() - 8 * 24 * 3600 * 1000;
  mem[key] = old;
  await CAT.detail('g1');
  ok('超过 7 天会重新拉', calls === 2, calls + ' 次');

  // 网络失败 → null，不抛
  CAT.setDetailLoader(function () { return Promise.reject(new Error('network')); });
  mem[CAT.__const.K_DETAIL + 'g9'] = '';
  delete mem[CAT.__const.K_DETAIL + 'g9'];
  const bad = await CAT.detail('g9');
  ok('拉失败返回 null，不抛错', bad === null, bad);

  // LRU：塞 51 条，拉到第 52 条之后只留 50
  for (let i = 0; i < 51; i++) {
    mem[CAT.__const.K_DETAIL + 'old' + i] = { steps: [], imgDetail: '', fetchedAt: 1000 + i };
  }
  CAT.setDetailLoader(loader);
  await CAT.detail('g-new');
  const keys = Object.keys(mem).filter(function (k) { return k.indexOf(CAT.__const.K_DETAIL) === 0; });
  ok('详情缓存最多留 50 条', keys.length === 50, keys.length);
  ok('先删最老的（old0 不在）', keys.indexOf(CAT.__const.K_DETAIL + 'old0') < 0);
  ok('刚拉的留着', keys.indexOf(CAT.__const.K_DETAIL + 'g-new') >= 0);

  /* ---------------- 8. 服务端下发的自建动作 ---------------- */

  console.log('\n=== 8. 应用下发的自建动作：合并、墓碑、跳过本地未上传 ===');
  fresh();

  const n1 = CAT.applyRemoteCustom([
    { exId: 'u-r1', cn: '绳索夹胸', part: 'chest', place: 'gym', unit: 'kg', tips: '', updatedAt: '2026-11-01T00:00:00Z', rev: 3 },
    { exId: 'u-r2', cn: '壶铃摇摆', part: 'core', place: 'gym', unit: 'kg', tips: '', updatedAt: '2026-11-01T00:00:00Z', rev: 4 }
  ]);
  ok('两条都写进来了', n1 === 2 && CAT.custom().length === 2, n1 + ' / ' + CAT.custom().length);
  ok('自建动作写进来后能查到', CAT.find('u-r2') && CAT.find('u-r2').cn === '壶铃摇摆');

  const n2 = CAT.applyRemoteCustom([
    { exId: 'u-r1', cn: '绳索夹胸（服务端改）', part: 'chest', place: 'gym', unit: 'kg', tips: '慢放', updatedAt: '2026-11-02T00:00:00Z', rev: 5 }
  ]);
  ok('同一条再下发是更新', n2 === 1 && CAT.custom().length === 2, CAT.custom().length);
  ok('服务端的新名字生效', CAT.find('u-r1').cn === '绳索夹胸（服务端改）', CAT.find('u-r1').cn);

  const n3 = CAT.applyRemoteCustom([
    { exId: 'u-r1', cn: 'x', part: 'chest', place: 'gym', unit: 'kg', done: false, updatedAt: '2026-11-03T00:00:00Z', rev: 6 }
  ]);
  ok('墓碑下发 → 本地直接删掉（不是留个假行）', n3 === 1 && CAT.rawCustom().length === 1, CAT.rawCustom().length);
  ok('删掉之后查不到', CAT.find('u-r1') === null);

  const n4 = CAT.applyRemoteCustom([
    { exId: 'u-local', cn: '本地还没传上去的', part: 'chest', place: 'gym', unit: 'kg', updatedAt: '2026-11-03T00:00:00Z', rev: 7 }
  ], function (id) { return id === 'x:u-local'; });
  ok('本地有未上传改动 → 跳过服务端那份', n4 === 0 && CAT.find('u-local') === null, n4);

  const before = emits;
  CAT.applyRemoteCustom([]);
  ok('空数组不触发通知', emits === before, emits - before);

  /* ---------------- 9. 清空 ---------------- */

  console.log('\n=== 9. reset：清单、自建、详情一起清 ===');
  CAT.applyCatalog(9, [{ id: 'z1', cn: '动作', en: '', part: 'chest', place: 'gym', unit: 'kg', tips: '', retired: false }]);
  mem[CAT.__const.K_DETAIL + 'z1'] = { steps: [], imgDetail: '', fetchedAt: Date.now() };
  CAT.reset();
  ok('jar 里没有清单了', CAT.catalogRev() === 0, CAT.catalogRev());
  ok('回到包内快照（105）', CAT.list().length === 105, CAT.list().length);
  ok('自建动作清空', CAT.rawCustom().length === 0, CAT.rawCustom().length);
  ok('详情缓存清空', Object.keys(mem).filter(function (k) { return k.indexOf(CAT.__const.K_DETAIL) === 0; }).length === 0);

  /* ---------------- 10. db 层的把关（上限与空名字） ---------------- */

  console.log('\n=== 10. db.saveCustomExercise 的把关 ===');
  fresh();

  ok('空名字被拒绝', db.saveCustomExercise({ cn: '   ', part: 'chest' }) === null);
  ok('拒绝后没有脏数据', CAT.custom().length === 0, CAT.custom().length);

  const a = db.saveCustomExercise({ cn: '农夫行走', part: 'core', place: 'gym' });
  const b = db.saveCustomExercise({ cn: '农夫行走', part: 'core', place: 'gym' });
  ok('两次新建拿到不同 id（不是撞成同一条）', a.exId !== b.exId, a.exId + ' / ' + b.exId);
  ok('id 格式 u-xxxxxxxx-xxxx', /^u-[0-9a-z]{8}-[0-9a-z]{4}$/.test(a.exId), a.exId);
  ok('id 不超过 16 字节', Buffer.byteLength(a.exId, 'utf8') <= 16, a.exId.length);
  ok('名字前后空格被去掉', db.saveCustomExercise({ cn: '  单臂划船  ', part: 'back' }).cn === '单臂划船');

  fresh();
  for (let i = 0; i < 30; i++) {
    db.saveCustomExercise({ exId: 'u-full' + i, cn: '动作' + i, part: 'chest', place: 'gym' });
  }
  const over = db.saveCustomExercise({ cn: '第 31 个', part: 'chest', place: 'gym' });
  ok('满 30 后第 31 个被拒绝（不是只把按钮置灰）', over === null, over && over.exId);
  ok('被拒绝时没有多写一条', CAT.custom().length === 30, CAT.custom().length);
  ok('修改已有动作不受上限影响',
    !!db.saveCustomExercise({ exId: 'u-full0', cn: '动作0改', part: 'chest', place: 'gym' }),
    db.exerciseById('u-full0').cn);

  /* ---------------- 收尾 ---------------- */

  console.log('');
  if (failed) {
    console.log('有 ' + failed + ' 项失败');
    process.exit(1);
  }
  console.log('动作库全部通过');
})();
