// Tool execution, shell commands, path filtering, and result compression
// Extracted from chatbot.ts for modularity

import { invoke } from "@tauri-apps/api/core";
import type { ToolCall } from "./chat-store";
import type { AgentAccess } from "./settings";

// ── Blocked paths ──

const BLOCKED_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__", ".next", ".nuxt", "coverage", ".cache"];
const BLOCKED_FILES = [
  ".env", ".env.local", ".env.production", ".env.development",
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  ".gitignore", ".DS_Store", "Thumbs.db",
];

export function isBlockedPath(filePath: string): boolean {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  if (parts.some((p) => BLOCKED_DIRS.includes(p))) return true;
  if (BLOCKED_FILES.includes(fileName)) return true;
  if (/\.(lock|lockb|log|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|mp[34]|zip|tar|gz)$/i.test(fileName)) return true;
  return false;
}

// ── Tool Result Compression ──

export function compressToolResult(toolName: string, result: string): string {
  const HARD_CAP = 1400;

  switch (toolName) {
    case "read_file":
    case "batch_read": {
      if (result.length <= HARD_CAP) return `[${toolName}] ${result}`;
      const lineCount = result.split("\n").length;
      const truncated = result.substring(0, 1100);
      const lastNewline = truncated.lastIndexOf("\n");
      const clean = lastNewline > 800 ? truncated.substring(0, lastNewline) : truncated;
      return `[${toolName}] ${clean}\n…[truncated: ${lineCount} total lines, ${result.length} chars]`;
    }

    case "search_content": {
      const lines = result.split("\n");
      if (lines.length <= 18) return `[${toolName}] ${result}`;
      return `[${toolName}] ${lines.slice(0, 18).join("\n")}\n…[${lines.length - 18} more matches omitted]`;
    }

    case "list_dir": {
      const entries = result.split("\n");
      if (entries.length <= 24) return `[${toolName}] ${result}`;
      return `[${toolName}] ${entries.slice(0, 24).join("\n")}\n…[${entries.length - 24} more entries omitted]`;
    }

    case "run_command": {
      if (result.length <= HARD_CAP) return `[${toolName}] ${result}`;
      const head = result.substring(0, 700);
      const tail = result.substring(Math.max(0, result.length - 450));
      return `[${toolName}] ${head}\n…[${result.length} chars total, showing head+tail]…\n${tail}`;
    }

    case "git_diff": {
      if (result.length <= HARD_CAP) return `[${toolName}] ${result}`;
      return `[${toolName}] ${result.substring(0, 1100)}\n…[diff truncated: ${result.length} chars total]`;
    }

    case "write_file":
      return `[${toolName}] ${result}`;

    case "make_plan":
      return `[${toolName}] ${result}`;

    case "search_files": {
      const paths = result.split("\n");
      if (paths.length <= 12) return `[${toolName}] ${result}`;
      return `[${toolName}] ${paths.slice(0, 12).join("\n")}\n…[${paths.length - 12} more files omitted]`;
    }

    default:
      if (result.length <= HARD_CAP) return `[${toolName}] ${result}`;
      return `[${toolName}] ${result.substring(0, HARD_CAP)}\n…[truncated]`;
  }
}

// ── Shell Command Execution ──

export interface ShellContext {
  activeCommandProcess: { pid: number; kill: () => Promise<void> } | null;
  activeCommandStopped: boolean;
  agentAborted: boolean;
  setActiveCommandProcess: (p: { pid: number; kill: () => Promise<void> } | null) => void;
  setActiveCommandStopped: (v: boolean) => void;
}

export async function runShellCommand(command: string, cwd: string, ctx: ShellContext): Promise<string> {
  try {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const cmd = Command.create("zsh", ["-l", "-c", command], { cwd });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    cmd.stdout.on("data", (data: string) => {
      stdoutChunks.push(data);
    });
    cmd.stderr.on("data", (data: string) => {
      stderrChunks.push(data);
    });

    return await new Promise<string>(async (resolve, reject) => {
      cmd.on("close", (payload: { code: number | null }) => {
        const stdout = stdoutChunks.join("").trim();
        const stderr = stderrChunks.join("").trim();
        const wasStopped = ctx.activeCommandStopped;

        ctx.setActiveCommandProcess(null);
        ctx.setActiveCommandStopped(false);

        if (wasStopped || ctx.agentAborted) {
          reject(new Error("Command stopped by user."));
          return;
        }

        if (payload.code !== 0 && payload.code !== null) {
          resolve(`Exit code ${payload.code}\n${stderr || stdout}`);
          return;
        }

        resolve(stdout || stderr || "(no output)");
      });

      cmd.on("error", (err: string) => {
        ctx.setActiveCommandProcess(null);
        const wasStopped = ctx.activeCommandStopped;
        ctx.setActiveCommandStopped(false);
        if (wasStopped || ctx.agentAborted) {
          reject(new Error("Command stopped by user."));
          return;
        }
        reject(new Error(err));
      });

      try {
        const child = await cmd.spawn();
        ctx.setActiveCommandStopped(false);
        ctx.setActiveCommandProcess(child);

        if (ctx.agentAborted) {
          ctx.setActiveCommandStopped(true);
          await invoke("kill_process_tree", { pid: child.pid }).catch(() => child.kill());
        }
      } catch (e: unknown) {
        ctx.setActiveCommandProcess(null);
        ctx.setActiveCommandStopped(false);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  } catch (e: unknown) {
    throw new Error(`Shell execution failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Tool Execution ──

export interface ToolExecContext extends ShellContext {
  getProjectPath: () => string;
  getAgentAccess: () => AgentAccess;
  onFileChanged: (path: string) => void;
  projectContext: string;
  setProjectContext: (ctx: string) => void;
}

export async function executeTool(tc: ToolCall, ctx: ToolExecContext): Promise<string> {
  const access = ctx.getAgentAccess();

  switch (tc.name) {
    case "read_file": {
      if (!access.fileRead) throw new Error("File read permission denied");
      if (isBlockedPath(tc.args.path)) throw new Error(`Blocked: reading "${tc.args.path}" is not allowed (heavy, sensitive, or binary file)`);
      const content = await invoke<string>("read_file", { path: tc.args.path });
      if (content.trim().length === 0) {
        return "(empty or whitespace-only file)";
      }
      const lines = content.split("\n");
      if (content.length > 15000) {
        return content.substring(0, 15000) + `\n\n… [truncated: ${lines.length} lines, ${content.length} chars total. Use search_content for targeted access.]`;
      }
      return content;
    }

    case "write_file": {
      if (!access.fileWrite) throw new Error("File write permission denied");
      await invoke("write_file", { path: tc.args.path, content: tc.args.content });
      ctx.onFileChanged(tc.args.path);
      if (tc.args.path.endsWith("/.athva/context.md")) {
        ctx.setProjectContext(tc.args.content);
      }
      return `File written: ${tc.args.path}`;
    }

    case "list_dir": {
      if (!access.fileRead) throw new Error("File read permission denied");
      const entries = await invoke<{ name: string; path: string; is_dir: boolean }[]>("read_dir", {
        path: tc.args.path,
      });
      const filtered = entries.filter((e) => {
        if (e.is_dir && BLOCKED_DIRS.includes(e.name)) return false;
        if (!e.is_dir && BLOCKED_FILES.includes(e.name)) return false;
        return true;
      });
      return filtered.map((e) => `${e.is_dir ? "[dir] " : "      "}${e.name}`).join("\n");
    }

    case "run_command": {
      if (!access.terminal) throw new Error("Terminal access permission denied");
      const projectPath = ctx.getProjectPath();
      const result = await runShellCommand(tc.args.command, projectPath, ctx);
      return result;
    }

    case "search_files": {
      if (!access.fileRead) throw new Error("File read permission denied");
      const projectPath = ctx.getProjectPath();
      const files = await invoke<{ name: string; path: string; is_dir: boolean }[]>("search_files", {
        root: projectPath,
        query: tc.args.query,
        maxResults: 50,
      });
      if (files.length === 0) return "No files found.";
      return files.map((f) => f.path).join("\n");
    }

    case "make_plan": {
      const title = (tc.args.title || "").trim();
      const notes = (tc.args.notes || "").trim();
      const rawSteps = tc.args.steps;
      const steps = (
        Array.isArray(rawSteps)
          ? rawSteps.map(String)
          : String(rawSteps || "").split("\n")
      ).map((s) => s.trim()).filter(Boolean);

      if (!title) throw new Error("Plan title is required");
      if (steps.length === 0) throw new Error("At least one plan step is required");

      const lines = [`Plan: ${title}`];
      for (let i = 0; i < steps.length; i++) {
        lines.push(`${i + 1}. ${steps[i]}`);
      }
      if (notes) {
        lines.push("");
        lines.push(`Notes: ${notes}`);
      }
      return lines.join("\n");
    }

    case "batch_read": {
      if (!access.fileRead) throw new Error("File read permission denied");
      const paths = String(tc.args.paths || "").split("\n").map((p: string) => p.trim()).filter(Boolean);
      if (paths.length === 0) throw new Error("No file paths provided");
      if (paths.length > 8) throw new Error("Max 8 files per batch_read (context limit)");

      const results: string[] = [];
      let totalSize = 0;
      const MAX_BATCH_SIZE = 15000;

      for (const filePath of paths) {
        if (isBlockedPath(filePath)) {
          results.push(`── ${filePath} ──\n[BLOCKED: heavy, sensitive, or binary file]`);
          continue;
        }
        try {
          let content = await invoke<string>("read_file", { path: filePath });
          if (content.trim().length === 0) {
            results.push(`── ${filePath} ──\n(empty file)`);
            continue;
          }
          if (totalSize + content.length > MAX_BATCH_SIZE) {
            const remaining = MAX_BATCH_SIZE - totalSize;
            if (remaining > 500) {
              content = content.substring(0, remaining) + "\n... (truncated — batch size limit reached)";
            } else {
              results.push(`── ${filePath} ──\n[SKIPPED: batch size limit reached]`);
              break;
            }
          }
          totalSize += content.length;
          results.push(`── ${filePath} ──\n${content}`);
        } catch (e: unknown) {
          results.push(`── ${filePath} ──\n[ERROR: ${e instanceof Error ? e.message : String(e)}]`);
        }
      }
      return results.join("\n\n");
    }

    case "search_content": {
      if (!access.fileRead) throw new Error("File read permission denied");
      const projectPath = ctx.getProjectPath();
      const pattern = String(tc.args.pattern || "").trim();
      if (!pattern) throw new Error("Search pattern is required");
      const glob = String(tc.args.glob || "*").replace(/[;|&$`]/g, "");
      const safePattern = pattern.replace(/'/g, "'\\''");
      const cmd = `cd "${projectPath}" && grep -rn --include='${glob}' -E '${safePattern}' . 2>/dev/null | head -50`;
      const result = await runShellCommand(cmd, projectPath, ctx);
      if (!result.trim()) return "No matches found.";
      return result;
    }

    case "git_diff": {
      if (!access.fileRead) throw new Error("File read permission denied");
      const projectPath = ctx.getProjectPath();
      const target = String(tc.args.target || "").trim().replace(/[;|&$`]/g, "");
      const cmd = target
        ? `cd "${projectPath}" && git diff '${target.replace(/'/g, "'\\''")}' 2>/dev/null | head -200`
        : `cd "${projectPath}" && git diff 2>/dev/null | head -200`;
      const result = await runShellCommand(cmd, projectPath, ctx);
      if (!result.trim()) return "No changes detected.";
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${tc.name}`);
  }
}
