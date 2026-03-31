import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { runCursorAgent } from "./runner.js";
import { formatRunResult } from "./formatter.js";
import { ensureShutdownHook, setMaxConcurrent } from "./process-registry.js";
import { createCursorAgentTool } from "./tool.js";
import { resolveAgentBinary } from "./resolve-binary.js";
import type { CursorAgentConfig, ParsedCommand, ResolvedBinary } from "./types.js";

const PLUGIN_ID = "cursor-agent";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_NO_OUTPUT_TIMEOUT_SEC = 120;
const DEFAULT_ENABLE_MCP = true;
const DEFAULT_MODE = "agent" as const;
const CONTEXT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Session context cache for /cc command */
interface SessionContext {
  project: string;
  sessionId: string;
  timestamp: number;
}
const sessionContext = new Map<string, SessionContext>();

/** Get context key from channel and sender */
function getContextKey(channelId: string, senderId: string): string {
  return `${channelId}:${senderId}`;
}

/** Cleanup expired session contexts */
function cleanupExpiredContext(): void {
  const now = Date.now();
  for (const [key, value] of sessionContext) {
    if (now - value.timestamp > CONTEXT_EXPIRY_MS) {
      sessionContext.delete(key);
    }
  }
}

/** Save session context for /cc command */
function saveSessionContext(channelId: string, senderId: string, project: string, sessionId: string): void {
  const key = getContextKey(channelId, senderId);
  sessionContext.set(key, { project, sessionId, timestamp: Date.now() });
}

/** Get session context for /cc command */
function getSessionContext(channelId: string, senderId: string): SessionContext | undefined {
  cleanupExpiredContext();
  const key = getContextKey(channelId, senderId);
  return sessionContext.get(key);
}

/** Auto-detect agent command path */
function detectAgentPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where agent" : "which agent";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
    const first = result.split(/\r?\n/)[0]?.trim();
    if (first && existsSync(first)) return first;
  } catch { /* ignore */ }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return null;

  if (process.platform === "win32") {
    const candidates = [
      resolve(home, "AppData/Local/cursor-agent/agent.cmd"),
      resolve(home, ".cursor/bin/agent.cmd"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else {
    const candidates = [
      resolve(home, ".cursor/bin/agent"),
      resolve(home, ".local/bin/agent"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * Parse /cursor command arguments.
 *
 * Format:
 *   /cursor <project> <prompt>
 *   /cursor <project> --continue <prompt>
 *   /cursor <project> --resume <chatId> <prompt>
 *   /cursor <project> --mode ask|plan|agent <prompt>
 *   /cursor <project> --model <model> <prompt>
 */
export function parseCommandArgs(args: string): ParsedCommand | { error: string } {
  if (!args?.trim()) {
    return { error: "Usage: /cursor <project> <prompt>\n\nOptions:\n  --continue          Continue previous session\n  --resume <chatId>   Resume a specific session\n  --mode <mode>       Set mode (agent|ask|plan)\n  --model <model>     Specify model (e.g. claude-4-sonnet)" };
  }

  const tokens = tokenize(args.trim());
  if (tokens.length === 0) {
    return { error: "Missing project parameter" };
  }

  const project = tokens[0]!;
  let mode: "agent" | "ask" | "plan" = DEFAULT_MODE;
  let model: string | undefined;
  let continueSession = false;
  let resumeSessionId: string | undefined;
  const promptParts: string[] = [];

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--continue") {
      continueSession = true;
      i++;
    } else if (token === "--resume") {
      i++;
      if (i >= tokens.length) return { error: "--resume requires a chatId" };
      resumeSessionId = tokens[i]!;
      i++;
    } else if (token === "--mode") {
      i++;
      if (i >= tokens.length) return { error: "--mode requires a mode (agent|ask|plan)" };
      const m = tokens[i]! as "agent" | "ask" | "plan";
      if (!["agent", "ask", "plan"].includes(m)) {
        return { error: `Unsupported mode: ${m}, available: agent, ask, plan` };
      }
      mode = m;
      i++;
    } else if (token === "--model") {
      i++;
      if (i >= tokens.length) return { error: "--model requires a model name" };
      model = tokens[i]!;
      i++;
    } else {
      promptParts.push(tokens.slice(i).join(" "));
      break;
    }
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    return { error: "Missing prompt parameter" };
  }

  return { project, prompt, mode, model, continueSession, resumeSessionId };
}

/** Simple tokenizer that preserves spaces within quotes */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export default {
  id: PLUGIN_ID,
  configSchema: { type: "object" as const },

  register(api: any) {
    const cfg: CursorAgentConfig = api.pluginConfig ?? {};
    console.log(`[${PLUGIN_ID}] pluginConfig:`, JSON.stringify(cfg));

    const agentPath = cfg.agentPath || detectAgentPath();
    if (!agentPath) {
      console.warn(`[${PLUGIN_ID}] Cursor Agent CLI not found, plugin disabled`);
      return;
    }

    // 解析底层 node + index.js，优先使用配置，其次自动解析
    let resolvedBinary: ResolvedBinary | undefined;
    if (cfg.agentNodeBin && cfg.agentEntryScript) {
      if (existsSync(cfg.agentNodeBin) && existsSync(cfg.agentEntryScript)) {
        resolvedBinary = { nodeBin: cfg.agentNodeBin, entryScript: cfg.agentEntryScript };
        console.log(`[${PLUGIN_ID}] using configured binary: ${cfg.agentNodeBin}`);
      } else {
        console.warn(`[${PLUGIN_ID}] configured agentNodeBin/agentEntryScript not found, falling back to auto-resolve`);
      }
    }
    if (!resolvedBinary) {
      resolvedBinary = resolveAgentBinary(agentPath) ?? undefined;
      if (resolvedBinary) {
        console.log(`[${PLUGIN_ID}] resolved binary: ${resolvedBinary.nodeBin} ${resolvedBinary.entryScript}`);
      } else {
        console.log(`[${PLUGIN_ID}] binary resolve failed, will invoke agentPath directly: ${agentPath}`);
      }
    }

    if (cfg.maxConcurrent) setMaxConcurrent(cfg.maxConcurrent);
    ensureShutdownHook();

    const projects = cfg.projects ?? {};
    const projectNames = Object.keys(projects);
    const projectListStr = projectNames.length > 0
      ? `Available projects: ${projectNames.join(", ")}`
      : "No pre-configured projects, provide a full path";

    // ── Path 1: /cursor command (explicit invocation, bypasses PI Agent) ──
    api.registerCommand({
      name: "cursor",
      description: `Invoke Cursor Agent for code analysis and modification. ${projectListStr}`,
      acceptsArgs: true,
      requireAuth: false,

      async handler(ctx: any) {
        const parsed = parseCommandArgs(ctx.args ?? "");

        if ("error" in parsed) {
          return { text: parsed.error };
        }

        const projectPath = resolveProjectPath(parsed.project, projects);
        if (!projectPath) {
          return {
            text: `Project not found: ${parsed.project}\n${projectListStr}`,
          };
        }

        const result = await runCursorAgent({
          agentPath,
          resolvedBinary,
          projectPath,
          prompt: parsed.prompt,
          mode: parsed.mode,
          timeoutSec: cfg.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC,
          noOutputTimeoutSec: cfg.noOutputTimeoutSec ?? DEFAULT_NO_OUTPUT_TIMEOUT_SEC,
          enableMcp: cfg.enableMcp ?? DEFAULT_ENABLE_MCP,
          model: parsed.model ?? cfg.model,
          prefixArgs: cfg.prefixArgs,
          continueSession: parsed.continueSession,
          resumeSessionId: parsed.resumeSessionId,
        });

        // Save session context for /cc command
        // 保存原始输入的 project 名称（可能是别名或绝对路径），而不是解析后的目录名
        if (result.sessionId) {
          const channelId = ctx.channelId ?? "default";
          const senderId = ctx.senderId ?? "unknown";
          saveSessionContext(channelId, senderId, parsed.project, result.sessionId);
        }

        const messages = formatRunResult(result);
        const combined = messages.join("\n\n---\n\n");
        return { text: combined };
      },
    });

    // ── Path 1.5: /cc command (continue context, shorthand for /cursor with resume) ──
    api.registerCommand({
      name: "cc",
      description: `Continue the previous Cursor Agent session (shorthand). Usage: /cc <your prompt>`,
      acceptsArgs: true,
      requireAuth: false,

      async handler(ctx: any) {
        const prompt = ctx.args?.trim();
        if (!prompt) {
          return {
            text: "❌ 缺少提示内容\n\n**用法：** `/cc <你的问题>`\n\n继续上一次的 Cursor Agent 会话，自动带上 project 和 sessionId。"
          };
        }

        const channelId = ctx.channelId ?? "default";
        const senderId = ctx.senderId ?? "unknown";
        const context = getSessionContext(channelId, senderId);

        if (!context) {
          return {
            text: "❌ 没有找到上一次的会话上下文。\n\n请先使用 `/cursor <project> <问题>` 开始一个新会话，之后才能使用 `/cc` 继续。"
          };
        }

        // Build full command with context
        const fullArgs = `${context.project} --resume ${context.sessionId} ${prompt}`;
        const parsed = parseCommandArgs(fullArgs);

        if ("error" in parsed) {
          return { text: parsed.error };
        }

        const projectPath = resolveProjectPath(parsed.project, projects);
        if (!projectPath) {
          return {
            text: `❌ Project not found: ${parsed.project}\n${projectListStr}\n\n**提示：** 之前保存的会话使用的是 \`${context.project}\`，但当前配置中找不到该项目。\n可能是项目配置已更改，或者之前使用的是绝对路径但该路径已不可用。\n请重新使用 \`/cursor <project> <prompt>\` 开始新的会话。`,
          };
        }

        const result = await runCursorAgent({
          agentPath,
          resolvedBinary,
          projectPath,
          prompt: parsed.prompt,
          mode: parsed.mode,
          timeoutSec: cfg.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC,
          noOutputTimeoutSec: cfg.noOutputTimeoutSec ?? DEFAULT_NO_OUTPUT_TIMEOUT_SEC,
          enableMcp: cfg.enableMcp ?? DEFAULT_ENABLE_MCP,
          model: parsed.model ?? cfg.model,
          prefixArgs: cfg.prefixArgs,
          resumeSessionId: parsed.resumeSessionId,
        });

        // Update session context with new sessionId (使用原始 project 名称)
        if (result.sessionId) {
          saveSessionContext(channelId, senderId, parsed.project, result.sessionId);
        }

        const messages = formatRunResult(result);
        const combined = messages.join("\n\n---\n\n");
        return { text: combined };
      },
    });

    // ── Path 2: Agent Tool (PI Agent fallback invocation) ──
    if (cfg.enableAgentTool !== false && projectNames.length > 0) {
      api.registerTool(
        createCursorAgentTool({ agentPath, resolvedBinary, projects, cfg }),
        { name: "cursor_agent", optional: true },
      );
      console.log(`[${PLUGIN_ID}] registered cursor_agent tool`);
    }

    console.log(`[${PLUGIN_ID}] registered /cursor command (agent: ${agentPath}, projects: ${projectNames.join(", ") || "none"})`);
  },
};

/** Resolve project path from mapping table or absolute path */
export function resolveProjectPath(
  projectKey: string,
  projects: Record<string, string>,
): string | null {
  // Exact match
  if (projects[projectKey]) return projects[projectKey]!;

  // Case-insensitive match
  const lowerKey = projectKey.toLowerCase();
  for (const [name, path] of Object.entries(projects)) {
    if (name.toLowerCase() === lowerKey) return path;
  }

  // Treat as absolute path
  if (existsSync(projectKey)) return projectKey;

  return null;
}
