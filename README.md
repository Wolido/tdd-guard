# tdd-guard

> 一个 pi 扩展，强制主 agent 遵守 TDD 流程——软性提醒靠不住。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi ≥ 0.82.1](https://img.shields.io/badge/pi-%E2%89%A50.82.1-blue)]()

## 问题背景

pi 的主 agent 通过子 agent（`coder`、`tester`、`reviewer` 等）分工协作。理论上应该遵循 TDD：先派 `tester` 写一个失败测试，*然后*派 `coder` 让测试通过。实际使用中，主 agent 经常跳过 tester 直接调用 coder。口头叮嘱（"请遵守 TDD"）不可靠——LLM 会在自认为已经知道答案时直接忽略这些指令。

**tdd-guard** 把规则变成硬约束。它在扩展层面拦截子 agent 调用，在当前轮次中 `tester` 成功完成之前，物理上阻止 `coder` 被派遣。

## 配套项目

tdd-guard 设计为与 [subagent-isolation](https://github.com/Wolido/subagent-isolation) 配套使用。subagent-isolation 是一个 pi 扩展，通过 `subagent` 工具提供子 agent 系统（`tester`、`coder`、`reviewer` 等）。tdd-guard 在其上叠加了一层纪律约束：拦截 `subagent` 工具调用，强制执行 TDD 闸门。

- **[subagent-isolation](https://github.com/Wolido/subagent-isolation)** — 子 agent 运行时。先安装它，获得 `subagent` 工具。
- **tdd-guard** — 闸门。配套安装，防止主 agent 跳过 RED 阶段。

两者搭配使用效果最佳，但 tdd-guard 是基于工具名称工作的：任何暴露同名 `subagent` 工具且输入 schema 一致（`agent` / `task` / `tasks` / `chain`）的扩展都会被闸门约束。

## 工作原理

tdd-guard 维护一枚 **RED 令牌**，作为一次性通行凭证。

```
                  ┌─────────────┐
                  │   无令牌     │  ← 初始状态 / 重置后
                  └──────┬──────┘
                         │
            tester 成功完成
                         │
                  ┌──────▼──────┐
                  │  RED 令牌   │
                  │    可用     │
                  └──────┬──────┘
                         │
              派遣 coder（令牌消耗）
                         │
                  ┌──────▼──────┐
                  │   无令牌     │
                  └─────────────┘
```

- **令牌授予**：`tester` 子 agent 无错误完成时。
- **令牌消耗**：下一次 `coder` 被派遣时（一次性使用）。
- **令牌拒绝**：`tester` 以错误退出时不授予——只有成功才算。
- **令牌重置**：每次 `session_start`（`/new`、`/resume`、`/fork`、reload）时。

只有 `coder` 调用受闸门控制。其他 agent（`tester`、`reviewer`、`writer`、`planner`……）自由通行。

## 安装

### 自动发现（推荐）

克隆到全局扩展目录，pi 会自动加载：

```bash
git clone https://github.com/Wolido/tdd-guard.git ~/.pi/agent/extensions/tdd-guard
cd ~/.pi/agent/extensions/tdd-guard
npm install
```

无需额外参数。作为子目录扩展（`index.ts` 入口）工作。

### 显式路径

```bash
git clone https://github.com/Wolido/tdd-guard.git /some/path/tdd-guard
cd /some/path/tdd-guard
npm install
pi -e /some/path/tdd-guard
```

适用于开发或按项目单独配置的场景。

### ⚠️ `--no-extensions`

`--no-extensions` 标志会禁用*所有*扩展，包括 tdd-guard。如果你依靠它来维持 TDD 纪律，就不要同时使用这两个标志。（亲身教训：花了 20 分钟排查闸门为什么不工作，最后发现是这个标志没关。）

## 使用行为

### 默认：coder 被闸门控制

每次 `coder` 调用都会检查当前令牌状态。如果没有可用令牌，调用被**拦截**，LLM 会收到一段中文提示，要求它先派遣 `tester`。

### 跳过闸门

在 `task` 字段的任意位置加入 `[skip-tdd]`，该次调用即可绕过闸门：

```
task: "[skip-tdd] hotfix: revert broken config"
```

谨慎使用。扩展信任你（以及 agent）会附上跳过理由。

### 批量模式

tdd-guard 处理全部三种子 agent 派遣模式：

| 模式 | 语法 | 检查规则 |
|------|------|----------|
| **单任务** | `agent: "coder"` + `task: "…"` | agent 为 `coder` 时闸门生效 |
| **并行** | `tasks: [{agent, task}, …]` | 任意条目为 `coder` 且无 `[skip-tdd]` 时闸门生效 |
| **链式** | `chain: [{agent, task}, …]` | 与并行规则相同 |

一枚令牌覆盖整批调用——如果批次中包含受控的 `coder`，令牌消耗一次，整批放行。

### 无效参数组合

模式混用（例如同时提供 `agent`/`task` *和* `tasks`）或全部缺失，会在到达闸门之前被拦截。LLM 会收到一条单独的错误信息，说明必须恰好选择一种模式。

### LLM 看到什么

被拦截时，LLM 会收到如下信息：

> 已拦截：当前调用 coder 子代理违反 TDD 流程——本轮尚无 tester 成功完成（RED 阶段缺失）。
> 请先派遣 tester 子代理编写失败测试（RED），待其成功完成后再调用 coder 实现功能。
> 如确需跳过 TDD，请在 task 中加入 [skip-tdd] 标记并写明理由。

### 通知方式

tdd-guard 仅使用非阻塞通知。没有弹窗，没有确认对话框——不会打断你的工作流。拦截或放行时你会看到一行简短的状态提示。

## 开发

```bash
git clone https://github.com/Wolido/tdd-guard.git
cd tdd-guard
npm install
npm test
```

### 项目结构

```
tdd-guard/
├── index.ts            # 薄接线层——挂接 pi 的事件系统
├── src/
│   └── gate.ts         # 纯逻辑——RED 令牌状态机，零依赖
├── test/
│   └── gate.test.ts    # ~20 条规格，覆盖全部状态、模式和边界情况
├── package.json
└── tsconfig.json
```

- **`gate.ts`** — `createTddGate()` 返回一个纯对象，暴露 `onSubagentStart`、`onSubagentBatchStart`、`onSubagentEnd` 和 `reset` 四个方法。无副作用，除了 TypeScript 类型外无任何导入。可完全隔离测试。
- **`index.ts`** — 订阅 `tool_call`、`tool_execution_end` 和 `session_start` 事件。校验子 agent 输入格式，将闸门判定结果接入 pi 的拦截机制，并维护 pending-call 映射表以关联 `tool_call` ID 与其 `tool_execution_end` 结果。

## 许可证

MIT © [Wolido](https://github.com/Wolido) <270262953@qq.com>
