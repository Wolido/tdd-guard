export type GateDecision = { action: "allow" } | { action: "block"; reason: string };

export interface SubagentCall {
  agent?: string;
  task?: string;
}

export interface SubagentEnd {
  agent: string;
  isError: boolean;
}

export interface SubagentBatch {
  tasks?: SubagentCall[];
  chain?: SubagentCall[];
}

const SKIP_TAG = "[skip-tdd]";

const BLOCK_REASON = [
  "已拦截：当前调用 coder 子代理违反 TDD 流程——本轮尚无 tester 成功完成（RED 阶段缺失）。",
  "请先派遣 tester 子代理编写失败测试（RED），待其成功完成后再调用 coder 实现功能。",
  "如确需跳过 TDD，请在 task 中加入 [skip-tdd] 标记并写明理由。",
].join("\n");

export function createTddGate() {
  // tester 成功完成一次 → 获得一枚 RED 令牌；放行含 coder 的调用时消耗一枚
  let redTokenAvailable = false;

  const hasSkipTag = (task?: string) => task?.includes(SKIP_TAG) ?? false;

  // 一批子任务中只要存在不带跳过标记的 coder，就需要消耗一枚令牌，否则拦截
  function judge(calls: SubagentCall[]): GateDecision {
    const needsToken = calls.some((c) => c.agent === "coder" && !hasSkipTag(c.task));
    if (!needsToken) return { action: "allow" };
    if (redTokenAvailable) {
      redTokenAvailable = false; // 一次性消耗
      return { action: "allow" };
    }
    return { action: "block", reason: BLOCK_REASON };
  }

  return {
    onSubagentStart: (call: SubagentCall): GateDecision => judge([call]),

    onSubagentBatchStart: (batch: SubagentBatch): GateDecision =>
      judge([...(batch.tasks ?? []), ...(batch.chain ?? [])]),

    onSubagentEnd(end: SubagentEnd): void {
      if (end.agent === "tester" && !end.isError) {
        redTokenAvailable = true;
      }
    },

    reset(): void {
      redTokenAvailable = false;
    },
  };
}
