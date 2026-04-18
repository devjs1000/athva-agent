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

export interface AppSettings {
  editor: EditorSettings;
  ai: AISettings;
  agentAccess: AgentAccess;
  memory: MemorySettings;
  security: SecuritySettings;
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
  editor: { ...DEFAULT_EDITOR_SETTINGS },
  ai: { ...DEFAULT_AI_SETTINGS },
  agentAccess: { ...DEFAULT_AGENT_ACCESS },
  memory: { ...DEFAULT_MEMORY_SETTINGS },
  security: { ...DEFAULT_SECURITY_SETTINGS },
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
  private activeTab = "all";

  // Editor elements
  private themeEl: HTMLSelectElement;
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
    this.themeEl.value = this.settings.editor.theme;
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
    };
  }

  private updateSecurityStatus() {
    const pinSet = !!(this.settings.security.pinHash && this.settings.security.pinSalt);
    const fpSet = !!this.settings.security.fingerprintCredentialId;
    this.securityPinStatusEl.textContent = pinSet ? "Set" : "Not set";
    this.securityFingerprintStatusEl.textContent = fpSet ? "Set" : "Not set";
    this.securityClearPinBtnEl.disabled = !pinSet;
    this.securityClearFingerprintBtnEl.disabled = !fpSet;
  }

  private async digestSha256Base64(data: Uint8Array): Promise<string> {
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

  private webAuthnSupported(): boolean {
    return typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
  }

  private async setupFingerprint() {
    if (!this.webAuthnSupported()) {
      this.securityFingerprintStatusEl.textContent = "Not supported on this platform";
      return;
    }
    const challenge = this.randomBytes(32);
    const userId = this.randomBytes(16);

    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Athva" },
        user: { id: userId, name: "athva", displayName: "Athva" },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "required",
        },
        attestation: "none",
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;

    if (!credential) return;
    const rawId = new Uint8Array(credential.rawId);
    const credentialId = this.base64UrlEncode(rawId);
    this.settings = {
      ...this.settings,
      security: {
        ...this.settings.security,
        fingerprintCredentialId: credentialId,
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

    this.securitySetPinBtnEl.addEventListener("click", async () => {
      await this.setPin();
    });
    this.securityClearPinBtnEl.addEventListener("click", () => this.clearPin());
    this.securitySetupFingerprintBtnEl.addEventListener("click", async () => {
      await this.setupFingerprint();
    });
    this.securityClearFingerprintBtnEl.addEventListener("click", () => this.clearFingerprint());

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
}
