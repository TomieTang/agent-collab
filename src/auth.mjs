import crypto from 'node:crypto'

export function makeAuth(secret) {
  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url')

  return {
    issue(ttlMs = 7 * 86400000) {
      const exp = String(Date.now() + ttlMs)
      return `${exp}.${sign(exp)}`
    },
    verify(cookie) {
      if (!cookie || typeof cookie !== 'string') return false
      const i = cookie.lastIndexOf('.')
      if (i <= 0) return false
      const exp = cookie.slice(0, i)
      const sig = cookie.slice(i + 1)
      if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false
      const want = sign(exp)
      if (sig.length !== want.length) return false
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))
    },
    checkPassword(input) {
      if (!this.enabled) return true
      const a = Buffer.from(String(input ?? ''))
      const b = Buffer.from(secret)
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    },
    enabled: Boolean(secret),
  }
}

export function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
