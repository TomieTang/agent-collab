import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from './config.mjs'
import { AtomGitHub, BOT_MARK, isBotComment } from './hub/atomgit.mjs'

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const ONCE = args.has('--once')

const cfg = config.connector
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!cfg.token) {
  console.error('缺少 HUB_TOKEN（AtomGit personal access token）')
  process.exit(1)
}
if (!cfg.repo.includes('/')) {
  console.error('缺少 HUB_REPO，格式 owner/repo')
  process.exit(1)
}

const hub = new AtomGitHub({ base: cfg.base, repo: cfg.repo, token: cfg.token })
const stateFile = cfg.stateFile

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(stateFile, 'utf8'))
  } catch {
    return {}
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')
}

class Local {
  constructor() {
    this.cookie = ''
  }

  async api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(cfg.collabUrl + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    const text = await res.text()
    if (!res.ok) throw new Error(`local ${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }

  async login() {
    if (!this.cookie) await this.api('/api/login', { method: 'POST', body: { password: cfg.collabPassword } })
  }

  async createRoom(task) {
    await this.login()
    const { room } = await this.api('/api/rooms', {
      method: 'POST',
      body: { task, interaction: 'chat', maxRounds: cfg.maxRounds },
    })
    return room
  }

  room(id) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}`).then((d) => d.room)
  }

  start(id) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/start`, { method: 'POST' })
  }

  say(id, text) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/say`, { method: 'POST', body: { text } })
  }

  file(id, rel) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/file?path=${encodeURIComponent(rel)}`).then((d) => d.content)
  }
}

const local = new Local()

function keyOf(number) {
  return `${cfg.repo}#${number}`
}

function fmtMessage(m) {
  const label = m.kind === 'human' ? '提问人' : m.label
  return `${BOT_MARK}\n**${label}** · R${m.round} · ${m.kind}\n\n${m.content}`
}

async function post(number, md) {
  if (DRY) {
    console.log(`[dry] comment on #${number}:\n${md.slice(0, 200)}\n---`)
    return null
  }
  return hub.postComment(number, md)
}

async function handleDiscussion(number, state) {
  const key = keyOf(number)
  const entry = state[key] || { roomId: null, posted: 0, lastHumanId: null, questionPosted: false, finished: false }

  if (entry.finished) return

  if (!entry.roomId) {
    const disc = await hub.getDiscussion(number)
    const task = `${disc.title}\n\n${disc.md_content || ''}`.trim()
    const room = await local.createRoom(task)
    entry.roomId = room.id
    state[key] = entry
    await saveState(state)
    console.log(`#${number} -> room ${room.id}`)
    await post(number, `${BOT_MARK}\n三个模型已进入讨论，开工。`)
    if (!DRY) await local.start(room.id)
    return
  }

  const room = await local.room(entry.roomId)
  if (!room) return

  const messages = room.messages || []
  const fresh = messages.slice(entry.posted)
  for (const m of fresh) {
    if (m.kind === 'human') continue
    await post(number, fmtMessage(m))
    entry.posted += 1
    await saveState(state)
  }

  const comments = await hub.listComments(number)
  const human = comments.filter((c) => !isBotComment(c))
  const lastHuman = human[human.length - 1]
  const lastId = entry.lastHumanId
  const isNew = lastHuman && lastHuman.id !== lastId

  if (isNew) {
    entry.lastHumanId = lastHuman.id
    if (room.status === 'waiting_input' || room.status === 'needs_human' || room.status === 'paused') {
      await local.say(entry.roomId, lastHuman.md_content || '')
      entry.questionPosted = false
      console.log(`#${number} <- human input, resume`)
    } else if (room.status === 'running') {
      await local.say(entry.roomId, lastHuman.md_content || '')
    }
    await saveState(state)
  }

  if (room.status === 'waiting_input' && room.pendingQuestion && !entry.questionPosted) {
    await post(
      number,
      `${BOT_MARK}\n**需要你确认** · ${room.pendingQuestion.label}\n\n${room.pendingQuestion.question}\n\n> 直接在下面回复即可，回复后自动继续。`
    )
    entry.questionPosted = true
    await saveState(state)
  }

  if (['done', 'needs_human', 'stopped', 'error'].includes(room.status)) {
    let summary = ''
    try {
      summary = await local.file(entry.roomId, 'DECISION.md')
    } catch {
      summary = ''
    }
    const head = room.status === 'done' ? '讨论已收束' : `讨论结束：${room.reason || room.status}`
    await post(number, `${BOT_MARK}\n**${head}**\n\n${summary.slice(0, 3000)}`)
    entry.finished = true
    await saveState(state)
  }
}

async function targets() {
  if (cfg.discussion) return [cfg.discussion]
  const list = await hub.listDiscussions()
  return list
    .filter((d) => !d.is_closed)
    .filter((d) => !cfg.owner || d.author?.login === cfg.owner)
    .map((d) => d.number)
}

async function main() {
  console.log(`connector: ${cfg.repo} @ ${cfg.base}${cfg.discussion ? ` #${cfg.discussion}` : ''}${DRY ? ' [dry]' : ''}`)
  const state = await loadState()
  do {
    try {
      for (const n of await targets()) await handleDiscussion(n, state)
    } catch (e) {
      console.error('tick error:', e.message)
    }
    if (!ONCE) await sleep(cfg.pollMs)
  } while (!ONCE)
}

main()
