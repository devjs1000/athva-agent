// exports-tracker.ts
// Tracks project exports in .athva/exports.json and provides auto-import completions.
// Also provides import-path and package completions for import/require strings.

import { invoke } from "@tauri-apps/api/core";
import type * as monaco from "monaco-editor";
import ts from "typescript";

export interface MonacoCompleter {
  languages: string[];
  provider: monaco.languages.CompletionItemProvider;
}

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

export interface DefinitionTarget {
  path: string;
  line: number;
  column: number;
}

export interface HoverInfo {
  signature: string;
  documentation?: string;
  definition?: DefinitionTarget;
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
const SOURCE_FILE_RE = /\.(?:d\.ts|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const MODULE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"];

const TS_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: true,
  esModuleInterop: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
  noLib: true,
};

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

  // TypeScript declaration file pattern: export = X + declare namespace X { members }
  // Used by many @types/* packages (e.g. older styles, lodash, etc.)
  const exportEqM = /^\s*export\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?/m.exec(content);
  if (exportEqM) {
    const nsName = exportEqM[1];
    const escNs = nsName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nsStartRe = new RegExp(`declare\\s+(?:global\\s+)?namespace\\s+${escNs}\\s*\\{`);
    const nsM = nsStartRe.exec(content);
    if (nsM) {
      let ni = content.indexOf("{", nsM.index + nsM[0].length - 1);
      let ndepth = 0;
      let nsBodyStart = ni + 1;
      let nsBody = "";
      for (; ni < content.length; ni++) {
        if (content[ni] === "{") ndepth++;
        else if (content[ni] === "}") { ndepth--; if (ndepth === 0) { nsBody = content.slice(nsBodyStart, ni); break; } }
      }
      if (nsBody) {
        const NS_RE = /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:readonly\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
        let nm: RegExpExecArray | null;
        while ((nm = NS_RE.exec(nsBody)) !== null) {
          add({ name: nm[1], file: filePath, kind: "named", module: "esm" });
        }
      }
    }
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
  return path.replace(/\.(ts|tsx|js|jsx|mjs|cjs|d\.ts)$/, "");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isSupportedSourceFile(path: string): boolean {
  return SOURCE_FILE_RE.test(path);
}

function getModuleCandidates(resolvedPath: string): string[] {
  const normalized = normalizePath(resolvedPath);
  const extensionless = normalized.replace(/\.(?:d\.ts|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i, "");
  const bases = normalized === extensionless ? [normalized] : [normalized, extensionless];
  const candidates = new Set<string>();
  for (const base of bases) {
    candidates.add(base);
    for (const suffix of MODULE_SUFFIXES) {
      candidates.add(`${base}${suffix}`);
      candidates.add(`${base}/index${suffix}`);
    }
  }
  return [...candidates];
}

function getTsExtension(filePath: string): ts.Extension {
  const normalized = normalizePath(filePath).toLowerCase();
  if (normalized.endsWith(".d.ts")) return ts.Extension.Dts;
  if (normalized.endsWith(".tsx")) return ts.Extension.Tsx;
  if (normalized.endsWith(".jsx")) return ts.Extension.Jsx;
  if (normalized.endsWith(".mts")) return ts.Extension.Mts;
  if (normalized.endsWith(".cts")) return ts.Extension.Cts;
  if (normalized.endsWith(".mjs")) return ts.Extension.Mjs;
  if (normalized.endsWith(".cjs")) return ts.Extension.Cjs;
  if (normalized.endsWith(".js")) return ts.Extension.Js;
  return ts.Extension.Ts;
}

function atypesToRealPkg(atypesPkg: string): string {
  const name = atypesPkg.slice(7); // strip "@types/"
  return name.includes("__") ? `@${name.replace("__", "/")}` : name;
}

// Single-pass depth-aware extractor: returns only top-level property/method names from a brace body.
function topLevelProps(body: string): string[] {
  const props: string[] = [];
  let depth = 0;
  let token = "";
  let inStr = false;
  let strCh = "";
  const SKIP = new Set(["return", "if", "for", "while", "switch", "new", "typeof", "instanceof", "void", "delete"]);

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === strCh && body[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; token = ""; continue; }
    if (ch === "{" || ch === "(" || ch === "[") { depth++; token = ""; continue; }
    if (ch === "}" || ch === ")" || ch === "]") { depth--; token = ""; continue; }
    if (depth > 0) { token = ""; continue; }
    if (/[A-Za-z_$0-9]/.test(ch)) {
      token += ch;
    } else if ((ch === ":" || ch === "(") && token && /^[A-Za-z_$]/.test(token) && !SKIP.has(token)) {
      props.push(token);
      token = "";
    } else {
      token = "";
    }
  }
  return props;
}

// Extract property/method names from object literals, classes, interfaces, type aliases.
// Uses brace-depth tracking so nested objects don't confuse the parser.
function extractMembersOf(objectName: string, content: string): string[] {
  const members: string[] = [];
  const esc = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Find the opening brace of the definition block for the given identifier.
  function extractBody(startRe: RegExp): string | null {
    const m = startRe.exec(content);
    if (!m) return null;
    let i = m.index + m[0].length - 1; // position of opening `{`
    if (content[i] !== "{") {
      // find the next `{`
      while (i < content.length && content[i] !== "{") i++;
    }
    let depth = 0;
    let start = i;
    for (; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") { depth--; if (depth === 0) return content.slice(start + 1, i); }
    }
    return null;
  }

  // Object literal: const/let/var Name = {
  const objBody = extractBody(new RegExp(`(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=\\s*\\{`));
  if (objBody) members.push(...topLevelProps(objBody));

  // Class: class Name { ... }
  const classBody = extractBody(new RegExp(`class\\s+${esc}(?:\\s+extends[^{]+)?\\s*\\{`));
  if (classBody) {
    const memberRe = /(?:^|\n)\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*[=(({:]/gm;
    let m: RegExpExecArray | null;
    while ((m = memberRe.exec(classBody)) !== null) {
      if (m[1] !== "constructor" && m[1] !== "return" && m[1] !== "if" && m[1] !== "for") {
        members.push(m[1]);
      }
    }
  }

  // Interface or type alias: interface Name { ... } / type Name = { ... }
  const ifaceBody = extractBody(new RegExp(`(?:interface|type)\\s+${esc}(?:<[^>]+>)?\\s*(?:extends[^{]+)?[=]?\\s*\\{`));
  if (ifaceBody) {
    const propRe2 = /(?:^|;|\n)\s*(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\??:/gm;
    let m: RegExpExecArray | null;
    while ((m = propRe2.exec(ifaceBody)) !== null) {
      members.push(m[1]);
    }
  }

  return [...new Set(members)].filter(Boolean);
}

// Drill into a chain like ["resolvers", "Query"] → members of resolvers.Query
function extractNestedMember(chain: string[], content: string): string[] {
  // Find the body of the root object, then drill into each sub-property
  function extractBody(startRe: RegExp, src: string): string | null {
    const m = startRe.exec(src);
    if (!m) return null;
    let i = src.indexOf("{", m.index + m[0].length - 1);
    if (i === -1) return null;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start + 1, i); }
    }
    return null;
  }

  function extractPropBody(propName: string, body: string): string | null {
    const esc = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return extractBody(new RegExp(`\\b${esc}\\s*:\\s*\\{`), body);
  }

  const esc0 = chain[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try to find the root variable's value body
  let body = extractBody(new RegExp(`(?:const|let|var)\\s+${esc0}\\s*(?::[^=]+)?=\\s*\\{`), content)
    ?? extractBody(new RegExp(`(?:module\\.exports|exports)\\s*=\\s*(?:${esc0}\\s*=\\s*)?\\{`), content);

  if (!body) return [];

  for (let i = 1; i < chain.length; i++) {
    const next = extractPropBody(chain[i], body);
    if (!next) return [];
    body = next;
  }

  // Extract top-level property names from the final body
  const members: string[] = [];
  for (const line of body.split("\n")) {
    const stripped = line.replace(/\/\/.*$/, "").trim();
    const m = stripped.match(/^(?:["']?([A-Za-z_$][A-Za-z0-9_$]*)["']?)\s*[:(]/);
    if (m) members.push(m[1]);
  }
  return [...new Set(members)];
}

function parseMemberAccessContext(lineUpToCursor: string, prefix: string) {
  const hit = lineUpToCursor.match(
    /([A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[['"][A-Za-z_$][\w$]*['"]\]))*)(?:\.([\w$]*)|\[(["'])([\w$]*)$)$/
  );
  if (!hit) return null;

  const receiver = hit[1];
  const chain = [receiver.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? ""];
  const propRe = /(?:\.([A-Za-z_$][\w$]*))|(?:\[['"]([A-Za-z_$][\w$]*)['"]\])/g;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = propRe.exec(receiver)) !== null) {
    chain.push(propMatch[1] ?? propMatch[2]);
  }

  return {
    bracket: hit[4] !== undefined,
    bracketQuote: hit[3] ?? "\"",
    chain: chain.filter(Boolean),
    memberPrefix: (hit[2] ?? hit[4] ?? prefix).toLowerCase(),
  };
}

function compactCompletionMeta(kind: string, displayText: string): string {
  const cleaned = displayText
    .replace(/^\([^)]+\)\s*/, "")
    .replace(/^[A-Za-z_$][A-Za-z0-9_$]*\s*/, "")
    .replace(/^\??\s*:\s*/, "")
    .trim();
  if (!cleaned) return kind;
  const shortText = cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned;
  return `${kind} · ${shortText}`;
}

function resolveRelativeImport(fromFile: string, importPath: string): string {
  const fromParts = fromFile.split("/").slice(0, -1);
  for (const part of importPath.split("/")) {
    if (part === "..") fromParts.pop();
    else if (part !== ".") fromParts.push(part);
  }
  return fromParts.join("/");
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

// Returns a Monaco text edit that inserts or updates an import statement, or null if already present.
function computeImportEdit(
  lines: string[],
  importPath: string,
  importName: string,
  kind: ExportKind,
  style: ImportStyle
): { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string } | null {
  if (style === "import") {
    if (kind === "named") {
      const namedImportRe = new RegExp(`^\\s*import\\s+([^\\n]+?)\\s+from\\s+["']${escapeRegExp(importPath)}["'];?\\s*$`);
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(namedImportRe);
        if (!match) continue;
        const clause = match[1];
        if (clause.includes("{") && clause.includes("}")) {
          const namedMatch = clause.match(/^(.*?)(\{([^}]*)\})(.*)$/);
          if (!namedMatch) break;
          const namedList = addNamedToImportClause(namedMatch[3], importName);
          const newLine = `import ${namedMatch[1]}{ ${namedList} }${namedMatch[4]} from "${importPath}";`
            .replace(/\s+,/g, ",")
            .replace(/,\s+\}/g, " }");
          return {
            range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1 },
            text: newLine,
          };
        }
      }
      const stmt = `import { ${importName} } from "${importPath}";`;
      if (lines.some((line) => line.trim() === stmt)) return null;
      const row = findInsertRow(lines, style);
      return {
        range: { startLineNumber: row + 1, startColumn: 1, endLineNumber: row + 1, endColumn: 1 },
        text: stmt + "\n",
      };
    }

    const defaultImportRe = new RegExp(`^\\s*import\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?:,\\s*\\{[^}]*\\})?\\s+from\\s+["']${escapeRegExp(importPath)}["'];?\\s*$`);
    if (lines.some((line) => defaultImportRe.test(line))) return null;

    const namedOnlyRe = new RegExp(`^\\s*import\\s+\\{([^}]*)\\}\\s+from\\s+["']${escapeRegExp(importPath)}["'];?\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(namedOnlyRe);
      if (!match) continue;
      const newLine = `import ${importName}, { ${match[1].trim()} } from "${importPath}";`;
      return {
        range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1 },
        text: newLine,
      };
    }

    const stmt = `import ${importName} from "${importPath}";`;
    const row = findInsertRow(lines, style);
    return {
      range: { startLineNumber: row + 1, startColumn: 1, endLineNumber: row + 1, endColumn: 1 },
      text: stmt + "\n",
    };
  }

  // require style
  if (kind === "named") {
    const namedRequireRe = new RegExp(`^\\s*(const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*require\\(["']${escapeRegExp(importPath)}["']\\);?\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(namedRequireRe);
      if (!match) continue;
      const updated = addNamedToImportClause(match[2], importName);
      const newLine = `${match[1]} { ${updated} } = require("${importPath}");`;
      return {
        range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1 },
        text: newLine,
      };
    }
    const stmt = `const { ${importName} } = require("${importPath}");`;
    if (lines.some((line) => line.trim() === stmt)) return null;
    const row = findInsertRow(lines, style);
    return {
      range: { startLineNumber: row + 1, startColumn: 1, endLineNumber: row + 1, endColumn: 1 },
      text: stmt + "\n",
    };
  }

  const defaultRequireRe = new RegExp(`^\\s*(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*require\\(["']${escapeRegExp(importPath)}["']\\);?\\s*$`);
  if (lines.some((line) => defaultRequireRe.test(line))) return null;
  const stmt = `const ${importName} = require("${importPath}");`;
  const row = findInsertRow(lines, style);
  return {
    range: { startLineNumber: row + 1, startColumn: 1, endLineNumber: row + 1, endColumn: 1 },
    text: stmt + "\n",
  };
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".athva", "dist", "build", ".next", "out", ".svelte-kit",
]);

export class ExportsTracker {
  private projectPath = "";
  private exports: ExportEntry[] = [];
  private packageExports: ExportEntry[] = [];
  private packageNames: string[] = [];
  private sourceFiles = new Map<string, string>();
  private sourceVersions = new Map<string, number>();
  private languageService: ts.LanguageService | null = null;
  private sourceIndexReady = false;
  private sourceIndexPromise: Promise<void> | null = null;

  async onProjectOpen(projectPath: string) {
    this.projectPath = normalizePath(projectPath);
    this.exports = [];
    this.packageExports = [];
    await this.loadPackageNames();
    this.sourceFiles.clear();
    this.sourceVersions.clear();
    this.languageService = null;
    this.sourceIndexReady = false;
    this.sourceIndexPromise = null;

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
      this.packageNames.map((pkgName) => this.scanOnePackage(pkgName))
    );

    this.packageExports = uniqueByKey(
      results.flat(),
      (e) => `${e.file}:${e.name}:${e.kind}`
    );
  }

  private async scanOnePackage(pkgName: string): Promise<ExportEntry[]> {
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

    // @types/{name} fallback: "react" → "@types/react", "@scope/pkg" → "@types/scope__pkg"
    const atypesName = pkgName.startsWith("@")
      ? pkgName.slice(1).replace("/", "__")
      : pkgName;
    const atypesBase = `${this.projectPath}/node_modules/@types/${atypesName}`;

    const candidates = [
      typesFile ? `${nmBase}/${typesFile}` : null,
      `${nmBase}/index.d.ts`,
      `${atypesBase}/index.d.ts`,
      `${nmBase}/index.js`,
    ].filter(Boolean) as string[];

    const realPkg = pkgName.startsWith("@types/") ? atypesToRealPkg(pkgName) : pkgName;

    for (const candidate of candidates) {
      try {
        const content = await invoke<string>("read_file", { path: candidate });
        const { entries } = extractExports(content, pkgName);

        // Follow `export * from './sub'` one level deep (common in @types packages)
        const RE_STAR = /^\s*export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"](\.[^'"]+)['"]/gm;
        const starPaths: string[] = [];
        let sm: RegExpExecArray | null;
        RE_STAR.lastIndex = 0;
        while ((sm = RE_STAR.exec(content)) !== null) starPaths.push(sm[1]);

        const subEntries = (
          await Promise.all(
            starPaths.map(async (rel) => {
              const dir = candidate.slice(0, candidate.lastIndexOf("/"));
              const subPath = rel.endsWith(".d.ts") || rel.endsWith(".ts")
                ? `${dir}/${rel}`
                : `${dir}/${rel}.d.ts`;
              try {
                const sub = await invoke<string>("read_file", { path: subPath });
                return extractExports(sub, pkgName).entries;
              } catch { return []; }
            })
          )
        ).flat();

        const all = uniqueByKey([...entries, ...subEntries], (e) => `${e.name}:${e.kind}`);
        if (all.length > 0) {
          return all.map((e) => ({ ...e, file: realPkg, isPackage: true }));
        }
      } catch { /* try next */ }
    }
    return [];
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
    const normalizedPath = normalizePath(absolutePath);
    if (isSupportedSourceFile(normalizedPath)) {
      this.setSourceFileContent(normalizedPath, content);
    }
    if (!this.projectPath) return;
    if (normalizedPath === `${this.projectPath}/package.json`) {
      await this.loadPackageNames();
      void this.scanPackageExports();
      return;
    }
    if (!normalizedPath.startsWith(this.projectPath)) return;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalizedPath)) return;

    const relFile = normalizedPath.slice(this.projectPath.length + 1);
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
    const oldNormalized = normalizePath(oldAbsPath);
    const newNormalized = normalizePath(newAbsPath);
    const toRel = (abs: string) =>
      abs.startsWith(this.projectPath) ? abs.slice(this.projectPath.length + 1) : abs;

    const oldRel = toRel(oldNormalized);
    const newRel = toRel(newNormalized);

    let changed = false;
    this.exports = this.exports.map((entry) => {
      if (entry.file === oldRel) {
        changed = true;
        return { ...entry, file: newRel };
      }
      return entry;
    });

    if (changed) await this.persist();

    if (this.sourceFiles.has(oldNormalized)) {
      const existing = this.sourceFiles.get(oldNormalized)!;
      const version = this.sourceVersions.get(oldNormalized) ?? 1;
      this.sourceFiles.delete(oldNormalized);
      this.sourceVersions.delete(oldNormalized);
      this.sourceFiles.set(newNormalized, existing);
      this.sourceVersions.set(newNormalized, version + 1);
    }
  }

  async resolveDefinition(
    filePath: string,
    content: string,
    row: number,
    column: number
  ): Promise<DefinitionTarget | null> {
    const normalizedFilePath = normalizePath(filePath);
    const importTarget = await this.resolveImportPathTarget(normalizedFilePath, content, row, column);
    if (importTarget) return importTarget;
    if (!isSupportedSourceFile(normalizedFilePath) || !this.projectPath) return null;

    await this.ensureSourceIndex();
    this.setSourceFileContent(normalizedFilePath, content);

    const languageService = this.getLanguageService();
    const program = languageService.getProgram();
    const sourceFile = program?.getSourceFile(normalizedFilePath);
    if (!sourceFile) return null;

    const position = ts.getPositionOfLineAndCharacter(sourceFile, row, column);
    const definitions = languageService.getDefinitionAtPosition(normalizedFilePath, position) ?? [];
    const preferredDefinitions = definitions.filter((definition) => this.isProjectFile(definition.fileName));
    const resolvedDefinition = (preferredDefinitions.length > 0 ? preferredDefinitions : definitions)
      .map((definition) => this.definitionInfoToTarget(definition, program))
      .find((target): target is DefinitionTarget => !!target);

    return resolvedDefinition ?? null;
  }

  async resolveHoverInfo(
    filePath: string,
    content: string,
    row: number,
    column: number
  ): Promise<HoverInfo | null> {
    const normalizedFilePath = normalizePath(filePath);
    if (!isSupportedSourceFile(normalizedFilePath) || !this.projectPath) return null;

    await this.ensureSourceIndex();
    this.setSourceFileContent(normalizedFilePath, content);

    const languageService = this.getLanguageService();
    const program = languageService.getProgram();
    const sourceFile = program?.getSourceFile(normalizedFilePath);
    if (!sourceFile) return null;

    const position = ts.getPositionOfLineAndCharacter(sourceFile, row, column);
    const quickInfo = languageService.getQuickInfoAtPosition(normalizedFilePath, position);
    if (!quickInfo?.displayParts?.length) return null;

    const definitions = languageService.getDefinitionAtPosition(normalizedFilePath, position) ?? [];
    const preferredDefinitions = definitions.filter((definition) => this.isProjectFile(definition.fileName));
    const definition = (preferredDefinitions.length > 0 ? preferredDefinitions : definitions)
      .map((item) => this.definitionInfoToTarget(item, program))
      .find((target): target is DefinitionTarget => !!target);

    const documentation = [
      ts.displayPartsToString(quickInfo.documentation),
      ...(quickInfo.tags ?? []).map((tag) => {
        const text = typeof tag.text === "string" ? tag.text : ts.displayPartsToString(tag.text);
        return text ? `@${tag.name} ${text}` : `@${tag.name}`;
      }),
    ].filter(Boolean).join("\n");

    return {
      signature: ts.displayPartsToString(quickInfo.displayParts),
      ...(documentation ? { documentation } : {}),
      ...(definition ? { definition } : {}),
    };
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

  private setSourceFileContent(filePath: string, content: string) {
    const normalizedPath = normalizePath(filePath);
    this.sourceFiles.set(normalizedPath, content);
    this.sourceVersions.set(normalizedPath, (this.sourceVersions.get(normalizedPath) ?? 0) + 1);
  }

  private async ensureSourceIndex() {
    if (this.sourceIndexReady || !this.projectPath) return;
    if (!this.sourceIndexPromise) {
      this.sourceIndexPromise = this.buildSourceIndex();
    }
    await this.sourceIndexPromise;
  }

  private async buildSourceIndex() {
    try {
      this.sourceFiles.clear();
      this.sourceVersions.clear();
      await this.scanSourceFiles(this.projectPath);
      this.languageService = null;
      this.sourceIndexReady = true;
    } finally {
      this.sourceIndexPromise = null;
    }
  }

  private async scanSourceFiles(rootPath: string): Promise<void> {
    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("read_dir", { path: rootPath });
    } catch {
      return;
    }

    const directories = entries.filter(
      (entry) => entry.is_dir && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")
    );
    const files = entries.filter((entry) => !entry.is_dir && isSupportedSourceFile(entry.name));

    const loadedFiles = await Promise.all(
      files.map(async (entry) => {
        try {
          const content = await invoke<string>("read_file", { path: entry.path });
          return { path: normalizePath(entry.path), content };
        } catch {
          return null;
        }
      })
    );

    loadedFiles.forEach((entry) => {
      if (!entry) return;
      this.sourceFiles.set(entry.path, entry.content);
      this.sourceVersions.set(entry.path, 1);
    });

    for (const directory of directories) {
      await this.scanSourceFiles(directory.path);
    }
  }

  private getLanguageService(): ts.LanguageService {
    if (this.languageService) return this.languageService;

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => TS_COMPILER_OPTIONS,
      getScriptFileNames: () => [...this.sourceFiles.keys()],
      getScriptVersion: (fileName) => `${this.sourceVersions.get(normalizePath(fileName)) ?? 0}`,
      getScriptSnapshot: (fileName) => {
        const content = this.sourceFiles.get(normalizePath(fileName));
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getCurrentDirectory: () => this.projectPath || "/",
      getDefaultLibFileName: () => "lib.d.ts",
      fileExists: (fileName) => this.sourceFiles.has(normalizePath(fileName)),
      readFile: (fileName) => this.sourceFiles.get(normalizePath(fileName)),
      readDirectory: () => [...this.sourceFiles.keys()],
      directoryExists: (dirName) => this.directoryExists(dirName),
      getDirectories: () => [],
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      resolveModuleNames: (moduleNames, containingFile) =>
        moduleNames.map((moduleName) => this.resolveModuleName(moduleName, containingFile)),
    };

    this.languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
    return this.languageService;
  }

  private resolveModuleName(
    moduleName: string,
    containingFile: string
  ): ts.ResolvedModuleFull | undefined {
    if (!moduleName.startsWith(".") && !moduleName.startsWith("/")) return undefined;

    const containingDir = normalizePath(containingFile).split("/").slice(0, -1).join("/");
    const resolvedBase = moduleName.startsWith("/")
      ? normalizePath(moduleName)
      : normalizePath(resolveDir(containingDir, moduleName));

    for (const candidate of getModuleCandidates(resolvedBase)) {
      if (!this.sourceFiles.has(candidate)) continue;
      return {
        resolvedFileName: candidate,
        extension: getTsExtension(candidate),
        isExternalLibraryImport: false,
      };
    }

    return undefined;
  }

  private directoryExists(dirName: string): boolean {
    const normalizedDir = normalizePath(dirName).replace(/\/+$/, "");
    if (!normalizedDir) return false;
    if (normalizedDir === this.projectPath) return true;
    const prefix = `${normalizedDir}/`;
    return [...this.sourceFiles.keys()].some((filePath) => filePath.startsWith(prefix));
  }

  private isProjectFile(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath);
    return normalizedPath === this.projectPath || normalizedPath.startsWith(`${this.projectPath}/`);
  }

  private definitionInfoToTarget(
    definition: ts.DefinitionInfo,
    program: ts.Program | undefined
  ): DefinitionTarget | null {
    const normalizedPath = normalizePath(definition.fileName);
    const sourceFile = program?.getSourceFile(normalizedPath);
    if (!sourceFile) return null;

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(definition.textSpan.start);
    return {
      path: normalizedPath,
      line: line + 1,
      column: character + 1,
    };
  }

  private async resolveImportPathTarget(
    filePath: string,
    content: string,
    row: number,
    column: number
  ): Promise<DefinitionTarget | null> {
    const line = content.split(/\r?\n/)[row] ?? "";
    const literal = this.getStringLiteralAtPosition(line, column);
    if (!literal) return null;

    const before = line.slice(0, literal.start - 1);
    const isImportPath = /(?:\bfrom\s*|require\s*\(\s*|import\s*\(\s*|^\s*import\s*)$/.test(before);
    if (!isImportPath) return null;

    const resolvedPath = await this.resolveProjectModulePath(filePath, literal.value);
    if (!resolvedPath) return null;

    return { path: resolvedPath, line: 1, column: 1 };
  }

  private getStringLiteralAtPosition(
    line: string,
    column: number
  ): { value: string; start: number; end: number } | null {
    const stringRe = /(['"])([^'"]+)\1/g;
    let match: RegExpExecArray | null;
    while ((match = stringRe.exec(line)) !== null) {
      const start = match.index + 1;
      const end = start + match[2].length;
      if (column >= start && column <= end) {
        return { value: match[2], start, end };
      }
    }
    return null;
  }

  private async resolveProjectModulePath(fromFile: string, specifier: string): Promise<string | null> {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

    const currentDir = normalizePath(fromFile).split("/").slice(0, -1).join("/");
    const resolvedBase = specifier.startsWith("/")
      ? normalizePath(specifier)
      : normalizePath(resolveDir(currentDir, specifier));

    for (const candidate of getModuleCandidates(resolvedBase)) {
      const exists = await invoke<boolean>("check_path_exists", { path: candidate }).catch(() => false);
      if (exists) return candidate;
    }

    return null;
  }

  getCompleter(): MonacoCompleter {
    const tracker = this;
    return {
      languages: ["typescript", "javascript"],
      provider: {
        provideCompletionItems(
          model: monaco.editor.ITextModel,
          position: monaco.Position
        ): monaco.languages.CompletionList {
          const lineUpTo = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const wordInfo = model.getWordUntilPosition(position);
          const prefix = wordInfo.word;
          if (!prefix || prefix.length < 1) return { suggestions: [] };

          if (/(?:from|import|require\s*\()\s*['"][^'"]*$/.test(lineUpTo)) return { suggestions: [] };
          if (/^\s*import\b/.test(model.getLineContent(position.lineNumber))) return { suggestions: [] };

          const currentAbsPath = (model.uri as any).path as string ?? "";
          const currentRelPath = currentAbsPath.startsWith("/" + tracker.projectPath.replace(/^\//, ""))
            ? currentAbsPath.slice(tracker.projectPath.length + 1)
            : currentAbsPath.startsWith(tracker.projectPath)
              ? currentAbsPath.slice(tracker.projectPath.length + 1)
              : "";
          const lowerPrefix = prefix.toLowerCase();
          const lines = model.getValue().split("\n");
          const importStyle = detectImportStyle(lines, currentAbsPath);

          const allEntries = [
            ...tracker.exports.filter(
              (e) =>
                (!e.rule || !currentRelPath || matchGlob(e.rule, currentRelPath)) &&
                e.file !== currentRelPath
            ),
            ...tracker.packageExports,
          ];

          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            startColumn: wordInfo.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          };

          const suggestions: monaco.languages.CompletionItem[] = allEntries
            .filter((entry) => entry.name.toLowerCase().startsWith(lowerPrefix))
            .map((entry) => {
              const importPath = entry.isPackage
                ? entry.file
                : currentRelPath
                  ? stripExt(relativePath(currentRelPath, entry.file))
                  : `./${stripExt(entry.file)}`;
              const importEdit = computeImportEdit(lines, importPath, entry.name, entry.kind, importStyle);
              return {
                label: entry.name,
                kind: entry.kind === "default" ? 6 /* Class */ : 5 /* Function */ as monaco.languages.CompletionItemKind,
                insertText: entry.name,
                detail: `${entry.kind === "default" ? "default" : "named"} · ${importPath}`,
                sortText: entry.kind === "default" ? `0${entry.name}` : `1${entry.name}`,
                additionalTextEdits: importEdit ? [importEdit] : [],
                range,
              };
            });

          return { suggestions };
        },
      },
    };
  }

  getPathCompleter(): MonacoCompleter {
    const tracker = this;
    return {
      languages: ["typescript", "javascript"],
      provider: {
        triggerCharacters: ["'", '"', "/", "."],
        provideCompletionItems(
          model: monaco.editor.ITextModel,
          position: monaco.Position
        ): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
          const lineUpTo = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const match = lineUpTo.match(/(?:from|import|require\s*\()\s*['"]([^'"]*)/);
          if (!match) return { suggestions: [] };

          const partialPath = match[1];
          const replaceStart = position.column - partialPath.length;
          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            startColumn: replaceStart,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          };

          if (partialPath.startsWith(".")) {
            const currentAbsPath = (model.uri as any).path as string ?? "";
            if (!currentAbsPath) return { suggestions: [] };

            const currentDir = currentAbsPath.slice(0, currentAbsPath.lastIndexOf("/"));
            const lastSlash = partialPath.lastIndexOf("/");
            const dirPart = lastSlash >= 0 ? partialPath.slice(0, lastSlash) : ".";
            const filePrefix = lastSlash >= 0 ? partialPath.slice(lastSlash + 1) : partialPath;
            const absDir = resolveDir(currentDir, dirPart);
            const displayBase = dirPart === "." ? "./" : `${dirPart}/`;

            return invoke<FileEntry[]>("read_dir", { path: absDir })
              .then((entries) => {
                const lowerPrefix = filePrefix.toLowerCase();
                const suggestions: monaco.languages.CompletionItem[] = entries
                  .filter((entry) => lowerPrefix === "" || entry.name.toLowerCase().startsWith(lowerPrefix))
                  .map((entry) => {
                    const targetName = entry.is_dir ? `${entry.name}/` : stripExt(entry.name);
                    const fullPath = `${displayBase}${targetName}`;
                    return {
                      label: fullPath,
                      kind: entry.is_dir ? 19 /* Folder */ : 17 /* File */ as monaco.languages.CompletionItemKind,
                      insertText: fullPath,
                      detail: entry.is_dir ? "dir" : "file",
                      range,
                    };
                  });
                return { suggestions };
              })
              .catch(() => ({ suggestions: [] }));
          }

          const lowerPrefix = partialPath.toLowerCase();
          const suggestions: monaco.languages.CompletionItem[] = tracker.packageNames
            .filter((packageName) => !partialPath || packageName.toLowerCase().startsWith(lowerPrefix))
            .map((packageName) => ({
              label: packageName,
              kind: 9 /* Module */ as monaco.languages.CompletionItemKind,
              insertText: packageName,
              detail: "package",
              range,
            }));
          return { suggestions };
        },
      },
    };
  }

  getNamedImportCompleter(): MonacoCompleter {
    const tracker = this;
    return {
      languages: ["typescript", "javascript"],
      provider: {
        provideCompletionItems(
          model: monaco.editor.ITextModel,
          position: monaco.Position
        ): monaco.languages.CompletionList {
          const wordInfo = model.getWordUntilPosition(position);
          const prefix = wordInfo.word;
          if (!prefix) return { suggestions: [] };

          const fullLine = model.getLineContent(position.lineNumber);
          const fromMatch = fullLine.match(/from\s+['"]([^'"]+)['"]/);
          if (!fromMatch) return { suggestions: [] };

          const openBrace = fullLine.indexOf("{");
          const closeBrace = fullLine.indexOf("}");
          if (openBrace === -1 || closeBrace === -1) return { suggestions: [] };
          if (position.column - 1 <= openBrace || position.column - 1 > closeBrace) return { suggestions: [] };
          if (!/^\s*import\b/.test(fullLine)) return { suggestions: [] };

          const pkgOrPath = fromMatch[1];
          const lowerPrefix = prefix.toLowerCase();

          let entries: ExportEntry[];
          if (pkgOrPath.startsWith(".")) {
            const currentAbsPath = (model.uri as any).path as string ?? "";
            const currentRelPath = currentAbsPath.startsWith(tracker.projectPath)
              ? currentAbsPath.slice(tracker.projectPath.length + 1)
              : "";
            const resolved = resolveRelativeImport(currentRelPath, pkgOrPath);
            entries = tracker.exports.filter(
              (e) =>
                (stripExt(e.file) === resolved || stripExt(e.file) === `${resolved}/index`) &&
                e.kind === "named"
            );
          } else {
            entries = tracker.packageExports.filter(
              (e) => e.file === pkgOrPath && e.kind === "named"
            );
          }

          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            startColumn: wordInfo.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          };

          const suggestions: monaco.languages.CompletionItem[] = entries
            .filter((e) => e.name.toLowerCase().startsWith(lowerPrefix))
            .map((e) => ({
              label: e.name,
              kind: 5 /* Function */ as monaco.languages.CompletionItemKind,
              insertText: e.name,
              detail: pkgOrPath,
              sortText: `0${e.name}`,
              range,
            }));

          return { suggestions };
        },
      },
    };
  }

  getMemberCompleter(): MonacoCompleter {
    const tracker = this;
    return {
      languages: ["typescript", "javascript"],
      provider: {
        triggerCharacters: [".", "["],
        provideCompletionItems(
          model: monaco.editor.ITextModel,
          position: monaco.Position
        ): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
          const lineUpTo = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const wordInfo = model.getWordUntilPosition(position);
          const context = parseMemberAccessContext(lineUpTo, wordInfo.word);
          if (!context) return { suggestions: [] };

          const currentAbsPath = (model.uri as any).path as string ?? "";

          const dotIdx = lineUpTo.lastIndexOf(".");
          const bracketIdx = Math.max(lineUpTo.lastIndexOf('["'), lineUpTo.lastIndexOf("['"));
          const replaceFrom = Math.max(dotIdx, bracketIdx) + (bracketIdx >= dotIdx ? 2 : 1) + 1; // 1-based
          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            startColumn: replaceFrom,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          };

          return tracker.getTypeScriptMemberCompletions(
            currentAbsPath,
            model.getValue(),
            position.lineNumber - 1,
            position.column - 1,
            context.memberPrefix,
            context.bracket,
            context.bracketQuote
          ).then((tsResults) => {
            if (tsResults.length > 0) {
              return {
                suggestions: tsResults.map((r: any) => ({
                  label: r.caption,
                  kind: 9 /* Module */ as monaco.languages.CompletionItemKind,
                  insertText: r.value,
                  detail: r.meta,
                  sortText: `0${r.caption}`,
                  range,
                })),
              };
            }
            const fallback = tracker.getRegexMemberCompletions(
              model.getValue(), context.chain, context.memberPrefix, context.bracket, context.bracketQuote
            );
            return {
              suggestions: fallback.map((r: any) => ({
                label: r.caption,
                kind: 9 /* Module */ as monaco.languages.CompletionItemKind,
                insertText: r.value,
                detail: r.meta,
                range,
              })),
            };
          }).catch(() => {
            const fallback = tracker.getRegexMemberCompletions(
              model.getValue(), context.chain, context.memberPrefix, context.bracket, context.bracketQuote
            );
            return {
              suggestions: fallback.map((r: any) => ({
                label: r.caption,
                kind: 9 /* Module */ as monaco.languages.CompletionItemKind,
                insertText: r.value,
                detail: r.meta,
                range,
              })),
            };
          });
        },
      },
    };
  }

  private async getTypeScriptMemberCompletions(
    filePath: string,
    content: string,
    row: number,
    column: number,
    memberPrefix: string,
    bracket: boolean,
    bracketQuote: string
  ): Promise<any[]> {
    const normalizedFilePath = normalizePath(filePath);
    if (!isSupportedSourceFile(normalizedFilePath) || !this.projectPath) return [];

    await this.ensureSourceIndex();
    this.setSourceFileContent(normalizedFilePath, content);

    const languageService = this.getLanguageService();
    const program = languageService.getProgram();
    const sourceFile = program?.getSourceFile(normalizedFilePath);
    if (!sourceFile) return [];

    const position = ts.getPositionOfLineAndCharacter(sourceFile, row, column);
    const completions = languageService.getCompletionsAtPosition(normalizedFilePath, position, {
      includeCompletionsForModuleExports: false,
      includeCompletionsWithInsertText: true,
      includeCompletionsWithSnippetText: true,
    });
    if (!completions?.entries?.length) return [];

    const lowerPrefix = memberPrefix.toLowerCase();
    const entries = completions.entries
      .filter((entry) => entry.name.toLowerCase().startsWith(lowerPrefix))
      .slice(0, 40);

    return entries.map((entry) => {
      const details = languageService.getCompletionEntryDetails(
        normalizedFilePath,
        position,
        entry.name,
        {},
        entry.source,
        {},
        entry.data
      );
      const displayText = details?.displayParts ? ts.displayPartsToString(details.displayParts) : "";
      return {
        caption: entry.name,
        value: bracket ? `${entry.name}${bracketQuote}]` : entry.name,
        meta: displayText ? compactCompletionMeta(entry.kind, displayText) : entry.kind,
        score: 2200,
        _athvaMemberCompletion: true,
      };
    });
  }

  private getRegexMemberCompletions(
    content: string,
    chain: string[],
    memberPrefix: string,
    bracket: boolean,
    bracketQuote: string
  ): any[] {
    const members = chain.length === 1
      ? extractMembersOf(chain[0], content)
      : extractNestedMember(chain, content);
    if (members.length === 0) return [];

    const rootName = chain[0];
    return members
      .filter((m: string) => m.toLowerCase().startsWith(memberPrefix))
      .map((m: string) => ({
        caption: m,
        value: bracket ? `${m}${bracketQuote}]` : m,
        meta: rootName,
        score: 1100,
        _athvaMemberCompletion: true,
      }));
  }
}
