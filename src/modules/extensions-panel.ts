import { invoke } from "@tauri-apps/api/core";

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
  private resultsEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private onResize: () => void;
  private getProjectPath: () => string;
  private installed: InstalledExtension[] = [];
  private results: MarketplaceExtension[] = [];
  private activeQuery = "";
  private isBusy = false;

  constructor(onResize: () => void, getProjectPath: () => string) {
    this.onResize = onResize;
    this.getProjectPath = getProjectPath;
    this.panelEl = document.getElementById("extensions-panel")!;
    this.resizeEl = document.getElementById("extensions-resize")!;
    this.triggerBtn = document.getElementById("btn-extensions-panel") as HTMLButtonElement;
    this.searchInput = document.getElementById("extensions-search-input") as HTMLInputElement;
    this.searchBtn = document.getElementById("btn-extensions-search") as HTMLButtonElement;
    this.refreshBtn = document.getElementById("btn-extensions-refresh") as HTMLButtonElement;
    this.closeBtn = document.getElementById("btn-close-extensions") as HTMLButtonElement;
    this.statusEl = document.getElementById("extensions-status")!;
    this.installedEl = document.getElementById("extensions-installed-list")!;
    this.resultsEl = document.getElementById("extensions-results-list")!;
    this.subtitleEl = document.getElementById("extensions-subtitle")!;

    this.searchBtn.addEventListener("click", () => void this.runSearch());
    this.refreshBtn.addEventListener("click", () => void this.refresh());
    this.closeBtn.addEventListener("click", () => this.close());
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.runSearch();
      }
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
      } else if (action === "reveal") {
        const path = target.dataset.path;
        if (path) void invoke("reveal_in_explorer", { path }).catch(() => {});
      }
    });

    this.renderStatus("idle", "Ready", "Search the Visual Studio Marketplace or load popular extensions.");
    this.renderInstalled();
    this.renderResults();
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
    this.renderResults();
    this.renderStatus("idle", "Ready", "Search the Visual Studio Marketplace or load popular extensions.");
    setTimeout(() => this.onResize(), 0);
  }

  isOpen(): boolean {
    return !this.panelEl.classList.contains("hidden");
  }

  async refresh() {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      this.installed = [];
      this.results = [];
      this.renderStatus("warning", "No project", "Open a project before installing extensions.");
      this.renderInstalled();
      this.renderResults();
      return;
    }

    this.subtitleEl.textContent = "Browse VSIX packages and install them into .athva/extensions";
    this.setBusy(true);
    try {
      this.installed = await invoke<InstalledExtension[]>("list_installed_vscode_extensions", {
        projectPath,
      });
      this.renderInstalled();
      await this.runSearch(this.activeQuery, false);
      if (!this.results.length) {
        this.renderStatus("success", "Installed list updated", `${this.installed.length} extensions available in this project.`);
      }
    } catch (error) {
      this.renderStatus("error", "Load failed", this.errorMessage(error));
    } finally {
      this.setBusy(false);
      this.renderResults();
    }
  }

  private async runSearch(query = this.searchInput.value.trim(), manageBusy = true) {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      this.renderStatus("warning", "No project", "Open a project before searching the marketplace.");
      return;
    }

    this.activeQuery = query.trim();
    if (manageBusy) this.setBusy(true);
    this.renderStatus(
      "loading",
      this.activeQuery ? "Searching marketplace" : "Loading popular extensions",
      this.activeQuery
        ? `Looking up "${this.activeQuery}" in the Visual Studio Marketplace.`
        : "Fetching popular Visual Studio Code extensions."
    );

    try {
      this.results = await invoke<MarketplaceExtension[]>("search_vscode_extensions", {
        query: this.activeQuery,
        limit: 18,
      });
      this.renderResults();
      this.renderStatus(
        "success",
        this.activeQuery ? "Marketplace results" : "Popular extensions",
        `${this.results.length} extensions ready to install.`
      );
    } catch (error) {
      this.results = [];
      this.renderResults();
      this.renderStatus("error", "Search failed", this.errorMessage(error));
    } finally {
      if (manageBusy) this.setBusy(false);
      this.renderResults();
    }
  }

  private async install(identifier: string) {
    const projectPath = this.getProjectPath();
    const extension = this.results.find((item) => item.identifier === identifier);
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
      this.installed = await invoke<InstalledExtension[]>("list_installed_vscode_extensions", {
        projectPath,
      });
      this.renderInstalled();
      this.renderResults();
      this.renderStatus(
        "success",
        "Installed",
        `${extension.display_name} ${extension.version} is available under .athva/extensions.`
      );
    } catch (error) {
      this.renderStatus("error", "Install failed", this.errorMessage(error));
    } finally {
      this.setBusy(false);
      this.renderResults();
    }
  }

  private setBusy(isBusy: boolean) {
    this.isBusy = isBusy;
    this.searchInput.disabled = isBusy;
    this.searchBtn.disabled = isBusy;
    this.refreshBtn.disabled = isBusy;
    this.panelEl.classList.toggle("extensions-panel-loading", isBusy);
  }

  private renderInstalled() {
    if (!this.installed.length) {
      this.installedEl.innerHTML = `
        <div class="extensions-empty-state">
          <div class="extensions-empty-title">No installed extensions</div>
          <div class="extensions-empty-copy">Installed VSIX packages for this project will appear here.</div>
        </div>
      `;
      return;
    }

    this.installedEl.innerHTML = this.installed
      .map(
        (item) => `
          <article class="extensions-installed-card">
            <div class="extensions-installed-main">
              <div class="extensions-installed-title-row">
                <strong>${escapeHtml(item.display_name)}</strong>
                <span class="extensions-pill">v${escapeHtml(item.version)}</span>
              </div>
              <div class="extensions-meta">${escapeHtml(item.identifier)}</div>
              <p class="extensions-copy">${escapeHtml(item.description || "No description provided.")}</p>
            </div>
            <button
              class="extensions-secondary-btn"
              data-extension-action="reveal"
              data-path="${escapeHtml(item.install_path)}"
            >
              Open Folder
            </button>
          </article>
        `
      )
      .join("");
  }

  private renderResults() {
    if (!this.results.length) {
      this.resultsEl.innerHTML = `
        <div class="extensions-empty-state">
          <div class="extensions-empty-title">No marketplace results</div>
          <div class="extensions-empty-copy">Try another search term or load popular extensions.</div>
          <button class="extensions-run-btn" data-extension-action="search">Load Popular Extensions</button>
        </div>
      `;
      return;
    }

    const installed = new Set(this.installed.map((item) => item.identifier));
    this.resultsEl.innerHTML = this.results
      .map((item) => {
        const isInstalled = installed.has(item.identifier);
        return `
          <article class="extensions-result-card">
            <div class="extensions-result-head">
              <img
                class="extensions-icon"
                src="${escapeAttribute(item.icon_url)}"
                alt=""
                loading="lazy"
                onerror="this.style.visibility='hidden'"
              />
              <div class="extensions-result-copy">
                <div class="extensions-result-title-row">
                  <strong>${escapeHtml(item.display_name)}</strong>
                  <span class="extensions-pill">${escapeHtml(item.version)}</span>
                </div>
                <div class="extensions-meta">${escapeHtml(item.identifier)} · ${escapeHtml(item.publisher_display_name)}</div>
              </div>
            </div>
            <p class="extensions-copy">${escapeHtml(item.description || "No description provided.")}</p>
            <div class="extensions-result-footer">
              <div class="extensions-stats">
                <span>${formatInstalls(item.installs)} installs</span>
                <span>${formatRating(item.average_rating, item.rating_count)}</span>
              </div>
              <button
                class="${isInstalled ? "extensions-secondary-btn" : "extensions-install-btn"}"
                data-extension-action="install"
                data-identifier="${escapeHtml(item.identifier)}"
                ${this.isBusy ? "disabled" : ""}
              >
                ${isInstalled ? "Reinstall" : "Install"}
              </button>
            </div>
          </article>
        `;
      })
      .join("");
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
