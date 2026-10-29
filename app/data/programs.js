/**
 * 官方训练方案
 *
 * 一个方案 = 一串训练日（A/B/C/D），每个训练日 = 一串动作 id。
 *
 * 为什么要这一层：
 *   以前只有「水平 × 一周几次 × 场所」三个旋钮，用户得自己组合，而且动作是
 *   按「推拉腿」机械挑的（推日就是卧推+肩推+侧平举+下压，四个里三个是上肢）。
 *   官方方案让人一眼看懂「这个方案适合谁、练几天、每次练什么」，点一下就能用。
 *
 * 与 buildPlan 的区别：
 *   buildPlan 是参数化的（给三个旋钮，自动拼），用于「用户自己选参数」；
 *   PROGRAMS 是显式写死动作的，用于官方预选方案。
 *   两者最终都展开成同样的结构，交给 db 层写进 lj.plans —— 页面层不需要区分。
 *
 * session.type 取 DAY_TYPES 里的值（push/pull/legs/upperA…），
 * 今天页据此选卡片线稿（images/art/<art>.png），所以别随便写。
 */

const P = require('./plan');

/* 只映射到 images/art/ 里真实存在的 4 张线稿：
   barbell / press / pull / squat。加新图之前不要写别的值，否则 image 会裂。 */
const ART_OF = {
  push: 'press', pull: 'pull', legs: 'squat', core: 'barbell',
  upperA: 'press', upperB: 'pull', lowerA: 'squat', lowerB: 'squat',
  fullA: 'barbell', fullB: 'pull'
};

const PROGRAMS = [
  /* ============ 居家 ============ */
  {
    id: 'home-starter-2',
    name: '全身入门',
    en: 'Home Starter',
    desc: '一周两次，每次四个动作。全是徒手和一条毛巾就能做的，先把动作做对。',
    place: 'home', level: 'new', days: 2,
    tags: ['新手', '全身', '徒手'],
    sessions: [
      { key: 'A', type: 'fullA', name: '全身 A', en: 'Full A', exIds: ['h6', 'h1', 'h5', 'h9'] },
      { key: 'B', type: 'fullB', name: '全身 B', en: 'Full B', exIds: ['h7', 'h2', 'h4', 'h10'] }
    ]
  },
  {
    id: 'home-shape-3',
    name: '居家塑形',
    en: 'Home Shape',
    desc: '推、拉、腿各一天。两个水瓶当哑铃，一条弹力带能换出更多花样。',
    place: 'home', level: 'some', days: 3,
    tags: ['塑形', '推拉腿', '水瓶'],
    sessions: [
      { key: 'A', type: 'push', name: '推日', en: 'Push', exIds: ['h1', 'h28', 'h19', 'h3'] },
      { key: 'B', type: 'pull', name: '拉日', en: 'Pull', exIds: ['h4', 'h24', 'h14', 'h33'] },
      { key: 'C', type: 'legs', name: '腿日', en: 'Legs', exIds: ['h6', 'h40', 'h7', 'h41'] }
    ]
  },
  {
    id: 'home-core-3',
    name: '核心与体态',
    en: 'Core & Posture',
    desc: '久坐、腰背紧、肚子松的人先练这个。核心稳定 + 臀腿激活，不追求重量。',
    place: 'home', level: 'some', days: 3,
    tags: ['核心', '体态', '久坐'],
    sessions: [
      { key: 'A', type: 'core', name: '核心 A', en: 'Core A', exIds: ['h9', 'h49', 'h45', 'h17'] },
      { key: 'B', type: 'legs', name: '臀腿激活', en: 'Glutes', exIds: ['h6', 'h8', 'h42', 'h16'] },
      { key: 'C', type: 'core', name: '核心 B', en: 'Core B', exIds: ['h46', 'h11', 'h47', 'h50'] }
    ]
  },

  /* ============ 健身房 ============ */
  {
    id: 'gym-starter-3',
    name: '器械入门',
    en: 'Gym Starter',
    desc: '头三个月用这套。固定器械和哑铃为主，杠铃只在深蹲架上出现一次。',
    place: 'gym', level: 'new', days: 3,
    tags: ['新手', '全身', '器械'],
    sessions: [
      { key: 'A', type: 'fullA', name: '全身 A', en: 'Full A', exIds: ['g9', 'g1', 'g18', 'g13'] },
      { key: 'B', type: 'fullB', name: '全身 B', en: 'Full B', exIds: ['g11', 'g2', 'g17', 'g14'] },
      { key: 'C', type: 'fullA', name: '全身 C', en: 'Full C', exIds: ['g12', 'g6', 'g3', 'g8'] }
    ]
  },
  {
    id: 'gym-ppl-3',
    name: '增肌推拉腿',
    en: 'Push Pull Legs',
    desc: '最经典的练法：推、拉、腿轮流。每个部位一周练到两次，加重量优先于加动作。',
    place: 'gym', level: 'some', days: 3,
    tags: ['增肌', '推拉腿'],
    sessions: [
      { key: 'A', type: 'push', name: '推日', en: 'Push', exIds: ['g1', 'g15', 'g4', 'g3', 'g19'] },
      { key: 'B', type: 'pull', name: '拉日', en: 'Pull', exIds: ['g5', 'g6', 'g17', 'g8', 'g20'] },
      { key: 'C', type: 'legs', name: '腿日', en: 'Legs', exIds: ['g40', 'g44', 'g21', 'g45', 'g22'] }
    ]
  },
  {
    id: 'gym-upper-lower-4',
    name: '上下肢四练',
    en: 'Upper / Lower',
    desc: '一周四练，上下肢各两次。练了一年以上的用这套，每个训练日有一个大重量主动作。',
    place: 'gym', level: 'trained', days: 4,
    tags: ['力量', '上下肢', '进阶'],
    sessions: [
      { key: 'A', type: 'upperA', name: '上肢 A', en: 'Upper A', exIds: ['g1', 'g6', 'g2', 'g3', 'g39'] },
      { key: 'B', type: 'lowerA', name: '下肢 A', en: 'Lower A', exIds: ['g40', 'g44', 'g45', 'g22', 'g51'] },
      { key: 'C', type: 'upperB', name: '上肢 B', en: 'Upper B', exIds: ['g24', 'g30', 'g35', 'g8', 'g31'] },
      { key: 'D', type: 'lowerB', name: '下肢 B', en: 'Lower B', exIds: ['g42', 'g43', 'g46', 'g47', 'g50'] }
    ]
  }
];

function byId(id) {
  return PROGRAMS.filter(function (p) { return p.id === id; })[0] || null;
}

function official() {
  return PROGRAMS;
}

/**
 * 展开成 lj.plans 的结构：[{ key, type, name, en, art, items }]
 *
 * items 里每条的组数次数重量按方案自带的 level 算（不是用户设置里的 level）——
 * 官方方案的动作难度是按它的目标人群挑的，组次也该跟着方案走。
 */
function expand(program) {
  const lv = P.LEVEL[program.level] || P.LEVEL.some;
  return program.sessions.map(function (s) {
    return {
      key: s.key,
      type: s.type,
      name: s.name,
      en: s.en,
      art: ART_OF[s.type] || 'barbell',
      items: P.makeItems(s.exIds, lv)
    };
  });
}

/** 「一周 3 练 · 健身房 · 增肌推拉腿」这种一行摘要 */
function describe(program) {
  if (!program) return '';
  return '一周 ' + program.days + ' 练 · ' +
    (program.place === 'home' ? '居家' : '健身房') + ' · ' + program.name;
}

module.exports = { PROGRAMS, byId, official, expand, describe, ART_OF };
