import { invoke } from "@tauri-apps/api/core";
import type { ExtensionCompatibilityIssue, ExtensionSupportSnapshot } from "./vscode-extension-support";

interface MarketplaceExtension {
  identifier: string;
  publisher: string;
  publisher_display_name: string;
  extension_name: string;
  display_name: string;
  description: string;
  version: string;
  icon_url: string;
  installs: number;
  average_rating: number;
  rating_count: number;
  download_url: string;
}

interface InstalledExtension {
  identifier: string;
  publisher: string;
  extension_name: string;
  display_name: string;
  description: string;
  version: string;
  install_path: string;
}

type StatusKind = "idle" | "loading" | "success" | "warning" | "error";
type ExtensionsTab = "installed" | "recommended" | "search";

interface ExtensionDetailState {
  kind: "installed" | "marketplace";
  identifier: string;
}

export interface ExtensionPreviewPayload {
  identifier: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  extensionName: string;
  iconUrl?: string;
  downloadUrl?: string;
  installs?: number;
  averageRating?: number;
  ratingCount?: number;
  readme?: string;
  installed: boolean;
  supportedFeatures: string[];
  unsupportedFeatures: string[];
  compatibilityIssues: ExtensionCompatibilityIssue[];
}

export interface ExtensionDiagnostic {
  timestamp: number;
  source: string;
  title: string;
  message: string;
  stack?: string;
}

interface ExtensionsPanelOptions {
  openInEditor?: (identifier: string, displayName: string) => void;
  openPreviewPage?: (payload: ExtensionPreviewPayload) => void;
  onExtensionSelected?: () => void;
  getSupport?: (identifier: string) => ExtensionSupportSnapshot | null;
  getDiagnostics?: (identifier: string) => ExtensionDiagnostic[];
  getSettingsState?: (identifier: string) => unknown;
  saveSettingsState?: (identifier: string, state: Record<string, unknown>) => Promise<void> | void;
  afterInstallChange?: () => Promise<void> | void;
  applyColorTheme?: (themeId: string) => Promise<void> | void;
  applyFileIconTheme?: (themeId: string) => Promise<void> | void;
}

export class ExtensionsPanel {
  private panelEl: HTMLElement;
  private resizeEl: HTMLElement;
  private triggerBtn: HTMLButtonElement;
  private searchInput: HTMLInputElement;
  private searchBtn: HTMLButtonElement;
  private refreshBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private installedEl: HTMLElement;
  private recommendedEl: HTMLElement;
  private resultsEl: HTMLElement;
  private detailEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private listTitleEl: HTMLElement;
  private listSubtitleEl: HTMLElement;
  private tabButtons: Record<ExtensionsTab, HTMLButtonElement>;
  private onResize: () => void;
  private getProjectPath: () => string;
  private options: ExtensionsPanelOptions;
  private installed: InstalledExtension[] = [];
  private recommended: MarketplaceExtension[] = [];
  private results: MarketplaceExtension[] = [];
  private activeQuery = "";
  private activeTab: ExtensionsTab = "installed";
  private selectedDetail: ExtensionDetailState | null = null;
  private refreshSeq = 0;
  private lastRefreshAt = 0;
  private readonly REFRESH_TTL_MS = 30_000;

  constructor(onResize: () => void, getProjectPath: () => string, options: ExtensionsPanelOptions = {}) {
    this.onResize = onResize;
    this.getProjectPath = getProjectPath;
    this.options = options;
    this.panelEl = document.getElementById("extensions-panel")!;
    this.resizeEl = document.getElementById("extensions-resize")!;
    this.triggerBtn = document.getElementById("btn-extensions-panel") as HTMLButtonElement;
    this.searchInput = document.getElementById("extensions-search-input") as HTMLInputElement;
    this.searchBtn = document.getElementById("btn-extensions-search") as HTMLButtonElement;
    this.refreshBtn = document.getElementById("btn-extensions-refresh") as HTMLButtonElement;
    this.closeBtn = document.getElementById("btn-close-extensions") as HTMLButtonElement;
    this.statusEl = document.getElementById("extensions-status")!;
    this.installedEl = document.getElementById("extensions-installed-list")!;
    this.recommendedEl = document.getElementById("extensions-recommended-list")!;
    this.resultsEl = document.getElementById("extensions-results-list")!;
    this.detailEl = document.getElementById("extensions-detail")!;
    this.subtitleEl = document.getElementById("extensions-subtitle")!;
    this.listTitleEl = document.getElementById("extensions-list-title")!;
    this.listSubtitleEl = document.getElementById("extensions-list-subtitle")!;
    this.tabButtons = {
      installed: document.getElementById("extensions-tab-installed") as HTMLButtonElement,
      recommended: document.getElementById("extensions-tab-recommended") as HTMLButtonElement,
      search: document.getElementById("extensions-tab-search") as HTMLButtonElement,
    };

    this.searchBtn.addEventListener("click", () => void this.runSearch());
    this.refreshBtn.addEventListener("click", () => void this.refresh());
    this.closeBtn.addEventListener("click", () => this.close());
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.runSearch();
      }
    });
    this.searchInput.addEventListener("input", () => {
      if (!this.searchInput.value.trim() && this.activeTab === "search") {
        this.setActiveTab("recommended");
      }
    });

    (Object.keys(this.tabButtons) as ExtensionsTab[]).forEach((tab) => {
      this.tabButtons[tab].addEventListener("click", () => this.setActiveTab(tab));
    });
    this.panelEl.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest("[data-extension-action]") as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.extensionAction;
      if (action === "search") {
        void this.runSearch();
      } else if (action === "install") {
        const identifier = target.dataset.identifier;
        if (identifier) void this.install(identifier);
      } else if (action === "uninstall") {
        const identifier = target.dataset.identifier;
        if (identifier) void this.uninstall(identifier);
      } else if (action === "select-installed") {
        const identifier = target.dataset.identifier;
        if (identifier) this.selectInstalled(identifier);
      } else if (action === "select-marketplace") {
        const identifier = target.dataset.identifier;
        if (identifier) this.selectMarketplace(identifier);
      } else if (action === "apply-color-theme") {
        const themeId = target.dataset.themeId;
        if (themeId) void this.options.applyColorTheme?.(themeId);
      } else if (action === "apply-file-icon-theme") {
        const themeId = target.dataset.themeId;
        if (themeId) void this.options.applyFileIconTheme?.(themeId);
      } else if (action === "open-marketplace") {
        const identifier = target.dataset.identifier;
        const displayName = target.dataset.displayName;
        if (identifier && displayName) {
          this.options.openInEditor?.(identifier, displayName);
        }
      } else if (action === "copy-support-errors") {
        const identifier = target.dataset.identifier;
        if (identifier) void this.copySupportErrors(identifier);
      } else if (action === "copy-diagnostics") {
        const identifier = target.dataset.identifier;
        if (identifier) void this.copyDiagnostics(identifier);
      }
    });

    this.renderStatus("idle", "Ready", "Search the Visual Studio Marketplace or review installed extensions.");
    this.setActiveTab("installed");
    this.renderInstalled();
    this.renderRecommended();
    this.renderResults();
    this.renderDetail();
  }

  getInstalled(): InstalledExtension[] { return this.installed; }

  setProject(_path: string) {
    if (!this.panelEl.classList.contains("hidden")) {
      void this.refresh();
    }
  }

  async open() {
    if (!this.panelEl.classList.contains("hidden")) return;
    // Reset state lazily on open so close() stays instant
    this.activeQuery = "";
    this.searchInput.value = "";
    this.results = [];
    this.selectedDetail = null;
    this.setActiveTab("installed");
    this.panelEl.classList.remove("hidden");
    this.resizeEl.classList.remove("hidden");
    this.triggerBtn.classList.add("active");
    setTimeout(() => this.onResize(), 0);
    if (Date.now() - this.lastRefreshAt > this.REFRESH_TTL_MS) {
      await this.refresh();
    }
  }

  close() {
    this.refreshSeq++; // cancel any in-flight refresh
    this.panelEl.classList.add("hidden");
    this.resizeEl.classList.add("hidden");
    this.triggerBtn.classList.remove("active");
    setTimeout(() => this.onResize(), 0);
  }

  isOpen(): boolean {
    return !this.panelEl.classList.contains("hidden");
  }

  refreshDetail() {
    if (!this.isOpen()) return;
    this.renderAllLists();
    this.renderDetail();
  }

  async refresh() {
    const seq = ++this.refreshSeq;
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      this.installed = [];
      this.recommended = [];
      this.results = [];
      this.selectedDetail = null;
      this.renderStatus("warning", "No project", "Open a project before browsing extensions.");
      this.renderAllLists();
      this.renderDetail();
      return;
    }

    this.subtitleEl.textContent = "Browse VSIX packages and install them globally for Athva";
    this.setBusy(true);
    try {
      const fetches: [Promise<InstalledExtension[]>, Promise<MarketplaceExtension[]>, Promise<MarketplaceExtension[]> | null] = [
        invoke<InstalledExtension[]>("list_installed_vscode_extensions", { projectPath }),
        invoke<MarketplaceExtension[]>("search_vscode_extensions", { query: "", limit: 18 }),
        this.activeQuery.trim()
          ? invoke<MarketplaceExtension[]>("search_vscode_extensions", { query: this.activeQuery, limit: 18 })
          : null,
      ];
      const [installed, recommended, results] = await Promise.all(fetches);
      if (seq !== this.refreshSeq) return;
      this.installed = installed;
      this.recommended = recommended;
      this.results = results ?? [];
      this.lastRefreshAt = Date.now();
      this.renderAllLists();
      this.renderDetail();
      this.renderStatus("success", "Extensions ready", `${this.installed.length} installed, ${this.recommended.length} recommended.`);
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      this.renderStatus("error", "Load failed", this.errorMessage(error));
    } finally {
      if (seq === this.refreshSeq) this.setBusy(false);
    }
  }

  private async runSearch(query = this.searchInput.value.trim()) {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      this.renderStatus("warning", "No project", "Open a project before searching the marketplace.");
      return;
    }

    this.activeQuery = query.trim();
    if (!this.activeQuery) {
      this.results = [];
      this.setActiveTab("recommended");
      this.renderResults();
      this.renderStatus("success", "Recommended extensions", "Showing recommended marketplace extensions.");
      return;
    }

    this.setBusy(true);
    this.setActiveTab("search");
    this.renderStatus("loading", "Searching marketplace", `Looking up "${this.activeQuery}" in the Visual Studio Marketplace.`);

    try {
      this.results = await invoke<MarketplaceExtension[]>("search_vscode_extensions", {
        query: this.activeQuery,
        limit: 18,
      });
      if (!this.selectedDetail || this.selectedDetail.kind !== "marketplace") {
        this.selectedDetail = this.results[0] ? { kind: "marketplace", identifier: this.results[0].identifier } : null;
      }
      this.renderResults();
      this.renderDetail();
      this.renderStatus("success", "Marketplace results", `${this.results.length} extensions matched your search.`);
    } catch (error) {
      this.results = [];
      this.renderResults();
      this.renderDetail();
      this.renderStatus("error", "Search failed", this.errorMessage(error));
    } finally {
      this.setBusy(false);
      this.renderResults();
      this.renderDetail();
    }
  }

  private async install(identifier: string) {
    const projectPath = this.getProjectPath();
    const extension = this.findMarketplace(identifier);
    if (!projectPath || !extension) return;

    this.setBusy(true);
    this.renderStatus("loading", "Installing extension", `Downloading ${extension.identifier} ${extension.version}.`);
    try {
      await invoke<InstalledExtension>("install_vscode_extension", {
        projectPath,
        publisher: extension.publisher,
        extensionName: extension.extension_name,
        version: extension.version,
        downloadUrl: extension.download_url,
      });
      this.installed = await invoke<InstalledExtension[]>("list_installed_vscode_extensions", { projectPath });
      await this.options.afterInstallChange?.();
      this.selectedDetail = { kind: "marketplace", identifier };
      this.renderAllLists();
      this.renderDetail();
      this.renderStatus("success", "Installed", `${extension.display_name} ${extension.version} is installed globally for Athva.`);
    } catch (error) {
      this.renderStatus("error", "Install failed", this.errorMessage(error));
    } finally {
      this.setBusy(false);
      this.renderAllLists();
      this.renderDetail();
    }
  }

  private async uninstall(identifier: string) {
    const projectPath = this.getProjectPath();
    if (!projectPath) return;

    this.setBusy(true);
    this.renderStatus("loading", "Uninstalling extension", `Removing ${identifier} from Athva.`);
    try {
      await invoke("uninstall_vscode_extension", { identifier });
      this.installed = await invoke<InstalledExtension[]>("list_installed_vscode_extensions", { projectPath });
      await this.options.afterInstallChange?.();
      if (this.selectedDetail?.identifier === identifier) {
        const fallbackMarketplace = this.findMarketplace(identifier);
        this.selectedDetail = fallbackMarketplace ? { kind: "marketplace", identifier } : null;
      }
      this.renderAllLists();
      this.renderDetail();
      this.renderStatus("success", "Uninstalled", `${identifier} was removed from Athva.`);
    } catch (error) {
      this.renderStatus("error", "Uninstall failed", this.errorMessage(error));
    } finally {
      this.setBusy(false);
      this.renderAllLists();
      this.renderDetail();
    }
  }

  private setBusy(isBusy: boolean) {
    this.searchInput.disabled = isBusy;
    this.searchBtn.disabled = isBusy;
    this.refreshBtn.disabled = isBusy;
    Object.values(this.tabButtons).forEach((button) => {
      button.disabled = isBusy;
    });
    this.panelEl.classList.toggle("extensions-panel-loading", isBusy);
  }

  private setActiveTab(tab: ExtensionsTab) {
    this.activeTab = tab;
    (Object.keys(this.tabButtons) as ExtensionsTab[]).forEach((key) => {
      this.tabButtons[key].classList.toggle("active", key === tab);
    });
    this.installedEl.classList.toggle("hidden", tab !== "installed");
    this.recommendedEl.classList.toggle("hidden", tab !== "recommended");
    this.resultsEl.classList.toggle("hidden", tab !== "search");

    if (tab === "installed") {
      this.listTitleEl.textContent = "Installed in Athva";
      this.listSubtitleEl.textContent = "global app store";
      if (!this.selectedDetail && this.installed[0]) {
        this.selectedDetail = { kind: "installed", identifier: this.installed[0].identifier };
      }
    } else if (tab === "recommended") {
      this.listTitleEl.textContent = "Recommended";
      this.listSubtitleEl.textContent = "popular marketplace picks";
      if (!this.selectedDetail && this.recommended[0]) {
        this.selectedDetail = { kind: "marketplace", identifier: this.recommended[0].identifier };
      }
    } else {
      this.listTitleEl.textContent = this.activeQuery ? `Search: ${this.activeQuery}` : "Search";
      this.listSubtitleEl.textContent = "Visual Studio Marketplace";
      if (!this.selectedDetail && this.results[0]) {
        this.selectedDetail = { kind: "marketplace", identifier: this.results[0].identifier };
      }
    }

    this.renderDetail();
  }

  private renderAllLists() {
    this.renderInstalled();
    this.renderRecommended();
    this.renderResults();
  }

  private renderInstalled() {
    if (!this.installed.length) {
      this.installedEl.innerHTML = `
        <div class="extensions-empty-state">
          <div class="extensions-empty-title">No installed extensions</div>
          <div class="extensions-empty-copy">Installed VSIX packages for Athva will appear here.</div>
        </div>
      `;
      return;
    }

    this.installedEl.innerHTML = this.installed.map((item) => this.renderListCard({
      kind: "installed",
      identifier: item.identifier,
      displayName: item.display_name,
      version: item.version,
      description: item.description,
      subtitle: item.identifier,
      iconUrl: "",
      selected: this.selectedDetail?.identifier === item.identifier && this.selectedDetail.kind === "installed",
      action: "select-installed",
    })).join("");
  }

  private renderRecommended() {
    if (!this.recommended.length) {
      this.recommendedEl.innerHTML = `
        <div class="extensions-empty-state">
          <div class="extensions-empty-title">No recommendations</div>
          <div class="extensions-empty-copy">Refresh to load recommended marketplace extensions.</div>
        </div>
      `;
      return;
    }
    this.recommendedEl.innerHTML = this.recommended.map((item) => this.renderListCard({
      kind: "marketplace",
      identifier: item.identifier,
      displayName: item.display_name,
      version: item.version,
      description: item.description,
      subtitle: `${item.identifier} · ${formatInstalls(item.installs)} installs`,
      iconUrl: item.icon_url,
      selected: this.selectedDetail?.identifier === item.identifier && this.selectedDetail.kind === "marketplace",
      action: "select-marketplace",
    })).join("");
  }

  private renderResults() {
    if (!this.results.length) {
      this.resultsEl.innerHTML = `
        <div class="extensions-empty-state">
          <div class="extensions-empty-title">No search results</div>
          <div class="extensions-empty-copy">Search for an extension name, or return to Recommended.</div>
          <button class="extensions-run-btn" data-extension-action="search">Load Recommended</button>
        </div>
      `;
      return;
    }
    this.resultsEl.innerHTML = this.results.map((item) => this.renderListCard({
      kind: "marketplace",
      identifier: item.identifier,
      displayName: item.display_name,
      version: item.version,
      description: item.description,
      subtitle: `${item.identifier} · ${formatRating(item.average_rating, item.rating_count)}`,
      iconUrl: item.icon_url,
      selected: this.selectedDetail?.identifier === item.identifier && this.selectedDetail.kind === "marketplace",
      action: "select-marketplace",
    })).join("");
  }

  private renderListCard(input: {
    kind: "installed" | "marketplace";
    identifier: string;
    displayName: string;
    version: string;
    description: string;
    subtitle: string;
    iconUrl: string;
    selected: boolean;
    action: "select-installed" | "select-marketplace";
  }): string {
    return `
      <article class="extensions-list-card${input.selected ? " selected" : ""}" data-extension-action="${input.action}" data-identifier="${escapeHtml(input.identifier)}">
        <div class="extensions-result-head">
          ${input.iconUrl ? `<img class="extensions-icon" src="${escapeAttribute(input.iconUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />` : `<div class="extensions-icon extensions-icon-placeholder"></div>`}
          <div class="extensions-result-copy">
            <div class="extensions-result-title-row">
              <strong>${escapeHtml(input.displayName)}</strong>
              <span class="extensions-pill">${escapeHtml(input.version)}</span>
            </div>
            <div class="extensions-meta">${escapeHtml(input.subtitle)}</div>
          </div>
        </div>
        <p class="extensions-copy">${escapeHtml(input.description || "No description provided.")}</p>
      </article>
    `;
  }

  private renderDetail() {
    const detail = this.selectedDetail
      ? (this.selectedDetail.kind === "installed"
          ? this.findInstalled(this.selectedDetail.identifier) ?? this.findMarketplace(this.selectedDetail.identifier) ?? null
          : this.findMarketplace(this.selectedDetail.identifier) ?? this.findInstalled(this.selectedDetail.identifier) ?? null)
      : null;

    if (!detail) {
      this.detailEl.classList.remove("hidden");
      this.detailEl.innerHTML = `
        <div class="extensions-detail-empty">
          <div class="extensions-empty-title">Select an extension</div>
          <div class="extensions-empty-copy">Open an extension to inspect details, install it, or uninstall it.</div>
        </div>
      `;
      return;
    }

    const support = this.options.getSupport?.(detail.identifier) ?? null;
    const diagnostics = this.options.getDiagnostics?.(detail.identifier) ?? [];
    const marketplace = this.findMarketplace(detail.identifier);
    const installed = this.isInstalled(detail.identifier);
    const iconUrl = marketplace?.icon_url || "";
    const compatibleCount = support?.supportedFeatures.length ?? 0;
    const issueCount = support?.compatibilityIssues.length ?? 0;
    const primaryAction = installed
      ? `<button class="extensions-run-btn extensions-run-btn-muted" data-extension-action="uninstall" data-identifier="${escapeAttribute(detail.identifier)}">Uninstall</button>`
      : `<button class="extensions-run-btn" data-extension-action="install" data-identifier="${escapeAttribute(detail.identifier)}" ${marketplace?.download_url ? "" : "disabled"}>Install</button>`;
    const supportHtml = support
      ? renderCompatibilityBlock(detail.identifier, support.compatibilityIssues, support.supportedFeatures)
      : `
        <div class="extensions-support-card">
          <div class="extensions-support-card-title">Compatibility Pending</div>
          <p class="extensions-support-card-copy">Install this extension in Athva to inspect which VS Code features map cleanly and which ones do not.</p>
        </div>
      `;
    const diagnosticsHtml = diagnostics.length ? renderDiagnosticsBlock(detail.identifier, diagnostics) : "";

    this.detailEl.classList.remove("hidden");
    this.detailEl.innerHTML = `
      <article class="extensions-detail-card">
        <div class="extensions-detail-head">
          ${iconUrl
            ? `<img class="extensions-detail-icon" src="${escapeAttribute(iconUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
            : `<div class="extensions-detail-icon extensions-icon-placeholder"></div>`}
          <div class="extensions-detail-copy">
            <strong>${escapeHtml(detail.display_name)}</strong>
            <div class="extensions-meta">${escapeHtml(detail.identifier)}</div>
            <div class="extensions-detail-stats">
              <span>${escapeHtml(detail.version)}</span>
              <span>${installed ? "Installed in Athva" : "Marketplace package"}</span>
              ${support ? `<span>${compatibleCount} supported</span><span>${issueCount} issue${issueCount === 1 ? "" : "s"}</span>` : ""}
            </div>
          </div>
        </div>
        <p class="extensions-copy">${escapeHtml(detail.description || "No description provided.")}</p>
        <div class="extensions-detail-actions">
          ${primaryAction}
          <button class="extensions-run-btn extensions-run-btn-muted" data-extension-action="open-marketplace" data-identifier="${escapeAttribute(detail.identifier)}" data-display-name="${escapeAttribute(detail.display_name)}">Open Marketplace</button>
        </div>
        ${supportHtml}
        ${diagnosticsHtml}
      </article>
    `;
  }

  private selectInstalled(identifier: string) {
    this.selectedDetail = { kind: "installed", identifier };
    this.renderAllLists();
    this.renderDetail();
    this.openPreviewPage(identifier, "installed");
  }

  private selectMarketplace(identifier: string) {
    this.selectedDetail = { kind: "marketplace", identifier };
    this.renderAllLists();
    this.renderDetail();
    this.openPreviewPage(identifier, "marketplace");
  }

  private openPreviewPage(identifier: string, kind: "installed" | "marketplace") {
    const detail = kind === "installed"
      ? this.findInstalled(identifier) ?? this.findMarketplace(identifier) ?? null
      : this.findMarketplace(identifier) ?? this.findInstalled(identifier) ?? null;
    if (!detail) return;
    const support = this.options.getSupport?.(detail.identifier) ?? null;
    const marketplace = this.findMarketplace(identifier);
    this.options.openPreviewPage?.({
      identifier: detail.identifier,
      displayName: detail.display_name,
      description: detail.description,
      version: detail.version,
      publisher: detail.publisher,
      extensionName: detail.extension_name,
      iconUrl: marketplace?.icon_url,
      downloadUrl: marketplace?.download_url,
      installs: marketplace?.installs,
      averageRating: marketplace?.average_rating,
      ratingCount: marketplace?.rating_count,
      readme: support?.readme || "",
      installed: this.isInstalled(detail.identifier),
      supportedFeatures: support?.supportedFeatures ?? [],
      unsupportedFeatures: support?.unsupportedFeatures ?? [],
      compatibilityIssues: support?.compatibilityIssues ?? [],
    });
    this.options.onExtensionSelected?.();
  }

  private findMarketplace(identifier: string): MarketplaceExtension | undefined {
    return [...this.results, ...this.recommended].find((item) => item.identifier === identifier);
  }

  private findInstalled(identifier: string): InstalledExtension | undefined {
    return this.installed.find((item) => item.identifier === identifier);
  }

  private isInstalled(identifier: string): boolean {
    return this.installed.some((item) => item.identifier === identifier);
  }

  private renderStatus(kind: StatusKind, title: string, text: string) {
    this.statusEl.className = `extensions-status extensions-status-${kind}`;
    this.statusEl.innerHTML = `
      <div class="extensions-status-icon">${statusIcon(kind)}</div>
      <div class="extensions-status-copy">
        <div class="extensions-status-title">${escapeHtml(title)}</div>
        <div class="extensions-status-text">${escapeHtml(text)}</div>
      </div>
    `;
  }

  private errorMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    return "Unknown error.";
  }

  private async copySupportErrors(identifier: string) {
    const support = this.options.getSupport?.(identifier) ?? null;
    if (!support?.compatibilityIssues.length) return;
    try {
      await navigator.clipboard.writeText(formatCompatibilityIssuesForClipboard(
        support.displayName || identifier,
        identifier,
        support.compatibilityIssues
      ));
      this.renderStatus("success", "Copied", `Compatibility errors for ${support.displayName || identifier} were copied.`);
    } catch {
      this.renderStatus("error", "Copy failed", "Athva could not copy the compatibility errors to the clipboard.");
    }
  }

  private async copyDiagnostics(identifier: string) {
    const diagnostics = this.options.getDiagnostics?.(identifier) ?? [];
    if (!diagnostics.length) return;
    try {
      await navigator.clipboard.writeText(formatDiagnosticsForClipboard(identifier, diagnostics));
      this.renderStatus("success", "Copied", `Diagnostics for ${identifier} were copied.`);
    } catch {
      this.renderStatus("error", "Copy failed", "Athva could not copy the diagnostics to the clipboard.");
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value || "");
}

function formatInstalls(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return value.toString();
}

function formatRating(value: number, count: number): string {
  if (!Number.isFinite(value) || value <= 0 || !count) return "No ratings";
  return `${value.toFixed(1)}★ (${count})`;
}

function statusIcon(kind: StatusKind): string {
  switch (kind) {
    case "loading":
      return "…";
    case "success":
      return "✓";
    case "warning":
      return "!";
    case "error":
      return "×";
    default:
      return "•";
  }
}

function renderCompatibilityBlock(
  identifier: string,
  issues: ExtensionCompatibilityIssue[],
  supportedFeatures: string[]
): string {
  const supportedHtml = supportedFeatures.length
    ? `<ul class="extensions-support-list">${supportedFeatures.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p class="extensions-support-card-copy">No Athva-supported contribution types were detected in the installed manifest.</p>`;

  const issuesHtml = issues.length
    ? issues.map((issue) => `
      <article class="extensions-compat-issue">
        <div class="extensions-compat-issue-head">
          <strong>${escapeHtml(issue.title)}</strong>
          <span class="extensions-compat-issue-code">${escapeHtml(issue.code)}</span>
        </div>
        <p>${escapeHtml(issue.summary)}</p>
        <ul class="extensions-support-list">${issue.details.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </article>
    `).join("")
    : `<p class="extensions-support-card-copy">No known compatibility blockers were detected for this extension package.</p>`;

  return `
    <div class="extensions-detail-support">
      <section class="extensions-support-card">
        <div class="extensions-support-card-title">Athva Support</div>
        ${supportedHtml}
      </section>
      <section class="extensions-support-card extensions-support-card-errors">
        <div class="extensions-support-card-head">
          <div>
            <div class="extensions-support-card-title">Unsupported VS Code Features</div>
            <p class="extensions-support-card-copy">These extension capabilities will not work correctly in Athva.</p>
          </div>
          ${issues.length
            ? `<button class="extensions-copy-btn" data-extension-action="copy-support-errors" data-identifier="${escapeAttribute(identifier)}">Copy</button>`
            : ""}
        </div>
        ${issuesHtml}
      </section>
    </div>
  `;
}

function formatCompatibilityIssuesForClipboard(
  displayName: string,
  identifier: string,
  issues: ExtensionCompatibilityIssue[]
): string {
  const lines = [
    `Extension: ${displayName}`,
    `Identifier: ${identifier}`,
    "",
    "Unsupported VS Code features in Athva:",
  ];
  for (const issue of issues) {
    lines.push(`- ${issue.title} [${issue.code}]`);
    lines.push(`  ${issue.summary}`);
    for (const detail of issue.details) {
      lines.push(`  • ${detail}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function renderDiagnosticsBlock(identifier: string, diagnostics: ExtensionDiagnostic[]): string {
  const items = diagnostics
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 12);
  const listHtml = items.map((d) => `
    <article class="extensions-compat-issue">
      <div class="extensions-compat-issue-head">
        <strong>${escapeHtml(d.title)}</strong>
        <span class="extensions-compat-issue-code">${escapeHtml(d.source)}</span>
      </div>
      <p>${escapeHtml(d.message)}</p>
      ${d.stack ? `<pre class="extensions-diagnostic-stack">${escapeHtml(d.stack)}</pre>` : ""}
    </article>
  `).join("");

  return `
    <section class="extensions-support-card extensions-support-card-errors">
      <div class="extensions-support-card-head">
        <div>
          <div class="extensions-support-card-title">Diagnostics</div>
          <p class="extensions-support-card-copy">Recent errors and unsupported-view notices captured while using this extension.</p>
        </div>
        <button class="extensions-copy-btn" data-extension-action="copy-diagnostics" data-identifier="${escapeAttribute(identifier)}">Copy</button>
      </div>
      ${listHtml}
    </section>
  `;
}

function formatDiagnosticsForClipboard(identifier: string, diagnostics: ExtensionDiagnostic[]): string {
  const items = diagnostics
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);
  const lines = [
    `Identifier: ${identifier}`,
    "",
    "Diagnostics:",
  ];
  for (const d of items) {
    const ts = new Date(d.timestamp).toISOString();
    lines.push(`- ${d.title} (${d.source}, ${ts})`);
    lines.push(`  ${d.message}`);
    if (d.stack) {
      lines.push("  Stack:");
      for (const line of d.stack.split("\n")) lines.push(`    ${line}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
