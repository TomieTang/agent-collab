import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './src/config.mjs'
import { makeAuth, parseCookies } from './src/auth.mjs'
import { Archive, slugify } from './src/archive.mjs'
import { OpencodeClient } from './src/oc.mjs'
import { MockOpencodeClient } from './src/mock-oc.mjs'
import { runRoom } from './src/orchestrator.mjs'
import { prepareWorkspace } from './src/workspace.mjs'
import { MODES, modeList } from './src/modes.mjs'

const auth = makeAuth(config.secret)
const archive = new Archive(config.archiveDir)
const oc = config.mock ? new MockOpencodeClient() : new OpencodeClient(config.oc)
const rooms = new Map()
const active = new Map()
const queue = []
let runningCount = 0
const concurrency = Math.max(1, config.concurrency)
const subs = new Map()
const failCount = new Map()

const PUBLIC = path.join(config.root, 'public')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(res, code, data, headers = {}) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function cookies(req) {
  return parseCookies(req.headers.cookie || '')
}

function authed(req) {
  if (!config.password && config.allowNoAuth) return true
  if (!config.password) return false
  return auth.verify(cookies(req).collab)
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1_000_000) throw new Error('body too large')
  }
  if (!raw) return {}
  return JSON.parse(raw)
}

function emit(room, event) {
  const payload = { at: new Date().toISOString(), ...event }
  archive.appendEvent(room, payload).catch(() => {})
  if (event.type === 'message') {
    room.messages.push({
      at: payload.at,
      role: event.role,
      label: event.label,
      kind: event.kind,
      round: event.round,
      content: event.content,
    })
    archive.saveRoom(room).catch(() => {})
  }
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of subs.get(room.id) || []) {
    try {
      res.write(line)
    } catch {}
  }
}

const ctx = { oc, archive, config, workspace: config.workspace, emit }

async function ensureRoom(id) {
  if (rooms.has(id)) return rooms.get(id)
  const room = await archive.readRoom(id)
  room.control = 'run'
  room.messages = room.messages || []
  rooms.set(id, room)
  return room
}

function badRequest(message) {
  const e = new Error(message)
  e.status = 400
  return e
}

async function createRoom(payload) {
  const task = String(payload.task || payload.requirement || '').trim()
  if (!task) throw badRequest('任务描述不能为空')
  const mode = MODES[payload.mode] ? payload.mode : 'build'
  if (MODES[mode].requireCommands && !(Array.isArray(payload.doneWhen) && payload.doneWhen.length)) {
    throw badRequest(`${MODES[mode].label}必须至少设置一条验收命令`)
  }
  const maxRounds = Math.min(Math.max(Number(payload.maxRounds || config.maxRounds), 1), 8)
  const doneWhen = (Array.isArray(payload.doneWhen) ? payload.doneWhen : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
  const id = archive.newId(task)
  const ws = await prepareWorkspace(config.workspace, id)
  const roles = {}
  for (const [key, def] of Object.entries(config.roles)) {
    const sessionID = await oc.createSession(`${key} · ${slugify(task, 24)}`)
    roles[key] = { ...def, label: MODES[mode].roles[key] || def.label, sessionID }
  }
  const room = {
    id,
    task,
    mode,
    doneWhen,
    maxRounds,
    round: 0,
    status: 'created',
    control: 'run',
    mock: Boolean(config.mock),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    roles,
    workspace: ws.dir,
    isolated: Boolean(ws.isolated),
    isolationReason: ws.reason || '',
    worktreeBranch: ws.branch || '',
    artifacts: [],
    messages: [],
  }
  await archive.createRoom(room)
  rooms.set(id, room)
  return room
}

function startRoom(room) {
  if (active.has(room.id) || queue.some((r) => r.id === room.id)) return false
  room.status = 'queued'
  room.control = 'run'
  emit(room, { type: 'status', status: 'queued' })
  archive.saveRoom(room).catch(() => {})
  queue.push(room)
  pump()
  return true
}

function pump() {
  while (runningCount < concurrency && queue.length) {
    const room = queue.shift()
    if (room.control === 'stop') continue
    runningCount += 1
    active.set(room.id, true)
    runRoom(ctx, room)
      .catch((e) => {
        room.status = 'error'
        room.reason = e.message
      })
      .finally(() => {
        active.delete(room.id)
        runningCount -= 1
        pump()
      })
  }
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1))
  const file = path.resolve(PUBLIC, rel)
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return json(res, 403, { error: 'forbidden' })
  }
  try {
    const data = await fs.readFile(file)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname

  try {
    if (p === '/api/login') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const { password } = await body(req)
      if (!config.password && !config.allowNoAuth) {
        return json(res, 500, { error: '服务未设置 COLLAB_PASSWORD，拒绝启动登录' })
      }
      const ip = req.socket.remoteAddress || 'x'
      const fails = failCount.get(ip) || 0
      if (fails >= 5) return json(res, 429, { error: '尝试过多，稍后再试' })
      if (!auth.checkPassword(password)) {
        failCount.set(ip, fails + 1)
        return json(res, 401, { error: '密码错误' })
      }
      failCount.delete(ip)
      res.setHeader('set-cookie', `collab=${auth.issue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`)
      return json(res, 200, { ok: true })
    }

    if (p === '/api/logout') {
      res.setHeader('set-cookie', 'collab=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
      return json(res, 200, { ok: true })
    }

    if (p === '/api/health') {
      const h = await oc.health()
      return json(res, 200, { ...h, mock: Boolean(config.mock), workspace: config.workspace, concurrency, queued: queue.length, running: runningCount })
    }

    if (p.startsWith('/api/')) {
      if (!authed(req)) return json(res, 401, { error: '未登录' })
    }

    if (p === '/api/me') return json(res, 200, { ok: true })

    if (p === '/api/roles') return json(res, 200, { roles: config.roles })

    if (p === '/api/modes') return json(res, 200, { modes: modeList() })

    if (p === '/api/models') {
      const h = await oc.health()
      return json(res, 200, h)
    }

    if (p === '/api/rooms' && req.method === 'GET') {
      return json(res, 200, { rooms: await archive.listRooms() })
    }

    if (p === '/api/rooms' && req.method === 'POST') {
      const room = await createRoom(await body(req))
      return json(res, 200, { room })
    }

    const m = p.match(/^\/api\/rooms\/([^/]+)(?:\/(start|pause|stop|inject|events|file))?$/)
    if (m) {
      const room = await ensureRoom(decodeURIComponent(m[1]))
      const action = m[2]

      if (!action) return json(res, 200, { room })

      if (action === 'events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify({ type: 'hello', room: { id: room.id, status: room.status, round: room.round } })}\n\n`)
        if (!subs.has(room.id)) subs.set(room.id, new Set())
        subs.get(room.id).add(res)
        const timer = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => {
          clearInterval(timer)
          subs.get(room.id)?.delete(res)
        })
        return
      }

      if (action === 'start') {
        const started = startRoom(room)
        return json(res, 200, { started })
      }

      if (action === 'pause') {
        room.control = 'pause'
        return json(res, 200, { ok: true })
      }

      if (action === 'stop') {
        room.control = 'stop'
        const i = queue.findIndex((r) => r.id === room.id)
        if (i >= 0) {
          queue.splice(i, 1)
          room.status = 'stopped'
          room.reason = '排队中被停止'
          await archive.saveRoom(room)
          emit(room, { type: 'done', status: 'stopped', reason: room.reason })
        }
        await Promise.all(Object.values(room.roles).map((r) => oc.abort(r.sessionID)))
        return json(res, 200, { ok: true })
      }

      if (action === 'inject') {
        const { role, text } = await body(req)
        const target = room.roles[role]
        if (!target) return json(res, 400, { error: '未知角色' })
        const reply = await oc.ask(target.sessionID, { model: target.model, agent: target.agent, text: String(text || '') })
        const content = reply.text || ''
        boardAppend(room, role, content)
        return json(res, 200, { content })
      }
    }

    if (p.startsWith('/api/') && p.endsWith('/file')) {
      const id = decodeURIComponent(p.split('/')[3])
      const room = await ensureRoom(id)
      const rel = url.searchParams.get('path') || ''
      const content = await archive.readArtifact(room, rel)
      if (content === null) return json(res, 404, { error: '文件不存在' })
      return json(res, 200, { path: rel, content })
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' })

    return serveStatic(req, res, p)
  } catch (e) {
    const status = e.status && e.status < 500 ? e.status : 500
    json(res, status, { error: e.message })
  }
})

function boardAppend(room, role, text) {
  archive
    .appendTranscript(room, { round: room.round || 0, role, label: `Human→${role}`, model: '-', kind: 'human', content: text })
    .catch(() => {})
  emit(room, { type: 'message', role, label: `Human→${role}`, kind: 'human', round: room.round || 0, content: text })
}

async function main() {
  if (!config.mock && !config.password && !config.allowNoAuth) {
    console.error('拒绝启动：请设置 COLLAB_PASSWORD（或 COLLAB_ALLOW_NOAUTH=1 仅本机调试）')
    process.exit(1)
  }
  await archive.init()
  await fs.mkdir(config.workspace, { recursive: true })
  const restored = await archive.listRooms()
  for (const r of restored) {
    if (r.status === 'running') {
      const room = await ensureRoom(r.id)
      room.status = 'interrupted'
      room.reason = '服务重启，编排中断'
      await archive.saveRoom(room)
    }
  }
  server.listen(config.port, config.host, () => {
    console.log(`agent-collab 已启动 http://${config.host}:${config.port}`)
    console.log(`  mode=${config.mock ? 'MOCK' : 'LIVE'} workspace=${config.workspace}`)
    console.log(`  archive=${config.archiveDir}`)
  })
}

main()

process.on('SIGINT', () => {
  for (const set of subs.values()) for (const res of set) res.end()
  server.close(() => process.exit(0))
})
