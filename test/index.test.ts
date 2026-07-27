import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  isToolCallEventType: vi.fn(
    (expectedName: string, event: { toolName: string }) =>
      event.toolName === expectedName
  ),
}));

import extensionFactory from "../index";

type EventHandler = (event: any, ctx: any) => any | Promise<any>;

function createFakePi() {
  const handlers: Record<string, EventHandler> = {};
  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers[event] = handler;
    }),
    handlers,
  };
}

function createFakeCtx() {
  return {
    ui: {
      notify: vi.fn(),
    },
  };
}

function makeToolCallEvent(input: Record<string, unknown>, toolCallId = "tc-1") {
  return {
    toolName: "subagent",
    toolCallId,
    input,
  };
}

function makeToolEndEvent(isError: boolean, toolCallId = "tc-1") {
  return {
    toolName: "subagent",
    toolCallId,
    isError,
  };
}

describe("TDD Guard wiring integration", () => {
  let pi: ReturnType<typeof createFakePi>;
  let ctx: ReturnType<typeof createFakeCtx>;

  beforeEach(() => {
    pi = createFakePi();
    ctx = createFakeCtx();
    extensionFactory(pi);
  });

  it("should block single coder call without red token and not pollute pending calls", async () => {
    // Arrange
    const event = makeToolCallEvent({ agent: "coder", task: "implement login" });

    // Act
    const result = await pi.handlers.tool_call(event, ctx);

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("TDD"),
    });

    // A subsequent end event for the same blocked call must not grant a token
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-1"), ctx);
    const second = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "second attempt" }, "tc-2"),
      ctx
    );
    expect(second).toEqual({
      block: true,
      reason: expect.stringContaining("TDD"),
    });
  });

  it("should allow tester call, grant token on success, then allow coder", async () => {
    // Arrange
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );

    // Act
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-tester"), ctx);
    const result = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "implement login" }, "tc-coder"),
      ctx
    );

    // Assert
    expect(result).toBeUndefined();
  });

  it("should not grant red token when tester call ends with error", async () => {
    // Arrange
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );

    // Act
    await pi.handlers.tool_execution_end(makeToolEndEvent(true, "tc-tester"), ctx);
    const result = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "implement login" }, "tc-coder"),
      ctx
    );

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("TDD"),
    });
  });

  it("should reset gate and pending calls on session_start", async () => {
    // Arrange: start a tester call but never end it
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );

    // Act: new session
    await pi.handlers.session_start({ reason: "new" }, ctx);

    // End the old tester call — it should no longer grant a token
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-tester"), ctx);

    // Assert
    const result = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "implement login" }, "tc-coder"),
      ctx
    );
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("TDD"),
    });
  });

  it("should not intercept non-subagent tool calls", async () => {
    // Arrange
    const event = { toolName: "bash", toolCallId: "tc-bash", input: { command: "ls" } };

    // Act
    const result = await pi.handlers.tool_call(event, ctx);

    // Assert
    expect(result).toBeUndefined();
  });

  // 技术债 1：无效参数组合必须 modeCount === 1
  it("should block mixed single and batch mode and not consume red token", async () => {
    // Arrange: earn a red token first
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-tester"), ctx);

    // Act: mixed mode — single agent/task plus parallel tasks
    const result = await pi.handlers.tool_call(
      makeToolCallEvent(
        {
          agent: "coder",
          task: "implement login",
          tasks: [{ agent: "reviewer", task: "review" }],
        },
        "tc-mixed"
      ),
      ctx
    );

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/invalid|mode|参数|组合/i),
    });

    // Token must not be consumed: a subsequent single coder call should still be allowed
    const after = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "single coder" }, "tc-after"),
      ctx
    );
    expect(after).toBeUndefined();
  });

  it("should block single plus chain mixed mode and not consume red token", async () => {
    // Arrange: earn a red token first
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-tester"), ctx);

    // Act: single agent/task plus chain
    const result = await pi.handlers.tool_call(
      makeToolCallEvent(
        {
          agent: "coder",
          task: "implement login",
          chain: [{ agent: "reviewer", task: "review" }],
        },
        "tc-mixed-chain"
      ),
      ctx
    );

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/invalid|mode|参数|组合/i),
    });

    const after = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "single coder" }, "tc-after"),
      ctx
    );
    expect(after).toBeUndefined();
  });

  it("should block both tasks and chain present and not consume red token", async () => {
    // Arrange: earn a red token first
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-tester"), ctx);

    // Act: both batch modes at once
    const result = await pi.handlers.tool_call(
      makeToolCallEvent(
        {
          tasks: [{ agent: "reviewer", task: "review" }],
          chain: [{ agent: "coder", task: "implement" }],
        },
        "tc-double"
      ),
      ctx
    );

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/invalid|mode|参数|组合/i),
    });

    // Token must remain available
    const after = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "single coder" }, "tc-after"),
      ctx
    );
    expect(after).toBeUndefined();
  });

  it("should allow valid batch tasks call and consume one red token", async () => {
    // Arrange: earn a red token
    await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "tester", task: "write failing tests" }, "tc-tester"),
      ctx
    );
    await pi.handlers.tool_execution_end(makeToolEndEvent(false, "tc-tester"), ctx);

    // Act: valid parallel batch with coder
    await pi.handlers.tool_call(
      makeToolCallEvent(
        {
          tasks: [
            { agent: "reviewer", task: "review" },
            { agent: "coder", task: "implement" },
          ],
        },
        "tc-batch"
      ),
      ctx
    );

    // Assert: token consumed
    const next = await pi.handlers.tool_call(
      makeToolCallEvent({ agent: "coder", task: "another" }, "tc-next"),
      ctx
    );
    expect(next).toEqual({
      block: true,
      reason: expect.stringContaining("TDD"),
    });
  });

  it("should block subagent call with no valid mode (modeCount = 0)", async () => {
    // Arrange
    const event = makeToolCallEvent({ agent: "coder" }, "tc-no-mode");

    // Act
    const result = await pi.handlers.tool_call(event, ctx);

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringMatching(/invalid|mode|参数|组合/i),
    });
  });

  it("should block valid batch tasks call containing coder when no red token", async () => {
    // Arrange: no token
    const event = makeToolCallEvent(
      {
        tasks: [{ agent: "coder", task: "implement" }],
      },
      "tc-batch"
    );

    // Act
    const result = await pi.handlers.tool_call(event, ctx);

    // Assert
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("TDD"),
    });
  });
});
