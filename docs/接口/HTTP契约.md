# 力见 · HTTP 接口契约 v3.4

> 前端与后端的**唯一约定**：字段名、同步语义、校验规则、错误码都以这里为准。
> 设计依据见 [`技术方案.md`](../技术方案.md)，排期见 [`开发计划.md`](../开发计划.md)。
> 各模块对表和接口的扩展见 [`设计文档/`](../设计文档/README.md)（如训练记录新增的 `workouts` 表与组记录字段），实现后合入本契约。
> **与模块文档冲突时以模块文档为准**，并把改动合入本文
> （v3 的 `workouts` 与 7 个新字段来自 [`设计文档/训练记录.md`](../设计文档/训练记录.md)；
> v3.3 的 `customExercises` / `/catalog` / `/exercises/{id}` 来自 [`设计文档/动作库.md`](../设计文档/动作库.md)）。

---

## 0. 通用约定

| 项 | 约定 |
|---|---|
| Base URL | `https://api.<域名>/api`；本地联调 `http://localhost:8080/api` |
| 格式 | 请求、响应都是 `application/json; charset=utf-8` |
| 命名 | 数据库 snake_case，API 一律 camelCase |
| 时间 | RFC 3339，UTC，毫秒精度：`2026-10-29T10:12:03.123Z`（即 JS `toISOString()` 的输出） |
| 日期 | `YYYY-MM-DD`，**用户本地时区的自然日**，由客户端决定 |
| 鉴权 | 除 `/login`、`/catalog`、`/healthz`、`/readyz` 外都要 `Authorization: Bearer <token>` |
| 成功 | `200` + 直接返回数据体（不套 `{code, data}` 信封） |
| 失败 | 非 2xx + `{ "error": { "code": "AUTH_EXPIRED", "message": "…" } }`，错误码见 §6 |

---

## 1. 资源模型

### 1.1 组记录 `SetRow`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `date` | string | `YYYY-MM-DD`，必须是真实日期 | 主键之一 |
| `exId` | string | 1–16 字符 | 主键之一，如 `g1` / `h12` |
| `setNo` | int | 1–50 | 主键之一，从 1 开始 |
| `exCn` | string | ≤ 32 字 | 冗余存中文名，动作库改名后历史不乱 |
| `part` | string | ≤ 16 字 | `chest|back|shoulders|arms|legs|core` |
| `planKey` | string | ≤ 8 字 | 属于哪个训练日：`A|B|C|D` |
| `sig` | string | ≤ 128 字 | 计划签名，见 §1.4 |
| `weight` | number | 0–1000 | 自重 / 计时动作为 0 |
| `reps` | int | 0–36000 | 次数；计时动作是秒数 |
| `unit` | string | `kg|bw|sec` | |
| `done` | bool | | `false` = **墓碑**（取消勾选） |
| `updatedAt` | string | RFC 3339，**必填** | 客户端写入时刻，用于 LWW |

**v3 新增的 7 个可空字段 + v3.1 的 `warmup`**（训练记录模块，来自 [`设计文档/训练记录.md`](../设计文档/训练记录.md) §4.3）：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `slot` | int \| null | 空或 0–19 | 动作在训练日里的位置（0 起）；自由加练为空 |
| `rir` | int \| null | 空或 0–10 | 还剩几次力气（进步可视化用） |
| `assist` | number \| null | 空或 0–1000 | 助力重量（辅助引体等） |
| `targetWeight` | number \| null | 空或 0–1000 | **当时**的建议重量，不是当前计划的 |
| `targetReps` | int \| null | 空或 0–36000 | 当时的计划次数 |
| `targetSets` | int \| null | 空或 1–50 | 当时的计划组数 |
| `completedAt` | string \| null | RFC 3339 | 这组**完成**的时刻。`updatedAt` 改数字就会变，不能代替。客户端按它排同一天各动作的先后顺序 |
| `warmup` | bool \| null | | **v3.1**：热身组。`null` 视为正式组。统计、PR、加重建议、`/history/summary` 的最好成绩与上一次都排除热身组 |
| `blockId` | string \| null | ≤ 32 字 | **v3.2**：这条记录属于哪条计划线；临时自由训练为 `adhoc:<id>`。**`null` 视为 `main`**（迁移前的老记录） |
| `trackVer` | int \| null | ≥ 0 | **v3.2**：记录时该计划线的版本号。计划线内容结构变化时 +1，旧版本的记录不再参与这条线的轮转 |

> **这些可空字段的合并规则（重要）**：服务端用 `coalesce(excluded.x, sets.x)` 合并——
> 旧版客户端不传（`null`）时**保留已有值**，不会把新客户端写上来的数据清空。
> 代价是「把某个字段改回空」不支持，这是有意取舍（模块设计 §11 第 5 条）。
> 其余字段仍是整行 LWW。

主键：`(用户, date, exId, setNo)`。

### 1.2 身体指标 `MetricRow`

| 字段 | 类型 | 约束 |
|---|---|---|
| `kind` | string | 1–16 字符：`weight|bodyfat|muscle|waist|chest|hip|arm|hrrest|sleep` |
| `date` | string | `YYYY-MM-DD` |
| `value` | number | ±100000 |
| `unit` | string | ≤ 8 字：`kg|%|cm|bpm|h` |
| `note` | string | ≤ 200 字 |
| `done` | bool | `false` = 墓碑 |
| `updatedAt` | string | 必填 |

主键：`(用户, kind, date)`——一种指标一天一个值。

### 1.3 配置文档 `ConfigDoc`

```jsonc
{
  "body": { /* 见下 */ },
  "updatedAt": "2026-10-29T10:12:03.123Z"
}
```

服务端只校验 `body` 是 JSON 对象且 ≤ 64KB，**不解析内部结构**。`body` 的结构由客户端定义（v1）：

```jsonc
{
  "v": 1,
  "onboarded": true,
  "profile": { "level": "some", "days": 3, "place": "gym", "programId": "gym-ppl-3" },
  "swaps": { "A:2": "g15" },                    // 训练日:第几个动作 → 换成的动作 id
  "customPrograms": [
    { "id": "my-1761700000000", "name": "我的上肢日", "en": "Custom", "desc": "",
      "place": "gym", "level": "some", "days": 1, "tags": ["自定义"],
      "sessions": [{ "key": "A", "type": "fullA", "name": "训练日 A", "en": "", "exIds": ["g1", "g27"] }] }
  ]
}
```

客户端升级 `body` 结构时递增 `v`，并兼容读取旧版本。**后端不需要跟着改。**

训练日队列不在这里：客户端拿到 `profile` + `customPrograms` 后自己推导。

### 1.4 计划签名 `sig`

```
sig = level + '|' + days + '|' + place + '|' + programId
例：  some|3|gym|gym-ppl-3
```

由客户端计算并写进每条组记录。服务端**只存不算**。它的作用是：改了设置之后，旧记录不再参与「下一个练哪个训练日」的轮转。

### 1.5 一次训练 `WorkoutRow`（v3 新增）

一天一行，主键 `(用户, date)`。**一天只算一次训练**（模块设计 §11 第 1 条）。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `date` | string | `YYYY-MM-DD` | 主键。训练归属的日期 = **它开始的那天**（跨零点规则见模块设计 §6.5） |
| `planKey` | string | ≤ 8 字 | 练的是哪个训练日；自由训练为空 |
| `planName` | string | ≤ 32 字 | 冗余存名称，方案改名后历史不乱 |
| `sig` | string | ≤ 128 字 | 当时的计划签名，见 §1.4 |
| `programId` | string | ≤ 64 字 | 当时用的方案 |
| `startedAt` | string | RFC 3339，**必填** | 第一组完成的时刻 |
| `finishedAt` | string \| null | RFC 3339，且不早于 `startedAt` | 点「完成训练」的时刻；空 = 还没结束 |
| `feel` | int \| null | 空或 1–5 | 训练感受（预留，本期无界面） |
| `note` | string | ≤ 200 字 | 备注（预留） |
| `done` | bool | | **由服务端按 sets 计算**，不按上传值，见 §4.2 |
| `updatedAt` | string | RFC 3339，**必填** | 客户端写入时刻，用于 LWW |

`workouts` 与 `sets` 之间**没有外键**：离线时两条记录可能分不同批次到达，加外键会让先到的那批写入失败、整批重试，同步卡住。两者靠「同一用户 + 同一天」关联，**某天有 `done=true` 的组就算练过**，即使对应的 workouts 行暂时缺失。

### 1.6 自建动作 `CustomExerciseRow`（v3.3 新增）

用户自己建的动作。和组记录同一套机制（自然主键 + `rev` + LWW + 墓碑），

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `exId` | string | **`u-` 开头，总长 3–16 字节**，只含小写字母/数字/连字符 | 主键之一 |
| `cn` | string | 1–24 字 | 动作名 |
| `part` | string | `chest\|shoulders\|arms\|back\|legs\|core`，必填 | 服务端校验 |
| `place` | string | `gym\|home`，必填 | **只有两个值**：`both` 会被客户端的等值筛选永久过滤掉 |
| `unit` | string | `kg\|bw\|sec`，必填 | |
| `tips` | string | ≤ 64 字，可空 | 一句话技术要点 |
| `done` | bool | | `false` = **墓碑** |
| `updatedAt` | string | RFC 3339，**必填** | 客户端写入时刻，用于 LWW |

**为什么强制 `u-` 前缀**：`exId` 会写进每一组记录、是 `sets` 主键的一部分永久存着，而它有两个生成者——官方（服务端建、能查重）和自建（手机上离线生成、没法查重）。前缀让两套 id 空间**结构上不相交**，所以不需要查重、不需要申请号段。官方 id 是 `g1` / `h12` 这种形式，永远不带 `u-`。

**为什么 ≤16 字节**：`ex_id` 是 `sets` 主键的一部分。超长的自建动作会让「用这个动作记的**每一组**」在同步时被拒收，再按 `rejected` 出队 = 数据静默丢失。

`/sync` 里它是**第 4 类资源**，跟 `sets` 完全同一套处理（整行 LWW、落败行刷新 `rev`、墓碑跨设备传播、计入 500 行上限）。

### 1.7 官方动作 `catalogExercise`（v3.3 新增，只读）

全局内容，**不进同步**，整份下发。清单只给缩略图，详细插画在要登录的详情接口后面。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 官方 id：`^[a-z][a-z0-9]{0,5}$`（`g1` / `h12`），永不变、永不复用 |
| `cn` / `en` | string | 中文名 / 英文名 |
| `part` | string | 六个部位之一 |
| `place` | string | `gym\|home` |
| `unit` | string | `kg\|bw\|sec` |
| `tips` | string | ≤64 字，列表直接显示 |
| `hot` | bool | 热点：只影响排序和内容制作顺序 |
| `imgThumb` | string | 缩略图 URL（`https://`），可空 |
| `retired` | bool | **下架标记，照常下发，由客户端过滤**——整份替换才能覆盖本地旧的「未下架」状态 |

详情接口额外返回 `steps: string[]`（≤10 步、每步 ≤200 字）和 `imgDetail`（大图 URL）。两者都允许为空，页面主体不依赖它们。

---

## 2. 数据库表

```sql
-- 身份 + 该用户的版本号计数器
create table users (
  id          bigserial   primary key,
  openid      text        not null unique,
  unionid     text,
  rev         bigint      not null default 0,   -- 已分配到的最大版本号
  created_at  timestamptz not null default now()
);

-- 组记录（唯一真相）
create table sets (
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
  done        boolean       not null default true,   -- false = 墓碑
  updated_at  timestamptz   not null,                -- 客户端时刻（LWW 用）
  rev         bigint        not null,                -- 服务端版本号（拉取用）
  primary key (user_id, date, ex_id, set_no),

  -- v3：训练记录模块新增的 7 个可空列（老库用下面的 alter 补）
  slot          smallint,
  rir           smallint,
  assist        numeric(6,2),
  target_weight numeric(6,2),
  target_reps   integer,
  target_sets   smallint,
  completed_at  timestamptz,
  warmup        boolean,                      -- v3.1：热身组，null = 正式组
  block_id      text,                         -- v3.2：属于哪条计划线，null = 'main'
  track_ver     integer                       -- v3.2：记录时计划线的版本号
);
create index sets_user_rev_idx     on sets (user_id, rev);
create index sets_user_ex_date_idx on sets (user_id, ex_id, date desc);

-- 老库升级：逐个补列，幂等（只加列，不删列）
alter table sets add column if not exists slot          smallint;
alter table sets add column if not exists rir           smallint;
alter table sets add column if not exists assist        numeric(6,2);
alter table sets add column if not exists target_weight numeric(6,2);
alter table sets add column if not exists target_reps   integer;
alter table sets add column if not exists target_sets   smallint;
alter table sets add column if not exists completed_at  timestamptz;
alter table sets add column if not exists warmup        boolean;
alter table sets add column if not exists block_id      text;
alter table sets add column if not exists track_ver     integer;

-- 一次训练（v3 新增）。done 由服务端按 sets 重算，不按上传值
create table workouts (
  user_id      bigint       not null references users(id) on delete cascade,
  date         date         not null,                -- 训练归属的日期（跨零点算开始那天）
  plan_key     text         not null default '',
  plan_name    text         not null default '',
  sig          text         not null default '',
  program_id   text         not null default 'auto',
  started_at   timestamptz  not null,                -- 第一组完成的时刻
  finished_at  timestamptz,                          -- 空 = 还没点「完成训练」
  feel         smallint,                             -- 1–5，预留
  note         text         not null default '',
  done         boolean      not null default true,    -- false = 墓碑（当天组全部取消）
  updated_at   timestamptz  not null,
  rev          bigint       not null,
  primary key (user_id, date)
);
create index workouts_user_rev_idx on workouts (user_id, rev);

-- 身体指标
create table metrics (
  user_id    bigint       not null references users(id) on delete cascade,
  kind       text         not null,
  date       date         not null,
  value      numeric(9,2) not null,
  unit       text         not null default '',
  note       text         not null default '',
  done       boolean      not null default true,
  updated_at timestamptz  not null,
  rev        bigint       not null,
  primary key (user_id, kind, date)
);
create index metrics_user_rev_idx on metrics (user_id, rev);

-- 配置文档（每用户一行，整份 LWW）
create table user_config (
  user_id     bigint      primary key references users(id) on delete cascade,
  body        jsonb       not null,
  updated_at  timestamptz not null,
  rev         bigint      not null
);

-- v3.3 动作库：官方动作（全局内容，不进同步，没有 rev 列）
create table exercises (
  id          text        primary key,
  cn          text        not null,
  en          text        not null default '',
  part        text        not null,
  place       text        not null default 'gym',
  unit        text        not null default 'kg',
  tips        text        not null default '',
  hot         boolean     not null default false,
  steps       jsonb       not null default '[]',
  img_thumb   text        not null default '',
  img_detail  text        not null default '',
  retired     boolean     not null default false,
  updated_at  timestamptz not null default now()
);
create index exercises_hot_idx on exercises (hot) where hot;

-- v3.3 动作库：整份版本号（单行表，每次导入 rev+1）
create table catalog_meta (
  id         int         primary key default 1 check (id = 1),
  rev        bigint      not null default 1,
  updated_at timestamptz not null default now()
);
insert into catalog_meta (id, rev) values (1, 1) on conflict (id) do nothing;

-- v3.3 动作库：用户自建动作（跟 sets 同一套 rev + LWW + 墓碑）
create table user_exercises (
  user_id    bigint      not null references users(id) on delete cascade,
  ex_id      text        not null,              -- 'u-m8f2k9ab-a7x2'
  cn         text        not null,
  part       text        not null,
  place      text        not null default 'gym',
  unit       text        not null default 'kg',
  tips       text        not null default '',
  done       boolean     not null default true,
  updated_at timestamptz not null,
  rev        bigint      not null,
  primary key (user_id, ex_id)
);
create index user_exercises_rev_idx on user_exercises (user_id, rev);
```

建表语句由服务启动时自动执行，全部 `IF NOT EXISTS`。**改结构只加列（`ADD COLUMN IF NOT EXISTS`），不删列**，保证新旧实例滚动发布时都能跑。

**没有的表**：`plans`（客户端推导）、`swaps` / `custom_programs`（并入 `user_config`）、任何统计 / 聚合表。
**v3 新增了 `workouts`**（见上）；它和 `sets` 之间**故意不加外键**（理由见 §1.5）。
**v3.3 新增了 `exercises` / `catalog_meta` / `user_exercises`**：官方动作是全局内容、单独一张表，不挂 `user_id`、不进同步；自建动作才挂用户、走 `/sync`。官方内容的写入只走 `cmd/seed-catalog`，服务端没有管理后台接口。

---

## 3. 端点一览

| 方法 | 路径 | 鉴权 | 限流 | 作用 |
|---|---|---|---|---|
| GET | `/healthz` | — | — | 进程存活（不碰数据库） |
| GET | `/readyz` | — | — | 数据库可达才 200 |
| POST | `/login` | — | 按 IP | `wx.login` 的 code 换 token |
| **POST** | **`/sync`** | ✓ | 按用户 | **唯一写入口**：上传增量 + 拉取增量 |
| GET | `/history/summary` | ✓ | 按用户 | 全量聚合（可选，不在关键路径） |
| GET | `/metrics?kind=&from=&to=` | ✓ | 按用户 | 指标时间序列（图表用，可选） |
| **GET** | **`/catalog?since=<rev>`** | — | **按 IP（独立限流器）** | **官方动作整份清单（v3.3）** |
| GET | `/exercises/{id}` | ✓ | 按用户 | 动作详情：`steps` + 大图（v3.3） |
| **DELETE** | **`/account`** | ✓ | 按用户 | **删除账号：级联清空该用户全部数据（v3.4）** |
| POST | `/client-error` | — | 按 IP（独立限流器） | 客户端兜底错误上报，**只记日志**（v3.4） |

**v1 里有、v2 删掉的端点**：`GET/PUT /me`、`GET /plans`、`GET /sets`、`GET /programs`、`PUT/DELETE /programs/custom`、`PUT /swaps`。全部被 `/sync` + 配置文档取代——**一条写路径，重试逻辑只有一处**。

---

## 4. 端点详情

### 4.1 `POST /login`

```jsonc
// 请求
{ "code": "081Kd…" }

// 200
{ "token": "eyJhbGciOi…", "expiresAt": "2026-11-28T10:12:03.123Z" }
```

- 服务端调 `jscode2session` 换 `openid`，按 `openid` upsert 用户（首次登录即注册）
- `DEV_MODE=true` 时不调微信，`openid = "dev-" + code`（同一个 code 永远是同一个用户）
- `session_key` 不返回、不入库
- token 过期或任何接口返回 401 → 客户端静默重新 `wx.login` 一次，用户无感知

### 4.2 `POST /sync` —— 核心

**一次往返完成「推」和「拉」。**

```jsonc
// 请求
{
  "cursor": 1234,                // 上次响应里的 cursor；首次传 0
  "sets":    [ /* SetRow，≤ 500 条（四类资源合计） */ ],
  "workouts":[ /* WorkoutRow，v3 新增 */ ],
  "metrics": [ /* MetricRow */ ],
  "customExercises": [ /* CustomExerciseRow，v3.3 新增；本地动作没改过就传空数组 */ ],
  "config":  { "body": { … }, "updatedAt": "…" }    // 本地配置没改过就传 null
}

// 200
{
  "cursor":   1300,              // 下次请求带上
  "hasMore":  false,             // true = 还有没拉完的，立刻再请求一次
  "applied":  12,                // 本次上传中赢下 LWW、实际写入的条数
  "rejected": [                  // 校验不过的行（按请求里的下标）
    { "kind": "set", "index": 3, "reason": "date 必须是 YYYY-MM-DD" }
  ],
  "sets":     [ /* cursor 之后别的设备写的、或本次落败需要回推的行 */ ],
  "workouts": [ … ],             // v3
  "metrics":  [ … ],
  "customExercises": [ … ],      // v3.3
  "config":   null,              // 服务端配置比 cursor 新时才下发
  "catalogRev": 5,               // v3.3：官方动作清单的整份版本号（每次都带）
  "serverTime": "2026-10-29T10:12:05.000Z"   // 仅供排查，客户端不要拿它做任何判断
}
```

`rejected[].kind` 取值：`set` / `workout` / `metric` / **`customExercise`** / `config`。

**`catalogRev` 怎么用**：客户端把它和自己 `lj.catalog.rev` 比——
`catalogRev > 本地 rev` → 去 `GET /api/catalog?since=<本地 rev>` 整份拉；
`catalogRev < 本地 rev` → 服务端被重置过，按 0 处理、强制全量拉一次（自愈）；
相等 → 什么都不做。它挂在 `/sync` 上而不是独立心跳：`/sync` 的触发点（`onShow`、改动后防抖、失败重试）都是现成的，零额外请求。

#### 服务端处理流程

```
1. 校验每一行（§1 的约束）；不合格的放进 rejected，其余照常处理
2. 夹紧时钟：updatedAt 比服务器快 > 2 分钟 → 按服务器时间记
3. 推（一个事务）：
     update users set rev = rev + n where id = $uid returning rev   ← 分配版本号 + 锁用户
     逐行 upsert sets / metrics / config：WHERE 旧.updated_at < 新.updated_at（LWW）
     逐行合并 workouts：按字段合并（见下），不受 LWW 守卫
     落败的行：只把 rev 改成新分配的值（让赢家出现在本次拉取结果里）
     刷新受影响日期的 workouts.done（以 sets 为准，变化的行分配新 rev）
     提交
4. 拉（可重复读的只读事务）：
     读 users.rev
     取 rev > cursor 的 sets / workouts / metrics / config，按 rev 升序，各取 ≤ 1000 条
     三张表都没取满 → cursor = users.rev，hasMore = false
     否则按 rev 三路归并取前 1000 条，cursor = 最后一条的 rev，hasMore = true
5. 去掉「本次刚上传且赢了、rev 未再变化」的 sets / metrics / config（客户端手里就是这份，不回传）
   workouts 例外：一律回传。它按字段合并，合并结果可能和上传的内容不同（v3.1 修复）
```

组记录的 upsert：

```sql
insert into sets (user_id, date, ex_id, set_no, ex_cn, part, plan_key, sig,
                  weight, reps, unit, done, updated_at, rev)
values (…)
on conflict (user_id, date, ex_id, set_no) do update set
  ex_cn = excluded.ex_cn, part = excluded.part, plan_key = excluded.plan_key,
  sig = excluded.sig, weight = excluded.weight, reps = excluded.reps,
  unit = excluded.unit, done = excluded.done,
  updated_at = excluded.updated_at, rev = excluded.rev
where sets.updated_at < excluded.updated_at;     -- LWW；影响 0 行 = 落败

-- v3：7 个可空字段用 coalesce 合并（旧客户端传 null 不清空已有值）
--   slot = coalesce(excluded.slot, sets.slot)   … 其余 6 个同理

-- 落败行
update sets set rev = $new_rev where user_id = … and date = … and ex_id = … and set_no = …;
```

`metrics`、`user_config` 同理。

`workouts` 的 upsert **不是整行 LWW，而是按字段合并**——两台设备同一天都练过时，整行 LWW 会丢掉较早的开始时刻，训练时长就算错了：

```sql
insert into workouts (user_id, date, plan_key, plan_name, sig, program_id,
                      started_at, finished_at, feel, note, done, updated_at, rev)
values (…)
on conflict (user_id, date) do update set
  started_at  = least(workouts.started_at, excluded.started_at),        -- 取较早
  finished_at = case                                                     -- 取较晚
                  when workouts.finished_at is null then excluded.finished_at
                  when excluded.finished_at is null then workouts.finished_at
                  else greatest(workouts.finished_at, excluded.finished_at)
                end,
  plan_key   = case when excluded.updated_at > workouts.updated_at then excluded.plan_key   else workouts.plan_key   end,
  plan_name  = case when excluded.updated_at > workouts.updated_at then excluded.plan_name  else workouts.plan_name  end,
  sig        = case when excluded.updated_at > workouts.updated_at then excluded.sig        else workouts.sig        end,
  program_id = case when excluded.updated_at > workouts.updated_at then excluded.program_id else workouts.program_id end,
  feel       = case when excluded.updated_at > workouts.updated_at then excluded.feel       else workouts.feel       end,
  note       = case when excluded.updated_at > workouts.updated_at then excluded.note       else workouts.note       end,
  updated_at = greatest(workouts.updated_at, excluded.updated_at),
  rev        = excluded.rev;
-- done 不在这里合并，由下面的刷新语句决定
```

写完 sets 和 workouts 后，在**同一事务**里刷新受影响日期的 `done`：

```sql
-- 受影响日期 = 本批 sets 的日期 ∪ 本批 workouts 的日期（所以与上传顺序无关）
update workouts w
set done = exists (select 1 from sets s
                   where s.user_id = w.user_id and s.date = w.date and s.done),
    rev  = $new_rev
where w.user_id = $uid and w.date = $date;
```

只对 `done` 真的翻转的日期执行（先查差异再分配 rev），否则每次上传都会让所有历史 workout 换 rev、拉取流量爆炸。

#### 语义保证

| 保证 | 说明 |
|---|---|
| 幂等 | 同一批重复提交任意次，结果和提交一次相同 |
| 原子 | 一批上传在一个事务里，要么全部生效要么全部不生效 |
| 不漏 | 按 cursor 翻页拉到 `hasMore=false`，一定拿到此刻之前所有已提交的写入 |
| 部分失败可恢复 | 推成功、拉失败 → 返回 5xx，客户端整批重传即可（幂等） |
| 游标自愈 | 客户端 cursor 大于服务端 `users.rev`（服务端被重置过）→ 服务端自动按 0 处理，从头下发 |

#### 限制

| 项 | 上限 | 超出时 |
|---|---|---|
| 单次上传行数（sets + workouts + metrics + customExercises） | 500 | `400 TOO_MANY_ROWS`，客户端分批 |
| 单次下发行数 | 1000 | `hasMore=true` |
| 请求体 | 2MB | `400 BODY_INVALID` |
| 配置文档 | 64KB | 进 `rejected` |
| 频率 | 每用户每秒 2 次，突发 20 | `429 RATE_LIMITED` + `Retry-After` |

### 4.3 `GET /history/summary`（可选）

全量实时聚合，**不落表**。客户端本地有全量历史，正常情况下用不到；用于新设备还没拉完历史时先显示总览、以及排查。

```jsonc
{
  "totalTon": 128.4, "totalDays": 87,
  "bestTon": 6.2, "bestDate": "2026-09-14",
  "streak": 23,                       // 按服务端时区（TZ_NAME）算的当前连续天数
  "exercises": [
    { "exId": "g1", "pb": 100, "pbDate": "2026-09-14",
      "lastDate": "2026-10-27", "lastWeight": 95, "lastSets": 4, "lastReps": 10, "doneDays": 31 }
  ],
  "asOf": "2026-10-29T10:20:00.000Z"
}
```

口径和客户端一致：只算 `done=true`；吨数只算 `unit='kg'`。

### 4.4 `GET /metrics?kind=weight&from=2026-08-01&to=2026-10-31`（可选）

```jsonc
{ "metrics": [ /* MetricRow，只含 done=true，按 date 升序，最多 5000 条 */ ] }
```

客户端本地也有全部指标（随 `/sync` 下发），这个接口留给以后的 Web 端或数据导出。

### 4.5 `/healthz` 与 `/readyz`

```jsonc
// GET /api/healthz → 200
{ "ok": true, "time": "…" }

// GET /api/readyz → 200 { "ok": true }  或  503 { "error": { "code": "DB_DOWN", … } }
```

容器存活探针用 `healthz`（数据库抖动时不要重启进程），负载均衡摘流量用 `readyz`。

### 4.6 `GET /api/catalog?since=<rev>`（v3.3，免登录）

```jsonc
// 200：永远是整份清单
{
  "rev": 5,
  "exercises": [
    { "id": "g1", "cn": "卧推", "en": "Bench Press", "part": "chest", "place": "gym",
      "unit": "kg", "tips": "肩胛后收下沉，杠铃落到乳头连线", "hot": true,
      "imgThumb": "", "retired": false }
  ]
}
```

- **`since` 只决定「要不要给」，不决定「给多少」**：`since >= 当前 rev` → `304`（空 body）；否则整份返回。
  客户端因此只有一条写入路径（整份替换），不需要处理增量合并。
- 不传 `since` = 一定给；`since` 非整数或负数 → `400 SINCE_INVALID`。
- 顺序由服务端定：`order by hot desc, id`。Postgres 不带 `ORDER BY` 时返回顺序未定义，
  两次拉取间顺序跳变会让用户觉得动作位置自己变了。
- `retired=true` 的行照常下发，**由客户端过滤**：整份替换才能覆盖本地旧的「未下架」状态。
- **自愈**：客户端本地 `rev` 大于服务端（服务端被重置/回滚过）时按 `0` 处理，否则
  `since >= rev` 恒成立、清单永远不再刷新。
- 限流用**独立**的 IP 限流器（`newLimiter(2, 60)`）：这个接口会被 `onShow` 频繁触发，
  复用人 `/login` 的 `(1, 10)` 会让正常用户撞限流，运营商 NAT 下整片 IP 更糟。

### 4.7 `GET /api/exercises/{id}`（v3.3，要登录）

```jsonc
// 200
{ "id": "g1", "steps": ["仰卧，肩胛后收", "握距略宽于肩", "下放到胸，推起"], "imgDetail": "" }
```

- `steps` 是 `string[]`（≤10 步、每步 ≤200 字），不是 Markdown：省一个解析器、省包体、没有 XSS 面。
- `steps` 和 `imgDetail` 都允许为空——**页面主体（名字、部位、`tips`）不依赖这个接口**，拉不到就不显示图。
- 大图放在这里而不是清单里：匿名面只给缩略图，`curl` 批量抓内容至少要有账号。
- `id` 为空或 >16 字节 → `400 ID_INVALID`；动作不存在 → `404 EXERCISE_NOT_FOUND`。

### 4.8 `DELETE /api/account`（v3.4，要登录）——删除账号

```jsonc
// 200
{ "deleted": true }     // false = 用户已经不在了（重复调用，幂等）
```

- 合规要求（「删除个人信息」）的落点：一次 `delete from users where id = $1`，
  五张业务表（`sets` / `workouts` / `metrics` / `user_config` / `user_exercises`）
  都带 `on delete cascade`，级联带走，**不留孤儿行**。
- **幂等**：重复调用返回 `deleted:false` + 200，客户端不必区分。
- 服务端删不到「别人手机上」的本地存储 —— 客户端在成功后必须自己 `db.resetAll()`，
  并清掉 `lj.auth` / `lj.sync.cursor`（`sync.deleteAccount()` 已经做了后两件事）。
  **不清 token 就会自动重登、建一个新用户，再把本地残留推上去，等于没删。**
- 用户被删后，旧 token 仍然能通过 JWT 校验（鉴权不查库），但任何写操作会返回
  `401 AUTH_EXPIRED`（`store.push` 找不到用户行）→ 客户端静默重登成空账号。

### 4.9 `POST /api/client-error`（v3.4，免登录）——客户端兜底错误

```jsonc
// 请求
{
  "kind": "onError",                 // onError | onUnhandledRejection | onPageNotFound
  "page": "pages/today/index",       // 出事时的页面路由
  "path": "",                        // onPageNotFound 的目标路径
  "msg": "Cannot read property …",
  "stack": "at …",                   // 换行会被压成一行再记
  "sid": "m3k2-9f1a",                // 一次启动一个 id，把一串错误串成会话
  "env": "release",                  // develop | trial | release
  "at": "2026-11-11T08:00:00.000Z"
}
```

- 返回 **204 No Content**（不带 body）。
- **只记日志、不落库**：单实例项目看服务日志就够；落库要先想清楚保留期与隐私边界。
- **免登录**：登录流程本身就可能出错，要求 token 会让最该上报的那类错误报不上来。
- 限制：请求体 ≤ 8KB、`msg` ≤ 500 字、`stack` ≤ 2000 字、其余字段 ≤ 128 字；
  超了 `400 FIELD_TOO_LONG`；`kind` 不在白名单里 `400 KIND_INVALID`。按 IP 独立限流 `(2, 30)`。
- 客户端侧（`utils/report.js`）：**同一条错误 60 秒内只报一次、一次启动最多 20 条**，
  且 `config.js` 地址留空（纯本地模式）时**一行请求都不发**。

---

## 5. 客户端同步行为（`utils/sync.js` 的职责）

| 项 | 行为 |
|---|---|
| 触发 | 小程序 `onLaunch` / `onShow`；本地有改动后 2 秒（防抖）；有待上传时每 30 秒一次 |
| 单飞 | 同一时刻只有一个同步在跑；跑的期间又有改动 → 结束后再跑一轮 |
| 分批 | 每次最多 500 行；循环到「队列空且 `hasMore=false`」，单次触发最多 20 轮 |
| 首次 | 把本地全部真实记录（不含示例数据）和配置排进上传队列 |
| 401 | 清 token → `wx.login` → `/login` → 重试一次 |
| 其他失败 | 指数退避：5s、10s、20s… 封顶 5 分钟，乘 0.5–1.5 随机抖动 |
| 400 TOO_MANY_ROWS | 客户端 bug，记日志；不应出现 |
| `rejected` | 对应行移出上传队列（否则一条坏数据会让队列永远卡住），记日志 |
| 成功后 | 清队列（只清发出后没再改过的行）→ 应用下发数据 → 保存 cursor → 通知页面刷新 |

应用下发数据的规则：

| 情况 | 处理 |
|---|---|
| 本地这行有未上传改动 | 不覆盖（等上传后服务端裁决，赢家会再回来） |
| 下发的是墓碑 | 本地物理删除 |
| 下发的配置，且本地配置没有未上传改动 | 整份替换，然后重新推导训练日队列 |
| 本次上传成功的墓碑 | 本地物理删除（服务端已有） |

---

## 6. 错误码

| HTTP | code | 含义 | 客户端处理 |
|---|---|---|---|
| 400 | `BODY_EMPTY` / `BODY_INVALID` | 请求体为空 / 不是合法 JSON / 超过 2MB | bug，记日志 |
| 400 | `CODE_INVALID` | 登录 code 为空或过长 | 重新 `wx.login` |
| 400 | `SINCE_INVALID` | `/catalog` 的 `since` 不是非负整数 | bug，按 0 重试（强制全量） |
| 400 | `ID_INVALID` | 动作 id 为空或 >16 字节 | bug，记日志 |
| 400 | `KIND_INVALID` / `FIELD_TOO_LONG` | 错误上报的 kind 不在白名单 / 字段超长（v3.4） | bug，记日志（客户端本来就不再重试） |
| 404 | `EXERCISE_NOT_FOUND` | 详情接口的动作不存在 | 不重试，页面只显示列表字段 |
| 400 | `TOO_MANY_ROWS` | 单次超过 500 行 | bug，分批 |
| 400 | `DATE_INVALID` | 查询参数日期格式错 | bug |
| 401 | `AUTH_MISSING` / `AUTH_EXPIRED` | 无 token / 过期 / 用户已删除 | 静默重新登录 |
| 429 | `RATE_LIMITED` | 请求太频繁 | 按 `Retry-After` 退避 |
| 500 | `DB_ERROR` / `TOKEN_ERROR` | 服务端错误 | 退避重试 |
| 502 | `WECHAT_FAILED` | 微信 `jscode2session` 失败 | 退避重试 |
| 503 | `DB_DOWN` | 数据库不可达（仅 `/readyz`） | — |

---

## 7. 服务端配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADDR` | `:8080` | 监听地址 |
| `DATABASE_URL` | — | **必填** |
| `DB_MAX_CONNS` | `20` | 单实例连接池上限 |
| `JWT_SECRET` | 开发用默认值 | **生产必须 ≥ 32 字节随机值**，否则拒绝启动 |
| `WECHAT_APPID` / `WECHAT_SECRET` | — | 生产必填 |
| `DEV_MODE` | `false` | `true` 时登录不调微信。**只在本地 `.env` 打开** |
| `TRUST_PROXY` | `false` | 限流是否采信 `X-Real-IP`。**只在 Nginx 反代后面才设 `true`**（v3.4）：直连端口时这个头客户端能伪造，按它限流等于没开 |
| `TZ_NAME` | `Asia/Shanghai` | 服务端「今天」的时区（仅影响 `/history/summary` 的 streak） |

---

## 8. 写代码时容易错的事

1. **不能信前端传的 userId**——一律从 JWT 取。
2. **拉取只看 `rev`，不看 `updated_at`**——混用两台机器的时钟会静默漏数据。
3. **`rev` 分配必须和用户行锁在同一句**（`update users … returning rev`），否则并发提交乱序会漏行。
4. **LWW 的 `WHERE` 不能省**，且 `updated_at` 用客户端时刻（夹紧后），不是 `now()`。
5. **落败行要刷新 rev**，否则时钟偏慢的设备拿不到赢家。
6. **删除一律写墓碑**，不要物理删除——否则会被别的设备传回来。
7. **自重 / 计时动作 `weight` 是 0**，吨数、均值要过滤 `unit='kg'`。
8. **`sig` 服务端只存不算**，别自作主张重算或排序。
9. **改表只加列不删列**，保证滚动发布时新旧实例都能跑。
10. **不要把 streak / pb 存成表**——它们是全量的实时查询。
11. **`workouts` 不能写成整行 LWW**——`started_at` 取较早、`finished_at` 取较晚，否则两台设备同一天训练会丢掉较早的开始时刻，训练时长算错（§4.2）。
12. **`workouts.done` 只能由服务端按 sets 算**，不能信上传值；且受影响日期要取 `sets ∪ workouts`，否则「先到组」「先到训练」两种顺序结果不同。
13. **`sets` 的 7 个新字段用 `coalesce` 合并**，不能直接 `= excluded.x`——否则旧版客户端上传时会把新客户端已写的值清成 `null`。
14. **`startedAt` / `finishedAt` 这类 timestamptz 参数不要传 Go 的 `time.Time` 到声明为 `::text` 的参数位**——pgx 会用 Go 默认格式编码，Postgres 报 `SQLSTATE 22007`。传客户端的 RFC3339 字符串。
15. **workouts 不能去回声**——按字段合并的行，「上传方赢了」不代表服务端存的和上传的一样，必须把合并结果回传给上传方（v3.1 修复的 bug）。
16. **`blockId` / `trackVer` 服务端只存不算**——「`null` 视为 `main`」「版本号变了旧记录不参与轮转」都是**客户端规则**，服务端不做任何解释，只保证字段能存能取、`coalesce` 不被旧客户端清空。
17. **`X-Real-IP` 只在 `TRUST_PROXY=true` 时才采信**——否则直连端口的人换个头就绕过所有 IP 限流（v3.4）。
18. **删除账号走一条 `delete from users`**，依赖外键级联；新增业务表时必须写 `references users(id) on delete cascade`，否则会留下孤儿行，等于「说得删、实际没删干净」。

---

## 9. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-29 | 初版：`/me` `/sets` `/plans` `/programs` 等端点，plans 服务端生成 |
| v2 | 2026-10-29 | 写入口收成唯一 `/sync`；游标从时间戳改为服务端版本号 `rev`；配置文档合并设置/换动作/自定义方案；训练日队列不进服务端 |
| **v3.2** | 2026-10-31 | 合入训练日程的前置字段：`sets` 新增可空 `blockId` / `trackVer`（`coalesce` 合并，服务端只存不算）；`pagePull` 重构成「统一行引用 + 类型标签」的 N 路归并（行为不变，为后续加 `cardio` / `agendas` 表铺路） |
| **v3.1** | 2026-10-31 | 修复：workouts 合并结果不回传给上传方，两端会不一致；`sets` 新增可空 `warmup`（热身组，`coalesce` 合并） |
| **v3** | 2026-10-31 | 合入训练记录模块（[`设计文档/训练记录.md`](../设计文档/训练记录.md)）：新增 `workouts` 表与 `WorkoutRow`；`sets` 新增 7 个可空字段（`null` 不覆盖已有值）；`/sync` 载荷扩展 `workouts`；拉取分页由两表扩到三表；`workouts` 按字段合并、`done` 由 sets 派生 |
| **v3.4** | 2026-11-11 | 上线加固：新增 `DELETE /api/account`（删除账号，级联清空该用户全部业务表，幂等）与 `POST /api/client-error`（客户端兜底错误上报，只记日志、免登录、8KB 体积上限）；限流改为**默认不采信 `X-Real-IP`**，只有 `TRUST_PROXY=true` 才按它算，避免直连端口时伪造头绕过限流 |
