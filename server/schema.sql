-- 练界 · 数据库结构
--
-- 由服务启动时自动执行（//go:embed schema.sql），所以必须幂等：
-- 全部用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，不要 DROP。
-- 改结构只加列不删列，保证滚动发布时新旧实例都能跑。
--
-- 设计依据见 docs/技术方案.md、docs/后端接口契约.md、
-- docs/设计文档/训练记录.md（模块设计）
--
-- 五张表：
--   users        身份 + 该用户的版本号计数器 rev
--   sets         组记录（唯一的业务真相）
--   workouts     一次训练（训练记录模块新增）
--   metrics      身体指标
--   user_config  设置 + 换动作 + 自定义方案，一份 JSON 文档整份 LWW
--
-- 没有 plans 表：训练日队列由客户端按配置 + 包内静态数据确定性推导。
-- workouts 与 sets 之间**不加外键**：离线时两条记录可能分不同批次到达，
-- 加外键会让先到的那批写入失败、整批重试，同步卡住。
-- 两者靠「同一用户 + 同一天」关联，某天有 done=true 的组就算练过。
--
-- 每张业务表都有 rev：服务端在每次写入时分配的、按用户递增的版本号。
-- 拉增量只看 rev（不看 updated_at），所以和任何一台机器的时钟都无关。
-- updated_at 是客户端写入时刻，只用于 LWW 判断「谁更新」。

-- ============ 用户 ============
create table if not exists users (
  id          bigserial   primary key,
  openid      text        not null unique,
  unionid     text,
  rev         bigint      not null default 0,   -- 该用户已分配到的最大版本号
  created_at  timestamptz not null default now()
);

-- ============ 组记录（唯一真相） ============
create table if not exists sets (
  user_id     bigint        not null references users(id) on delete cascade,
  date        date          not null,
  ex_id       text          not null,
  set_no      smallint      not null,

  -- 动作信息（冗余，动作库以后改名、调整部位，历史不乱）
  ex_cn       text          not null default '',
  part        text          not null default '',

  -- 归属
  plan_key    text          not null default '',
  sig         text          not null default '',
  slot        smallint,                              -- 动作位置（0 起）；自由加练为空

  -- 实际做了多少
  weight      numeric(6,2)  not null default 0,
  reps        integer       not null default 0,      -- 计时动作是秒数
  unit        text          not null default 'kg',
  rir         smallint,                              -- 还剩几次力气（进步可视化用）
  assist      numeric(6,2),                          -- 助力重量（辅助引体等）

  -- 当时的目标（不是当前计划的目标，换方案后历史判断才不会变）
  target_weight numeric(6,2),
  target_reps   integer,
  target_sets   smallint,

  completed_at  timestamptz,                         -- 这组完成的时刻（只在勾选时写）
  done        boolean       not null default true,   -- false = 墓碑（取消勾选），不是物理删除

  updated_at  timestamptz   not null,
  rev         bigint        not null,
  primary key (user_id, date, ex_id, set_no)
);

create index if not exists sets_user_rev_idx      on sets (user_id, rev);
create index if not exists sets_user_ex_date_idx  on sets (user_id, ex_id, date desc);

-- 老库升级：训练记录模块新增的 7 个可空列，逐个补上（幂等）
alter table sets add column if not exists slot          smallint;
alter table sets add column if not exists rir           smallint;
alter table sets add column if not exists assist        numeric(6,2);
alter table sets add column if not exists target_weight numeric(6,2);
alter table sets add column if not exists target_reps   integer;
alter table sets add column if not exists target_sets   smallint;
alter table sets add column if not exists completed_at  timestamptz;

-- ============ 一次训练（训练记录模块） ============
-- 主键 (user_id, date)：一天只算一次训练（模块设计 §11 第 1 条）。
-- done 由服务端按「这一天是否还有 done=true 的组」重新计算，不按上传值。
create table if not exists workouts (
  user_id      bigint       not null references users(id) on delete cascade,
  date         date         not null,                 -- 训练归属的日期（跨零点：算开始的那天）

  plan_key     text         not null default '',      -- A|B|C|D；自由训练为空
  plan_name    text         not null default '',      -- 冗余存名称，方案改名后历史不乱
  sig          text         not null default '',      -- 当时的计划签名
  program_id   text         not null default 'auto',  -- 当时用的方案

  started_at   timestamptz  not null,                 -- 第一组完成的时刻
  finished_at  timestamptz,                           -- 点「完成训练」的时刻；空 = 还没结束

  feel         smallint,                              -- 1–5，预留
  note         text         not null default '',      -- ≤ 200 字，预留

  done         boolean      not null default true,    -- false = 墓碑（当天组全部取消）
  updated_at   timestamptz  not null,                 -- 客户端时刻，LWW 用
  rev          bigint       not null,                 -- 服务端版本号，拉取用
  primary key (user_id, date)
);

create index if not exists workouts_user_rev_idx on workouts (user_id, rev);

-- ============ 身体指标 ============
create table if not exists metrics (
  user_id    bigint        not null references users(id) on delete cascade,
  kind       text          not null,   -- weight|bodyfat|muscle|waist|chest|hip|arm|hrrest|sleep
  date       date          not null,
  value      numeric(9,2)  not null,
  unit       text          not null default '',
  note       text          not null default '',
  done       boolean       not null default true,
  updated_at timestamptz   not null,
  rev        bigint        not null,
  primary key (user_id, kind, date)
);

create index if not exists metrics_user_rev_idx on metrics (user_id, rev);

-- ============ 配置文档（整份 LWW） ============
create table if not exists user_config (
  user_id     bigint      primary key references users(id) on delete cascade,
  body        jsonb       not null,
  updated_at  timestamptz not null,
  rev         bigint      not null
);
