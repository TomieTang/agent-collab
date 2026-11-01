# 独立评审（第 1 轮，MOCK）

## CHECKLIST
- 需求覆盖: FAIL 未覆盖空输入与超时
- 接口契约: FAIL 未覆盖空输入与超时
- 异常路径: OK
- 并发与资源: FAIL 未覆盖空输入与超时
- 安全: FAIL 未覆盖空输入与超时
- 测试充分性: FAIL 未覆盖空输入与超时

## ISSUES
- [MAJOR] RV-1 src/core/index.ts:42 | 输入为空时未判空，会向下游传 undefined | 增加判空并返回 EINVAL
- [MINOR] RV-2 test/core.test.ts:12 | 缺少超时用例 | 补一条超时路径用例
