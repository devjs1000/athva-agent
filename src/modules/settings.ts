import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "./editor";
import { getModelsForProvider } from "./model-list";
import { PRESET_THEMES, applyTheme, getThemeColors } from "./theme-engine";
import {
  DEFAULT_SCREEN_SAVER_SETTINGS,
  ANIMATION_OPTIONS,
  runAnimationLoop,
  type ScreenSaverSettings,
  type ScreenSaverAnimation,
} from "./screen-saver";

export interface ThemeColors {
  topBar: string;
  bottomBar: string;
  leftSidebar: string;
  rightPanels: string;
  accent: string;
  editorBg: string;
}

export interface CustomTheme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export interface AppearanceSettings {
  theme: string;
  fileIconTheme: string;
  colorOverrides: Partial<ThemeColors>;
  customThemes: CustomTheme[];
  backgroundImage: {
    editorUrl: string;
    editorOpacity: number;
    editorBlur: number;
    workspaceUrl: string;
    workspaceOpacity: number;
    workspaceBlur: number;
  };
  screenSaver: ScreenSaverSettings;
}

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
  autoApprove: boolean;
}

export interface MemorySettings {
  globalEnabled: boolean;
  projectEnabled: boolean;
}

export type UnlockMethod = "pin" | "fingerprint" | "pin_or_fingerprint";

export interface SecuritySettings {
  enabled: boolean;
  method: UnlockMethod;
  pinSalt?: string;
  pinHash?: string;
  fingerprintCredentialId?: string; // base64url
  lockBeforeProjectOpen: boolean;
  protectEnvFiles: boolean;
}

export type WorkspaceActionPlacement =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left-sidebar-strip"
  | "right-sidebar-strip"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type WorkspaceActionId =
  | "explorer"
  | "settings"
  | "run-script"
  | "format"
  | "ai-review"
  | "quality-panel"
  | "extensions-panel"
  | "snippets"
  | "source-control"
  | "terminal"
  | "chat";

export interface WorkspaceActionSettings {
  placements: Record<WorkspaceActionId, WorkspaceActionPlacement>;
}

export interface AppSettings {
  editor: EditorSettings;
  ai: AISettings;
  agentAccess: AgentAccess;
  memory: MemorySettings;
  security: SecuritySettings;
  appearance: AppearanceSettings;
  workspaceActions: WorkspaceActionSettings;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  theme: "dark",
  fileIconTheme: "",
  colorOverrides: {},
  customThemes: [],
  backgroundImage: {
    editorUrl: "",
    editorOpacity: 0.3,
    editorBlur: 0,
    workspaceUrl: "",
    workspaceOpacity: 0.2,
    workspaceBlur: 0,
  },
  screenSaver: { ...DEFAULT_SCREEN_SAVER_SETTINGS },
};

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
  autoApprove: false,
};

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  globalEnabled: true,
  projectEnabled: true,
};

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  enabled: false,
  method: "pin",
  pinSalt: "",
  pinHash: "",
  fingerprintCredentialId: "",
  lockBeforeProjectOpen: true,
  protectEnvFiles: true,
};

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { ...DEFAULT_APPEARANCE_SETTINGS, colorOverrides: {}, customThemes: [], backgroundImage: { ...DEFAULT_APPEARANCE_SETTINGS.backgroundImage } },
  editor: { ...DEFAULT_EDITOR_SETTINGS },
  ai: { ...DEFAULT_AI_SETTINGS },
  agentAccess: { ...DEFAULT_AGENT_ACCESS },
  memory: { ...DEFAULT_MEMORY_SETTINGS },
  security: { ...DEFAULT_SECURITY_SETTINGS },
  workspaceActions: {
    placements: {
      explorer: "left-sidebar-strip",
      settings: "top-right",
      "run-script": "top-right",
      format: "top-right",
      "ai-review": "top-right",
      "quality-panel": "top-right",
      "extensions-panel": "top-right",
      snippets: "top-right",
      "source-control": "top-right",
      terminal: "top-right",
      chat: "top-right",
    },
  },
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw);
    return {
      editor: { ...DEFAULT_EDITOR_SETTINGS, ...parsed.editor },
      ai: { ...DEFAULT_AI_SETTINGS, ...parsed.ai },
      agentAccess: { ...DEFAULT_AGENT_ACCESS, ...parsed.agentAccess },
      memory: { ...DEFAULT_MEMORY_SETTINGS, ...parsed.memory },
      security: { ...DEFAULT_SECURITY_SETTINGS, ...parsed.security },
      workspaceActions: {
        placements: {
          ...DEFAULT_SETTINGS.workspaceActions.placements,
          ...parsed.workspaceActions?.placements,
        },
      },
      appearance: {
        ...DEFAULT_APPEARANCE_SETTINGS,
        ...parsed.appearance,
        fileIconTheme: parsed.appearance?.fileIconTheme ?? DEFAULT_APPEARANCE_SETTINGS.fileIconTheme,
        colorOverrides: parsed.appearance?.colorOverrides ?? {},
        customThemes: parsed.appearance?.customThemes ?? [],
        backgroundImage: { ...DEFAULT_APPEARANCE_SETTINGS.backgroundImage, ...parsed.appearance?.backgroundImage },
        screenSaver: { ...DEFAULT_SCREEN_SAVER_SETTINGS, ...parsed.appearance?.screenSaver },
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  await invoke("save_settings", { settings: json });
}

async function pathToDataUrl(filePath: string): Promise<string | null> {
  try {
    const bytes = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    };
    const mime = mimeMap[ext] ?? "image/png";
    // Efficient base64 via Blob + FileReader
    const blob = new Blob([bytes], { type: mime });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export class SettingsUI {
  private settings: AppSettings;
  private onApply: (settings: AppSettings) => void;
  private activeTab = "all";

  // Editor elements
  private fontSizeEl: HTMLInputElement;
  private tabSizeEl: HTMLInputElement;
  private wordWrapEl: HTMLInputElement;
  private showGutterEl: HTMLInputElement;
  private minimapEl: HTMLInputElement;
  private aiInlineEl: HTMLInputElement;
  private tailwindEl: HTMLInputElement;

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
  private accessAutoApproveEl: HTMLInputElement;

  // Memory elements
  private memoryGlobalEl: HTMLInputElement;
  private memoryProjectEl: HTMLInputElement;

  // Security elements
  private securityEnabledEl: HTMLInputElement;
  private securityMethodEl: HTMLSelectElement;
  private securityPinStatusEl: HTMLElement;
  private securityFingerprintStatusEl: HTMLElement;
  private securityLockProjectOpenEl: HTMLInputElement;
  private securityProtectEnvEl: HTMLInputElement;
  private securitySetPinBtnEl: HTMLButtonElement;
  private securityClearPinBtnEl: HTMLButtonElement;
  private securitySetupFingerprintBtnEl: HTMLButtonElement;
  private securityClearFingerprintBtnEl: HTMLButtonElement;

  // Settings navigation / filtering
  private searchEl: HTMLInputElement;
  private tabEls: HTMLElement[];
  private sectionEls: HTMLElement[];

  // Appearance elements
  private appearanceThemeCardsEl: HTMLElement;
  private appearanceColorRows: Record<keyof ThemeColors, { picker: HTMLInputElement; resetBtn: HTMLButtonElement }>;
  private appearanceSaveThemeBtn: HTMLButtonElement;
  private appearanceEditorImageBtn: HTMLButtonElement;
  private appearanceEditorImageClear: HTMLButtonElement;
  private appearanceEditorImagePreview: HTMLElement;
  private appearanceEditorOpacity: HTMLInputElement;
  private appearanceEditorBlur: HTMLInputElement;
  private appearanceWorkspaceImageBtn: HTMLButtonElement;
  private appearanceWorkspaceImageClear: HTMLButtonElement;
  private appearanceWorkspaceImagePreview: HTMLElement;
  private appearanceWorkspaceOpacity: HTMLInputElement;
  private appearanceWorkspaceBlur: HTMLInputElement;
  private appearanceRestoreBtn: HTMLButtonElement;

  // Screen saver elements
  private ssEnabledEl: HTMLInputElement;
  private ssTimeoutEl: HTMLInputElement;
  private ssTimeoutValEl: HTMLElement;
  private ssModeAnimEl: HTMLInputElement;
  private ssModeImageEl: HTMLInputElement;
  private ssAnimationEl: HTMLSelectElement;
  private ssAnimationCardsEl: HTMLElement;
  private ssImageBtn: HTMLButtonElement;
  private ssImageClearBtn: HTMLButtonElement;
  private ssImagePreviewEl: HTMLElement;
  private ssAnimationCleanups: (() => void)[] = [];

  // Save button
  private saveBtnEl: HTMLElement;

  constructor(settings: AppSettings, onApply: (s: AppSettings) => void) {
    this.settings = settings;
    this.onApply = onApply;

    this.fontSizeEl = document.getElementById("setting-font-size") as HTMLInputElement;
    this.tabSizeEl = document.getElementById("setting-tab-size") as HTMLInputElement;
    this.wordWrapEl = document.getElementById("setting-word-wrap") as HTMLInputElement;
    this.showGutterEl = document.getElementById("setting-show-gutter") as HTMLInputElement;
    this.minimapEl = document.getElementById("setting-minimap") as HTMLInputElement;
    this.aiInlineEl = document.getElementById("setting-ai-inline") as HTMLInputElement;
    this.tailwindEl = document.getElementById("setting-tailwind") as HTMLInputElement;

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
    this.accessAutoApproveEl = document.getElementById("setting-access-auto-approve") as HTMLInputElement;

    this.memoryGlobalEl = document.getElementById("setting-memory-global") as HTMLInputElement;
    this.memoryProjectEl = document.getElementById("setting-memory-project") as HTMLInputElement;

    this.securityEnabledEl = document.getElementById("setting-security-enabled") as HTMLInputElement;
    this.securityMethodEl = document.getElementById("setting-security-method") as HTMLSelectElement;
    this.securityPinStatusEl = document.getElementById("setting-security-pin-status") as HTMLElement;
    this.securityFingerprintStatusEl = document.getElementById("setting-security-fingerprint-status") as HTMLElement;
    this.securityLockProjectOpenEl = document.getElementById("setting-security-lock-project-open") as HTMLInputElement;
    this.securityProtectEnvEl = document.getElementById("setting-security-protect-env") as HTMLInputElement;
    this.securitySetPinBtnEl = document.getElementById("btn-security-set-pin") as HTMLButtonElement;
    this.securityClearPinBtnEl = document.getElementById("btn-security-clear-pin") as HTMLButtonElement;
    this.securitySetupFingerprintBtnEl = document.getElementById("btn-security-setup-fingerprint") as HTMLButtonElement;
    this.securityClearFingerprintBtnEl = document.getElementById("btn-security-clear-fingerprint") as HTMLButtonElement;

    this.searchEl = document.getElementById("settings-search-input") as HTMLInputElement;
    this.tabEls = Array.from(document.querySelectorAll<HTMLElement>(".settings-tab-btn"));
    this.sectionEls = Array.from(document.querySelectorAll<HTMLElement>(".settings-section"));

    // Appearance
    this.appearanceThemeCardsEl = document.getElementById("appearance-theme-cards")!;
    this.appearanceColorRows = {
      topBar: { picker: document.getElementById("appearance-color-top-bar") as HTMLInputElement, resetBtn: document.getElementById("appearance-reset-top-bar") as HTMLButtonElement },
      bottomBar: { picker: document.getElementById("appearance-color-bottom-bar") as HTMLInputElement, resetBtn: document.getElementById("appearance-reset-bottom-bar") as HTMLButtonElement },
      leftSidebar: { picker: document.getElementById("appearance-color-left-sidebar") as HTMLInputElement, resetBtn: document.getElementById("appearance-reset-left-sidebar") as HTMLButtonElement },
      rightPanels: { picker: document.getElementById("appearance-color-right-panels") as HTMLInputElement, resetBtn: document.getElementById("appearance-reset-right-panels") as HTMLButtonElement },
      accent: { picker: document.getElementById("appearance-color-accent") as HTMLInputElement, resetBtn: document.getElementById("appearance-reset-accent") as HTMLButtonElement },
      editorBg: { picker: document.getElementById("appearance-color-editor-bg") as HTMLInputElement, resetBtn: document.getElementById("appearance-reset-editor-bg") as HTMLButtonElement },
    };
    this.appearanceSaveThemeBtn = document.getElementById("appearance-save-theme") as HTMLButtonElement;
    this.appearanceEditorImageBtn = document.getElementById("appearance-editor-image-btn") as HTMLButtonElement;
    this.appearanceEditorImageClear = document.getElementById("appearance-editor-image-clear") as HTMLButtonElement;
    this.appearanceEditorImagePreview = document.getElementById("appearance-editor-image-preview")!;
    this.appearanceEditorOpacity = document.getElementById("appearance-editor-opacity") as HTMLInputElement;
    this.appearanceEditorBlur = document.getElementById("appearance-editor-blur") as HTMLInputElement;
    this.appearanceWorkspaceImageBtn = document.getElementById("appearance-workspace-image-btn") as HTMLButtonElement;
    this.appearanceWorkspaceImageClear = document.getElementById("appearance-workspace-image-clear") as HTMLButtonElement;
    this.appearanceWorkspaceImagePreview = document.getElementById("appearance-workspace-image-preview")!;
    this.appearanceWorkspaceOpacity = document.getElementById("appearance-workspace-opacity") as HTMLInputElement;
    this.appearanceWorkspaceBlur = document.getElementById("appearance-workspace-blur") as HTMLInputElement;
    this.appearanceRestoreBtn = document.getElementById("appearance-restore-defaults") as HTMLButtonElement;

    // Screen saver
    this.ssEnabledEl = document.getElementById("setting-ss-enabled") as HTMLInputElement;
    this.ssTimeoutEl = document.getElementById("setting-ss-timeout") as HTMLInputElement;
    this.ssTimeoutValEl = document.getElementById("setting-ss-timeout-val")!;
    this.ssModeAnimEl = document.getElementById("setting-ss-mode-animation") as HTMLInputElement;
    this.ssModeImageEl = document.getElementById("setting-ss-mode-image") as HTMLInputElement;
    this.ssAnimationEl = document.getElementById("setting-ss-animation") as HTMLSelectElement;
    this.ssAnimationCardsEl = document.getElementById("ss-animation-cards")!;
    this.ssImageBtn = document.getElementById("ss-image-btn") as HTMLButtonElement;
    this.ssImageClearBtn = document.getElementById("ss-image-clear") as HTMLButtonElement;
    this.ssImagePreviewEl = document.getElementById("ss-image-preview")!;

    this.saveBtnEl = document.getElementById("btn-save-settings")!;

    this.populateFromSettings();
    this.bindEvents();
    this.applyFilters();
  }

  updateSettings(settings: AppSettings) {
    this.settings = settings;
    this.populateFromSettings();
    this.applyFilters();
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  private populateFromSettings() {
    // Editor
    this.fontSizeEl.value = String(this.settings.editor.fontSize);
    this.tabSizeEl.value = String(this.settings.editor.tabSize);
    this.wordWrapEl.checked = this.settings.editor.wordWrap;
    this.showGutterEl.checked = this.settings.editor.showGutter;
    this.minimapEl.checked = this.settings.editor.showMinimap;
    this.aiInlineEl.checked = this.settings.editor.aiInlineSuggestions;
    this.tailwindEl.checked = this.settings.editor.tailwindAutocomplete;

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
    this.accessAutoApproveEl.checked = this.settings.agentAccess.autoApprove;

    // Memory
    this.memoryGlobalEl.checked = this.settings.memory.globalEnabled;
    this.memoryProjectEl.checked = this.settings.memory.projectEnabled;

    // Security
    this.securityEnabledEl.checked = !!this.settings.security.enabled;
    this.securityMethodEl.value = this.settings.security.method || "pin";
    this.securityLockProjectOpenEl.checked = !!this.settings.security.lockBeforeProjectOpen;
    this.securityProtectEnvEl.checked = !!this.settings.security.protectEnvFiles;
    this.updateSecurityStatus();

    // Appearance
    this.renderThemeCards();
    this.updateColorPickers();
    this.updateImagePreviews();

    // Screen saver
    this.populateScreenSaver();
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
        fontSize: parseInt(this.fontSizeEl.value) || 14,
        tabSize: parseInt(this.tabSizeEl.value) || 2,
        wordWrap: this.wordWrapEl.checked,
        showGutter: this.showGutterEl.checked,
        showMinimap: this.minimapEl.checked,
        aiInlineSuggestions: this.aiInlineEl.checked,
        tailwindAutocomplete: this.tailwindEl.checked,
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
        autoApprove: this.accessAutoApproveEl.checked,
      },
      memory: {
        globalEnabled: this.memoryGlobalEl.checked,
        projectEnabled: this.memoryProjectEl.checked,
      },
      security: {
        ...this.settings.security,
        enabled: this.securityEnabledEl.checked,
        method: (this.securityMethodEl.value as UnlockMethod) || "pin",
        lockBeforeProjectOpen: this.securityLockProjectOpenEl.checked,
        protectEnvFiles: this.securityProtectEnvEl.checked,
      },
      workspaceActions: { ...this.settings.workspaceActions },
      appearance: { ...this.settings.appearance },
    };
  }

  private updateSecurityStatus() {
    const enabled = this.securityEnabledEl.checked;
    const method = this.securityMethodEl.value;
    const showPin = enabled && (method === "pin" || method === "pin_or_fingerprint");
    const showFp = enabled && (method === "fingerprint" || method === "pin_or_fingerprint");

    document.getElementById("security-method-row")?.classList.toggle("hidden", !enabled);
    document.getElementById("security-pin-row")?.classList.toggle("hidden", !showPin);
    document.getElementById("security-fingerprint-row")?.classList.toggle("hidden", !showFp);
    document.getElementById("security-lock-project-row")?.classList.toggle("hidden", !enabled);
    document.getElementById("security-protect-env-row")?.classList.toggle("hidden", !enabled);

    const pinSet = !!(this.settings.security.pinHash && this.settings.security.pinSalt);
    const fpSet = !!this.settings.security.fingerprintCredentialId;
    this.securityPinStatusEl.textContent = pinSet ? "Set" : "Not set";
    this.securityFingerprintStatusEl.textContent = fpSet ? "Set" : "Not set";
    this.securityClearPinBtnEl.disabled = !pinSet;
    this.securityClearFingerprintBtnEl.disabled = !fpSet;
  }

  private async digestSha256Base64(data: Uint8Array): Promise<string> {
    //@ts-ignore
    const hash = await crypto.subtle.digest("SHA-256", data);
    return this.base64Encode(new Uint8Array(hash));
  }

  private base64Encode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  private base64UrlEncode(bytes: Uint8Array): string {
    return this.base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  private randomBytes(len: number): Uint8Array {
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    return buf;
  }

  private async showSetPinDialog(): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = document.getElementById("set-pin-dialog")!;
      const pinEl = document.getElementById("set-pin-new") as HTMLInputElement;
      const confirmEl = document.getElementById("set-pin-confirm") as HTMLInputElement;
      const errorEl = document.getElementById("set-pin-error")!;
      const okBtn = document.getElementById("set-pin-ok")!;
      const cancelBtn = document.getElementById("set-pin-cancel")!;

      errorEl.classList.add("hidden");
      errorEl.textContent = "";
      pinEl.value = "";
      confirmEl.value = "";
      overlay.classList.remove("hidden");
      pinEl.focus();

      const cleanup = () => {
        overlay.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        overlay.removeEventListener("click", onOverlay);
        document.removeEventListener("keydown", onKey);
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      const onOk = () => {
        const pin = pinEl.value.trim();
        const confirm = confirmEl.value.trim();
        if (!/^\d{4,12}$/.test(pin)) {
          errorEl.textContent = "PIN must be 4–12 digits.";
          errorEl.classList.remove("hidden");
          pinEl.focus();
          return;
        }
        if (pin !== confirm) {
          errorEl.textContent = "PINs do not match.";
          errorEl.classList.remove("hidden");
          confirmEl.focus();
          return;
        }
        cleanup();
        resolve(pin);
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        if (e.key === "Enter") { e.preventDefault(); onOk(); }
      };

      const onOverlay = (e: MouseEvent) => {
        if (e.target === overlay) onCancel();
      };

      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      overlay.addEventListener("click", onOverlay);
      document.addEventListener("keydown", onKey);
    });
  }

  private async setPin() {
    const pin = await this.showSetPinDialog();
    if (!pin) return;
    const saltBytes = this.randomBytes(16);
    const salt = this.base64UrlEncode(saltBytes);
    const encoded = new TextEncoder().encode(`${salt}:${pin}`);
    const hash = await this.digestSha256Base64(encoded);
    this.settings = {
      ...this.settings,
      security: {
        ...this.settings.security,
        pinSalt: salt,
        pinHash: hash,
      },
    };
    this.updateSecurityStatus();
  }

  private clearPin() {
    this.settings = {
      ...this.settings,
      security: {
        ...this.settings.security,
        pinSalt: "",
        pinHash: "",
      },
    };
    this.updateSecurityStatus();
  }

  private async setupFingerprint() {
    const available = await invoke<boolean>("touchid_available").catch(() => false);
    if (!available) {
      this.securityFingerprintStatusEl.textContent = "Touch ID not available on this device";
      return;
    }
    const ok = await invoke<boolean>("touchid_authenticate", { reason: "Verify Touch ID to enable it for Athva" }).catch(() => false);
    if (!ok) {
      this.securityFingerprintStatusEl.textContent = "Touch ID verification failed";
      return;
    }
    this.settings = {
      ...this.settings,
      security: {
        ...this.settings.security,
        fingerprintCredentialId: "touchid-enabled",
      },
    };
    this.updateSecurityStatus();
  }

  private clearFingerprint() {
    this.settings = {
      ...this.settings,
      security: {
        ...this.settings.security,
        fingerprintCredentialId: "",
      },
    };
    this.updateSecurityStatus();
  }

  private bindEvents() {
    // When provider changes, repopulate model dropdown
    this.providerEl.addEventListener("change", () => {
      const provider = this.providerEl.value;
      this.populateModelDropdown(provider, "");
    });

    this.searchEl.addEventListener("input", () => this.applyFilters());

    this.tabEls.forEach((tabEl) => {
      tabEl.addEventListener("click", () => {
        this.activeTab = tabEl.dataset.settingsTab || "all";
        this.tabEls.forEach((el) => {
          el.classList.toggle("active", el === tabEl);
        });
        this.applyFilters();
      });
    });

    this.sectionEls.forEach((sectionEl) => {
      const header = sectionEl.querySelector<HTMLElement>(".settings-section-header");
      if (!header) return;
      header.addEventListener("click", () => {
        if (!sectionEl.classList.contains("expanded")) {
          sectionEl.classList.add("expanded");
          return;
        }
        if (this.searchEl.value.trim()) return;
        sectionEl.classList.remove("expanded");
      });
    });

    this.securityEnabledEl.addEventListener("change", () => this.updateSecurityStatus());
    this.securityMethodEl.addEventListener("change", () => this.updateSecurityStatus());

    this.securitySetPinBtnEl.addEventListener("click", async () => {
      await this.setPin();
    });
    this.securityClearPinBtnEl.addEventListener("click", () => this.clearPin());
    this.securitySetupFingerprintBtnEl.addEventListener("click", async () => {
      await this.setupFingerprint();
    });
    this.securityClearFingerprintBtnEl.addEventListener("click", () => this.clearFingerprint());

    // Appearance — color pickers
    const colorKeys = Object.keys(this.appearanceColorRows) as Array<keyof ThemeColors>;
    colorKeys.forEach((key) => {
      const { picker, resetBtn } = this.appearanceColorRows[key];
      picker.addEventListener("input", () => {
        this.settings.appearance.colorOverrides[key] = picker.value;
        applyTheme(this.settings.appearance);
      });
      resetBtn.addEventListener("click", () => {
        delete this.settings.appearance.colorOverrides[key];
        this.updateColorPickers();
        applyTheme(this.settings.appearance);
      });
    });

    // Appearance — save as new theme
    this.appearanceSaveThemeBtn.addEventListener("click", async () => {
      const name = await this.promptThemeName();
      if (!name) return;
      const colors = getThemeColors(this.settings.appearance);
      const id = `custom-${Date.now()}`;
      this.settings.appearance.customThemes.push({ id, name, colors });
      this.settings.appearance.theme = id;
      this.settings.appearance.colorOverrides = {};
      this.renderThemeCards();
      this.updateColorPickers();
      applyTheme(this.settings.appearance);
    });

    // Appearance — background images
    this.appearanceEditorImageBtn.addEventListener("click", async () => {
      const path = await open({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }] });
      if (typeof path === "string") {
        const dataUrl = await pathToDataUrl(path);
        if (dataUrl) {
          this.settings.appearance.backgroundImage.editorUrl = dataUrl;
          this.updateImagePreviews();
          applyTheme(this.settings.appearance);
        }
      }
    });

    this.appearanceEditorImageClear.addEventListener("click", () => {
      this.settings.appearance.backgroundImage.editorUrl = "";
      this.updateImagePreviews();
      applyTheme(this.settings.appearance);
    });

    this.appearanceEditorOpacity.addEventListener("input", () => {
      this.settings.appearance.backgroundImage.editorOpacity = parseFloat(this.appearanceEditorOpacity.value) / 100;
      this.updateImagePreviews();
      applyTheme(this.settings.appearance);
    });

    this.appearanceEditorBlur.addEventListener("input", () => {
      this.settings.appearance.backgroundImage.editorBlur = parseFloat(this.appearanceEditorBlur.value);
      this.updateImagePreviews();
      applyTheme(this.settings.appearance);
    });

    this.appearanceEditorOpacity.addEventListener("input", () => this.syncSliderLabels());
    this.appearanceEditorBlur.addEventListener("input", () => this.syncSliderLabels());
    this.appearanceWorkspaceOpacity.addEventListener("input", () => this.syncSliderLabels());
    this.appearanceWorkspaceBlur.addEventListener("input", () => this.syncSliderLabels());

    this.appearanceWorkspaceImageBtn.addEventListener("click", async () => {
      const path = await open({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }] });
      if (typeof path === "string") {
        const dataUrl = await pathToDataUrl(path);
        if (dataUrl) {
          this.settings.appearance.backgroundImage.workspaceUrl = dataUrl;
          this.updateImagePreviews();
          applyTheme(this.settings.appearance);
        }
      }
    });

    this.appearanceWorkspaceImageClear.addEventListener("click", () => {
      this.settings.appearance.backgroundImage.workspaceUrl = "";
      this.updateImagePreviews();
      applyTheme(this.settings.appearance);
    });

    this.appearanceWorkspaceOpacity.addEventListener("input", () => {
      this.settings.appearance.backgroundImage.workspaceOpacity = parseFloat(this.appearanceWorkspaceOpacity.value) / 100;
      this.updateImagePreviews();
      applyTheme(this.settings.appearance);
    });

    this.appearanceWorkspaceBlur.addEventListener("input", () => {
      this.settings.appearance.backgroundImage.workspaceBlur = parseFloat(this.appearanceWorkspaceBlur.value);
      this.updateImagePreviews();
      applyTheme(this.settings.appearance);
    });


    // Appearance — restore defaults
    this.appearanceRestoreBtn.addEventListener("click", () => {
      this.settings.appearance = {
        theme: "dark",
        fileIconTheme: "",
        colorOverrides: {},
        customThemes: this.settings.appearance.customThemes,
        backgroundImage: { editorUrl: "", editorOpacity: 0.3, editorBlur: 0, workspaceUrl: "", workspaceOpacity: 0.2, workspaceBlur: 0 },
        screenSaver: { ...DEFAULT_SCREEN_SAVER_SETTINGS },
      };
      this.renderThemeCards();
      this.updateColorPickers();
      this.updateImagePreviews();
      this.populateScreenSaver();
      applyTheme(this.settings.appearance);
    });

    // ── Screen Saver Bindings ──
    this.ssEnabledEl.addEventListener("change", () => {
      this.settings.appearance.screenSaver.enabled = this.ssEnabledEl.checked;
      this.updateScreenSaverVisibility();
    });

    this.ssTimeoutEl.addEventListener("input", () => {
      const val = parseInt(this.ssTimeoutEl.value) || 5;
      this.settings.appearance.screenSaver.timeoutMinutes = val;
      this.ssTimeoutValEl.textContent = `${val} min`;
    });

    this.ssModeAnimEl.addEventListener("change", () => {
      this.settings.appearance.screenSaver.mode = "animation";
      this.updateScreenSaverVisibility();
    });

    this.ssModeImageEl.addEventListener("change", () => {
      this.settings.appearance.screenSaver.mode = "image";
      this.updateScreenSaverVisibility();
    });

    this.ssAnimationEl.addEventListener("change", () => {
      this.settings.appearance.screenSaver.animation = this.ssAnimationEl.value as ScreenSaverAnimation;
      this.renderAnimationCards();
    });

    this.ssImageBtn.addEventListener("click", async () => {
      const path = await open({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }] });
      if (typeof path === "string") {
        const dataUrl = await pathToDataUrl(path);
        if (dataUrl) {
          this.settings.appearance.screenSaver.imageUrl = dataUrl;
          this.updateScreenSaverImagePreview();
        }
      }
    });

    this.ssImageClearBtn.addEventListener("click", () => {
      this.settings.appearance.screenSaver.imageUrl = "";
      this.updateScreenSaverImagePreview();
    });

    // Screen saver preview
    const ssPreviewBtn = document.getElementById("ss-preview-btn");
    ssPreviewBtn?.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("athva:screensaver-preview", {
        detail: { ...this.settings.appearance.screenSaver },
      }));
    });

    // Save button
    this.saveBtnEl.addEventListener("click", async () => {
      this.settings = this.collectFromUI();
      this.onApply({ ...this.settings });
      await saveSettings(this.settings);
      this.showSavedToast();
    });
  }

  private applyFilters() {
    const query = this.searchEl.value.trim().toLowerCase();

    this.sectionEls.forEach((sectionEl) => {
      const category = sectionEl.dataset.settingsCategory || "all";
      const categoryMatch = this.activeTab === "all" || this.activeTab === category;
      const sectionText = this.normalizeSearchText(sectionEl.querySelector(".settings-section-heading")?.textContent || "");
      const rows = Array.from(sectionEl.querySelectorAll<HTMLElement>(".setting-row"));

      let visibleRows = 0;
      const sectionMatch = query.length > 0 && sectionText.includes(query);

      rows.forEach((row) => {
        const rowMatch = sectionMatch || query.length === 0 || this.normalizeSearchText(row.textContent || "").includes(query);
        row.classList.toggle("hidden-by-filter", !rowMatch);
        if (rowMatch) visibleRows++;
      });

      const shouldShow = categoryMatch && (query.length === 0 || sectionMatch || visibleRows > 0);
      sectionEl.classList.toggle("hidden-by-filter", !shouldShow);

      if (shouldShow && query.length > 0) {
        sectionEl.classList.add("expanded");
      }
    });
  }

  private normalizeSearchText(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  private renderThemeCards(): void {
    if (!this.appearanceThemeCardsEl) return;
    const activeId = this.settings.appearance.theme;
    const hasOverrides = Object.keys(this.settings.appearance.colorOverrides).some(
      (k) => !!(this.settings.appearance.colorOverrides as Record<string, string>)[k]
    );

    const builtinCards = Object.entries(PRESET_THEMES).map(([id, theme]) => {
      const active = activeId === id;
      const modified = active && hasOverrides;
      return `<button class="appearance-theme-card${active ? " active" : ""}" data-theme-id="${id}" title="${theme.label}">
        <div class="appearance-theme-swatches">
          <div class="swatch" style="background:${theme.topBar}"></div>
          <div class="swatch" style="background:${theme.editorBg}"></div>
          <div class="swatch" style="background:${theme.accent}"></div>
          <div class="swatch" style="background:${theme.bottomBar}"></div>
        </div>
        <span class="appearance-theme-name">${theme.label}${modified ? " •" : ""}</span>
      </button>`;
    });

    const customCards = this.settings.appearance.customThemes.map((ct) => {
      const active = activeId === ct.id;
      return `<button class="appearance-theme-card custom${active ? " active" : ""}" data-theme-id="${ct.id}" title="${ct.name}">
        <div class="appearance-theme-swatches">
          <div class="swatch" style="background:${ct.colors.topBar}"></div>
          <div class="swatch" style="background:${ct.colors.editorBg}"></div>
          <div class="swatch" style="background:${ct.colors.accent}"></div>
          <div class="swatch" style="background:${ct.colors.bottomBar}"></div>
        </div>
        <span class="appearance-theme-name">${ct.name}</span>
        <button class="appearance-theme-delete" data-delete-theme="${ct.id}" title="Delete theme">×</button>
      </button>`;
    });

    this.appearanceThemeCardsEl.innerHTML = [...builtinCards, ...customCards].join("");

    // Bind click events on theme cards
    this.appearanceThemeCardsEl.querySelectorAll<HTMLButtonElement>(".appearance-theme-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        const deleteBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".appearance-theme-delete");
        if (deleteBtn) {
          const deleteId = deleteBtn.dataset.deleteTheme!;
          this.settings.appearance.customThemes = this.settings.appearance.customThemes.filter((t) => t.id !== deleteId);
          if (this.settings.appearance.theme === deleteId) this.settings.appearance.theme = "dark";
          this.renderThemeCards();
          this.updateColorPickers();
          applyTheme(this.settings.appearance);
          return;
        }
        const themeId = card.dataset.themeId!;
        this.settings.appearance.theme = themeId;
        this.settings.appearance.colorOverrides = {};
        this.renderThemeCards();
        this.updateColorPickers();
        applyTheme(this.settings.appearance);
      });
    });
  }

  private updateColorPickers(): void {
    const colors = getThemeColors(this.settings.appearance);
    const overrides = this.settings.appearance.colorOverrides;
    const keys = Object.keys(this.appearanceColorRows) as Array<keyof ThemeColors>;
    keys.forEach((key) => {
      const { picker, resetBtn } = this.appearanceColorRows[key];
      picker.value = overrides[key] || colors[key];
      resetBtn.disabled = !overrides[key];
    });
  }

  private updateImagePreviews(): void {
    const bg = this.settings.appearance.backgroundImage;

    // Editor preview
    if (bg.editorUrl) {
      this.appearanceEditorImagePreview.style.backgroundImage = `url("${bg.editorUrl}")`;
      this.appearanceEditorImagePreview.style.opacity = String(bg.editorOpacity);
      this.appearanceEditorImagePreview.style.filter = bg.editorBlur > 0 ? `blur(${bg.editorBlur}px)` : "none";
      this.appearanceEditorImagePreview.classList.remove("empty");
    } else {
      this.appearanceEditorImagePreview.style.backgroundImage = "none";
      this.appearanceEditorImagePreview.style.opacity = "1";
      this.appearanceEditorImagePreview.style.filter = "none";
      this.appearanceEditorImagePreview.classList.add("empty");
    }
    this.appearanceEditorOpacity.value = String(Math.round(bg.editorOpacity * 100));
    this.appearanceEditorBlur.value = String(bg.editorBlur ?? 0);
    this.appearanceEditorImageClear.disabled = !bg.editorUrl;

    // Workspace preview
    if (bg.workspaceUrl) {
      this.appearanceWorkspaceImagePreview.style.backgroundImage = `url("${bg.workspaceUrl}")`;
      this.appearanceWorkspaceImagePreview.style.opacity = String(bg.workspaceOpacity);
      this.appearanceWorkspaceImagePreview.style.filter = bg.workspaceBlur > 0 ? `blur(${bg.workspaceBlur}px)` : "none";
      this.appearanceWorkspaceImagePreview.classList.remove("empty");
    } else {
      this.appearanceWorkspaceImagePreview.style.backgroundImage = "none";
      this.appearanceWorkspaceImagePreview.style.opacity = "1";
      this.appearanceWorkspaceImagePreview.style.filter = "none";
      this.appearanceWorkspaceImagePreview.classList.add("empty");
    }
    this.appearanceWorkspaceOpacity.value = String(Math.round(bg.workspaceOpacity * 100));
    this.appearanceWorkspaceBlur.value = String(bg.workspaceBlur ?? 0);
    this.appearanceWorkspaceImageClear.disabled = !bg.workspaceUrl;
    this.syncSliderLabels();
  }

  private syncSliderLabels(): void {
    const el = (id: string) => document.getElementById(id);
    const opEl = el("appearance-editor-opacity-val");
    const blEl = el("appearance-editor-blur-val");
    const wopEl = el("appearance-workspace-opacity-val");
    const wblEl = el("appearance-workspace-blur-val");
    if (opEl) opEl.textContent = `${this.appearanceEditorOpacity.value}%`;
    if (blEl) blEl.textContent = `${this.appearanceEditorBlur.value}px`;
    if (wopEl) wopEl.textContent = `${this.appearanceWorkspaceOpacity.value}%`;
    if (wblEl) wblEl.textContent = `${this.appearanceWorkspaceBlur.value}px`;
  }

  // ── Screen Saver UI Helpers ──

  private populateScreenSaver() {
    const ss = this.settings.appearance.screenSaver;
    this.ssEnabledEl.checked = ss.enabled;
    this.ssTimeoutEl.value = String(ss.timeoutMinutes);
    this.ssTimeoutValEl.textContent = `${ss.timeoutMinutes} min`;
    this.ssModeAnimEl.checked = ss.mode === "animation";
    this.ssModeImageEl.checked = ss.mode === "image";

    // Populate animation dropdown
    this.ssAnimationEl.innerHTML = ANIMATION_OPTIONS
      .map((a) => `<option value="${a.id}"${a.id === ss.animation ? " selected" : ""}>${a.label}</option>`)
      .join("");

    this.renderAnimationCards();
    this.updateScreenSaverImagePreview();
    this.updateScreenSaverVisibility();
  }

  private updateScreenSaverVisibility() {
    const ss = this.settings.appearance.screenSaver;
    const detailsEl = document.getElementById("ss-details-group");
    const animGroupEl = document.getElementById("ss-animation-group");
    const imageGroupEl = document.getElementById("ss-image-group");
    if (detailsEl) detailsEl.classList.toggle("hidden", !ss.enabled);
    if (animGroupEl) animGroupEl.classList.toggle("hidden", ss.mode !== "animation");
    if (imageGroupEl) imageGroupEl.classList.toggle("hidden", ss.mode !== "image");
  }

  private renderAnimationCards() {
    if (!this.ssAnimationCardsEl) return;
    
    // Cleanup previous animations
    this.ssAnimationCleanups.forEach(cleanup => cleanup());
    this.ssAnimationCleanups = [];

    const active = this.settings.appearance.screenSaver.animation;
    this.ssAnimationCardsEl.innerHTML = ANIMATION_OPTIONS.map((a) => {
      const isActive = a.id === active;
      return `<button class="ss-animation-card${isActive ? " active" : ""}" data-anim-id="${a.id}" type="button">
        <div class="ss-anim-preview-wrap">
          <canvas class="ss-anim-preview-canvas" width="140" height="80"></canvas>
        </div>
        <div class="ss-anim-info">
          <span class="ss-anim-name">${a.label}</span>
          <span class="ss-anim-desc">${a.description}</span>
        </div>
      </button>`;
    }).join("");

    this.ssAnimationCardsEl.querySelectorAll<HTMLButtonElement>(".ss-animation-card").forEach((card) => {
      const id = card.dataset.animId as ScreenSaverAnimation;
      
      const canvas = card.querySelector<HTMLCanvasElement>(".ss-anim-preview-canvas");
      if (canvas) {
        this.ssAnimationCleanups.push(runAnimationLoop(id, canvas, true));
      }

      card.addEventListener("click", () => {
        this.settings.appearance.screenSaver.animation = id;
        this.ssAnimationEl.value = id;
        this.renderAnimationCards();
      });
    });
  }

  private updateScreenSaverImagePreview() {
    const url = this.settings.appearance.screenSaver.imageUrl;
    if (url) {
      this.ssImagePreviewEl.style.backgroundImage = `url("${url}")`;
      this.ssImagePreviewEl.classList.remove("empty");
    } else {
      this.ssImagePreviewEl.style.backgroundImage = "none";
      this.ssImagePreviewEl.classList.add("empty");
    }
    this.ssImageClearBtn.disabled = !url;
  }

  private async promptThemeName(): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = document.getElementById("appearance-name-dialog")!;
      const inputEl = document.getElementById("appearance-name-input") as HTMLInputElement;
      const okBtn = document.getElementById("appearance-name-ok")!;
      const cancelBtn = document.getElementById("appearance-name-cancel")!;

      inputEl.value = "";
      overlay.classList.remove("hidden");
      inputEl.focus();

      const cleanup = () => {
        overlay.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
      };

      const onOk = () => {
        const name = inputEl.value.trim();
        if (!name) return;
        cleanup();
        resolve(name);
      };
      const onCancel = () => { cleanup(); resolve(null); };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); onOk(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      };

      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
    });
  }
}
