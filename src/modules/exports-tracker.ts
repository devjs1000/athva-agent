// exports-tracker.ts
// Tracks project exports in .athva/exports.json and provides auto-import completions.
//
// exports.json schema:
// {
//   "exports": [
//     { "name": "MyFn", "file": "src/utils.ts", "rule": "*.ts" }
//   ]
// }
//
// "rule" is optional — set from a //.athva-exports-rule <glob> comment in the source file.

import { invoke } from "@tauri-apps/api/core";
import type { Ace } from "ace-builds";

interface ExportEntry {
  name: string;
  file: string;    // project-relative path (forward slashes)
  rule?: string;   // glob pattern — if set, only offer this import in matching files
}

interface ExportsJson {
  exports: ExportEntry[];
}

// ── Regex helpers ──────────────────────────────────────────────────────────────

// Captures named exports: export const/let/var/function/class/type/interface/enum <name>
const RE_NAMED = /^export\s+(?:default\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

// export { Foo, Bar as Baz }
const RE_BRACED = /^export\s*\{([^}]+)\}/gm;

// //.athva-exports-rule <glob>
const RE_RULE = /\/\/\s*\.athva-exports-rule\s+(\S+)/;

function extractExports(content: string): { names: string[]; rule?: string } {
  const names: Set<string> = new Set();

  let m: RegExpExecArray | null;

  RE_NAMED.lastIndex = 0;
  while ((m = RE_NAMED.exec(content)) !== null) {
    names.add(m[1]);
  }

  RE_BRACED.lastIndex = 0;
  while ((m = RE_BRACED.exec(content)) !== null) {
    // "Foo, Bar as Baz" → pick the local name (before "as")
    m[1].split(",").forEach((part) => {
      const local = part.trim().split(/\s+as\s+/)[0].trim();
      if (local) names.add(local);
    });
  }

  const ruleMatch = RE_RULE.exec(content);
  return { names: [...names], rule: ruleMatch?.[1] };
}

// ── Glob-like matcher (only * wildcard) ───────────────────────────────────────

function matchGlob(pattern: string, filePath: string): boolean {
  const filename = filePath.split("/").pop() ?? filePath;
  const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  return re.test(filename);
}

// ── Relative path resolver ─────────────────────────────────────────────────────

function relativePath(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split("/");
  fromParts.pop(); // remove filename → directory parts
  const toParts = toFile.split("/");

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }

  const ups = fromParts.length - common;
  const rel = [...Array(ups).fill(".."), ...toParts.slice(common)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Strip extension for import path
function stripExt(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

// ── Main class ─────────────────────────────────────────────────────────────────

export class ExportsTracker {
  private projectPath = "";
  private exports: ExportEntry[] = [];
  private dirty = false;

  async onProjectOpen(projectPath: string) {
    this.projectPath = projectPath;
    this.exports = [];
    try {
      const raw = await invoke<string>("read_file", {
        path: `${projectPath}/.athva/exports.json`,
      });
      const parsed: ExportsJson = JSON.parse(raw);
      this.exports = parsed.exports ?? [];
    } catch {
      // File doesn't exist yet — that's fine
    }
  }

  async onFileSave(absolutePath: string, content: string) {
    if (!this.projectPath) return;
    if (!absolutePath.startsWith(this.projectPath)) return;

    // Only track TS/JS source files
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(absolutePath)) return;

    const relFile = absolutePath.slice(this.projectPath.length + 1);
    const { names, rule } = extractExports(content);

    // Remove old entries for this file
    const before = this.exports.filter((e) => e.file !== relFile);

    // Add new entries
    const newEntries: ExportEntry[] = names.map((name) => ({
      name,
      file: relFile,
      ...(rule ? { rule } : {}),
    }));

    this.exports = [...before, ...newEntries];
    this.dirty = true;
    await this.persist();
  }

  async onFileRenamed(oldAbsPath: string, newAbsPath: string) {
    if (!this.projectPath) return;
    const oldRel = oldAbsPath.startsWith(this.projectPath)
      ? oldAbsPath.slice(this.projectPath.length + 1)
      : oldAbsPath;
    const newRel = newAbsPath.startsWith(this.projectPath)
      ? newAbsPath.slice(this.projectPath.length + 1)
      : newAbsPath;

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
    if (!this.projectPath || !this.dirty) return;
    this.dirty = false;
    const json: ExportsJson = { exports: this.exports };
    try {
      // Ensure .athva dir exists (write_file will fail otherwise on first save)
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
    return {
      getCompletions: (
        editor: Ace.Editor,
        _session: Ace.EditSession,
        _pos: Ace.Point,
        prefix: string,
        callback: Ace.CompleterCallback
      ) => {
        if (!prefix || prefix.length < 1) {
          callback(null, []);
          return;
        }

        const currentAbsPath: string =
          (editor as any).__athvaFilePath ?? "";
        const currentRelPath = currentAbsPath.startsWith(this.projectPath)
          ? currentAbsPath.slice(this.projectPath.length + 1)
          : "";

        const lp = prefix.toLowerCase();
        const results: Ace.ValueCompletion[] = [];

        for (const entry of this.exports) {
          // Filter by rule if present
          if (entry.rule && currentRelPath && !matchGlob(entry.rule, currentRelPath)) continue;

          if (!entry.name.toLowerCase().startsWith(lp)) continue;

          const importPath = currentRelPath
            ? stripExt(relativePath(currentRelPath, entry.file))
            : `./${stripExt(entry.file)}`;

          results.push({
            caption: entry.name,
            value: entry.name,
            meta: "auto-import",
            snippet: `import { ${entry.name} } from "${importPath}";`,
            score: 900,
          } as any);
        }

        callback(null, results);
      },
    };
  }
}
