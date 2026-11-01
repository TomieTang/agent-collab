import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const COLLAB_PORT = 3981
const HUB_PORT = 3982
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-collab-conn-'))

const discussions = []
const comments = {}

const hub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, data) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (url.pathname === '/api/v5/user') return send(200, { login: 'tangjie66' })
  if (url.pathname === '/api/v5/repos/o/r/discuss') return send(200, discussions)
  let m = url.pathname.match(/^\/api\/v5\/repos\/o\/r\/discuss\/(\d+)$/)
  if (m) return send(200, discussions.find((d) => d.number === Number(m[1])))
  m = url.pathname.match(/^\/api\/v5\/repos\/o\/r\/discuss\/(\d+)\/comment$/)
  if (m) {
    const n = Number(m[1])
    if (req.method === 'POST') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw || '{}')
      const c = { id: `c${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, md_content: body.md_content, created_at: new Date().toISOString() }
      ;(comments[n] ||= []).push(c)
      return send(200, c)
    }
    return send(200, comments[n] || [])
  }
  send(404, { error: 'not found' })
})
await new Promise((r) => hub.listen(HUB_PORT, '127.0.0.1', r))

const env = {
  ...process.env,
  COLLAB_MOCK: '1',
  COLLAB_PASSWORD: 'test-pass',
  COLLAB_PORT: String(COLLAB_PORT),
  COLLAB_ARCHIVE: path.join(tmp, 'requirements'),
  COLLAB_WORKSPACE: path.join(tmp, 'workspace'),
  COLLAB_HOST: '127.0.0.1',
}
await fs.mkdir(env.COLLAB_WORKSPACE, { recursive: true })

const server = spawn('node', ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${COLLAB_PORT}/api/health`)
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error('server did not start')
}

const stateFile = path.join(tmp, 'connector.json')
const connEnv = {
  ...process.env,
  HUB_BASE: `http://127.0.0.1:${HUB_PORT}`,
  HUB_REPO: 'o/r',
  HUB_TOKEN: 'x',
  HUB_POLL_MS: '1000',
  HUB_MAX_ROUNDS: '2',
  CONNECTOR_STATE: stateFile,
  CONNECTOR_GIT: '0',
  COLLAB_PORT: String(COLLAB_PORT),
  COLLAB_PASSWORD: 'test-pass',
}

function cleanup(code) {
  server.kill('SIGKILL')
  hub.close()
  process.exit(code)
}

try {
  await waitUp()

  const conn = spawn('node', ['src/connector.mjs'], { cwd: ROOT, env: connEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  conn.stdout.on('data', (d) => (log += d))
  conn.stderr.on('data', (d) => (log += d))
  await sleep(1500)

  const now = new Date().toISOString()
  discussions.push(
    { number: 1, title: 'TASK-ONE 讨论接口设计', md_content: '实现 A', author: { login: 'tangjie66' }, created_at: now, is_closed: 0 },
    { number: 2, title: 'TASK-TWO 讨论错误处理', md_content: '实现 B', author: { login: 'tangjie66' }, created_at: now, is_closed: 0 },
    { number: 3, title: 'TASK-THREE 保持等待', md_content: '实现 C', author: { login: 'tangjie66' }, created_at: now, is_closed: 0 },
    { number: 4, title: 'TASK-FOUR 手动结束', md_content: '实现 D', author: { login: 'tangjie66' }, created_at: now, is_closed: 0 }
  )

  const asked = (n) => (comments[n] || []).some((c) => String(c.md_content).includes('需要你确认'))
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (asked(1) && asked(2)) break
  }
  assert.ok(asked(1) && asked(2), 'both discussions should ask the human before finishing')
  for (const n of [1, 2]) {
    ;(comments[n] ||= []).push({ id: `human-${n}`, md_content: '每秒 100 条，P99 50ms', created_at: new Date().toISOString() })
  }

  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const st = JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => '{}'))
    if (st['o/r#1']?.finished && st['o/r#2']?.finished) break
  }

  const st = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  const one = st['o/r#1']
  const two = st['o/r#2']
  assert.ok(one?.roomId, 'discussion #1 should create a room')
  assert.ok(two?.roomId, 'discussion #2 should create a room')
  assert.notEqual(one.roomId, two.roomId, 'rooms must be isolated per discussion')
  assert.equal(one.finished, true, 'discussion #1 should finish')
  assert.equal(two.finished, true, 'discussion #2 should finish')

  const login = await fetch(`http://127.0.0.1:${COLLAB_PORT}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const getRoom = (id) => fetch(`http://127.0.0.1:${COLLAB_PORT}/api/rooms/${encodeURIComponent(id)}`, { headers: { cookie } }).then((r) => r.json())
  const r1 = await getRoom(one.roomId)
  const r2 = await getRoom(two.roomId)
  for (const role of ['architect', 'reviewer', 'verifier']) {
    assert.notEqual(r1.room.roles[role].sessionID, r2.room.roles[role].sessionID, `session must differ for ${role}`)
  }
  assert.match(r1.room.task, /TASK-ONE/)
  assert.match(r2.room.task, /TASK-TWO/)

  assert.ok(comments[1]?.length > 0, 'discussion #1 should receive comments')
  assert.ok(comments[2]?.length > 0, 'discussion #2 should receive comments')
  assert.ok(!JSON.stringify(comments[1]).includes('TASK-TWO'), 'no cross-talk into #1')

  const asked4 = () => (comments[4] || []).some((c) => String(c.md_content).includes('需要你确认'))
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (asked4()) break
  }
  assert.ok(asked4(), 'discussion #4 should reach the asking state')
  ;(comments[4] ||= []).push({ id: 'human-end-4', md_content: '/end', created_at: new Date().toISOString() })

  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const cur = JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => '{}'))
    if (cur['o/r#4']?.closed) break
  }
  const stEnd = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  assert.equal(stEnd['o/r#4'].ended, true, '#4 should end on /end')
  assert.equal(stEnd['o/r#4'].closed, true, '#4 sessions should be closed')
  assert.equal(stEnd['o/r#4'].archived, true, '#4 should be archived before closing')
  const room4 = await getRoom(stEnd['o/r#4'].roomId)
  assert.equal(room4.room.closed, true, 'room #4 should be marked closed')
  assert.ok((await fs.stat(path.join(env.COLLAB_ARCHIVE, stEnd['o/r#4'].roomId, 'sessions', 'architect.json')).catch(() => null)), 'closed room must export raw sessions')

  const before = Object.keys(st).filter((k) => k !== '__meta').length
  conn.kill('SIGTERM')
  await new Promise((r) => conn.on('exit', r))

  const after = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  assert.equal(Object.keys(after).filter((k) => k !== '__meta').length, before)
  for (const key of ['o/r#1', 'o/r#2', 'o/r#3']) {
    assert.equal(after[key].finished, true, `${key} should be finalized on shutdown`)
    assert.equal(after[key].archived, true, `${key} should be archived on shutdown/finish`)
    const dir = path.join(env.COLLAB_ARCHIVE, after[key].roomId)
    const stat = await fs.stat(path.join(dir, 'REPORT.md')).catch(() => null)
    assert.ok(stat, `${key} archive should contain REPORT.md`)
  }
  assert.match(log, /已退出|停止轮询/)

  console.log('PASS discussion 连接器：多讨论隔离 + 优雅退出归档')
  cleanup(0)
} catch (e) {
  console.error('FAIL', e)
  cleanup(1)
}
