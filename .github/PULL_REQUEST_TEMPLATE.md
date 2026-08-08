## 描述

<!-- 动机：修什么问题 / 加什么能力。关联 issue 编号。 -->

## 变更点

<!-- 改动文件与逻辑（handler 路由 / 存储 / 仲裁 / 文档…）。 -->

## 测试证据

<!--
- `npm test` 输出（断言数）
- `npm run typecheck` 结果
- 新增/修改的测试用例说明
-->

## 真机验证（如涉及链路/契约）

<!-- 登录 → 会话列表 → 会话页 → 选模型 → 发消息 → 回复回流，实际结果。 -->

## 契约影响

<!-- 是否改动了 invoke handler 返回/参数形状？如是，列出参考仓消费方与对齐结果。 -->

## Checklist

- [ ] `npm test` 全绿（PI_CINDY_DATA_DIR 隔离）
- [ ] `npm run typecheck` 全绿
- [ ] commit 符合 Conventional Commits（commitlint）
- [ ] 行为变更已记录到 `docs/CHANGELOG.md` 对应版本
- [ ] 踩坑/根因经验已记录到 `docs/EXPERIENCE.md`（如适用）
