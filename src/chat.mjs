import fs from 'node:fs/promises'
import path from 'node:path'

const ORDER = ['architect', 'reviewer', 'verifier']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class StopSignal extends Error {}

function renderMessages(list) {
  if (!list.length) return '（讨论刚开始，还没有人发言。请你先给出观点。）'
  return list.map((m) => `[${m.label}] ${m.content}`).join('\n\n')
}

function chatPrompt(room, role, unseen, turn) {
  return `你是「${role.label}」，正在参加一个多模型讨论。

讨论主题：
${room.task}

你的模型：${role.model}
本轮发言序号：${turn}

自你上次发言以来的新消息：
---
${renderMessages(unseen)}
---

现在轮到你发言。要求：
1. 只回应上面新增的内容，不要复述已达成一致的部分。
2. 可以补充、质疑、要求对方给出证据或具体位置（文件:行）。
3. 与其他人观点一致时明确说"同意"，不要重复论证。
4. 300 字以内，直接说话，不要写标题和长篇结构。
5. 当这场讨论已经可以收尾、没有新的实质分歧时，在回复最后单独写一行 [END]。
6. 不要修改文件、不要执行命令，这是讨论。`
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
  room.status = 'running'
  room.control = 'run'
  room.round = 0
  room.reason = ''
  ctx.emit(room, { type: 'status', status: 'running' })
  await ctx.archive.saveRoom(room)

  const cursors = Object.fromEntries(ORDER.map((k) => [k, 0]))
  const maxTurns = Math.max(1, room.maxRounds) * ORDER.length
  let ended = false

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      await gate(ctx, room)
      const roleKey = ORDER[(turn - 1) % ORDER.length]
      const role = room.roles[roleKey]
      room.round = Math.ceil(turn / ORDER.length)
      const unseen = room.messages.slice(cursors[roleKey])

      ctx.emit(room, { type: 'thinking', role: roleKey, turn, round: room.round })
      ctx.emit(room, { type: 'turn', turn, maxTurns, role: roleKey })

      const reply = await ctx.oc.ask(role.sessionID, {
        model: role.model,
        agent: role.agent,
        text: chatPrompt(room, role, unseen, turn),
      })
      const content = (reply.text || '').trim()
      if (!content) continue

      ctx.emit(room, { type: 'message', role: roleKey, label: role.label, kind: 'chat', round: room.round, turn, content })
      await ctx.archive.appendTranscript(room, {
        round: turn,
        role: roleKey,
        label: role.label,
        model: role.model,
        kind: 'chat',
        content,
      })
      cursors[roleKey] = room.messages.length

      if (/\[END\]/i.test(content)) {
        ended = true
        room.status = 'done'
        room.reason = `三方对话收束（第 ${turn} 次发言出现 [END]）`
        break
      }
    }
    if (!ended) {
      room.status = 'needs_human'
      room.reason = room.control === 'stop' ? '人工停止' : '达到发言上限，未出现 [END]'
    }
  } catch (e) {
    if (e instanceof StopSignal) {
      room.status = 'stopped'
      room.reason = '人工停止'
    } else {
      room.status = 'error'
      room.reason = e.message
      ctx.emit(room, { type: 'error', message: e.message })
    }
  } finally {
    room.finishedAt = new Date().toISOString()
    await writeChatDecision(ctx, room)
    await ctx.archive.writeReport(room, { commandLog: '', changedFiles: [], unresolved: [] })
    await ctx.archive.saveRoom(room)
    ctx.emit(room, { type: 'done', status: room.status, reason: room.reason })
  }
  return room
}

async function writeChatDecision(ctx, room) {
  const last = {}
  for (const m of room.messages) last[m.role] = m
  const body = ORDER.map((k) => {
    const m = last[k]
    return `### ${room.roles[k].label}（${room.roles[k].model}）\n\n${m ? m.content : '（未发言）'}`
  }).join('\n\n')
  const text = `# DECISION — ${room.id}

- 模式：chat（多模型对话）
- 状态：${room.status} — ${room.reason}
- 发言数：${room.messages.length}

## 各方最后观点

${body}

## 完整对话

见 \`transcript.md\`。
`
  await fs.mkdir(ctx.archive.roomDir(room.id), { recursive: true })
  await ctx.archive.writeArtifact(room, 'DECISION.md', text)
}
