import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env

export const DEFAULT_ROLES = {
  architect: {
    label: 'Architect',
    model: env.COLLAB_MODEL_ARCHITECT || 'cannbot/deepseek-v4-pro',
    agent: 'architect',
  },
  reviewer: {
    label: 'Reviewer',
    model: env.COLLAB_MODEL_REVIEWER || 'cannbot/glm-5.3',
    agent: 'reviewer',
  },
  verifier: {
    label: 'Verifier',
    model: env.COLLAB_MODEL_VERIFIER || 'cannbot/deepseek-v4.1-flash',
    agent: 'verifier',
  },
}

export const config = {
  root: ROOT,
  host: env.COLLAB_HOST || '127.0.0.1',
  port: Number(env.COLLAB_PORT || 3000),
  password: env.COLLAB_PASSWORD || '',
  allowNoAuth: env.COLLAB_ALLOW_NOAUTH === '1',
  secret: env.COLLAB_SECRET || env.COLLAB_PASSWORD || 'dev-only-secret',
  mock: env.COLLAB_MOCK === '1',
  archiveDir: env.COLLAB_ARCHIVE || path.join(ROOT, 'requirements'),
  workspace: env.COLLAB_WORKSPACE || path.join(ROOT, 'workspace'),
  maxRounds: Number(env.COLLAB_MAX_ROUNDS || 3),
  commandTimeoutMs: Number(env.COLLAB_CMD_TIMEOUT || 600000),
  oc: {
    url: env.OC_URL || 'http://127.0.0.1:4096',
    user: env.OC_USER || 'opencode',
    pass: env.OC_PASS || env.OPENCODE_SERVER_PASSWORD || '',
  },
  roles: DEFAULT_ROLES,
}
