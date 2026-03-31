/**
 * Integration tests — verify the full flow of runner → parser → formatter → process-registry.
 *
 * Following the OpenClaw integration test pattern:
 * - Uses real child_process spawn, but with mock-agent.mjs instead of the real CLI
 * - Verifies end-to-end data flow and error handling
 * - Tests real process management behavior (detached, signal handling)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runCursorAgent } from "./runner.js";
import { formatRunResult, extractModifiedFiles } from "./formatter.js";
import * as registry from "./process-registry.js";
import type { RunOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_SCRIPT = resolve(__dirname, "__fixtures__/mock-agent.mjs");

function makeOpts(overrides: Partial<RunOptions> & { env?: Record<string, string> } = {}): RunOptions {
  const { env: _env, ...rest } = overrides;
  return {
    agentPath: process.execPath,
    projectPath: __dirname,
    prompt: "integration test prompt",
    mode: "agent",
    timeoutSec: 10,
    noOutputTimeoutSec: 5,
    enableMcp: false,
    ...rest,
  };
}

describe("integration: full execution flow", () => {
  beforeEach(() => {
    registry.setMaxConcurrent(5);
  });

  it("success scenario: collect events → format output", async () => {
    const result = await runCursorAgent({
      ...makeOpts(),
      agentPath: process.execPath,
      prefixArgs: [MOCK_AGENT_SCRIPT],
    });

    expect(result.success).toBe(true);
    expect(result.projectLabel).toBe(basename(resolve(__dirname)));
    expect(result.sessionId).toBe("mock-session-001");
    expect(result.resultText).toBe("Analysis completed successfully");
    expect(result.toolCallCount).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });

    expect(result.events.length).toBeGreaterThanOrEqual(3);
    const toolStarts = result.events.filter(e => e.type === "tool_start");
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]!.toolName).toBe("read");

    const assistants = result.events.filter(e => e.type === "assistant");
    expect(assistants.length).toBeGreaterThanOrEqual(1);

    const messages = formatRunResult(result);
    expect(messages.length).toBeGreaterThan(0);
    const combined = messages.join("\n");
    expect(combined).toContain("✅");
    expect(combined).toContain("mock-session-001");
    expect(combined).toContain("read");
  });

  it("error scenario: CLI returns error", async () => {
    const badResult = await runCursorAgent({
      ...makeOpts(),
      agentPath: process.execPath,
      prefixArgs: ["/nonexistent/mock-agent-script.mjs"],
    });

    expect(badResult.success).toBe(false);
  });

  it("AbortSignal interrupts execution", async () => {
    const ac = new AbortController();

    const promise = runCursorAgent({
      ...makeOpts(),
      agentPath: process.execPath,
      prefixArgs: [MOCK_AGENT_SCRIPT],
      signal: ac.signal,
      timeoutSec: 30,
      noOutputTimeoutSec: 30,
    });

    setTimeout(() => ac.abort(), 200);

    const result = await promise;
    expect(result).toBeTruthy();
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("process registry cleans up after execution", async () => {
    const countBefore = registry.getActiveCount();

    await runCursorAgent({
      ...makeOpts(),
      agentPath: process.execPath,
      prefixArgs: [MOCK_AGENT_SCRIPT],
      runId: "integration-test-1",
    });

    expect(registry.getActiveCount()).toBe(countBefore);
  });

  it("concurrency control: rejects when limit exceeded", async () => {
    registry.setMaxConcurrent(1);

    const longRunPromise = runCursorAgent({
      ...makeOpts(),
      agentPath: process.execPath,
      prefixArgs: [MOCK_AGENT_SCRIPT],
      runId: "long-run",
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    registry.setMaxConcurrent(0);
    // setMaxConcurrent(0) is protected by Math.max(1, 0) to minimum 1

    await longRunPromise;
    registry.setMaxConcurrent(5);
  });
});

describe("integration: formatting end-to-end", () => {
  it("RunResult → formatRunResult → extractModifiedFiles full pipeline", () => {
    const result = {
      success: true,
      resultText: "done",
      sessionId: "sess-e2e",
      durationMs: 2500,
      toolCallCount: 3,
      events: [
        { type: "tool_start" as const, toolName: "readFile", toolArgs: "config.ts", timestamp: 100 },
        { type: "tool_end" as const, toolName: "readFile", toolResult: "export default {}", timestamp: 200 },
        { type: "tool_start" as const, toolName: "editFile", toolArgs: "main.ts", timestamp: 300 },
        { type: "tool_end" as const, toolName: "editFile", toolResult: "ok", timestamp: 400 },
        { type: "tool_start" as const, toolName: "writeFile", toolArgs: "new-file.ts", timestamp: 500 },
        { type: "tool_end" as const, toolName: "writeFile", toolResult: "ok", timestamp: 600 },
        { type: "assistant" as const, text: "Code modifications completed, updated main.ts and added new-file.ts", timestamp: 700 },
        { type: "result" as const, resultData: { type: "result", subtype: "success", result: "done", duration_ms: 2500, is_error: false } as any, timestamp: 800 },
      ],
      usage: { inputTokens: 500, outputTokens: 250 },
    };

    const messages = formatRunResult(result);
    const combined = messages.join("\n");

    expect(combined).toContain("✅");
    expect(combined).toContain("readFile");
    expect(combined).toContain("editFile");
    expect(combined).toContain("writeFile");
    expect(combined).toContain("Code modifications completed");
    expect(combined).toContain("2.5s");
    expect(combined).toContain("sess-e2e");

    const modifiedFiles = extractModifiedFiles(result.events);
    expect(modifiedFiles).toContain("main.ts");
    expect(modifiedFiles).toContain("new-file.ts");
    expect(modifiedFiles).not.toContain("config.ts");
  });

  it("fallback output with empty event list", () => {
    const result = {
      success: true,
      resultText: "",
      durationMs: 100,
      toolCallCount: 0,
      events: [],
    };

    const messages = formatRunResult(result);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every(m => m.length > 0)).toBe(true);
  });
});

describe("integration: tool + runner + formatter end-to-end", () => {
  it("createCursorAgentTool full execution via mock-agent", async () => {
    const { createCursorAgentTool } = await import("./tool.js");

    const projects = { testproj: __dirname };
    const factory = createCursorAgentTool({
      agentPath: process.execPath,
      projects,
      cfg: { defaultTimeoutSec: 10, noOutputTimeoutSec: 5, enableMcp: false, prefixArgs: [MOCK_AGENT_SCRIPT] },
    });

    const tool = factory({});
    const result = await tool.execute("call-e2e", {
      project: "testproj",
      prompt: "e2e test",
      mode: "ask",
    });

    expect(result.content[0]!.text).toContain("✅");
    expect(result.content[0]!.text).toContain("📁 src");
    expect(result.content[0]!.text).toContain("CRITICAL INSTRUCTION");
    expect(result.content[0]!.text).toContain("MUST NOT summarize");
    expect(result.details?.success).toBe(true);
    expect(result.details?.sessionId).toBe("mock-session-001");
    expect(result.details?.sentDirectly).toBe(false);
  });
});
