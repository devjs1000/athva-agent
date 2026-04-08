import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Ace } from "ace-builds";
import { SNIPPET_CATEGORIES, type Snippet } from "./snippets-data";

export type SnippetScope = "global" | "project";
export type SnippetSource = "builtin" | SnippetScope;

export interface SnippetEntry extends Snippet {
  id: string;
  category: string;
  source: SnippetSource;
}

interface StoredSnippetFile {
  snippets: Array<Omit<SnippetEntry, "source">>;
}

const GLOBAL_SNIPPETS_PATH = ".athva/snippets.json";
const PROJECT_SNIPPETS_FILE = ".athva/snippets.json";
const SNIPPET_PREFIX_RE = /[A-Za-z0-9_$-]/;

function createSnippetId(): string {
  return `snippet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function modeToCategories(modeName: string): string[] {
  const normalized = modeName.toLowerCase();
  if (normalized.includes("tsx")) return ["typescript", "javascript", "react"];
  if (normalized.includes("jsx")) return ["javascript", "typescript", "react"];
  if (normalized.includes("typescript")) return ["typescript"];
  if (normalized.includes("javascript")) return ["javascript"];
  if (normalized.includes("html")) return ["html"];
  if (normalized.includes("css")) return ["css"];
  if (normalized.includes("python")) return ["python"];
  return [];
}

function getSnippetPrefix(session: Ace.EditSession, pos: Ace.Point, fallback: string): string {
  if (fallback) return fallback;

  const line = session.getLine(pos.row).slice(0, pos.column);
  let start = line.length;
  while (start > 0 && SNIPPET_PREFIX_RE.test(line[start - 1])) start--;
  return line.slice(start);
}

function dedupeSnippets(snippets: SnippetEntry[]): SnippetEntry[] {
  const seen = new Set<string>();
  const results: SnippetEntry[] = [];
  for (const snippet of snippets) {
    const key = `${snippet.category}:${snippet.prefix}:${snippet.label}:${snippet.body}:${snippet.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(snippet);
  }
  return results;
}

function normalizeStoredSnippets(raw: string, source: SnippetScope): SnippetEntry[] {
  try {
    const parsed = JSON.parse(raw) as StoredSnippetFile;
    return (parsed.snippets || [])
      .filter((snippet) => snippet && snippet.id && snippet.category && snippet.prefix && snippet.label && snippet.body)
      .map((snippet) => ({ ...snippet, description: snippet.description || "", source }));
  } catch {
    return [];
  }
}

function getBuiltInSnippets(): SnippetEntry[] {
  return SNIPPET_CATEGORIES.flatMap((category) =>
    category.snippets.map((snippet) => ({
      ...snippet,
      id: `builtin:${category.id}:${snippet.prefix}:${snippet.label}`,
      category: category.id,
      source: "builtin" as const,
    }))
  );
}

export class SnippetStore {
  private projectPath = "";
  private readonly builtIn = getBuiltInSnippets();
  private globalSnippets: SnippetEntry[] = [];
  private projectSnippets: SnippetEntry[] = [];
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.globalSnippets = await this.readGlobalSnippets();
    this.initialized = true;
  }

  async setProjectPath(projectPath: string) {
    await this.init();
    this.projectPath = projectPath;
    this.projectSnippets = projectPath ? await this.readProjectSnippets(projectPath) : [];
  }

  getSnippets(category: string): SnippetEntry[] {
    return dedupeSnippets(
      [...this.projectSnippets, ...this.globalSnippets, ...this.builtIn].filter((snippet) => snippet.category === category)
    );
  }

  getCustomCompleter(): Ace.Completer {
    const store = this;
    return {
      identifierRegexps: [/[a-zA-Z_$0-9]/],
      getCompletions(
        _editor: Ace.Editor,
        session: Ace.EditSession,
        pos: Ace.Point,
        prefix: string,
        callback: Ace.CompleterCallback
      ) {
        const resolvedPrefix = getSnippetPrefix(session, pos, prefix).trim();
        if (!resolvedPrefix) {
          callback(null, []);
          return;
        }

        const modeName = ((session.getMode() as any)?.$id || "") as string;
        const categories = modeToCategories(modeName);
        if (!categories.length) {
          callback(null, []);
          return;
        }

        const lowerPrefix = resolvedPrefix.toLowerCase();
        const results = dedupeSnippets([...store.globalSnippets, ...store.projectSnippets])
          .filter((snippet) => categories.includes(snippet.category))
          .filter(
            (snippet) =>
              snippet.prefix.toLowerCase().startsWith(lowerPrefix) ||
              snippet.label.toLowerCase().includes(lowerPrefix) ||
              snippet.description.toLowerCase().includes(lowerPrefix)
          )
          .map((snippet) => ({
            caption: snippet.prefix,
            value: snippet.prefix,
            snippet: snippet.body,
            meta: `${snippet.source} snippet`,
            score: snippet.prefix.toLowerCase().startsWith(lowerPrefix) ? 960 : 920,
          }));

        callback(null, results);
      },
    } as Ace.Completer;
  }

  async createSnippet(input: {
    category: string;
    prefix: string;
    label: string;
    description: string;
    body: string;
    scope: SnippetScope;
  }) {
    await this.init();

    const snippet: SnippetEntry = {
      id: createSnippetId(),
      category: input.category,
      prefix: input.prefix.trim(),
      label: input.label.trim(),
      description: input.description.trim(),
      body: input.body,
      source: input.scope,
    };

    if (snippet.source === "global") {
      this.globalSnippets = [...this.globalSnippets, snippet];
      await this.writeGlobalSnippets(this.globalSnippets);
      return;
    }

    if (!this.projectPath) {
      throw new Error("Open a project before saving a project snippet.");
    }

    this.projectSnippets = [...this.projectSnippets, snippet];
    await this.writeProjectSnippets(this.projectSnippets);
  }

  private async readGlobalSnippets(): Promise<SnippetEntry[]> {
    try {
      const hasFile = await exists(GLOBAL_SNIPPETS_PATH, { baseDir: BaseDirectory.Home });
      if (!hasFile) return [];
      const raw = await readTextFile(GLOBAL_SNIPPETS_PATH, { baseDir: BaseDirectory.Home });
      return normalizeStoredSnippets(raw, "global");
    } catch {
      return [];
    }
  }

  private async readProjectSnippets(projectPath: string): Promise<SnippetEntry[]> {
    try {
      const raw = await invoke<string>("read_file", { path: `${projectPath}/${PROJECT_SNIPPETS_FILE}` });
      return normalizeStoredSnippets(raw, "project");
    } catch {
      return [];
    }
  }

  private async writeGlobalSnippets(snippets: SnippetEntry[]) {
    const payload: StoredSnippetFile = {
      snippets: snippets.map(({ source: _source, ...snippet }) => snippet),
    };
    await mkdir(".athva", { baseDir: BaseDirectory.Home, recursive: true });
    await writeTextFile(GLOBAL_SNIPPETS_PATH, JSON.stringify(payload, null, 2), { baseDir: BaseDirectory.Home });
  }

  private async writeProjectSnippets(snippets: SnippetEntry[]) {
    if (!this.projectPath) return;
    const payload: StoredSnippetFile = {
      snippets: snippets.map(({ source: _source, ...snippet }) => snippet),
    };
    await invoke("create_dir", { path: `${this.projectPath}/.athva` });
    await invoke("write_file", {
      path: `${this.projectPath}/${PROJECT_SNIPPETS_FILE}`,
      content: JSON.stringify(payload, null, 2),
    });
  }
}
