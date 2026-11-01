const MODELS = [
  { id: 'cannbot/deepseek-v4-pro', providerID: 'cannbot', modelID: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1048576, output: 262144 },
  { id: 'cannbot/glm-5.3', providerID: 'cannbot', modelID: 'glm-5.3', name: 'GLM-5.3', context: 1048576, output: 262144 },
  { id: 'cannbot/deepseek-v4.1-flash', providerID: 'cannbot', modelID: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1048576, output: 262144 },
]

const CHECKLIST = ['需求覆盖', '接口契约', '异常路径', '并发与资源', '安全', '测试充分性']
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
    return `mock-ses-${seq}-${slugify(title).slice(0, 12)}`
  }

  async abort() {
    return true
  }

  async ask(sessionID, { agent, text }) {
    await delay(120)
    const round = Number((text.match(/轮次：(\d+)/) || [])[1] || 1)
    const last = round > 1
    if (agent === 'architect') {
      return { text: architect(round, last) }
    }
    if (agent === 'reviewer') {
      return { text: reviewer(round, last) }
    }
    return { text: verifier(round, last) }
  }
}

function architect(round, last) {
  return `# 方案（第 ${round} 轮，MOCK）

## 目标拆解
1. 定义模块边界与接口
2. 实现核心逻辑
3. 补充测试

## 改动文件
- \`src/core/index.ts\` 新增
- \`src/core/types.ts\` 新增
- \`test/core.test.ts\` 新增

## 关键决策
- 采用显式错误码而非抛异常，便于上层收敛
- 并发路径统一走单写者队列，避免竞态

## 风险
- 大输入下的内存峰值未验证

## 回应
- RV-1: ${last ? 'FIXED 已在 src/core/index.ts:38 增加空值判断与错误码' : 'REJECTED（本轮尚未处理）'}
`
}

function reviewer(round, last) {
  const rows = CHECKLIST.map((k) => `- ${k}: ${last || k === '异常路径' ? 'OK' : 'FAIL 未覆盖空输入与超时'}`).join('\n')
  const issues = last
    ? '## ISSUES\n- 无'
    : `## ISSUES
- [MAJOR] RV-1 src/core/index.ts:42 | 输入为空时未判空，会向下游传 undefined | 增加判空并返回 EINVAL
- [MINOR] RV-2 test/core.test.ts:12 | 缺少超时用例 | 补一条超时路径用例`
  return `# 独立评审（第 ${round} 轮，MOCK）

## CHECKLIST
${rows}

${issues}
`
}

function verifier(round, last) {
  return `# 核验（第 ${round} 轮，MOCK）

## ISSUE 核验
- RV-1: ${last ? 'FIXED 证据 src/core/index.ts:38 增加 if (!input) return EINVAL' : 'NOT_FIXED 证据 src/core/index.ts:42 仍无判空'}
- RV-2: ${last ? 'FIXED 证据 test/core.test.ts:30 新增超时用例' : 'UNVERIFIABLE 用例尚未添加'}

## 命令
- ${last ? 'npm test -> exit 0' : 'npm test -> exit 1'}
`
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
