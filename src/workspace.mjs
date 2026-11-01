import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

export async function isGitRepo(dir) {
  try {
    const st = await fs.stat(path.join(dir, '.git'))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

function branchFor(id) {
  const h = crypto.createHash('sha1').update(id).digest('hex').slice(0, 6)
  return `collab/${id.replace(/[^\w-]/g, '').slice(0, 32) || 'room'}-${h}`
}

export async function prepareWorkspace(base, id) {
  await fs.mkdir(base, { recursive: true })
  if (!(await isGitRepo(base))) {
    return { dir: base, isolated: false, reason: 'workspace 不是 git 仓库，无法建立独立 worktree' }
  }
  const head = await run('git', ['rev-parse', 'HEAD'], base)
  if (head.code !== 0) {
    return { dir: base, isolated: false, reason: 'workspace 还没有提交，无法建立 worktree' }
  }

  await fs.mkdir(path.join(base, '.worktrees'), { recursive: true })
  await fs.appendFile(path.join(base, '.git', 'info', 'exclude'), '\n.worktrees/\n').catch(() => {})

  const dir = path.join(base, '.worktrees', id)
  const branch = branchFor(id)
  let r = await run('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], base)
  if (r.code !== 0) r = await run('git', ['worktree', 'add', '--detach', dir, 'HEAD'], base)
  if (r.code !== 0) {
    return { dir: base, isolated: false, reason: `worktree 创建失败：${r.out.slice(0, 200)}` }
  }
  return { dir, branch, isolated: true }
}

export async function worktreeDiff(base, dir) {
  const r = await run('git', ['diff', '--stat', 'HEAD'], dir)
  return r.code === 0 ? r.out : ''
}
