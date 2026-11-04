-- 练界 · 数据库结构
--
-- 由服务启动时自动执行（//go:embed schema.sql），所以必须幂等：
-- 全部用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，不要 DROP。
-- 改结构只加列不删列，保证滚动发布时新旧实例都能跑。
--
-- 设计依据见 docs/技术方案.md、docs/后端接口契约.md、
-- docs/设计文档/训练记录.md（模块设计）
--
-- 五张业务表 + 三张动作库表：
--   users           身份 + 该用户的版本号计数器 rev
--   sets            组记录（唯一的业务真相）
--   workouts        一次训练（训练记录模块新增）
--   metrics         身体指标
--   user_config     设置 + 换动作 + 自定义方案，一份 JSON 文档整份 LWW
--   exercises       官方动作库（全局内容，不进同步）
--   catalog_meta    官方动作清单的整份版本号
--   user_exercises  用户自建动作（用户数据，跟 sets 一起同步）
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

  completed_at  timestamptz,                         -- 这组完成的时刻（只在勾选时写）；同一动作的顺序按它排
  warmup      boolean,                               -- 热身组；null 视为正式组（统计、PR、加重建议都排除热身组）
  block_id    text,                                  -- 训练日程：属于哪条计划线；空视为 'main'
  track_ver   integer,                               -- 训练日程：记录时计划线的版本号
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
alter table sets add column if not exists warmup        boolean;

-- 训练日程（训练记录 v0.3）：记录归属哪条计划线 + 当时的计划线版本
alter table sets add column if not exists block_id      text;
alter table sets add column if not exists track_ver     integer;

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

-- ============ 动作库：官方动作（全局内容，不进同步） ============
-- 没有 rev 列：清单版本由 catalog_meta.rev 整份表达，详情缓存用 TTL，
-- 逐行版本和它的索引没有读写方（设计文档/动作库.md §2.1）。
create table if not exists exercises (
  id          text        primary key,               -- 'g1'，永不变、永不复用
  cn          text        not null,
  en          text        not null default '',
  part        text        not null,                  -- chest|shoulders|arms|back|legs|core
  place       text        not null default 'gym',     -- gym|home（只有两个值）
  unit        text        not null default 'kg',      -- kg|bw|sec
  tips        text        not null default '',        -- ≤64 字，列表直接显示
  hot         boolean     not null default false,     -- 热点：只影响排序和内容制作顺序
  steps       jsonb       not null default '[]',      -- 分步讲解 string[]，≤10 步，可为空
  img_thumb   text        not null default '',        -- CDN URL，可为空
  img_detail  text        not null default '',        -- CDN URL，可为空
  retired     boolean     not null default false,     -- 下架：客户端过滤，历史记录照常显示
  updated_at  timestamptz not null default now()      -- 内容维护时间，仅供人看
);
create index if not exists exercises_hot_idx on exercises (hot) where hot;

-- ============ 动作库：整份版本号 ============
-- 每次导入内容，同一个事务里 rev = rev + 1。
-- 不能用 max(exercises.updated_at) 代替：下架也要让客户端知道，「整份变了」表达不出来。
create table if not exists catalog_meta (
  id         int         primary key default 1 check (id = 1),
  rev        bigint      not null default 1,
  updated_at timestamptz not null default now()
);
insert into catalog_meta (id, rev) values (1, 1) on conflict (id) do nothing;

-- ============ 动作库：用户自建动作（用户数据，跟 sets 一起同步） ============
-- 与 sets 同一套机制：自然主键 + rev + LWW + 墓碑。
-- id 必须带 'u-' 前缀，和官方 id 空间结构上不相交（两台设备离线各建也不会撞）。
create table if not exists user_exercises (
  user_id    bigint      not null references users(id) on delete cascade,
  ex_id      text        not null,                   -- 'u-m8f2k9ab-a7x2'
  cn         text        not null,
  part       text        not null,
  place      text        not null default 'gym',
  unit       text        not null default 'kg',
  tips       text        not null default '',
  done       boolean     not null default true,       -- false = 墓碑
  updated_at timestamptz not null,                    -- 客户端时刻，LWW 用
  rev        bigint      not null,                    -- 服务端版本号，拉取用
  primary key (user_id, ex_id)
);
create index if not exists user_exercises_rev_idx on user_exercises (user_id, rev);
