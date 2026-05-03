// Tool execution, shell commands, path filtering, and result compression
// Extracted from chatbot.ts for modularity

import { invoke } from "@tauri-apps/api/core";
import type { ToolCall } from "./chat-store";
import type { AgentAccess } from "./settings";
import type { ExecutorAction, ExecutorResult } from "./chat-workflow";
import { PROJECT_ROOT_TOKEN } from "./chat-workflow";

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

function isProtectedDeletePath(filePath: string): boolean {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  if (parts.includes(".git")) return true;
  if (/^\.env(\..+)?$/i.test(fileName)) return true;
  if (["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].includes(fileName)) return true;
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
    case "delete_path":
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
  activeCommandToolId?: string | null;
  agentAborted: boolean;
  setActiveCommandProcess: (p: { pid: number; kill: () => Promise<void> } | null) => void;
  setActiveCommandStopped: (v: boolean) => void;
  setActiveCommandToolId?: (toolId: string | null) => void;
}

const SHELL_COMMAND_TIMEOUT_MS = 15000;

function hasTemplatePlaceholders(args: Record<string, string>): boolean {
  return Object.values(args).some((value) => /\{\{[^}]+\}\}/.test(String(value || "")));
}

function normalizeLooseArgValue(value: string): string {
  let cleaned = String(value || "").trim();
  cleaned = cleaned.replace(/^["'`]+|["'`,]+$/g, "");
  cleaned = cleaned.replace(/^["'`]*[a-z_][a-z0-9_-]{1,}["'`]*\s*:\s*/i, "");
  cleaned = cleaned.replace(/^["'`]+|["'`,]+$/g, "");
  return cleaned.trim();
}

function sanitizeExecutionArgs(args: Record<string, string>): Record<string, string> {
  const next = { ...args };
  const pathKeys = ["path", "file_path", "filepath", "file", "target_path", "target", "root"];

  for (const key of pathKeys) {
    if (typeof next[key] === "string") {
      next[key] = normalizeLooseArgValue(next[key]);
    }
  }

  if (typeof next.paths === "string") {
    next.paths = next.paths
      .split("\n")
      .map((part) => normalizeLooseArgValue(part))
      .filter(Boolean)
      .join("\n");
  }

  return next;
}

function hasMalformedPathArg(args: Record<string, string>): boolean {
  const candidates = [
    args.path,
    args.file_path,
    args.filepath,
    args.file,
    args.target_path,
    args.target,
  ].filter(Boolean) as string[];

  return candidates.some((value) => /["'`]*[a-z_][a-z0-9_-]{1,}["'`]*\s*:/.test(value) || /[{}]/.test(value));
}

export async function runShellCommand(command: string, cwd: string, ctx: ShellContext): Promise<string> {
  try {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const cmd = Command.create("zsh", ["-l", "-c", command], { cwd });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    cmd.stdout.on("data", (data: string) => {
      stdoutChunks.push(data);
    });
    cmd.stderr.on("data", (data: string) => {
      stderrChunks.push(data);
    });

    return await new Promise<string>(async (resolve, reject) => {
      cmd.on("close", (payload: { code: number | null }) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const stdout = stdoutChunks.join("").trim();
        const stderr = stderrChunks.join("").trim();
        const wasStopped = ctx.activeCommandStopped;

        ctx.setActiveCommandProcess(null);
        ctx.setActiveCommandStopped(false);
        ctx.setActiveCommandToolId?.(null);

        if (timedOut) {
          const output = [stdout, stderr].filter(Boolean).join("\n");
          reject(new Error(
            `Command timed out after ${Math.floor(SHELL_COMMAND_TIMEOUT_MS / 1000)}s and was stopped automatically.${output ? `\n${output}` : ""}`,
          ));
          return;
        }

        if (wasStopped || ctx.agentAborted) {
          reject(new Error("Command stopped by user."));
          return;
        }

        if (payload.code !== 0 && payload.code !== null) {
          reject(new Error(`Exit code ${payload.code}\n${stderr || stdout}`));
          return;
        }

        resolve(stdout || stderr || "(no output)");
      });

      cmd.on("error", (err: string) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        ctx.setActiveCommandProcess(null);
        const wasStopped = ctx.activeCommandStopped;
        ctx.setActiveCommandStopped(false);
        ctx.setActiveCommandToolId?.(null);
        if (timedOut) {
          const output = [stdoutChunks.join("").trim(), stderrChunks.join("").trim()].filter(Boolean).join("\n");
          reject(new Error(
            `Command timed out after ${Math.floor(SHELL_COMMAND_TIMEOUT_MS / 1000)}s and was stopped automatically.${output ? `\n${output}` : ""}`,
          ));
          return;
        }
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
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          void invoke("kill_process_tree", { pid: child.pid }).catch(() => child.kill());
        }, SHELL_COMMAND_TIMEOUT_MS);

        if (ctx.agentAborted) {
          ctx.setActiveCommandStopped(true);
          ctx.setActiveCommandToolId?.(null);
          await invoke("kill_process_tree", { pid: child.pid }).catch(() => child.kill());
        }
      } catch (e: unknown) {
        ctx.setActiveCommandProcess(null);
        ctx.setActiveCommandStopped(false);
        ctx.setActiveCommandToolId?.(null);
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

interface SearchMatch {
  path: string;
  line: number;
  col: number;
  line_content: string;
  match_start: number;
  match_end: number;
}

function formatSearchMatches(matches: SearchMatch[]): string {
  if (matches.length === 0) return "No matches found.";
  return matches
    .slice(0, 50)
    .map((match) => `${match.path}:${match.line}:${match.col + 1}: ${match.line_content}`)
    .join("\n");
}

function collectArtifacts(tool: ExecutorAction["tool"], output: string, args: Record<string, string>): string[] {
  const artifacts = new Set<string>();

  const pathArg = args.path || args.root || args.target || "";
  if (pathArg) artifacts.add(pathArg);

  if (tool === "search_files" || tool === "search_content" || tool === "search_in_files" || tool === "git_diff") {
    for (const line of output.split("\n")) {
      const maybePath = line.split(":")[0]?.trim();
      if (maybePath && maybePath.includes("/")) {
        artifacts.add(maybePath);
      }
    }
  }

  return Array.from(artifacts);
}

function resolveProjectTokens(args: Record<string, string>, projectPath: string): Record<string, string> {
  return sanitizeExecutionArgs(Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      value === PROJECT_ROOT_TOKEN ? projectPath : value.split(PROJECT_ROOT_TOKEN).join(projectPath),
    ]),
  ));
}

export function executorActionNeedsApproval(action: ExecutorAction): boolean {
  return action.requiresApproval;
}

export async function executeExecutorAction(action: ExecutorAction, ctx: ToolExecContext): Promise<ExecutorResult> {
  const startedAt = Date.now();
  const resolvedArgs = resolveProjectTokens(action.args, ctx.getProjectPath());

  try {
    if (hasTemplatePlaceholders(resolvedArgs)) {
      throw new Error("Planner action contains unresolved template placeholders.");
    }
    if (hasMalformedPathArg(resolvedArgs)) {
      throw new Error("Planner action contains malformed path arguments.");
    }

    if (action.tool === "search_in_files") {
      const projectPath = ctx.getProjectPath();
      const matches = await invoke<SearchMatch[]>("search_in_files", {
        root: projectPath,
        query: String(resolvedArgs.query || resolvedArgs.pattern || ""),
        caseSensitive: String(resolvedArgs.case_sensitive || "false") === "true",
        useRegex: String(resolvedArgs.use_regex || "false") === "true",
        maxResults: Number(resolvedArgs.max_results || 50),
      });
      const output = formatSearchMatches(matches);
      return {
        actionId: action.id,
        tool: action.tool,
        ok: true,
        output,
        artifacts: Array.from(new Set(matches.map((match) => match.path))),
        durationMs: Date.now() - startedAt,
      };
    }

    if (action.tool === "run_command") {
      ctx.setActiveCommandToolId?.(action.id);
    }

    const result = await executeTool(
      {
        id: action.id,
        name: action.tool,
        args: resolvedArgs,
        status: "running",
      } as ToolCall,
      ctx,
    );

    return {
      actionId: action.id,
      tool: action.tool,
      ok: true,
      output: result,
      artifacts: collectArtifacts(action.tool, result, resolvedArgs),
      durationMs: Date.now() - startedAt,
      args: resolvedArgs,
      description: action.description,
    };
  } catch (error: unknown) {
    return {
      actionId: action.id,
      tool: action.tool,
      ok: false,
      output: "",
      artifacts: collectArtifacts(action.tool, "", resolvedArgs),
      args: resolvedArgs,
      description: action.description,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (action.tool === "run_command") {
      ctx.setActiveCommandToolId?.(null);
    }
  }
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
      if (tc.args.path.endsWith("/.athva/context.md")) {
        throw new Error('Legacy context path is blocked. Write context files under ".athva/contexts/" only.');
      }
      await invoke("write_file", { path: tc.args.path, content: tc.args.content });
      ctx.onFileChanged(tc.args.path);
      return `File written: ${tc.args.path}`;
    }

    case "delete_path": {
      if (!access.fileWrite) throw new Error("File write permission denied");
      if (isProtectedDeletePath(tc.args.path)) throw new Error(`Blocked: deleting "${tc.args.path}" is not allowed.`);
      await invoke("delete_path", { path: tc.args.path });
      ctx.onFileChanged(tc.args.path);
      return `Path deleted: ${tc.args.path}`;
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
      const rawPaths = tc.args.paths as unknown;
      if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
        throw new Error("batch_read: paths must be a non-empty array of file paths");
      }
      const paths = (rawPaths as unknown[]).map(String);
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

    case "search_in_files": {
      if (!access.fileRead) throw new Error("File read permission denied");
      const projectPath = ctx.getProjectPath();
      const matches = await invoke<SearchMatch[]>("search_in_files", {
        root: projectPath,
        query: String(tc.args.query || tc.args.pattern || ""),
        caseSensitive: String(tc.args.case_sensitive || "false") === "true",
        useRegex: String(tc.args.use_regex || "false") === "true",
        maxResults: Number(tc.args.max_results || 50),
      });
      return formatSearchMatches(matches);
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
