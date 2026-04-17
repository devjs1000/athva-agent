// exports-tracker.ts
// Tracks project exports in .athva/exports.json and provides auto-import completions.
// Also provides import-path and package completions for import/require strings.

import { invoke } from "@tauri-apps/api/core";
import type { Ace } from "ace-builds";

type ExportKind = "named" | "default";
type ModuleKind = "esm" | "cjs";
type ImportStyle = "import" | "require";

interface ExportEntry {
  name: string;
  file: string; // project-relative path or package name (for isPackage entries)
  kind: ExportKind;
  module: ModuleKind;
  rule?: string; // glob pattern — if set, only offer in matching files
  isPackage?: boolean; // true for entries sourced from node_modules
}

interface ExportsJson {
  exports: ExportEntry[];
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const RE_ESM_NAMED_DECL =
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const RE_ESM_DEFAULT_DECL =
  /^\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const RE_ESM_DEFAULT_REF = /^\s*export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?/gm;
const RE_ESM_BRACED = /^\s*export\s*\{([^}]+)\}/gm;
const RE_CJS_DEFAULT = /(?:^|\n)\s*module\.exports\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?/g;
const RE_CJS_EXPORTS_PROP = /(?:^|\n)\s*(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
const RE_CJS_OBJECT = /(?:^|\n)\s*module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?/g;
const RE_RULE = /\/\/\s*\.athva-exports-rule\s+(\S+)/;

function uniqueByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function getFileBaseName(filePath: string): string {
  const base = filePath.split("/").pop() || filePath;
  return stripExt(base).replace(/[^A-Za-z0-9_$]+/g, "_") || "DefaultExport";
}

function normalizeLegacyEntry(entry: Partial<ExportEntry>): ExportEntry | null {
  if (!entry.name || !entry.file) return null;
  return {
    name: entry.name,
    file: entry.file,
    kind: entry.kind === "default" ? "default" : "named",
    module: entry.module === "cjs" ? "cjs" : "esm",
    ...(entry.rule ? { rule: entry.rule } : {}),
  };
}

function parseBracedExport(
  raw: string,
  filePath: string,
  add: (entry: ExportEntry) => void
) {
  raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const match = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
      if (!match) return;
      const localName = match[1];
      const exportedName = match[2] || localName;
      if (exportedName === "default") {
        add({ name: localName || getFileBaseName(filePath), file: filePath, kind: "default", module: "esm" });
      } else {
        add({ name: exportedName, file: filePath, kind: "named", module: "esm" });
      }
    });
}

function parseCommonJsObject(
  raw: string,
  filePath: string,
  add: (entry: ExportEntry) => void
) {
  raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const cleaned = part.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/g, "").trim();
      if (!cleaned) return;
      const shorthand = cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (shorthand) {
        add({ name: shorthand[1], file: filePath, kind: "named", module: "cjs" });
        return;
      }
      const pair = cleaned.match(/^(?:["']?([A-Za-z_$][A-Za-z0-9_$]*)["']?)\s*:/);
      if (pair) {
        add({ name: pair[1], file: filePath, kind: "named", module: "cjs" });
      }
    });
}

function extractExports(content: string, filePath: string): { entries: ExportEntry[]; rule?: string } {
  const entries: ExportEntry[] = [];
  const add = (entry: ExportEntry) => entries.push(entry);
  let match: RegExpExecArray | null;

  RE_ESM_NAMED_DECL.lastIndex = 0;
  while ((match = RE_ESM_NAMED_DECL.exec(content)) !== null) {
    add({ name: match[1], file: filePath, kind: "named", module: "esm" });
  }

  RE_ESM_DEFAULT_DECL.lastIndex = 0;
  while ((match = RE_ESM_DEFAULT_DECL.exec(content)) !== null) {
    add({ name: match[1], file: filePath, kind: "default", module: "esm" });
  }

  RE_ESM_DEFAULT_REF.lastIndex = 0;
  while ((match = RE_ESM_DEFAULT_REF.exec(content)) !== null) {
    add({ name: match[1], file: filePath, kind: "default", module: "esm" });
  }

  RE_ESM_BRACED.lastIndex = 0;
  while ((match = RE_ESM_BRACED.exec(content)) !== null) {
    parseBracedExport(match[1], filePath, add);
  }

  RE_CJS_DEFAULT.lastIndex = 0;
  while ((match = RE_CJS_DEFAULT.exec(content)) !== null) {
    add({ name: match[1], file: filePath, kind: "default", module: "cjs" });
  }

  RE_CJS_EXPORTS_PROP.lastIndex = 0;
  while ((match = RE_CJS_EXPORTS_PROP.exec(content)) !== null) {
    add({ name: match[1], file: filePath, kind: "named", module: "cjs" });
  }

  RE_CJS_OBJECT.lastIndex = 0;
  while ((match = RE_CJS_OBJECT.exec(content)) !== null) {
    parseCommonJsObject(match[1], filePath, add);
  }

  const ruleMatch = RE_RULE.exec(content);
  const defaultName = getFileBaseName(filePath);
  if (!entries.some((entry) => entry.kind === "default") && /^\s*export\s+default\b/m.test(content)) {
    add({ name: defaultName, file: filePath, kind: "default", module: "esm" });
  }
  if (!entries.some((entry) => entry.kind === "default") && /^\s*module\.exports\s*=/m.test(content)) {
    add({ name: defaultName, file: filePath, kind: "default", module: "cjs" });
  }

  return {
    entries: uniqueByKey(entries, (entry) => `${entry.file}:${entry.module}:${entry.kind}:${entry.name}`),
    rule: ruleMatch?.[1],
  };
}

function matchGlob(pattern: string, filePath: string): boolean {
  const filename = filePath.split("/").pop() ?? filePath;
  const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  return re.test(filename);
}

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

function stripExt(path: string): string {
  return path.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectImportStyle(lines: string[], currentFilePath = ""): ImportStyle {
  if (currentFilePath.endsWith(".cjs")) return "require";
  if (lines.some((line) => /^\s*import\b/.test(line))) return "import";
  if (lines.some((line) => /\brequire\s*\(/.test(line) || /\bmodule\.exports\b/.test(line) || /\bexports\./.test(line))) {
    return "require";
  }
  return "import";
}

function findInsertRow(lines: string[], style: ImportStyle): number {
  let row = 0;
  while (row < lines.length && /^\s*['"]use\s+\w+['"];\s*$/.test(lines[row])) row++;

  let lastImportLike = row - 1;
  for (let i = row; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*import\b/.test(line)) {
      lastImportLike = i;
      continue;
    }
    if (style === "require" && /^\s*(?:const|let|var)\s+.+?=\s*require\(/.test(line)) {
      lastImportLike = i;
      continue;
    }
    if (/^\s*$/.test(line)) continue;
    break;
  }

  return lastImportLike + 1;
}

function addNamedToImportClause(existing: string, importName: string): string {
  const parts = existing
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(importName)) parts.push(importName);
  return parts.sort((a, b) => a.localeCompare(b)).join(", ");
}

function replaceSessionLine(session: Ace.EditSession, row: number, nextLine: string) {
  const currentLine = session.getLine(row);
  session.replace(
    { start: { row, column: 0 }, end: { row, column: currentLine.length } } as any,
    nextLine
  );
}

function ensureImportInserted(
  session: Ace.EditSession,
  importPath: string,
  importName: string,
  kind: ExportKind,
  style: ImportStyle
) {
  const lines = session.getValue().split("\n");
  if (style === "import") {
    if (kind === "named") {
      const namedImportRe = new RegExp(`^\\s*import\\s+([^\\n]+?)\\s+from\\s+["']${escapeRegExp(importPath)}["'];?\\s*$`);
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(namedImportRe);
        if (!match) continue;
        const clause = match[1];
        if (clause.includes(`{`) && clause.includes(`}`)) {
          const namedMatch = clause.match(/^(.*?)(\{([^}]*)\})(.*)$/);
          if (!namedMatch) break;
          const namedList = addNamedToImportClause(namedMatch[3], importName);
          replaceSessionLine(
            session,
            i,
            `import ${namedMatch[1]}{ ${namedList} }${namedMatch[4]} from "${importPath}";`
              .replace(/\s+,/g, ",")
              .replace(/,\s+\}/g, " }")
          );
          return;
        }
      }

      const stmt = `import { ${importName} } from "${importPath}";`;
      if (lines.some((line) => line.trim() === stmt)) return;
      const row = findInsertRow(lines, style);
      session.insert({ row, column: 0 }, stmt + "\n");
      return;
    }

    const defaultImportRe = new RegExp(`^\\s*import\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?:,\\s*\\{[^}]*\\})?\\s+from\\s+["']${escapeRegExp(importPath)}["'];?\\s*$`);
    if (lines.some((line) => defaultImportRe.test(line))) return;

    const namedOnlyRe = new RegExp(`^\\s*import\\s+\\{([^}]*)\\}\\s+from\\s+["']${escapeRegExp(importPath)}["'];?\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(namedOnlyRe);
      if (!match) continue;
      replaceSessionLine(session, i, `import ${importName}, { ${match[1].trim()} } from "${importPath}";`);
      return;
    }

    const stmt = `import ${importName} from "${importPath}";`;
    const row = findInsertRow(lines, style);
    session.insert({ row, column: 0 }, stmt + "\n");
    return;
  }

  if (kind === "named") {
    const namedRequireRe = new RegExp(`^\\s*(const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*require\\(["']${escapeRegExp(importPath)}["']\\);?\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(namedRequireRe);
      if (!match) continue;
      const updated = addNamedToImportClause(match[2], importName);
      replaceSessionLine(session, i, `${match[1]} { ${updated} } = require("${importPath}");`);
      return;
    }

    const stmt = `const { ${importName} } = require("${importPath}");`;
    if (lines.some((line) => line.trim() === stmt)) return;
    const row = findInsertRow(lines, style);
    session.insert({ row, column: 0 }, stmt + "\n");
    return;
  }

  const defaultRequireRe = new RegExp(`^\\s*(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*require\\(["']${escapeRegExp(importPath)}["']\\);?\\s*$`);
  if (lines.some((line) => defaultRequireRe.test(line))) return;
  const stmt = `const ${importName} = require("${importPath}");`;
  const row = findInsertRow(lines, style);
  session.insert({ row, column: 0 }, stmt + "\n");
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".athva", "dist", "build", ".next", "out", ".svelte-kit",
]);

export class ExportsTracker {
  private projectPath = "";
  private exports: ExportEntry[] = [];
  private packageExports: ExportEntry[] = [];
  private packageNames: string[] = [];

  async onProjectOpen(projectPath: string) {
    this.projectPath = projectPath;
    this.exports = [];
    this.packageExports = [];
    await this.loadPackageNames();

    let loaded = false;
    try {
      const raw = await invoke<string>("read_file", {
        path: `${projectPath}/.athva/exports.json`,
      });
      const parsed: ExportsJson = JSON.parse(raw);
      this.exports = (parsed.exports ?? [])
        .map((entry) => normalizeLegacyEntry(entry))
        .filter((entry): entry is ExportEntry => !!entry);
      loaded = true;
    } catch {
      // No cache yet
    }

    if (!loaded) {
      void this.scanProject(projectPath).then(() => this.persist());
    }

    void this.scanPackageExports();
  }

  private async scanPackageExports(): Promise<void> {
    if (!this.projectPath || this.packageNames.length === 0) return;

    const results = await Promise.all(
      this.packageNames.map(async (pkgName): Promise<ExportEntry[]> => {
        const nmBase = `${this.projectPath}/node_modules/${pkgName}`;
        let typesFile: string | null = null;

        try {
          const raw = await invoke<string>("read_file", { path: `${nmBase}/package.json` });
          const pkg = JSON.parse(raw) as {
            types?: string; typings?: string;
            exports?: Record<string, { types?: string; typings?: string } | string>;
          };
          typesFile = pkg.types ?? pkg.typings ?? null;
          if (!typesFile && pkg.exports) {
            const main = pkg.exports["."];
            if (main && typeof main === "object") typesFile = main.types ?? main.typings ?? null;
          }
        } catch { return []; }

        const candidates = [
          typesFile ? `${nmBase}/${typesFile}` : null,
          `${nmBase}/index.d.ts`,
          `${nmBase}/index.js`,
        ].filter(Boolean) as string[];

        for (const candidate of candidates) {
          try {
            const content = await invoke<string>("read_file", { path: candidate });
            const { entries } = extractExports(content, pkgName);
            return entries.map((e) => ({ ...e, file: pkgName, isPackage: true }));
          } catch { /* try next */ }
        }
        return [];
      })
    );

    this.packageExports = uniqueByKey(
      results.flat(),
      (e) => `${e.file}:${e.name}:${e.kind}`
    );
  }

  private async loadPackageNames() {
    if (!this.projectPath) return;
    try {
      const raw = await invoke<string>("read_file", { path: `${this.projectPath}/package.json` });
      const parsed: PackageJson = JSON.parse(raw);
      const names = new Set<string>();
      [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies, parsed.optionalDependencies]
        .filter(Boolean)
        .forEach((group) => Object.keys(group!).forEach((name) => names.add(name)));
      this.packageNames = [...names].sort((a, b) => a.localeCompare(b));
    } catch {
      this.packageNames = [];
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
          const { entries: foundEntries, rule } = extractExports(content, relFile);
          foundEntries.forEach((exportEntry) => {
            this.exports.push({ ...exportEntry, ...(rule ? { rule } : {}) });
          });
        } catch {
          // skip unreadable files
        }
      }
    }

    this.exports = uniqueByKey(this.exports, (entry) => `${entry.file}:${entry.module}:${entry.kind}:${entry.name}`);
  }

  async onFileSave(absolutePath: string, content: string) {
    if (!this.projectPath) return;
    if (absolutePath === `${this.projectPath}/package.json`) {
      await this.loadPackageNames();
      void this.scanPackageExports();
      return;
    }
    if (!absolutePath.startsWith(this.projectPath)) return;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(absolutePath)) return;

    const relFile = absolutePath.slice(this.projectPath.length + 1);
    const { entries, rule } = extractExports(content, relFile);

    const before = this.exports.filter((entry) => entry.file !== relFile);
    const next = entries.map((entry) => ({
      ...entry,
      ...(rule ? { rule } : {}),
    }));
    this.exports = uniqueByKey([...before, ...next], (entry) => `${entry.file}:${entry.module}:${entry.kind}:${entry.name}`);
    await this.persist();
  }

  async onFileRenamed(oldAbsPath: string, newAbsPath: string) {
    if (!this.projectPath) return;
    const toRel = (abs: string) =>
      abs.startsWith(this.projectPath) ? abs.slice(this.projectPath.length + 1) : abs;

    const oldRel = toRel(oldAbsPath);
    const newRel = toRel(newAbsPath);

    let changed = false;
    this.exports = this.exports.map((entry) => {
      if (entry.file === oldRel) {
        changed = true;
        return { ...entry, file: newRel };
      }
      return entry;
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
    } catch (error) {
      console.warn("exports-tracker: failed to persist", error);
    }
  }

  getCompleter(): Ace.Completer {
    const tracker = this;
    const completer: Ace.Completer = {
      identifierRegexps: [/[a-zA-Z_$0-9]/],

      getCompletions(
        editor: Ace.Editor,
        session: Ace.EditSession,
        pos: Ace.Point,
        prefix: string,
        callback: Ace.CompleterCallback
      ) {
        if (!prefix || prefix.length < 1) { callback(null, []); return; }

        const lineUpTo = session.getLine(pos.row).slice(0, pos.column);
        if (/(?:from|import|require\s*\()\s*['"][^'"]*$/.test(lineUpTo)) {
          callback(null, []);
          return;
        }

        const currentAbsPath: string = (editor as any).__athvaFilePath ?? "";
        const currentRelPath = currentAbsPath.startsWith(tracker.projectPath)
          ? currentAbsPath.slice(tracker.projectPath.length + 1)
          : "";
        const lowerPrefix = prefix.toLowerCase();

        const allEntries = [
          ...tracker.exports.filter((e) => !e.rule || !currentRelPath || matchGlob(e.rule, currentRelPath)),
          ...tracker.packageExports,
        ];

        const results = allEntries
          .filter((entry) => entry.name.toLowerCase().startsWith(lowerPrefix))
          .map((entry) => {
            const importPath = entry.isPackage
              ? entry.file
              : currentRelPath
                ? stripExt(relativePath(currentRelPath, entry.file))
                : `./${stripExt(entry.file)}`;
            return {
              caption: entry.name,
              value: entry.name,
              meta: `${entry.kind === "default" ? "default" : "named"} · ${importPath}`,
              score: entry.kind === "default" ? 925 : 900,
              completer,
              _exportEntry: entry,
              _importPath: importPath,
            };
          });

        callback(null, results);
      },

      insertMatch(editor: Ace.Editor, data: any) {
        const session = editor.getSession();
        const pos = editor.getCursorPosition();
        const line = session.getLine(pos.row);

        let startCol = pos.column;
        while (startCol > 0 && /[\w$]/.test(line[startCol - 1])) startCol--;

        session.replace(
          { start: { row: pos.row, column: startCol }, end: { row: pos.row, column: pos.column } } as any,
          data.value ?? ""
        );

        const entry = data._exportEntry as ExportEntry | undefined;
        const importPath = data._importPath as string | undefined;
        if (!entry || !importPath) return;

        const currentFilePath = ((editor as any).__athvaFilePath ?? "") as string;
        const importStyle = detectImportStyle(session.getValue().split("\n"), currentFilePath);
        ensureImportInserted(session, importPath, data.value ?? entry.name, entry.kind, importStyle);
      },
    };

    return completer;
  }

  getPathCompleter(): Ace.Completer {
    const tracker = this;
    const completer: Ace.Completer = {
      identifierRegexps: [/[a-zA-Z_$0-9./\\@\-]/],

      getCompletions(
        editor: Ace.Editor,
        session: Ace.EditSession,
        pos: Ace.Point,
        _prefix: string,
        callback: Ace.CompleterCallback
      ) {
        const lineUpTo = session.getLine(pos.row).slice(0, pos.column);
        const match = lineUpTo.match(/(?:from|import|require\s*\()\s*['"]([^'"]*)/);
        if (!match) { callback(null, []); return; }

        const partialPath = match[1];
        if (partialPath.startsWith(".")) {
          const currentAbsPath: string = (editor as any).__athvaFilePath ?? "";
          if (!currentAbsPath) { callback(null, []); return; }

          const currentDir = currentAbsPath.slice(0, currentAbsPath.lastIndexOf("/"));
          const lastSlash = partialPath.lastIndexOf("/");
          const dirPart = lastSlash >= 0 ? partialPath.slice(0, lastSlash) : ".";
          const filePrefix = lastSlash >= 0 ? partialPath.slice(lastSlash + 1) : partialPath;
          const absDir = resolveDir(currentDir, dirPart);
          const displayBase = dirPart === "." ? "./" : `${dirPart}/`;

          invoke<FileEntry[]>("read_dir", { path: absDir })
            .then((entries) => {
              const lowerPrefix = filePrefix.toLowerCase();
              const results = entries
                .filter((entry) => lowerPrefix === "" || entry.name.toLowerCase().startsWith(lowerPrefix))
                .map((entry) => {
                  const targetName = entry.is_dir ? `${entry.name}/` : stripExt(entry.name);
                  const fullPath = `${displayBase}${targetName}`;
                  return {
                    caption: fullPath,
                    value: fullPath,
                    meta: entry.is_dir ? "dir" : "file",
                    score: entry.is_dir ? 875 : 850,
                    completer,
                  };
                });
              callback(null, results);
            })
            .catch(() => callback(null, []));
          return;
        }

        const lowerPrefix = partialPath.toLowerCase();
        const packageResults = tracker.packageNames
          .filter((packageName) => !partialPath || packageName.toLowerCase().startsWith(lowerPrefix))
          .map((packageName) => ({
            caption: packageName,
            value: packageName,
            meta: "package",
            score: 800,
            completer,
          }));
        callback(null, packageResults);
      },

      insertMatch(editor: Ace.Editor, data: any) {
        const session = editor.getSession();
        const pos = editor.getCursorPosition();
        const line = session.getLine(pos.row);
        const lineUpTo = line.slice(0, pos.column);
        const match = lineUpTo.match(/(?:from|import|require\s*\()\s*['"]([^'"]*)$/);
        if (!match) return;

        const partialPath = match[1];
        const replaceStart = pos.column - partialPath.length;
        session.replace(
          { start: { row: pos.row, column: replaceStart }, end: { row: pos.row, column: pos.column } } as any,
          data.value ?? ""
        );
      },
    };

    return completer;
  }
}
