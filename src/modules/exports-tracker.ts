// exports-tracker.ts
// Tracks project exports in .athva/exports.json and provides auto-import completions.
//
// exports.json schema:
// { "exports": [ { "name": "MyFn", "file": "src/utils.ts", "rule": "*.ts" } ] }
//
// "rule" is optional — from a //.athva-exports-rule <glob> comment in the source file.

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

// ── Relative path resolver ────────────────────────────────────────────────────

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

// ── Dirs to skip during project scan ─────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".athva", "dist", "build", ".next", "out"]);

// ── Main class ────────────────────────────────────────────────────────────────

export class ExportsTracker {
  private projectPath = "";
  private exports: ExportEntry[] = [];

  async onProjectOpen(projectPath: string) {
    this.projectPath = projectPath;
    this.exports = [];

    // Try to load cached exports.json first
    let loaded = false;
    try {
      const raw = await invoke<string>("read_file", {
        path: `${projectPath}/.athva/exports.json`,
      });
      const parsed: ExportsJson = JSON.parse(raw);
      this.exports = parsed.exports ?? [];
      loaded = true;
    } catch {
      // No cached file — will scan below
    }

    // If no cache, do a full project scan in the background
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
        const dirName = entry.name;
        if (SKIP_DIRS.has(dirName) || dirName.startsWith(".")) continue;
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

    // Replace entries for this file
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

  getCompleter(): Ace.Completer {
    const tracker = this;

    return {
      getCompletions(
        editor: Ace.Editor,
        _session: Ace.EditSession,
        _pos: Ace.Point,
        prefix: string,
        callback: Ace.CompleterCallback
      ) {
        if (!prefix || prefix.length < 1) {
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
            meta: `import · ${importPath}`,
            score: 900,
            // Store import info for insertMatch
            _importName: entry.name,
            _importPath: importPath,
          });
        }

        callback(null, results);
      },

      // Custom insert: write the symbol name at cursor AND prepend the import line
      insertMatch(editor: Ace.Editor, data: any) {
        // Insert the symbol name (replace prefix)
        if ((editor as any).completer) {
          (editor as any).completer.insertMatch({ value: data.value });
        }

        if (!data._importName || !data._importPath) return;

        const importLine = `import { ${data._importName} } from "${data._importPath}";\n`;
        const session = editor.getSession();
        const docValue: string = session.getValue();

        // Don't duplicate if already imported
        if (docValue.includes(importLine.trim())) return;

        // Find the right row to insert: after the last existing import block
        const lines: string[] = docValue.split("\n");
        let lastImportRow = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^import\s/.test(lines[i].trim())) lastImportRow = i;
        }

        const insertRow = lastImportRow + 1; // 0 if no imports exist
        session.insert({ row: insertRow, column: 0 }, importLine);
      },
    };
  }
}
