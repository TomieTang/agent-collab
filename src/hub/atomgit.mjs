export class AtomGitHub {
  constructor({ base = 'https://atomgit.com', repo, token }) {
    this.base = base.replace(/\/+$/, '')
    this.repo = repo
    this.token = token
  }

  async request(path, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'private-token': this.token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`hub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }

  listDiscussions() {
    return this.request(`/api/v5/repos/${this.repo}/discuss`)
  }

  getDiscussion(number) {
    return this.request(`/api/v5/repos/${this.repo}/discuss/${number}`)
  }

  listComments(number) {
    return this.request(`/api/v5/repos/${this.repo}/discuss/${number}/comment`)
  }

  postComment(number, md) {
    return this.request(`/api/v5/repos/${this.repo}/discuss/${number}/comment`, {
      method: 'POST',
      body: { md_content: md },
    })
  }

  deleteComment(number, id) {
    return this.request(`/api/v5/repos/${this.repo}/discuss/${number}/comment/${id}`, { method: 'DELETE' })
  }
}

export const BOT_MARK = '<!-- agent-collab -->'

export function isBotComment(comment) {
  return String(comment?.md_content || '').includes(BOT_MARK)
}
