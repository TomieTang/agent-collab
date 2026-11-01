const $ = (s) => document.querySelector(s)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const store = {
  tabs: [],
  active: null,
  rooms: [],
}
let current = null
let source = null
let roles = null
let modes = null
let pollTimer = null

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

function saveTabs() {
  sessionStorage.setItem('collab.tabs', JSON.stringify({ tabs: store.tabs, active: store.active }))
}

function loadTabs() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('collab.tabs') || '{}')
    if (Array.isArray(saved.tabs)) store.tabs = saved.tabs
    if (saved.active) store.active = saved.active
  } catch {}
}

async function boot() {
  try {
    await api('/api/me')
  } catch {
    $('#login').classList.remove('hidden')
    return
  }
  showApp()
}

function showApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
  loadTabs()
  api('/api/modes').then((d) => {
    modes = d.modes
    refreshRooms()
  }).catch(() => {})
  refreshHealth()
  if (store.active && store.tabs.includes(store.active)) openRoom(store.active)
  pollTimer = setInterval(poll, 3000)
}

async function refreshHealth() {
  const h = await api('/api/health').catch(() => null)
  const node = $('#health')
  if (!h) return (node.textContent = '服务异常')
  node.textContent = h.ok
    ? `${h.mock ? 'MOCK' : 'LIVE'} · ${h.models.length} 个模型 · 并发 ${h.concurrency ?? '-'}`
    : h.reason || 'opencode 不可用'
  node.style.color = h.ok ? 'var(--muted)' : 'var(--danger)'
}

async function refreshRooms() {
  const { rooms } = await api('/api/rooms')
  store.rooms = rooms
  renderSidebar()
  renderTabs()
}

function renderSidebar() {
  const list = $('#room-list')
  list.textContent = ''
  for (const r of store.rooms) {
    const item = el('div', 'room-item' + (store.active === r.id ? ' active' : ''))
    item.append(el('div', 'req', r.task || r.requirement))
    const sub = el('div', 'sub')
    sub.append(el('span', `badge ${r.status}`, statusText(r.status)))
    sub.append(el('span', '', `${r.round}/${r.maxRounds} 轮`))
    if (r.mode && r.mode !== 'build') sub.append(el('span', '', modeLabel(r.mode)))
    if (r.closed) sub.append(el('span', 'badge closed', '已关闭'))
    if (r.mock) sub.append(el('span', '', 'MOCK'))
    item.onclick = () => openRoom(r.id)
    list.append(item)
  }
}

function renderTabs() {
  const bar = $('#tabbar')
  bar.textContent = ''
  bar.classList.toggle('hidden', store.tabs.length === 0)
  for (const id of store.tabs) {
    const room = store.rooms.find((r) => r.id === id)
    const tab = el('button', 'tab' + (store.active === id ? ' active' : ''))
    tab.append(el('span', `dot ${room?.status || 'idle'}`))
    tab.append(el('span', 'tab-title', room ? shortTitle(room.task || room.requirement) : id))
    const x = el('span', 'tab-x', '×')
    x.onclick = (e) => {
      e.stopPropagation()
      closeTab(id)
    }
    tab.append(x)
    tab.onclick = () => openRoom(id)
    bar.append(tab)
  }
  const add = el('button', 'tab tab-add', '+')
  add.title = '新建需求'
  add.onclick = openCreate
  bar.append(add)
}

function modeLabel(id) {
  return modes?.find((m) => m.id === id)?.label || id
}

function shortTitle(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 16)
}

function closeTab(id) {
  store.tabs = store.tabs.filter((t) => t !== id)
  if (store.active === id) {
    store.active = store.tabs[store.tabs.length - 1] || null
    if (store.active) return openRoom(store.active)
    current = null
    if (source) source.close()
    source = null
    $('#room').classList.add('hidden')
    $('#empty').classList.remove('hidden')
  }
  saveTabs()
  renderTabs()
  renderSidebar()
}

async function openRoom(id) {
  if (!store.tabs.includes(id)) store.tabs.push(id)
  store.active = id
  saveTabs()
  const { room } = await api(`/api/rooms/${id}`)
  current = normalize(room)
  $('#empty').classList.add('hidden')
  $('#room').classList.remove('hidden')
  renderRoom()
  renderTabs()
  renderSidebar()
  openStream(id)
}

function normalize(room) {
  room.messages = room.messages || []
  room.artifacts = room.artifacts || []
  return room
}

function statusText(s) {
  return { created: '待开始', queued: '排队中', running: '进行中', paused: '已暂停', done: '已完成', needs_human: '需人工', error: '出错', stopped: '已停止', interrupted: '中断' }[s] || s
}

function renderRoom() {
  const room = current
  $('#room-title').textContent = (room.task || room.requirement).split('\n')[0].slice(0, 60)
  renderMeta()
  renderControls()
  $('#reason').textContent = room.reason
    ? `结束原因：${room.reason}`
    : room.isolated
      ? `独立工作区：${room.workspace}`
      : `共享工作区${room.isolationReason ? `（${room.isolationReason}）` : ''}`

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
    const o = el('option', '', role.label)
    o.value = key
    sel.append(o)
  }

  renderFiles()
  loadBoard()
}

function renderControls() {
  const terminal = ['done', 'needs_human', 'stopped', 'error', 'interrupted'].includes(current.status)
  const running = ['running', 'queued', 'paused'].includes(current.status)
  const closed = Boolean(current.closed)
  $('#btn-start').disabled = closed || running
  $('#btn-start').textContent = closed ? '已关闭' : '开始'
  $('#btn-pause').disabled = closed || !running
  $('#btn-stop').disabled = closed || !running
  $('#btn-close').classList.toggle('hidden', !terminal || closed)
}

function renderMeta() {
  const room = current
  const rolesText = Object.entries(room.roles).map(([k, v]) => `${k}=${v.model}`).join(' · ')
  const closed = room.closed ? ' · 已关闭会话' : ''
  $('#room-meta').textContent = `${statusText(room.status)}${closed} · ${modeLabel(room.mode || 'build')} · ${room.round}/${room.maxRounds} 轮 · ${rolesText}`
}

function renderFiles() {
  const fl = $('#file-list')
  fl.textContent = ''
  for (const f of current.artifacts) {
    const li = el('li', '', f)
    li.onclick = () => viewFile(f)
    fl.append(li)
  }
  if (!current.artifacts.length) fl.append(el('li', 'muted', '暂无文件'))
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
  source = new EventSource(`/api/rooms/${encodeURIComponent(id)}/events`)
  source.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    if (!current || current.id !== id) return
    handleEvent(ev)
  }
}

function handleEvent(ev) {
  if (ev.type === 'message') {
    const col = document.querySelector(`.chat .col[data-role="${ev.role}"]`)
    if (!col) return
    col.querySelector('.thinking')?.remove()
    const m = { role: ev.role, round: ev.round, kind: ev.kind, content: ev.content, at: ev.at }
    current.messages.push(m)
    col.append(msgNode(m))
    scrollChat()
    if (ev.kind !== 'human') {
      loadBoard()
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
    renderControls()
    refreshRooms()
  }
  if (ev.type === 'round_start') {
    current.round = ev.round
    renderMeta()
  }
  if (ev.type === 'verdict') {
    const bits = [`R${ev.round}：评审 ${ev.reviewOk ? '通过' : '未通过'}`, `核验 ${ev.verifyOk ? '通过' : '未通过'}`, `命令 ${ev.commandsOk ? '通过' : '未通过'}`]
    if (!ev.reviewOk && ev.missingChecklist?.length) bits.push(`缺项 ${ev.missingChecklist.join('/')}`)
    $('#reason').textContent = bits.join(' · ')
  }
  if (ev.type === 'error') $('#reason').textContent = `错误：${ev.message}`
  if (ev.type === 'closed') {
    current.closed = true
    current.closedAt = ev.closedAt
    renderMeta()
    renderControls()
    refreshArtifacts()
    refreshRooms()
  }
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
  current.artifacts = room.artifacts || []
  current.status = room.status
  current.round = room.round
  current.reason = room.reason
  current.closed = room.closed
  renderFiles()
  renderMeta()
  renderControls()
}

async function viewFile(path) {
  const { content } = await api(`/api/rooms/${encodeURIComponent(current.id)}/file?path=${encodeURIComponent(path)}`)
  $('#file-view').textContent = content
  $('#file-view').classList.remove('muted')
  for (const li of document.querySelectorAll('#file-list li')) li.classList.toggle('active', li.textContent === path)
}

async function loadBoard() {
  try {
    const { content } = await api(`/api/rooms/${encodeURIComponent(current.id)}/file?path=board.md`)
    $('#board').textContent = content
  } catch {}
}

async function poll() {
  if (document.hidden) return
  await refreshRooms().catch(() => {})
  if (!current) return
  const latest = store.rooms.find((r) => r.id === current.id)
  if (!latest) return
  if (latest.status !== current.status || latest.round !== current.round) {
    const { room } = await api(`/api/rooms/${current.id}`)
    current = normalize(room)
    renderRoom()
  }
}


function applyMode(id) {
  const m = modes?.find((x) => x.id === id)
  if (!m) return
  $('#mode-hint').textContent = m.hint
  $('#f-done').required = m.requireCommands
  $('#f-done').placeholder = m.requireCommands ? 'npm test（必填）' : '可选，例如复现脚本'
  const box = $('#role-preview')
  box.textContent = ''
  const labels = Object.entries(m.roles).map(([k, v]) => `${v}(${k})`).join(' → ')
  box.append(el('div', '', `协作链路：${labels}`))
  for (const [k, v] of Object.entries(roles || {})) box.append(el('div', '', `${m.roles[k] || v.label}: ${v.model}`))
}

async function openCreate() {
  $('#modal').classList.remove('hidden')
  $('#create-error').textContent = ''
  if (!roles) roles = (await api('/api/roles')).roles
  if (!modes) modes = (await api('/api/modes')).modes
  const sel = $('#f-mode')
  sel.textContent = ''
  for (const m of modes) {
    const o = el('option', '', m.label)
    o.value = m.id
    sel.append(o)
  }
  sel.onchange = () => applyMode(sel.value)
  applyMode(sel.value)
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
  sessionStorage.removeItem('collab.tabs')
  location.reload()
}

$('#new-room').onclick = openCreate
$('#cancel-create').onclick = () => $('#modal').classList.add('hidden')

$('#create-form').onsubmit = async (e) => {
  e.preventDefault()
  $('#create-error').textContent = ''
  const payload = {
    mode: $('#f-mode').value,
    task: $('#f-task').value,
    doneWhen: $('#f-done').value.split('\n').map((s) => s.trim()).filter(Boolean),
    maxRounds: Number($('#f-rounds').value),
  }
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: JSON.stringify(payload) })
    $('#modal').classList.add('hidden')
    $('#create-form').reset()
    $('#f-rounds').value = 3
    await refreshRooms()
    await openRoom(room.id)
    await api(`/api/rooms/${encodeURIComponent(room.id)}/start`, { method: 'POST' })
    await refreshRooms()
  } catch (err) {
    $('#create-error').textContent = err.message
  }
}

$('#btn-start').onclick = async () => {
  await api(`/api/rooms/${encodeURIComponent(current.id)}/start`, { method: 'POST' })
  await refreshRooms()
}
$('#btn-pause').onclick = () => api(`/api/rooms/${encodeURIComponent(current.id)}/pause`, { method: 'POST' }).then(refreshRooms)
$('#btn-stop').onclick = () => api(`/api/rooms/${encodeURIComponent(current.id)}/stop`, { method: 'POST' }).then(refreshRooms)

$('#btn-close').onclick = async () => {
  if (!confirm('关闭会删除 opencode 中的会话上下文，归档保留。继续？')) return
  try {
    const { room, errors } = await api(`/api/rooms/${encodeURIComponent(current.id)}/close`, { method: 'POST' })
    current.closed = true
    current.closedAt = room.closedAt
    renderMeta()
    renderControls()
    refreshArtifacts()
    refreshRooms()
    if (errors?.length) $('#reason').textContent = `会话已关闭，但有异常：${errors.join('；')}`
  } catch (err) {
    $('#reason').textContent = `关闭失败：${err.message}`
  }
}

$('#inject-send').onclick = async () => {
  const text = $('#inject-text').value.trim()
  if (!text) return
  const role = $('#inject-role').value
  $('#inject-text').value = ''
  try {
    await api(`/api/rooms/${encodeURIComponent(current.id)}/inject`, { method: 'POST', body: JSON.stringify({ role, text }) })
  } catch (err) {
    $('#reason').textContent = `插话失败：${err.message}`
  }
}

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn)
    for (const id of ['chat', 'board', 'files']) $(`#tab-${id}`).classList.toggle('hidden', id !== btn.dataset.tab)
    if (btn.dataset.tab === 'board') loadBoard()
    if (btn.dataset.tab === 'files') refreshArtifacts()
  }
}

window.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll()
})

boot()
