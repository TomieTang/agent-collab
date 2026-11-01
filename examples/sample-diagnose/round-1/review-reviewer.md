# 反证（第 1 轮，MOCK）

## CHECKLIST
- 现象复现: OK
- 假设可证伪: FAIL 未覆盖（假设可证伪）
- 证据充分: OK
- 其他可能: OK
- 结论可操作: OK

## ISSUES
- [MAJOR] RV-1 src/core/index.ts:42 | 关键路径缺少判空与超时 | 补充判空并返回明确错误
- [MINOR] RV-2 test/core.test.ts:12 | 缺少异常路径用例 | 补一条
