import fs from 'node:fs/promises'
import path from 'node:path'

const pad = (n, w = 2) => String(n).padStart(w, '0')

export function slugify(text, max = 32) {
  const ascii = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (ascii || 'requirement').slice(0, max)
}

export class Archive {
  constructor(root) {
    this.root = root
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true })
    return this
  }

  newId(requirement) {
    const d = new Date()
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return `${ts}-${slugify(requirement)}`
  }

  roomDir(id) {
    return path.join(this.root, id)
  }

  async createRoom(room) {
    await fs.mkdir(this.roomDir(room.id), { recursive: true })
    await fs.writeFile(
      path.join(this.roomDir(room.id), 'board.md'),
      `# Board — ${(room.task || '').slice(0, 80)}\n\n## 任务类型\n${room.mode || 'build'}\n\n## 目标\n${room.task}\n\n## 已确认结论\n\n## 待决问题\n| ID | 提出方 | 严重度 | 状态 |\n| --- | --- | --- | --- |\n\n## 下一步\n`,
      'utf8'
    )
    await this.saveRoom(room)
  }

  async saveRoom(room) {
    room.updatedAt = new Date().toISOString()
    const dir = this.roomDir(room.id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'room.json'), JSON.stringify(room, null, 2), 'utf8')
  }

  async readRoom(id) {
    const raw = await fs.readFile(path.join(this.roomDir(id), 'room.json'), 'utf8')
    return JSON.parse(raw)
  }

  async listRooms() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    const rooms = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const file = path.join(this.root, e.name, 'room.json')
      try {
        const room = JSON.parse(await fs.readFile(file, 'utf8'))
        rooms.push({
          id: room.id,
          task: room.task || room.requirement,
          mode: room.mode || 'build',
          status: room.status,
          round: room.round,
          maxRounds: room.maxRounds,
          mock: room.mock,
          closed: Boolean(room.closed),
          createdAt: room.createdAt,
          updatedAt: room.updatedAt,
          roles: Object.fromEntries(Object.entries(room.roles || {}).map(([k, v]) => [k, v.model])),
        })
      } catch {
        continue
      }
    }
    return rooms.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  async ensureRound(room, round) {
    await fs.mkdir(path.join(this.roomDir(room.id), `round-${round}`), { recursive: true })
  }

  artifactPath(room, rel) {
    const p = path.resolve(this.roomDir(room.id), rel)
    if (!p.startsWith(path.resolve(this.roomDir(room.id)) + path.sep)) {
      throw new Error(`非法归档路径：${rel}`)
    }
    return p
  }

  async writeArtifact(room, rel, content) {
    const p = this.artifactPath(room, rel)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, content, 'utf8')
    if (!room.artifacts.includes(rel)) room.artifacts.push(rel)
    return p
  }

  async readArtifact(room, rel) {
    try {
      return await fs.readFile(this.artifactPath(room, rel), 'utf8')
    } catch {
      return null
    }
  }

  async appendEvent(room, event) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event })
    await fs.appendFile(path.join(this.roomDir(room.id), 'events.jsonl'), line + '\n', 'utf8')
  }

  async appendMeta(room, round, meta) {
    const p = this.artifactPath(room, `round-${round}/meta.json`)
    let list = []
    try {
      list = JSON.parse(await fs.readFile(p, 'utf8'))
    } catch {
      list = []
    }
    list.push(meta)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify(list, null, 2), 'utf8')
  }

  async appendTranscript(room, entry) {
    const time = new Date().toISOString().slice(11, 19)
    const block = `\n## [R${entry.round} ${time}] ${entry.label} · ${entry.kind}\n\n- role: \`${entry.role}\`\n- model: \`${entry.model}\`\n\n${entry.content.trim()}\n`
    await fs.appendFile(path.join(this.roomDir(room.id), 'transcript.md'), block, 'utf8')
  }

  async writeDecision(room, round, verdict, unresolved) {
    const proposal = (await this.readArtifact(room, `round-${round}/proposal-architect.md`)) || ''
    const content = `# DECISION — ${room.id}

- 任务类型：${room.mode || 'build'}
- 状态：${verdict}
- 轮次：${round}/${room.maxRounds}
- 模型：architect=${room.roles.architect.model} / reviewer=${room.roles.reviewer.model} / verifier=${room.roles.verifier.model}

## 最终方案

${proposal}

## 未解决项

${unresolved.length ? unresolved.map((u) => `- ${u}`).join('\n') : '- 无'}
`
    await this.writeArtifact(room, 'DECISION.md', content)
  }

  async appendReport(room, text) {
    await fs.appendFile(path.join(this.roomDir(room.id), 'REPORT.md'), text, 'utf8')
  }

  async writeReport(room, extra) {
    const files = await this.listFiles(room)
    const content = `# REPORT — ${room.id}

## 任务（${room.mode || 'build'}）

${room.task || room.requirement}

## 结果

- 状态：\`${room.status}\`
- 轮次：${room.round}/${room.maxRounds}
- 结束时间：${new Date().toISOString()}
- 原因：${room.reason || '-'}

## 分工

| 角色 | 模型 | opencode agent | session |
| --- | --- | --- | --- |
${Object.entries(room.roles)
  .map(([k, v]) => `| ${k} | \`${v.model}\` | \`${v.agent}\` | \`${v.sessionID}\` |`)
  .join('\n')}

## 验收命令

${(room.doneWhen || []).length ? room.doneWhen.map((c) => `- \`${c}\``).join('\n') : '- 未设置验收命令（按规则不得判为 done）'}

${extra?.commandLog ? `\n### 最后一轮命令输出\n\n\`\`\`\n${extra.commandLog.slice(0, 4000)}\n\`\`\`\n` : ''}

## 变更文件

${(extra?.changedFiles || []).length ? extra.changedFiles.map((f) => `- \`${f}\``).join('\n') : '- 无（或工作区不是 git 仓库）'}

## 未解决项

${(extra?.unresolved || []).length ? extra.unresolved.map((u) => `- ${u}`).join('\n') : '- 无'}

## 归档文件

${files.map((f) => `- \`${f}\``).join('\n')}
`
    await this.writeArtifact(room, 'REPORT.md', content)
  }

  async listFiles(room) {
    const base = this.roomDir(room.id)
    const out = []
    const walk = async (dir, prefix) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel)
        else out.push(rel)
      }
    }
    await walk(base, '')
    return out.sort()
  }
}
