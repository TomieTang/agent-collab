# DECISION — 20261101-110441-帮我设计一版写入接口的错误处理

- 模式：chat（多模型对话）
- 状态：done — 三方对话收束（第 3 次发言出现 [END]）
- 发言数：3
- 人工补充：1 条

## 人的补充

- 每秒 100 条，P99 50ms

## 各方最后观点

### deepseek-v4-pro（cannbot/deepseek-v4-pro）

建议先统一入口校验：非法输入返回错误码，不做抛异常。这样上层能统一收敛。

### glm-5.3（cannbot/glm-5.3）

错误码方向我同意，但现在缺两个关键输入：写入量级和延迟目标，这直接决定批量策略。
[ASK] 这个接口预期的写入量级是多少？延迟目标是什么量级？

### deepseek-v4.1-flash（cannbot/deepseek-v4.1-flash）

核对通过：src/core/index.ts:42 的判空缺失与量级假设都能对上，建议按批量 64 落地。
[END]

## 完整对话

见 `transcript.md`。
