import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { AtomGitHub, BOT_MARK, isBotComment } from './hub/atomgit.mjs'

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const ONCE = args.has('--once')

const cfg = config.connector
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!cfg.token) {
  console.error('缺少 HUB_TOKEN（AtomGit / GitCode personal access token）')
  process.exit(1)
}
if (!cfg.repo.includes('/')) {
  console.error('缺少 HUB_REPO，格式 owner/repo')
  process.exit(1)
}

const hub = new AtomGitHub({ base: cfg.base, repo: cfg.repo, token: cfg.token })
const stateFile = cfg.stateFile

let state = {}
let shuttingDown = false
let owner = cfg.owner

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  } catch {
    state = {}
  }
  if (!state.__meta) state.__meta = { since: new Date().toISOString() }
}

async function saveState() {
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

  async health() {
    return this.api('/api/health')
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

  stop(id) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/stop`, { method: 'POST' })
  }

  close(id) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/close`, { method: 'POST' })
  }

  say(id, text) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/say`, { method: 'POST', body: { text } })
  }

  file(id, rel) {
    return this.api(`/api/rooms/${encodeURIComponent(id)}/file?path=${encodeURIComponent(rel)}`).then((d) => d.content)
  }
}

const local = new Local()
const terminal = ['done', 'needs_human', 'stopped', 'error', 'interrupted']

function keyOf(number) {
  return `${cfg.repo}#${number}`
}

function fmtMessage(m) {
  const label = m.kind === 'human' ? '提问人' : m.label
  return `${BOT_MARK}\n**${label}** · R${m.round} · ${m.kind}\n\n${m.content}`
}

async function post(number, md) {
  if (DRY) {
    console.log(`[dry] #${number}:\n${md.slice(0, 160)}\n---`)
    return null
  }
  return hub.postComment(number, md)
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: config.root, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

async function commitArchive(relPaths, message) {
  if (!cfg.git || DRY) return { skipped: true }
  const add = await git(['add', '--', ...relPaths])
  if (add.code !== 0) return { ok: false, out: add.out }
  const st = await git(['status', '--porcelain'])
  if (!st.out.trim()) return { ok: true, out: 'nothing to commit' }
  const c = await git([
    '-c', 'user.name=' + (process.env.GIT_AUTHOR_NAME || 'agent-collab'),
    '-c', 'user.email=' + (process.env.GIT_AUTHOR_EMAIL || 'agent-collab@localhost'),
    'commit', '-q', '-m', message,
  ])
  if (c.code !== 0) return { ok: false, out: c.out }
  const p = await git(['push', cfg.remote, `HEAD:${cfg.branch}`])
  return { ok: p.code === 0, out: p.code === 0 ? 'pushed' : p.out.slice(0, 300) }
}

async function stopAndWait(roomId, timeoutMs = 90000) {
  try {
    await local.stop(roomId)
  } catch {}
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let room
    try {
      room = await local.room(roomId)
    } catch {
      return null
    }
    if (!room || terminal.includes(room.status)) return room
    await sleep(1000)
  }
  return null
}

function isEndSignal(disc) {
  if (!disc) return false
  if (Number(disc.is_closed) === 1) return true
  const title = String(disc.title || '')
  if (/\[(end|结束)\]/i.test(title)) return true
  const category = String(disc.category?.name || '').trim().toLowerCase()
  if (cfg.endCategory && category === cfg.endCategory.toLowerCase()) return true
  return false
}

function isEndComment(text) {
  return /^\s*\/?(end|结束|stop)\s*$/i.test(String(text || ''))
}

async function endDiscussion(number, entry, reason) {
  if (entry.ended) return
  entry.ended = true
  console.log(`#${number} 结束信号：${reason}`)
  let room = null
  if (entry.roomId) {
    room = await stopAndWait(entry.roomId)
    entry.finished = true
    entry.finishedAt = entry.finishedAt || new Date().toISOString()
    await saveState()
  }
  await archiveRoom(number, entry)
  if (entry.roomId && cfg.closeOnEnd) {
    try {
      const res = await local.close(entry.roomId)
      entry.closed = true
      entry.closedAt = new Date().toISOString()
      entry.closeErrors = res?.errors || []
      await saveState()
      console.log(`#${number} 会话已关闭${res?.errors?.length ? `（异常 ${res.errors.length}）` : ''}`)
    } catch (e) {
      console.error(`#${number} 关闭会话失败：${e.message}`)
    }
  }
  await post(
    number,
    `${BOT_MARK}\n**讨论已结束**（${reason}）\n\n产出已归档并提交；${cfg.closeOnEnd ? '对应会话已关闭。' : '会话保留。'}\n\n${room ? `状态：${room.status} — ${room.reason || ''}` : ''}`
  )
  entry.finished = true
  await saveState()
}

async function archiveRoom(number, entry) {
  if (entry.archived || !entry.roomId) return
  const room = await local.room(entry.roomId).catch(() => null)
  const rel = path.relative(config.root, path.join(config.archiveDir, entry.roomId))
  const res = await commitArchive([rel], `archive(#${number}): ${(room?.task || entry.task || '').slice(0, 60)}`)
  if (res.ok || res.skipped) {
    entry.archived = true
    entry.archivedAt = new Date().toISOString()
    await saveState()
    console.log(`archive #${number} ${entry.roomId}: ${res.out}`)
  } else {
    console.error(`archive #${number} failed: ${res.out}`)
  }
}

async function handleDiscussion(number) {
  const key = keyOf(number)
  const entry = state[key] || {
    roomId: null,
    posted: 0,
    lastHumanId: null,
    questionPosted: false,
    finished: false,
    archived: false,
  }
  state[key] = entry
  const disc = await hub.getDiscussion(number)
  if (entry.ended) return
  if (isEndSignal(disc)) {
    await endDiscussion(number, entry, Number(disc.is_closed) === 1 ? '讨论已关闭' : '标题/分类标记为 end')
    return
  }

  if (!entry.roomId) {
    const task = `${disc.title}\n\n${disc.md_content || ''}`.trim()
    const room = await local.createRoom(task)
    entry.roomId = room.id
    entry.task = task
    entry.createdAt = new Date().toISOString()
    await saveState()
    console.log(`#${number} -> room ${room.id}`)
    await post(number, `${BOT_MARK}\n已接收讨论 #${number}，三个模型开始协作。`)
    if (!DRY) await local.start(room.id)
    return
  }

  if (entry.finished) {
    if (!entry.archived) await archiveRoom(number, entry)
    return
  }

  const room = await local.room(entry.roomId)
  if (!room) return

  const messages = room.messages || []
  for (const m of messages.slice(entry.posted)) {
    if (m.kind === 'human') continue
    await post(number, fmtMessage(m))
    entry.posted += 1
    await saveState()
  }

  const comments = await hub.listComments(number)
  const human = comments.filter((c) => !isBotComment(c))
  const lastHuman = human[human.length - 1]
  if (lastHuman && lastHuman.id !== entry.lastHumanId) {
    entry.lastHumanId = lastHuman.id
    const text = lastHuman.md_content || ''
    if (isEndComment(text)) {
      await endDiscussion(number, entry, '评论区 /end')
      return
    }
    if (text.trim()) {
      await local.say(entry.roomId, text)
      entry.questionPosted = false
      console.log(`#${number} <- human input`)
    }
    await saveState()
  }

  if (room.status === 'waiting_input' && room.pendingQuestion && !entry.questionPosted) {
    await post(
      number,
      `${BOT_MARK}\n**需要你确认** · ${room.pendingQuestion.label}\n\n${room.pendingQuestion.question}\n\n> 直接在下面回复即可，回复后自动继续。`
    )
    entry.questionPosted = true
    await saveState()
  }

  if (terminal.includes(room.status)) {
    let summary = ''
    try {
      summary = await local.file(entry.roomId, 'DECISION.md')
    } catch {}
    const head = room.status === 'done' ? '讨论已收束' : `讨论结束：${room.reason || room.status}`
    await post(number, `${BOT_MARK}\n**${head}**\n\n${summary.slice(0, 3000)}`)
    entry.finished = true
    entry.finishedAt = new Date().toISOString()
    await saveState()
    await archiveRoom(number, entry)
  }
}

async function targets() {
  if (cfg.discussion) return [cfg.discussion]
  const list = await hub.listDiscussions()
  const since = state.__meta?.since || ''
  return list
    .filter((d) => !d.is_closed)
    .filter((d) => !owner || d.author?.login === owner)
    .filter((d) => cfg.includeExisting || String(d.created_at || '') >= since)
    .map((d) => d.number)
}

async function tick() {
  for (const n of await targets()) {
    if (shuttingDown) return
    try {
      await handleDiscussion(n)
    } catch (e) {
      console.error(`#${n} error: ${e.message}`)
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[${signal}] 停止轮询，收尾中…`)
  const active = Object.entries(state).filter(([k, v]) => k !== '__meta' && v.roomId && !v.finished)
  for (const [key, entry] of active) {
    const number = Number(key.split('#').pop())
    try {
      const room = await stopAndWait(entry.roomId)
      if (room) {
        entry.finished = true
        entry.finishedAt = new Date().toISOString()
        if (!DRY) await post(number, `${BOT_MARK}\n**服务停止，讨论中断**（${room.status}: ${room.reason || ''}）\n\n归档已保存。`)
        await archiveRoom(number, entry)
      }
    } catch (e) {
      console.error(`shutdown #${number}: ${e.message}`)
    }
  }
  await saveState()
  console.log('已退出')
  process.exit(0)
}

async function main() {
  await loadState()
  if (!owner) {
    try {
      const me = await hub.request('/api/v5/user')
      owner = me?.login || ''
    } catch {}
  }
  if (!DRY) {
    const h = await local.health().catch(() => null)
    if (!h?.ok) {
      console.error(`本地服务不可用（${cfg.collabUrl}），请先 npm start`)
      process.exit(1)
    }
  }
  console.log(`connector: ${cfg.repo} @ ${cfg.base}${cfg.discussion ? ` #${cfg.discussion}` : ' 全部讨论'}${DRY ? ' [dry]' : ''}`)
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  do {
    await tick()
    if (!ONCE && !shuttingDown) await sleep(cfg.pollMs)
  } while (!ONCE && !shuttingDown)
}

main().catch((e) => {
  console.error('fatal:', e.message)
  process.exit(1)
})
