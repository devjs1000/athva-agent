import { invoke } from "@tauri-apps/api/core";
import type { ExtensionSupportSnapshot } from "./vscode-extension-support";

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

interface ExtensionsPanelOptions {
  openInEditor?: (identifier: string, displayName: string) => void;
  getSupport?: (identifier: string) => ExtensionSupportSnapshot | null;
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
  private isBusy = false;

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
      }
    });

    this.renderStatus("idle", "Ready", "Search the Visual Studio Marketplace or review installed extensions.");
    this.setActiveTab("installed");
    this.renderInstalled();
    this.renderRecommended();
    this.renderResults();
    this.renderDetail();
  }

  setProject(_path: string) {
    if (!this.panelEl.classList.contains("hidden")) {
      void this.refresh();
    }
  }

  async open() {
    if (!this.panelEl.classList.contains("hidden")) return;
    this.panelEl.classList.remove("hidden");
    this.resizeEl.classList.remove("hidden");
    this.triggerBtn.classList.add("active");
    setTimeout(() => this.onResize(), 0);
    await this.refresh();
  }

  close() {
    this.panelEl.classList.add("hidden");
    this.resizeEl.classList.add("hidden");
    this.triggerBtn.classList.remove("active");
    this.activeQuery = "";
    this.searchInput.value = "";
    this.results = [];
    this.selectedDetail = null;
    this.setActiveTab("installed");
    this.renderResults();
    this.renderDetail();
    this.renderStatus("idle", "Ready", "Search the Visual Studio Marketplace or review installed extensions.");
    setTimeout(() => this.onResize(), 0);
  }

  isOpen(): boolean {
    return !this.panelEl.classList.contains("hidden");
  }

  async refresh() {
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
      this.installed = await invoke<InstalledExtension[]>("list_installed_vscode_extensions", { projectPath });
      this.recommended = await invoke<MarketplaceExtension[]>("search_vscode_extensions", { query: "", limit: 18 });
      if (this.activeQuery.trim()) {
        this.results = await invoke<MarketplaceExtension[]>("search_vscode_extensions", { query: this.activeQuery, limit: 18 });
      } else {
        this.results = [];
      }
      this.renderAllLists();
      this.renderDetail();
      this.renderStatus("success", "Extensions ready", `${this.installed.length} installed, ${this.recommended.length} recommended.`);
    } catch (error) {
      this.renderStatus("error", "Load failed", this.errorMessage(error));
    } finally {
      this.setBusy(false);
      this.renderAllLists();
      this.renderDetail();
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
    this.isBusy = isBusy;
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
    const expanded = this.selectedDetail?.identifier === input.identifier && this.selectedDetail.kind === input.kind;
    return `
      <article class="extensions-list-card${input.selected ? " selected" : ""}${expanded ? " expanded" : ""}" data-extension-action="${input.action}" data-identifier="${escapeHtml(input.identifier)}">
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
        ${expanded ? this.renderExpandedCardDetail(input.identifier, input.kind, input.iconUrl) : ""}
      </article>
    `;
  }

  private renderDetail() {
    this.detailEl.classList.add("hidden");
    this.detailEl.innerHTML = "";
  }

  private renderExpandedCardDetail(identifier: string, kind: "installed" | "marketplace", iconUrl: string): string {
    const detail = kind === "installed"
      ? this.findInstalled(identifier) ?? this.findMarketplace(identifier) ?? null
      : this.findMarketplace(identifier) ?? this.findInstalled(identifier) ?? null;
    if (!detail) return "";

    const marketplaceDetail = isMarketplaceExtension(detail) ? detail : null;
    const installed = this.isInstalled(detail.identifier);
    const installedInfo = this.findInstalled(detail.identifier);
    const support = this.options.getSupport?.(detail.identifier) ?? null;
    const stats = marketplaceDetail
      ? `<div class="extensions-detail-stats">
          <span>${formatInstalls(marketplaceDetail.installs)} installs</span>
          <span>${formatRating(marketplaceDetail.average_rating, marketplaceDetail.rating_count)}</span>
          <span>${escapeHtml(marketplaceDetail.publisher_display_name)}</span>
        </div>`
      : `<div class="extensions-detail-stats">
          <span>Installed globally in Athva</span>
          <span>${escapeHtml(detail.publisher)}</span>
        </div>`;

    return `
      <div class="extensions-inline-detail">
        <div class="extensions-detail-head">
          ${iconUrl ? `<img class="extensions-detail-icon" src="${escapeAttribute(iconUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />` : `<div class="extensions-detail-icon extensions-icon-placeholder"></div>`}
          <div class="extensions-detail-copy">
            <div class="extensions-result-title-row">
              <strong>${escapeHtml(detail.display_name)}</strong>
              <span class="extensions-pill">${escapeHtml(detail.version)}</span>
            </div>
            <div class="extensions-meta">${escapeHtml(detail.identifier)}</div>
            ${stats}
          </div>
        </div>
        <div class="extensions-detail-actions">
          ${installed
            ? `<button class="extensions-secondary-btn" data-extension-action="uninstall" data-identifier="${escapeHtml(detail.identifier)}" ${this.isBusy ? "disabled" : ""}>Uninstall</button>`
            : marketplaceDetail
              ? `<button class="extensions-install-btn" data-extension-action="install" data-identifier="${escapeHtml(detail.identifier)}" ${this.isBusy ? "disabled" : ""}>Install</button>`
              : ""
          }
        </div>
        <div class="extensions-detail-note">Opening this extension launches the marketplace page in the editor area.</div>
        ${support?.supportedFeatures.length ? `<div class="extensions-detail-note">Athva support: ${escapeHtml(support.supportedFeatures.join(", "))}</div>` : ""}
        ${support?.fileIconThemes.map((theme) => `<button class="extensions-secondary-btn" data-extension-action="apply-file-icon-theme" data-theme-id="${escapeAttribute(theme.id)}">Set File Icons: ${escapeHtml(theme.label)}</button>`).join("") ?? ""}
        ${support?.colorThemes.map((theme) => `<button class="extensions-secondary-btn" data-extension-action="apply-color-theme" data-theme-id="${escapeAttribute(theme.id)}">Set Theme: ${escapeHtml(theme.label)}</button>`).join("") ?? ""}
        ${support?.snippetCount ? `<div class="extensions-detail-note">${support.snippetCount} snippet${support.snippetCount === 1 ? "" : "s"} are active in Athva.</div>` : ""}
        ${support?.unsupportedFeatures.length ? `<div class="extensions-detail-note">Not supported here: ${escapeHtml(support.unsupportedFeatures.join(", "))}</div>` : ""}
        ${installedInfo
          ? `<div class="extensions-detail-note">Installed version: ${escapeHtml(installedInfo.version)}</div>`
          : `<div class="extensions-detail-note">Not installed in Athva yet.</div>`
        }
      </div>
    `;
  }

  private selectInstalled(identifier: string) {
    this.selectedDetail = { kind: "installed", identifier };
    this.renderAllLists();
    this.renderDetail();
    const extension = this.findInstalled(identifier);
    if (extension) {
      this.options.openInEditor?.(identifier, extension.display_name);
    }
  }

  private selectMarketplace(identifier: string) {
    this.selectedDetail = { kind: "marketplace", identifier };
    this.renderAllLists();
    this.renderDetail();
    const extension = this.findMarketplace(identifier);
    if (extension) {
      this.options.openInEditor?.(identifier, extension.display_name);
    }
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
}

function isMarketplaceExtension(
  extension: InstalledExtension | MarketplaceExtension
): extension is MarketplaceExtension {
  return "installs" in extension;
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
