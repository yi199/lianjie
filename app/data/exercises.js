/**
 * 动作字典
 *
 * place: gym = 健身房（需要器械），home = 居家（徒手 / 一条毛巾 / 两瓶水）
 * unit:  kg = 记重量, bw = 自重（记次数）, sec = 计时（记秒数）
 * tips:  一句技术要点，训练页「动作要点」那行直接用，别写长
 *
 * 表里只放「动作是什么」，不放重量——重量是计划模板决定的。
 * 每个部位的同类动作要够多，「换动作」才换得出来。
 */

const EXERCISES = [
  /* ---------------- 健身房 ---------------- */
  { id: 'g1',  cn: '卧推', en: 'Bench Press', part: 'chest', place: 'gym', unit: 'kg',
    tips: '肩胛后收下沉，杠铃落到乳头连线' },
  { id: 'g15', cn: '上斜卧推', en: 'Incline Press', part: 'chest', place: 'gym', unit: 'kg',
    tips: '靠背约 30°，杠铃落到锁骨下方' },
  { id: 'g16', cn: '哑铃飞鸟', en: 'Dumbbell Fly', part: 'chest', place: 'gym', unit: 'kg',
    tips: '肘微屈锁住，下放到胸有拉伸感' },
  { id: 'g2',  cn: '哑铃推举', en: 'Shoulder Press', part: 'shoulders', place: 'gym', unit: 'kg',
    tips: '核心收紧，别用腰往后仰代偿' },
  { id: 'g4',  cn: '哑铃侧平举', en: 'Lateral Raise', part: 'shoulders', place: 'gym', unit: 'kg',
    tips: '抬到肩高就停，全程别耸肩' },
  { id: 'g19', cn: '前平举', en: 'Front Raise', part: 'shoulders', place: 'gym', unit: 'kg',
    tips: '抬到眼高，肘不要锁死' },
  { id: 'g3',  cn: '绳索下压', en: 'Triceps Pushdown', part: 'arms', place: 'gym', unit: 'kg',
    tips: '大臂夹紧体侧，只动小臂' },
  { id: 'g8',  cn: '哑铃弯举', en: 'Biceps Curl', part: 'arms', place: 'gym', unit: 'kg',
    tips: '肘固定不动，下放数 3 秒' },
  { id: 'g20', cn: '锤式弯举', en: 'Hammer Curl', part: 'arms', place: 'gym', unit: 'kg',
    tips: '掌心相对，别靠甩上去' },
  { id: 'g5',  cn: '引体向上', en: 'Pull-up', part: 'back', place: 'gym', unit: 'bw',
    tips: '先沉肩再拉，下巴过杠' },
  { id: 'g6',  cn: '俯身划船', en: 'Barbell Row', part: 'back', place: 'gym', unit: 'kg',
    tips: '背保持平，杠铃贴大腿拉到腹部' },
  { id: 'g17', cn: '高位下拉', en: 'Lat Pulldown', part: 'back', place: 'gym', unit: 'kg',
    tips: '胸口迎向杠，别整个后仰' },
  { id: 'g18', cn: '坐姿划船', en: 'Seated Row', part: 'back', place: 'gym', unit: 'kg',
    tips: '先收肩胛再拉，别耸肩' },
  { id: 'g7',  cn: '面拉', en: 'Face Pull', part: 'back', place: 'gym', unit: 'kg',
    tips: '拉到眼睛高度，肘高于手' },
  { id: 'g9',  cn: '高脚杯深蹲', en: 'Goblet Squat', part: 'legs', place: 'gym', unit: 'kg',
    tips: '下蹲到大腿与地面平行' },
  { id: 'g10', cn: '壶铃摆荡', en: 'Kettlebell Swing', part: 'legs', place: 'gym', unit: 'kg',
    tips: '髋部发力顶出去，不是用手抬' },
  { id: 'g11', cn: '箭步蹲', en: 'Lunge', part: 'legs', place: 'gym', unit: 'kg',
    tips: '前膝盖不超过脚尖' },
  { id: 'g12', cn: '腿举', en: 'Leg Press', part: 'legs', place: 'gym', unit: 'kg',
    tips: '顶点膝盖别完全锁死' },
  { id: 'g21', cn: '罗马尼亚硬拉', en: 'Romanian Deadlift', part: 'legs', place: 'gym', unit: 'kg',
    tips: '屈髋不含胸，杠贴大腿下放' },
  { id: 'g22', cn: '提踵', en: 'Calf Raise', part: 'legs', place: 'gym', unit: 'kg',
    tips: '顶点停一秒，下放到脚跟最低' },
  { id: 'g13', cn: '平板支撑', en: 'Plank', part: 'core', place: 'gym', unit: 'sec',
    tips: '夹臀收腹，身体一条直线' },
  { id: 'g14', cn: '卷腹', en: 'Crunch', part: 'core', place: 'gym', unit: 'bw',
    tips: '靠腹部把自己卷起来，不是甩脖子' },

  /* ---------------- 居家 ---------------- */
  { id: 'h1',  cn: '俯卧撑', en: 'Push-up', part: 'chest', place: 'home', unit: 'bw',
    tips: '手在肩正下方，身体一条线' },
  { id: 'h2',  cn: '跪姿俯卧撑', en: 'Knee Push-up', part: 'chest', place: 'home', unit: 'bw',
    tips: '膝盖着地，上身仍然保持直线' },
  { id: 'h12', cn: '上斜俯卧撑', en: 'Incline Push-up', part: 'chest', place: 'home', unit: 'bw',
    tips: '手撑得越高越轻松，从桌子开始' },
  { id: 'h13', cn: '宽距俯卧撑', en: 'Wide Push-up', part: 'chest', place: 'home', unit: 'bw',
    tips: '手比肩宽一掌，更多吃力在胸外侧' },
  { id: 'h19', cn: '水瓶侧平举', en: 'Bottle Raise', part: 'shoulders', place: 'home', unit: 'bw',
    tips: '瓶里装水当重量，抬到肩高' },
  { id: 'h3',  cn: '板凳臂屈伸', en: 'Bench Dip', part: 'arms', place: 'home', unit: 'bw',
    tips: '背贴凳沿，肘朝正后方' },
  { id: 'h20', cn: '钻石俯卧撑', en: 'Diamond Push-up', part: 'arms', place: 'home', unit: 'bw',
    tips: '双手并成三角，肘贴身体' },
  { id: 'h4',  cn: '反向划船', en: 'Inverted Row', part: 'back', place: 'home', unit: 'bw',
    tips: '身体绷直，胸口去找杠' },
  { id: 'h5',  cn: '毛巾划船', en: 'Towel Row', part: 'back', place: 'home', unit: 'bw',
    tips: '身体后倾，把毛巾拉向怀里' },
  { id: 'h14', cn: '俯卧挺身', en: 'Superman', part: 'back', place: 'home', unit: 'bw',
    tips: '抬手抬脚，顶点停一秒' },
  { id: 'h6',  cn: '徒手深蹲', en: 'Bodyweight Squat', part: 'legs', place: 'home', unit: 'bw',
    tips: '膝盖方向跟着脚尖' },
  { id: 'h7',  cn: '臀桥', en: 'Glute Bridge', part: 'legs', place: 'home', unit: 'bw',
    tips: '顶点夹紧臀部停一秒' },
  { id: 'h8',  cn: '弓步蹲', en: 'Split Squat', part: 'legs', place: 'home', unit: 'bw',
    tips: '下蹲到前后腿各约 90°' },
  { id: 'h18', cn: '后撤步弓步', en: 'Reverse Lunge', part: 'legs', place: 'home', unit: 'bw',
    tips: '往后撤步，前膝压力更小' },
  { id: 'h16', cn: '单腿臀桥', en: 'Single Glute Bridge', part: 'legs', place: 'home', unit: 'bw',
    tips: '一只脚离地，骨盆别歪' },
  { id: 'h15', cn: '靠墙静蹲', en: 'Wall Sit', part: 'legs', place: 'home', unit: 'sec',
    tips: '大腿平行地面，背贴墙' },
  { id: 'h9',  cn: '平板支撑', en: 'Plank', part: 'core', place: 'home', unit: 'sec',
    tips: '夹臀收腹，别塌腰' },
  { id: 'h10', cn: '登山跑', en: 'Mountain Climber', part: 'core', place: 'home', unit: 'sec',
    tips: '手撑稳，膝盖交替找胸口' },
  { id: 'h11', cn: '仰卧举腿', en: 'Leg Raise', part: 'core', place: 'home', unit: 'bw',
    tips: '腰贴地，腿慢慢放下' },
  { id: 'h17', cn: '死虫式', en: 'Dead Bug', part: 'core', place: 'home', unit: 'bw',
    tips: '腰贴地，对侧手脚同时伸出' }
];

const PART_CN = {
  chest: '胸', back: '背', shoulders: '肩', arms: '手臂', legs: '腿', core: '核心'
};

function byId(id) {
  return EXERCISES.filter(function (e) { return e.id === id; })[0] || null;
}

/** 按场所筛选 */
function byPlace(place) {
  return EXERCISES.filter(function (e) { return e.place === place; });
}

/** 同部位、同场所的其它动作（换动作用） */
function alternatives(exId, place) {
  const ex = byId(exId);
  if (!ex) return [];
  return EXERCISES.filter(function (e) {
    return e.id !== exId && e.part === ex.part && e.place === place;
  });
}

module.exports = { EXERCISES, PART_CN, byId, byPlace, alternatives };
