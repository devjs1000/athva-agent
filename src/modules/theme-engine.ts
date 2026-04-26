import type { AppearanceSettings, ThemeColors } from "./settings";

export interface RuntimeThemeDefinition {
  id: string;
  name: string;
  colors: ThemeColors;
  monacoTheme: {
    base: "vs" | "vs-dark";
    inherit: boolean;
    rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
    colors: Record<string, string>;
  };
}

// Map UI theme → Monaco theme name
export const THEME_TO_MONACO: Record<string, string> = {
  dark: "athva-dark",
  light: "athva-light",
  dracula: "athva-dracula",
  solarized: "athva-solarized",
  nord: "athva-nord",
  catppuccin: "athva-catppuccin",
  "github-dark": "athva-github-dark",
};

// External callback set by main.ts so theme-engine doesn't import Editor
let _setMonacoTheme: ((theme: string) => void) | null = null;
export function registerMonacoThemeSetter(fn: (theme: string) => void) {
  _setMonacoTheme = fn;
}

let _defineMonacoTheme: ((name: string, theme: RuntimeThemeDefinition["monacoTheme"]) => void) | null = null;
export function registerMonacoThemeDefiner(fn: (name: string, theme: RuntimeThemeDefinition["monacoTheme"]) => void) {
  _defineMonacoTheme = fn;
}

// External callback set by main.ts so theme-engine doesn't import TerminalPanel
let _setTerminalTheme: ((colors: ThemeColors, isLight: boolean) => void) | null = null;
export function registerTerminalThemeSetter(fn: (colors: ThemeColors, isLight: boolean) => void) {
  _setTerminalTheme = fn;
}

export const PRESET_THEMES: Record<string, ThemeColors & { label: string }> = {
  dark: {
    label: "Dark",
    topBar: "#252526",
    bottomBar: "#007acc",
    leftSidebar: "#252526",
    rightPanels: "#252526",
    accent: "#0078d4",
    editorBg: "#1e1e1e",
  },
  light: {
    label: "Light",
    topBar: "#f3f3f3",
    bottomBar: "#007acc",
    leftSidebar: "#f3f3f3",
    rightPanels: "#f3f3f3",
    accent: "#0066b8",
    editorBg: "#ffffff",
  },
  dracula: {
    label: "Dracula",
    topBar: "#282a36",
    bottomBar: "#6272a4",
    leftSidebar: "#282a36",
    rightPanels: "#282a36",
    accent: "#bd93f9",
    editorBg: "#1e1f29",
  },
  solarized: {
    label: "Solarized",
    topBar: "#002b36",
    bottomBar: "#073642",
    leftSidebar: "#002b36",
    rightPanels: "#002b36",
    accent: "#268bd2",
    editorBg: "#002b36",
  },
  nord: {
    label: "Nord",
    topBar: "#2e3440",
    bottomBar: "#3b4252",
    leftSidebar: "#2e3440",
    rightPanels: "#2e3440",
    accent: "#88c0d0",
    editorBg: "#2e3440",
  },
  catppuccin: {
    label: "Catppuccin",
    topBar: "#1e1e2e",
    bottomBar: "#313244",
    leftSidebar: "#1e1e2e",
    rightPanels: "#181825",
    accent: "#cba6f7",
    editorBg: "#1e1e2e",
  },
  "github-dark": {
    label: "GitHub Dark",
    topBar: "#161b22",
    bottomBar: "#21262d",
    leftSidebar: "#161b22",
    rightPanels: "#161b22",
    accent: "#58a6ff",
    editorBg: "#0d1117",
  },
};

const runtimeThemes = new Map<string, RuntimeThemeDefinition>();

export function registerRuntimeThemes(themes: RuntimeThemeDefinition[]) {
  runtimeThemes.clear();
  for (const theme of themes) {
    runtimeThemes.set(theme.id, theme);
    _defineMonacoTheme?.(theme.id, theme.monacoTheme);
  }
}

export function getRuntimeTheme(id: string): RuntimeThemeDefinition | null {
  return runtimeThemes.get(id) ?? null;
}

export function getRuntimeThemes(): RuntimeThemeDefinition[] {
  return Array.from(runtimeThemes.values());
}

export function getThemeColors(appearance: AppearanceSettings): ThemeColors {
  // Look in built-in presets first, then user custom themes
  const preset = PRESET_THEMES[appearance.theme];
  let base: ThemeColors;
  if (preset) {
    base = { ...preset };
  } else {
    const custom = appearance.customThemes.find((t) => t.id === appearance.theme);
    const runtime = runtimeThemes.get(appearance.theme);
    base = custom ? { ...custom.colors } : runtime ? { ...runtime.colors } : { ...PRESET_THEMES.dark };
  }

  // Apply per-area overrides
  const ov = appearance.colorOverrides;
  return {
    topBar: ov.topBar || base.topBar,
    bottomBar: ov.bottomBar || base.bottomBar,
    leftSidebar: ov.leftSidebar || base.leftSidebar,
    rightPanels: ov.rightPanels || base.rightPanels,
    accent: ov.accent || base.accent,
    editorBg: ov.editorBg || base.editorBg,
  };
}

function lighten(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const r = Math.min(255, parseInt(clean.substring(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(clean.substring(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(clean.substring(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function applyTheme(appearance: AppearanceSettings): void {
  const colors = getThemeColors(appearance);
  const root = document.documentElement;

  root.style.setProperty("--top-bar-bg", colors.topBar);
  root.style.setProperty("--bottom-bar-bg", colors.bottomBar);
  root.style.setProperty("--left-sidebar-bg", colors.leftSidebar);
  root.style.setProperty("--right-panels-bg", colors.rightPanels);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-hover", lighten(colors.accent, 20));
  root.style.setProperty("--editor-bg", colors.editorBg);

  // Update bg-primary to match editor bg for consistency
  root.style.setProperty("--bg-primary", colors.editorBg);

  // Derive secondary backgrounds from sidebar color
  const sidebarHex = colors.leftSidebar.replace("#", "");
  const sr = parseInt(sidebarHex.substring(0, 2), 16);
  const sg = parseInt(sidebarHex.substring(2, 4), 16);
  const sb = parseInt(sidebarHex.substring(4, 6), 16);
  const lighter = `#${Math.min(255, sr + 8).toString(16).padStart(2, "0")}${Math.min(255, sg + 8).toString(16).padStart(2, "0")}${Math.min(255, sb + 8).toString(16).padStart(2, "0")}`;
  root.style.setProperty("--bg-secondary", lighter);

  // Set light/dark mode text colors based on brightness of editorBg
  const edHex = colors.editorBg.replace("#", "");
  const er = parseInt(edHex.substring(0, 2), 16);
  const eg = parseInt(edHex.substring(2, 4), 16);
  const eb = parseInt(edHex.substring(4, 6), 16);
  const brightness = (er * 299 + eg * 587 + eb * 114) / 1000;
  if (brightness > 128) {
    root.style.setProperty("--text-primary", "#1f1f1f");
    root.style.setProperty("--text-secondary", "#555555");
    root.style.setProperty("--text-muted", "#888888");
    root.style.setProperty("--border", "#d0d0d0");
    root.style.setProperty("--bg-hover", "rgba(0,0,0,0.05)");
    root.style.setProperty("--bg-active", "rgba(0,0,0,0.1)");
    root.style.setProperty("--bg-input", "#f0f0f0");
  } else {
    root.style.setProperty("--text-primary", "#cccccc");
    root.style.setProperty("--text-secondary", "#969696");
    root.style.setProperty("--text-muted", "#6e6e6e");
    root.style.setProperty("--border", "#3c3c3c");
    root.style.setProperty("--bg-hover", "#2a2d2e");
    root.style.setProperty("--bg-active", "#37373d");
    root.style.setProperty("--bg-input", "#3c3c3c");
  }

  // Set Monaco editor theme to match the UI theme
  if (_setMonacoTheme) {
    if (runtimeThemes.has(appearance.theme)) {
      _setMonacoTheme(appearance.theme);
    } else {
      const baseTheme = appearance.theme in THEME_TO_MONACO ? appearance.theme : "dark";
      _setMonacoTheme(THEME_TO_MONACO[baseTheme]);
    }
  }

  // Pass theme to Terminal if available
  if (_setTerminalTheme) {
    _setTerminalTheme(colors, brightness > 128);
  }

  // Apply workspace background image
  applyBackgroundImage(
    "workspace-bg-layer",
    document.getElementById("workspace-main"),
    appearance.backgroundImage.workspaceUrl,
    appearance.backgroundImage.workspaceOpacity,
    appearance.backgroundImage.workspaceBlur ?? 0
  );

  // Apply editor background image
  applyBackgroundImage(
    "editor-bg-layer",
    document.getElementById("editor-area"),
    appearance.backgroundImage.editorUrl,
    appearance.backgroundImage.editorOpacity,
    appearance.backgroundImage.editorBlur ?? 0
  );
}

function applyBackgroundImage(layerId: string, container: HTMLElement | null, url: string, opacity: number, blur: number): void {
  if (!container) return;

  const existingStyle = container.getAttribute("style") || "";
  if (!existingStyle.includes("position")) {
    container.style.position = "relative";
  }

  let layer = document.getElementById(layerId);
  if (!layer) {
    layer = document.createElement("div");
    layer.id = layerId;
    layer.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    `;
    container.prepend(layer);
  }

  if (url) {
    layer.style.backgroundImage = `url("${url}")`;
    layer.style.opacity = String(opacity);
    layer.style.filter = blur > 0 ? `blur(${blur}px)` : "none";
    if (blur > 0) {
      const px = `${blur * 2}px`;
      layer.style.inset = `-${px}`;
      layer.style.width = `calc(100% + ${blur * 4}px)`;
      layer.style.height = `calc(100% + ${blur * 4}px)`;
    } else {
      layer.style.inset = "0";
      layer.style.width = "";
      layer.style.height = "";
    }
    layer.style.display = "block";
  } else {
    layer.style.backgroundImage = "none";
    layer.style.display = "none";
  }
}
