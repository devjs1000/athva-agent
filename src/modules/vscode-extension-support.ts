import { invoke } from "@tauri-apps/api/core";
import type { RuntimeFileIconTheme } from "./file-icons";
import type { SnippetEntry } from "./snippet-store";
import type { ThemeColors } from "./settings";
import type { RuntimeThemeDefinition } from "./theme-engine";

export interface InstalledExtensionRecord {
  identifier: string;
  publisher: string;
  extension_name: string;
  display_name: string;
  description: string;
  version: string;
  install_path: string;
}

export interface ExtensionThemeChoice {
  id: string;
  label: string;
}

export interface ExtensionIconThemeChoice {
  id: string;
  label: string;
}

export interface ExtensionCommand {
  command: string;
  title: string;
  category?: string;
  iconCodicon?: string;
}

export interface ExtensionMenuContribution {
  command: string;
  group?: string;
  when?: string;
}

export interface ExtensionViewContainer {
  id: string;
  title: string;
  icon?: string;
  iconSvg?: string;
  extensionIdentifier: string;
  hasRuntime: boolean;
}

export interface ExtensionView {
  id: string;
  name: string;
  containerId: string;
}

export interface ExtensionLanguage {
  id: string;
  aliases: string[];
  extensions: string[];
}

export interface ExtensionCompatibilityIssue {
  code: string;
  title: string;
  summary: string;
  details: string[];
}

export interface ExtensionSupportSnapshot {
  identifier: string;
  displayName: string;
  version: string;
  description: string;
  readme: string;
  colorThemes: ExtensionThemeChoice[];
  fileIconThemes: ExtensionIconThemeChoice[];
  snippetCount: number;
  supportedFeatures: string[];
  unsupportedFeatures: string[];
  compatibilityIssues: ExtensionCompatibilityIssue[];
  commands: ExtensionCommand[];
  menus: ExtensionMenuContribution[];
  viewContainers: ExtensionViewContainer[];
  views: ExtensionView[];
  languages: ExtensionLanguage[];
  hasRuntime: boolean;
  runtimeMain?: string;
}

export interface ResolvedExtensionsSupport {
  supportByIdentifier: Map<string, ExtensionSupportSnapshot>;
  runtimeThemes: RuntimeThemeDefinition[];
  runtimeFileIconThemes: RuntimeFileIconTheme[];
  snippets: SnippetEntry[];
  allCommands: ExtensionCommand[];
  allMenuContributions: ExtensionMenuContribution[];
  allViewContainers: ExtensionViewContainer[];
  allViews: ExtensionView[];
  allLanguages: ExtensionLanguage[];
}

interface ManifestThemeContribution {
  id?: string;
  label?: string;
  path?: string;
  uiTheme?: string;
}

interface ManifestIconThemeContribution {
  id?: string;
  label?: string;
  path?: string;
}

const README_CANDIDATES = [
  "extension/README.md",
  "extension/readme.md",
  "README.md",
  "readme.md",
];

const LANGUAGE_CATEGORY_MAP: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  typescriptreact: "react",
  javascriptreact: "react",
  html: "html",
  css: "css",
  scss: "css",
  less: "css",
  python: "python",
};

export async function loadInstalledExtensionSupport(
  installed: InstalledExtensionRecord[]
): Promise<ResolvedExtensionsSupport> {
  const supportByIdentifier = new Map<string, ExtensionSupportSnapshot>();
  const runtimeThemes: RuntimeThemeDefinition[] = [];
  const runtimeFileIconThemes: RuntimeFileIconTheme[] = [];
  const snippets: SnippetEntry[] = [];
  const allCommands: ExtensionCommand[] = [];
  const allMenuContributions: ExtensionMenuContribution[] = [];
  const allViewContainers: ExtensionViewContainer[] = [];
  const allViews: ExtensionView[] = [];
  const allLanguages: ExtensionLanguage[] = [];

  for (const extension of installed) {
    const manifest = await readExtensionManifest(extension.install_path);
    if (!manifest) {
      supportByIdentifier.set(extension.identifier, {
        identifier: extension.identifier,
        displayName: extension.display_name,
        version: extension.version,
        description: extension.description,
        readme: "",
        colorThemes: [],
        fileIconThemes: [],
        snippetCount: 0,
        supportedFeatures: [],
        unsupportedFeatures: ["Manifest unreadable"],
        compatibilityIssues: [{
          code: "manifest.unreadable",
          title: "Manifest could not be read",
          summary: "Athva could not inspect this extension package, so compatibility could not be determined.",
          details: [
            "The extension manifest package.json could not be loaded from the installed VSIX.",
            "Reinstall the extension if the package looks incomplete or corrupted.",
          ],
        }],
        commands: [],
        menus: [],
        viewContainers: [],
        views: [],
        languages: [],
        hasRuntime: false,
        runtimeMain: undefined,
      });
      continue;
    }

    const readme = await readFirstTextFile(
      README_CANDIDATES.map((candidate) => joinFsPath(extension.install_path, candidate))
    );
    const colorThemes = await loadColorThemes(extension.identifier, extension.display_name, extension.install_path, manifest);
    const iconThemes = await loadIconThemes(extension.identifier, extension.display_name, extension.install_path, manifest);
    const extensionSnippets = await loadSnippets(extension.identifier, extension.install_path, manifest);
    const commands = parseCommands(manifest);
    const menus = parseMenus(manifest);
    const viewContainers = await parseViewContainers(extension.identifier, extension.install_path, manifest);
    const views = parseViews(manifest);
    const languages = parseLanguages(manifest);

    runtimeThemes.push(...colorThemes);
    runtimeFileIconThemes.push(...iconThemes);
    snippets.push(...extensionSnippets);
    allCommands.push(...commands);
    allMenuContributions.push(...menus);
    allViewContainers.push(...viewContainers);
    allViews.push(...views);
    allLanguages.push(...languages);

    const supportedFeatures: string[] = [];
    const compatibilityIssues = collectCompatibilityIssues(manifest);
    const unsupportedFeatures = compatibilityIssues.map((issue) => issue.title);

    if (colorThemes.length) supportedFeatures.push(`${colorThemes.length} color theme${colorThemes.length === 1 ? "" : "s"}`);
    if (iconThemes.length) supportedFeatures.push(`${iconThemes.length} file icon theme${iconThemes.length === 1 ? "" : "s"}`);
    if (extensionSnippets.length) supportedFeatures.push(`${extensionSnippets.length} snippet${extensionSnippets.length === 1 ? "" : "s"}`);
    if (commands.length) supportedFeatures.push(`${commands.length} command${commands.length === 1 ? "" : "s"}`);
    if (menus.length) supportedFeatures.push(`${menus.length} menu contribution${menus.length === 1 ? "" : "s"}`);
    if (manifest?.main || manifest?.browser) supportedFeatures.push("Runtime execution (beta)");
    if (viewContainers.length) supportedFeatures.push(`${viewContainers.length} activity bar panel${viewContainers.length === 1 ? "" : "s"}`);
    if (languages.length) supportedFeatures.push(`${languages.length} language${languages.length === 1 ? "" : "s"} (metadata)`);

    supportByIdentifier.set(extension.identifier, {
      identifier: extension.identifier,
      displayName: extension.display_name,
      version: extension.version,
      description: extension.description,
      readme,
      colorThemes: colorThemes.map((theme) => ({ id: theme.id, label: theme.name })),
      fileIconThemes: iconThemes.map((theme) => ({ id: theme.id, label: theme.label })),
      snippetCount: extensionSnippets.length,
      supportedFeatures,
      unsupportedFeatures,
      compatibilityIssues,
      commands,
      menus,
      viewContainers,
      views,
      languages,
      hasRuntime: !!(manifest?.main || manifest?.browser),
      runtimeMain: manifest?.main || manifest?.browser || undefined,
    });
  }

  return { supportByIdentifier, runtimeThemes, runtimeFileIconThemes, snippets, allCommands, allMenuContributions, allViewContainers, allViews, allLanguages };
}

async function readExtensionManifest(installPath: string): Promise<any | null> {
  const manifestCandidates = [
    { manifest: joinFsPath(installPath, "extension/package.json"), base: joinFsPath(installPath, "extension") },
    { manifest: joinFsPath(installPath, "package.json"), base: installPath },
  ];

  for (const { manifest: manifestPath, base } of manifestCandidates) {
    try {
      const raw = await invoke<string>("read_file", { path: manifestPath });
      const parsed = parseJsonc(raw);
      if (!parsed) continue;
      const nls = await loadNls(base);
      return nls ? applyNls(parsed, nls) : parsed;
    } catch {
      continue;
    }
  }

  return null;
}

async function loadNls(base: string): Promise<Record<string, string> | null> {
  const candidates = [
    joinFsPath(base, "package.nls.json"),
    joinFsPath(base, "package.nls.en.json"),
  ];
  for (const path of candidates) {
    const raw = await readTextFileSafe(path);
    if (!raw) continue;
    const parsed = parseJsonc(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  }
  return null;
}

function applyNls(value: unknown, nls: Record<string, string>): unknown {
  if (typeof value === "string") {
    const match = value.match(/^%(.+)%$/);
    if (match) return nls[match[1]] ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => applyNls(item, nls));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = applyNls(v, nls);
    }
    return result;
  }
  return value;
}

async function loadColorThemes(
  extensionIdentifier: string,
  extensionName: string,
  installPath: string,
  manifest: any
): Promise<RuntimeThemeDefinition[]> {
  const contributes = manifest?.contributes ?? {};
  const themes = Array.isArray(contributes.themes) ? contributes.themes as ManifestThemeContribution[] : [];
  const loaded: RuntimeThemeDefinition[] = [];

  for (let index = 0; index < themes.length; index += 1) {
    const theme = themes[index];
    if (!theme?.path) continue;
    const themePath = resolveContributionPath(installPath, theme.path);
    const raw = await readTextFileSafe(themePath);
    if (!raw) continue;
    const parsed = parseJsonc(raw);
    if (!parsed) continue;

    const id = makeRuntimeContributionId("ext-theme", extensionIdentifier, theme.id || theme.label || index);
    loaded.push({
      id,
      name: theme.label || parsed.name || `${extensionName} Theme ${index + 1}`,
      colors: deriveWorkbenchColors(parsed.colors || {}, theme.uiTheme || parsed.type || ""),
      monacoTheme: {
        base: isLightTheme(theme.uiTheme || parsed.type || "") ? "vs" : "vs-dark",
        inherit: true,
        rules: buildMonacoRules(parsed.tokenColors, parsed.semanticTokenColors),
        colors: normalizeMonacoThemeColors(parsed.colors || {}, theme.uiTheme || parsed.type || ""),
      },
    });
  }

  return loaded;
}

async function loadIconThemes(
  extensionIdentifier: string,
  extensionName: string,
  installPath: string,
  manifest: any
): Promise<RuntimeFileIconTheme[]> {
  const contributes = manifest?.contributes ?? {};
  const iconThemes = Array.isArray(contributes.iconThemes) ? contributes.iconThemes as ManifestIconThemeContribution[] : [];
  const loaded: RuntimeFileIconTheme[] = [];

  for (let index = 0; index < iconThemes.length; index += 1) {
    const iconTheme = iconThemes[index];
    if (!iconTheme?.path) continue;
    const themePath = resolveContributionPath(installPath, iconTheme.path);
    const raw = await readTextFileSafe(themePath);
    if (!raw) continue;
    const parsed = parseJsonc(raw);
    if (!parsed) continue;

    const iconDefinitions = parsed.iconDefinitions || {};
    const defaultFile = await resolveThemeIconHtml(themePath, iconDefinitions[parsed.file]);
    const defaultFolder = await resolveThemeIconHtml(themePath, iconDefinitions[parsed.folder]);
    const defaultFolderExpanded = await resolveThemeIconHtml(themePath, iconDefinitions[parsed.folderExpanded]);
    const filesByName = await resolveThemeIconMap(themePath, parsed.fileNames || {}, iconDefinitions);
    const filesByExtension = await resolveThemeIconMap(themePath, parsed.fileExtensions || {}, iconDefinitions);
    const foldersByName = await resolveThemeIconMap(themePath, parsed.folderNames || {}, iconDefinitions);
    const foldersExpandedByName = await resolveThemeIconMap(themePath, parsed.folderNamesExpanded || {}, iconDefinitions);

    loaded.push({
      id: makeRuntimeContributionId("ext-icons", extensionIdentifier, iconTheme.id || iconTheme.label || index),
      label: iconTheme.label || `${extensionName} Icons ${index + 1}`,
      extensionIdentifier,
      defaultFile: defaultFile || undefined,
      defaultFolder: defaultFolder || undefined,
      defaultFolderExpanded: defaultFolderExpanded || undefined,
      filesByName,
      filesByExtension,
      foldersByName,
      foldersExpandedByName,
    });
  }

  return loaded;
}

async function loadSnippets(
  extensionIdentifier: string,
  installPath: string,
  manifest: any
): Promise<SnippetEntry[]> {
  const contributes = manifest?.contributes ?? {};
  const snippetDefs = Array.isArray(contributes.snippets) ? contributes.snippets : [];
  const snippets: SnippetEntry[] = [];

  for (const snippetDef of snippetDefs) {
    const language = LANGUAGE_CATEGORY_MAP[String(snippetDef?.language || "").toLowerCase()];
    if (!language || !snippetDef?.path) continue;
    const snippetPath = resolveContributionPath(installPath, snippetDef.path);
    const raw = await readTextFileSafe(snippetPath);
    if (!raw) continue;
    const parsed = parseJsonc(raw);
    if (!parsed || typeof parsed !== "object") continue;

    for (const [label, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const prefixValue = Array.isArray((value as any).prefix)
        ? (value as any).prefix[0]
        : (value as any).prefix;
      const bodyValue = Array.isArray((value as any).body)
        ? (value as any).body.join("\n")
        : (value as any).body;
      if (!prefixValue || !bodyValue) continue;

      snippets.push({
        id: `extension:${extensionIdentifier}:${language}:${String(prefixValue)}:${String(label)}`,
        category: language,
        prefix: String(prefixValue),
        label: String(label),
        description: String((value as any).description || ""),
        body: String(bodyValue),
        source: `extension:${extensionIdentifier}`,
      });
    }
  }

  return snippets;
}

function parseCommands(manifest: any): ExtensionCommand[] {
  const raw = manifest?.contributes?.commands;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item: any) => item && typeof item.command === "string" && item.command)
    .map((item: any) => ({
      command: String(item.command),
      title: String(item.title || item.command),
      category: item.category ? String(item.category) : undefined,
      iconCodicon: typeof item.icon === "string" && item.icon.startsWith("$(") ? item.icon : undefined,
    }));
}

function parseMenus(manifest: any): ExtensionMenuContribution[] {
  const menus = manifest?.contributes?.menus;
  if (!menus || typeof menus !== "object") return [];
  const result: ExtensionMenuContribution[] = [];
  for (const entries of Object.values(menus)) {
    if (!Array.isArray(entries)) continue;
    for (const item of entries as any[]) {
      if (!item || typeof item.command !== "string" || !item.command) continue;
      result.push({
        command: String(item.command),
        group: typeof item.group === "string" ? String(item.group) : undefined,
        when: typeof item.when === "string" ? String(item.when) : undefined,
      });
    }
  }
  return result;
}

async function parseViewContainers(extensionIdentifier: string, installPath: string, manifest: any): Promise<ExtensionViewContainer[]> {
  const contributes = manifest?.contributes ?? {};
  const activitybar = Array.isArray(contributes.viewsContainers?.activitybar)
    ? contributes.viewsContainers.activitybar
    : [];
  const hasRuntime = !!(manifest?.main || manifest?.browser);

  const result: ExtensionViewContainer[] = [];
  for (const item of activitybar) {
    if (!item || typeof item.id !== "string") continue;
    let iconSvg: string | undefined;
    if (typeof item.icon === "string" && item.icon.trim()) {
      const iconPath = resolveContributionPath(installPath, item.icon);
      if (iconPath.toLowerCase().endsWith(".svg")) {
        iconSvg = (await readTextFileSafe(iconPath)) || undefined;
      }
    }
    result.push({
      id: String(item.id),
      title: String(item.title || item.id),
      icon: typeof item.icon === "string" ? item.icon : undefined,
      iconSvg: iconSvg || undefined,
      extensionIdentifier,
      hasRuntime,
    });
  }
  return result;
}

function parseViews(manifest: any): ExtensionView[] {
  const viewsMap = manifest?.contributes?.views;
  if (!viewsMap || typeof viewsMap !== "object") return [];
  const result: ExtensionView[] = [];
  for (const [containerId, viewList] of Object.entries(viewsMap)) {
    if (!Array.isArray(viewList)) continue;
    for (const item of viewList as any[]) {
      if (!item || typeof item.id !== "string") continue;
      result.push({
        id: String(item.id),
        name: String(item.name || item.id),
        containerId,
      });
    }
  }
  return result;
}

function parseLanguages(manifest: any): ExtensionLanguage[] {
  const raw = manifest?.contributes?.languages;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item: any) => item && typeof item.id === "string" && item.id)
    .map((item: any) => ({
      id: String(item.id),
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
      extensions: Array.isArray(item.extensions) ? item.extensions.map(String) : [],
    }));
}

function collectCompatibilityIssues(manifest: any): ExtensionCompatibilityIssue[] {
  const issues = new Map<string, ExtensionCompatibilityIssue>();
  const contributes = manifest?.contributes ?? {};

  // Runtime-backed extensions are supported in Athva via the extension host bridge.
  if (Array.isArray(contributes.grammars) && contributes.grammars.length) {
    const grammarCount = contributes.grammars.length;
    issues.set("grammar.textmate", {
      code: "grammar.textmate",
      title: "TextMate grammars are not loaded",
      summary: "Athva does not import VS Code TextMate grammar tokenization from extensions yet.",
      details: [
        `package.json: contributes.grammars count=${grammarCount}`,
        "Custom syntax highlighting rules from contributes.grammars will be ignored.",
        "Language metadata may still load, but token colors can differ from VS Code.",
      ],
    });
  }
  if (Array.isArray(contributes.debuggers) || Array.isArray(contributes.taskDefinitions)) {
    const debugCount = Array.isArray(contributes.debuggers) ? contributes.debuggers.length : 0;
    const taskCount = Array.isArray(contributes.taskDefinitions) ? contributes.taskDefinitions.length : 0;
    issues.set("workbench.debug-task", {
      code: "workbench.debug-task",
      title: "Debugger and task integrations are unavailable",
      summary: "VS Code debugger adapters and contributed task definitions are not wired into Athva.",
      details: [
        ...(debugCount ? [`package.json: contributes.debuggers count=${debugCount}`] : []),
        ...(taskCount ? [`package.json: contributes.taskDefinitions count=${taskCount}`] : []),
        "Launch configurations and task providers from this extension will not execute.",
        "Use Athva's native run flows instead of extension-provided debug/task actions.",
      ],
    });
  }
  if (Array.isArray(contributes.configurationDefaults) || Array.isArray(contributes.configuration)) {
    const configurationCount = Array.isArray(contributes.configuration) ? contributes.configuration.length : 0;
    const defaultsCount = Array.isArray(contributes.configurationDefaults) ? contributes.configurationDefaults.length : 0;
    const propertyKeys = new Set<string>();
    if (Array.isArray(contributes.configuration)) {
      for (const entry of contributes.configuration) {
        const props = entry?.properties;
        if (props && typeof props === "object") {
          for (const key of Object.keys(props)) propertyKeys.add(key);
        }
      }
    }
    const propertySample = Array.from(propertyKeys).slice(0, 10);
    issues.set("config.vscode-api", {
      code: "config.vscode-api",
      title: "VS Code configuration APIs are incomplete",
      summary: "The extension contributes settings that Athva does not fully surface or apply.",
      details: [
        ...(configurationCount ? [`package.json: contributes.configuration count=${configurationCount}`] : []),
        ...(defaultsCount ? [`package.json: contributes.configurationDefaults count=${defaultsCount}`] : []),
        ...(propertySample.length ? [`settings keys (sample): ${propertySample.join(", ")}`] : []),
        "contributes.configuration and configurationDefaults entries were detected.",
        "Extension-specific settings UI and config-driven behaviors may be missing.",
      ],
    });
  }
  // Notebook APIs are partially shimmed in the extension host; do not hard-block
  // notebook-capable extensions at compatibility-scan time.

  return Array.from(issues.values());
}

function deriveWorkbenchColors(colors: Record<string, string>, uiTheme: string): ThemeColors {
  const fallbackLight = isLightTheme(uiTheme);
  const fallback = fallbackLight
    ? {
        topBar: "#f3f3f3",
        bottomBar: "#007acc",
        leftSidebar: "#f3f3f3",
        rightPanels: "#f3f3f3",
        accent: "#0066b8",
        editorBg: "#ffffff",
      }
    : {
        topBar: "#252526",
        bottomBar: "#007acc",
        leftSidebar: "#252526",
        rightPanels: "#252526",
        accent: "#0078d4",
        editorBg: "#1e1e1e",
      };

  return {
    topBar: firstColor(colors, ["titleBar.activeBackground", "activityBar.background", "editorGroupHeader.tabsBackground"], fallback.topBar),
    bottomBar: firstColor(colors, ["statusBar.background", "activityBar.background"], fallback.bottomBar),
    leftSidebar: firstColor(colors, ["sideBar.background", "activityBar.background"], fallback.leftSidebar),
    rightPanels: firstColor(colors, ["panel.background", "sideBar.background"], fallback.rightPanels),
    accent: firstColor(colors, ["button.background", "focusBorder", "list.highlightForeground"], fallback.accent),
    editorBg: firstColor(colors, ["editor.background"], fallback.editorBg),
  };
}

function normalizeMonacoThemeColors(input: Record<string, unknown>, uiTheme: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizeHexColor(value);
    if (normalized) {
      result[key] = normalized;
    }
  }
  if (!result["editor.foreground"]) {
    result["editor.foreground"] = isLightTheme(uiTheme) ? "#1f1f1f" : "#d4d4d4";
  }
  if (!result["editor.background"]) {
    result["editor.background"] = isLightTheme(uiTheme) ? "#ffffff" : "#1e1e1e";
  }
  return result;
}

function buildMonacoRules(
  tokenColors: unknown,
  semanticTokenColors?: unknown
): Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }> {
  const rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }> = [];
  const seen = new Set<string>();

  const pushRule = (token: string, foreground?: string, background?: string, fontStyle?: string) => {
    if (!token) return;
    const key = `${token}|${foreground || ""}|${background || ""}|${fontStyle || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ token, foreground: foreground || undefined, background: background || undefined, fontStyle });
  };

  if (Array.isArray(tokenColors)) {
    for (const item of tokenColors) {
      const scopes = Array.isArray((item as any)?.scope)
        ? (item as any).scope
        : typeof (item as any)?.scope === "string"
          ? String((item as any).scope).split(",")
          : [];
      const settings = (item as any)?.settings ?? {};
      const foreground = normalizeMonacoRuleColor(settings.foreground);
      const background = normalizeMonacoRuleColor(settings.background);
      const fontStyle = normalizeThemeFontStyle(settings);

      for (const rawScope of scopes) {
        const scope = String(rawScope || "").trim();
        if (!scope) continue;
        pushRule(scope, foreground, background, fontStyle);
        for (const token of mapScopeToMonacoTokens(scope)) {
          pushRule(token, foreground, background, fontStyle);
        }
      }
    }
  }

  if (semanticTokenColors && typeof semanticTokenColors === "object") {
    for (const [selector, rawValue] of Object.entries(semanticTokenColors as Record<string, unknown>)) {
      const settings = normalizeSemanticSettings(rawValue);
      if (!settings) continue;
      for (const token of mapSemanticSelectorToMonacoTokens(selector)) {
        pushRule(token, settings.foreground, settings.background, settings.fontStyle);
      }
    }
  }

  return rules;
}

function mapScopeToMonacoTokens(scope: string): string[] {
  const normalized = scope.toLowerCase();
  const tokens = new Set<string>();

  if (normalized.includes("comment")) tokens.add("comment");
  if (normalized.includes("string.regexp")) tokens.add("regexp");
  if (normalized.includes("string")) tokens.add("string");
  if (normalized.includes("keyword") || normalized.includes("storage")) tokens.add("keyword");
  if (normalized.includes("number") || normalized.includes("constant.numeric")) tokens.add("number");
  if (normalized.includes("constant.language")) tokens.add("keyword");
  if (normalized.includes("constant")) tokens.add("constant");
  if (normalized.includes("entity.name.function") || normalized.includes("support.function") || normalized.includes("meta.function-call")) {
    tokens.add("function");
  }
  if (normalized.includes("entity.name.type") || normalized.includes("support.type") || normalized.includes("storage.type.class")) {
    tokens.add("type");
    tokens.add("type.identifier");
  }
  if (normalized.includes("entity.name.class")) tokens.add("type.identifier");
  if (normalized.includes("entity.name.tag")) tokens.add("tag");
  if (normalized.includes("entity.other.attribute-name")) tokens.add("attribute.name");
  if (normalized.includes("variable.parameter")) tokens.add("variable.parameter");
  if (normalized.includes("variable.language")) tokens.add("keyword");
  if (normalized.includes("variable")) tokens.add("variable");
  if (normalized.includes("support.variable.property") || normalized.includes("meta.property")) tokens.add("attribute.name");
  if (normalized.includes("property")) tokens.add("attribute.name");
  if (normalized.includes("punctuation.definition.tag")) tokens.add("delimiter.html");
  if (normalized.includes("punctuation")) tokens.add("delimiter");
  if (normalized.includes("invalid")) tokens.add("invalid");
  if (normalized.includes("namespace")) tokens.add("namespace");
  if (normalized.includes("operator")) tokens.add("operator");

  return Array.from(tokens);
}

function mapSemanticSelectorToMonacoTokens(selector: string): string[] {
  const normalized = selector.toLowerCase();
  const tokens = new Set<string>();

  if (normalized.includes("function")) tokens.add("function");
  if (normalized.includes("method")) tokens.add("function");
  if (normalized.includes("variable")) tokens.add("variable");
  if (normalized.includes("parameter")) tokens.add("variable.parameter");
  if (normalized.includes("property")) tokens.add("attribute.name");
  if (normalized.includes("type")) {
    tokens.add("type");
    tokens.add("type.identifier");
  }
  if (normalized.includes("class")) tokens.add("type.identifier");
  if (normalized.includes("interface")) {
    tokens.add("type");
    tokens.add("type.identifier");
  }
  if (normalized.includes("enum")) tokens.add("type.identifier");
  if (normalized.includes("namespace")) tokens.add("namespace");
  if (normalized.includes("keyword")) tokens.add("keyword");
  if (normalized.includes("string")) tokens.add("string");
  if (normalized.includes("number")) tokens.add("number");
  if (normalized.includes("comment")) tokens.add("comment");

  return Array.from(tokens);
}

function normalizeSemanticSettings(
  rawValue: unknown
): { foreground?: string; background?: string; fontStyle?: string } | null {
  if (typeof rawValue === "string") {
    const foreground = normalizeMonacoRuleColor(rawValue);
    return foreground ? { foreground } : null;
  }
  if (!rawValue || typeof rawValue !== "object") return null;
  const value = rawValue as Record<string, unknown>;
  return {
    foreground: normalizeMonacoRuleColor(value.foreground) || undefined,
    background: normalizeMonacoRuleColor(value.background) || undefined,
    fontStyle: normalizeThemeFontStyle(value) || undefined,
  };
}

function normalizeThemeFontStyle(value: Record<string, unknown>): string | undefined {
  if (typeof value.fontStyle === "string" && value.fontStyle.trim()) {
    return value.fontStyle;
  }
  const styles: string[] = [];
  if (value.italic === true) styles.push("italic");
  if (value.bold === true) styles.push("bold");
  if (value.underline === true) styles.push("underline");
  return styles.length ? styles.join(" ") : undefined;
}

async function resolveThemeIconMap(
  themePath: string,
  mapping: Record<string, string>,
  definitions: Record<string, any>
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, definitionKey] of Object.entries(mapping)) {
    const iconHtml = await resolveThemeIconHtml(themePath, definitions[definitionKey]);
    if (iconHtml) result[key.toLowerCase()] = iconHtml;
  }
  return result;
}

async function resolveThemeIconHtml(themePath: string, definition: any): Promise<string> {
  const iconPath = definition?.iconPath;
  if (typeof iconPath !== "string" || !iconPath.trim()) return "";
  const resolvedPath = resolveRelativePath(dirname(themePath), iconPath);
  if (!resolvedPath.toLowerCase().endsWith(".svg")) return "";
  const rawSvg = await readTextFileSafe(resolvedPath);
  if (!rawSvg) return "";
  return rawSvg.trim();
}

function parseJsonc(raw: string): any | null {
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
}

// String-aware JSONC comment stripper — never touches content inside string literals.
function stripJsonComments(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    // String literal — copy verbatim until closing unescaped quote
    if (ch === '"') {
      out += ch;
      i++;
      while (i < raw.length) {
        const sc = raw[i];
        out += sc;
        if (sc === "\\") {
          i++;
          if (i < raw.length) { out += raw[i]; i++; }
          continue;
        }
        i++;
        if (sc === '"') break;
      }
      continue;
    }
    // Block comment
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Line comment
    if (ch === "/" && raw[i + 1] === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

async function readFirstTextFile(paths: string[]): Promise<string> {
  for (const path of paths) {
    const raw = await readTextFileSafe(path);
    if (raw) return raw;
  }
  return "";
}

async function readTextFileSafe(path: string): Promise<string> {
  try {
    return await invoke<string>("read_file", { path });
  } catch {
    return "";
  }
}

function resolveContributionPath(installPath: string, contributionPath: string): string {
  const normalized = contributionPath.replace(/\\/g, "/");
  const base = normalized.startsWith("extension/") ? installPath : joinFsPath(installPath, "extension");
  return resolveRelativePath(base, normalized);
}

function resolveRelativePath(basePath: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  const parts = `${basePath}/${relativePath}`.replace(/\\/g, "/").split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  const prefix = basePath.startsWith("/") ? "/" : "";
  return `${prefix}${resolved.join("/")}`;
}

function joinFsPath(base: string, suffix: string): string {
  return `${base.replace(/[\\/]+$/, "")}/${suffix.replace(/^[\\/]+/, "")}`;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized : normalized.slice(0, index);
}

function firstColor(source: Record<string, string>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = normalizeHexColor(source[key]);
    if (value) return value;
  }
  return fallback;
}

function normalizeHexColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("#")) return "";
  const hex = trimmed.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("")}`;
  }
  if (/^[0-9a-fA-F]{4}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("")}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) {
    return `#${hex}`;
  }
  return "";
}

function normalizeMonacoRuleColor(value: unknown): string {
  const normalized = normalizeHexColor(value);
  return normalized ? normalized.slice(1) : "";
}

function isLightTheme(uiTheme: string): boolean {
  const lower = uiTheme.toLowerCase();
  return lower.includes("light");
}

function makeRuntimeContributionId(prefix: string, extensionIdentifier: string, localId: string | number): string {
  const raw = `${prefix}-${extensionIdentifier}-${String(localId)}`.toLowerCase();
  return raw.replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
