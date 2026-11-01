import fs from 'node:fs/promises'

const ORDER = ['architect', 'reviewer', 'verifier']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DUTY = {
  architect: '你是方案提出者：给出可执行方案，回应质疑，被说服时明确修正自己的结论。',
  reviewer: '你是质疑者：找漏洞、指出风险、要求对方给出证据（文件:行），不要重复别人已说过的。',
  verifier: '你是核对者：核对事实与证据，指出无法证实的地方；不臆测，也不代替别人做决定。',
}

class StopSignal extends Error {}

function renderMessages(list) {
  if (!list.length) return '（还没有新消息，请你先开口。）'
  return list.map((m) => `[${m.label}] ${m.content}`).join('\n\n')
}

function chatPrompt(room, roleKey, role, unseen) {
  return `${DUTY[roleKey]}

你在这场讨论中的名字：${role.label}（模型 ${role.model}）

讨论主题：
${room.task}

自你上次发言以来的新消息：
---
${renderMessages(unseen)}
---

现在轮到你发言。规则：
1. 300 字以内，直接说话，只回应新内容，不要复述已经一致的部分。
2. 需要证据时要求对方给出 文件:行；自己有证据也写清楚位置。
3. 如果接下来的决定取决于人的选择（需求范围、优先级、环境约束、成本），不要替人决定，单独输出一行：[ASK] 你想问人的问题
4. 当讨论可以收尾、没有新的实质分歧时，单独输出一行：[END]
5. 这是讨论，不要修改文件、不要执行命令。`
}

async function gate(ctx, room) {
  while (room.control === 'pause') {
    room.status = 'paused'
    ctx.emit(room, { type: 'status', status: 'paused' })
    await ctx.archive.saveRoom(room)
    await sleep(500)
  }
  if (room.control === 'stop') throw new StopSignal('stopped')
  if (room.status === 'paused') {
    room.status = 'running'
    ctx.emit(room, { type: 'status', status: 'running' })
  }
}

export async function runChat(ctx, room) {
  room.control = room.control || 'run'
  if (room.control === 'stop') {
    room.status = 'stopped'
    room.reason = '人工停止'
    await ctx.archive.saveRoom(room)
    return room
  }
  room.status = 'running'
  ctx.emit(room, { type: 'status', status: 'running' })

  const state = room.chatState || { turn: 0, cursors: {} }
  for (const k of ORDER) state.cursors[k] = state.cursors[k] ?? 0
  room.chatState = state
  const maxTurns = Math.max(1, room.maxRounds) * ORDER.length
  state.maxTurns = maxTurns
  let ended = false
  let waiting = false

  try {
    while (state.turn < maxTurns) {
      await gate(ctx, room)
      const roleKey = ORDER[state.turn % ORDER.length]
      const role = room.roles[roleKey]
      const unseen = room.messages.slice(state.cursors[roleKey] ?? 0)
      const displayTurn = state.turn + 1

      ctx.emit(room, { type: 'thinking', role: roleKey, label: role.label, turn: displayTurn, round: room.round })
      ctx.emit(room, { type: 'turn', turn: displayTurn, maxTurns, role: roleKey, label: role.label })

      const reply = await ctx.oc.ask(role.sessionID, {
        model: role.model,
        agent: role.agent,
        text: chatPrompt(room, roleKey, role, unseen),
      })
      const content = (reply.text || '').trim()
      state.turn = displayTurn
      room.round = Math.ceil(state.turn / ORDER.length)

      if (!content) {
        state.cursors[roleKey] = room.messages.length
        await ctx.archive.saveRoom(room)
        continue
      }

      ctx.emit(room, { type: 'message', role: roleKey, label: role.label, kind: 'chat', round: room.round, turn: state.turn, content })
      await ctx.archive.appendTranscript(room, {
        round: state.turn,
        role: roleKey,
        label: role.label,
        model: role.model,
        kind: 'chat',
        content,
      })
      state.cursors[roleKey] = room.messages.length

      const ask = content.match(/\[ASK\]\s*([\s\S]+)/i)
      if (ask) {
        waiting = true
        room.pendingQuestion = { role: roleKey, label: role.label, question: ask[1].trim(), at: new Date().toISOString() }
        room.status = 'waiting_input'
        room.reason = `${role.label} 需要你确认后继续`
        ctx.emit(room, { type: 'waiting_input', question: room.pendingQuestion })
        break
      }

      if (/\[END\]/i.test(content)) {
        ended = true
        room.status = 'done'
        room.reason = `三方对话收束（第 ${state.turn} 次发言出现 [END]）`
        break
      }

      await ctx.archive.saveRoom(room)
    }

    if (!ended && !waiting) {
      room.status = 'needs_human'
      room.reason = '达到发言上限，未出现 [END]'
    }
  } catch (e) {
    if (e instanceof StopSignal) {
      room.status = 'stopped'
      room.reason = '人工停止'
    } else {
      room.status = 'error'
      room.reason = e.message
      room.pendingQuestion = null
      ctx.emit(room, { type: 'error', message: e.message })
    }
  } finally {
    await ctx.archive.saveRoom(room)
    if (!['waiting_input', 'running', 'paused'].includes(room.status)) {
      await finalizeChat(ctx, room, room.status)
    }
  }
  return room
}

async function writeChatDecision(ctx, room, status) {
  const last = {}
  for (const m of room.messages) last[m.role] = m
  const body = ORDER.map((k) => {
    const m = last[k]
    return `### ${room.roles[k].label}（${room.roles[k].model}）\n\n${m ? m.content : '（未发言）'}`
  }).join('\n\n')
  const human = room.messages.filter((m) => m.kind === 'human')
  const text = `# DECISION — ${room.id}

- 模式：chat（多模型对话）
- 状态：${status || room.status} — ${room.reason}
- 发言数：${room.messages.filter((m) => m.kind === 'chat').length}
- 人工补充：${human.length} 条

## 人的补充

${human.length ? human.map((m) => `- ${m.content}`).join('\n') : '- 无'}

## 各方最后观点

${body}

## 完整对话

见 \`transcript.md\`。
`
  await fs.mkdir(ctx.archive.roomDir(room.id), { recursive: true })
  await ctx.archive.writeArtifact(room, 'DECISION.md', text)
}

export async function finalizeChat(ctx, room, status) {
  room.status = 'finalizing'
  await writeChatDecision(ctx, room, status)
  await ctx.archive.writeReport(room, { status, commandLog: '', changedFiles: [], unresolved: [] })
  room.status = status
  room.finishedAt = room.finishedAt || new Date().toISOString()
  await ctx.archive.saveRoom(room)
  ctx.emit(room, { type: 'done', status, reason: room.reason })
}
