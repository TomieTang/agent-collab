# 设计说明

## 目标

让同一需求由不同模型分工完成：一个写方案与代码，一个独立评审，一个核验证据与测试，全过程本地归档、可追溯、可回放。单人使用，网页操作，手机可访问。

## 关键取舍

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| Agent 运行时 | `opencode serve` | 文件读写、bash、权限、多模型、会话持久化已有，不自研 tool loop |
| 会话模型 | 一个 server + 每角色一个 session | 上下文天然隔离，同时共享同一工作区 |
| 消息传递 | 文件黑板 + JSONL 事件 | agent 本来就会读文件；避免把长历史塞进 prompt |
| 存储 | JSON 文件（无数据库） | 单人规模，归档即数据，便于 git 提交 |
| 前端 | 原生 JS + SSE | 零依赖，单文件可读，手机上够用 |
| 归档位置 | 平台仓库 `requirements/` | 需求过程与代码仓库分离，归档可随平台仓一起备份 |

## 数据流

```
POST /api/rooms
  → 为每个角色 createSession
  → 建 requirements/<id>/，写 board.md、room.json

POST /api/rooms/:id/start
  → runRoom()
      for round in 1..maxRounds:
        architect.ask(proposalPrompt)  → round-N/proposal-architect.md
        reviewer.ask(reviewPrompt)     → round-N/review-reviewer.md
        verifier.ask(verifyPrompt)     → round-N/verify-verifier.md
        runDoneWhen()                  → round-N/commands.log
        judge()                        → 继续 / done / needs_human
      writeDecision() + writeReport()
  → emit(done) → SSE → 前端
```

## 协议要点

1. **只传路径不传全文**：每轮 prompt 只给需求、轮次、要读的文件路径，模型自己读。上下文短且不会随轮次膨胀。
2. **强制输出格式**：评审必须输出 6 项 checklist 与 `[BLOCKER|MAJOR|MINOR] ID 文件:行 | 问题 | 建议`，编排器据此判定，不依赖模型自述。
3. **证据优先**：Verifier 每条结论必须带文件行号或命令输出，否则记 `UNVERIFIABLE`，阻塞收敛。
4. **只读评审**：Reviewer 的 opencode agent 关闭 write/edit/bash，避免评审变成改代码。
5. **验收命令由编排器执行**：不信任 agent 报告的命令结果，编排器自己跑一遍，退出码说了算。
6. **同族不互证**：DeepSeek-Pro 与 DeepSeek-Flash 判为相关证据，收敛只认异族（GLM）+ 命令结果。

## 状态机

```
created ──start──▶ running ──┬──▶ done            评审+核验+命令全通过
                             ├──▶ needs_human     轮次用尽 / checklist 缺项 / 命令未过
                             ├──▶ paused ──start──▶ running
                             ├──▶ stopped         人工停止
                             └──▶ error           调用失败
服务重启时 running → interrupted（不自动续跑，避免半轮状态污染）
```

## 安全边界

- 服务默认绑定 `127.0.0.1`，对外只经 Cloudflare Tunnel；opencode 端口不暴露。
- opencode 侧再套一层 Basic Auth（`OPENCODE_SERVER_PASSWORD`）。
- 登录：单密码 + HMAC 签名 Cookie（HttpOnly / SameSite=Lax），失败 5 次锁 30 秒。
- agent 的破坏性命令在 `workspace-template/opencode.json` 里限定白名单；工作区应是专用仓库。
- 归档目录做了路径逃逸检查，`/api/rooms/:id/file` 只能读房间目录内文件。

## 已知不足

- 没有 token 预算硬限制，只有轮次和命令超时。
- 人插话与自动轮次可能并发写同一 session，UI 上用 `Human→role` 标记区分。
- 归档里的 `board.md` 依赖 agent 自觉更新，MOCK 模式不会写。
- 轮次内不做 `session/summarize`，超长需求可能触及上下文上限。
