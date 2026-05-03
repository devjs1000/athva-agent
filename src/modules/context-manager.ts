import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, ChatMode, ToolCall } from "./chat-store";

export interface ContextIndexEntry {
  name: string;
  path: string;
}

export interface TaskHistoryEntry {
  title: string;
  path: string;
}

export interface TaskContextSnapshot {
  promptContext: string;
  relevantFiles: string[];
  matchedContextNames: string[];
}

export interface TaskCompletionRecord {
  userTask: string;
  mode: ChatMode;
  relevantContextFiles: string[];
  messages: ChatMessage[];
}

export interface ContextWorkspaceModel {
  rootPath: string;
  indexPath: string;
  taskHistoryPath: string;
  coreEntries: ContextIndexEntry[];
  taskEntries: TaskHistoryEntry[];
}

const CONTEXT_ROOT_RELATIVE = ".athva/contexts";
const CONTEXT_INDEX_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/context.md`;
const ROUTES_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/routes.md`;
const PROJECT_STRUCTURE_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/project-structure.md`;
const PROJECT_CONVENTIONS_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/project-conventions.md`;
const TASK_HISTORY_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/task-history.md`;
const HISTORY_DIR_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/history`;
const LEGACY_CONTEXT_RELATIVE = ".athva/context.md";

const DEFAULT_CONTEXT_INDEX: ContextIndexEntry[] = [
  { name: "Routes", path: ROUTES_RELATIVE },
  { name: "Project Structure", path: PROJECT_STRUCTURE_RELATIVE },
  { name: "Project Conventions", path: PROJECT_CONVENTIONS_RELATIVE },
  { name: "Task History", path: TASK_HISTORY_RELATIVE },
];

const DEFAULT_CONTEXT_FILE_CONTENT: Record<string, string> = {
  [ROUTES_RELATIVE]: "# Routes\n\n- Add route maps, endpoint summaries, and navigation notes here.\n",
  [PROJECT_STRUCTURE_RELATIVE]: "# Project Structure\n\n- Record high-signal folders, modules, and ownership notes here.\n",
  [PROJECT_CONVENTIONS_RELATIVE]: "# Project Conventions\n\n- Record project-specific coding, naming, workflow, and review conventions here.\n",
  [TASK_HISTORY_RELATIVE]: "",
};

const STOP_WORDS = new Set([
  "about", "after", "agent", "also", "before", "build", "change", "code", "create", "current", "file", "files",
  "from", "have", "into", "just", "like", "make", "need", "only", "project", "show", "that", "them", "this",
  "with", "your",
]);

const KEYWORD_GROUPS: Array<{ entry: string; terms: string[] }> = [
  { entry: "Routes", terms: ["route", "routes", "router", "routing", "endpoint", "endpoints", "navigation", "nav", "url", "urls", "path", "paths", "page", "pages", "api"] },
  { entry: "Project Structure", terms: ["structure", "module", "modules", "folder", "folders", "architecture", "layout", "tree", "refactor", "organize", "workspace", "directory"] },
  { entry: "Project Conventions", terms: ["convention", "conventions", "style", "naming", "pattern", "patterns", "rule", "rules", "standard", "standards", "guideline", "guidelines"] },
];

function joinPath(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function normalizeRelativeContextPath(value: string): string {
  return value.replace(/\\/g, "/").trim().replace(/^\/+/, "");
}

function parseMappingFile(content: string, keyLabel: "name" | "title"): Array<Record<"name" | "path" | "title", string>> {
  const entries: Array<Record<"name" | "path" | "title", string>> = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*(?:->|→)\s*(.*?)$/);
    if (!match) continue;
    const left = match[1].trim();
    const right = normalizeRelativeContextPath(match[2]);
    if (!left || !right.startsWith(CONTEXT_ROOT_RELATIVE)) continue;
    entries.push({
      name: keyLabel === "name" ? left : "",
      title: keyLabel === "title" ? left : "",
      path: right,
    });
  }
  return entries;
}

function serializeIndex(entries: ContextIndexEntry[]): string {
  return entries.map((entry) => `${entry.name} -> ${entry.path}`).join("\n");
}

function serializeTaskHistory(entries: TaskHistoryEntry[]): string {
  return entries.map((entry) => `${entry.title} -> ${entry.path}`).join("\n");
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "task";
}

function extractTaskTitle(task: string): string {
  const firstLine = task.split("\n").map((line) => line.trim()).find(Boolean) || "Task";
  return clip(firstLine.replace(/\s+/g, " "), 80);
}

function tokenize(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9/_\-.]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
      .filter((token) => !STOP_WORDS.has(token)),
  ));
}

function extractMentionedPaths(text: string): string[] {
  const matches = new Set<string>();
  const patterns = [
    /`([^`]+\.[a-z0-9]+)`/gi,
    /([A-Za-z0-9._/-]+\/[A-Za-z0-9._/-]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || "").trim();
      if (!value || value.startsWith("http")) continue;
      matches.add(value.replace(/^\.?\//, ""));
    }
  }

  return Array.from(matches);
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean)));
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_file", { path });
  } catch {
    return null;
  }
}

async function ensureFile(path: string, content: string): Promise<void> {
  const existing = await readFileIfExists(path);
  if (existing !== null) return;
  await invoke("write_file", { path, content });
}

function parseTaskHistory(content: string): TaskHistoryEntry[] {
  return parseMappingFile(content, "title")
    .map((entry) => ({ title: entry.title, path: entry.path }));
}

function scoreContextEntry(entry: ContextIndexEntry, queryText: string, explicitPaths: string[]): number {
  const lowerName = entry.name.toLowerCase();
  let score = entry.name === "Project Conventions" ? 2 : 0;

  for (const group of KEYWORD_GROUPS) {
    if (group.entry !== entry.name) continue;
    for (const term of group.terms) {
      if (queryText.includes(term)) score += 3;
    }
  }

  if (entry.name === "Project Structure" && explicitPaths.length > 0) score += 3;
  if (entry.name === "Routes" && explicitPaths.some((path) => /route|router|page|api/i.test(path))) score += 2;
  if (entry.name === "Task History") score += 1;
  if (queryText.includes(lowerName)) score += 2;

  return score;
}

function formatContextSection(title: string, content: string): string {
  return `### ${title}\n${content.trim()}`;
}

function summarizeToolActivity(messages: ChatMessage[]): {
  filesRead: string[];
  filesWritten: string[];
  commands: string[];
} {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commands = new Set<string>();

  for (const message of messages) {
    for (const toolCall of message.toolCalls || []) {
      collectToolCallArtifacts(toolCall, filesRead, filesWritten, commands);
    }
  }

  return {
    filesRead: Array.from(filesRead),
    filesWritten: Array.from(filesWritten),
    commands: Array.from(commands),
  };
}

function collectToolCallArtifacts(
  toolCall: ToolCall,
  filesRead: Set<string>,
  filesWritten: Set<string>,
  commands: Set<string>,
) {
  if (toolCall.name === "read_file" && toolCall.args.path) filesRead.add(toolCall.args.path);
  if (toolCall.name === "batch_read" && Array.isArray(toolCall.args.paths)) {
    for (const path of toolCall.args.paths) filesRead.add(String(path));
  }
  if (toolCall.name === "write_file" && toolCall.args.path) filesWritten.add(toolCall.args.path);
  if (toolCall.name === "delete_path" && toolCall.args.path) filesWritten.add(toolCall.args.path);
  if (toolCall.name === "run_command" && toolCall.args.command) commands.add(toolCall.args.command);
}

export class ContextManager {
  private projectPath = "";

  async setProjectPath(projectPath: string) {
    this.projectPath = projectPath;
    if (projectPath) {
      await this.ensureStructure();
    }
  }

  getRootPath(): string {
    return this.projectPath ? joinPath(this.projectPath, CONTEXT_ROOT_RELATIVE) : "";
  }

  getProjectConventionsPath(): string {
    return joinPath(this.projectPath, PROJECT_CONVENTIONS_RELATIVE);
  }

  async loadProjectConventions(): Promise<string> {
    await this.ensureStructure();
    return (await readFileIfExists(this.getProjectConventionsPath())) || DEFAULT_CONTEXT_FILE_CONTENT[PROJECT_CONVENTIONS_RELATIVE];
  }

  async saveProjectConventions(content: string): Promise<void> {
    await this.ensureStructure();
    await invoke("write_file", {
      path: this.getProjectConventionsPath(),
      content,
    });
  }

  async ensureStructure(): Promise<void> {
    if (!this.projectPath) return;

    await invoke("create_dir", { path: this.getRootPath() }).catch(() => { });
    await invoke("create_dir", { path: joinPath(this.projectPath, HISTORY_DIR_RELATIVE) }).catch(() => { });

    await ensureFile(joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE), serializeIndex(DEFAULT_CONTEXT_INDEX));
    for (const [relativePath, content] of Object.entries(DEFAULT_CONTEXT_FILE_CONTENT)) {
      await ensureFile(joinPath(this.projectPath, relativePath), content);
    }

    await this.migrateLegacyContext();
  }

  async buildTaskContext(task: string, history: ChatMessage[]): Promise<TaskContextSnapshot> {
    await this.ensureStructure();

    const index = await this.readContextIndex();
    const queryText = `${task}\n${history.slice(-6).map((message) => message.content).join("\n")}`.toLowerCase();
    const explicitPaths = extractMentionedPaths(queryText);

    const selectedEntries = index
      .map((entry) => ({ entry, score: scoreContextEntry(entry, queryText, explicitPaths) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(({ entry }) => entry);

    const matchedTaskHistory = await this.findRelevantTaskHistory(queryText);
    const sections: string[] = [];
    const relevantFiles = [joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE)];

    sections.push(
      "[Context Index]\n" +
      index
        .map((entry) => `- ${entry.name} -> ${entry.path}`)
        .join("\n"),
    );

    for (const entry of selectedEntries) {
      const content = await readFileIfExists(joinPath(this.projectPath, entry.path));
      if (!content?.trim()) continue;
      sections.push(formatContextSection(entry.name, content));
      relevantFiles.push(joinPath(this.projectPath, entry.path));
    }

    if (matchedTaskHistory.length > 0) {
      sections.push(
        "### Related Task History\n" +
        matchedTaskHistory
          .map((entry) => `- ${entry.title} -> ${entry.path}`)
          .join("\n"),
      );

      for (const entry of matchedTaskHistory) {
        const content = await readFileIfExists(joinPath(this.projectPath, entry.path));
        if (!content?.trim()) continue;
        sections.push(formatContextSection(`Task: ${entry.title}`, clip(content, 2200)));
        relevantFiles.push(joinPath(this.projectPath, entry.path));
      }
    }

    return {
      promptContext: sections.join("\n\n").trim(),
      relevantFiles: uniquePaths(relevantFiles),
      matchedContextNames: selectedEntries.map((entry) => entry.name),
    };
  }

  async buildWorkspaceModel(): Promise<ContextWorkspaceModel> {
    await this.ensureStructure();
    return {
      rootPath: this.getRootPath(),
      indexPath: joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE),
      taskHistoryPath: joinPath(this.projectPath, TASK_HISTORY_RELATIVE),
      coreEntries: await this.readContextIndex(),
      taskEntries: await this.readTaskHistory(),
    };
  }

  async recordTaskCompletion(record: TaskCompletionRecord): Promise<void> {
    if (!this.projectPath || !record.userTask.trim()) return;
    await this.ensureStructure();

    const title = extractTaskTitle(record.userTask);
    const date = new Date().toISOString().replace(/[:]/g, "-");
    const slug = slugify(title);
    const relativePath = `${HISTORY_DIR_RELATIVE}/${date}-${slug}.md`;
    const absolutePath = joinPath(this.projectPath, relativePath);
    const summary = summarizeToolActivity(record.messages);
    const finalAssistant = [...record.messages].reverse().find((message) => message.role === "assistant")?.content.trim() || "";

    const content = [
      `# ${title}`,
      "",
      `- Recorded At: ${new Date().toISOString()}`,
      `- Mode: ${record.mode}`,
      "",
      "## Request",
      "",
      record.userTask.trim(),
      "",
      "## Relevant Context Files",
      "",
      ...record.relevantContextFiles.map((path) => `- ${path.replace(`${this.projectPath}/`, "")}`),
      "",
      "## Files Read",
      "",
      ...(summary.filesRead.length ? summary.filesRead.map((path) => `- ${path.replace(`${this.projectPath}/`, "")}`) : ["- None"]),
      "",
      "## Files Written",
      "",
      ...(summary.filesWritten.length ? summary.filesWritten.map((path) => `- ${path.replace(`${this.projectPath}/`, "")}`) : ["- None"]),
      "",
      "## Commands",
      "",
      ...(summary.commands.length ? summary.commands.map((command) => `- \`${command}\``) : ["- None"]),
      "",
      "## Result",
      "",
      finalAssistant || "No assistant summary captured.",
      "",
    ].join("\n");

    await invoke("write_file", { path: absolutePath, content });

    const taskHistory = await this.readTaskHistory();
    const nextHistory = [{ title, path: relativePath }, ...taskHistory].slice(0, 300);
    await invoke("write_file", {
      path: joinPath(this.projectPath, TASK_HISTORY_RELATIVE),
      content: serializeTaskHistory(nextHistory),
    });
  }

  private async migrateLegacyContext(): Promise<void> {
    const legacyPath = joinPath(this.projectPath, LEGACY_CONTEXT_RELATIVE);
    const legacyContent = await readFileIfExists(legacyPath);
    if (!legacyContent?.trim()) return;

    const conventionsPath = this.getProjectConventionsPath();
    const current = (await readFileIfExists(conventionsPath)) || "";
    if (!current.includes("Migrated Legacy Context")) {
      const merged = [
        current.trimEnd(),
        "",
        "## Migrated Legacy Context",
        "",
        legacyContent.trim(),
        "",
      ].join("\n");
      await invoke("write_file", { path: conventionsPath, content: merged });
    }

    await invoke("delete_path", { path: legacyPath }).catch(() => { });
  }

  private async readContextIndex(): Promise<ContextIndexEntry[]> {
    const indexPath = joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE);
    const raw = (await readFileIfExists(indexPath)) || "";
    const parsed = parseMappingFile(raw, "name")
      .map((entry) => ({ name: entry.name, path: entry.path }));
    return parsed.length > 0 ? parsed : DEFAULT_CONTEXT_INDEX;
  }

  private async readTaskHistory(): Promise<TaskHistoryEntry[]> {
    const historyPath = joinPath(this.projectPath, TASK_HISTORY_RELATIVE);
    const raw = (await readFileIfExists(historyPath)) || "";
    return parseTaskHistory(raw);
  }

  private async findRelevantTaskHistory(queryText: string): Promise<TaskHistoryEntry[]> {
    const entries = await this.readTaskHistory();
    if (entries.length === 0) return [];

    const tokens = tokenize(queryText);
    if (tokens.length === 0) return entries.slice(0, 2);

    return entries
      .map((entry) => {
        const haystack = `${entry.title} ${entry.path}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) score += token.length > 6 ? 3 : 2;
        }
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ entry }) => entry);
  }
}
