# tdd-guard

> A pi extension that enforces TDD discipline on the main agent — soft reminders won't cut it.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi ≥ 0.82.1](https://img.shields.io/badge/pi-%E2%89%A50.82.1-blue)]()

## The Problem

pi's main agent delegates work to sub-agents (`coder`, `tester`, `reviewer`, etc.). In theory, it should follow TDD: dispatch `tester` to write a failing test, *then* dispatch `coder` to make it pass. In practice, the agent often skips straight to `coder`. Soft instructions ("please follow TDD") are unreliable because the LLM can — and will — ignore them when it thinks it already knows the answer.

**tdd-guard** makes the rule mechanical. It intercepts sub-agent calls at the extension level and physically blocks `coder` until `tester` has completed successfully in the current turn.

## Companion Project

tdd-guard is designed to work with [subagent-isolation](https://github.com/Wolido/subagent-isolation), a pi extension that provides the sub-agent system — `tester`, `coder`, `reviewer`, and others — via a `subagent` tool. tdd-guard layers discipline on top: it intercepts `subagent` tool calls and enforces the TDD gate.

- **[subagent-isolation](https://github.com/Wolido/subagent-isolation)** — the sub-agent runtime. Install it first to get the `subagent` tool.
- **tdd-guard** — the gate. Install it alongside to prevent the main agent from skipping the RED phase.

The two work best together, but tdd-guard is tool-name-based: any extension that exposes a `subagent` tool with the same input schema (`agent` / `task` / `tasks` / `chain`) will be gated.

## How It Works

tdd-guard maintains a single **RED token** that acts as a one-shot gate pass.

```
                  ┌─────────────┐
                  │  NO TOKEN   │  ← initial state / after reset
                  └──────┬──────┘
                         │
            tester completes successfully
                         │
                  ┌──────▼──────┐
                  │ RED TOKEN   │
                  │  AVAILABLE  │
                  └──────┬──────┘
                         │
              coder dispatched (token consumed)
                         │
                  ┌──────▼──────┐
                  │  NO TOKEN   │
                  └─────────────┘
```

- **Token granted** when a `tester` sub-agent finishes without error.
- **Token consumed** the next time `coder` is dispatched (single-use).
- **Token denied** if `tester` exits with an error — only success counts.
- **Token reset** on every `session_start` (`/new`, `/resume`, `/fork`, reload).

Only `coder` calls are gated. Other agents (`tester`, `reviewer`, `writer`, `planner`, …) pass through freely.

## Installation

### Auto-discovery (recommended)

Clone into the global extensions directory and pi picks it up automatically:

```bash
git clone https://github.com/Wolido/tdd-guard.git ~/.pi/agent/extensions/tdd-guard
cd ~/.pi/agent/extensions/tdd-guard
npm install
```

No extra flags needed. Works as a subdirectory extension (`index.ts` entry point).

### Explicit path

```bash
git clone https://github.com/Wolido/tdd-guard.git /some/path/tdd-guard
cd /some/path/tdd-guard
npm install
pi -e /some/path/tdd-guard
```

Useful for development or per-project setups.

### ⚠️ `--no-extensions`

The `--no-extensions` flag disables *all* extensions, including tdd-guard. If you rely on it for discipline, don't combine the two. (Personal lesson: spent 20 minutes wondering why the gate stopped working before remembering this flag was on.)

## Usage / Behavior

### Default: coder is gated

Every `coder` call is checked against the current token state. If no token is available, the call is **blocked** and the LLM receives a reason message (in Chinese) instructing it to dispatch `tester` first.

### Skipping the gate

Add `[skip-tdd]` anywhere in the `task` field and the gate is bypassed for that call:

```
task: "[skip-tdd] hotfix: revert broken config"
```

Use sparingly. The extension trusts you (and the agent) to include a reason.

### Batch modes

tdd-guard handles all three sub-agent dispatch modes:

| Mode | Syntax | Check |
|------|--------|-------|
| **Single** | `agent: "coder"` + `task: "…"` | Gated if agent is `coder` |
| **Parallel** | `tasks: [{agent, task}, …]` | Gated if *any* entry is `coder` without `[skip-tdd]` |
| **Chain** | `chain: [{agent, task}, …]` | Same rule as parallel |

One token covers the entire batch — if the batch has a gated `coder`, the token is consumed once and the whole batch is allowed.

### Invalid parameter combinations

Mixing modes (e.g. providing both `agent`/`task` *and* `tasks`) or providing none at all is blocked before reaching the gate. The LLM gets a separate error explaining it must pick exactly one mode.

### What the LLM sees

When blocked, the LLM receives a message like:

> 已拦截：当前调用 coder 子代理违反 TDD 流程——本轮尚无 tester 成功完成（RED 阶段缺失）。
> 请先派遣 tester 子代理编写失败测试（RED），待其成功完成后再调用 coder 实现功能。
> 如确需跳过 TDD，请在 task 中加入 [skip-tdd] 标记并写明理由。

### Notifications

tdd-guard uses non-blocking notifications only. No popups, no confirm dialogs — it won't interrupt your flow. You'll see a brief status line when calls are blocked or allowed.

## Development

```bash
git clone https://github.com/Wolido/tdd-guard.git
cd tdd-guard
npm install
npm test
```

### Project structure

```
tdd-guard/
├── index.ts            # Thin wiring layer — hooks into pi's event system
├── src/
│   └── gate.ts         # Pure logic — RED token state machine, zero dependencies
├── test/
│   └── gate.test.ts    # ~20 specs covering all states, modes, and edge cases
├── package.json
└── tsconfig.json
```

- **`gate.ts`** — `createTddGate()` returns a plain object with `onSubagentStart`, `onSubagentBatchStart`, `onSubagentEnd`, and `reset`. No side effects, no imports beyond TypeScript types. Testable in complete isolation.
- **`index.ts`** — Subscribes to `tool_call`, `tool_execution_end`, and `session_start`. Validates sub-agent input shapes, wires gate decisions back to pi's block mechanism, and manages the pending-call map that correlates `tool_call` IDs with their `tool_execution_end` results.

## License

MIT © [Wolido](https://github.com/Wolido) <270262953@qq.com>
