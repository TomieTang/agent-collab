export function splitModel(model) {
  const i = model.indexOf('/')
  if (i <= 0) throw new Error(`模型格式应为 provider/model，收到：${model}`)
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
}

export class OpencodeClient {
  constructor(cfg) {
    this.cfg = cfg
  }

  get enabled() {
    return Boolean(this.cfg?.url)
  }

  headers() {
    const h = { 'content-type': 'application/json' }
    if (this.cfg.pass) {
      const raw = `${this.cfg.user}:${this.cfg.pass}`
      h.authorization = `Basic ${Buffer.from(raw).toString('base64')}`
    }
    return h
  }

  async request(path, { method = 'GET', body } = {}) {
    const res = await fetch(this.cfg.url + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`)
      err.status = res.status
      throw err
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async listModels() {
    const data = await this.request('/provider')
    const providers = data?.all || data?.providers || []
    const seen = new Set()
    const out = []
    for (const p of providers) {
      const models = p.models || {}
      const entries = Array.isArray(models) ? models.map((m) => [m.id, m]) : Object.entries(models)
      for (const [id, meta] of entries) {
        if (!id || id === 'cannbot-error') continue
        const full = `${p.id}/${id}`
        if (seen.has(full)) continue
        seen.add(full)
        out.push({
          id: full,
          providerID: p.id,
          modelID: id,
          name: meta?.name || id,
          context: meta?.limit?.context ?? null,
          output: meta?.limit?.output ?? null,
        })
      }
    }
    return out
  }

  async createSession(title) {
    const data = await this.request('/session', { method: 'POST', body: { title } })
    return data.id
  }

  async ask(sessionID, { model, agent, text }) {
    const { providerID, modelID } = splitModel(model)
    const data = await this.request(`/session/${sessionID}/message`, {
      method: 'POST',
      body: { model: { providerID, modelID }, agent, parts: [{ type: 'text', text }] },
    })
    return {
      text: (data?.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n'),
      tokens: data?.info?.tokens?.output ?? data?.info?.tokens ?? null,
    }
  }

  async messages(sessionID) {
    return this.request(`/session/${sessionID}/message`)
  }

  async deleteSession(sessionID) {
    return this.request(`/session/${sessionID}`, { method: 'DELETE' })
  }

  async abort(sessionID) {
    try {
      return await this.request(`/session/${sessionID}/abort`, { method: 'POST' })
    } catch {
      return false
    }
  }

  async health() {
    try {
      const models = await this.listModels()
      const cannbot = models.filter((m) => m.providerID === 'cannbot')
      if (cannbot.length === 0) {
        return { ok: false, models, reason: 'CANNBOT 未注册任何模型：opencode 进程可能未登录或 JWT 已过期' }
      }
      return { ok: true, models }
    } catch (e) {
      return { ok: false, models: [], reason: `opencode 不可用：${e.message}` }
    }
  }
}
