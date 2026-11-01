# DECISION — 20261101-104459-给配置模块增加校验-非法输入返回-einval-并补一条超时用例

- 任务类型：build
- 状态：done — 评审通过 + 核验通过 + 验收命令通过
- 轮次：2/3
- 模型：architect=cannbot/deepseek-v4-pro / reviewer=cannbot/glm-5.3 / verifier=cannbot/deepseek-v4.1-flash

## 最终方案

# 方案（第 2 轮，MOCK）

## 目标拆解
1. 定义模块边界与接口
2. 实现核心逻辑
3. 补充测试

## 改动文件
- `src/core/index.ts` 新增
- `test/core.test.ts` 新增

## 关键决策
- 采用显式错误码而非抛异常，便于上层收敛

## 风险
- 大输入下的内存峰值未验证

## 回应
- RV-1: FIXED 已在 src/core/index.ts:38 增加判空与错误码


## 未解决项

- 无
