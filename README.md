# Agent Collab

多模型 Agent 协作平台：给一个需求，由不同模型分别担任 **Architect（设计与实现）/ Reviewer（独立评审）/ Verifier（核验）**，按回合互相检视，直到评审、核验和验收命令全部通过；全过程落在 `requirements/<需求目录>/` 里归档。

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

## 收敛规则

一轮 = Architect 提案 → Reviewer 独立评审 → Verifier 逐条核验 → 编排器跑验收命令。

判定为 `done` 需要同时满足：

1. Reviewer 的 6 项 checklist 全部出现且无 `[BLOCKER]` / `[MAJOR]`（缺项视为未评审）
2. Verifier 无 `NOT_FIXED` / `UNVERIFIABLE`
3. 房间设置的验收命令全部 `exit 0`

任何一条不满足就进入下一轮；到上限仍是 `needs_human`，未解决项写进 `DECISION.md`。**没设验收命令的房间不会被判为 done。**

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

## 已知限制

- 单人使用，单密码鉴权，无多租户。
- 轮次与命令超时兜底，但没有 token 预算硬限制。
- 同一时刻同一房间只有一个 agent 在跑（共享工作区写冲突的规避方式）。
- CANNBOT 的 JWT 过期后 `/provider` 只剩 `cannbot-error`，`/api/health` 会提示重新登录。
