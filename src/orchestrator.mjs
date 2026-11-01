import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { proposalPrompt, reviewPrompt, verifyPrompt, checklistCoverage, extractIssues } from './prompts.mjs'
import { modeOf } from './modes.mjs'

class StopSignal extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sh(cmd, cwd, timeout) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, out: out + String(e.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out })
    })
  })
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

async function step(ctx, room, roleKey, kind, promptText) {
  const role = room.roles[roleKey]
  const rel = `round-${room.round}/${kind}-${roleKey}.md`
  await ctx.archive.ensureRound(room, room.round)
  ctx.emit(room, { type: 'thinking', role: roleKey, kind, round: room.round })
  const started = Date.now()
  const res = await ctx.oc.ask(role.sessionID, { model: role.model, agent: role.agent, text: promptText })
  const existing = await ctx.archive.readArtifact(room, rel)
  const content = existing || res.text || ''
  if (!existing) await ctx.archive.writeArtifact(room, rel, content)
  const meta = {
    role: roleKey,
    kind,
    model: role.model,
    agent: role.agent,
    round: room.round,
    ms: Date.now() - started,
    tokens: res.tokens ?? null,
  }
  await ctx.archive.appendMeta(room, room.round, meta)
  await ctx.archive.appendTranscript(room, {
    round: room.round,
    role: roleKey,
    label: role.label,
    model: role.model,
    kind,
    content,
  })
  ctx.emit(room, { type: 'message', role: roleKey, label: role.label, kind, round: room.round, content, meta })
  return content
}

async function runDoneWhen(ctx, room) {
  if (!room.doneWhen.length) {
    return { ok: !modeOf(room).requireCommands, log: '', reason: '' }
  }
  const lines = []
  let ok = true
  for (const cmd of room.doneWhen) {
    ctx.emit(room, { type: 'command', command: cmd, round: room.round })
    const r = await sh(cmd, room.workspace, ctx.config.commandTimeoutMs)
    lines.push(`$ ${cmd}\nexit=${r.code}\n${r.out.trim()}`)
    if (r.code !== 0) ok = false
  }
  const log = lines.join('\n\n')
  await ctx.archive.writeArtifact(room, `round-${room.round}/commands.log`, log)
  ctx.emit(room, { type: 'command_done', ok, round: room.round })
  return { ok, log }
}

async function changedFiles(ctx, room) {
  const r = await sh('git status --porcelain', room.workspace, 30000)
  if (r.code !== 0) return []
  return r.out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, ''))
}

async function linkBoard(ctx, room) {
  const link = path.join(room.workspace, '.collab')
  try {
    await fs.rm(link, { force: true })
  } catch {}
  try {
    await fs.symlink(ctx.archive.roomDir(room.id), link, 'dir')
  } catch (e) {
    ctx.emit(room, { type: 'warn', message: `.collab 软链创建失败，agent 需用绝对路径访问归档：${e.message}` })
  }
}

export async function runRoom(ctx, room) {
  room.status = 'running'
  room.control = 'run'
  room.round = 0
  room.reason = ''
  ctx.emit(room, { type: 'status', status: 'running' })
  await ctx.archive.saveRoom(room)
  await linkBoard(ctx, room)

  let lastReview = ''
  let lastVerify = ''
  let lastLog = ''
  let unresolved = []

  try {
    for (let round = 1; round <= room.maxRounds; round++) {
      room.round = round
      await ctx.archive.saveRoom(room)
      ctx.emit(room, { type: 'round_start', round, maxRounds: room.maxRounds })

      await gate(ctx, room)
      await step(ctx, room, 'architect', 'proposal', proposalPrompt(room, round))

      await gate(ctx, room)
      lastReview = await step(ctx, room, 'reviewer', 'review', reviewPrompt(room, round))

      await gate(ctx, room)
      lastVerify = await step(ctx, room, 'verifier', 'verify', verifyPrompt(room, round, room.doneWhen))

      const mode = modeOf(room)
      const coverage = checklistCoverage(mode, lastReview)
      const cmd = await runDoneWhen(ctx, room)
      lastLog = cmd.log
      unresolved = extractIssues(lastReview)
      const verdict = mode.converge({
        review: lastReview,
        verify: lastVerify,
        coverage,
        commandsOk: cmd.ok,
        doneWhen: room.doneWhen,
      })

      ctx.emit(room, {
        type: 'verdict',
        round,
        ok: verdict.ok,
        reviewOk: coverage.complete && !/\[(BLOCKER|MAJOR)\]/i.test(lastReview),
        verifyOk: !/UNVERIFIABLE|NOT_FIXED/i.test(lastVerify),
        commandsOk: cmd.ok,
        missingChecklist: coverage.missing,
        reason: verdict.reason,
      })

      if (verdict.ok) {
        room.status = 'done'
        room.reason = verdict.reason
        break
      }
      if (round === room.maxRounds) {
        room.status = 'needs_human'
        room.reason = `达到轮次上限：${verdict.reason || cmd.reason || '未收敛'}`
      }
    }
    if (room.status === 'running') {
      room.status = 'needs_human'
      room.reason = room.reason || '未收敛'
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
    const finalStatus = room.status
    room.status = 'finalizing'
    await ctx.archive.writeDecision(room, room.round || 1, `${finalStatus} — ${room.reason}`, unresolved)
    const files = await changedFiles(ctx, room)
    await ctx.archive.writeReport(room, { status: finalStatus, commandLog: lastLog, changedFiles: files, unresolved })
    room.status = finalStatus
    room.finishedAt = new Date().toISOString()
    await ctx.archive.saveRoom(room)
    await fs.rm(path.join(room.workspace, '.collab'), { force: true }).catch(() => {})
    ctx.emit(room, { type: 'done', status: room.status, reason: room.reason })
  }
  return room
}
