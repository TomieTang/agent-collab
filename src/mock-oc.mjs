import { MODES } from './modes.mjs'

const MODELS = [
  { id: 'cannbot/deepseek-v4-pro', providerID: 'cannbot', modelID: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1048576, output: 262144 },
  { id: 'cannbot/glm-5.3', providerID: 'cannbot', modelID: 'glm-5.3', name: 'GLM-5.3', context: 1048576, output: 262144 },
  { id: 'cannbot/deepseek-v4.1-flash', providerID: 'cannbot', modelID: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1048576, output: 262144 },
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0

export class MockOpencodeClient {
  enabled = true
  mock = true

  async listModels() {
    return MODELS
  }

  async health() {
    return { ok: true, models: MODELS, mock: true }
  }

  async createSession(title) {
    seq += 1
    return `mock-ses-${seq}-${String(title).replace(/[^a-z0-9]+/gi, '').slice(0, 12)}`
  }

  async abort() {
    return true
  }

  async messages(sessionID) {
    return [
      {
        info: { id: `mock-msg-${sessionID}-1`, role: 'assistant', sessionID },
        parts: [{ type: 'text', text: 'MOCK 会话原始记录' }],
      },
    ]
  }

  async deleteSession() {
    return true
  }

  async ask(sessionID, { agent, text }) {
    await delay(120)
    if (text.includes('现在轮到你发言')) return { text: chatReply(agent, text) }
    const round = Number((text.match(/轮次：(\d+)/) || [])[1] || 1)
    const mode = (text.match(/任务类型：(\w+)/) || [])[1] || 'build'
    const last = round > 1
    if (agent === 'architect') return { text: architect(mode, round, last) }
    if (agent === 'reviewer') return { text: reviewer(mode, round, last) }
    return { text: verifier(mode, round, last) }
  }
}

function chatReply(agent, text) {
  const answered = text.includes('提问人')
  if (agent === 'architect') {
    return '建议先统一入口校验：非法输入返回错误码，不做抛异常。这样上层能统一收敛。'
  }
  if (agent === 'reviewer') {
    if (!answered) return '错误码方向我同意，但现在缺两个关键输入：写入量级和延迟目标，这直接决定批量策略。\n[ASK] 这个接口预期的写入量级是多少？延迟目标是什么量级？'
    return '按每秒 100 条、P99 < 50ms 来看，批量 64 足够，不需要引入队列。'
  }
  if (!answered) return 'src/core/index.ts:42 确实没有判空，这一点可证实。量级问题需要提问人确认。'
  return '核对通过：src/core/index.ts:42 的判空缺失与量级假设都能对上，建议按批量 64 落地。\n[END]'
}

function architect(mode, round, last) {
  if (mode === 'diagnose') {
    return `# 排查记录（第 ${round} 轮，MOCK）

## 现象
- 训练脚本偶发 hang，进程不退出，GPU 利用率归零

## 复现
- \`bash scripts/repro.sh\` 10 次出现 1 次

## 假设
- H1 数据加载线程未设置超时 | 判据：hang 时 loader 栈停在 read() | ${last ? '已确认 src/data/loader.py:88' : '待验证'}
- H2 分布式 barrier 未配对 | 判据：hang 时 rank0 停在 barrier | ${last ? '已排除 src/train.py:140' : '待验证'}

## 根因
${last ? '- src/data/loader.py:88 read() 无超时，worker 阻塞后主进程永久等待' : '- 待定'}

## 修复建议
- 给 read() 增加超时并 fail-fast
`
  }
  if (mode === 'analyze' || mode === 'review') {
    return `# ${mode === 'review' ? '现状说明' : '分析'}（第 ${round} 轮，MOCK）

## 问题拆解
1. 性能代价
2. 改造成本
3. 风险

## 结论
- 子问题1：读写放大 1.7x，依据 docs/bench.md:12
- 子问题2：改动 3 个文件，依据 src/core/store.ts:44
- 子问题3：${last ? '回滚成本可控，依据 src/core/store.ts:91' : '风险待确认'}

## 不确定与反例
- ${last ? '小写入场景结论可能反转' : '尚未评估小写入场景'}

## 建议
- 采用方案 B，前提是写入批量不低于 64KB
`
  }
  return `# 方案（第 ${round} 轮，MOCK）

## 目标拆解
1. 定义模块边界与接口
2. 实现核心逻辑
3. 补充测试

## 改动文件
- \`src/core/index.ts\` 新增
- \`test/core.test.ts\` 新增

## 关键决策
- 采用显式错误码而非抛异常，便于上层收敛

## 风险
- 大输入下的内存峰值未验证

## 回应
- RV-1: ${last ? 'FIXED 已在 src/core/index.ts:38 增加判空与错误码' : 'REJECTED（本轮尚未处理）'}
`
}

function reviewer(mode, round, last) {
  const list = MODES[mode]?.checklist || MODES.build.checklist
  const failAt = 1
  const rows = list.map((k, i) => `- ${k}: ${last || i !== failAt ? 'OK' : `FAIL 未覆盖（${k}）`}`).join('\n')
  const issues = last
    ? '## ISSUES\n- 无'
    : `## ISSUES
- [MAJOR] RV-1 src/core/index.ts:42 | 关键路径缺少判空与超时 | 补充判空并返回明确错误
- [MINOR] RV-2 test/core.test.ts:12 | 缺少异常路径用例 | 补一条`
  return `# ${MODES[mode]?.roles.reviewer || '评审'}（第 ${round} 轮，MOCK）

## CHECKLIST
${rows}

${issues}
`
}

function verifier(mode, round, last) {
  if (mode === 'diagnose') {
    return `# 取证（第 ${round} 轮，MOCK）

- H1: ${last ? '[CONFIRMED] src/data/loader.py:88 read() 无超时，hang 栈一致' : '[UNVERIFIABLE] 尚无栈采样'}
- H2: ${last ? '[REFUTED] src/train.py:140 barrier 配对完整' : '[UNVERIFIABLE] 尚未检查'}
- 结论：${last ? '[CONFIRMED] src/data/loader.py:88 read() 无超时导致 worker 阻塞' : '未确认'}

## 命令
- ${last ? 'bash scripts/repro.sh -> exit 0' : 'bash scripts/repro.sh -> exit 1'}
`
  }
  if (mode === 'analyze' || mode === 'review') {
    return `# 核对（第 ${round} 轮，MOCK）

- 依据1 docs/bench.md:12: ${last ? '[EVIDENCE] 数据一致' : '[MISSING] 未找到出处'}
- 依据2 src/core/store.ts:44: ${last ? '[EVIDENCE] 引用正确' : '[MISSING] 未找到出处'}
- 依据3 src/core/store.ts:91: ${last ? '[EVIDENCE] 引用正确' : '[MISSING] 未找到出处'}
`
  }
  return `# 核验（第 ${round} 轮，MOCK）

- RV-1: ${last ? 'FIXED 证据 src/core/index.ts:38 已判空并返回 EINVAL' : 'NOT_FIXED 证据 src/core/index.ts:42 仍无判空'}
- RV-2: ${last ? 'FIXED 证据 test/core.test.ts:30 新增用例' : 'UNVERIFIABLE 用例尚未添加'}

## 命令
- ${last ? 'npm test -> exit 0' : 'npm test -> exit 1'}
`
}
