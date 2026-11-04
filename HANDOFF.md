# 练界 — 项目交接（新对话开工先读这份）

> 换新对话时，第一句话直接说：**读一下 E:\wx小程序\HANDOFF.md，我们接着做**。
> 最后更新：2026-11-04 16:5x（`main` 已推进到 `0677811`，PR #37–#41 已合入）

## 一句话

微信**原生**小程序：健身训练记录 + 训练数据可视化，带**多设备同步**（自建 Go 后端）。单人用、纯本地优先、不社交、不卖课。

对标产品是「杯间餐时」（居家调饮社区），**只借视觉语言和产品形态，不抄内容结构**（用户明确反对换皮）。

## 分支地图（先看这里，别推错）

**2026-11-04 已收拢成一条线：只剩 `main`。**

| 位置 | 分支 | 指向 | 状态 |
|---|---|---|---|
| github | **`main`** | **`39652f7`** | **唯一主线**。已合入 feat/fonts-on-main 的全部内容：身体指标 P5 / 进步可视化 P7 / S7 部署 / 记录单位三态 / 详情页动作档案 |
| 本地 | **`main`** | `39652f7` | 与 github 同步；**它跟踪的是 `gitee/main`，所以 `git status` 会显示 ahead 63**，别被吓到 |
| 本地 | `backup/pre-main-merge` | `0f84b6e` | 合并前的临时备份，确认没问题后可 `git branch -D backup/pre-main-merge` |
| gitee | `main` | `452ad47` | **旧镜像，落后 63 个提交**，要同步得单独 `git push gitee main` |

远端：`gitee`(man-qianyi/lianjie) + `github`(yi199/lianjie，ssh://git@ssh.github.com:443)。

已删除的 8 个旧分支（内容都在 main 里，不用找回）：
`feat/fonts-tabbar` `feat/catalog` `feat/fonts-rebuild` `feat/fonts-rebuild-2`
`feat/safe-storage` `feat/fonts-on-main` `feat/backend-sync-design`（废弃）`feat/onboarding-rewards`

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
  pages/                8 页：welcome 引导 / today 今天 / record 记录 /
                        report 战报 / stats 数据 / my 我的 /
                        programs 方案中心 / builder 自建方案
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

## 红线（用户反复强调过）

- **不许照抄杯间餐时**：不能只把酒换成健身。文案、结构、图形都要自己长出来。
- **版权**：不用第三方图片、图标库、字体文件。图形用 Pillow/SVG 自绘，字体用 OFL 开源字体子集化。
- **不做**：付费抽奖/盲盒、排行榜、身材对比图、AR 体型扫描。
- 不输出任何令牌、密码、连接字符串到聊天或文件。

## 当前状态

### 已完成

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
- **上线加固 P0-1（2026-11-04）**：`utils/safeStorage.js` 成为**唯一**的本地写入入口（storage / catalog / db / sync 全部改走它）。本地空间满时 `wx.setStorageSync` 抛异常不再冒到页面；storage 层写失败即丢内存缓存回落到磁盘真相（宁可少显示，不做「看着有、重进就没」）；提示只弹一次、带真实用量。索引 key 写失败时不写半截（`migrateLegacy` 失败保留老 key 下次重来）。**`test.js` 第 21 节 5 项**专门测这条路径（monkey-patch 让 `lj.sets.*` 写失败）→ 七套 **614 项**全绿。
- **上线加固 P0-2（2026-11-04）**：`project.config.json` 的 `packOptions.ignore` 排掉 8 个 `test*.js`（**156KB** 不再进线上包）。

### 未完成 / 在飞

- **★ 待拆的下几批 PR（47 文件 / 4355 行，都在 `feat/fonts-on-main` 上）**。按 `git diff --stat github/main feat/fonts-on-main` 看真实剩余，能干净拆成 4 个主题：

  | 主题 | 主要文件 | 规模 |
  |---|---|---|
  | 身体指标 P5 v0.1 | `pages/metrics/*`、`utils/metricChart.js`、`storage.js` 的 metric 段、`test-metrics.js`、`docs/设计文档/身体指标.md` | 200+ |
  | 进步可视化 P7 V1+V2 | `utils/progress.js`(697)、`data/progress-model.js`、`pages/progress/*`、`test-progress.js`(353)、示例数据两个提交 | **1400+** |
  | S7 部署 | `server/deploy/*`、`docker-compose.yml`、`.env.example` | 270+ |
  | 真后端测试 C6 | `test-sync-real.js` | 212 |

  注意：`storage.js` / `sync.js` 在这批里是**按 hunk 混主题**的（safeStorage 的改动已经拆走了，剩下的是 metrics 载荷），cherry-pick 时要看清 diff 别把 metrics 带错地方。
- **C6 测试补强**：双设备并发、分页、时钟偏差；`test-sync.js` 现在只有「顺序模拟换设备」，没有两套独立状态。
- **S7 部署实操**：配置齐了，缺「在一台真服务器上照 README 走一遍」——证书签发、`limit_req` 生效、备份还原演练都没验过。
- **P0 备案**：域名 + ICP。**只卡上线不卡开发**，第一天就该提交，现在还没开始。
- **P4 真机联调**：两台真机互相同步、弱网、杀进程、改时钟——**一次都没做过**（开发者工具≠真机）。
- **P5 身体指标**：M1–M3 已做（v0.1）；**剩下**：和进步可视化 V3 对接（体重换算自重负荷、力量水平评级）。
- **P6 上线准备**：隐私协议、数据导出/注销、监控告警、备份演练、灰度。
- **P7 进步可视化 V1 + V2**（2026-11-04，`9ce7717`）：`data/progress-model.js`（**纯参数表**：四种模型归属、体重系数、肌群参与度、进阶阶梯、噪声/停滞/起点参数）+ `utils/progress.js`（实际负荷、Epley+RIR 估算、序列/趋势/停滞事实/全身指数/肌群分摊/七类高光/数据质量）；`pages/progress` 整体变化页（指数、周走势、肌群、高光、动作榜可展开）+ 数据页入口。**`test-progress.js` 95 项**。示例数据默认不进统计，且铺了 12 周、带「涨→卡住→突破」的故事（点「示例数据」就能看到停滞提示和升级高光）。V3（体重/性别/评级/RIR 录入）与 V4 校准未做。
- **动作库 v1.3 · E1 服务端已完成**（2026-11-04）：`exercises` / `catalog_meta` / `user_exercises` 三张表；`GET /api/catalog?since=`（免登录、独立 IP 限流、`since>=rev` → 304 空 body、`order by hot desc,id`）；`GET /api/exercises/{id}`（要登录，`steps: string[]` + `imgDetail`，都可空）；`/sync` 加第 4 类资源 `customExercises`（LWW + 墓碑 + `rejected.kind=customExercise`）和 `catalogRev`；`cmd/seed-catalog` + `content/exercises.json`（105 个动作 / 18 个 hot）。后端 **76 项断言组全绿**（14 单元 + 23 集成，含四表分页、rev 区间、坏行隔离），HTTP 契约升到 **v3.3**。**E2（数据源）/ E3（我的动作页）/ E4（详情页）客户端三块均已完成**（见上）。
- **训练日程 / 有氧记录**：只有 v0.1 设计，无代码。

## 已知的坑

| 坑 | 表现 | 解法 |
|---|---|---|
| **Go 依赖下不来** | `go build` 报 `proxy.golang.org ... connection failed` | `export GOPROXY=https://goproxy.cn,direct`。本机直连不通，不加这条永远编译不了 |
| **改中文文案漏字** | 新字显示成方框（只在真机/工具里看得见） | 重做字体子集（命令见下）。先跑 `node _cache/check_font_chars.js` 看缺几个字 |
| **测试把日期写死** | 过几天跑就红，误以为是回归 | **已修（2026-11-03）**：`weeklyProgress(date)` / `alternatives(exId, planKey, date)` 都接受可选日期，测试传固定日期；示例数据改成「最近五周含今天」。以后新增用例别用 `D.today()` 当真值 |
| **换字体后文字被挤断** | 「4 × 10」断成两行、`一周 2 练` 的「练」掉下去压住标签行 | Space Grotesk 比 Georgia 宽。flex 行里的数字/短句加 `flex-shrink: 0; white-space: nowrap`（`.pss` / `.pm` 已加） |
| **WSL 里的 Postgres 会自己消失** | 后端突然全是 `500 DB_ERROR`（10s 超时），PG 日志里是「上次 09:13 干净关闭，09:24 才启动」，且这段时间写的数据可能丢 | WSL2 会空闲回收虚拟机。跑联调前先挂一个 `wsl -u root -- sleep infinity`（后台进程）把 VM 钉住；真要认真跑集成测试，用服务器上的 PG 或 Windows 原生安装 |
| **分支被删 / 推错** | `git fetch --prune` 后本地跟踪分支 `[deleted]`；或推了非当前分支显示 up-to-date | 先 `git branch --show-current`；工作分支 = `feat/fonts-on-main` |
| **Edge headless 截图** | 目标 HTML 被浏览器进程锁住，写入失败 | 换文件名再写 |
| **中文日期字距** | 套英文的 `0.26em` → "周 三 · 1 0 月 2 9 日" | 中文用 `.date`，字距 `0.06em` |
| **类名冲突** | `.today` / `.side` 在 demo 里撞名，布局塌 | 加前缀或改名 |
| **杠铃物理** | 每组加一片是错的 | 片数恒定，颜色逐个点亮表示进度 |
| **旧版本假数据** | 升级后仍显示 126 条假记录 | `db.migrate()` 清 `lj.seeded` |
| **8080 被别的进程（Docker）占** | 后端连不上 / 连错了进程 | `netstat -ano \| grep :8080` 找到占用者，再换端口或停它 |
| **`wx.login` 每次都是新用户** | 开发者工具里重新登录一次，数据就没了 | `config.js` 的 `DEV_LOGIN_CODE`：**开发版返回固定 code**，同步层据此走固定身份；只有非 develop 环境才走真实 `wx.login` |
| **拆 PR 脚本的 `git reset --hard`** | 开发者工具同时开着时，热重载读到「文件刚被删、还没写回」的瞬间：报 `app.json: 未找到 pages/xxx/index.wxml`，或者更阴的 `module 'utils/xxx.js' is not defined`（模块表里还挂着「已删除」状态，文件明明在磁盘上）。2026-11-04 13:06 那次 5 个新页面全报 ENOENT，就是 `_cache/build_tabbar_pr.sh` 的 reset 干的 | 跑这类脚本前先关掉模拟器；已经踩了分两步：① `cli.bat cache --clean compile --project ...` ② `touch` 引用它的模块（如 `utils/catalog.js`）逼编译器重新解析依赖图。判据是日志里出现 `Compiling utils/xxx.js suceess` |
| **字体子集是全局生成物** | 合完 PR 才发现界面出方框。`node test-*.js` 永远抓不到（缺字只在渲染时暴露），`check_app.sh` 也只比较字数不比较字符集 | **所有会改文案的 PR 合完之后最后重建**，否则每合一个就要补一次（2026-11-04 连着补了两次）。重建后必须按 cmap 实测：从 `.js/.wxml/.json` 剥掉注释取中文，与子集 cmap 求差集，测试文件和 `.wxss` 不计入 |
| **squash 合并让 rev-list 失真** | `git rev-list --count main..分支` 显示领先 32 个提交，实际内容早就合过一大半 | 看真实剩余量用 `git diff --stat main 分支`。拆 PR 从新 main 开分支 + cherry-pick，别再用旧基点 reset |

## 常用操作

```bash
# 七套自测（改完必跑，现在全绿 · 合计 595 项）
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
