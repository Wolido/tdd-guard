import { describe, it, expect, beforeEach } from "vitest";
import {
  createTddGate,
  type GateDecision,
  type SubagentBatch,
} from "../src/gate";

function assertBlocked(decision: GateDecision, expectedSubstrings: string[]) {
  expect(decision.action).toBe("block");
  if (decision.action !== "block") {
    throw new Error("Expected decision.action to be 'block' but got 'allow'");
  }
  const reason = decision.reason.toLowerCase();
  for (const substr of expectedSubstrings) {
    expect(reason).toContain(substr.toLowerCase());
  }
}

function assertAllowed(decision: GateDecision) {
  expect(decision.action).toBe("allow");
}

describe("TDD Gate pure logic", () => {
  let gate: ReturnType<typeof createTddGate>;

  beforeEach(() => {
    gate = createTddGate();
  });

  // 规约 1：初始状态拦截 coder
  it("should block coder subagent call when no tester has completed since startup", () => {
    // Arrange
    const call = { agent: "coder", task: "implement login" };

    // Act
    const decision = gate.onSubagentStart(call);

    // Assert
    assertBlocked(decision, [
      "TDD",
      "tester",
      "RED",
      "[skip-tdd]",
    ]);
  });

  // 规约 2：tester 成功后放行 coder
  it("should allow coder subagent call after a successful tester call completes", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });

    // Act
    const decision = gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Assert
    assertAllowed(decision);
  });

  // 规约 3：一次性消耗
  it("should block the next coder call after a previous coder call was allowed", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Act
    const decision = gate.onSubagentStart({ agent: "coder", task: "implement logout" });

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });

  // 规约 4：跳过标记
  it("should allow coder subagent call when task contains [skip-tdd] regardless of state", () => {
    // Arrange: no tester has run

    // Act
    const decision = gate.onSubagentStart({
      agent: "coder",
      task: "[skip-tdd] hotfix production bug",
    });

    // Assert
    assertAllowed(decision);
  });

  it("should allow coder subagent call with [skip-tdd] even after red token was consumed", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Act
    const decision = gate.onSubagentStart({
      agent: "coder",
      task: "[skip-tdd] emergency patch",
    });

    // Assert
    assertAllowed(decision);
  });

  // 规约 5：不干扰其他 agent
  it.each(["tester", "reviewer", "writer", "executor", "planner"])(
    "should always allow %s subagent call",
    (agent) => {
      // Arrange
      const call = { agent, task: "do something" };

      // Act
      const decision = gate.onSubagentStart(call);

      // Assert
      assertAllowed(decision);
    }
  );

  it("should still allow tester call even when red token is consumed", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Act
    const decision = gate.onSubagentStart({
      agent: "tester",
      task: "write tests for logout",
    });

    // Assert
    assertAllowed(decision);
  });

  // 规约 6：tester 失败不算完成
  it("should block coder subagent call after tester call ends with error", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: true });

    // Act
    const decision = gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });

  it("should allow coder only after tester succeeds following a failed tester attempt", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "first attempt" });
    gate.onSubagentEnd({ agent: "tester", isError: true });
    gate.onSubagentStart({ agent: "tester", task: "second attempt" });
    gate.onSubagentEnd({ agent: "tester", isError: false });

    // Act
    const decision = gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Assert
    assertAllowed(decision);
  });

  // Critical fix 1：undefined task 不崩溃，按正常规则判定
  it("should block coder call when task is undefined and no red token is available", () => {
    // Arrange
    const call = { agent: "coder", task: undefined };

    // Act
    const decision = gate.onSubagentStart(call);

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });

  it("should block coder call when task is undefined because no skip tag is present", () => {
    // Arrange: no tester has run

    // Act
    const decision = gate.onSubagentStart({
      agent: "coder",
      task: undefined,
    });

    // Assert: undefined task means no skip tag, so it should still be blocked
    assertBlocked(decision, ["TDD", "tester"]);
  });

  // Critical fix 2 前置：退化输入 agent 缺失
  it("should allow subagent call when agent is undefined because gate only guards coder", () => {
    // Arrange
    const call = { agent: undefined, task: "do something" };

    // Act
    const decision = gate.onSubagentStart(call);

    // Assert
    assertAllowed(decision);
  });

  // Critical fix 2：批量 tasks 模式
  it("should block batch tasks call containing a coder subtask without red token", () => {
    // Arrange
    const batch: SubagentBatch = {
      tasks: [
        { agent: "planner", task: "plan feature" },
        { agent: "coder", task: "implement feature" },
      ],
    };

    // Act
    const decision = gate.onSubagentBatchStart(batch);

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });

  it("should allow batch tasks call containing a coder subtask when red token is available", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    const batch: SubagentBatch = {
      tasks: [
        { agent: "reviewer", task: "review code" },
        { agent: "coder", task: "implement feature" },
      ],
    };

    // Act
    const decision = gate.onSubagentBatchStart(batch);

    // Assert
    assertAllowed(decision);
  });

  it("should allow batch tasks call when coder subtask contains [skip-tdd] even without red token", () => {
    // Arrange: no tester has run
    const batch: SubagentBatch = {
      tasks: [
        { agent: "coder", task: "[skip-tdd] emergency fix" },
      ],
    };

    // Act
    const decision = gate.onSubagentBatchStart(batch);

    // Assert
    assertAllowed(decision);
  });

  it("should allow batch tasks call when all subtasks are non-coder agents", () => {
    // Arrange: no tester has run
    const batch: SubagentBatch = {
      tasks: [
        { agent: "tester", task: "write tests" },
        { agent: "reviewer", task: "review" },
      ],
    };

    // Act
    const decision = gate.onSubagentBatchStart(batch);

    // Assert
    assertAllowed(decision);
  });

  it("should consume one red token for an allowed batch tasks call", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    const batch: SubagentBatch = {
      tasks: [{ agent: "coder", task: "implement feature" }],
    };

    // Act
    gate.onSubagentBatchStart(batch);
    const nextDecision = gate.onSubagentStart({
      agent: "coder",
      task: "another change",
    });

    // Assert
    assertBlocked(nextDecision, ["TDD", "tester"]);
  });

  // Critical fix 2：链式 chain 模式
  it("should block batch chain call containing a coder subtask without red token", () => {
    // Arrange
    const batch: SubagentBatch = {
      chain: [
        { agent: "planner", task: "plan feature" },
        { agent: "coder", task: "implement feature" },
      ],
    };

    // Act
    const decision = gate.onSubagentBatchStart(batch);

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });

  // 规约 7：状态可重置
  it("should block coder subagent call after reset even if red token was previously available", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    gate.reset();

    // Act
    const decision = gate.onSubagentStart({ agent: "coder", task: "implement login" });

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });

  it("should block coder subagent call after reset even after coder was allowed", () => {
    // Arrange
    gate.onSubagentStart({ agent: "tester", task: "write failing tests" });
    gate.onSubagentEnd({ agent: "tester", isError: false });
    gate.onSubagentStart({ agent: "coder", task: "implement login" });
    gate.reset();

    // Act
    const decision = gate.onSubagentStart({ agent: "coder", task: "implement logout" });

    // Assert
    assertBlocked(decision, ["TDD", "tester"]);
  });
});
