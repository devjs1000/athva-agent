// exports-tracker.ts
// Tracks project exports in .athva/exports.json and provides auto-import completions.
// Also provides import-path completions for relative paths in import statements.

import { invoke } from "@tauri-apps/api/core";
import type { Ace } from "ace-builds";

interface ExportEntry {
  name: string;
  file: string;    // project-relative path (forward slashes)
  rule?: string;   // glob pattern — if set, only offer in matching files
}

interface ExportsJson {
  exports: ExportEntry[];
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

// ── Regex helpers ──────────────────────────────────────────────────────────────

const RE_NAMED =
  /^export\s+(?:default\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

const RE_BRACED = /^export\s*\{([^}]+)\}/gm;

const RE_RULE = /\/\/\s*\.athva-exports-rule\s+(\S+)/;

function extractExports(content: string): { names: string[]; rule?: string } {
  const names: Set<string> = new Set();

  RE_NAMED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_NAMED.exec(content)) !== null) {
    names.add(m[1]);
  }

  RE_BRACED.lastIndex = 0;
  while ((m = RE_BRACED.exec(content)) !== null) {
    m[1].split(",").forEach((part) => {
      const local = part.trim().split(/\s+as\s+/)[0].trim();
      if (local) names.add(local);
    });
  }

  const ruleMatch = RE_RULE.exec(content);
  return { names: [...names], rule: ruleMatch?.[1] };
}

// ── Glob matcher (only * wildcard) ────────────────────────────────────────────

function matchGlob(pattern: string, filePath: string): boolean {
  const filename = filePath.split("/").pop() ?? filePath;
  const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  return re.test(filename);
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function relativePath(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split("/");
  fromParts.pop();
  const toParts = toFile.split("/");

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const rel = [...Array(ups).fill(".."), ...toParts.slice(common)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function stripExt(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function resolveDir(currentDir: string, partialPath: string): string {
  const parts = currentDir.split("/");
  const segments = partialPath.split("/");
  for (const seg of segments) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

// ── Dirs to skip during project scan ─────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".athva", "dist", "build", ".next", "out", ".svelte-kit",
]);

// ── Main class ────────────────────────────────────────────────────────────────

export class ExportsTracker {
  private projectPath = "";
  private exports: ExportEntry[] = [];

  async onProjectOpen(projectPath: string) {
    this.projectPath = projectPath;
    this.exports = [];

    let loaded = false;
    try {
      const raw = await invoke<string>("read_file", {
        path: `${projectPath}/.athva/exports.json`,
      });
      const parsed: ExportsJson = JSON.parse(raw);
      this.exports = parsed.exports ?? [];
      loaded = true;
    } catch {
      // No cache yet
    }

    if (!loaded) {
      void this.scanProject(projectPath).then(() => this.persist());
    }
  }

  private async scanProject(rootPath: string): Promise<void> {
    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("read_dir", { path: rootPath });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.is_dir) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await this.scanProject(entry.path);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        try {
          const content = await invoke<string>("read_file", { path: entry.path });
          const relFile = entry.path.slice(this.projectPath.length + 1);
          const { names, rule } = extractExports(content);
          names.forEach((name) => {
            this.exports.push({ name, file: relFile, ...(rule ? { rule } : {}) });
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  async onFileSave(absolutePath: string, content: string) {
    if (!this.projectPath) return;
    if (!absolutePath.startsWith(this.projectPath)) return;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(absolutePath)) return;

    const relFile = absolutePath.slice(this.projectPath.length + 1);
    const { names, rule } = extractExports(content);

    const before = this.exports.filter((e) => e.file !== relFile);
    const newEntries: ExportEntry[] = names.map((name) => ({
      name,
      file: relFile,
      ...(rule ? { rule } : {}),
    }));
    this.exports = [...before, ...newEntries];
    await this.persist();
  }

  async onFileRenamed(oldAbsPath: string, newAbsPath: string) {
    if (!this.projectPath) return;
    const toRel = (abs: string) =>
      abs.startsWith(this.projectPath) ? abs.slice(this.projectPath.length + 1) : abs;

    const oldRel = toRel(oldAbsPath);
    const newRel = toRel(newAbsPath);

    let changed = false;
    this.exports = this.exports.map((e) => {
      if (e.file === oldRel) {
        changed = true;
        return { ...e, file: newRel };
      }
      return e;
    });

    if (changed) await this.persist();
  }

  private async persist() {
    if (!this.projectPath) return;
    const json: ExportsJson = { exports: this.exports };
    try {
      await invoke("create_dir", { path: `${this.projectPath}/.athva` }).catch(() => {});
      await invoke("write_file", {
        path: `${this.projectPath}/.athva/exports.json`,
        content: JSON.stringify(json, null, 2),
      });
    } catch (e) {
      console.warn("exports-tracker: failed to persist", e);
    }
  }

  // ── Completer 1: named-export auto-import ─────────────────────────────────

  getCompleter(): Ace.Completer {
    const tracker = this;

    return {
      // Tell Ace to include these chars in the "prefix" word
      identifierRegexps: [/[a-zA-Z_$0-9]/],

      getCompletions(
        editor: Ace.Editor,
        session: Ace.EditSession,
        pos: Ace.Point,
        prefix: string,
        callback: Ace.CompleterCallback
      ) {
        if (!prefix || prefix.length < 1) { callback(null, []); return; }

        // Don't fire inside an import string — path completer handles that
        const lineUpTo = session.getLine(pos.row).slice(0, pos.column);
        if (/(?:from|import)\s*['"][^'"]*$/.test(lineUpTo)) {
          callback(null, []);
          return;
        }

        const currentAbsPath: string = (editor as any).__athvaFilePath ?? "";
        const currentRelPath = currentAbsPath.startsWith(tracker.projectPath)
          ? currentAbsPath.slice(tracker.projectPath.length + 1)
          : "";

        const lp = prefix.toLowerCase();
        const results: any[] = [];

        for (const entry of tracker.exports) {
          if (entry.rule && currentRelPath && !matchGlob(entry.rule, currentRelPath)) continue;
          if (!entry.name.toLowerCase().startsWith(lp)) continue;

          const importPath = currentRelPath
            ? stripExt(relativePath(currentRelPath, entry.file))
            : `./${stripExt(entry.file)}`;

          results.push({
            caption: entry.name,
            value: entry.name,
            meta: `↑ ${importPath}`,
            score: 900,
            _importName: entry.name,
            _importPath: importPath,
          });
        }

        callback(null, results);
      },

      insertMatch(editor: Ace.Editor, data: any) {
        const session = editor.getSession();
        const pos = editor.getCursorPosition();
        const line = session.getLine(pos.row);

        // Walk back to find where the typed prefix starts
        let startCol = pos.column;
        while (startCol > 0 && /[\w$]/.test(line[startCol - 1])) startCol--;

        // Replace the prefix with just the symbol name — plain object works (Ace duck-types ranges)
        session.replace(
          { start: { row: pos.row, column: startCol }, end: { row: pos.row, column: pos.column } } as any,
          data.value ?? ""
        );

        if (!data._importName || !data._importPath) return;

        const stmt = `import { ${data._importName} } from "${data._importPath}";`;
        const docLines = session.getValue().split("\n");

        if (docLines.some((l) => l.includes(stmt))) return;

        let lastImportRow = -1;
        for (let i = 0; i < docLines.length; i++) {
          if (/^import[\s{*"']/.test(docLines[i])) lastImportRow = i;
        }

        session.insert({ row: lastImportRow + 1, column: 0 }, stmt + "\n");
      },
    };
  }

  // ── Completer 2: import path file suggestions ─────────────────────────────

  getPathCompleter(): Ace.Completer {
    return {
      // Include path chars so Ace sends "." and "/" as part of prefix
      identifierRegexps: [/[a-zA-Z_$0-9./\\@\-]/],

      getCompletions(
        editor: Ace.Editor,
        session: Ace.EditSession,
        pos: Ace.Point,
        _prefix: string,
        callback: Ace.CompleterCallback
      ) {
        const lineUpTo = session.getLine(pos.row).slice(0, pos.column);

        const m = lineUpTo.match(/(?:from|import|require\s*\()\s*['"]([^'"]*)/);
        if (!m) { callback(null, []); return; }

        const partialPath = m[1];
        if (!partialPath.startsWith(".")) { callback(null, []); return; }

        const currentAbsPath: string = (editor as any).__athvaFilePath ?? "";
        if (!currentAbsPath) { callback(null, []); return; }

        const currentDir = currentAbsPath.slice(0, currentAbsPath.lastIndexOf("/"));
        const lastSlash = partialPath.lastIndexOf("/");

        const dirPart  = lastSlash >= 0 ? partialPath.slice(0, lastSlash) : ".";
        const filePrefix = lastSlash >= 0 ? partialPath.slice(lastSlash + 1) : "";

        const absDir = resolveDir(currentDir, dirPart);

        invoke<FileEntry[]>("read_dir", { path: absDir })
          .then((entries) => {
            const fp = filePrefix.toLowerCase();
            const results: any[] = entries
              .filter((e) => fp === "" || e.name.toLowerCase().startsWith(fp))
              .map((e) => ({
                caption: e.name,
                value: e.is_dir ? e.name : stripExt(e.name),
                meta: e.is_dir ? "dir" : "file",
                score: 850,
              }));
            callback(null, results);
          })
          .catch(() => callback(null, []));
      },

      // Replace only the part after the last "/" with the selected name
      insertMatch(editor: Ace.Editor, data: any) {
        const session = editor.getSession();
        const pos = editor.getCursorPosition();
        const line = session.getLine(pos.row);
        const lineUpTo = line.slice(0, pos.column);

        // Find the last "/" inside the current import string
        const quoteMatch = lineUpTo.match(/(?:from|import|require\s*\()\s*['"](.*)/);
        if (!quoteMatch) return;
        const partialPath = quoteMatch[1];
        const lastSlash = partialPath.lastIndexOf("/");
        const replaceStart = pos.column - (partialPath.length - lastSlash - 1);

        session.replace(
          { start: { row: pos.row, column: replaceStart }, end: { row: pos.row, column: pos.column } } as any,
          data.value ?? ""
        );
      },
    };
  }
}
