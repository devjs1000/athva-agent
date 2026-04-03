import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "./editor";

export interface AISettings {
  provider: string;
  apiKey: string;
  model: string;
}

export interface AppSettings {
  editor: EditorSettings;
  ai: AISettings;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "openai",
  apiKey: "",
  model: "",
};

export const DEFAULT_SETTINGS: AppSettings = {
  editor: { ...DEFAULT_EDITOR_SETTINGS },
  ai: { ...DEFAULT_AI_SETTINGS },
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw);
    return {
      editor: { ...DEFAULT_EDITOR_SETTINGS, ...parsed.editor },
      ai: { ...DEFAULT_AI_SETTINGS, ...parsed.ai },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  await invoke("save_settings", { settings: json });
}

export class SettingsUI {
  private settings: AppSettings;
  private onChange: (settings: AppSettings) => void;

  // Editor setting elements
  private themeEl: HTMLSelectElement;
  private fontSizeEl: HTMLInputElement;
  private tabSizeEl: HTMLInputElement;
  private wordWrapEl: HTMLInputElement;
  private showGutterEl: HTMLInputElement;
  private minimapEl: HTMLInputElement;

  // AI setting elements
  private providerEl: HTMLSelectElement;
  private apiKeyEl: HTMLInputElement;
  private modelEl: HTMLInputElement;

  constructor(settings: AppSettings, onChange: (s: AppSettings) => void) {
    this.settings = settings;
    this.onChange = onChange;

    this.themeEl = document.getElementById("setting-theme") as HTMLSelectElement;
    this.fontSizeEl = document.getElementById("setting-font-size") as HTMLInputElement;
    this.tabSizeEl = document.getElementById("setting-tab-size") as HTMLInputElement;
    this.wordWrapEl = document.getElementById("setting-word-wrap") as HTMLInputElement;
    this.showGutterEl = document.getElementById("setting-show-gutter") as HTMLInputElement;
    this.minimapEl = document.getElementById("setting-minimap") as HTMLInputElement;

    this.providerEl = document.getElementById("setting-ai-provider") as HTMLSelectElement;
    this.apiKeyEl = document.getElementById("setting-ai-api-key") as HTMLInputElement;
    this.modelEl = document.getElementById("setting-ai-model") as HTMLInputElement;

    this.populateFromSettings();
    this.bindEvents();
  }

  updateSettings(settings: AppSettings) {
    this.settings = settings;
    this.populateFromSettings();
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  private populateFromSettings() {
    this.themeEl.value = this.settings.editor.theme;
    this.fontSizeEl.value = String(this.settings.editor.fontSize);
    this.tabSizeEl.value = String(this.settings.editor.tabSize);
    this.wordWrapEl.checked = this.settings.editor.wordWrap;
    this.showGutterEl.checked = this.settings.editor.showGutter;
    this.minimapEl.checked = this.settings.editor.showMinimap;

    this.providerEl.value = this.settings.ai.provider;
    this.apiKeyEl.value = this.settings.ai.apiKey;
    this.modelEl.value = this.settings.ai.model;
  }

  private bindEvents() {
    const save = () => {
      this.settings.editor.theme = this.themeEl.value;
      this.settings.editor.fontSize = parseInt(this.fontSizeEl.value) || 14;
      this.settings.editor.tabSize = parseInt(this.tabSizeEl.value) || 2;
      this.settings.editor.wordWrap = this.wordWrapEl.checked;
      this.settings.editor.showGutter = this.showGutterEl.checked;
      this.settings.editor.showMinimap = this.minimapEl.checked;

      this.settings.ai.provider = this.providerEl.value;
      this.settings.ai.apiKey = this.apiKeyEl.value;
      this.settings.ai.model = this.modelEl.value;

      this.onChange(this.settings);
      saveSettings(this.settings);
    };

    // Bind all inputs
    [this.themeEl, this.fontSizeEl, this.tabSizeEl, this.providerEl].forEach(
      (el) => el.addEventListener("change", save)
    );
    [this.wordWrapEl, this.showGutterEl, this.minimapEl].forEach((el) =>
      el.addEventListener("change", save)
    );
    [this.apiKeyEl, this.modelEl].forEach((el) =>
      el.addEventListener("input", save)
    );
  }
}
