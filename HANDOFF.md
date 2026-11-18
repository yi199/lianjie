# 力见 — 项目交接（新对话开工先读这份）

> 换新对话第一句：**读一下 E:\wx小程序\HANDOFF.md，读完用三句话复述，然后等指令**。
> 最后更新：**2026-11-18**（协议主动勾选整改；交接整理：历史归档到 docs/变更历史.md，本文只留现在有效的事实）
> 变更动机查 `docs/变更历史.md`（**别整读**，只在问「当时为什么这么做」时翻）。

## 一句话

微信**原生**小程序：健身训练记录 + 力量地形可视化。单人用、**纯本地优先**、不社交、不卖课。
带自建 Go 后端的多设备同步，但**首版纯本地发布**，后端代码原样保留（见约定 12）。

- 名字：**力见**（2026-11-13 定；旧名练界，代码里只在备份兼容处保留）。
- 对标「杯间餐时」：**只借视觉语言与产品形态，不抄内容结构**。
- ⚠️ **UI 口径**：别在界面里反复强调「数据只在这台手机 / 记得备份」（用户原话：「绝大多数人也不是很会在意这个」）。
  低频动作不该占屏幕：不摆常驻状态行、备份/恢复收进一行、诊断收进页脚「反馈问题」、不做备份提醒。

## 分支地图（先看这里，别推错）

**`main` 是唯一主线。`feat/*` 是协作者 Jaserのaiyi 的分支 —— 只看不动，删别人的分支是红线。**

| 位置 | 分支 | 指向 | 状态 |
|---|---|---|---|
| 本地 + 两远端 | **`main`** | **`c50c0b9`** | 主线；github / gitee 已回读一致 |
| 本地 + 两远端 | **`feat/dev`** | **`4ac25b4`** | 日常工作分支；提交先落这里，稳定后 `--no-ff` 合 main |
| github | `feat/fonts-tabbar` `feat/catalog` `feat/fonts-rebuild(-2)` `feat/safe-storage` | — | 协作者分支（内容已进 main）。**不要删** |
| 本地+gitee | `feat/backend-sync-design` `feat/onboarding-rewards` | `f055522` `452ad47` | 历史残留，内容已在 main |
| 本地 | `backup/pre-main-merge` `backup/pre-merge-20261111` | `0f84b6e` `3547078` | 合并前备份，确认无误可删 |

远端：`gitee`(man-qianyi/lianjie) + `github`(yi199/lianjie，走 `ssh://git@ssh.github.com:443`)。
**squash 合并会让 `rev-list` 失真**：判断分支能否删/是否真合并，看 `git diff --shortstat main <branch>`，别看 `--is-ancestor`。

## 怎么跑

```bash
# 七套自测（改完必跑）+ 分享快照（在飞时也要跑）
cd app && for f in test.js test-page.js test-sync.js test-training.js test-metrics.js test-catalog.js test-progress.js; do node $f || break; done
node test-share-snapshot.js        # 工作区有这份文件时才有（见「在飞」）

bash _cache/run_all_tests.sh       # 只报各套项数/失败数
bash _cache/check_app.sh           # 语法 / JSON / wxml 类名 / db 方法 / 字体缺字
```

- 开发者工具：导入 `E:\wx小程序\app`，AppID **`wxfbe33a79e7898c0a`**；详情→本地设置→勾「不校验合法域名」。
- 后端（可选，纯本地版用不到）：PG 在 WSL Ubuntu（`wsl -u root -- pg_ctlcluster 16 main start`），
  `bash _cache/run_api.sh` 起 `:18081`；`go test ./...` 需 `GOPROXY=https://goproxy.cn,direct`。
  **WSL2 会空闲回收 VM**，跑联调前挂一个 `wsl -u root -- sleep infinity` 钉住。
- Windows + git-bash；`_cache/` 是本地产物（脚本/截图/字体源），**不进版本库**。

## 目录

```
app/                  小程序源码（唯一要改的前端）
  pages/              13 页：shell（tab 容器）/ welcome / today / record / report / stats /
                      my / programs / builder / metrics / my-exercises / exercise / progress / privacy
  components/         set-row（组行）/ tab-today|tab-stats|tab-my（薄壳）/ tab-bar（底栏）
  data/               exercises 105 动作 / plan 训练日队列 / programs 6 方案 / fonts base64（勿手改）
  utils/              db 数据层（唯一读写入口）/ storage / sync / terrain / poster / config / date / volume
server/               Go 后端（保留的扩展能力）
docs/                 上线清单 / 提审操作手册 / 技术方案 / 开发计划 / 开发标准 / 接口 / 设计文档 / 变更历史
文档/                 产品说明、加入开发指南
原型/                 早期 HTML 原型（本地保留、不入库）
```

## 架构与约定（破坏这些就会返工）

1. **原生小程序**，不用 uni-app，不引入编译层。
2. **所有数据读写只走 `app/utils/db.js`**；页面里不准碰 `wx.getStorageSync`，`storage.js` 只给 db/sync 用。
3. **存储按月分 key**（`lj.sets.YYYY-MM`），单 key 1MB 上限。
4. **字号只用令牌**（`app.wxss` 的 `--fs-*`，8 档：**22/27/32/40/49/63/78/96rpx**）。写死 rpx 会被测试揪出来；改字号只改这一处。
5. **字体**：中文 `LJSans`（思源黑体子集）+ 英文数字 `LJGrotesk`（Space Grotesk），OFL 1.1，base64 在 `data/fonts.js`，`wx.loadFontFace` 异步加载。**改中文文案必须重做子集**。
6. **计划模型是「训练日排队」**：本周 N 次 A→B→C 轮流，跳过自动顺延。**不是**「周一推日」。
7. **力量地形是山脊线**：横轴 12 周、每周一峰、不做平滑；**不是**雷达图。纵轴是**组数**（自重/计时算不出吨），单位只在顶端刻度。
8. **同步协议**：本地优先 + 服务端 `rev` 游标 + LWW（夹紧 2 分钟）+ 墓碑 `done=false`，永不物理删。
9. **三个 tab 装在同一个 swiper 容器里**（`pages/shell` + `components/tab-*`）。`app.json` **没有 tabBar**，所以
   **全项目禁止 `wx.switchTab(` / `getTabBar(`**，一律 `utils/tabkit.goTab(i)` / `backToShell()`；每个 tab 自己套 `scroll-view`。
10. **动画只能加在「不含 `position: fixed` 后代」的容器上**（transform 会让后代 fixed 相对它定位）。
11. **顶行右侧禁放可点元素**：微信胶囊会吃掉点击（`padding-right` 让位实测无效）。按钮一律放到胶囊下沿以下。
12. **★ 后端与同步代码是「保留的扩展能力」不是死代码**：`server/`、`sync.js`、待上传队列、`/api/*` 一行都不许删；
    唯一开关是 `utils/config.js` 的 `trial`/`release`（留空 = 纯本地，sync 全短路）。开云端靠 `sync.backfillOnce()` 一次性接管历史。
13. **动效口径**：嫌平庸，要 spring / 胶囊滑块 / 跟手横滑；改交互前先做可交互 HTML 原型让他点选。
14. **一个 PR 一件事**；动作档案在 `data/exercise-meta.js`（改 xlsx 后重生成）。

## 红线（用户反复强调过）

- **不许照抄杯间餐时**（不能只把酒换成健身）。
- **版权**：不用第三方图片/图标库/字体文件；图形自绘、字体用 OFL 子集。
- **不做**：付费抽奖/盲盒、排行榜、身材对比图、AR 体测。
- 不输出任何令牌、密码、连接字符串到聊天或文件。
- **别回退已砍的东西**：示例数据入口、分步引导、「存成图片」、顶行右侧可点按钮 —— 都有反向断言守着。

## 当前状态（2026-11-18 快照，接手先复跑）

- `main` = `c50c0b9`（本地/github/gitee 三处一致）；`feat/dev` = `4ac25b4`。
- **七套自测 865 项全绿**、`check_app.sh` 全通过、字体字表 1002 / 代码用字 998 **0 缺字**（2026-11-18 实跑）。
- 主包约 1.3MB（上限 2MB）；AppID `wxfbe33a79e7898c0a`；`trial`/`release` 为空（纯本地）。
- 产品能力现状：一屏引导（默认值）→ 今天 → 记录（一键完成剩下的组）→ 战报（5:4 分享图 + 原生分享）→ 数据（组数地形）→ 我的。
- **没有相册权限**：存图功能已删，隐私能力声明只有**剪切板**（备份/恢复）。别再往回调。

### 在飞

- **协议主动勾选整改（2026-11-18）**：修 11-17 提审驳回「默认自动同意隐私政策」。welcome 勾选框默认不勾、未勾拦截开始（抖 480ms）；privacy 生效条款同步改；865 项测试 + 两态截图核验过，**未经真机验收、未重新提审**（见未完成第 1 项）。动机边界见 `docs/变更历史.md` 首条。

### 未完成（按优先级）
> **★ 重提审核**：11-17 首提被驳回（默认自动同意协议），0.1.4 整改代码已就绪——真机过一遍勾选手感 → 开发者工具上传 0.1.4 → 重提，备注照提审手册 §5.2-4 / §6。

1. **小程序备案未提交**（1–20 工作日，最长一环）。名称已定**力见**，**先到 MP 后台试改名称查重**（被占备选：力见记/力见训练记/今日力见），**名称与备案必须一字不差**。
2. **MP 后台**：用户隐私保护指引（只声明**剪切板**）、服务类目 **工具 → 健康管理**、基本信息、体验成员（约 15 人）。
3. **真机验收**（swiper 版从未逐项签字）：横滑跟手 / 点底栏同步 / 每 tab 滚到底 / 下拉刷新 / 数据页有山 / 详情返回不重启容器 / 一键完成按钮位置 / 分享卡片缩略图 / ··· 里是否有「分享到朋友圈」/ **分享快照只读态（编译→发给文件传输助手→点开只读→再转发不断链→「我也开始练」落点）**。
4. 给人体验：体验版**二维码 7 天失效** → 加体验成员 + 发小程序卡片，别发码图；简历只放视频 + GitHub（仓库已 public）。
5. 低优先：C6 测试补强（双设备并发/分页/时钟偏差）、S7 部署实操（证书/限流/备份演练）、训练日程与有氧记录（只有设计）。

## 已知的坑（一条顶半小时）

| 坑 | 解法 |
|---|---|
| 顶行右侧按钮点不到 | 微信胶囊吃掉点击（iPhone/小米都实测），`padding-right` 无效 → 挪到 y>95 内容区 |
| 删 tabBar 后点底栏没反应 | `wx.switchTab` 直接失败 → 全换 `tabkit.goTab/backToShell`，有断言禁它 |
| swiper 里内容划不动 | swiper-item 无页面级滚动 → 每个 tab 套 `scroll-view` |
| swiper 非当前项 canvas 量不到尺寸 | 用 `active` 驱动 + 延迟 80ms 重绘，绘制函数自己判 `w/h` 兜底 |
| 给容器加动画后 fixed 元素乱跑 | transform 改变 fixed 参照 → 动画只加在不含 fixed 后代的容器 |
| 页面之间转场做不出来 | WebView 写死右进左出（只有 Skyline 能自定义）→ 别在 `.page` 上加动画指望它 |
| scroll-view 放进 flex 列把兄弟压扁 | 只能靠**显式像素高度**（vw 算），别用 absolute 救 |
| 改中文文案出现方框 | 重做字体子集；`check_app.sh` 会按 cmap 报缺字 |
| 测试把「今天」写死 | 过一次日期就红（不是回归）→ 用例传固定日期，别用 `D.today()` 当真值 |
| 地形画成一块砖/整齐锯齿 | 改地形口径必须顺手看 `data/plan.js` 的示例数据形状 |
| 深色底 png 图标看不见 / 底栏滑动「闪一下」 | 图标用 `filter: brightness(0) invert(1)` 反相；底栏是每 tab 独立实例 → `globalData.tabFrom` 接力（先摆旧位，下一帧再滑） |
| 并行会话 `reset --hard` 吞改动 | 收工前落成 commit，或 `git diff > _cache/x.patch`；改代码前先看当前分支 |
| `wx://not-found` 报错不给页面名 | 先清缓存重编译 → 再查嵌套 `<block wx:else>` / 无 `wx:key` 的 for-item → 最后用 wx:if 二分 |
| 后端环境：PG 自己消失 / Go 依赖下不来 | WSL2 空闲回收 VM → 挂 `sleep infinity`；依赖走 `GOPROXY=https://goproxy.cn,direct` |
| Edge headless 截图不出文件 | 中文路径必须 `file:///` + %编码；失败就换 user-data-dir 或改用 Chrome |
| 改名后旧备份打不开 | 备份 `app` 标记改力见，但 `normalizeImport` **同时接受练界**——别「顺手清理」掉 |

## 常用操作

```bash
# 双远端推送（先确认分支是 feat/dev 还是 main）
git branch --show-current && git push gitee <b> && git push github <b>

# 没有开发者工具时看页面：渲染成 HTML → 截图（判 UI 一律 430 宽）
RENDER_W=430 node _cache/render_pages.js
bash _cache/shot.sh                      # Edge headless；Edge 抽风就换 Chrome

# 改文案后重做字体子集
bash _cache/rebuild_fonts.sh             # 内部：collect_chars → fontTools.subset → make_fonts_js

python3.12 _cache/make_share_preview.py   # 5:4 分享图预览
```

## 交接惯例

- **开工**：读这份 → `git fetch --prune && git status` → 复跑七套 → 三句话复述 → 等指令（别急着改代码）。
- **收工**：`docs/变更历史.md` 追加一条（日期+动机+影响）；这份只留「现在仍然有效的事实」，≤150 行。
- **用户偏好**：先给效果图再定方案；反感术语堆砌；说「改好了」要**先读文件核实**；拍板用正文编号选项。
