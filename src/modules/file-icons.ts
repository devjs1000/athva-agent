// VS Code Material Icon-inspired SVG file & folder icons
// Colors and shapes closely match material-icon-theme

// ── Folder Icons ──

const FOLDER_CLOSED = (color: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 2C.67 2 0 2.67 0 3.5V12.5C0 13.33.67 14 1.5 14H14.5C15.33 14 16 13.33 16 12.5V5.5C16 4.67 15.33 4 14.5 4H8L6.5 2H1.5Z" fill="${color}"/></svg>`;

const FOLDER_OPEN = (color: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 2C.67 2 0 2.67 0 3.5V5H6.5L8 3H14.5C15.33 3 16 3.67 16 4.5V5H8L6.5 7H0V12.5C0 13.33.67 14 1.5 14H14.5C15.33 14 16 13.33 16 12.5V5.5C16 4.67 15.33 4 14.5 4H8L6.5 2H1.5Z" fill="${color}"/><path d="M0 7H6L8 5H16V12.5C16 13.33 15.33 14 14.5 14H1.5C.67 14 0 13.33 0 12.5V7Z" fill="${color}" opacity="0.7"/></svg>`;

// Default file icon
const FILE_DEFAULT =
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 1C2.45 1 2 1.45 2 2V14C2 14.55 2.45 15 3 15H13C13.55 15 14 14.55 14 14V5L10 1H3Z" fill="#424b56"/><path d="M10 1V5H14L10 1Z" fill="#5c6672"/></svg>`;

// ── Special Folder Colors ──

interface FolderStyle {
  color: string;
}

const FOLDER_STYLES: Record<string, FolderStyle> = {
  src:         { color: "#42a5f5" },
  source:      { color: "#42a5f5" },
  lib:         { color: "#7e57c2" },
  node_modules:{ color: "#8bc34a" },
  dist:        { color: "#ff7043" },
  build:       { color: "#ff7043" },
  out:         { color: "#ff7043" },
  public:      { color: "#66bb6a" },
  assets:      { color: "#66bb6a" },
  static:      { color: "#66bb6a" },
  images:      { color: "#66bb6a" },
  img:         { color: "#66bb6a" },
  components:  { color: "#42a5f5" },
  pages:       { color: "#42a5f5" },
  hooks:       { color: "#ce93d8" },
  utils:       { color: "#78909c" },
  helpers:     { color: "#78909c" },
  config:      { color: "#78909c" },
  styles:      { color: "#ec407a" },
  css:         { color: "#ec407a" },
  test:        { color: "#fdd835" },
  tests:       { color: "#fdd835" },
  __tests__:   { color: "#fdd835" },
  spec:        { color: "#fdd835" },
  docs:        { color: "#42a5f5" },
  api:         { color: "#66bb6a" },
  routes:      { color: "#66bb6a" },
  middleware:  { color: "#ab47bc" },
  models:      { color: "#ef5350" },
  types:       { color: "#42a5f5" },
  store:       { color: "#7e57c2" },
  modules:     { color: "#ce93d8" },
  layouts:     { color: "#42a5f5" },
  scripts:     { color: "#78909c" },
  ".github":   { color: "#bdbdbd" },
  ".vscode":   { color: "#42a5f5" },
  target:      { color: "#ff7043" },
  vendor:      { color: "#8bc34a" },
};

const DEFAULT_FOLDER_COLOR = "#90a4ae";

// ── File Icon Definitions ──

interface FileIcon {
  svg: string;
}

export interface AthvaSpecialEntry {
  kind: "docs-folder" | "contexts-folder" | "extensions-folder" | "todo-file" | "spreadsheet-file" | "text-file" | "flow-file" | "extension-file";
  label: string;
  accent: string;
}

export interface AthvaSpecialGuideItem {
  label: string;
  pattern: string;
  useCase: string;
  accent: string;
}

export interface AthvaSpecialGuideSection {
  title: string;
  items: AthvaSpecialGuideItem[];
}

export interface RuntimeFileIconTheme {
  id: string;
  label: string;
  extensionIdentifier: string;
  defaultFile?: string;
  defaultFolder?: string;
  defaultFolderExpanded?: string;
  filesByName: Record<string, string>;
  filesByExtension: Record<string, string>;
  foldersByName: Record<string, string>;
  foldersExpandedByName: Record<string, string>;
}

function fileIcon(bodyColor: string, tagColor: string, tagText: string): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">` +
    `<path d="M3 1C2.45 1 2 1.45 2 2V14C2 14.55 2.45 15 3 15H13C13.55 15 14 14.55 14 14V5L10 1H3Z" fill="${bodyColor}"/>` +
    `<path d="M10 1V5H14L10 1Z" fill="${bodyColor}" opacity="0.6"/>` +
    `<text x="8" y="12" text-anchor="middle" font-size="4.5" font-weight="700" font-family="sans-serif" fill="${tagColor}">${tagText}</text>` +
    `</svg>`;
}

function langIcon(color: string, letter: string): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">` +
    `<rect x="1" y="1" width="14" height="14" rx="2" fill="${color}" opacity="0.15"/>` +
    `<text x="8" y="11.5" text-anchor="middle" font-size="8" font-weight="700" font-family="sans-serif" fill="${color}">${letter}</text>` +
    `</svg>`;
}

// Extension → icon mapping
const FILE_ICON_MAP: Record<string, FileIcon> = {
  // JavaScript / TypeScript
  js:    { svg: langIcon("#f5de19", "JS") },
  jsx:   { svg: langIcon("#61dafb", "JX") },
  ts:    { svg: langIcon("#3178c6", "TS") },
  tsx:   { svg: langIcon("#3178c6", "TX") },
  mjs:   { svg: langIcon("#f5de19", "MJ") },
  cjs:   { svg: langIcon("#f5de19", "CJ") },

  // Web
  html:  { svg: langIcon("#e44d26", "<>") },
  htm:   { svg: langIcon("#e44d26", "<>") },
  css:   { svg: langIcon("#1572b6", "#") },
  scss:  { svg: langIcon("#cd6799", "S") },
  sass:  { svg: langIcon("#cd6799", "S") },
  less:  { svg: langIcon("#1d365d", "L") },
  svg:   { svg: langIcon("#ffb13b", "SV") },

  // Data / Config
  json:  { svg: langIcon("#f5de19", "{ }") },
  yaml:  { svg: fileIcon("#424b56", "#f44336", "YML") },
  yml:   { svg: fileIcon("#424b56", "#f44336", "YML") },
  toml:  { svg: fileIcon("#424b56", "#78909c", "TM") },
  xml:   { svg: fileIcon("#424b56", "#ff9800", "XM") },
  csv:   { svg: fileIcon("#424b56", "#66bb6a", "CSV") },
  xlsx:  { svg: fileIcon("#424b56", "#2e7d32", "XLS") },
  xls:   { svg: fileIcon("#424b56", "#2e7d32", "XLS") },
  env:   { svg: fileIcon("#424b56", "#fdd835", "ENV") },

  // Markdown / Text
  md:    { svg: langIcon("#42a5f5", "M") },
  mdx:   { svg: langIcon("#42a5f5", "MX") },
  txt:   { svg: fileIcon("#424b56", "#bdbdbd", "TXT") },
  flow:  { svg: fileIcon("#424b56", "#42a5f5", "FLW") },
  log:   { svg: fileIcon("#424b56", "#78909c", "LOG") },

  // Rust
  rs:    { svg: langIcon("#ff5722", "Rs") },

  // Python
  py:    { svg: langIcon("#3572A5", "Py") },
  pyi:   { svg: langIcon("#3572A5", "Py") },
  pyc:   { svg: fileIcon("#424b56", "#3572A5", "PYC") },

  // Go
  go:    { svg: langIcon("#00acd7", "Go") },

  // Java / Kotlin
  java:  { svg: langIcon("#ea2d2e", "Jv") },
  kt:    { svg: langIcon("#7f52ff", "Kt") },
  kts:   { svg: langIcon("#7f52ff", "Kt") },

  // C / C++ / C#
  c:     { svg: langIcon("#5c6bc0", "C") },
  h:     { svg: langIcon("#5c6bc0", "H") },
  cpp:   { svg: langIcon("#5c6bc0", "C+") },
  hpp:   { svg: langIcon("#5c6bc0", "H+") },
  cs:    { svg: langIcon("#68217a", "C#") },

  // Shell
  sh:    { svg: langIcon("#4eaa25", "$_") },
  bash:  { svg: langIcon("#4eaa25", "$_") },
  zsh:   { svg: langIcon("#4eaa25", "$_") },
  fish:  { svg: langIcon("#4eaa25", "$_") },
  ps1:   { svg: langIcon("#012456", "PS") },

  // Ruby / PHP
  rb:    { svg: langIcon("#cc342d", "Rb") },
  php:   { svg: langIcon("#777bb3", "PH") },

  // Swift / Dart
  swift: { svg: langIcon("#f05138", "Sw") },
  dart:  { svg: langIcon("#0175c2", "Dt") },

  // Docker
  dockerfile: { svg: langIcon("#2496ed", "Dk") },

  // SQL
  sql:   { svg: langIcon("#e38c00", "SQ") },

  // Images
  png:   { svg: fileIcon("#424b56", "#66bb6a", "PNG") },
  jpg:   { svg: fileIcon("#424b56", "#66bb6a", "JPG") },
  jpeg:  { svg: fileIcon("#424b56", "#66bb6a", "JPG") },
  gif:   { svg: fileIcon("#424b56", "#66bb6a", "GIF") },
  webp:  { svg: fileIcon("#424b56", "#66bb6a", "WBP") },
  ico:   { svg: fileIcon("#424b56", "#66bb6a", "ICO") },
  icns:  { svg: fileIcon("#424b56", "#66bb6a", "ICN") },

  // Fonts
  ttf:   { svg: fileIcon("#424b56", "#ec407a", "TTF") },
  otf:   { svg: fileIcon("#424b56", "#ec407a", "OTF") },
  woff:  { svg: fileIcon("#424b56", "#ec407a", "WF") },
  woff2: { svg: fileIcon("#424b56", "#ec407a", "WF2") },

  // Package / Lock
  lock:  { svg: fileIcon("#424b56", "#78909c", "LCK") },

  // Binary / Misc
  wasm:  { svg: langIcon("#654ff0", "WA") },
  exe:   { svg: fileIcon("#424b56", "#78909c", "EXE") },
  dll:   { svg: fileIcon("#424b56", "#78909c", "DLL") },
  so:    { svg: fileIcon("#424b56", "#78909c", "SO") },
};

// Special filename mappings (exact match)
const FILENAME_ICON_MAP: Record<string, FileIcon> = {
  "package.json":      { svg: langIcon("#8bc34a", "NP") },
  "package-lock.json": { svg: langIcon("#8bc34a", "NP") },
  "tsconfig.json":     { svg: langIcon("#3178c6", "TS") },
  "jsconfig.json":     { svg: langIcon("#f5de19", "JS") },
  ".gitignore":        { svg: langIcon("#f44336", "GI") },
  ".gitattributes":    { svg: langIcon("#f44336", "GA") },
  ".eslintrc":         { svg: langIcon("#4b32c3", "ES") },
  ".eslintrc.js":      { svg: langIcon("#4b32c3", "ES") },
  ".eslintrc.json":    { svg: langIcon("#4b32c3", "ES") },
  ".prettierrc":       { svg: langIcon("#56b3b4", "PR") },
  ".prettierrc.json":  { svg: langIcon("#56b3b4", "PR") },
  "prettier.config.js":{ svg: langIcon("#56b3b4", "PR") },
  "vite.config.ts":    { svg: langIcon("#646cff", "Vi") },
  "vite.config.js":    { svg: langIcon("#646cff", "Vi") },
  "webpack.config.js": { svg: langIcon("#8dd6f9", "WP") },
  "rollup.config.js":  { svg: langIcon("#ff3333", "RL") },
  "Cargo.toml":        { svg: langIcon("#ff5722", "Cg") },
  "Cargo.lock":        { svg: langIcon("#ff5722", "Cg") },
  "Makefile":          { svg: langIcon("#e65100", "Mk") },
  "Dockerfile":        { svg: langIcon("#2496ed", "Dk") },
  "docker-compose.yml":{ svg: langIcon("#2496ed", "Dk") },
  "docker-compose.yaml":{ svg: langIcon("#2496ed", "Dk") },
  ".dockerignore":     { svg: langIcon("#2496ed", "Dk") },
  "LICENSE":           { svg: fileIcon("#424b56", "#fdd835", "LIC") },
  "LICENSE.md":        { svg: fileIcon("#424b56", "#fdd835", "LIC") },
  "README.md":         { svg: langIcon("#42a5f5", "R") },
  ".env":              { svg: fileIcon("#424b56", "#fdd835", "ENV") },
  ".env.local":        { svg: fileIcon("#424b56", "#fdd835", "ENV") },
  ".env.development":  { svg: fileIcon("#424b56", "#fdd835", "ENV") },
  ".env.production":   { svg: fileIcon("#424b56", "#fdd835", "ENV") },
  "tailwind.config.js":{ svg: langIcon("#06b6d4", "TW") },
  "tailwind.config.ts":{ svg: langIcon("#06b6d4", "TW") },
  "postcss.config.js": { svg: langIcon("#dd3735", "PC") },
  "babel.config.js":   { svg: langIcon("#f5da55", "Ba") },
  ".babelrc":          { svg: langIcon("#f5da55", "Ba") },
  "jest.config.js":    { svg: langIcon("#c21325", "Je") },
  "jest.config.ts":    { svg: langIcon("#c21325", "Je") },
  "vitest.config.ts":  { svg: langIcon("#6da13f", "Vt") },
  "pnpm-lock.yaml":    { svg: langIcon("#f69220", "PN") },
  "yarn.lock":         { svg: langIcon("#2c8ebb", "YN") },
  "bun.lockb":         { svg: langIcon("#f472b6", "BN") },
  "deno.json":         { svg: langIcon("#000000", "Dn") },
};

const runtimeFileIconThemes = new Map<string, RuntimeFileIconTheme>();
let activeRuntimeFileIconThemeId = "";

export function registerRuntimeFileIconThemes(themes: RuntimeFileIconTheme[]) {
  runtimeFileIconThemes.clear();
  for (const theme of themes) {
    runtimeFileIconThemes.set(theme.id, theme);
  }
}

export function setActiveRuntimeFileIconTheme(themeId: string) {
  activeRuntimeFileIconThemeId = themeId;
}

export function getRuntimeFileIconTheme(themeId: string): RuntimeFileIconTheme | null {
  return runtimeFileIconThemes.get(themeId) ?? null;
}

export function getRuntimeFileIconThemes(): RuntimeFileIconTheme[] {
  return Array.from(runtimeFileIconThemes.values());
}

function getActiveRuntimeTheme(): RuntimeFileIconTheme | null {
  return activeRuntimeFileIconThemeId ? runtimeFileIconThemes.get(activeRuntimeFileIconThemeId) ?? null : null;
}

export function getAthvaSpecialEntry(name: string, isDir: boolean): AthvaSpecialEntry | null {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();

  if (isDir) {
    if (lower === "docs") {
      return { kind: "docs-folder", label: "DOCS", accent: "#59b6ff" };
    }
    if (lower === "contexts") {
      return { kind: "contexts-folder", label: "CTX", accent: "#7ce3c4" };
    }
    if (lower === "extensions") {
      return { kind: "extensions-folder", label: "EXT", accent: "#d78bff" };
    }
    return null;
  }

  const baseName = lower.replace(/\.(md|txt|json)$/, "");
  if (baseName === "todo" || baseName === "todos") {
    return { kind: "todo-file", label: "TODO", accent: "#ffb74d" };
  }

  const ext = lower.split(".").pop() || "";
  if (ext === "csv" || ext === "xlsx" || ext === "xls") {
    return { kind: "spreadsheet-file", label: ext === "csv" ? "CSV" : "XLS", accent: "#7ad97a" };
  }
  if (ext === "txt") {
    return { kind: "text-file", label: "TXT", accent: "#c7d2da" };
  }
  if (ext === "flow") {
    return { kind: "flow-file", label: "FLOW", accent: "#67c6ff" };
  }
  if (ext === "vsix") {
    return { kind: "extension-file", label: "EXT", accent: "#d78bff" };
  }

  return null;
}

export function getAthvaSpecialEntryGuide(): AthvaSpecialGuideSection[] {
  return [
    {
      title: "Special folders",
      items: [
        {
          label: "DOCS",
          pattern: "docs/",
          useCase: "Project docs, specs, and reference notes.",
          accent: "#59b6ff",
        },
        {
          label: "CTX",
          pattern: "contexts/",
          useCase: "Agent context packs, prompts, and working state.",
          accent: "#7ce3c4",
        },
        {
          label: "EXT",
          pattern: "extensions/",
          useCase: "Installed extension bundles and extension assets.",
          accent: "#d78bff",
        },
      ],
    },
    {
      title: "Special names",
      items: [
        {
          label: "TODO",
          pattern: "todo.* / todos.*",
          useCase: "Task lists, pending work, and execution checkpoints.",
          accent: "#ffb74d",
        },
      ],
    },
    {
      title: "Special extensions",
      items: [
        {
          label: "CSV",
          pattern: ".csv",
          useCase: "Flat tabular data for imports, exports, and quick analysis.",
          accent: "#7ad97a",
        },
        {
          label: "XLS",
          pattern: ".xlsx, .xls",
          useCase: "Spreadsheet workbooks with structured sheets and formulas.",
          accent: "#7ad97a",
        },
        {
          label: "TXT",
          pattern: ".txt",
          useCase: "Plain text notes, dumps, and scratch output.",
          accent: "#c7d2da",
        },
        {
          label: "FLOW",
          pattern: ".flow",
          useCase: "Flow definitions, process maps, or execution diagrams.",
          accent: "#67c6ff",
        },
        {
          label: "EXT",
          pattern: ".vsix",
          useCase: "VS Code extension packages ready to import or inspect.",
          accent: "#d78bff",
        },
      ],
    },
  ];
}

// ── Public API ──

export function getFolderIcon(name: string, isOpen: boolean): string {
  const runtimeTheme = getActiveRuntimeTheme();
  if (runtimeTheme) {
    const lowerName = name.toLowerCase();
    const themedIcon = isOpen
      ? runtimeTheme.foldersExpandedByName[lowerName] || runtimeTheme.foldersByName[lowerName] || runtimeTheme.defaultFolderExpanded || runtimeTheme.defaultFolder
      : runtimeTheme.foldersByName[lowerName] || runtimeTheme.defaultFolder;
    if (themedIcon) return themedIcon;
  }
  const style = FOLDER_STYLES[name.toLowerCase()] || { color: DEFAULT_FOLDER_COLOR };
  return isOpen ? FOLDER_OPEN(style.color) : FOLDER_CLOSED(style.color);
}

export function getFileIcon(filename: string): string {
  const runtimeTheme = getActiveRuntimeTheme();
  if (runtimeTheme) {
    const lowerName = filename.toLowerCase();
    const byName = runtimeTheme.filesByName[filename] || runtimeTheme.filesByName[lowerName];
    if (byName) return byName;
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const byExt = runtimeTheme.filesByExtension[ext];
    if (byExt) return byExt;
    if (runtimeTheme.defaultFile) return runtimeTheme.defaultFile;
  }

  // Check exact filename first
  const nameIcon = FILENAME_ICON_MAP[filename];
  if (nameIcon) return nameIcon.svg;

  // Check lowercase filename
  const lowerIcon = FILENAME_ICON_MAP[filename.toLowerCase()];
  if (lowerIcon) return lowerIcon.svg;

  // Check extension
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const extIcon = FILE_ICON_MAP[ext];
  if (extIcon) return extIcon.svg;

  // Check if it's a dotfile starting with .
  if (filename.startsWith(".")) {
    return fileIcon("#424b56", "#78909c", "CFG");
  }

  return FILE_DEFAULT;
}
