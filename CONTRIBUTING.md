# 协作规范

> 这个文件是为了减少沟通成本。看完再动代码。

## 一句话原则

**`main` 只放能跑的版本；所有改动走分支 + PR。**

---

## 1. 分支怎么开

```
main                      随时可演示、可编译的版本
├── feat/edit-weight      新功能
├── fix/timer-negative    修 bug
└── docs/collab-guide     只改文档
```

- 命名：`类型/简短英文描述`，全小写，用短横线
- 从最新的 `main` 切出来，别从别人的分支切
- 职责单一，一个分支只干一件事

```bash
git checkout main
git pull
git checkout -b feat/edit-weight
```

---

## 2. 提交信息怎么写

格式：`类型: 说明`

| 类型 | 什么时候用 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 只改文档 |
| `refactor` | 重构，不改行为 |
| `style` | 只改样式、格式 |
| `test` | 加或改测试 |
| `chore` | 配置、依赖、杂项 |

例：

```
feat: 记录页支持修改重量和次数
fix: 休息计时器在切后台后变成负数
docs: 补充协作规范
```

**说明部分说「做了什么」，不要写 "update" "fix bug" 这种没信息量的。**

---

## 3. PR 怎么提

1. 推分支到远程：`git push -u origin feat/edit-weight`
2. Gitee / GitHub 上发起 Pull Request，目标分支选 `main`
3. 描述里写清三件事：**改了什么 / 为什么改 / 怎么验证**
4. **描述里必须写 `Closes #<issue>`**（做了哪条就关哪条）
5. 至少 1 个人看过再合并
6. **合并后删掉分支**

合并方式建议用 **Squash**（把分支上的碎提交压成一个），`main` 的历史会干净很多。

### 为什么必须写 `Closes #N`

```markdown
## 改了什么
把取消勾选改成落库（墓碑）

Closes #21
```

漏写的话 issue **不会自动关闭**。做完了却还开着，issue 列表里就混着「已完成待关」和「真没做」两类，过一阵分不清哪些还需要动手——只能逐条去翻代码核对。

> 一个 issue 对应多个 PR 时，只在**最后一个** PR 里写 `Closes`；前面的 PR 用 `Refs #N` 引用即可。

合并完顺手看一眼 issue 是不是真关了；没关就手动关，并在评论里写清由哪个 PR 完成。

---

## 4. 冲突怎么办

```bash
git checkout feat/你的分支
git pull --rebase origin main     # 把最新的 main 拉下来接到你的提交之前
# 有冲突就打开文件，找到 <<<<<<< ======= >>>>>>> 手动改成你想要的样子
git add .
git rebase --continue
```

**不确定就问，不要硬推。** 尤其不要 `git push -f`。

---

## 5. 这个项目的约定

| 约定 | 原因 |
|---|---|
| **所有数据读写只走 `app/utils/db.js`** | 以后换云开发只改这一个文件 |
| **训练量计算只在 `app/utils/volume.js`** | 现在有两处需要它，别各写一遍 |
| **改完 `utils/` 或 `data/` 就跑 `node app/test.js`** | 18 项断言，10 秒跑完 |
| **颜色只用 `app/app.wxss` 里 `page{}` 定义的变量** | 换深色模式时只改一处 |
| **尺寸用 `rpx`**，不用 `px` | 375px 屏 = 750rpx，视觉才一致 |
| **新页面要在 `app.json` 的 `pages` 里注册** | 否则页面打不开 |
| **组件放 `app/components/`，四件套同名目录** | 保持一致 |

---

## 6. 小程序协作的三个坑

**① 不要提交 `project.private.config.json`**
这是微信开发者工具生成的**本机配置**（记着你本地的编译模式、路径）。每人一份，提交了会互相覆盖。已经在 `.gitignore` 里排除了，**别手动 add**。

**② 各自用测试号就能开发**
不需要真 AppID。导入项目时 AppID 选「测试号」即可，云开发等功能用不了，但本项目第一版全用本地存储，够用。

**③ 真机预览要另外加权限**
git 权限 ≠ 小程序权限。要真机预览/上传代码，得去 `mp.weixin.qq.com → 管理 → 成员管理` 加项目成员。这一步只有小程序管理员能做。

---

## 7. 不要做的事

- ❌ `git push -f` 到 `main`
- ❌ 把 `node_modules/`、`_cache/` 提交上去
- ❌ 直接改 `main`（开了分支保护会拦住你）
- ❌ 一个 PR 里混三件不相关的事
- ❌ 把别人的代码用本地版本整个覆盖再提交

---

## 8. 第一次拉代码

```bash
git clone https://gitee.com/man-qianyi/lianjie.git
cd lianjie
node app/test.js          # 先确认环境正常，应该输出「全部通过」
```

然后微信开发者工具 → 导入项目 → 选 `lianjie/app` 目录 → AppID 选「测试号」。
