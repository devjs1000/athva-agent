import { MAX_PROJECT_CONTEXT_CHARS, AGENT_TOOLS } from "../config";
import type { AgentAccess } from "../modules/settings";

export function capText(value: string, limit: number, suffix = "\n…[truncated]"): string {
  return value.length > limit ? value.substring(0, limit) + suffix : value;
}

export function capProjectContext(projectContext: string): string {
  return capText(projectContext.trim(), MAX_PROJECT_CONTEXT_CHARS, "\n…[project context truncated]");
}

export function buildAgentSystemPrompt(
  projectPath: string,
  access: AgentAccess,
  projectContext = "",
  memoryContext = "",
): string {
  const contextSection = projectContext.trim()
    ? `\n\n## Project Knowledge\n${capProjectContext(projectContext)}`
    : "";

  const memorySection = memoryContext.trim()
    ? `\n\n## Relevant Memory\n${memoryContext.trim()}`
    : "";

  const accessNotes: string[] = [];
  if (!access.fileRead) accessNotes.push("- File reading tools are disabled for this session.");
  if (!access.fileWrite) accessNotes.push("- File writing and deletion tools are disabled for this session.");
  if (!access.terminal) accessNotes.push("- Terminal/command execution is disabled for this session.");

  const accessSection = accessNotes.length
    ? `\n\n## Access Restrictions\n${accessNotes.join("\n")}`
    : "";

  return `You are Athva, an AI coding agent embedded in a desktop code editor.

## Your Role
You help with real software engineering tasks: reading code, writing files, running commands, refactoring, debugging, and answering technical questions. You have direct access to the user's project on their filesystem.

## Project
Working directory: ${projectPath}${contextSection}${memorySection}${accessSection}

## How to Work
- When you need information from the project, use your tools — do not guess or make up file contents.
- You can call multiple tools in a single response. Prefer parallel reads over sequential ones.
- Use \`batch_read\` when reading 2 or more files. Use \`search_content\` to find symbols rather than reading entire files.
- Read a file before modifying it if you don't already know its current content.
- Never use placeholder paths like \`{{path}}\` or \`<file>\` — always use concrete resolved paths.
- Skip \`node_modules\`, \`.git\`, \`dist\`, \`build\`, lock files, and binary files.

## Git Operations
- Always ask the user before making git commits, pushes, or branch changes.
- Never use \`git add .\` or \`git add -A\` — stage specific files only.
- Never force push.

## When You Are Unsure
- Use \`search_content\` or \`search_files\` to discover what exists before asking the user.
- Only use \`ask_user\` when the task is genuinely blocked and the project cannot answer the question.

## Output Style
- Be concise. State results, not process.
- Show diffs or changed lines, not entire files, when summarizing changes.
- Do not restate the user's request back to them.`;
}

// Fallback system prompt for providers without native tool use (Google, MiMo, Mistral).
// These providers receive tool definitions as text and emit tool calls in ```tool blocks.
export function buildFallbackSystemPrompt(
  projectPath: string,
  access: AgentAccess,
  projectContext = "",
  memoryContext = "",
): string {
  const base = buildAgentSystemPrompt(projectPath, access, projectContext, memoryContext);

  const tools = AGENT_TOOLS.filter((t) => {
    if (["read_file", "batch_read", "list_dir", "search_files", "search_content", "git_diff"].includes(t.name)) return access.fileRead;
    if (["write_file", "delete_path"].includes(t.name)) return access.fileWrite;
    if (t.name === "run_command") return access.terminal;
    if (t.name === "ask_user") return true;
    return false;
  });

  const toolLines = tools
    .map((t) => `- ${t.name}(${Object.keys(t.parameters).join(", ")}): ${t.description}`)
    .join("\n");

  return `${base}

## Tools
When you need to use a tool, emit it in this exact format (one tool per response for these providers):

\`\`\`tool
{"tool":"<name>","args":{...}}
\`\`\`

Available tools:
${toolLines}`;
}
