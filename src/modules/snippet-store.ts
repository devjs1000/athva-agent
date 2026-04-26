import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type * as monaco from "monaco-editor";
import { SNIPPET_CATEGORIES, type Snippet } from "./snippets-data";

export interface MonacoCompleter {
  languages: string[];
  provider: monaco.languages.CompletionItemProvider;
}

export type SnippetScope = "global" | "project";
export type SnippetSource = "builtin" | SnippetScope | `extension:${string}`;

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
let extensionSnippets: SnippetEntry[] = [];

function createSnippetId(): string {
  return `snippet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function langToCategories(langId: string): string[] {
  if (langId === "typescript") return ["typescript"];
  if (langId === "javascript") return ["javascript"];
  if (langId === "html") return ["html"];
  if (langId === "css" || langId === "scss") return ["css"];
  if (langId === "python") return ["python"];
  return [];
}

function getSnippetPrefixFromLine(lineUpTo: string): string {
  let start = lineUpTo.length;
  while (start > 0 && SNIPPET_PREFIX_RE.test(lineUpTo[start - 1])) start--;
  return lineUpTo.slice(start);
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
      [...this.projectSnippets, ...this.globalSnippets, ...extensionSnippets, ...this.builtIn].filter((snippet) => snippet.category === category)
    );
  }

  getCustomCompleter(): MonacoCompleter {
    const store = this;
    return {
      languages: ["typescript", "javascript", "html", "css", "python"],
      provider: {
        provideCompletionItems(
          model: monaco.editor.ITextModel,
          position: monaco.Position
        ): monaco.languages.CompletionList {
          const lineUpTo = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const resolvedPrefix = getSnippetPrefixFromLine(lineUpTo).trim();
          if (!resolvedPrefix) return { suggestions: [] };

          const categories = langToCategories(model.getLanguageId());
          if (!categories.length) return { suggestions: [] };

          const lowerPrefix = resolvedPrefix.toLowerCase();
          const wordInfo = model.getWordUntilPosition(position);
          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            startColumn: wordInfo.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          };

          const suggestions: monaco.languages.CompletionItem[] = dedupeSnippets([...store.globalSnippets, ...store.projectSnippets, ...extensionSnippets])
            .filter((snippet) => categories.includes(snippet.category))
            .filter(
              (snippet) =>
                snippet.prefix.toLowerCase().startsWith(lowerPrefix) ||
                snippet.label.toLowerCase().includes(lowerPrefix) ||
                snippet.description.toLowerCase().includes(lowerPrefix)
            )
            .map((snippet) => ({
              label: snippet.prefix,
              kind: 15 /* Snippet */ as monaco.languages.CompletionItemKind,
              insertText: snippet.body,
              insertTextRules: 4 /* InsertAsSnippet */ as monaco.languages.CompletionItemInsertTextRule,
              detail: `${snippet.source} snippet`,
              documentation: snippet.description || snippet.label,
              sortText: snippet.prefix.toLowerCase().startsWith(lowerPrefix) ? `0${snippet.prefix}` : `1${snippet.prefix}`,
              range,
            }));

          return { suggestions };
        },
      },
    };
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

export function setExtensionSnippets(snippets: SnippetEntry[]) {
  extensionSnippets = dedupeSnippets(snippets);
}
