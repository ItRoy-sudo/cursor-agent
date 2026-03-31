import { describe, it, expect } from "vitest";
import { formatRunResult, extractModifiedFiles } from "./formatter.js";
import type { RunResult, CollectedEvent } from "./types.js";

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    success: true,
    resultText: "Analysis completed",
    durationMs: 5000,
    toolCallCount: 3,
    events: [],
    ...overrides,
  };
}

describe("formatRunResult", () => {
  it("success result contains ✅ marker", () => {
    const messages = formatRunResult(makeResult());
    const combined = messages.join("\n");
    expect(combined).toContain("✅");
    expect(combined).toContain("Completed");
  });

  it("failure result contains ❌ marker", () => {
    const messages = formatRunResult(makeResult({ success: false, error: "timeout" }));
    const combined = messages.join("\n");
    expect(combined).toContain("❌");
    expect(combined).toContain("Failed");
    expect(combined).toContain("timeout");
  });

  it("includes duration and tool call count", () => {
    const messages = formatRunResult(makeResult({ durationMs: 12345, toolCallCount: 7 }));
    const combined = messages.join("\n");
    expect(combined).toContain("12.3s");
    expect(combined).toContain("7 tool calls");
  });

  it("includes token usage", () => {
    const messages = formatRunResult(makeResult({
      usage: { inputTokens: 1000, outputTokens: 500 },
    }));
    const combined = messages.join("\n");
    expect(combined).toContain("1000in");
    expect(combined).toContain("500out");
  });

  it("includes session ID", () => {
    const messages = formatRunResult(makeResult({ sessionId: "sess-abc-123" }));
    const combined = messages.join("\n");
    expect(combined).toContain("sess-abc-123");
  });

  it("includes project label in footer when set", () => {
    const messages = formatRunResult(makeResult({ projectLabel: "my-web-app" }));
    const combined = messages.join("\n");
    expect(combined).toContain("📁");
    expect(combined).toContain("my-web-app");
  });

  it("omits project segment when projectLabel is empty", () => {
    const messages = formatRunResult(makeResult({ projectLabel: "" }));
    const combined = messages.join("\n");
    expect(combined).not.toContain("📁");
  });

  it("shows resume command when both projectLabel and sessionId exist", () => {
    const messages = formatRunResult(makeResult({
      projectLabel: "flp-webportal",
      sessionId: "86a7dffc-b80f-44b0-bab8-28833b2f4aad",
    }));
    const combined = messages.join("\n");
    expect(combined).toContain("👉");
    expect(combined).toContain("继续会话");
    expect(combined).toContain("/cursor flp-webportal --resume 86a7dffc-b80f-44b0-bab8-28833b2f4aad");
  });

  it("omits resume command when projectLabel is missing", () => {
    const messages = formatRunResult(makeResult({
      projectLabel: "",
      sessionId: "sess-123",
    }));
    const combined = messages.join("\n");
    expect(combined).not.toContain("👉");
    expect(combined).not.toContain("继续会话");
  });

  it("omits resume command when sessionId is missing", () => {
    const messages = formatRunResult(makeResult({
      projectLabel: "my-project",
      sessionId: undefined,
    }));
    const combined = messages.join("\n");
    expect(combined).not.toContain("👉");
    expect(combined).not.toContain("继续会话");
  });

  it("shows tool call summary", () => {
    const events: CollectedEvent[] = [
      { type: "tool_start", toolName: "read", toolArgs: "main.ts", timestamp: 1 },
      { type: "tool_end", toolName: "read", toolResult: "...", timestamp: 2 },
      { type: "tool_start", toolName: "edit", toolArgs: "main.ts", timestamp: 3 },
      { type: "tool_end", toolName: "edit", toolResult: "ok", timestamp: 4 },
    ];
    const messages = formatRunResult(makeResult({ events }));
    const combined = messages.join("\n");
    expect(combined).toContain("read");
    expect(combined).toContain("edit");
    expect(combined).toContain("main.ts");
  });

  it("shows last assistant message as conclusion", () => {
    const events: CollectedEvent[] = [
      { type: "assistant", text: "First step analysis", timestamp: 1 },
      { type: "assistant", text: "Final conclusion is as follows", timestamp: 2 },
    ];
    const messages = formatRunResult(makeResult({ events }));
    const combined = messages.join("\n");
    expect(combined).toContain("Final conclusion is as follows");
  });

  it("has default output with no events", () => {
    const messages = formatRunResult(makeResult({ events: [] }));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]!.length).toBeGreaterThan(0);
  });

  it("splits long content into multiple messages automatically", () => {
    const longText = "This is a long line of text for testing.\n".repeat(500);
    const events: CollectedEvent[] = [
      { type: "assistant", text: longText, timestamp: 1 },
    ];
    const messages = formatRunResult(makeResult({ events }));
    expect(messages.length).toBeGreaterThan(1);
    for (const msg of messages) {
      expect(msg.length).toBeLessThanOrEqual(4000);
    }
  });

  it("matches tool icons correctly", () => {
    const events: CollectedEvent[] = [
      { type: "tool_start", toolName: "readFile", toolArgs: "a.ts", timestamp: 1 },
      { type: "tool_start", toolName: "editFile", toolArgs: "b.ts", timestamp: 2 },
      { type: "tool_start", toolName: "shellCommand", toolArgs: "ls", timestamp: 3 },
      { type: "tool_start", toolName: "searchText", toolArgs: "foo", timestamp: 4 },
      { type: "tool_start", toolName: "deleteFile", toolArgs: "c.ts", timestamp: 5 },
      { type: "tool_start", toolName: "listDir", toolArgs: "src", timestamp: 6 },
      { type: "tool_start", toolName: "customTool", toolArgs: "", timestamp: 7 },
    ];
    const messages = formatRunResult(makeResult({ events }));
    const combined = messages.join("\n");
    expect(combined).toContain("📖");
    expect(combined).toContain("📝");
    expect(combined).toContain("⚙️");
    expect(combined).toContain("🔍");
    expect(combined).toContain("🗑️");
    expect(combined).toContain("📋");
    expect(combined).toContain("🔧");
  });
});

describe("extractModifiedFiles", () => {
  it("extracts file names from write operations", () => {
    const events: CollectedEvent[] = [
      { type: "tool_start", toolName: "editFile", toolArgs: "main.ts", timestamp: 1 },
      { type: "tool_start", toolName: "writeFile", toolArgs: "config.ts", timestamp: 2 },
      { type: "tool_start", toolName: "replaceInFile", toolArgs: "utils.ts", timestamp: 3 },
      { type: "tool_start", toolName: "deleteFile", toolArgs: "old.ts", timestamp: 4 },
    ];
    const files = extractModifiedFiles(events);
    expect(files).toContain("main.ts");
    expect(files).toContain("config.ts");
    expect(files).toContain("utils.ts");
    expect(files).toContain("old.ts");
  });

  it("deduplicates", () => {
    const events: CollectedEvent[] = [
      { type: "tool_start", toolName: "editFile", toolArgs: "main.ts", timestamp: 1 },
      { type: "tool_start", toolName: "editFile", toolArgs: "main.ts", timestamp: 2 },
    ];
    const files = extractModifiedFiles(events);
    expect(files).toEqual(["main.ts"]);
  });

  it("ignores read operations", () => {
    const events: CollectedEvent[] = [
      { type: "tool_start", toolName: "readFile", toolArgs: "main.ts", timestamp: 1 },
      { type: "tool_start", toolName: "searchText", toolArgs: "query", timestamp: 2 },
      { type: "tool_start", toolName: "viewFile", toolArgs: "file.ts", timestamp: 3 },
    ];
    const files = extractModifiedFiles(events);
    expect(files).toEqual([]);
  });

  it("ignores write operations without toolArgs", () => {
    const events: CollectedEvent[] = [
      { type: "tool_start", toolName: "editFile", toolArgs: "", timestamp: 1 },
      { type: "tool_start", toolName: "editFile", timestamp: 2 },
    ];
    const files = extractModifiedFiles(events);
    expect(files).toEqual([]);
  });

  it("ignores tool_end events", () => {
    const events: CollectedEvent[] = [
      { type: "tool_end", toolName: "editFile", toolResult: "done", timestamp: 1 },
    ];
    const files = extractModifiedFiles(events);
    expect(files).toEqual([]);
  });

  it("returns empty array for empty events", () => {
    expect(extractModifiedFiles([])).toEqual([]);
  });
});
