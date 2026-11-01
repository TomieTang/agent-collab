const $ = (s) => document.querySelector(s)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

let current = null
let source = null
let roles = null

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status })
  return data
}

async function boot() {
  try {
    await api('/api/me')
    showApp()
  } catch {
    $('#login').classList.remove('hidden')
  }
}

function showApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
  refreshHealth()
  refreshRooms()
}

async function refreshHealth() {
  const h = await api('/api/health').catch(() => null)
  const node = $('#health')
  if (!h) return (node.textContent = '服务异常')
  const n = h.models?.length || 0
  node.textContent = h.ok
    ? `${h.mock ? 'MOCK 模式' : 'LIVE'} · ${n} 个模型可用`
    : h.reason || 'opencode 不可用'
  node.style.color = h.ok ? 'var(--muted)' : 'var(--danger)'
}

async function refreshRooms() {
  const { rooms } = await api('/api/rooms')
  const list = $('#room-list')
  list.textContent = ''
  for (const r of rooms) {
    const item = el('div', 'room-item' + (current?.id === r.id ? ' active' : ''))
    item.append(el('div', 'req', r.requirement))
    const sub = el('div', 'sub')
    sub.append(el('span', `badge ${r.status}`, statusText(r.status)))
    sub.append(el('span', '', `${r.round}/${r.maxRounds} 轮`))
    if (r.mock) sub.append(el('span', '', 'MOCK'))
    item.append(sub)
    item.onclick = () => selectRoom(r.id)
    list.append(item)
  }
}

function statusText(s) {
  return { created: '待开始', running: '进行中', paused: '已暂停', done: '已完成', needs_human: '需人工', error: '出错', stopped: '已停止', interrupted: '中断' }[s] || s
}

async function selectRoom(id) {
  const { room } = await api(`/api/rooms/${id}`)
  current = room
  renderRoom()
  refreshRooms()
  openStream(id)
}

function renderRoom() {
  const room = current
  $('#empty').classList.add('hidden')
  $('#room').classList.remove('hidden')
  $('#room-title').textContent = room.requirement.split('\n')[0].slice(0, 60)
  renderMeta()
  $('#reason').textContent = room.reason ? `结束原因：${room.reason}` : ''

  const chat = $('#tab-chat')
  chat.textContent = ''
  for (const [key, role] of Object.entries(room.roles)) {
    const col = el('div', 'col')
    col.dataset.role = key
    col.append(el('h4', '', `${role.label} · ${role.model}`))
    for (const m of room.messages.filter((x) => x.role === key)) col.append(msgNode(m))
    chat.append(col)
  }

  const sel = $('#inject-role')
  sel.textContent = ''
  for (const [key, role] of Object.entries(room.roles)) {
    const o = el('option', '', `${role.label}`)
    o.value = key
    sel.append(o)
  }

  const fl = $('#file-list')
  fl.textContent = ''
  for (const f of room.artifacts || []) {
    const li = el('li', '', f)
    li.onclick = () => viewFile(f)
    fl.append(li)
  }
  if (!room.artifacts?.length) fl.append(el('li', 'muted', '暂无文件'))
  loadBoard()
  scrollChat()
}

function renderMeta() {
  const room = current
  const rolesText = Object.entries(room.roles).map(([k, v]) => `${k}=${v.model}`).join('  ·  ')
  $('#room-meta').textContent = `${statusText(room.status)} · ${room.round}/${room.maxRounds} 轮 · ${rolesText}`
}

function msgNode(m) {
  const n = el('div', 'msg' + (m.kind === 'human' ? ' human' : ''))
  const head = el('div', 'msg-head')
  head.append(el('span', '', `R${m.round} · ${m.kind}`))
  head.append(el('span', '', new Date(m.at).toLocaleTimeString()))
  n.append(head, el('pre', '', m.content))
  return n
}

function scrollChat() {
  for (const c of document.querySelectorAll('.chat .col')) c.scrollTop = c.scrollHeight
}

function openStream(id) {
  if (source) source.close()
  source = new EventSource(`/api/rooms/${id}/events`)
  source.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    if (!current || current.id !== id) return
    handleEvent(ev)
  }
}

function handleEvent(ev) {
  if (ev.type === 'message') {
    const col = document.querySelector(`.chat .col[data-role="${ev.role}"]`)
    if (col) {
      col.querySelector('.thinking')?.remove()
      const m = { role: ev.role, round: ev.round, kind: ev.kind, content: ev.content, at: ev.at }
      current.messages.push(m)
      col.append(msgNode(m))
      scrollChat()
      if (ev.kind !== 'human') loadBoard()
      refreshArtifacts()
    }
  }
  if (ev.type === 'thinking') {
    const col = document.querySelector(`.chat .col[data-role="${ev.role}"]`)
    if (col && !col.querySelector('.thinking')) {
      const t = el('div', 'msg thinking', '思考中…')
      t.style.opacity = '.6'
      col.append(t)
      scrollChat()
    }
  }
  if (ev.type === 'status') {
    current.status = ev.status
    renderMeta()
    refreshRooms()
  }
  if (ev.type === 'round_start') {
    current.round = ev.round
    renderMeta()
    refreshRooms()
  }
  if (ev.type === 'verdict') {
    const bits = [`R${ev.round} 判定：评审 ${ev.reviewOk ? '通过' : '未通过'}`, `核验 ${ev.verifyOk ? '通过' : '未通过'}`, `命令 ${ev.commandsOk ? '通过' : '未通过'}`]
    if (!ev.reviewOk && ev.missingChecklist?.length) bits.push(`缺项 ${ev.missingChecklist.join('/')}`)
    $('#reason').textContent = bits.join(' · ')
  }
  if (ev.type === 'error') $('#reason').textContent = `错误：${ev.message}`
  if (ev.type === 'done') {
    current.status = ev.status
    current.reason = ev.reason
    $('#reason').textContent = `结束：${statusText(ev.status)} — ${ev.reason}`
    refreshRooms()
    refreshArtifacts()
    loadBoard()
  }
}

async function refreshArtifacts() {
  const { room } = await api(`/api/rooms/${current.id}`)
  current.artifacts = room.artifacts
  const fl = $('#file-list')
  fl.textContent = ''
  for (const f of room.artifacts) {
    const li = el('li', '', f)
    li.onclick = () => viewFile(f)
    fl.append(li)
  }
}

async function viewFile(path) {
  const { content } = await api(`/api/rooms/${current.id}/file?path=${encodeURIComponent(path)}`)
  $('#file-view').textContent = content
  $('#file-view').classList.remove('muted')
  for (const li of document.querySelectorAll('#file-list li')) li.classList.toggle('active', li.textContent === path)
}

async function loadBoard() {
  try {
    const { content } = await api(`/api/rooms/${current.id}/file?path=board.md`)
    $('#board').textContent = content
  } catch {}
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault()
  $('#login-error').textContent = ''
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) })
    showApp()
  } catch (err) {
    $('#login-error').textContent = err.message
  }
}

$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' })
  location.reload()
}

$('#new-room').onclick = async () => {
  $('#modal').classList.remove('hidden')
  $('#create-error').textContent = ''
  if (!roles) {
    roles = (await api('/api/roles')).roles
    const box = $('#role-preview')
    box.textContent = ''
    for (const [k, v] of Object.entries(roles)) box.append(el('div', '', `${v.label}: ${v.model} → agent=${v.agent}`))
  }
}

$('#cancel-create').onclick = () => $('#modal').classList.add('hidden')

$('#create-form').onsubmit = async (e) => {
  e.preventDefault()
  $('#create-error').textContent = ''
  const payload = {
    requirement: $('#f-requirement').value,
    doneWhen: $('#f-done').value.split('\n').map((s) => s.trim()).filter(Boolean),
    maxRounds: Number($('#f-rounds').value),
  }
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: JSON.stringify(payload) })
    $('#modal').classList.add('hidden')
    await refreshRooms()
    await selectRoom(room.id)
    await api(`/api/rooms/${room.id}/start`, { method: 'POST' })
  } catch (err) {
    $('#create-error').textContent = err.message
  }
}

$('#btn-start').onclick = async () => {
  await api(`/api/rooms/${current.id}/start`, { method: 'POST' })
  refreshRooms()
}
$('#btn-pause').onclick = async () => {
  await api(`/api/rooms/${current.id}/pause`, { method: 'POST' })
}
$('#btn-stop').onclick = async () => {
  await api(`/api/rooms/${current.id}/stop`, { method: 'POST' })
}

$('#inject-send').onclick = async () => {
  const text = $('#inject-text').value.trim()
  if (!text) return
  const role = $('#inject-role').value
  $('#inject-text').value = ''
  try {
    await api(`/api/rooms/${current.id}/inject`, { method: 'POST', body: JSON.stringify({ role, text }) })
  } catch (err) {
    $('#reason').textContent = `插话失败：${err.message}`
  }
}

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn)
    for (const id of ['chat', 'board', 'files']) {
      $(`#tab-${id}`).classList.toggle('hidden', id !== btn.dataset.tab)
    }
    if (btn.dataset.tab === 'board') loadBoard()
    if (btn.dataset.tab === 'files') refreshArtifacts()
  }
}

boot()
