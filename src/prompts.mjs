import { modeOf } from './modes.mjs'

function where(room) {
  return `工作区（绝对路径）：\`${room.workspace}\`
归档目录（= 工作区下的 .collab）：\`${room.workspace}/.collab\`
所有 bash 命令请自行加 \`cd ${room.workspace} && \` 前缀；涉及其他任务目录的内容一律不要读写。`
}

function head(room, round) {
  const mode = modeOf(room)
  return `任务类型：${mode.id}（${mode.label}）
任务：
${room.task}

轮次：${round}/${room.maxRounds}
${where(room)}`
}

export function proposalPrompt(room, round) {
  const mode = modeOf(room)
  const prev = round > 1 ? `- 上一轮评审：\`.collab/round-${round - 1}/review-reviewer.md\`（必须逐条回应）` : ''
  return `你是本协作房间的 ${mode.roles.architect}。

${head(room, round)}
共享状态板：\`.collab/board.md\`（先读）
${prev}

任务：
1. 先读 board.md 与仓库相关内容，再动手，不要凭空假设。
2. 产出写入 \`.collab/round-${round}/proposal-architect.md\`。
3. ${mode.proposalSpec}
4. 完成后更新 board.md 的「已确认结论」和「待决问题」。
5. 最终回复只输出要点摘要，不超过 20 行。`
}

export function reviewPrompt(room, round) {
  const mode = modeOf(room)
  return `你是本协作房间的 ${mode.roles.reviewer}。

${head(room, round)}
评审对象：\`.collab/round-${round}/proposal-architect.md\` 与工作区当前状态（用 git diff 看改动）

必须逐项给出结论，缺一不可：${mode.checklist.map((c, i) => `${i + 1}. ${c}`).join(' ')}

输出到 \`.collab/round-${round}/review-reviewer.md\`，格式固定：

## CHECKLIST
- ${mode.checklist[0]}: OK 或 FAIL（原因）

## ISSUES
- [BLOCKER] RV-1 文件:行 | 问题 | 建议
- [MAJOR] RV-2 文件:行 | 问题 | 建议
- [MINOR] RV-3 文件:行 | 问题 | 建议

${mode.reviewSpec}

没有问题时写 \`## ISSUES\` 下 \`- 无\`，但 CHECKLIST 仍必须完整。
最终回复只输出 issue 数量统计。`
}

export function verifyPrompt(room, round, doneWhen) {
  const mode = modeOf(room)
  const cmds = doneWhen.length ? doneWhen.map((c) => `- \`${c}\``).join('\n') : '- （本任务未设置验收命令）'
  return `你是本协作房间的 ${mode.roles.verifier}。

${head(room, round)}
核验对象：\`.collab/round-${round}/proposal-architect.md\`、\`.collab/round-${round}/review-reviewer.md\` 与工作区当前状态

${mode.verifySpec}

需要运行的命令：
${cmds}

结果写入 \`.collab/round-${round}/verify-verifier.md\`。
最终回复只输出：标记统计 + 每条命令的退出码。`
}

export function checklistCoverage(mode, text) {
  const missing = mode.checklist.filter((item) => !String(text || '').includes(item))
  return { complete: missing.length === 0, missing }
}

export function extractIssues(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/\[(BLOCKER|MAJOR|MINOR)\]\s*(\S+)?/)
    if (m) out.push(`${m[1]} ${m[2] || ''} ${line.replace(/^[-\s]+/, '').trim()}`.trim())
  }
  return out
}
