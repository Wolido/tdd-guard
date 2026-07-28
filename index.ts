import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTddGate, type SubagentCall } from "./src/gate";

// 与 subagent 工具实际 schema 对齐：单任务（agent/task）与批量（tasks/chain）均为可选
type SubagentInput = {
  agent?: string;
  task?: string;
  tasks?: SubagentCall[];
  chain?: SubagentCall[];
};

const INVALID_MODE_REASON =
  "已拦截：subagent 参数组合无效——必须恰好选择一种调用模式（single：agent + task；parallel：tasks 数组；chain：chain 数组），不可混合使用或全部缺失。";

// 结构化入参类型：仅依赖实际用到的 on 方法，便于测试注入轻量 fake
export default function (pi: Pick<ExtensionAPI, "on">) {
  const gate = createTddGate();
  // tool_execution_end 不携带 input，需在 tool_call 阶段记录 toolCallId → 是否含 tester 子任务
  const pendingCalls = new Map<string, boolean>();

  pi.on("session_start", async () => {
    gate.reset();
    pendingCalls.clear();
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType<"subagent", SubagentInput>("subagent", event)) return;
    const { agent, task, tasks, chain } = event.input;

    // 与 subagent 工具一致的入参校验：恰好一种模式，否则直接拦截（不消耗令牌、不注册 pending）
    const hasSingle = Boolean(agent && task);
    const hasTasks = (tasks?.length ?? 0) > 0;
    const hasChain = (chain?.length ?? 0) > 0;
    if (Number(hasSingle) + Number(hasTasks) + Number(hasChain) !== 1) {
      return { block: true, reason: INVALID_MODE_REASON };
    }

    const isBatch = !hasSingle;
    const decision = isBatch
      ? gate.onSubagentBatchStart({ tasks, chain })
      : gate.onSubagentStart({ agent, task });
    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }
    const subtasks: SubagentCall[] = isBatch ? [...(tasks ?? []), ...(chain ?? [])] : [{ agent, task }];
    pendingCalls.set(event.toolCallId, subtasks.some((s) => s.agent === "tester"));
  });

  pi.on("tool_execution_end", async (event) => {
    const hasTester = pendingCalls.get(event.toolCallId);
    if (hasTester === undefined) return;
    pendingCalls.delete(event.toolCallId);
    // 含 tester 子任务且整体成功完成 → 授予 RED 令牌（复用单任务语义）
    if (hasTester) gate.onSubagentEnd({ agent: "tester", isError: event.isError });
  });
}
