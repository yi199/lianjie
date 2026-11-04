/**
 * 数据层（第一版：微信本地存储）
 *
 * 为什么单独一层：以后换成云开发，只改这个文件，
 * 页面调用的方法签名不变（都是同步返回，后续换云时再改 Promise）。
 *
 * 存储键：
 *   lj.onboarded  是否走完首次引导
 *   lj.profile    引导时的选择 { level, days, place }
 *   lj.plans      训练日模板队列（数组，不是按星期的对象）
 *   lj.sets.*     组记录，按月分 key（见 utils/storage.js）
 *   lj.workouts.* 一次训练，按年分 key（同上）
 */

const EX = require('../data/exercises');   // 只剩 PART_CN / 包内快照这类静态内容
const CAT = require('../utils/catalog');   // 动作数据的唯一入口（官方清单 + 自建动作）
const P = require('../data/plan');
const PR = require('../data/programs');
const D = require('../utils/date');
const V = require('../utils/volume');
const S = require('../utils/storage');
const CFG = require('../utils/config');
const store = require('../store/index');

const K_ONBOARDED = 'lj.onboarded';
const K_PROFILE = 'lj.profile';
const K_PLAN = 'lj.plans';
const K_SWAPS = 'lj.swaps';   // 训练日里「第几个动作 → 换成哪个」，跟着计划走
const K_CUSTOM = 'lj.customPrograms';   // 用户自己搭的方案（数组）
const K_CONFIG_META = 'lj.config.meta'; // 配置文档的版本与是否待上传 { updatedAt, dirty }

const LEVEL_CN = { new: '刚开始', some: '练过一阵', trained: '一直在练' };

/* ---------------- 引导 / 用户设置 ---------------- */

function hasOnboarded() {
  return !!wx.getStorageSync(K_ONBOARDED);
}

function profile() {
  return wx.getStorageSync(K_PROFILE) || null;
}

/**
 * 生成并保存计划（改设置、换方案都走这里）
 *
 * profile.programId：
 *   'auto'    按 level × days × place 自动排（原来的行为）
 *   方案 id   用官方 / 自定义方案里显式写死的动作表
 */
function saveProfile(p) {
  const prof = {
    level: p.level || 'some',
    days: Number(p.days) || 3,
    place: p.place === 'home' ? 'home' : 'gym',
    programId: p.programId || 'auto'
  };
  const oldSig = planSig();
  wx.setStorageSync(K_PROFILE, prof);
  applyProgram(prof);

  // 训练日编号的含义变了（A 从「推日」变「上肢 A」），旧的换动作记录不能再用
  if (oldSig && oldSig !== planSig()) wx.removeStorageSync(K_SWAPS);

  markConfigDirty();
  return plans();
}

/**
 * 把方案写进 lj.plans。
 *
 * 官方方案和自定义方案是同一种结构，都走 PR.expand —— 所以
 * 「今天该练哪个训练日」的轮转逻辑（nextKey/todaySession）一行都不用改，
 * 页面层也完全不知道「方案」这个概念存在。
 */
function applyProgram(prof) {
  let list = null;

  if (prof.programId && prof.programId !== 'auto') {
    const prog = programById(prof.programId);
    if (prog) list = PR.expand(prog);
  }

  if (!list) {
    // 方案被删了，或者本来就是 auto → 退回参数化生成
    prof.programId = 'auto';
    list = P.buildPlan(prof.days, prof.place, prof.level);
    wx.setStorageSync(K_PROFILE, prof);
  }

  wx.setStorageSync(K_PLAN, list);
  return list;
}

/** 走完引导（第一次进入时调用） */
function finishOnboarding(p) {
  saveProfile(p);
  wx.setStorageSync(K_ONBOARDED, true);
  markConfigDirty();
}

/**
 * 兼容旧版本存储。
 * 1) 老版本没有引导，启动就写入写死的计划 + 126 条假记录（键 lj.seeded）
 * 2) 老版本的 plans 是按星期的对象，现在是训练日队列数组
 */
function migrate() {
  let changed = false;

  if (wx.getStorageSync('lj.seeded') && !hasOnboarded()) {
    S.removeAll();
    wx.removeStorageSync(K_PLAN);
    wx.removeStorageSync('lj.seeded');
    changed = true;
  }

  const p = wx.getStorageSync(K_PLAN);
  if (p && !Array.isArray(p) && Object.keys(p).length) {
    const prof = profile();
    if (prof) {
      wx.setStorageSync(K_PLAN, P.buildPlan(prof.days, prof.place, prof.level));
    } else {
      wx.removeStorageSync(K_PLAN);
    }
    changed = true;
  }

  // 老 profile 没有 programId，补成 auto；不补的话换方案时签名不会变，会漏判
  const prof = wx.getStorageSync(K_PROFILE);
  if (prof && prof.programId === undefined) {
    prof.programId = 'auto';
    wx.setStorageSync(K_PROFILE, prof);
    changed = true;
  }

  return changed;
}

function profileText() {
  const p = profile();
  if (!p) return '';
  if (p.programId && p.programId !== 'auto') {
    const prog = programById(p.programId);
    if (prog) return PR.describe(prog);      // 一周 3 练 · 健身房 · 增肌推拉腿
  }
  return P.describe(p);
}

/* ---------------- 动作 ---------------- */

function exercises() {
  return CAT.list();
}

function exerciseById(id) {
  return CAT.find(id);
}

/** 这个动作第一次做该上多重（按用户当前水平算） */
function initialWeight(exId) {
  return P.initialWeight(exId, (profile() || {}).level);
}

/**
 * 同部位、同场所的其它动作（换动作用）。场所跟着动作本身走，不看用户设置。
 *
 * 传了训练日 planKey 时，排除这个训练日里已有的动作和今天已经练过的动作——
 * 否则换成同一天已有的动作，两个位置的组会写到同一条记录上互相覆盖（模块设计 §9.2）。
 *
 * date 只给测试用：传了就拿它当「今天」，不传走 trainingDate()（含跨零点顺延）。
 */
function alternatives(exId, planKey, date) {
  const list = CAT.candidates(exId);
  if (!list.length) return [];
  if (!planKey) return list;

  const exclude = {};
  const p = plans().filter(function (x) { return x.key === planKey; })[0];
  if (p) decorate(p).items.forEach(function (it) { exclude[it.exId] = true; });
  todaySets(date || trainingDate()).forEach(function (s) { exclude[s.exId] = true; });
  return list.filter(function (e) { return !exclude[e.id]; });
}

/* ---------------- 自建动作（动作库模块） ---------------- */

function customExercises() {
  return CAT.custom();
}

function canAddCustomExercise() {
  return CAT.canAddCustom();
}

/**
 * 生成自建动作 id：'u-' + 8 位 base36 时间戳 + '-' + 4 位随机 = 15 字符。
 *
 * 为什么这么拼：36^8 ≈ 2.8e12 > Date.now()，8 位正好装下毫秒时间戳；
 * 总长必须 ≤16 字节——ex_id 是组记录主键的一部分，超长会让用这个动作记的**每一组**
 * 在同步时被服务端拒收。前缀 'u-' 让自建和官方（g 开头、h 开头）的 id 空间结构上不相交，
 * 所以两台设备离线各建一个也不用查重。
 */
function newCustomId() {
  const ts = Date.now().toString(36).slice(-8);
  const rnd = Math.random().toString(36).slice(2, 6);
  return 'u-' + (ts + '00000000').slice(0, 8) + '-' + (rnd + '0000').slice(0, 4);
}

/** 新建或修改一个自建动作；写本地 + 标脏，等同步上传。返回 null 表示没写（名字空 / 满 30 个） */
function saveCustomExercise(rec) {
  const now = S.stamp();
  const exId = rec.exId || newCustomId();
  const name = String(rec.cn || '').trim();
  // 名字是唯一能认出它的东西（选择面板、「我的动作」、战报都只显示 cn），
  // 空名字等于往库里塞一条看不见的动作，必须当场拒绝，不能靠页面兜。
  if (!name) return null;
  const prev = CAT.rawCustom().filter(function (e) { return e.exId === exId; })[0] || {};
  // 上限 30 只由客户端把关：**新建**才判，改已有动作不占新名额（否则改名字改不了）。
  if (!prev.exId && !CAT.canAddCustom()) return null;
  const row = Object.assign({}, prev, {
    exId: exId,
    cn: name,
    part: rec.part,
    place: rec.place || 'gym',
    unit: rec.unit || 'kg',
    tips: String(rec.tips || '').slice(0, 64),
    done: true,
    // 用户改过就清掉上次的拒绝原因：改完会重新上传，旧的错误提示不能一直挂着
    syncError: '',
    updatedAt: now,
    rev: 0
  });
  const saved = CAT.putCustom(row);
  S.markDirty('x:' + exId, now);
  return saved;
}

/** 删除 = 墓碑（done:false），跨设备传播；历史记录照常显示（sets 里冗余存了 exCn） */
function removeCustomExercise(exId) {
  const cur = CAT.rawCustom().filter(function (e) { return e.exId === exId; })[0];
  if (!cur) return false;
  const now = S.stamp();
  CAT.putCustom(Object.assign({}, cur, { done: false, updatedAt: now }));
  S.markDirty('x:' + exId, now);
  return true;
}

/** 官方动作清单整份写入（同步层拉到 /catalog 之后调） */
function applyCatalog(rev, list) {
  CAT.applyCatalog(rev, list);
}

/** 本地清单版本号，和 /sync 的 catalogRev 比 */
function catalogRev() {
  return CAT.catalogRev();
}

/** 动作库变更（清单更新 / 自建动作增删），页面用它刷新 */
function onCatalogChange(fn) {
  CAT.onChange(fn);
}

/* ---------------- 计划 ---------------- */

/** 训练日模板队列：[{ key:'A', type, name, en, items }] */
function plans() {
  const p = wx.getStorageSync(K_PLAN);
  return Array.isArray(p) ? p : [];
}

/* ---------------- 方案：官方预选 / 用户自定义 ---------------- */

function customPrograms() {
  const list = wx.getStorageSync(K_CUSTOM);
  return Array.isArray(list) ? list : [];
}

/**
 * 存一个自定义方案（新建或覆盖同 id）。
 * 结构对齐官方方案，这样两边都能被 PR.expand 展开成同一种训练日队列。
 */
function saveCustomProgram(prog) {
  const list = customPrograms();
  const sessions = (prog.sessions || []).map(function (s, i) {
    const letter = String.fromCharCode(65 + i);
    return {
      key: s.key || letter,
      type: s.type || 'fullA',
      name: s.name || ('训练日 ' + letter),
      en: s.en || '',
      exIds: (s.exIds || []).slice()
    };
  });

  const row = {
    id: prog.id || ('my-' + Date.now()),
    name: prog.name || '我的方案',
    en: prog.en || 'Custom',
    desc: prog.desc || '',
    place: prog.place === 'home' ? 'home' : 'gym',
    level: prog.level || 'some',
    days: sessions.length,
    tags: prog.tags || ['自定义'],
    sessions: sessions
  };

  const idx = list.findIndex(function (x) { return x.id === row.id; });
  if (idx >= 0) list[idx] = row; else list.push(row);
  wx.setStorageSync(K_CUSTOM, list);
  markConfigDirty();
  return row;
}

function removeCustomProgram(id) {
  const list = customPrograms().filter(function (x) { return x.id !== id; });
  wx.setStorageSync(K_CUSTOM, list);
  markConfigDirty();

  // 正在用这个方案 → 退回自动排，别留一个指向已删方案的 programId
  const prof = profile();
  if (prof && prof.programId === id) {
    saveProfile({ level: prof.level, days: prof.days, place: prof.place, programId: 'auto' });
  }
  return list;
}

/** 官方 + 自定义统一按 id 查 */
function programById(id) {
  return PR.byId(id) ||
    customPrograms().filter(function (x) { return x.id === id; })[0] ||
    null;
}

function currentProgramId() {
  const p = profile();
  return (p && p.programId) || 'auto';
}

/** 方案中心用的列表（带 active 标记，页面不用自己比 id） */
function programList() {
  const cur = currentProgramId();

  function brief(p, source) {
    return {
      id: p.id,
      name: p.name,
      en: p.en,
      desc: p.desc || '',
      place: p.place,
      placeCn: p.place === 'home' ? '居家' : '健身房',
      level: p.level,
      levelCn: LEVEL_CN[p.level] || p.level,
      days: p.days,
      tags: p.tags || [],
      source: source,
      active: cur === p.id,
      sessionText: p.sessions.map(function (s) { return s.key + ' ' + s.name; }).join(' · ')
    };
  }

  return {
    auto: cur === 'auto',
    official: PR.official().map(function (p) { return brief(p, 'official'); }),
    custom: customPrograms().map(function (p) { return brief(p, 'custom'); })
  };
}

/**
 * 启用方案（官方/自定义都行）。传 'auto' 退回参数化生成。
 * 会同时把 profile 的 days/place/level 对齐方案，避免「一周 3 练」显示错。
 */
function activateProgram(id) {
  const prof = profile() || { level: 'some', days: 3, place: 'gym' };
  const next = {
    level: prof.level,
    days: prof.days,
    place: prof.place,
    programId: id || 'auto'
  };

  if (id && id !== 'auto') {
    const prog = programById(id);
    if (!prog) return null;
    next.level = prog.level;
    next.days = prog.days;
    next.place = prog.place;
  }

  saveProfile(next);
  return programById(id);
}

/** 当前方案用什么动作（给方案中心的「看看练什么」用） */
function programSessions(id) {
  const prog = programById(id || currentProgramId());
  if (!prog) return [];
  return PR.expand(prog).map(function (p) {
    return {
      key: p.key,
      name: p.name,
      en: p.en,
      art: p.art,
      items: p.items.map(function (it) {
        const ex = CAT.find(it.exId) || { cn: it.exId, en: '', part: '' };
        return {
          exId: it.exId, cn: ex.cn, en: ex.en, part: ex.part,
          partCn: EX.PART_CN[ex.part] || '',
          sets: it.sets, reps: it.reps, unit: it.unit, weight: it.weight
        };
      })
    };
  });
}

/* ---------------- 换动作（训练日里永久替换） ---------------- */

/**
 * 换过的动作。
 * 存的是「训练日 key + 第几个动作」→ 新动作 id，不按日期，
 * 所以换一次以后这个训练日一直是新动作，不用每天重换。
 */
function swaps() {
  return wx.getStorageSync(K_SWAPS) || {};
}

function setSwap(planKey, slot, exId) {
  const sw = swaps();
  const list = plans();
  const p = list.filter(function (x) { return x.key === planKey; })[0];
  const origin = p && p.items[slot] ? p.items[slot].exId : '';

  // 换回原动作等于没换，别留一条「换成同一个动作」的脏记录
  if (origin && origin === exId) delete sw[planKey + ':' + slot];
  else sw[planKey + ':' + slot] = exId;

  wx.setStorageSync(K_SWAPS, sw);
  markConfigDirty();
  return sw;
}

function clearSwap(planKey, slot) {
  const sw = swaps();
  delete sw[planKey + ':' + slot];
  wx.setStorageSync(K_SWAPS, sw);
  markConfigDirty();
  return sw;
}

/* ---------------- 配置文档（设置 + 换动作 + 自定义方案，整份同步） ---------------- */

/**
 * 这三样为什么打包成一份：
 * 它们会**联动修改**（启用一个方案 = 改设置 + 换动作表清空，因为训练日编号的含义变了）。
 * 分成三个资源同步，两台设备交错修改时会出现「设置是 A 设备的、换动作是 B 设备的」这种组合。
 *
 * 训练日队列（lj.plans）不在这里：它是「配置 + 包内静态数据」的纯函数，
 * 拿到配置后重新推导即可，同步它等于同步第二份真相。
 */
const CONFIG_VER = 1;

// 应用服务端下发配置的过程中不再标脏，否则「应用」自己会被当成一次本地改动
let applyingRemote = false;
const configListeners = [];

function configMeta() {
  const m = wx.getStorageSync(K_CONFIG_META);
  return m && typeof m === 'object' ? m : { updatedAt: '', dirty: false };
}

function configUpdatedAt() {
  return configMeta().updatedAt || '';
}

/** 有没有还没上传的配置改动 */
function configPending() {
  return !!configMeta().dirty;
}

function notifyConfig() {
  configListeners.slice().forEach(function (fn) {
    try { fn(); } catch (e) { /* 单个监听器出错不影响写入 */ }
  });
}

/**
 * 配置变了：盖一个严格递增的时刻；同步打开时标脏并唤醒同步层。
 * 同步没打开时只记时刻不标脏——等接上后端由 syncMarkAll() 统一排进队列。
 */
function markConfigDirty() {
  if (applyingRemote) return;
  const meta = configMeta();
  meta.updatedAt = S.stamp();
  if (syncOn()) meta.dirty = true;
  wx.setStorageSync(K_CONFIG_META, meta);
  if (meta.dirty) notifyConfig();
}

/** 打包成契约 §1.3 的 ConfigDoc.body */
function packConfig() {
  const prof = profile();
  return {
    v: CONFIG_VER,
    onboarded: hasOnboarded(),
    profile: prof
      ? { level: prof.level, days: prof.days, place: prof.place, programId: prof.programId }
      : null,
    swaps: swaps(),
    customPrograms: customPrograms()
  };
}

/** 取一份待上传的配置；没有改动返回 null */
function takeConfig() {
  if (!configPending()) return null;
  return { body: packConfig(), updatedAt: configMeta().updatedAt };
}

/**
 * 服务端确认已收到。只清「发出去之后没再改过」的——
 * 上传途中用户又改了设置，updatedAt 已经变了，必须留着下次再传。
 */
function ackConfig(updatedAt) {
  const meta = configMeta();
  if (!meta.dirty || meta.updatedAt !== updatedAt) return false;
  meta.dirty = false;
  wx.setStorageSync(K_CONFIG_META, meta);
  return true;
}

/**
 * 应用服务端下发的配置。
 * 本地还有没上传的改动 → 整份不覆盖（等它上传后由服务端裁决，赢家下次回来）。
 * 来自更新版本客户端的 body（v 更大）→ 读不懂就跳过，别写坏数据。
 * @returns {boolean} 是否应用了
 */
function applyConfigDoc(doc) {
  if (!doc || !doc.body) return false;
  if (configPending()) return false;

  const body = doc.body;
  if ((Number(body.v) || 0) > CONFIG_VER) return false;

  applyingRemote = true;
  try {
    if (body.profile) {
      wx.setStorageSync(K_PROFILE, {
        level: body.profile.level || 'some',
        days: Number(body.profile.days) || 3,
        place: body.profile.place === 'home' ? 'home' : 'gym',
        programId: body.profile.programId || 'auto'
      });
    } else {
      wx.removeStorageSync(K_PROFILE);
    }

    wx.setStorageSync(K_SWAPS, body.swaps || {});
    wx.setStorageSync(K_CUSTOM, Array.isArray(body.customPrograms) ? body.customPrograms : []);

    if (body.onboarded) wx.setStorageSync(K_ONBOARDED, true);
    else wx.removeStorageSync(K_ONBOARDED);

    // 训练日队列不随配置同步：拿到配置后重新推导
    const prof = profile();
    if (prof) applyProgram(prof);
    else wx.removeStorageSync(K_PLAN);
  } finally {
    applyingRemote = false;
  }

  wx.setStorageSync(K_CONFIG_META, { updatedAt: doc.updatedAt || '', dirty: false });
  return true;
}

/* ---------------- 身体指标 ---------------- */

/**
 * 身体指标（P5）。
 *
 * 服务端 `metrics` 表和同步协议早就有（kind / date / value / unit / note / done / updatedAt），
 * 前端这边只做「录入 + 看趋势」：一天一个值，同一天再填就是改。
 *
 * 为什么只放 4 种：体重、体脂、腰围、静息心率 —— 正好覆盖开发计划 M2 说的
 * 「体重 / 体脂 / 围度 / 静息心率」，其余（胸围臀围臂围睡眠）字段留着，等真要用再加。
 */
const METRIC_KINDS = [
  { kind: 'weight', cn: '体重', en: 'Weight', unit: 'kg', step: 0.1, min: 20, max: 300 },
  { kind: 'bodyfat', cn: '体脂率', en: 'Body Fat', unit: '%', step: 0.1, min: 3, max: 60 },
  { kind: 'waist', cn: '腰围', en: 'Waist', unit: 'cm', step: 0.5, min: 40, max: 200 },
  { kind: 'hrrest', cn: '静息心率', en: 'Resting HR', unit: 'bpm', step: 1, min: 30, max: 150 }
];

const METRIC_BY_KIND = {};
METRIC_KINDS.forEach(function (k) { METRIC_BY_KIND[k.kind] = k; });

function metricKinds() { return METRIC_KINDS.slice(); }

function metricDef(kind) { return METRIC_BY_KIND[kind] || null; }

/** 某天某种指标（不含墓碑）；没有返回 null */
function metricOf(kind, date) {
  const r = S.metric(kind, date || D.today());
  return r && r.done ? r : null;
}

/**
 * 存一个值（同一天同一种覆盖）。超范围直接拒绝，不做静默裁剪 —— 手滑输入 500 公斤
 * 应该当场发现，而不是被「修正」成 300。
 * @returns {object|null} 存下来的行；参数不合法返回 null
 */
function saveMetric(rec) {
  const def = metricDef((rec || {}).kind);
  if (!def) return null;
  const date = rec.date || D.today();
  const v = Number(rec.value);
  if (!isFinite(v) || v < def.min || v > def.max) return null;

  const rounded = Math.round(v / def.step) * def.step;
  const row = {
    kind: def.kind,
    date: date,
    // 0.1 这类步长乘回来会有浮点尾巴（75.1 * 0.1），按步长定小数位收干净
    value: Number(rounded.toFixed(def.step < 1 ? 1 : 0)),
    unit: def.unit,
    note: String(rec.note || '').slice(0, 200),
    done: true
  };
  const saved = S.putMetricLocal(row, syncOn());
  store.touchSets();
  return saved;
}

/** 删掉某天某个指标：同步开着写墓碑，同步关着直接物理删 */
function removeMetric(kind, date) {
  const day = date || D.today();
  const prev = S.metric(kind, day);
  if (!prev || !prev.done) return false;
  if (syncOn()) S.putMetricLocal(Object.assign({}, prev, { done: false }), true);
  else S.removeMetrics([{ kind: kind, date: day }]);
  store.touchSets();
  return true;
}

/**
 * 某个指标的序列（只有有效值，按日期升序）。
 * @param {string} kind
 * @param {{from?:string, to?:string, limit?:number}} [opts]
 */
function metricSeries(kind, opts) {
  const o = opts || {};
  let list = S.metrics().filter(function (r) {
    return r.kind === kind && r.done;
  });
  if (o.from) list = list.filter(function (r) { return r.date >= o.from; });
  if (o.to) list = list.filter(function (r) { return r.date <= o.to; });
  if (o.limit) list = list.slice(-o.limit);
  return list;
}

/** 最近一次记录的该指标，没有返回 null */
function latestMetric(kind) {
  const list = metricSeries(kind);
  return list.length ? list[list.length - 1] : null;
}

/**
 * 和 N 天前比变了多少（找那天或之前最近的一次记录）。
 * @returns {{now:number, before:number, delta:number, days:number, beforeDate:string}|null}
 */
function metricDelta(kind, days) {
  const now = latestMetric(kind);
  if (!now) return null;
  const cutoff = D.shift(now.date, -(days || 30));
  const earlier = metricSeries(kind, { to: cutoff });
  if (!earlier.length) return null;
  const before = earlier[earlier.length - 1];
  return {
    now: now.value,
    before: before.value,
    delta: Math.round((now.value - before.value) * 10) / 10,
    days: days || 30,
    beforeDate: before.date
  };
}

/* ---------------- 同步层接口（sync.js 只用这几个，页面不用） ---------------- */

/** 待上传总数：记录 + 训练 + 配置算 1 */
function syncPending() {
  return S.pendingCount() + (configPending() ? 1 : 0);
}

/** 取一批待上传：{ rows, workouts, sent, config }，config 没改动时为 null */
function syncPullBatch(limit) {
  const b = S.dirtyBatch(limit || 500);
  b.config = takeConfig();
  return b;
}

/** 服务端已确认：清队列（只清发出之后没再改过的行） */
function syncAck(batch, rejectedIds) {
  const b = batch || {};
  S.ack(b.sent || {}, rejectedIds || []);
  if (b.config) ackConfig(b.config.updatedAt);
}

/** 把服务端 rejected 映射成队列 id（id 规则在 storage 里维护，别在这儿复制） */
function rejectedIds(batch, rejected) {
  return S.rejectedIds(batch, rejected);
}

/** 应用服务端下发的结果；返回应用了多少条（配置算 1） */
function syncApply(pulled) {
  if (!pulled) return 0;
  let n = 0;
  if (pulled.sets && pulled.sets.length) n += S.applyRemote(pulled.sets);
  if (pulled.workouts && pulled.workouts.length) n += S.applyRemoteWorkouts(pulled.workouts);
  if (pulled.metrics && pulled.metrics.length) n += S.applyRemoteMetrics(pulled.metrics);
  if (pulled.customExercises && pulled.customExercises.length) {
    n += S.applyRemoteExercises(pulled.customExercises);
  }
  if (pulled.config) n += applyConfigDoc(pulled.config) ? 1 : 0;
  return n;
}

/** 第一次接上后端：把本地全部真实记录和配置排进上传队列 */
function syncMarkAll() {
  S.markAllDirty();
  const meta = configMeta();
  if (!meta.updatedAt) meta.updatedAt = S.stamp();
  meta.dirty = true;
  wx.setStorageSync(K_CONFIG_META, meta);
}

/** 有本地改动时通知（组记录 / 训练 / 配置都会触发） */
function onDirty(fn) {
  S.onDirty(fn);
  configListeners.push(fn);
}

/** 把模板里的动作 id 展开成完整动作，并应用换过的动作 */
function decorate(p) {
  const sw = swaps();
  return {
    key: p.key,
    type: p.type,
    name: p.name,
    en: p.en,
    items: p.items.map(function (it, i) {
      const altId = sw[p.key + ':' + i];
      const useAlt = !!(altId && CAT.find(altId));
      const exId = useAlt ? altId : it.exId;
      // 兜底 part 给空串而不是 'legs'：查不到的动作不该被静默算成腿，污染部位统计
      const ex = CAT.find(exId) || { cn: exId, en: '', part: '', unit: 'kg' };
      const origin = CAT.find(it.exId);

      return {
        exId: exId,
        cn: ex.cn,
        en: ex.en,
        part: ex.part,
        tips: ex.tips || '',
        slot: i,
        sets: it.sets,
        reps: it.reps,
        weight: useAlt ? P.initialWeight(exId, (profile() || {}).level) : it.weight,
        unit: ex.unit || it.unit || 'kg',
        swapped: useAlt,
        originCn: useAlt && origin ? origin.cn : ''
      };
    })
  };
}

/** 本周七天（周一 → 周日） */
function weekDates(date) {
  const base = date || D.today();
  const wd = D.weekdayMon(new Date(base + 'T00:00:00'));
  const monday = D.shift(base, -wd);
  const out = [];
  for (let i = 0; i < 7; i++) out.push(D.shift(monday, i));
  return out;
}

/* ---------------- 训练日轮转 ---------------- */

/** 当前计划签名（设置/方案变了，旧记录就不再对应现在的 A/B/C） */
function planSig() {
  const p = profile() || {};
  return P.planSig(p) + '|' + (p.programId || 'auto');
}

/**
 * 某一天的记录属于哪个训练日。
 * 优先看记录里的 planKey；老记录没带 planKey 的，用「做过哪些动作」反推最像的那个。
 */
function dayKey(rows) {
  const cnt = {};
  rows.forEach(function (s) {
    if (!s.planKey) return;
    cnt[s.planKey] = (cnt[s.planKey] || 0) + 1;
  });
  const keys = Object.keys(cnt);
  if (keys.length) {
    return keys.sort(function (a, b) { return cnt[b] - cnt[a]; })[0];
  }

  const list = plans();
  const exIds = {};
  rows.forEach(function (s) { exIds[s.exId] = true; });
  let best = '';
  let bestHit = 0;
  list.forEach(function (p) {
    const hit = p.items.filter(function (it) { return exIds[it.exId]; }).length;
    if (hit > bestHit) { bestHit = hit; best = p.key; }
  });
  return best;
}

/**
 * 已经练过的训练日序列（按日期升序），只认当前计划签名、且日期早于 beforeDate 的记录。
 */
function sessionDays(beforeDate) {
  const sig = planSig();
  const byDate = {};
  allSets().forEach(function (s) {
    if (!s.done) return;
    if (s.sig && s.sig !== sig) return;          // 改设置之前的老记录，不参与轮转
    if (beforeDate && s.date >= beforeDate) return;
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  });
  return Object.keys(byDate).sort().map(function (d) {
    return { date: d, key: dayKey(byDate[d]) };
  });
}

/**
 * 下一个该练的训练日。
 *
 * 关键是「接着上一次练的那天往下排」，不是「本周练了几次 % 模板数」——
 * 后者只要一周没练满目标次数，就会永远在 A/B 之间打转，C 一辈子轮不到。
 */
function nextKey(beforeDate) {
  const list = plans();
  if (!list.length) return null;

  const days = sessionDays(beforeDate);
  if (!days.length) return list[0];

  const lastKey = days[days.length - 1].key;
  const idx = list.findIndex(function (p) { return p.key === lastKey; });
  if (idx < 0) return list[0];
  return list[(idx + 1) % list.length];
}

/**
 * 今天该练什么。
 *
 *   今天已经练过 → 继续当天那个训练日
 *   否则 → 接着上一次训练往下排（跨周连续，不会漏掉某个训练日）
 *   本周达标 → finished，但仍给下一个模板，允许加练
 *
 * @returns {{ finished, resumed, plan, week:{done,target}, today:{doneEx,totalEx,complete,rows}, list }}
 */
function todaySession(date) {
  const list = plans();
  const prof = profile() || {};
  const target = Number(prof.days) || list.length || 3;
  const today = date || D.today();
  const week = weekDates(today);

  const rows = allSets().filter(function (s) { return s.done; });
  const todayRows = rows.filter(function (s) { return s.date === today; });
  const hasToday = todayRows.length > 0;

  // 本周进度：按「练了几天」算，一天练两次也只算一次
  const daySet = {};
  rows.forEach(function (s) {
    if (week.indexOf(s.date) >= 0) daySet[s.date] = true;
  });
  const done = Object.keys(daySet).length;
  const finished = done >= target;

  // 今天练的是哪个训练日：先认记录，认不出来再接着排队
  let raw = null;
  if (hasToday) {
    const k = dayKey(todayRows);
    raw = list.filter(function (p) { return p.key === k; })[0] || null;
  }
  if (!raw) raw = nextKey(today);
  if (!raw && list.length) raw = list[0];

  const plan = raw ? decorate(raw) : null;

  // 今天做到哪了：按当前训练日的动作逐个对，换过动作也算
  const doneEx = {};
  todayRows.forEach(function (s) { doneEx[s.exId] = true; });
  const totalEx = plan ? plan.items.length : 0;
  const hitEx = plan
    ? plan.items.filter(function (it) { return doneEx[it.exId]; }).length
    : 0;

  return {
    finished: finished,
    resumed: hasToday,
    plan: plan,
    week: { done: done, target: target },
    today: {
      doneEx: hitEx,
      totalEx: totalEx,
      complete: hasToday && totalEx > 0 && hitEx >= totalEx,
      rows: todayRows.length
    },
    list: list
  };
}

/* ---------------- 记录：基础 ---------------- */

/** 同步是否打开：决定取消 / 清空是写墓碑还是直接删 */
function syncOn() {
  return CFG.syncEnabled();
}

/** 全部有效组记录（不含墓碑，含热身组）。返回的是缓存，只读不改 */
function allSets() {
  return S.live();
}

/** 正式组：上次成绩、加重建议、PR、吨数、部位分布都只看正式组，热身组不算 */
function isWork(s) {
  return !s.warmup;
}

/** 某天的记录（默认今天） */
function todaySets(date) {
  const day = date || D.today();
  return allSets().filter(function (s) { return s.date === day; });
}

/** 有没有练过（判断首页空态用） */
function hasAnyRecord() {
  return allSets().length > 0;
}

function lastCompletedAt(rows) {
  let last = null;
  rows.forEach(function (s) {
    if (s.completedAt && (!last || s.completedAt > last)) last = s.completedAt;
  });
  return last;
}

/** v 有值就用 v，否则用 fallback；都没有给 null（写进记录的可空字段） */
function opt(v, fallback) {
  if (v !== undefined && v !== null) return v;
  return fallback === undefined ? null : fallback;
}

/* ---------------- 训练日期（跨零点） ---------------- */

const CARRY_HOURS = 3;

/**
 * 当前应该记在哪一天（模块设计 §6.5）。
 * 一次训练算在它开始的那天：今天还没练、昨天的训练没点「完成」、
 * 且昨天最后一组在 3 小时以内 → 仍然记在昨天。
 * @param {number} [nowMs] 测试用
 */
function trainingDate(nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const today = D.dateStr(new Date(now));
  if (todaySets(today).length) return today;

  const y = D.shift(today, -1);
  const w = S.workout(y);
  if (!w || !w.done || w.finishedAt) return today;

  const last = lastCompletedAt(todaySets(y));
  if (last && now - Date.parse(last) <= CARRY_HOURS * 3600 * 1000) return y;
  return today;
}

/* ---------------- 一次训练 ---------------- */

/** 某天的训练（已被取消的不返回） */
function workout(date) {
  const w = S.workout(date || trainingDate());
  return w && w.done ? w : null;
}

/**
 * 保证某天有一条有效的训练记录。当天第一组完成时调用。
 * 被取消过的训练（当天组全部取消）在重新完成一组时恢复。
 */
function ensureWorkout(day, set) {
  const w = S.workout(day);
  if (w && w.done) {
    // 补记的组可能比现有的开始时刻还早
    if (set.completedAt && set.completedAt < w.startedAt) {
      return S.putWorkoutLocal(Object.assign({}, w, { startedAt: set.completedAt }), syncOn());
    }
    return w;
  }

  const p = set.planKey ? plans().filter(function (x) { return x.key === set.planKey; })[0] : null;
  const prof = profile() || {};
  const startedAt = w && w.startedAt && w.startedAt < set.completedAt ? w.startedAt : set.completedAt;
  return S.putWorkoutLocal({
    date: day,
    planKey: set.planKey || '',
    planName: p ? p.name : '',
    sig: set.sig,
    programId: prof.programId || 'auto',
    startedAt: startedAt,
    finishedAt: w ? opt(w.finishedAt) : null,
    feel: w ? opt(w.feel) : null,
    note: w ? (w.note || '') : '',
    done: true
  }, syncOn());
}

/** 当天的组全部取消后，这次训练也随之取消 */
function dropWorkout(day) {
  const w = S.workout(day);
  if (!w) return;
  if (syncOn()) {
    if (w.done) S.putWorkoutLocal(Object.assign({}, w, { done: false }), true);
  } else {
    S.removeWorkouts([day]);
  }
}

/**
 * 点「完成训练」。
 * @returns {boolean} 当天一组都没有时返回 false，页面提示「还没记录任何一组」
 */
function finishWorkout(date) {
  const day = date || trainingDate();
  const rows = todaySets(day);
  if (!rows.length) return false;

  const first = rows.reduce(function (a, b) {
    return (b.completedAt || '') < (a.completedAt || '') ? b : a;
  });
  const w = ensureWorkout(day, first);
  const now = new Date().toISOString();
  const fin = w.finishedAt && w.finishedAt > now ? w.finishedAt : now;
  S.putWorkoutLocal(Object.assign({}, w, { finishedAt: fin }), syncOn());
  store.touchSets();
  return true;
}

/** 训练时长（分钟）：开始 → 点完成（没点就到最后一组）+ 第一组本身约 1 分钟。算不出返回 null */
function workoutMinutes(w, rows) {
  if (!w || !w.startedAt) return null;
  const end = w.finishedAt || lastCompletedAt(rows);
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(w.startedAt);
  if (!(ms >= 0)) return null;
  return Math.round(ms / 60000) + 1;
}

/* ---------------- 记录：写 ---------------- */

/** 没传 planKey 时这一组归哪个训练日：当天已有训练就跟着它，否则取今天该练的 */
function planKeyFor(day) {
  const w = S.workout(day);
  if (w && w.done) return w.planKey || '';
  const s = todaySession(day);
  return s.plan ? s.plan.key : '';
}

/**
 * 完成一组，或修改已完成的组（同一天、同动作、同组号覆盖）。
 *
 * 必填：date exId setNo weight reps unit
 * 可选：warmup slot targetWeight targetReps targetSets planKey exCn part
 *
 * 完成时刻只在第一次完成时写，之后改数字不变。
 * 当天第一组时同时创建「一次训练」。
 */
function saveSet(rec) {
  const id = S.rowId(rec);
  const prev = S.get(id);
  const keep = !!(prev && prev.done);     // 已完成的组再保存 = 修改
  const ex = CAT.find(rec.exId) || {};
  const day = rec.date;

  let planKey;
  if (rec.planKey !== undefined) planKey = rec.planKey || '';
  else if (keep) planKey = prev.planKey || '';
  else planKey = planKeyFor(day);

  const row = {
    date: day,
    exId: rec.exId,
    exCn: rec.exCn || (keep && prev.exCn) || ex.cn || rec.exId,
    part: rec.part || (keep && prev.part) || ex.part || '',
    planKey: planKey,
    sig: keep && prev.sig ? prev.sig : planSig(),
    setNo: Number(rec.setNo),
    weight: Number(rec.weight) || 0,
    reps: Number(rec.reps) || 0,
    unit: rec.unit || ex.unit || 'kg',
    warmup: !!opt(rec.warmup, keep ? prev.warmup : false),
    slot: opt(rec.slot, keep ? prev.slot : null),
    rir: opt(rec.rir, keep ? prev.rir : null),
    assist: opt(rec.assist, keep ? prev.assist : null),
    targetWeight: opt(rec.targetWeight, keep ? prev.targetWeight : null),
    targetReps: opt(rec.targetReps, keep ? prev.targetReps : null),
    targetSets: opt(rec.targetSets, keep ? prev.targetSets : null),
    completedAt: keep && prev.completedAt ? prev.completedAt : (rec.completedAt || S.stamp()),
    done: true
  };

  const saved = S.putLocal(row, syncOn());
  ensureWorkout(day, saved);
  store.touchSets();
  return saved;
}

/**
 * 取消一组（修复：以前取消勾选什么都不写，统计仍算这一组）。
 * 同步打开时写墓碑通知其他设备；纯本地时直接删除。
 * 当天最后一组被取消 → 这次训练也取消。
 * @returns {boolean} 这一组本来就不存在时返回 false
 */
function uncheckSet(rec) {
  const id = S.rowId(rec);
  const prev = S.get(id);
  if (!prev || !prev.done) return false;

  if (syncOn()) S.putLocal(Object.assign({}, prev, { done: false }), true);
  else S.remove([id]);

  if (!todaySets(rec.date).length) dropWorkout(rec.date);
  store.touchSets();
  return true;
}

/** 这个动作某天下一组的组号 */
function nextSetNo(exId, date) {
  const day = date || trainingDate();
  return todaySets(day).reduce(function (m, s) {
    return s.exId === exId && s.setNo > m ? s.setNo : m;
  }, 0) + 1;
}

/* ---------------- 上一次、最好成绩 ---------------- */

/** 某动作在 beforeDate 之前最后一次训练那天的正式组；没练过返回 null */
function lastDayWork(exId, beforeDate) {
  const rows = allSets().filter(function (s) {
    return s.exId === exId && s.date < beforeDate && isWork(s);
  });
  if (!rows.length) return null;
  const lastDay = rows.reduce(function (a, b) { return a.date > b.date ? a : b; }).date;
  return { date: lastDay, rows: rows.filter(function (s) { return s.date === lastDay; }) };
}

/** 最好的一组：负重看重量（同重量看次数），自重 / 计时看次数 / 秒数 */
function bestSet(rows) {
  return rows.reduce(function (a, b) {
    if (b.unit === 'kg') {
      if (b.weight !== a.weight) return b.weight > a.weight ? b : a;
      return b.reps > a.reps ? b : a;
    }
    return b.reps > a.reps ? b : a;
  });
}

/* ---------------- 重量建议（渐进超负荷） ---------------- */

/**
 * 建议今天这个动作练多重（来自计划的动作）。
 *
 * 规则：上次同一动作，「组数做够」且「每组次数都达标」→ 加一档；否则保持。
 *   下肢 +5kg，其它 +2.5kg（取 2.5 的整数倍）
 *
 * 「够不够、达没达标」拿那天记录里存的目标（targetSets / targetReps）比，
 * 不拿当前计划比——换了方案，历史判断不能跟着变。老记录没存目标时退回用传入的计划值。
 *
 * 专门防住的坑：
 *   1) 只勾了 1 组就退出，不能算「全部完成」——必须组数也够；
 *   2) 基准取当天最重的一组，用户中途减重不该把下次的起点拉低；
 *   3) 热身组不算，否则热身的轻重量会把基准拉低。
 *
 * @returns {{weight, reason:'first'|'up'|'keep', prev, step, date, sets, enoughSets}}
 */
function suggestWeight(exId, planReps, planSets, date) {
  const day = date || D.today();
  const ex = CAT.find(exId);   // 自建动作也要能算加重档位（腿 = +5kg）

  const rows = allSets().filter(function (s) {
    return isWork(s) && s.exId === exId && s.date < day && s.unit === 'kg' && s.weight > 0;
  });
  if (!rows.length) {
    return { weight: 0, reason: 'first', prev: 0, step: 0, date: '', sets: 0, enoughSets: false };
  }

  const lastDay = rows.reduce(function (a, b) { return a.date > b.date ? a : b; }).date;
  const lastRows = rows.filter(function (s) { return s.date === lastDay; });

  const base = lastRows.reduce(function (a, b) {
    return b.weight > a.weight ? b : a;
  }).weight;

  const savedSets = lastRows.map(function (s) { return s.targetSets; }).filter(function (x) { return x > 0; })[0];
  const needSets = Number(savedSets || planSets) || 0;
  const enoughSets = lastRows.length >= needSets;
  const allHit = lastRows.every(function (s) {
    return s.reps >= (Number(s.targetReps || planReps) || 0);
  });
  const step = (ex && ex.part === 'legs') ? 5 : 2.5;

  if (enoughSets && allHit) {
    return {
      weight: P.roundWeight(base + step),
      reason: 'up',
      prev: base,
      step: step,
      date: lastDay,
      sets: lastRows.length,
      enoughSets: true
    };
  }
  return {
    weight: base,
    reason: 'keep',
    prev: base,
    step: 0,
    date: lastDay,
    sets: lastRows.length,
    enoughSets: enoughSets
  };
}

/** 上次练这个动作是什么时候、最好的一组多少（热身组不算） */
function lastRecord(exId, beforeDate) {
  const before = beforeDate || D.today();
  const last = lastDayWork(exId, before);
  if (!last) return null;
  const best = bestSet(last.rows);
  return {
    date: last.date,
    weight: best.weight,
    reps: best.reps,
    sets: last.rows.length,
    daysAgo: D.diffDays(before, last.date)
  };
}

/** 某动作在今天之前的最大重量（判断 PR 用，热身组不算）；没练过返回 0 */
function maxWeightBefore(exId, beforeDate) {
  const before = beforeDate || D.today();
  let max = 0;
  allSets().forEach(function (s) {
    if (s.exId !== exId || s.date >= before || !isWork(s)) return;
    if (s.unit !== 'kg' || !(s.weight > max)) return;
    max = s.weight;
  });
  return max;
}

function lastText(lr, unit) {
  if (!lr) return '第一次做这个动作';
  if (unit === 'sec') return '上次 ' + lr.reps + ' 秒 × ' + lr.sets + ' 组';
  if (unit === 'bw') return '上次 ' + lr.reps + ' 次 × ' + lr.sets + ' 组';
  return '上次 ' + lr.weight + ' kg × ' + lr.reps + ' × ' + lr.sets + ' 组';
}

/** 没有历史时的默认次数：按用户水平 */
function defaultReps(unit) {
  const lv = P.LEVEL[(profile() || {}).level] || P.LEVEL.some;
  if (unit === 'sec') return lv.sec;
  if (unit === 'bw') return lv.repsBw;
  return lv.repsKg;
}

/**
 * 选中一个动作时的预填（模块设计 §5.5）。
 *
 * 来自计划：按 suggestWeight 的规则，「上次做满了」直接预填加一档。
 * 自己选的：预填上次最好一组；上次正式组每组都 ≥ 10 次（计时 ≥ 60 秒）时
 *           只提示「可以试试加」，不自动加。
 */
function exercisePrefill(exId, date) {
  const day = date || trainingDate();
  const ex = CAT.find(exId) || { unit: 'kg', part: '' };
  const unit = ex.unit || 'kg';
  const sess = todaySession(day);
  const item = sess.plan ? sess.plan.items.filter(function (it) { return it.exId === exId; })[0] : null;

  const maxBefore = maxWeightBefore(exId, day);
  const today = todaySets(day)
    .filter(function (s) { return s.exId === exId; })
    .sort(function (a, b) { return a.setNo - b.setNo; });
  const lr = lastRecord(exId, day);

  const out = {
    exId: exId,
    weight: 0,
    reps: 0,
    sets: 3,
    reason: 'first',
    step: 0,
    lastText: lastText(lr, unit),
    hintText: '',
    nextSetNo: nextSetNo(exId, day),
    todaySets: today.map(function (s) { return setItem(s, maxBefore); }),
    maxBefore: maxBefore
  };

  if (item && unit === 'kg') {
    const sug = suggestWeight(exId, item.reps, item.sets, day);
    out.weight = sug.reason === 'first' ? item.weight : sug.weight;
    out.reps = item.reps;
    out.sets = item.sets;
    out.reason = sug.reason;
    out.step = sug.step;
    if (sug.reason === 'up') out.hintText = '全部完成，今天加 ' + sug.step + ' kg';
    else if (sug.reason === 'keep') {
      out.hintText = sug.enoughSets
        ? '上次没做满，今天保持'
        : '上次只做了 ' + sug.sets + ' 组（计划 ' + item.sets + ' 组），今天保持';
    }
    return out;
  }

  if (item) {
    // 计划里的自重 / 计时动作：没有重量可加，次数按计划
    out.reps = item.reps;
    out.sets = item.sets;
    out.reason = lr ? 'keep' : 'first';
    return out;
  }

  const last = lastDayWork(exId, day);
  if (!last) {
    out.weight = unit === 'kg' ? initialWeight(exId) : 0;
    out.reps = defaultReps(unit);
    return out;
  }

  const best = bestSet(last.rows);
  out.weight = unit === 'kg' ? best.weight : 0;
  out.reps = best.reps;
  out.sets = last.rows.length;
  out.reason = 'keep';

  const high = last.rows.every(function (s) { return s.reps >= (unit === 'sec' ? 60 : 10); });
  if (unit === 'kg' && high) {
    out.reason = 'hint';
    out.step = ex.part === 'legs' ? 5 : 2.5;
    out.hintText = '上次每组都做到 10 次以上，可以试试加 ' + out.step + ' kg';
  }
  return out;
}

/* ---------------- 今天的训练全貌 ---------------- */

function setItem(s, maxBefore) {
  return {
    setNo: s.setNo,
    weight: s.weight,
    reps: s.reps,
    unit: s.unit,
    warmup: !!s.warmup,
    done: true,
    completedAt: s.completedAt || null,
    pr: isWork(s) && s.unit === 'kg' && s.weight > 0 && maxBefore > 0 && s.weight > maxBefore
  };
}

function makeBlock(exId, planItem, rows, firstAt, day) {
  // 兜底优先用行里冗余的 exCn：动作已删/是自建时，exId 查不到也得显示中文名而不是 u- 开头的 id
  const ex = CAT.find(exId) ||
    { cn: (rows[0] && rows[0].exCn) || exId, en: '', part: '', unit: 'kg', tips: '' };
  const maxBefore = rows.length ? maxWeightBefore(exId, day) : 0;
  const work = rows.filter(isWork).length;

  let status = 'todo';
  if (rows.length) status = planItem ? (work >= planItem.sets ? 'done' : 'doing') : 'done';

  return {
    exId: exId,
    cn: ex.cn,
    en: ex.en || '',
    part: ex.part,
    partCn: EX.PART_CN[ex.part] || '',
    unit: ex.unit || 'kg',
    tips: ex.tips || '',
    source: planItem ? 'plan' : 'manual',
    slot: planItem ? planItem.slot : null,
    plan: planItem ? { sets: planItem.sets, reps: planItem.reps, weight: planItem.weight } : null,
    sets: rows.slice()
      .sort(function (a, b) { return a.setNo - b.setNo; })
      .map(function (s) { return setItem(s, maxBefore); }),
    firstAt: firstAt,
    status: status
  };
}

/**
 * 今天的训练（模块设计 §5.1 / §5.2，前端接口 §3.3）。
 *
 * exercises 的顺序：已练的按「第一组完成时刻」在前；
 * 计划里还没练的在后，保持计划顺序。
 */
function todayWorkout(date) {
  const day = date || trainingDate();
  const sess = todaySession(day);
  const plan = sess.plan;
  const rows = todaySets(day);

  // 按动作分组，记下每个动作第一组的完成时刻
  const groups = {};
  const order = [];
  rows.forEach(function (s, i) {
    let g = groups[s.exId];
    if (!g) {
      g = groups[s.exId] = { rows: [], first: null, idx: i };
      order.push(s.exId);
    }
    g.rows.push(s);
    if (s.completedAt && (!g.first || s.completedAt < g.first)) g.first = s.completedAt;
  });
  order.sort(function (a, b) {
    const fa = groups[a].first;
    const fb = groups[b].first;
    if (fa && fb && fa !== fb) return fa < fb ? -1 : 1;
    if (fa && !fb) return -1;
    if (!fa && fb) return 1;
    return groups[a].idx - groups[b].idx;     // 老数据没有完成时刻：按记录先后
  });

  const planItem = {};
  const planOrder = [];
  (plan ? plan.items : []).forEach(function (it) {
    if (planItem[it.exId]) return;            // 同一动作在计划里出现两次，只算第一个位置
    planItem[it.exId] = it;
    planOrder.push(it.exId);
  });

  const exercises = order.map(function (id) {
    return makeBlock(id, planItem[id], groups[id].rows, groups[id].first, day);
  });
  planOrder.forEach(function (id) {
    if (!groups[id]) exercises.push(makeBlock(id, planItem[id], [], null, day));
  });

  // 最后练的那个动作：完成时刻最晚的一组
  let lastEx = null;
  let lastAt = '';
  rows.forEach(function (s) {
    if ((s.completedAt || '') >= lastAt) { lastAt = s.completedAt || ''; lastEx = s.exId; }
  });

  let current = lastEx;
  if (plan) {
    const todo = exercises.filter(function (b) { return b.source === 'plan' && b.status === 'todo'; })[0];
    if (todo) current = todo.exId;
  }

  const w = rows.length ? S.workout(day) : null;
  let status = 'idle';
  if (rows.length) status = w && w.done && w.finishedAt ? 'finished' : 'active';

  const work = rows.filter(isWork);

  return {
    date: day,
    mode: plan ? 'plan' : 'free',
    plan: plan ? { key: plan.key, name: plan.name, en: plan.en } : null,
    status: status,
    startedAt: w && w.done ? w.startedAt : null,
    finishedAt: w && w.done ? opt(w.finishedAt) : null,
    minutes: w && w.done ? workoutMinutes(w, rows) : null,
    exercises: exercises,
    current: current,
    totals: {
      sets: work.length,
      exercises: order.length,
      ton: V.toTon(V.totalVolume(work))
    },
    week: { done: sess.week.done, target: sess.week.target, finished: sess.finished }
  };
}

/**
 * 选动作面板（前端接口 §3.5）。
 * @param {{date?, place?, part?, keyword?}} opts place 默认用户设置的场所，'all' 不过滤
 */
function pickableExercises(opts) {
  const o = opts || {};
  const day = o.date || trainingDate();
  const sess = todaySession(day);

  const doneToday = {};
  todaySets(day).forEach(function (s) { doneToday[s.exId] = true; });

  const from = D.shift(day, -28);
  const recent = {};
  allSets().forEach(function (s) {
    if (s.date >= from && s.date < day) recent[s.exId] = true;
  });

  const seen = {};
  const recommended = (sess.plan ? sess.plan.items : [])
    .filter(function (it) {
      if (seen[it.exId] || doneToday[it.exId]) return false;
      seen[it.exId] = true;
      return true;
    })
    .map(function (it) {
      return {
        exId: it.exId, cn: it.cn, part: it.part, partCn: EX.PART_CN[it.part] || '',
        unit: it.unit, slot: it.slot, doneToday: false
      };
    });

  const place = o.place || (profile() || {}).place || 'gym';
  const kw = String(o.keyword || '').trim().toLowerCase();
  const matchKw = function (e) {
    if (!kw) return true;
    return e.cn.toLowerCase().indexOf(kw) >= 0 ||
      String(e.en || '').toLowerCase().indexOf(kw) >= 0;
  };
  const matchPart = function (e) { return !o.part || e.part === o.part; };

  // 「我的动作」整组置顶：自建动作挂在任意部位下，混进部位分组会找不到。
  // 场所过滤显式放行自建动作——不能靠 place 取巧（写成 'all' 会被等值比较过滤掉）。
  const mine = CAT.custom()
    .filter(function (e) { return matchPart(e) && matchKw(e); })
    .map(function (e) {
      return {
        exId: e.id, cn: e.cn, en: e.en || '', unit: e.unit, place: e.place,
        doneToday: !!doneToday[e.id], recent: !!recent[e.id], custom: true
      };
    });

  const list = CAT.list().filter(function (e) {
    if (place !== 'all' && e.place !== place) return false;
    if (!matchPart(e)) return false;
    return matchKw(e);
  });

  const groups = TERRAIN_KEYS.map(function (k) {
    return {
      part: k,
      partCn: EX.PART_CN[k],
      // 部位分组排除自建动作（否则同一个动作在「我的动作」和部位分组里各出现一次）。
      // hot 在前：服务端已按 hot desc,id 下发，这里再稳定排一次，包内快照也能吃上。
      items: list.filter(function (e) { return e.part === k && !e.custom; })
        .sort(function (a, b) { return (b.hot ? 1 : 0) - (a.hot ? 1 : 0); })
        .map(function (e) {
          return {
            exId: e.id, cn: e.cn, en: e.en || '', unit: e.unit, place: e.place,
            doneToday: !!doneToday[e.id], recent: !!recent[e.id]
          };
        })
    };
  }).filter(function (g) { return g.items.length; });

  return { recommended: recommended, mine: mine, groups: groups };
}

/* ---------------- 示例数据 ---------------- */

/**
 * 造一份示例记录。只在用户主动点「先看看长什么样」时调用。
 * 按用户自己的计划生成，所以看起来就是他练的。示例数据带 demo 标记，永不上传。
 *
 * 已经练过的用户不给覆盖 —— 示例数据把真实记录冲掉是不可接受的。
 * @returns {number} 生成的条数；-1 表示已有真实记录，没动
 */
function loadDemo() {
  const list = plans();
  const prof = profile() || {};
  if (!list.length) return 0;
  if (hasAnyRecord()) return -1;
  const rows = P.makeDemoSets(list, Number(prof.days) || list.length);
  S.putMany(rows);

  // 每个示例训练日配一条「一次训练」，战报和统计才有时长
  const byDay = {};
  rows.forEach(function (r) {
    const d = byDay[r.date] || (byDay[r.date] = { first: r, last: r });
    if (r.completedAt < d.first.completedAt) d.first = r;
    if (r.completedAt > d.last.completedAt) d.last = r;
  });
  S.putWorkouts(Object.keys(byDay).map(function (day) {
    const d = byDay[day];
    const p = list.filter(function (x) { return x.key === d.first.planKey; })[0];
    return {
      date: day, planKey: d.first.planKey, planName: p ? p.name : '',
      sig: planSig(), programId: prof.programId || 'auto',
      startedAt: d.first.completedAt, finishedAt: d.last.completedAt,
      feel: null, note: '', done: true, demo: true, updatedAt: S.LEGACY_STAMP
    };
  }));

  store.touchSets();
  return rows.length;
}

/**
 * 清空训练记录（计划设置保留）。
 * 同步打开时，真实记录写墓碑，其他设备也会一起清掉；示例数据直接删。
 */
function clearSets() {
  if (syncOn()) {
    S.rows().forEach(function (r) {
      if (r.demo) S.remove([r.id]);
      else if (r.done) S.putLocal(Object.assign({}, r, { done: false }), true);
    });
    S.workouts().forEach(function (w) {
      if (w.demo) S.removeWorkouts([w.date]);
      else if (w.done) S.putWorkoutLocal(Object.assign({}, w, { done: false }), true);
    });
  } else {
    S.removeAll();
  }
  store.touchSets();
}

/** 彻底清空本机数据（重走引导用，调试也有用） */
function resetAll() {
  wx.removeStorageSync(K_ONBOARDED);
  wx.removeStorageSync(K_PROFILE);
  wx.removeStorageSync(K_PLAN);
  wx.removeStorageSync(K_SWAPS);
  wx.removeStorageSync(K_CUSTOM);
  wx.removeStorageSync(K_CONFIG_META);

  // 同步身份与游标也要清：只清数据不清游标的话，客户端会以为自己已经
  // 拿到了服务端最新状态，重新登录后一条也不会重新拉 —— 看起来就是「数据全没了」。
  // 这两个键由 sync.js 拥有，但清空本机数据时必须一起清掉。
  wx.removeStorageSync('lj.auth');
  wx.removeStorageSync('lj.sync.cursor');

  S.removeAll();

  // 动作库：官方清单缓存在 lj.catalog，自建在 lj.customEx，详情缓存在 lj.catalog.detail.*。
  // 不清的话「清空重来」之后自建动作还会冒出来，而记录已经没了。
  CAT.reset();
}

/* ---------------- 训练战报 ---------------- */

/**
 * 找今天的 PR（只算负重动作的正式组）。
 * 第一次做的动作不算 PR —— 否则头一个月什么都没干，天天「新纪录」，就不值钱了。
 */
function detectPRs(date) {
  const day = date || D.today();
  const rows = todaySets(day).filter(isWork);

  const cur = {};
  rows.forEach(function (s) {
    if (s.unit !== 'kg' || !(s.weight > 0)) return;
    if (!cur[s.exId] || s.weight > cur[s.exId].weight) {
      cur[s.exId] = { cn: s.exCn, weight: s.weight };
    }
  });

  const hist = {};
  allSets().forEach(function (s) {
    if (s.date >= day || !isWork(s)) return;
    if (s.unit !== 'kg' || !(s.weight > 0)) return;
    if (!hist[s.exId] || s.weight > hist[s.exId]) hist[s.exId] = s.weight;
  });

  const prs = [];
  Object.keys(cur).forEach(function (id) {
    const old = hist[id];
    if (old === undefined) return;
    if (cur[id].weight > old) {
      prs.push({
        exId: id,
        cn: cur[id].cn,
        weight: cur[id].weight,
        prev: old,
        delta: Math.round((cur[id].weight - old) * 10) / 10
      });
    }
  });

  return prs.sort(function (a, b) { return b.delta - a.delta; });
}

/** 今天这次训练的汇总，给战报页用。组数、吨数、部位分布只算正式组 */
function todayReport(date) {
  const day = date || D.today();
  const rows = todaySets(day);
  const work = rows.filter(isWork);

  const exSeen = {};
  rows.forEach(function (s) { exSeen[s.exId] = true; });

  const partSets = {};
  work.forEach(function (s) {
    partSets[s.part] = (partSets[s.part] || 0) + 1;
  });
  const totalSets = work.length || 1;
  const parts = Object.keys(partSets).map(function (k) {
    return { key: k, name: EX.PART_CN[k] || k, pct: Math.round(partSets[k] / totalSets * 100) };
  }).sort(function (a, b) { return b.pct - a.pct; });

  // 训练日名称：优先取「一次训练」里存的（方案改名后历史不乱），再从记录的 planKey 找
  const w = S.workout(day);
  const key = (w && w.done && w.planKey) || (rows.length && rows[0].planKey) || '';
  let planName = (w && w.done && w.planName) || '';
  let plannedSets = 0;
  if (key) {
    const p = plans().filter(function (x) { return x.key === key; })[0];
    if (p) {
      if (!planName) planName = p.name;
      plannedSets = p.items.reduce(function (a, it) { return a + it.sets; }, 0);
    }
  }
  if (!planName) planName = '自由训练';

  const volume = V.totalVolume(work);
  const view = todayWorkout(day);

  return {
    date: day,
    planName: planName,
    sets: work.length,
    plannedSets: plannedSets,
    exercises: Object.keys(exSeen).length,
    volume: volume,
    ton: V.toTon(volume),
    minutes: w && w.done ? workoutMinutes(w, rows) : null,
    parts: parts,
    prs: detectPRs(day),
    blocks: view.exercises.filter(function (b) { return b.status !== 'todo'; }),
    week: weeklyProgress(day)
  };
}

/**
 * 力量地形用的部位强度。
 * 固定返回 6 个部位（没练过的记 0），这样多边形形状才稳定，
 * 不会因为某个部位没数据就塌掉一个角。
 */
const TERRAIN_KEYS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];

function partTerrain(y, m) {
  const st = monthlyStats(y, m);
  const map = {};
  st.parts.forEach(function (p) { map[p.key] = p.pct; });

  return TERRAIN_KEYS.map(function (k) {
    const pct = map[k] || 0;
    return { key: k, name: EX.PART_CN[k] || k, pct: pct, trained: pct > 0 };
  });
}

/**
 * 近 n 周的训练量（吨），给柱状图用。
 * 返回从最早到最近：[{ label, ton }]
 */
function weeklyVolume(n) {
  const weeks = Number(n) || 8;
  const wd = D.weekdayMon();
  const thisMonday = D.shift(D.today(), -wd);
  const all = allSets().filter(function (s) { return s.done; });

  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = D.shift(thisMonday, -i * 7);
    const end = D.shift(start, 6);
    const rows = all.filter(function (s) { return s.date >= start && s.date <= end && isWork(s); });
    out.push({
      label: i === 0 ? '本周' : '-' + i + 'w',
      ton: V.toTon(V.totalVolume(rows)),
      sets: rows.length
    });
  }
  return out;
}

/**
 * 全部历史的总览：累计吨数、单次最高、练过多少天。
 * 地形页那三个数字卡要的就是这三个。
 */
function allTimeStats() {
  const all = allSets();

  const byDay = {};
  all.forEach(function (s) {
    if (!byDay[s.date]) byDay[s.date] = [];
    byDay[s.date].push(s);
  });

  const dates = Object.keys(byDay);
  let best = 0;
  let bestDate = '';
  dates.forEach(function (d) {
    const t = V.toTon(V.totalVolume(byDay[d].filter(isWork)));
    if (t > best) { best = t; bestDate = d; }
  });

  return {
    days: dates.length,
    totalTon: V.toTon(V.totalVolume(all.filter(isWork))),
    best: best,
    bestDate: bestDate
  };
}

/* ---------------- 统计 ---------------- */

/** 本周进度：这周练了几天 / 目标几天 */
function weeklyProgress(date) {
  const p = wx.getStorageSync(K_PROFILE) || {};
  const week = weekDates(date);

  const daySet = {};
  allSets().filter(function (s) { return s.done; }).forEach(function (s) {
    if (week.indexOf(s.date) >= 0) daySet[s.date] = true;
  });

  return {
    done: Object.keys(daySet).length,
    planned: Number(p.days) || plans().length || 3
  };
}

/**
 * 某月统计：
 * { days, streak, ton, calendar: [{d, on, today}], parts: [{name, pct}], top: [{cn, count}] }
 */
function monthlyStats(y, m) {
  const pre = y + '-' + D.pad(m) + '-';
  const all = allSets().filter(function (s) { return s.done; });
  const inMonth = all.filter(function (s) { return s.date.indexOf(pre) === 0; });

  // 训练日
  const daySet = {};
  inMonth.forEach(function (s) { daySet[s.date] = true; });
  const days = Object.keys(daySet).length;

  // 连续天数：今天还没练不算断签，从昨天往前数
  const allDaySet = {};
  all.forEach(function (s) { allDaySet[s.date] = true; });
  let streak = 0;
  let cursor = D.today();
  if (!allDaySet[cursor]) cursor = D.shift(cursor, -1);
  while (allDaySet[cursor]) {
    streak++;
    cursor = D.shift(cursor, -1);
  }

  // 容量、部位分布只算正式组
  const work = inMonth.filter(isWork);
  const ton = V.toTon(V.totalVolume(work));

  // 日历
  const todayS = D.today();
  const dim = D.daysInMonth(y, m);
  const calendar = [];
  for (let d = 1; d <= dim; d++) {
    const ds = pre + D.pad(d);
    calendar.push({ d: d, on: !!daySet[ds], today: ds === todayS });
  }

  // 部位分布：按「练了多少组」算，比按容量更直观
  // （按容量的话，腿因为重量大会被放大到七八成，看起来像只有腿在练）
  const partSets = {};
  work.forEach(function (s) {
    partSets[s.part] = (partSets[s.part] || 0) + 1;
  });
  const totalSets = Object.keys(partSets).reduce(function (a, k) { return a + partSets[k]; }, 0) || 1;
  const parts = Object.keys(partSets)
    .map(function (k) {
      return { key: k, name: EX.PART_CN[k] || k, pct: Math.round(partSets[k] / totalSets * 100) };
    })
    .sort(function (a, b) { return b.pct - a.pct; });

  // 动作频次（按天去重：练过几次，不是几组）
  const exDays = {};
  inMonth.forEach(function (s) {
    const k = s.exId;
    if (!exDays[k]) exDays[k] = { cn: s.exCn, days: {} };
    exDays[k].days[s.date] = true;
  });
  const top = Object.keys(exDays)
    .map(function (k) {
      return { cn: exDays[k].cn, count: Object.keys(exDays[k].days).length };
    })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 5);

  return { days: days, streak: streak, ton: ton, calendar: calendar, parts: parts, top: top };
}

module.exports = {
  /* 引导 */
  hasOnboarded, profile, saveProfile, finishOnboarding, profileText, migrate, resetAll,
  /* 动作 */
  exercises, exerciseById, alternatives, initialWeight,
  /* 自建动作 + 官方清单（动作库模块） */
  customExercises, canAddCustomExercise, saveCustomExercise, removeCustomExercise,
  applyCatalog, catalogRev, onCatalogChange,
  /* 计划 */
  plans, todaySession, suggestWeight, planSig,
  /* 方案 */
  programList, programById, currentProgramId, activateProgram, programSessions,
  customPrograms, saveCustomProgram, removeCustomProgram,
  /* 换动作 */
  swaps, setSwap, clearSwap,
  /* 训练（今天练什么、选动作、记组） */
  trainingDate, todayWorkout, exercisePrefill, pickableExercises, nextSetNo,
  /* 记录 */
  allSets, saveSet, uncheckSet, todaySets, hasAnyRecord, lastRecord, maxWeightBefore, clearSets, loadDemo,
  /* 一次训练 */
  workout, finishWorkout,
  /* 战报 */
  todayReport, detectPRs,
  /* 统计 */
  monthlyStats, weeklyProgress,
  /* 身体指标 */
  metricKinds, metricDef, metricOf, saveMetric, removeMetric, metricSeries, latestMetric, metricDelta,
  /* 可视化 */
  partTerrain, weeklyVolume, allTimeStats,
  /* 配置文档 */
  packConfig, takeConfig, ackConfig, applyConfigDoc, configPending, configUpdatedAt,
  markConfigDirty,
  /* 同步层接口（sync.js 用，页面不用） */
  syncPending, syncPullBatch, syncAck, syncApply, syncMarkAll, onDirty, rejectedIds
};
