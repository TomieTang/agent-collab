export const CHECKLIST = ['需求覆盖', '接口契约', '异常路径', '并发与资源', '安全', '测试充分性']

export function proposalPrompt(room, round) {
  const prev = round > 1 ? `- 上一轮评审：\`.collab/round-${round - 1}/review-reviewer.md\`（必须逐条回应）` : ''
  return `你是本协作房间的 Architect（主设计 + 主实现）。

需求：
${room.requirement}

轮次：${round}/${room.maxRounds}
共享状态板：\`.collab/board.md\`（先读）
${prev}

任务：
1. 先读 board.md 与仓库相关源码，再动手，不要凭空假设。
2. 方案写入 \`.collab/round-${round}/proposal-architect.md\`，必须包含：目标拆解、改动文件清单、关键决策与理由、风险。
3. 需要改的代码直接改在仓库里；完成后更新 board.md 的「已确认结论」和「待决问题」。
4. 对上一轮每条 issue 给出 \`FIXED\` 或 \`REJECTED（理由）\`，写在方案末尾的 \`## 回应\` 段。
5. 最终回复只输出：改了哪些文件 + issue 回应摘要，不超过 20 行。`
}

export function reviewPrompt(room, round) {
  return `你是本协作房间的 Reviewer（独立评审方），只能读，不能修改代码。

需求：
${room.requirement}

轮次：${round}/${room.maxRounds}
评审对象：\`.collab/round-${round}/proposal-architect.md\` 与仓库当前代码（用 git diff 看改动）

必须逐项给出结论，六项缺一不可：
${CHECKLIST.map((c, i) => `${i + 1}. ${c}`).join('\n')}

输出到 \`.collab/round-${round}/review-reviewer.md\`，格式固定：

## CHECKLIST
- ${CHECKLIST[0]}: OK 或 FAIL（原因）

## ISSUES
- [BLOCKER] RV-1 文件:行 | 问题 | 建议修复
- [MAJOR] RV-2 文件:行 | 问题 | 建议修复
- [MINOR] RV-3 文件:行 | 问题 | 建议修复

没有问题时写 \`## ISSUES\` 下 \`- 无\`，但 CHECKLIST 仍必须完整。
最终回复只输出 issue 数量统计（BLOCKER/MAJOR/MINOR 各几条）。`
}

export function verifyPrompt(room, round, doneWhen) {
  const cmds = doneWhen.length ? doneWhen.map((c) => `- \`${c}\``).join('\n') : '- （房间未设置验收命令）'
  return `你是本协作房间的 Verifier（核验方），只读 + 命令白名单。

需求：
${room.requirement}

轮次：${round}/${room.maxRounds}
核验对象：\`.collab/round-${round}/proposal-architect.md\`、\`.collab/round-${round}/review-reviewer.md\` 与仓库当前代码

任务：
1. 逐条判断 review 中每个 issue 是否真的修复：\`FIXED\` / \`NOT_FIXED\` / \`UNVERIFIABLE\`，每条必须带证据（文件:行，或命令输出片段）。没有证据一律记 UNVERIFIABLE。
2. 运行以下命令并记录退出码：
${cmds}
3. 结果写入 \`.collab/round-${round}/verify-verifier.md\`。

最终回复只输出：issue 通过率 + 每条命令的退出码。`
}

export function checklistCoverage(text) {
  const missing = CHECKLIST.filter((item) => !text.includes(item))
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
