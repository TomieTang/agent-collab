# Agent Collab

多模型 Agent 协作平台：给一个任务（开发、定位问题、分析评估、评审实现），由不同模型分别担任 **Architect（设计与实现）/ Reviewer（独立评审）/ Verifier（核验）**，按回合互相检视，直到评审、核验和验收命令全部通过；全过程落在 `requirements/<需求目录>/` 里归档。

底层复用 [opencode](https://opencode.ai) 的 headless server，不自研 agent 循环。

```
浏览器 ──登录──▶ 编排服务(server.mjs) ──HTTP──▶ opencode serve ──▶ 模型
                        │
                        └──▶ requirements/<id>/  (board.md / round-N/ / DECISION.md / REPORT.md)
```

## 快速开始

### 1. 零凭证演示（MOCK）

```bash
COLLAB_MOCK=1 COLLAB_PASSWORD=collab npm start
# 打开 http://127.0.0.1:3000 ，密码 collab
```

MOCK 模式用内置假模型跑完整流程，产物结构与真实运行一致，只是 `room.json` 里 `mock: true`。

### 2. 接入真实模型（CANNBOT / opencode）

```bash
# 终端 A：起 opencode server（必须先登录过 CANNBOT）
CANNBOT_GUI=1 OPENCODE_SERVER_PASSWORD=dev-pass opencode serve --hostname 127.0.0.1 --port 4096

# 终端 B：起编排服务
COLLAB_PASSWORD='换成你的密码' \
OC_PASS=dev-pass \
COLLAB_WORKSPACE=/path/to/your/repo \
npm start
```

- `CANNBOT_GUI=1` 必须加：插件的 TUI 模式只注册个人模型，GUI 模式才注册 builtin + personal。
- 三个角色默认使用 `cannbot/deepseek-v4-pro`、`cannbot/glm-5.3`、`cannbot/deepseek-v4.1-flash`，可用 `COLLAB_MODEL_ARCHITECT/REVIEWER/VERIFIER` 覆盖。
- 工作区（`COLLAB_WORKSPACE`）必须是 opencode agent 定义所在的仓库，把 `workspace-template/` 下的 `opencode.json` 和 `prompts/` 复制进去。

```bash
cp -r workspace-template/opencode.json workspace-template/prompts /path/to/your/repo/
```

### 3. 手机访问

服务只监听 `127.0.0.1`，通过隧道暴露，不要直接绑公网：

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

拿到 HTTPS 地址后在手机浏览器打开并登录。opencode 的 4096 端口始终留在本机。

## 配置

把以下内容存成项目根目录的 `.env`，`npm start` 会自动加载（已存在的环境变量优先）：

```bash
COLLAB_PASSWORD=dev123
OC_PASS=dev123
COLLAB_WORKSPACE=/path/to/your/repo
```


| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COLLAB_PASSWORD` | 空（必填） | 网页登录密码，自定义即可，无需注册；不设且未开 `COLLAB_ALLOW_NOAUTH=1` 时拒绝启动 |
| `COLLAB_SECRET` | 同密码 | Cookie 签名密钥 |
| `COLLAB_PORT` / `COLLAB_HOST` | 3000 / 127.0.0.1 | 监听地址 |
| `COLLAB_WORKSPACE` | `./workspace` | agent 实际改代码的仓库 |
| `COLLAB_ARCHIVE` | `./requirements` | 归档根目录 |
| `COLLAB_MAX_ROUNDS` | 3 | 房间默认轮次上限（1–8） |
| `COLLAB_CONCURRENCY` | 2 | 同时运行的房间数，超出排 `queued` |
| `OC_URL` / `OC_USER` / `OC_PASS` | `http://127.0.0.1:4096` / `opencode` / 空 | opencode server 连接信息 |
| `COLLAB_MODEL_ARCHITECT` 等 | 见上文 | 覆盖角色模型 |
| `COLLAB_MOCK` | 0 | `1` 启用 MOCK 适配器 |
| `COLLAB_CMD_TIMEOUT` | 600000 | 单条验收命令超时（ms） |

## 归档结构

每个需求一个目录，`requirements/<YYYYMMDD-HHMMSS>-<需求摘要>/`：

```
room.json              需求原文、角色/模型/session、轮次、状态、验收命令
board.md               共享状态板（agent 与人共写）
events.jsonl           机器可读事件流（SSE 同源）
transcript.md          全量对话，人可读
round-N/
  proposal-architect.md
  review-reviewer.md
  verify-verifier.md
  meta.json            模型、耗时、token
  commands.log         验收命令与退出码
DECISION.md            最终方案 + 未解决项
REPORT.md              结果、分工、变更文件、证据
```

运行期会在工作区创建 `.collab` 软链指向当前房间目录，让 agent 用 `.collab/round-N/...` 读写产物；房间结束后自动移除。

## 多任务并行与隔离

网页顶部是页签栏，一个页签 = 一个任务 = 一个房间：

- 每个房间单独创建 3 个 session，模型上下文互不可见
- 归档写入各自的 `requirements/<id>/`，互不覆盖
- 创建房间时在 `COLLAB_WORKSPACE/.worktrees/<id>` 建一个 git worktree 和 `collab/<id>` 分支，代码改动互不覆盖
- 房间结束后 worktree 保留，方便 `git diff` 对比后手工挑一版合并
- 关闭页签只是从界面移除，归档与 worktree 都还在

`COLLAB_CONCURRENCY`（默认 2）限制同时运行的房间数，其余显示「排队中」。工作区不是 git 仓库或还没有提交时无法建 worktree，会退回共享目录，此时请把并发设为 1。

## 两种协作方式

新建任务时选择，默认是**对话讨论**：

| 方式 | 怎么跑 | 适合 |
| --- | --- | --- |
| `chat` 对话讨论 | 三个 session 轮流发言（A→B→C→A），每次只把「对方新说的话」发给当前模型，各自维护自己的上下文；任意一方写 `[END]` 即收束 | 讨论方案、争论设计取舍、一起分析问题 |
| `pipeline` 流程协作 | 固定回合：提案 → 评审 → 核验 → 验收命令 → 判定，产物落 `round-N/` | 需要明确产出物和验收命令的开发任务 |

对话模式下 `maxRounds` 表示「每个模型最多发言轮数」，总发言次数 = 轮数 × 3。人工随时可以在底部插话，插话会作为新消息进入下一轮其他人的上下文。

人机协作规则：

- 你起头写任务描述，三个模型按分工轮流发言（提出方案 / 质疑 / 核对证据）
- 遇到取决于人的决策（范围、优先级、环境约束、成本），模型会输出 `[ASK] 问题`，房间转为 `waiting_input` 并停下
- 你在输入框补充后，消息广播给所有人，从上次中断处继续
- 任何一方输出 `[END]` 即收束

区别的关键：pipeline 里三个模型各司其职、互相看不到对方的完整立场；chat 里每个 session 都保存自己看过的全部对话，像三个人在群里讨论。

## 任务类型

新建任务时选择，三种角色的提示词、checklist 和收敛判据都随之切换：

| 类型 | 角色 | checklist | 判 `done` 的条件 | 验收命令 |
| --- | --- | --- | --- | --- |
| `build` 开发/实现 | Builder / Reviewer / Verifier | 需求覆盖、接口契约、异常路径、并发与资源、安全、测试充分性 | 无 BLOCKER/MAJOR + 无 NOT_FIXED/UNVERIFIABLE + 命令全 exit 0 | **必填** |
| `diagnose` 定位问题 | 排查 / 反证 / 取证 | 现象复现、假设可证伪、证据充分、其他可能、结论可操作 | 反证无 BLOCKER + 无 UNVERIFIABLE + 取证出现 `[CONFIRMED]` | 可选 |
| `analyze` 分析/评估 | 分析 / 质询 / 核对 | 问题覆盖、依据充分、反例考虑、结论边界、建议可执行 | 无 BLOCKER/MAJOR + 依据无 `MISSING`/`WRONG` | 可选 |
| `review` 评审实现 | 说明 / 评审 / 核对 | 范围明确、接口契约、异常路径、并发与资源、安全、可维护性 | 无 BLOCKER/MAJOR + 无 UNVERIFIABLE | 可选 |

共同前置：checklist 必须完整出现，缺项视为未评审，不会收敛。任何一条不满足就进入下一轮；到上限仍是 `needs_human`，未解决项写进 `DECISION.md`。

定位类任务靠标记判定而不是靠模型自述：

```
- [CONFIRMED] H1 src/data/loader.py:88 read() 无超时，hang 栈一致
- [REFUTED]   H2 src/train.py:140 barrier 配对完整
- [UNVERIFIABLE] H3 尚无栈采样
- 结论：[CONFIRMED] ...
```

只要还有 `UNVERIFIABLE` 或缺少 `[CONFIRMED]`，这轮就不算通过。

## 关闭会话

会话（opencode 上下文）与归档是两回事：**关闭只删 opencode 里的上下文，`requirements/<id>/` 不会动**。

点击「关闭会话」时按顺序执行：

1. 校验房间处于终态（`done` / `needs_human` / `stopped` / `error`），运行中拒绝
2. 用 `GET /session/:id/message` 把每个角色的原始会话导出到 `sessions/<role>.json`（含 tool 调用等原始内容，不只是文本）
3. `DELETE /session/:id` 删除三个会话
4. `room.json` 记 `closed: true`、`closedAt`、`closeErrors`，并在 `REPORT.md` 追加「会话关闭」段

关闭后该房间不能再 `start`（会 400），要接着做就新建任务或 `fork` 旧会话。

建议时机：`done` 后观察几天再关；`needs_human` 不要关，那是在等你决策；`error` 处理完再关。一个 session 只服务一个任务，不要复用。

## 角色分工依据

- Reviewer 用只读 agent（`tools.write/edit/bash=false`），从机制上避免它一边评审一边改代码。
- Architect 不跑测试，交给 Verifier，避免上下文被日志污染。
- Verifier 的结论必须带 `文件:行` 证据，否则编排器不接受。
- DeepSeek-V4-Pro 与 V4.1-Flash 同族，二者的一致意见不作为独立证据；GLM-5.3 才是异族信号。

## 测试

```bash
npm test     # 临时目录 + MOCK，校验端到端归档产物
```

## 目录

```
server.mjs           HTTP + 路由 + SSE + 鉴权
src/orchestrator.mjs 回合编排、验收命令、收敛判定
src/archive.mjs      归档目录与产物读写
src/oc.mjs           opencode 客户端
src/mock-oc.mjs      MOCK 适配器
src/prompts.mjs      每轮提示词与 checklist
public/              前端（零依赖）
workspace-template/  opencode agent 定义模板
requirements/        需求归档
```

## Discussion 连接器（AtomGit / GitCode）

本机定时轮询一个讨论（discussion），把讨论正文当任务开跑，并把协作过程实时贴回评论区；遇到 `[ASK]` 会在评论区提问并暂停，你回复后自动继续。

```bash
HUB_TOKEN=<atomgit token> \
HUB_REPO=tangjie66/agent-collab \
HUB_DISCUSSION=1 \
COLLAB_PASSWORD=<你的网页密码> \
npm run connector
```

| 变量 | 说明 |
| --- | --- |
| `HUB_BASE` | 默认 `https://atomgit.com`，GitCode 也可用 `https://gitcode.com` |
| `HUB_REPO` | `owner/repo` |
| `HUB_DISCUSSION` | 只监听指定编号；不填则扫全部（可配合 `HUB_OWNER` 只处理自己的） |
| `HUB_TOKEN` | AtomGit/GitCode personal access token（`private-token` 头） |
| `HUB_POLL_MS` | 轮询间隔，默认 20000 |
| `CONNECTOR_STATE` | 状态文件，默认 `~/.config/agent-collab/connector.json` |

先用 `npm run connector:dry` 干跑，只打印不会发评论。

实现要点：

- 机器人与你共用同一个账号，靠评论里的隐藏标记 `<!-- agent-collab -->` 区分，避免把自己的评论当成人输入
- 状态文件记录 `roomId / 已发消息数 / 最后处理的评论 id`，重启不重复刷屏
- 评论创建走 `POST /api/v5/repos/{owner}/{repo}/discuss/{n}/comment`，字段 `md_content`

## 关于 GitHub Pages

GitHub Pages 只能托管静态文件，无法运行本服务（需要子进程 + 本地仓库写入 + opencode）。所以常见做法是：

- 代码与归档放仓库（`requirements/` 直接 commit，形成可追溯的需求史）
- 服务在本地或自己的机器上跑，对外用 Cloudflare Tunnel / Tailscale 暴露 3000
- CI 用 GitHub Actions 跑 `npm test`（MOCK 模式，无需任何密钥）

## 已知限制

- 单人使用，单密码鉴权，无多租户。
- 轮次与命令超时兜底，但没有 token 预算硬限制。
- 同一房间内串行执行各角色，不同房间可并行（依赖 worktree 隔离）。
- 定位/分析类任务不改代码时，worktree 里可能是空的，属正常。
- 并行房间共用 CANNBOT 网关配额，同一账号并发放太多会互相拖慢。
- CANNBOT 的 JWT 过期后 `/provider` 只剩 `cannbot-error`，`/api/health` 会提示重新登录。

## 后台轮询（discussion 触发）

```bash
# 1. 配置（写进仓库根目录 .env，已被 .gitignore 忽略）
cat >> .env <<'EOF'
HUB_TOKEN=你的 atomgit token
HUB_REPO=tangjie66/agent-collab
COLLAB_PASSWORD=你的网页密码
EOF

# 2. 起本地服务（另一个进程）
npm start

# 3. 起轮询服务
./scripts/connectorctl start
./scripts/connectorctl status
./scripts/connectorctl logs
./scripts/connectorctl stop      # 会先停房间、等归档、再提交 gitcode
```

行为：

- 服务启动后，**新创建**的 discussion 会被扫描到并触发协作；启动前的旧讨论默认跳过（`HUB_INCLUDE_EXISTING=1` 可纳入）
- 每个 discussion 一个独立房间、独立 session（服务端还会给每个房间独立 worktree），日志与归档互不交叉
- 每条模型发言实时贴到对应讨论的评论区；遇到 `[ASK]` 会提问并暂停，你在评论区回复后自动续跑
- 讨论结束时把 `requirements/<roomId>/` 提交到 `origin`（GitCode）的 `main`，提交信息 `archive(#N): ...`
- `stop` 发送 SIGTERM：先对所有运行中的房间调 `/stop`，等 `REPORT.md` 落盘，再提交归档，最后退出；90 秒未收敛才强制结束

| 变量 | 说明 |
| --- | --- |
| `HUB_INCLUDE_EXISTING` | `1` 时启动即处理已有讨论 |
| `CONNECTOR_GIT` | `0` 关闭自动提交 |
| `CONNECTOR_REMOTE` / `CONNECTOR_BRANCH` | 默认 `origin` / `main` |
| `CONNECTOR_STATE` | 默认 `~/.config/agent-collab/connector.json` |
