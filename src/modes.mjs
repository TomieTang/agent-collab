export const MODES = {
  build: {
    id: 'build',
    label: '开发/实现',
    hint: '要实现或改造什么，例如：给配置模块增加校验，非法输入返回 EINVAL',
    requireCommands: true,
    roles: { architect: 'Builder', reviewer: 'Reviewer', verifier: 'Verifier' },
    checklist: ['需求覆盖', '接口契约', '异常路径', '并发与资源', '安全', '测试充分性'],
    proposalSpec: `方案必须包含：目标拆解、改动文件清单、关键决策与理由、风险。
需要改的代码直接改在仓库里，改动保持最小。
对上一轮每条 issue 给出 FIXED（附文件:行）或 REJECTED（附理由），写在方案末尾的「## 回应」段。`,
    reviewSpec: `评审制定方案与代码改动，判断是否真的满足任务、是否有遗漏与风险。
每条 issue 必须定位到文件:行；不能定位就把原因写进对应 checklist 项的 FAIL 里。`,
    verifySpec: `逐条判断 review 中的 issue 是否真的修复，并运行验收命令记录退出码。`,
    doneMarker: null,
    converge({ review, verify, coverage, commandsOk, doneWhen }) {
      if (!doneWhen.length) return { ok: false, reason: '开发类任务必须设置验收命令' }
      if (!coverage.complete) return { ok: false, reason: `评审 checklist 缺项：${coverage.missing.join('/')}` }
      if (/\[(BLOCKER|MAJOR)\]/i.test(review)) return { ok: false, reason: '仍有 BLOCKER/MAJOR' }
      if (/NOT_FIXED|UNVERIFIABLE/i.test(verify)) return { ok: false, reason: '仍有未修复或无法核验的 issue' }
      if (!commandsOk) return { ok: false, reason: '验收命令未通过' }
      return { ok: true, reason: '评审通过 + 核验通过 + 验收命令通过' }
    },
  },

  diagnose: {
    id: 'diagnose',
    label: '定位问题',
    hint: '贴现象、报错、复现步骤或日志位置，例如：训练脚本偶发 hang，日志在 logs/train.log，找出根因',
    requireCommands: false,
    roles: { architect: '排查', reviewer: '反证', verifier: '取证' },
    checklist: ['现象复现', '假设可证伪', '证据充分', '其他可能', '结论可操作'],
    proposalSpec: `按假设驱动的方式工作，方案必须包含：
## 现象
- 可观察到的表现、影响范围、触发条件
## 复现
- 尽量给出最小复现步骤或命令；不能复现要说明卡在哪
## 假设
- H1 假设内容 | 判据：满足什么现象/证据就成立 | 当前状态：待验证/已排除（证据）
- H2 ...
## 根因
- 已有证据指向的位置（文件:行 或 日志行），不确定就写"待定"
## 修复建议
- 可执行的下一步，不改代码也可以给方案`,
    reviewSpec: `你是反证方：目标是推翻排查者的结论，而不是帮他确认。
重点检查：现象是否真的复现、每个假设是否可证伪、证据链是否有跳跃、是否漏掉其他可能路径、结论能否指导修复。`,
    verifySpec: `为每条假设取证，并在最终给结论。
每条必须有明确标记：
- [CONFIRMED] H1 证据（文件:行 或 日志片段）说明
- [REFUTED] H2 证据 说明
- [UNVERIFIABLE] H3 原因
最终必须有一行 \`结论：[CONFIRMED] 根因说明\`，否则视为未收敛。
不要用"可能""大概"这类词替代证据。`,
    doneMarker: /\[CONFIRMED\]/i,
    converge({ review, verify, coverage, commandsOk }) {
      if (!coverage.complete) return { ok: false, reason: `反证 checklist 缺项：${coverage.missing.join('/')}` }
      if (/\[(BLOCKER|MAJOR)\]/i.test(review)) return { ok: false, reason: '仍有未排除的 BLOCKER/MAJOR' }
      if (/UNVERIFIABLE/i.test(verify)) return { ok: false, reason: '存在无法取证的假设' }
      if (!/\[CONFIRMED\]/i.test(verify)) return { ok: false, reason: '根因尚未确认（缺少 [CONFIRMED]）' }
      if (!commandsOk) return { ok: false, reason: '验收命令未通过' }
      return { ok: true, reason: '根因已确认且反证通过' }
    },
  },

  analyze: {
    id: 'analyze',
    label: '分析/评估',
    hint: '要分析对比什么，例如：比较两种存储方案的读写放大与改造成本，给出选型建议',
    requireCommands: false,
    roles: { architect: '分析', reviewer: '质询', verifier: '核对' },
    checklist: ['问题覆盖', '依据充分', '反例考虑', '结论边界', '建议可执行'],
    proposalSpec: `分析必须包含：
## 问题拆解
- 把大问题拆成可分别回答的子问题
## 结论
- 每个子问题给出明确结论与依据（文件:行、数据、文档出处）
## 不确定与反例
- 明确写出哪些结论证据不足、什么情况下结论会反转
## 建议
- 可执行建议，带代价与前提`,
    reviewSpec: `你是质询方：找出分析里的逻辑跳跃、证据不足、漏掉的反例和被忽略的约束。
不要求代码正确性，只要求论证站得住。`,
    verifySpec: `逐条核对分析中的每个依据是否真实存在、是否被正确引用：
- [EVIDENCE] 依据 出处 是否成立
- [MISSING] 依据 缺少出处
- [WRONG] 依据 与源码/数据不符
没有出处的依据一律记 [MISSING]。`,
    doneMarker: null,
    converge({ review, verify, coverage, commandsOk }) {
      if (!coverage.complete) return { ok: false, reason: `质询 checklist 缺项：${coverage.missing.join('/')}` }
      if (/\[(BLOCKER|MAJOR)\]/i.test(review)) return { ok: false, reason: '仍有 BLOCKER/MAJOR' }
      if (/MISSING|WRONG|UNVERIFIABLE/i.test(verify)) return { ok: false, reason: '存在缺失或错误的依据' }
      if (!commandsOk) return { ok: false, reason: '验收命令未通过' }
      return { ok: true, reason: '论证与依据核对通过' }
    },
  },

  review: {
    id: 'review',
    label: '评审现有实现',
    hint: '指定要评审的模块或提交范围，例如：评审 src/scheduler 的并发模型与错误处理',
    requireCommands: false,
    roles: { architect: '说明', reviewer: '评审', verifier: '核对' },
    checklist: ['范围明确', '接口契约', '异常路径', '并发与资源', '安全', '可维护性'],
    proposalSpec: `先界定评审范围，再给出被评审对象的事实说明：
## 范围
- 涉及的模块/文件/提交
## 现状
- 关键流程、接口、错误处理的事实描述（文件:行）
## 已识别的薄弱点
- 带文件:行
不要修改代码。`,
    reviewSpec: `在「说明」的基础上做独立评审，重点是指出它没提或刻意淡化的问题。
每条必须是可操作的 issue，带文件:行。`,
    verifySpec: `核验每条评审 issue 是否成立：
- [CONFIRMED] RV-1 文件:行 说明
- [REFUTED] RV-2 文件:行 说明
- [UNVERIFIABLE] RV-3 原因
没有源码支撑的结论一律 UNVERIFIABLE。`,
    doneMarker: null,
    converge({ review, verify, coverage, commandsOk }) {
      if (!coverage.complete) return { ok: false, reason: `评审 checklist 缺项：${coverage.missing.join('/')}` }
      if (/\[(BLOCKER|MAJOR)\]/i.test(review)) return { ok: false, reason: '仍有 BLOCKER/MAJOR' }
      if (/UNVERIFIABLE/i.test(verify)) return { ok: false, reason: '存在无法核验的结论' }
      if (!commandsOk) return { ok: false, reason: '验收命令未通过' }
      return { ok: true, reason: '评审与核验通过' }
    },
  },
}

export function modeOf(room) {
  return MODES[room.mode] || MODES.build
}

export function modeList() {
  return Object.values(MODES).map((m) => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    requireCommands: m.requireCommands,
    roles: m.roles,
    checklist: m.checklist,
  }))
}
