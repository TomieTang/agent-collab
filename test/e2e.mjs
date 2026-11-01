import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const PORT = 3999
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-collab-'))
const env = {
  ...process.env,
  COLLAB_MOCK: '1',
  COLLAB_PASSWORD: 'test-pass',
  COLLAB_PORT: String(PORT),
  COLLAB_ARCHIVE: path.join(tmp, 'requirements'),
  COLLAB_WORKSPACE: path.join(tmp, 'workspace'),
  COLLAB_HOST: '127.0.0.1',
}
await fs.mkdir(env.COLLAB_WORKSPACE, { recursive: true })
await fs.writeFile(path.join(env.COLLAB_WORKSPACE, 'README.md'), '# demo workspace\n')
for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']]) {
  await new Promise((res, rej) =>
    import('node:child_process').then(({ execFile }) =>
      execFile('git', args, { cwd: env.COLLAB_WORKSPACE }, (e) => (e ? rej(e) : res()))
    )
  )
}

const server = spawn('node', ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] })
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

let cookied = false
let cookie = ''

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  })
  const set = res.headers.get('set-cookie')
  if (set) {
    cookie = set.split(';')[0]
    cookied = true
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/api/health')
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error('server did not start')
}

function cleanup(code) {
  server.kill('SIGKILL')
  console.log(code === 0 ? `\nOK  归档目录：${tmp}` : '')
  process.exit(code)
}

try {
  await waitUp()

  await assert.rejects(api('/api/rooms'), /401|未登录/)
  const bad = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
  assert.equal(bad.status, 401)

  await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'test-pass' }) })
  assert.ok(cookied, 'login should set cookie')

  const models = await api('/api/models')
  assert.equal(models.ok, true)
  assert.ok(models.models.length >= 3, 'mock exposes 3 models')

  const { room } = await api('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      requirement: '给配置模块增加校验：非法输入返回 EINVAL，并补一条超时用例',
      doneWhen: ['node -e "process.exit(0)"'],
      maxRounds: 3,
    }),
  })
  assert.equal(room.status, 'created')
  assert.equal(Object.keys(room.roles).length, 3)
  for (const r of Object.values(room.roles)) assert.match(r.sessionID, /^mock-ses-/)

  await api(`/api/rooms/${room.id}/start`, { method: 'POST' })

  let final = null
  for (let i = 0; i < 100; i++) {
    await sleep(300)
    const { room: r } = await api(`/api/rooms/${room.id}`)
    if (['done', 'needs_human', 'error', 'stopped'].includes(r.status)) {
      final = r
      break
    }
  }
  assert.ok(final, 'room should finish')
  assert.equal(final.status, 'done', `expected done, got ${final.status}: ${final.reason}`)
  assert.equal(final.round, 2, 'should converge on round 2')

  const dir = path.join(env.COLLAB_ARCHIVE, room.id)
  const files = ['room.json', 'board.md', 'transcript.md', 'events.jsonl', 'DECISION.md', 'REPORT.md',
    'round-1/proposal-architect.md', 'round-1/review-reviewer.md', 'round-1/verify-verifier.md', 'round-1/meta.json',
    'round-2/proposal-architect.md', 'round-2/review-reviewer.md', 'round-2/verify-verifier.md', 'round-2/commands.log']
  for (const f of files) {
    const st = await fs.stat(path.join(dir, f)).catch(() => null)
    assert.ok(st, `missing archive file: ${f}`)
  }

  const transcript = await fs.readFile(path.join(dir, 'transcript.md'), 'utf8')
  for (const role of ['architect', 'reviewer', 'verifier']) assert.ok(transcript.includes(`role: \`${role}\``), `transcript missing ${role}`)

  const report = await fs.readFile(path.join(dir, 'REPORT.md'), 'utf8')
  assert.match(report, /状态：`done`/)
  assert.match(report, /node -e/)

  const ws1 = path.join(env.COLLAB_WORKSPACE, '.worktrees', room.id)
  assert.ok((await fs.stat(ws1).catch(() => null))?.isDirectory(), 'room should get its own worktree')
  assert.equal(final.isolated, true)

  const req2 = '再补一个并发用例：同一需求跑两次不互相覆盖'
  const { room: room2 } = await api('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ requirement: req2, doneWhen: ['node -e "process.exit(0)"'], maxRounds: 2 }),
  })
  assert.notEqual(room2.roles.architect.sessionID, room.roles.architect.sessionID)
  assert.notEqual(room2.workspace, room.workspace)
  await api(`/api/rooms/${room2.id}/start`, { method: 'POST' })
  await api(`/api/rooms/${room.id}/start`, { method: 'POST' })

  let final2 = null
  for (let i = 0; i < 120; i++) {
    await sleep(300)
    const { room: r } = await api(`/api/rooms/${encodeURIComponent(room2.id)}`)
    if (['done', 'needs_human', 'error', 'stopped'].includes(r.status)) {
      final2 = r
      break
    }
  }
  assert.equal(final2?.status, 'done', `second room: ${final2?.status} ${final2?.reason}`)
  assert.equal(room2.isolated, true)
  assert.ok((await fs.stat(path.join(env.COLLAB_WORKSPACE, '.worktrees', room2.id)).catch(() => null))?.isDirectory())

  const list = await api('/api/rooms')
  assert.ok(list.rooms.some((r) => r.id === room.id))
  assert.ok(list.rooms.some((r) => r.id === room2.id))

  console.log('PASS 需求归档流程')
  console.log(`  房间：${room.id}`)
  console.log(`  状态：${final.status}（${final.round} 轮）`)
  console.log(`  文件：${files.length} 个关键归档文件齐全`)
  cleanup(0)
} catch (e) {
  console.error('FAIL', e)
  cleanup(1)
}
