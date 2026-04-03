import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "./editor";
import { getModelsForProvider } from "./model-list";

export interface AISettings {
  provider: string;
  apiKey: string;
  model: string;
}

export interface AgentAccess {
  fileRead: boolean;
  fileWrite: boolean;
  terminal: boolean;
  network: boolean;
  env: boolean;
  git: boolean;
  packageInstall: boolean;
}

export interface AppSettings {
  editor: EditorSettings;
  ai: AISettings;
  agentAccess: AgentAccess;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4o",
};

export const DEFAULT_AGENT_ACCESS: AgentAccess = {
  fileRead: true,
  fileWrite: false,
  terminal: false,
  network: false,
  env: false,
  git: false,
  packageInstall: false,
};

export const DEFAULT_SETTINGS: AppSettings = {
  editor: { ...DEFAULT_EDITOR_SETTINGS },
  ai: { ...DEFAULT_AI_SETTINGS },
  agentAccess: { ...DEFAULT_AGENT_ACCESS },
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw);
    return {
      editor: { ...DEFAULT_EDITOR_SETTINGS, ...parsed.editor },
      ai: { ...DEFAULT_AI_SETTINGS, ...parsed.ai },
      agentAccess: { ...DEFAULT_AGENT_ACCESS, ...parsed.agentAccess },
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
  private onApply: (settings: AppSettings) => void;

  // Editor elements
  private themeEl: HTMLSelectElement;
  private fontSizeEl: HTMLInputElement;
  private tabSizeEl: HTMLInputElement;
  private wordWrapEl: HTMLInputElement;
  private showGutterEl: HTMLInputElement;
  private minimapEl: HTMLInputElement;
  private aiInlineEl: HTMLInputElement;

  // AI elements
  private providerEl: HTMLSelectElement;
  private apiKeyEl: HTMLInputElement;
  private modelEl: HTMLSelectElement;

  // Agent access elements
  private accessFileReadEl: HTMLInputElement;
  private accessFileWriteEl: HTMLInputElement;
  private accessTerminalEl: HTMLInputElement;
  private accessNetworkEl: HTMLInputElement;
  private accessEnvEl: HTMLInputElement;
  private accessGitEl: HTMLInputElement;
  private accessInstallEl: HTMLInputElement;

  // Save button
  private saveBtnEl: HTMLElement;

  constructor(settings: AppSettings, onApply: (s: AppSettings) => void) {
    this.settings = settings;
    this.onApply = onApply;

    this.themeEl = document.getElementById("setting-theme") as HTMLSelectElement;
    this.fontSizeEl = document.getElementById("setting-font-size") as HTMLInputElement;
    this.tabSizeEl = document.getElementById("setting-tab-size") as HTMLInputElement;
    this.wordWrapEl = document.getElementById("setting-word-wrap") as HTMLInputElement;
    this.showGutterEl = document.getElementById("setting-show-gutter") as HTMLInputElement;
    this.minimapEl = document.getElementById("setting-minimap") as HTMLInputElement;
    this.aiInlineEl = document.getElementById("setting-ai-inline") as HTMLInputElement;

    this.providerEl = document.getElementById("setting-ai-provider") as HTMLSelectElement;
    this.apiKeyEl = document.getElementById("setting-ai-api-key") as HTMLInputElement;
    this.modelEl = document.getElementById("setting-ai-model") as HTMLSelectElement;

    this.accessFileReadEl = document.getElementById("setting-access-file-read") as HTMLInputElement;
    this.accessFileWriteEl = document.getElementById("setting-access-file-write") as HTMLInputElement;
    this.accessTerminalEl = document.getElementById("setting-access-terminal") as HTMLInputElement;
    this.accessNetworkEl = document.getElementById("setting-access-network") as HTMLInputElement;
    this.accessEnvEl = document.getElementById("setting-access-env") as HTMLInputElement;
    this.accessGitEl = document.getElementById("setting-access-git") as HTMLInputElement;
    this.accessInstallEl = document.getElementById("setting-access-install") as HTMLInputElement;

    this.saveBtnEl = document.getElementById("btn-save-settings")!;

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
    // Editor
    this.themeEl.value = this.settings.editor.theme;
    this.fontSizeEl.value = String(this.settings.editor.fontSize);
    this.tabSizeEl.value = String(this.settings.editor.tabSize);
    this.wordWrapEl.checked = this.settings.editor.wordWrap;
    this.showGutterEl.checked = this.settings.editor.showGutter;
    this.minimapEl.checked = this.settings.editor.showMinimap;
    this.aiInlineEl.checked = this.settings.editor.aiInlineSuggestions;

    // AI
    this.providerEl.value = this.settings.ai.provider;
    this.apiKeyEl.value = this.settings.ai.apiKey;
    this.populateModelDropdown(this.settings.ai.provider, this.settings.ai.model);

    // Agent Access
    this.accessFileReadEl.checked = this.settings.agentAccess.fileRead;
    this.accessFileWriteEl.checked = this.settings.agentAccess.fileWrite;
    this.accessTerminalEl.checked = this.settings.agentAccess.terminal;
    this.accessNetworkEl.checked = this.settings.agentAccess.network;
    this.accessEnvEl.checked = this.settings.agentAccess.env;
    this.accessGitEl.checked = this.settings.agentAccess.git;
    this.accessInstallEl.checked = this.settings.agentAccess.packageInstall;
  }

  private populateModelDropdown(provider: string, selectedModel: string) {
    const models = getModelsForProvider(provider);
    this.modelEl.innerHTML = models
      .map((m) => `<option value="${m.id}"${m.id === selectedModel ? " selected" : ""}>${m.label}</option>`)
      .join("");

    // If no match, select the first
    if (selectedModel && !models.find((m) => m.id === selectedModel)) {
      this.modelEl.selectedIndex = 0;
    }
  }

  private showSavedToast() {
    const toast = document.getElementById("settings-saved-toast");
    if (!toast) return;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 2000);
  }

  private collectFromUI(): AppSettings {
    return {
      editor: {
        theme: this.themeEl.value,
        fontSize: parseInt(this.fontSizeEl.value) || 14,
        tabSize: parseInt(this.tabSizeEl.value) || 2,
        wordWrap: this.wordWrapEl.checked,
        showGutter: this.showGutterEl.checked,
        showMinimap: this.minimapEl.checked,
        aiInlineSuggestions: this.aiInlineEl.checked,
      },
      ai: {
        provider: this.providerEl.value,
        apiKey: this.apiKeyEl.value,
        model: this.modelEl.value,
      },
      agentAccess: {
        fileRead: this.accessFileReadEl.checked,
        fileWrite: this.accessFileWriteEl.checked,
        terminal: this.accessTerminalEl.checked,
        network: this.accessNetworkEl.checked,
        env: this.accessEnvEl.checked,
        git: this.accessGitEl.checked,
        packageInstall: this.accessInstallEl.checked,
      },
    };
  }

  private bindEvents() {
    // When provider changes, repopulate model dropdown
    this.providerEl.addEventListener("change", () => {
      const provider = this.providerEl.value;
      this.populateModelDropdown(provider, "");
    });

    // Save button
    this.saveBtnEl.addEventListener("click", async () => {
      this.settings = this.collectFromUI();
      this.onApply({ ...this.settings });
      await saveSettings(this.settings);
      this.showSavedToast();
    });
  }
}
