-- 练界 · 数据库结构
--
-- 由服务启动时自动执行（//go:embed schema.sql），所以必须幂等：
-- 全部用 IF NOT EXISTS。改结构时新增列用 ADD COLUMN IF NOT EXISTS，不要 DROP。
--
-- 设计依据见 docs/技术方案.md、docs/后端接口契约.md
--
-- 四张表：
--   users        身份 + 该用户的版本号计数器 rev
--   sets         组记录（唯一的业务真相）
--   metrics      身体指标
--   user_config  设置 + 换动作 + 自定义方案，一份 JSON 文档整份 LWW
--
-- 没有 plans 表：训练日队列由客户端按配置 + 包内静态数据确定性推导。
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

  ex_cn       text          not null default '',
  part        text          not null default '',
  plan_key    text          not null default '',
  sig         text          not null default '',
  weight      numeric(6,2)  not null default 0,
  reps        integer       not null default 0,
  unit        text          not null default 'kg',
  done        boolean       not null default true,   -- false = 墓碑（取消勾选），不是物理删除

  updated_at  timestamptz   not null,
  rev         bigint        not null,
  primary key (user_id, date, ex_id, set_no)
);

create index if not exists sets_user_rev_idx      on sets (user_id, rev);
create index if not exists sets_user_ex_date_idx  on sets (user_id, ex_id, date desc);

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
