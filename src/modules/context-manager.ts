import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, ChatMode, ToolCall } from "./chat-store";

export interface ContextIndexEntry {
  name: string;
  path: string;
}

export interface ContextDocument {
  id: string;
  name: string;
  path: string;
  absolutePath: string;
  kind: "index" | "context" | "task-index" | "task" | "session-index" | "session";
  sizeBytes: number;
  critical: boolean;
  references: string[];
  summary: string;
}

export interface ContextGraphEdge {
  from: string;
  to: string;
  bidirectional: boolean;
}

export interface TaskContextBuildOptions {
  mode: "auto" | "manual";
  selectedPaths?: string[];
  sessionContext?: string;
}

export interface TaskContextSnapshot {
  promptContext: string;
  relevantFiles: string[];
  matchedContextNames: string[];
  selectedPaths: string[];
  oversizedDocuments: ContextDocument[];
}

export interface TaskCompletionRecord {
  sessionId: string;
  userTask: string;
  mode: ChatMode;
  relevantContextFiles: string[];
  messages: ChatMessage[];
  sessionContext?: string;
}

export interface ContextWorkspaceModel {
  rootPath: string;
  indexPath: string;
  sessionIndexPath: string;
  coreEntries: ContextIndexEntry[];
  documents: ContextDocument[];
  edges: ContextGraphEdge[];
}

const CONTEXT_ROOT_RELATIVE = ".athva/contexts";
const CONTEXT_INDEX_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/context.md`;
const ROUTES_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/routes.md`;
const PROJECT_STRUCTURE_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/project-structure.md`;
const PROJECT_CONVENTIONS_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/project-conventions.md`;
const LEGACY_CONTEXT_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/legacy-project-context.md`;
const SESSIONS_DIR_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/sessions`;
const SESSIONS_INDEX_RELATIVE = `${SESSIONS_DIR_RELATIVE}/index.md`;
const OLD_LEGACY_CONTEXT_RELATIVE = ".athva/context.md";
const OBSOLETE_TASK_HISTORY_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/task-history.md`;
const OBSOLETE_HISTORY_DIR_RELATIVE = `${CONTEXT_ROOT_RELATIVE}/history`;
const CONTEXT_SIZE_LIMIT_BYTES = 100 * 1024;
const GRAPH_BASE_WIDTH = 1200;
const GRAPH_BASE_HEIGHT = 820;
const PROJECT_SCAN_LIMIT = 220;

const DEFAULT_CONTEXT_INDEX: ContextIndexEntry[] = [
  { name: "Routes", path: ROUTES_RELATIVE },
  { name: "Project Structure", path: PROJECT_STRUCTURE_RELATIVE },
  { name: "Project Conventions", path: PROJECT_CONVENTIONS_RELATIVE },
  { name: "Sessions", path: SESSIONS_INDEX_RELATIVE },
];

const DEFAULT_CONTEXT_FILE_CONTENT: Record<string, string> = {
  [ROUTES_RELATIVE]: "# Routes\n\n- Add route maps, endpoint summaries, and navigation notes here.\n",
  [PROJECT_STRUCTURE_RELATIVE]: "# Project Structure\n\n- Record high-signal folders, modules, and ownership notes here.\n",
  [PROJECT_CONVENTIONS_RELATIVE]: "# Project Conventions\n\n- Record project-specific coding, naming, workflow, and review conventions here.\n",
  [SESSIONS_INDEX_RELATIVE]: "# Sessions\n\n",
};

const KEYWORD_GROUPS: Array<{ entry: string; terms: string[] }> = [
  { entry: "Routes", terms: ["route", "routes", "router", "routing", "endpoint", "endpoints", "navigation", "nav", "url", "urls", "path", "paths", "page", "pages", "api"] },
  { entry: "Project Structure", terms: ["structure", "module", "modules", "folder", "folders", "architecture", "layout", "tree", "refactor", "organize", "workspace", "directory"] },
  { entry: "Project Conventions", terms: ["convention", "conventions", "style", "naming", "pattern", "patterns", "rule", "rules", "standard", "standards", "guideline", "guidelines"] },
];

type FrontmatterResult = {
  body: string;
  metadata: {
    critical: boolean;
    references: string[];
  };
};

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

function joinPath(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function normalizeRelativeContextPath(value: string): string {
  return value.replace(/\\/g, "/").trim().replace(/^\/+/, "");
}

function normalizeReferencePath(projectPath: string, value: string): string | null {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  if (normalized.startsWith(projectPath)) {
    return normalizeRelativeContextPath(normalized.replace(`${projectPath}/`, ""));
  }
  if (normalized.startsWith(CONTEXT_ROOT_RELATIVE)) {
    return normalizeRelativeContextPath(normalized);
  }
  if (normalized.startsWith("contexts/")) {
    return normalizeRelativeContextPath(`.athva/${normalized}`);
  }
  if (normalized.startsWith("./")) {
    return normalizeReferencePath(projectPath, normalized.slice(2));
  }
  return null;
}

function parseFrontmatter(content: string, projectPath: string): FrontmatterResult {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { body: content, metadata: { critical: false, references: [] } };
  }

  let critical = false;
  const references: string[] = [];
  let captureReferences = false;

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^critical\s*:\s*true$/i.test(line)) {
      critical = true;
      captureReferences = false;
      continue;
    }
    if (/^references\s*:\s*$/i.test(line)) {
      captureReferences = true;
      continue;
    }
    const inlineReference = line.match(/^references\s*:\s*(.+)$/i);
    if (inlineReference) {
      captureReferences = false;
      inlineReference[1].split(",").forEach((part) => {
        const normalized = normalizeReferencePath(projectPath, part);
        if (normalized) references.push(normalized);
      });
      continue;
    }
    if (captureReferences) {
      const itemMatch = line.match(/^-\s+(.+)$/);
      if (!itemMatch) {
        captureReferences = false;
        continue;
      }
      const normalized = normalizeReferencePath(projectPath, itemMatch[1]);
      if (normalized) references.push(normalized);
    }
  }

  return {
    body: content.slice(match[0].length),
    metadata: { critical, references: Array.from(new Set(references)) },
  };
}

function stripFrontmatter(content: string): string {
  return parseFrontmatter(content, "").body;
}

function parseMappingFile(content: string): ContextIndexEntry[] {
  const entries: ContextIndexEntry[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*(?:->|→)\s*(.*?)$/);
    if (!match) continue;
    const name = match[1].trim();
    const path = normalizeRelativeContextPath(match[2]);
    if (!name || !path.startsWith(CONTEXT_ROOT_RELATIVE)) continue;
    entries.push({ name, path });
  }
  return entries;
}

function serializeIndex(entries: ContextIndexEntry[]): string {
  return entries.map((entry) => `${entry.name} -> ${entry.path}`).join("\n");
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || "task";
}

function extractTaskTitle(task: string): string {
  const firstLine = task.split("\n").map((line) => line.trim()).find(Boolean) || "Task";
  return clip(firstLine.replace(/\s+/g, " "), 80);
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

function extractReferences(projectPath: string, relativePath: string, content: string): string[] {
  const frontmatter = parseFrontmatter(content, projectPath);
  const matches = new Set<string>(frontmatter.metadata.references);
  const patterns = [
    /\[[^\]]+\]\(([^)]+)\)/g,
    /(?:->|→)\s*([./A-Za-z0-9_-]+(?:\/[./A-Za-z0-9_-]+)+\.md)/g,
    /(?:references?|refs?)\s*:\s*(.+)$/gim,
  ];

  for (const pattern of patterns) {
    for (const match of frontmatter.body.matchAll(pattern)) {
      const rawValue = (match[1] || "").trim();
      if (!rawValue) continue;
      if (pattern === patterns[2]) {
        rawValue.split(",").forEach((part) => {
          const normalized = normalizeReferencePath(projectPath, part);
          if (normalized && normalized !== relativePath) matches.add(normalized);
        });
        continue;
      }
      const normalized = normalizeReferencePath(projectPath, rawValue);
      if (normalized && normalized !== relativePath) matches.add(normalized);
    }
  }

  return Array.from(matches);
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean)));
}

function buildDocumentSummary(content: string): string {
  const body = stripFrontmatter(content);
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 3);
  return clip(lines.join(" "), 180);
}

function formatContextSection(title: string, content: string): string {
  return `### ${title}\n${content.trim()}`;
}

function scoreContextEntry(entry: ContextDocument, queryText: string, explicitPaths: string[]): number {
  const lowerName = entry.name.toLowerCase();
  const lowerPath = entry.path.toLowerCase();
  let score = 0;

  for (const group of KEYWORD_GROUPS) {
    if (group.entry !== entry.name) continue;
    for (const term of group.terms) {
      if (queryText.includes(term)) score += 3;
    }
  }

  if (entry.kind === "session" || entry.kind === "task") score += 1;
  if (entry.kind === "context" && explicitPaths.length > 0 && /structure|routes|conventions|legacy/.test(lowerPath)) score += 2;
  if (queryText.includes(lowerName)) score += 3;
  if (explicitPaths.some((path) => lowerPath.includes(path.toLowerCase()))) score += 4;
  if (entry.references.some((ref) => explicitPaths.some((path) => ref.includes(path.toLowerCase())))) score += 2;
  if (entry.critical) score += 1;

  return score;
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

function withFrontmatter(content: string, critical: boolean, references: string[]): string {
  const body = stripFrontmatter(content).trimStart();
  const lines = ["---", `critical: ${critical ? "true" : "false"}`];
  if (references.length > 0) {
    lines.push("references:");
    references.forEach((ref) => lines.push(`- ${ref}`));
  }
  lines.push("---", "");
  return `${lines.join("\n")}${body}`;
}

function compactMarkdownContent(content: string, targetBytes: number): string {
  const parsed = parseFrontmatter(content, "");
  const lines = parsed.body.split("\n");
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }

    const preferred =
      trimmed.startsWith("#") ||
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      trimmed.startsWith("##") ||
      trimmed.startsWith("###") ||
      trimmed.includes("->") ||
      kept.length < 24;
    if (!preferred) continue;

    const nextLine = clip(line, 320);
    const nextBytes = new TextEncoder().encode(`${kept.join("\n")}\n${nextLine}`).length;
    if (nextBytes > targetBytes) break;
    kept.push(nextLine);
    used = nextBytes;
  }

  const note = used < new TextEncoder().encode(parsed.body).length ? "\n\n> Context compacted to reduce size.\n" : "";
  return withFrontmatter(`${kept.join("\n").trim()}\n${note}`, parsed.metadata.critical, parsed.metadata.references);
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

export class ContextManager {
  private projectPath = "";

  async setProjectPath(projectPath: string) {
    this.projectPath = projectPath;
    if (projectPath) await this.ensureStructure();
  }

  getRootPath(): string {
    return this.projectPath ? joinPath(this.projectPath, CONTEXT_ROOT_RELATIVE) : "";
  }

  getIndexPath(): string {
    return joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE);
  }

  getGraphBaseSize() {
    return { width: GRAPH_BASE_WIDTH, height: GRAPH_BASE_HEIGHT };
  }

  resolvePath(relativePath: string): string {
    return joinPath(this.projectPath, normalizeRelativeContextPath(relativePath));
  }

  async ensureStructure(): Promise<void> {
    if (!this.projectPath) return;
    await invoke("create_dir", { path: this.getRootPath() }).catch(() => { });
    await invoke("create_dir", { path: joinPath(this.projectPath, SESSIONS_DIR_RELATIVE) }).catch(() => { });
    await ensureFile(joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE), serializeIndex(DEFAULT_CONTEXT_INDEX));
    for (const [relativePath, content] of Object.entries(DEFAULT_CONTEXT_FILE_CONTENT)) {
      await ensureFile(joinPath(this.projectPath, relativePath), content);
    }
    await this.cleanupObsoleteStructure();
    await this.migrateLegacyContext();
  }

  async resetContexts(): Promise<void> {
    if (!this.projectPath) return;
    await invoke("delete_path", { path: this.getRootPath() }).catch(() => { });
    await this.ensureStructure();
  }

  async initContexts(): Promise<void> {
    if (!this.projectPath) return;
    await this.ensureStructure();

    const topLevelEntries = await this.readProjectTree(this.projectPath, 2, PROJECT_SCAN_LIMIT);
    const packageJsonRaw = await readFileIfExists(joinPath(this.projectPath, "package.json"));
    const readmeRaw = await readFileIfExists(joinPath(this.projectPath, "README.md"));
    const packageJson = packageJsonRaw ? this.safeJsonParse(packageJsonRaw) : null;
    const routeHints = topLevelEntries.filter((entry) => /route|router|page|pages|api/i.test(entry)).slice(0, 24);
    const structureHints = topLevelEntries.filter((entry) => !/node_modules|dist|\.git|\.athva/.test(entry)).slice(0, 40);
    const dependencyNames = packageJson
      ? Object.keys({ ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }).slice(0, 24)
      : [];
    const scriptNames = packageJson ? Object.keys(packageJson.scripts || {}) : [];

    await invoke("write_file", {
      path: joinPath(this.projectPath, ROUTES_RELATIVE),
      content: [
        "# Routes",
        "",
        ...(routeHints.length
          ? ["## Discovered Hints", "", ...routeHints.map((entry: string) => `- ${entry}`)]
          : ["- No route or API-oriented paths were detected from the initial scan."]),
        "",
        "## Notes",
        "",
        readmeRaw ? clip(stripFrontmatter(readmeRaw), 1400) : "- Add route maps, endpoint summaries, and navigation notes here.",
        "",
      ].join("\n"),
    });

    await invoke("write_file", {
      path: joinPath(this.projectPath, PROJECT_STRUCTURE_RELATIVE),
      content: [
        "# Project Structure",
        "",
        "## Top-Level Scan",
        "",
        ...structureHints.map((entry: string) => `- ${entry}`),
        "",
        "## Packages",
        "",
        ...(dependencyNames.length ? dependencyNames.map((dep) => `- ${dep}`) : ["- No package manifest detected."]),
        "",
      ].join("\n"),
    });

    await invoke("write_file", {
      path: joinPath(this.projectPath, PROJECT_CONVENTIONS_RELATIVE),
      content: [
        "# Project Conventions",
        "",
        "## Tooling",
        "",
        ...(scriptNames.length ? scriptNames.map((script) => `- npm script: ${script}`) : ["- No scripts discovered."]),
        "",
        "## Repository Notes",
        "",
        packageJson ? `- Package manager manifest detected: package.json` : "- Package manager manifest not detected.",
        readmeRaw ? `- README present and can be used as a human-authored baseline.` : "- README not detected.",
        "",
        "- Replace this generated base with repo-specific conventions as you refine the contexts.",
        "",
      ].join("\n"),
    });
  }

  async compactContexts(): Promise<void> {
    if (!this.projectPath) return;
    await this.ensureStructure();
    const documents = await this.readContextDocuments();

    for (const document of documents) {
      if (document.kind === "session-index" || document.kind === "index") continue;
      if (document.sizeBytes <= 12 * 1024) continue;
      const content = await readFileIfExists(document.absolutePath);
      if (!content) continue;
      const compacted = compactMarkdownContent(content, 12 * 1024);
      await invoke("write_file", { path: document.absolutePath, content: compacted });
    }
  }

  async buildTaskContext(task: string, history: ChatMessage[], options?: TaskContextBuildOptions): Promise<TaskContextSnapshot> {
    await this.ensureStructure();

    const model = await this.buildWorkspaceModel();
    const queryText = `${task}\n${history.slice(-6).map((message) => message.content).join("\n")}`.toLowerCase();
    const explicitPaths = extractMentionedPaths(queryText);
    const selectedSet = new Set((options?.selectedPaths || []).map((path) => normalizeRelativeContextPath(path)));

    let selectedDocuments = model.documents.filter((doc) => !["index", "task-index", "session-index"].includes(doc.kind));
    if (options?.mode === "manual" && selectedSet.size > 0) {
      selectedDocuments = selectedDocuments.filter((doc) => selectedSet.has(doc.path));
    } else {
      selectedDocuments = selectedDocuments
        .map((entry) => ({ entry, score: scoreContextEntry(entry, queryText, explicitPaths) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(({ entry }) => entry);
    }

    const oversizedDocuments = selectedDocuments.filter((doc) => doc.sizeBytes > CONTEXT_SIZE_LIMIT_BYTES && !doc.critical);
    selectedDocuments = selectedDocuments.filter((doc) => doc.sizeBytes <= CONTEXT_SIZE_LIMIT_BYTES || doc.critical);

    const sections: string[] = [];
    const relevantFiles = [model.indexPath];
    const registryLines = model.documents
      .filter((doc) => doc.kind !== "task")
      .slice(0, 24)
      .map((doc) => `- ${doc.name} -> ${doc.path}${doc.references.length ? ` [refs: ${doc.references.join(", ")}]` : ""}`);

    sections.push("[Available Contexts]\n" + registryLines.join("\n"));

    for (const entry of selectedDocuments) {
      const content = await readFileIfExists(entry.absolutePath);
      if (!content?.trim()) continue;
      sections.push(formatContextSection(entry.name, content));
      relevantFiles.push(entry.absolutePath);
    }

    if (options?.sessionContext?.trim()) {
      sections.push(`### Session Working Context\n${options.sessionContext.trim()}`);
    }

    return {
      promptContext: sections.join("\n\n").trim(),
      relevantFiles: uniquePaths(relevantFiles),
      matchedContextNames: selectedDocuments.map((entry) => entry.name),
      selectedPaths: selectedDocuments.map((entry) => entry.path),
      oversizedDocuments,
    };
  }

  async buildWorkspaceModel(): Promise<ContextWorkspaceModel> {
    await this.ensureStructure();
    const coreEntries = await this.readContextIndex();
    const documents = await this.readContextDocuments();
    return {
      rootPath: this.getRootPath(),
      indexPath: joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE),
      sessionIndexPath: joinPath(this.projectPath, SESSIONS_INDEX_RELATIVE),
      coreEntries,
      documents,
      edges: this.buildGraphEdges(documents),
    };
  }

  async readDocument(pathOrRelativePath: string): Promise<string> {
    const absolutePath = pathOrRelativePath.startsWith(this.projectPath)
      ? pathOrRelativePath
      : this.resolvePath(pathOrRelativePath);
    return (await readFileIfExists(absolutePath)) || "";
  }

  async recordTaskCompletion(record: TaskCompletionRecord): Promise<void> {
    if (!this.projectPath || !record.userTask.trim()) return;
    await this.ensureStructure();

    const sessionDirRelative = `${SESSIONS_DIR_RELATIVE}/${record.sessionId}`;
    const tasksDirRelative = `${sessionDirRelative}/tasks`;
    const sessionFileRelative = `${sessionDirRelative}/session.md`;
    const taskIndexRelative = `${tasksDirRelative}/index.md`;
    await invoke("create_dir", { path: joinPath(this.projectPath, tasksDirRelative) }).catch(() => { });

    const title = extractTaskTitle(record.userTask);
    const summary = summarizeToolActivity(record.messages);
    const finalAssistant = [...record.messages].reverse().find((message) => message.role === "assistant")?.content.trim() || "";
    const taskFileRelative = await this.nextAvailableTaskPath(tasksDirRelative, slugify(title));
    const taskFileAbsolute = joinPath(this.projectPath, taskFileRelative);

    const taskContent = [
      `# ${title}`,
      "",
      "## Request",
      "",
      record.userTask.trim(),
      "",
      "## Relevant Context Files",
      "",
      ...(record.relevantContextFiles.length
        ? record.relevantContextFiles.map((path) => `- ${path.replace(`${this.projectPath}/`, "")}`)
        : ["- None"]),
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
    await invoke("write_file", { path: taskFileAbsolute, content: taskContent });

    const taskIndexRaw = (await readFileIfExists(joinPath(this.projectPath, taskIndexRelative))) || "# Tasks\n\n";
    const nextTaskIndex = `${taskIndexRaw.trimEnd()}\n- ${title} -> ${taskFileRelative}\n`;
    await invoke("write_file", { path: joinPath(this.projectPath, taskIndexRelative), content: nextTaskIndex });

    const sessionSummary = clip(finalAssistant || record.userTask, 220);
    const sessionContent = [
      `# Session ${record.sessionId}`,
      "",
      `- Session ID: ${record.sessionId}`,
      `- Summary: ${sessionSummary}`,
      `- Tasks Index: ${taskIndexRelative}`,
      ...(record.sessionContext?.trim() ? ["", "## Working Context", "", record.sessionContext.trim()] : []),
      "",
    ].join("\n");
    await invoke("write_file", { path: joinPath(this.projectPath, sessionFileRelative), content: sessionContent });

    const sessionsIndexRaw = (await readFileIfExists(joinPath(this.projectPath, SESSIONS_INDEX_RELATIVE))) || "# Sessions\n\n";
    const sessionLine = `- ${record.sessionId}: ${sessionSummary}`;
    const nextSessionsIndex = sessionsIndexRaw.includes(sessionLine)
      ? sessionsIndexRaw
      : `${sessionsIndexRaw.trimEnd()}\n${sessionLine}\n`;
    await invoke("write_file", { path: joinPath(this.projectPath, SESSIONS_INDEX_RELATIVE), content: nextSessionsIndex });
  }

  async setContextCritical(relativePath: string, critical: boolean): Promise<void> {
    const absolutePath = this.resolvePath(relativePath);
    const existing = await readFileIfExists(absolutePath);
    if (existing === null) return;
    const parsed = parseFrontmatter(existing, this.projectPath);
    await invoke("write_file", {
      path: absolutePath,
      content: withFrontmatter(existing, critical, parsed.metadata.references),
    });
  }

  private async migrateLegacyContext(): Promise<void> {
    const legacyPath = joinPath(this.projectPath, OLD_LEGACY_CONTEXT_RELATIVE);
    const legacyContent = await readFileIfExists(legacyPath);
    if (!legacyContent?.trim()) return;

    const migratedPath = joinPath(this.projectPath, LEGACY_CONTEXT_RELATIVE);
    const existing = await readFileIfExists(migratedPath);
    if (!existing?.trim()) {
      await invoke("write_file", {
        path: migratedPath,
        content: `# Legacy Project Context\n\n${legacyContent.trim()}\n`,
      });
    }

    const index = await this.readContextIndex();
    if (!index.some((entry) => entry.path === LEGACY_CONTEXT_RELATIVE)) {
      index.push({ name: "Legacy Project Context", path: LEGACY_CONTEXT_RELATIVE });
      await invoke("write_file", {
        path: joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE),
        content: serializeIndex(index),
      });
    }

    await invoke("delete_path", { path: legacyPath }).catch(() => { });
  }

  private async cleanupObsoleteStructure(): Promise<void> {
    await invoke("delete_path", { path: joinPath(this.projectPath, OBSOLETE_TASK_HISTORY_RELATIVE) }).catch(() => { });
    await invoke("delete_path", { path: joinPath(this.projectPath, OBSOLETE_HISTORY_DIR_RELATIVE) }).catch(() => { });
  }

  private async readContextIndex(): Promise<ContextIndexEntry[]> {
    const indexPath = joinPath(this.projectPath, CONTEXT_INDEX_RELATIVE);
    const raw = (await readFileIfExists(indexPath)) || "";
    const parsed = parseMappingFile(raw);
    return parsed.length > 0 ? parsed : DEFAULT_CONTEXT_INDEX;
  }

  private async readContextDocuments(): Promise<ContextDocument[]> {
    const documents: ContextDocument[] = [];
    const entries = await this.collectMarkdownFiles(this.getRootPath());

    for (const absolutePath of entries) {
      const content = await readFileIfExists(absolutePath);
      if (content === null) continue;
      const relativePath = normalizeRelativeContextPath(absolutePath.replace(`${this.projectPath}/`, ""));
      const parsed = parseFrontmatter(content, this.projectPath);
      documents.push({
        id: relativePath,
        name: this.documentName(relativePath, content),
        path: relativePath,
        absolutePath,
        kind: this.documentKind(relativePath),
        sizeBytes: new TextEncoder().encode(content).length,
        critical: parsed.metadata.critical,
        references: extractReferences(this.projectPath, relativePath, content),
        summary: buildDocumentSummary(content),
      });
    }

    return documents.sort((a, b) => a.path.localeCompare(b.path));
  }

  private buildGraphEdges(documents: ContextDocument[]): ContextGraphEdge[] {
    const knownPaths = new Set(documents.map((doc) => doc.path));
    const byPath = new Map(documents.map((doc) => [doc.path, doc]));
    const edges = new Map<string, ContextGraphEdge>();

    for (const document of documents) {
      for (const ref of document.references) {
        if (!knownPaths.has(ref)) continue;
        const reverse = byPath.get(ref)?.references.includes(document.path) || false;
        const key = reverse ? [document.path, ref].sort().join("::") : `${document.path}->${ref}`;
        if (!edges.has(key)) {
          edges.set(key, {
            from: reverse ? [document.path, ref].sort()[0] : document.path,
            to: reverse ? [document.path, ref].sort()[1] : ref,
            bidirectional: reverse,
          });
        }
      }
    }

    return Array.from(edges.values());
  }

  private async collectMarkdownFiles(rootPath: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string) => {
      const entries = await invoke<DirEntry[]>("read_dir", { path: dir }).catch(() => []);
      for (const entry of entries) {
        if (entry.is_dir) {
          await visit(entry.path);
          continue;
        }
        if (entry.path.endsWith(".md")) out.push(entry.path);
      }
    };
    await visit(rootPath);
    return out;
  }

  private async readProjectTree(rootPath: string, maxDepth: number, limit: number): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string, depth: number) => {
      if (out.length >= limit) return;
      const entries = await invoke<DirEntry[]>("read_dir", { path: dir }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= limit) break;
        const relativePath = entry.path.replace(`${rootPath}/`, "");
        if (/^(\.git|node_modules|dist|dist-cli|target)$/.test(relativePath.split("/")[0])) continue;
        out.push(relativePath + (entry.is_dir ? "/" : ""));
        if (entry.is_dir && depth < maxDepth) {
          await visit(entry.path, depth + 1);
        }
      }
    };
    await visit(rootPath, 0);
    return out;
  }

  private documentName(relativePath: string, content: string): string {
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) return heading;
    const baseName = relativePath.split("/").pop() || relativePath;
    return baseName.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  }

  private documentKind(relativePath: string): ContextDocument["kind"] {
    if (relativePath === CONTEXT_INDEX_RELATIVE) return "index";
    if (relativePath.endsWith("/tasks/index.md")) return "task-index";
    if (relativePath === SESSIONS_INDEX_RELATIVE) return "session-index";
    if (relativePath.includes("/sessions/") && relativePath.endsWith("/session.md")) return "session";
    if (relativePath.includes("/sessions/")) return "task";
    return "context";
  }

  private async nextAvailableTaskPath(baseDirRelative: string, slug: string): Promise<string> {
    let attempt = 0;
    while (attempt < 100) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const relativePath = `${baseDirRelative}/${slug}${suffix}.md`;
      const exists = await readFileIfExists(joinPath(this.projectPath, relativePath));
      if (exists === null) return relativePath;
      attempt += 1;
    }
    return `${baseDirRelative}/${slug}-${Date.now()}.md`;
  }

  private safeJsonParse(value: string): any {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
}
