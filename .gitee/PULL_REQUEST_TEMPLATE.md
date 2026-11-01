## 关联 issue

<!-- 合并后自动关闭：Closes #12；多个就写多行；只想引用不打算关的写 Refs #12 -->
Closes #

## 改了什么

<!-- 一句话说清，例如：记录页的组可以点数字改成其他重量 -->

## 为什么

<!-- 解决什么问题，或者来自哪个需求 -->

## 怎么验证

- [ ] `cd app && node test.js` 全部通过
- [ ] `cd app && node test-page.js` 全部通过
- [ ] `cd app && node test-training.js` 全部通过
- [ ] 微信开发者工具编译无报错
- [ ] 手动点过改动涉及的页面

## 影响到哪

<!-- 改了 db.js / volume.js 这类公共文件的话，写清楚影响范围 -->

- [ ] 改动了 `app/utils/` 下的公共逻辑
- [ ] 改动了同步链路（`app/utils/sync.js`、`app/utils/config.js`）→ 另外跑了 `cd app && node test-sync.js`
- [ ] 改动了 `server/` → 另外跑了 `cd server && go test ./...`
- [ ] 改动了 `app/app.wxss` 的全局样式变量
- [ ] 新增了页面（已在 `app.json` 注册）
