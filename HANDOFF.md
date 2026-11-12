# 练界 — 项目交接（新对话开工先读这份）

> 换新对话时，第一句话直接说：**读一下 E:\wx小程序\HANDOFF.md，我们接着做**。
> 最后更新：2026-11-11（上线加固 + 纯本地定位 + 三件套 + 隐私页 + 合并进 main + 上线清单）

## 一句话

微信**原生**小程序：健身训练记录 + 训练数据可视化，带**多设备同步**（自建 Go 后端）。单人用、纯本地优先、不社交、不卖课。

> **产品定位（2026-11-11 定，别再绕回「要不要微信登录」）**：主打**轻量、无需登录**。
> 微信小程序的登录本来就是静默的（`wx.login` 无 UI），所以「无需登录」不需要额外做什么。
> **首版按纯本地发布**（`config.js` 的 `trial` / `release` 留空）。**后端与同步代码原样保留**
> （不删、不阉割），靠 `config.js` 一个开关随时能开 —— 见「架构与约定」第 12 条。
>
> ⚠️ **UI 口径（2026-11-11 用户当面纠正）**：**别在界面里反复强调「数据只在这台手机上 / 记得备份」**。
> 原话「绝大多数人也不是很会在意这个」。数据安全是工程顾虑，不该变成用户的日常负担：
> - 「数据」区**不摆常驻状态行**（纯本地时 `syncState === 'local'`，wx:if 直接不渲染；只有真连了云端、有东西要传才出现）；
> - 备份/恢复**收进一行「备份与恢复」+ 动作面板**，不各占一行；
> - 诊断信息收进页脚「反馈问题」，不进设置区；
> - 不在战报页/首页做「记得备份」的友情提示。
> 能力仍在（换手机、排障都得靠它），只是**低频动作不该占屏幕**。

对标产品是「杯间餐时」（居家调饮社区），**只借视觉语言和产品形态，不抄内容结构**（用户明确反对换皮）。

## 分支地图（先看这里，别推错）

**`main` 是唯一主线。`feat/*` 是协作者 Jaserのaiyi 的分支 —— 只看不动，删别人的分支是红线。**

| 位置 | 分支 | 指向 | 状态 |
|---|---|---|---|
| **本地 + 远端** | **`main`** | **`849aad2`** | **主线。两个远端已同步到同一提交，feat/dev 完全包含在里面**（2026-11-11 合并） |
| **本地 + 远端** | **`feat/dev`** | **`3547078`** | **日常工作分支**。所有修改先提交到这里，稳定后再合 main |
| github | `feat/fonts-tabbar` `feat/catalog` `feat/fonts-rebuild` `feat/fonts-rebuild-2` `feat/safe-storage` | `b78a4ee` `17c559a` `f2e72f6` `1bb28cb` `05b291b` | **协作者的分支**（对应 PR #37–#41，内容已进 main）。**不要删**，即使看起来"已经合并了" |
| gitee | `feat/dev` `feat/backend-sync-design` `feat/onboarding-rewards` | `3547078` `f055522` `452ad47` | gitee 上也有 feat/dev 了（2026-11-11 新建）；后两个是历史残留 |
| 本地 | `feat/backend-sync-design` `feat/onboarding-rewards` | `f055522` `452ad47` | 历史残留，远端本来就没有这两个 |
| 本地 | `backup/pre-main-merge` `backup/pre-merge-20261111` | `0f84b6e` `3547078` | 合并前的临时备份，确认跑得没问题后可 `git branch -D` |

远端：`gitee`(man-qianyi/lianjie) + `github`(yi199/lianjie，ssh://git@ssh.github.com:443)。

2026-11-04 删过**自己的** `feat/fonts-on-main`（已合并进 main）；同一天新开了 `feat/dev` 作为日常分支。
2026-11-11 把 `feat/dev`（13 个提交）用 `--no-ff` 合进 main，**在 main 上重跑过七套 751 项 + `check_app.sh` + `go test`**，然后两个远端一起推到 `849aad2`（gitee 的 main 从此不再落后）。

### ★ squash 合并的坑（2026-11-04 踩到，已处理完）

主线用 **squash** 合并，每个 PR 压成一个新 SHA，**源分支与 main 失去血缘**：
`git rev-list --count github/main..feat/fonts-on-main` 会给出 32 这种假数字。

**判断一个分支能不能删，不能看 `--is-ancestor`，要看内容**：
`git diff --shortstat main <branch>` —— 为空、或差异只体现"main 比它多"，才是真合并了。
合并时同理：先 `git diff main <branch>` 确认分支是超集，再 `git merge <branch> -X theirs`，
冲突块全是"分支新增、main 侧为空"的那种。

## 怎么跑

```bash
# 七套自测都要绿（数据层 / 页面 / 同步 / 训练记录 / 进步 / 动作库 / 指标）
cd app && node test.js && node test-page.js && node test-sync.js && node test-training.js   && node test-progress.js && node test-catalog.js && node test-metrics.js

# 语法 / JSON / wxml 类名 / db 方法检查
bash _cache/check_app.sh
```

### 本地起后端（真库联调）

本机没有 Docker，Postgres 装在 **WSL Ubuntu 24.04** 里（PG 16.15），Windows 侧跑 Go 二进制：

```bash
# 1. 起库（WSL 里）
wsl -u root -- pg_ctlcluster 16 main start

# 2. 起后端（Windows，DEV_MODE + :18081）
bash _cache/run_api.sh        # 自动取 WSL IP 拼 DATABASE_URL，日志打在终端

# 3. 真链路自检：登录 / 推 / 幂等重推 / 换设备拉 / 墓碑 / LWW / 用户隔离 / 配置文档
python3.12 _cache/e2e_test.py

# 4. 后端 30 项测试（含 17 个集成，要真库）
cd server && TEST_DATABASE_URL="postgres://postgres:postgres@<WSL_IP>:5432/lianjie_test?sslmode=disable" \
  go test ./... -v
```

**★ WSL2 的 localhost 转发不可靠**：`DATABASE_URL` 用 `127.0.0.1:5432` 时，单个连接能通，但
`go test` 一并发就 `connection refused`（17 个集成测试全红）。必须用 WSL 的 IP
（`wsl -u root -- hostname -I`），`run_api.sh` 已经现取现用。

开发者工具（`E:\微信web开发者工具`，项目名 lianjian）里的 develop 版指向
`http://127.0.0.1:18081/api`，后端一起来它就会登录成 `dev-local-1` 并上传本地记录。

```bash
# 真机 / 模拟器
# 微信开发者工具 → 导入 E:\wx小程序\app → AppID: wxfbe33a79e7898c0a
# 详情 → 本地设置 → 勾「不校验合法域名」，后端走 http://127.0.0.1:18081
```

Windows + git-bash。`_cache/` 是本地产物目录（脚本、截图、字体源文件），**不进版本库**。

## 目录

```
app/                    小程序源码（唯一需要改的前端）
  pages/                13 页：welcome 引导 / today 今天 / record 记录 /
                        report 战报 / stats 数据 / my 我的 /
                        programs 方案中心 / builder 自建方案 /
                        metrics 身体指标 / my-exercises 我的动作 /
                        exercise 动作详情 / progress 进步 / privacy 隐私与协议
  components/set-row/   单组记录行（重量/次数可编辑，受控 input）
  data/                 exercises.js 105 个动作 / plan.js 训练日队列 /
                        programs.js 6 个官方方案 / fonts.js 字体 base64（勿手改）
  utils/                db.js 数据层（唯一读写入口）/ storage.js 分片存储+上传队列 /
                        sync.js 同步调度 / terrain.js 力量地形绘制 /
                        config.js 后端地址 / date.js / volume.js
  store/index.js        极简跨页通知
  test.js test-page.js test-sync.js test-training.js   四套自测
server/                 Go 后端（v2/v3 已实现，单体 + Postgres）
docs/                   文档体系（见下）
文档/                   产品说明 / 加入开发指南
原型/                   早期原型 HTML（本地保留、不入版本库；与工程是两份代码）
```

**docs/ 现在的结构**（朋友 11-01 重组，一份事实只写一处）：

```
上线清单.md              ★ 提审前照这个打勾（备案 / 类目 / 隐私指引 / 真机 14 项 / 审核话术 / 时间线）
技术方案.md              为什么这么设计（架构 / 同步协议 / 一致性取舍）
开发计划.md              阶段、模块、验收，带「状态」列
开发标准.md              「改动怎么做才不算错」：文档纪律 / 接口纪律 / 硬约束
接口/HTTP契约.md         端点、字段、校验、错误码（原「后端接口契约」）
接口/训练记录.md          客户端数据层函数签名、状态
设计文档/<模块>.md        每个模块的表、业务规则、边界（动作库 / 训练记录 / 训练日程 / 有氧记录 / 进步可视化）
```

## 架构与约定（破坏这些就会重蹈覆辙）

1. **原生小程序，不用 uni-app**。调试直接对应源码，不要引入编译层。
2. **所有数据读写只走 `app/utils/db.js`**。页面里不准直接碰 `wx.getStorageSync`；`storage.js` 只准 `db.js` 和 `sync.js` 引用。将来换后端只改这两个文件。
3. **本地存储按月分 key**（`lj.sets.YYYY-MM`），训练记录按年分（`lj.workouts.YYYY`）。单 key 上限 1MB，塞一个 key 约 31 个月写满。
4. **字号只用令牌**（`app.wxss` 的 `--fs-*`，现在 **8 档**：19/24/30/38/46/60/76/96rpx）。曾经出现过 19–25rpx 七个近似字号用了 59 次，整页糊成一片灰。颜色同理，只用 CSS 变量。
5. **字体**：中文 `LJSans`（思源黑体 VF 子集）+ 英文数字 `LJGrotesk`（Space Grotesk），OFL 1.1 可商用，全部 base64 在 `data/fonts.js`，`wx.loadFontFace` 异步加载，失败静默回落系统黑体。**改中文文案必须重做子集**（见「常用操作」）。
6. **计划模型是「训练日排队」**：本周 N 次，A→B→C 轮流，跳过自动顺延。**不是**「周一推日、周三拉日」。
7. **力量地形是山脊线**：横轴 12 周，每周一个峰，折线不做平滑。**不是**部位雷达图（犯过一次，commit 88f0166 修的）。
8. **同步协议**：本地优先 + 服务端 `rev` 版本号游标 + LWW（客户端时刻，夹紧 2 分钟）+ 墓碑 `done=false`。撤销删除永远不物理删（会复活）。配置文档整份同步、服务端不解析。
9. **原型与工程是两份代码**。改工程的视觉后要同步 `练界_小程序演示.html`（生成脚本 `_cache/make_interactive.py`）。
11. **底部切换栏是自定义的**（`app/custom-tab-bar/`，`app.json` 里 `tabBar.custom: true`）。
   加新的 tab 页时，**必须在 onShow 里 `this.getTabBar().setData({ selected: N })`**，
   否则进来时高亮会停在上一个 tab；页面还要自己让出栏高
   （`padding-bottom: calc(var(--sp5) + 120rpx + env(safe-area-inset-bottom))`）。
10. **一个 PR 一件事，PR 描述写 `Closes #issue`**（见 `CONTRIBUTING.md` 和 `.github/pull_request_template.md`）。
11. **动作档案在本地**：`app/data/exercise-meta.js` 存表格里那 5 个展示列（难度 / 器材 / 主要肌群 /
    单双侧 / 类型），详情页「看讲解」把它们渲染成「动作档案」卡片。数据源是
    `健身动作库_105动作清单_v1.xlsx` 的「动作库」页；改表后重新生成该文件即可。
    详情页**只保留**：标签 / 动作名 / 插画（有图才显示）/ 一句话要点 / 动作档案。
    「怎么做」步骤和「怎么记」两块已按用户要求删除；`steps` 仍由后端提供，但页面不再渲染。
12. **★ 后端与同步代码是「保留的扩展能力」，不是死代码（2026-11-11）**。首版纯本地发布，但：
    - **一行都不许删**：`server/`、`utils/sync.js`、`utils/storage.js` 的待上传队列、`/api/*` 契约全部保留；
    - **开关只有一处**：`utils/config.js` 的 `trial` / `release`。留空 = 纯本地（sync 全部短路，零请求零定时器）；
    - **打开即接管历史**：纯本地模式下 `putLocal(row, track=false)`，行**不进队列**，所以光填地址只会把「以后新写的」传上去。
      为此 `sync.js` 里有 `backfillOnce()`：第一次真正和云端握手时调 `db.syncMarkAll()` 把本机历史一次性排进队列，
      用 `lj.sync.backfilled` 记住只做一次。**删掉它，「随时能开云端」就是一句空话。**
    - 验证：`test-sync.js` 第 16 节（假服务端）+ `test-sync-real.js` 第 7 节（真库：纯本地 3 组 → 填地址 → 上云 → 换设备拉回 → 不重推）。

## 红线（用户反复强调过）

- **不许照抄杯间餐时**：不能只把酒换成健身。文案、结构、图形都要自己长出来。
- **版权**：不用第三方图片、图标库、字体文件。图形用 Pillow/SVG 自绘，字体用 OFL 开源字体子集化。
- **不做**：付费抽奖/盲盒、排行榜、身材对比图、AR 体型扫描。
- 不输出任何令牌、密码、连接字符串到聊天或文件。

## 当前状态

### 已完成

- **★ 地形为何改按「组数」画（2026-11-11）**：数据页山脊线的纵轴从「吨」改成「每周完成组数」。
  - 起因：用户在真机/截图上看图时问「有些运动没有吨啊」——**自重（俯卧撑/引体/徒手深蹲）和计时（平板支撑）都没有「重量×次数」**，动作库 105 个动作里 **51 个自重 + 10 个计时**，超过一半没有吨。
  - 旧口径的后果：混练的人只看到举铁那部分，纯自重的那几周**塌成贴地的深谷**，像「白练了」。旧代码只在「整段时间完全没负重」时才退回组数，是半兜底。
  - 现在：`utils/terrain.js` 新增 `seriesOf(weeks)`，纵轴固定取 `weeklyVolume()` 的 `sets` 列；小字固定「每周完成 · 组」。**吨没消失**——它在 TOTAL / BEST 两张卡里（TOTAL 小字改成「吨 · 负重累计」，说清只算负重）。
  - 代价（接受）：地形看不出强度（8 组轻和 8 组重一样高）。强度由力量水平 / 进步指数 / PR 三处负责，地形只回答「这周练了多少」。
  - 连带改了**示例数据**：`data/plan.js` 加 `DEMO_ATTEND`（每周练几次：`[3,3,3,2,3,3,3,1,3,3,2,3]`）+ 每次最后一组偶尔少做 1–2 组（确定性抖动，不用随机数）。否则十二周每周都是 47 组，地形会画成**一块砖**（或整齐的等距锯齿，一眼假）。
  - 测试 +3：`seriesOf` 只认 sets 列、吨为 0 的那周仍有正常高度。七套 **754 项**。

- **★ 隐私政策 + 用户协议（2026-11-11）**：新页面 `pages/privacy`（一页两节，13 个页面）。
  - 文案与实现严格对齐：**不注册、不登录、不联网**，数据只在本机；唯二离开手机的动作是用户主动点「备份」/「诊断信息」（都只进系统剪贴板）。
  - 覆盖审核会看的点：收集了什么（没有）、数据存哪、怎么删（`删除我的全部数据`）、训练风险免责、未成年人、条款更新、联系渠道（小程序「反馈与投诉」）。
  - 入口两处：**引导页底部「继续即表示同意《隐私政策与用户协议》」**、我的页页脚「隐私政策 · 用户协议」。
  - ⚠️ **文案与实现必须同步**：哪天给 `config.js` 的 `release` 填域名、开云同步，这一页必须改成「会上传哪些数据、存多久、如何撤回同意」，否则就是虚假陈述。
  - 测试：页面 9 项（含「关键条款不能被删掉」的反向断言 —— 直接断言 wxml 里有「不收集」「训练风险」「删除我的全部数据」），七套合计 **750 项**。
- **★ 纯本地三件套（2026-11-11）**：把「无需登录」这条路补齐到能用。
  - **备份 / 恢复**：`db.exportData()` 生成整份 JSON → 剪贴板；「从备份恢复」读剪贴板 → **先算账再确认**（「将恢复 3120 组…」）→ 落地。
    规则是 **只加不删**：同 id 比 `updatedAt`，新的赢；墓碑不导；示例数据不导；`app !== '练界'` 或不是 JSON 整份拒绝。
    这是纯本地路线换手机的**唯一出路**（没有账号，数据只能靠用户自己带走）。落地位置 `utils/storage.js` 的 `importRows/importWorkouts/importMetrics/importExercises` + `db.inspectImport/applyImport`。
  - **本地诊断日志**：新模块 `utils/diag.js`（只依赖 safeStorage，环形 40 条）。`report.send()` 现在**先把错误落本机再考虑上报** —— 纯本地模式没有服务端可发，这一步就是唯一的线索。
    「我的 → 诊断信息」一键复制（环境 / 存储用量 / 本机数据量 / 最近错误）。
  - **文案去技术化 + 入口合并**：删掉独立的「同步」栏，并进「数据」区顶部一条状态行（纯本地显示「数据保存在这台手机上 / 换手机前用下面的『备份』带走」）；
    「删除账号 → 删除我的全部数据」；「重新引导」入口**删除**（三个旋钮能改设置，删数据能重来，两个入口做同一件事）；自建动作页脚、欢迎页提示里的「同步」字样全部换掉。
  - **顺手修掉一个真 bug**：`exportData` 里把 `metricKinds()` 返回的**定义对象**当 key 用过（`metricKinds()` 返回 `{kind,cn,unit…}`），
    导致「导出我的数据」里**身体指标永远是空的**。上一轮就写错了，这轮被导入往返测试抓出来。
  - 验收：七套 **750 项全绿**（+40/累计：数据层 18 / 页面 20 / 诊断 2）、`check_app.sh` 全过、字体子集 984 字 / 380KB（cmap 实测 0 缺字）、我的页渲染截图逐行核对无遮挡。
- **★ 纯本地定位落地（2026-11-11）**：产品定为「轻量、无需登录」，首版纯本地发布；后端与同步代码原样保留。
  发现并修掉扩展性的真漏洞：纯本地模式下 `putLocal(row, track=false)` 让行不进待上传队列，**光给 config.js 填地址只会把「以后新写的」传上去，历史全留在手机里**（`db.syncMarkAll()` 早就写好了，但生产代码从没调过）。
  现在 `sync.js` 的 `backfillOnce()` 在第一次真正握手时自动全量入队（`lj.sync.backfilled` 记住只做一次）。
  七套自测 **710 项全绿**（+5）；`test-sync-real.js` 新增第 7 节，用真库验证「纯本地 3 组 → 填地址 → 上云 → 换设备拉回 → 之后只推新行」。
- **★ 上线加固第一轮（2026-11-11）**：把「上线前代码审计」里能自己改的五条全部落地。
  - **全局错误兜底**：`utils/report.js`（叶子模块，只依赖 config）+ `app.js` 的 `onError`/`onUnhandledRejection`/`onPageNotFound`；节流（同一错误 60 秒一次、单次启动最多 20 条）、纯本地模式**一行请求都不发**；`onPageNotFound` 顺手 `reLaunch` 回首页，不让用户停在白屏。
  - **后端 `POST /api/client-error`（v3.4）**：免登录、8KB 体积上限、字段长度上限、`kind` 白名单、按 IP 独立限流；**只记日志不落库**，栈里的换行压成 `⏎` 保证一条错误占一行。
  - **删除账号（合规）**：后端 `DELETE /api/account` 一条 `delete from users` 走外键级联（五张业务表都带 `on delete cascade`），幂等；客户端「我的 → 数据 → 删除账号」二次确认 → `sync.deleteAccount()` → `db.resetAll()` → 回引导页。**成功后必须清 token/游标**，否则下次请求会 401 重登、建新号再把本地残留推上去。
  - **导出数据**：`我的 → 导出我的数据` 把 profile / sets / metrics / 自建动作 / 自建方案打成 JSON 复制到剪贴板（纯本地生成，不需要后端）。
  - **限流信任开关**：`ratelimit.go` 的 `X-Real-IP` 改成只有 `TRUST_PROXY=true` 才采信，默认按 `RemoteAddr`；`.env.example` 与 `deploy/README.md` 已写「前面有 Nginx 才打开」。
  - **胶囊适配**：`app.js` 用 `getMenuButtonBoundingClientRect` 算 `capsulePad`（拿不到时按右边距 7 + 宽 87 兜底）；记录页「换一个」、动作页/进步页的右上英文小标加 `padding-right`，不再被胶囊盖住（之前 iPhone 上那块按钮被系统层吃掉点击）。
  - **验收**：七套自测 **705 项全绿**（+21）、`check_app.sh` 全过、字体子集重建到 **925 字 / 360KB**（`check-font-cmap.py` 0 缺字）、Go 单测 + `TRUST_PROXY` / 错误上报 / `oneLine` 共 8 项新增；**用 WSL 真 PG 跑了全套集成测试（含新的 `TestIntegrationDeleteAccount`）全 PASS**，临时库跑完已 `drop`。
- **★ 2026-11-04 主线合并**：`github/main` 从 `5c530a9` 推到 `0677811`，一口气合了 5 个 PR —— #37 字体 + 自定义 tabBar、#38 动作库 E1–E4、#39 字体补动作库新页面的 7 个缺字、#40 本地写满不丢数据（`safeStorage`）、#41 补安全存储提示里的 3 个字。
  - 合并前先在独立 worktree 里预演过：tabbar 零冲突，catalog 只有 `app/utils/db.js` 的 `alternatives` 一处 8 行冲突（取 `CAT.candidates`）。
  - **合完在真实 main 上复验**：449 项测试全过、0 缺字、字体子集 319KB。
  - 剩下 **47 文件 / 4355 行** 还在 `feat/fonts-on-main` 上，见「未完成」。
- **P1 后端 S1–S8**：鉴权、存储与迁移、`/sync` 推拉（rev 游标 / LWW / 时钟夹紧 / 落败行回推 / 去回声）、只读查询、限流探针、集成测试。
- **S7 部署配置已写好**：`server/deploy/`（`nginx.conf` TLS + `limit_req` + `X-Real-IP`、`proxy_common.conf`、`backup.sh` 每日 pg_dump 留 14 天、`README.md`）。**但一次都没在真服务器上跑过。**
  - **2026-11-04 已首次跑通真库**：WSL 里装 PG 16，`go test` 30 项全 PASS（含 17 个集成）。
- **前后端真链路已验证**（2026-11-04）：Go 后端 :18081 + 真 Postgres，`_cache/e2e_test.py` 14 项全过
  （登录 / 推 3 组 / 幂等重推 applied=0 / 换设备全量拉 / 墓碑可传播 / 旧值不覆盖 / 用户隔离 / 无 token 401 / 配置文档跨设备）。
  同一时刻开发者工具里的小程序自动登录成 `dev-local-1` 并上传了本地记录（3 组 + 1 次训练 + 配置），库里有据可查。
- **P2 前端存储 C1/C2**：`storage.js` 分片 + 待上传队列；`db.js` 全部改走它；`uncheckSet` 修掉「取消勾选不落库」的老 bug。**对页面的方法签名一个没变**。
- **P3 接入同步 C3/C4/C5**：`sync.js`（单飞 / 防抖 / 分批 / 退避 / 401 重登）；`config.js` 按环境选地址，留空 = 纯本地；`app.js` 启动链路；welcome 从服务端恢复引导态；today/stats 收到远端变更刷新；my 页清空文案。
- **★ M1 端到端**：朋友已在微信开发者工具里跑通（记录 → 上传 → 换设备拉回、断网补传）。
- **训练记录 v0.3（部分）**：`workouts` 表、`sets` 新增 `blockId` / `trackVer` / `rir` / `assist`，「先选动作再记组」「热身组」「跨零点算哪天」。**多训练块还没实现**。
- **字体（我们这条线独有）**：思源黑体 VF + Space Grotesk，770 字子集，303KB（抽字时跳过注释，注释里的字不进包）。
- **P5 身体指标 v0.1**（2026-11-04）：`pages/metrics`（体重/体脂率/腰围/静息心率，大数字 + 趋势图 + 最近记录 + 底部录入）、`utils/metricChart.js`、`storage.js` 加 metrics 分片与 `m:` 队列、`db.js` 加 8 个接口、同步载荷接上 `metrics`；40 项自测。评级与自重负荷换算（V3）仍未做。
- **动作库 E2 客户端数据源**（2026-11-04）：`utils/catalog.js`（269 行）成为动作数据的唯一入口——服务端清单 `/ 自建 / 包内快照` 三路合一，`retired` 过滤、换动作候选、选动作面板、详情缓存（7 天 TTL + 50 条 LRU）、变更通知、清空。`db/storage/sync/plan/builder` 全部改走它；自建动作 `u-` id 规则（≤16 字节）、墓碑、`x:` 上传队列（排在批次最前）、`customExercises` 同步载荷。**`test-catalog.js` 68 项**。
- **记录页交互收紧**（2026-11-04，`6b45f3d`）：打勾前必须填数字（负重看重量、自重/计时看次数秒数，底部「完成这组」走同一条校验）；已完成的组点勾要 showModal 二次确认（默认「不动它」）才撤销；已完成的组也不能被改成非法值（清空重量会被拒）。`test-page.js` 95 项。
- **动作库 E3 我的动作页**（2026-11-04，`8048109`）：`pages/my-exercises` 列表/新建/编辑/删除（名字·部位·场所·记法·要点，满 30 个给提示，被服务端拒绝的行标红显示原因）；「我的」页加入口；`db.suggestWeight` 改走 `CAT.find`（自建动作也能算加重档位）、`makeBlock` 兜底优先用行里的 `exCn`（不再把 `u-` id 漏到界面）；`test.js` +2 项。
- **动作库 E4 动作详情页**（2026-11-04，`699c254`）：`pages/exercise`——骨架同步渲染（名字/英文/部位·场所·记法/要点/怎么记全走本地 `catalog.find`），再异步 `catalog.detail(id)` 拉 `steps` + `imgDetail`（缓存 7 天 TTL + 50 条 LRU 由 catalog 负责，页面不自己实现）；没图给虚线占位不空白、图挂了 `binderror` 就当没图、讲解拉不到显示「讲解没拉到 + 再试一次」而要点照旧；自建动作不打后端。训练页动作名旁加「看讲解 ›」入口。`test-page.js` +19 项。
- **自定义底部 tabBar**（2026-11-04）：`app/custom-tab-bar/`，纸面底 `#EDE8D9`（比页面深一档）+ 上沿细线 + 选中项陶土色小把手 + 按压缩放；栏高 92rpx（≈原生）。三个 tab 页 `onShow` 里 `getTabBar().setData({selected})`，页面自己让出 `104rpx + 安全区`。
- **文档体系**：拆成 `接口/` + `设计文档/`，新增 `开发标准.md`、`CONTRIBUTING.md`、PR 模板。
- **上线加固 P0-1（2026-11-04）**：`utils/safeStorage.js` 成为**唯一**的本地写入入口（storage / catalog / db / sync 全部改走它）。本地空间满时 `wx.setStorageSync` 抛异常不再冒到页面；storage 层写失败即丢内存缓存回落到磁盘真相（宁可少显示，不做「看着有、重进就没」）；提示只弹一次、带真实用量。索引 key 写失败时不写半截（`migrateLegacy` 失败保留老 key 下次重来）。**`test.js` 第 21 节 5 项**专门测这条路径（monkey-patch 让 `lj.sets.*` 写失败）→ 七套 **630 项**全绿。
- **力量地形纵轴（2026-11-05，`eb6281e`）**：左边三档刻度（顶 / 中 / 0）+ 轴线 + 两条极淡虚线；上限定在 1/1.5/2/2.5/3/4/5/6/8×10ⁿ 整档，最高峰留一成余量；山脚收在 0 基线；单位由「每周容量 · 吨/组」小字交代。演示页 `练界_小程序演示.html` 同步改（该文件被 `.gitignore:59` 忽略，不进库）。
- **上线加固 P0-2（2026-11-04）**：`project.config.json` 的 `packOptions.ignore` 排掉 8 个 `test*.js`（**156KB** 不再进线上包）。

- **力量水平 V3（2026-11-05）**：`data/strength-standard.js`（5 个标准动作 × 男/女 × 四档门槛，**参考值不是研究数据**，界面标「仅供参考」）+ `utils/strength.js`（估算 1RM ÷ 体重 → 新手/入门/中级/进阶/精英，缺性别或缺体重就只提示缺什么，绝不编默认值）；性别 / 出生年份进配置文档（`saveProfile` 显式传空才清除，改计划不会抹掉）；进步页新增「力量水平」栏（**放在空态之外**——只练过一次的人也看得到），五档小圆点 + 距下一档还差多少。`test-progress.js` 95 → 115 项。**RIR 录入界面仍未做**（字段早就有了）。
- **同步可见（2026-11-05）**：我的页「同步」栏四态（本地模式 / 正在同步 / 没传上去 / 已同步 + 上次多久前），页面可见时 3 秒轮询自动更新；**只有失败态才出现「重试」**——同步本来就是全自动的（2 秒防抖 + 指数退避 + 空闲轮询），不该给用户一个「要按一下」的按钮。删掉「数据只存在这台手机里，不上传」那句错话。
- **补录与回看（2026-11-05）**：数据页日历格子可点 → 那天战报（战报认日期，过去那天说「那天」、按钮变「回到数据」）；身体指标页可把日期往回翻着录（今天 / 昨天 / 10.03），记录行点一下切到那天、每行都能删。
- **P7 进步可视化 V1 + V2**（2026-11-04，`9ce7717`）：`data/progress-model.js`（**纯参数表**：四种模型归属、体重系数、肌群参与度、进阶阶梯、噪声/停滞/起点参数）+ `utils/progress.js`（实际负荷、Epley+RIR 估算、序列/趋势/停滞事实/全身指数/肌群分摊/七类高光/数据质量）；`pages/progress` 整体变化页（指数、周走势、肌群、高光、动作榜可展开）+ 数据页入口。**`test-progress.js` 95 项**。示例数据默认不进统计，且铺了 12 周、带「涨→卡住→突破」的故事（点「示例数据」就能看到停滞提示和升级高光）。V3（体重/性别/评级/RIR 录入）与 V4 校准未做。
- **动作库 v1.3 · E1 服务端**（2026-11-04）：`exercises` / `catalog_meta` / `user_exercises` 三张表；`GET /api/catalog?since=`（免登录、独立 IP 限流、`since>=rev` → 304 空 body、`order by hot desc,id`）；`GET /api/exercises/{id}`（要登录，`steps: string[]` + `imgDetail`，都可空）；`/sync` 加第 4 类资源 `customExercises`（LWW + 墓碑 + `rejected.kind=customExercise`）和 `catalogRev`；`cmd/seed-catalog` + `content/exercises.json`（105 个动作 / 18 个 hot）。后端 **76 项断言组全绿**（14 单元 + 23 集成，含四表分页、rev 区间、坏行隔离），HTTP 契约升到 **v3.3**。**E2（数据源）/ E3（我的动作页）/ E4（详情页）客户端三块均已完成**（见上）。

### 未完成 / 在飞

- ~~待拆的下几批 PR~~ **已作废**：`feat/fonts-on-main` 已于 2026-11-04 19:23 整体合进 `main`（merge `39652f7`），身体指标 P5 v0.1 / 进步可视化 P7 V1+V2 / S7 部署配置 / 真后端测试 `test-sync-real.js` 现在都在 main 里。
- **C6 测试补强**：双设备并发、分页、时钟偏差；`test-sync.js` 现在只有「顺序模拟换设备」，没有两套独立状态。
- **S7 部署实操**：配置齐了，缺「在一台真服务器上照 README 走一遍」——证书签发、`limit_req` 生效、备份还原演练都没验过。
- **P0 备案**：域名 + ICP。**只卡上线不卡开发**，第一天就该提交，现在还没开始。
- **P4 真机联调**：两台真机互相同步、弱网、杀进程、改时钟——**一次都没做过**（开发者工具≠真机）。
- **P5 身体指标**：M1–M3 已做（v0.1）；和 V3 的对接（体重换算自重负荷、力量水平评级）2026-11-05 已补完。
- **P6 上线准备**：~~隐私协议 / 用户协议页面~~ **已做（`pages/privacy`，2026-11-11）**；剩下**后台「用户隐私保护指引」还得你自己填**（纯本地版可声明不采集个人信息）、监控告警与灰度未做。~~数据导出 / 注销~~ **已完成（2026-11-11）**；~~换手机带数据~~ **备份 / 恢复已完成（2026-11-11）**。
- **训练日程 / 有氧记录**：只有 v0.1 设计，无代码。

## 已知的坑

| 坑 | 表现 | 解法 |
|---|---|---|
| **Go 依赖下不来** | `go build` 报 `proxy.golang.org ... connection failed` | `export GOPROXY=https://goproxy.cn,direct`。本机直连不通，不加这条永远编译不了 |
| **地形画成一块砖 / 整齐锯齿** | 示例数据每周组数一模一样，山脊线变成平顶矩形 | 改 `data/plan.js` 的 `DEMO_ATTEND`（漏课要不规律）+ 每次少做 1–2 组。**改了地形口径就要顺手看一眼示例数据的形状**，否则用户点「示例数据」看到的是一张坏图 |
| **改中文文案漏字** | 新字显示成方框（只在真机/工具里看得见） | 重做字体子集（命令见下）。先跑 `node _cache/check_font_chars.js` 看缺几个字 |
| **测试把日期写死** | 过几天跑就红，误以为是回归 | **已修（2026-11-03）**：`weeklyProgress(date)` / `alternatives(exId, planKey, date)` 都接受可选日期，测试传固定日期；示例数据改成「最近五周含今天」。以后新增用例别用 `D.today()` 当真值 |
| **换字体后文字被挤断** | 「4 × 10」断成两行、`一周 2 练` 的「练」掉下去压住标签行 | Space Grotesk 比 Georgia 宽。flex 行里的数字/短句加 `flex-shrink: 0; white-space: nowrap`（`.pss` / `.pm` 已加） |
| **WSL 里的 Postgres 会自己消失** | 后端突然全是 `500 DB_ERROR`（10s 超时），PG 日志里是「上次 09:13 干净关闭，09:24 才启动」，且这段时间写的数据可能丢 | WSL2 会空闲回收虚拟机。跑联调前先挂一个 `wsl -u root -- sleep infinity`（后台进程）把 VM 钉住；真要认真跑集成测试，用服务器上的 PG 或 Windows 原生安装 |
| **分支被删 / 推错** | `git fetch --prune` 后本地跟踪分支 `[deleted]`；或推了非当前分支显示 up-to-date | 先 `git branch --show-current`；工作分支 = **`feat/dev`**（2026-11-04 起） |
| **Edge headless 截图** | 目标 HTML 被浏览器进程锁住，写入失败 | 换文件名再写 |
| **中文日期字距** | 套英文的 `0.26em` → "周 三 · 1 0 月 2 9 日" | 中文用 `.date`，字距 `0.06em` |
| **类名冲突** | `.today` / `.side` 在 demo 里撞名，布局塌 | 加前缀或改名 |
| **杠铃物理** | 每组加一片是错的 | 片数恒定，颜色逐个点亮表示进度 |
| **旧版本假数据** | 升级后仍显示 126 条假记录 | `db.migrate()` 清 `lj.seeded` |
| **8080 被别的进程（Docker）占** | 后端连不上 / 连错了进程 | `netstat -ano \| grep :8080` 找到占用者，再换端口或停它 |
| **`wx.login` 每次都是新用户** | 开发者工具里重新登录一次，数据就没了 | `config.js` 的 `DEV_LOGIN_CODE`：**开发版返回固定 code**，同步层据此走固定身份；只有非 develop 环境才走真实 `wx.login` |
| **拆 PR 脚本的 `git reset --hard`** | 开发者工具同时开着时，热重载读到「文件刚被删、还没写回」的瞬间：报 `app.json: 未找到 pages/xxx/index.wxml`，或者更阴的 `module 'utils/xxx.js' is not defined`（模块表里还挂着「已删除」状态，文件明明在磁盘上）。2026-11-04 13:06 那次 5 个新页面全报 ENOENT，就是 `_cache/build_tabbar_pr.sh` 的 reset 干的 | 跑这类脚本前先关掉模拟器；已经踩了分两步：① `cli.bat cache --clean compile --project ...` ② `touch` 引用它的模块（如 `utils/catalog.js`）逼编译器重新解析依赖图。判据是日志里出现 `Compiling utils/xxx.js suceess` |
| **`wx://not-found`（点某个页面就报）** | Console 报 `Component is not found in path "wx://not-found"`，栈里全是 `recurseComponentImpl`，**不给页面名也不给文件名**；从数据页点「强了多少」进进步页时必现（2026-11-05） | wxml 里只有 `view` / `text` / `block` 三个内置标签、开闭配平、页面 json 无组件声明、app.json 无全局组件 —— 静态查不出野组件。最后**同时**做了两件事才消失：① 清缓存重编译（批量脚本改过 wxml，编译产物可能是半截的）；② 把嵌套的 `<block wx:else>` 换成扁平 `<view wx:if>/<view wx:else>`，嵌套 `wx:for-item` 补 `wx:key`。两处一起改的，**没法定论是哪一处**。以后遇到按这个顺序：先清缓存 → 再查嵌套 block / 无 key 的 for-item → 最后用 `wx:if` 开关一行关掉可疑区块做二分 |
| **scroll-view 放进 flex 列里会把兄弟压扁** | iPhone 14 Pro 真机：建方案页的「选动作」抽屉，部位 chip 只剩半截、底部「已选 N 个 / 完成」整条消失（2026-11-08）。三版才收口：`flex:1;height:0`（aa053ed）真机仍复现；「外套 view + scroll-view 绝对定位撑满」（3395419）真机**更乱**；`f7d21ee` 版待真机确认（用户报「全乱」后改的第三版） | 根因是 scroll-view 内部有滚动层，不肯像普通 div 那样把「自动最小尺寸」缩到内容以下，用内容高度参与 flex 计算。**终版：让 scroll-view 只有一种高度来源——显式像素高度**：`.sheet` 不做 flex 列，`.sheeth` 定高 120rpx、`.parttabs` 死高 88rpx、`.sheetf` 定高 `calc(128rpx + env(safe-area-inset-bottom))`，列表 `height: calc(78vh - 44.8vw - env(safe-area-inset-bottom))`（44.8vw = 336rpx = 头 120 + chip 88 + 底 128；用 vw 不赌 rpx 在 calc 里的转换）。**别用 absolute 救**：微信里 scroll-view 靠绝对定位算不出高度，会塌成一团。渲染管线仍是 Chromium，只能证明算式自洽（393 视口 62.9+46.1+488.5+67.1=664.6=78vh、scrollH 2557/clientH 488），真机结论必须由用户确认 |
| **顶行右侧元素被胶囊压住** | 自定义导航（`navigationStyle: custom`）下，页面顶行右侧的按钮/英文小标在 iPhone 上正好落在微信胶囊下面，**系统层会吃掉那块点击**：记录页「换一个」点了没反应（2026-11-11 实测几何：iPhone 14 Pro 内容行 y 62–94、胶囊 y 59–91，水平重叠） | `app.js` 的 `capsulePad()` 用 `getMenuButtonBoundingClientRect` 算出「右侧要让出多少 px」（缺省按右边距 7 + 宽 87 兜底），顶行加 `style="padding-right:{{cpad}}px"`。**别用 `sbh`（状态栏高度）硬推** —— 它只管垂直，不管胶囊的宽度 |
| **并行会话 `reset --hard` 吞掉未提交改动** | 2026-11-04 19:21 另一个会话在同一工作树里 `git reset --hard` + 切分支，把未提交的 5 个文件改动整个清空（页面看着像「改回去了」，`git status` 却是干净的） | 收工前把改动落成提交，或至少 `git diff > _cache/xxx.patch`（`_cache` 被 ignore，不会被 reset 碰掉）；改代码前先 `git rev-parse --abbrev-ref HEAD` 确认落在哪条分支 |
| **字体子集是全局生成物** | 合完 PR 才发现界面出方框。`node test-*.js` 永远抓不到（缺字只在渲染时暴露），`check_app.sh` 也只比较字数不比较字符集 | **所有会改文案的 PR 合完之后最后重建**，否则每合一个就要补一次（2026-11-04 连着补了两次）。重建后必须按 cmap 实测：从 `.js/.wxml/.json` 剥掉注释取中文，与子集 cmap 求差集，测试文件和 `.wxss` 不计入 |
| **squash 合并让 rev-list 失真** | `git rev-list --count main..分支` 显示领先 32 个提交，实际内容早就合过一大半 | 看真实剩余量用 `git diff --stat main 分支`。拆 PR 从新 main 开分支 + cherry-pick，别再用旧基点 reset |

## 常用操作

```bash
# 七套自测（改完必跑，现在全绿 · 合计 750 项）
cd app && for f in test.js test-page.js test-sync.js test-training.js test-metrics.js test-catalog.js test-progress.js; do echo "--- $f"; node $f || break; done

# 同上但只报项数（_cache 不进版本库；没有就手敲上面那行）
bash _cache/run_tests.sh

# 语法 / JSON / db 方法 / 字体缺字，一把过（有失败项退出码 1）
bash _cache/check_app.sh

# 没有开发者工具时看页面效果：渲染成 HTML → 逐页截图 → 拼成对照图
RENDER_W=430 node _cache/render_pages.js   # 模拟 wx/Page/Component，跑 onLoad 拿 data，wxml 求值成 HTML
                                           # 判 UI 一律 430 宽（iPhone 15 PM）；不传 RENDER_W 仍是 375
bash _cache/shot.sh               # Edge headless 截 375×812 @2x（老脚本，430 见 shot_exercise.sh）
python3.12 _cache/stitch.py       # 拼成 _cache/grid1.png / grid2.png

# 双远端推送（先确认当前分支）
git branch --show-current
git push gitee <当前分支> && git push github <当前分支>

# 重新生成演示页（含地形/字体）
python3.12 _cache/make_interactive.py

# ★ 改文案后重做字体子集（漏字会显示成方框）
node _cache/check_font_chars.js                                      # 先看缺几个字
python3.12 _cache/collect_chars.py                                   # 抽字表
python3.12 -m fontTools.subset C:/Windows/Fonts/NotoSansSC-VF.ttf \
  --text-file=E:/wx小程序/_cache/fonts/chars.txt --flavor=woff2 \
  --output-file=E:/wx小程序/_cache/fonts/noto.sub.woff2
python3.12 _cache/make_fonts_js.py                                   # 生成 data/fonts.js

# 后端
cd server && export GOPROXY=https://goproxy.cn,direct
docker compose up -d db
go test ./...
```

## 用户偏好（影响怎么做，不只是做什么）

- 要先看效果再定：给对比图/截图，别只描述。
- 反感术语堆砌，先讲「是什么／跟我什么关系」。
- 对版权敏感，每个外来素材都要说清授权。
- 说「改好了」要核实文件，可能只做了一半——**先读文件再信**。
- 任务进度存桌面或根目录文档（像这份）；但简单答疑直接在对话里答，别为每句话生成文件。
- 要拍板时用编号选项写在正文里，他不用弹窗。
