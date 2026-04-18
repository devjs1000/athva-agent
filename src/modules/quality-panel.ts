import { invoke } from "@tauri-apps/api/core";
import {
  merge_quality_config,
  should_include_quality_file,
  type QualityAnalysisInput,
  type QualityPackageManifest,
  type QualityPanelConfig,
  type QualityReport,
  type QualitySourceFile,
  type QualityViolation,
} from "./quality-core";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

type StatusKind = "idle" | "loading" | "success" | "warning" | "error";

const CONFIG_CANDIDATES = [
  ".athva/quality-panel.json",
  "quality-panel.config.json",
  "quality-panel.json",
];

let worker: Worker | null = null;
let request_id = 0;
const pending_requests = new Map<
  number,
  {
    resolve: (report: QualityReport) => void;
    reject: (error: Error) => void;
  }
>();

function get_worker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./quality-panel.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event) => {
      const { id, report, error } = event.data as {
        id: number;
        report?: QualityReport;
        error?: string;
      };
      const pending = pending_requests.get(id);
      if (!pending) return;
      pending_requests.delete(id);
      if (error) {
        pending.reject(new Error(error));
      } else if (report) {
        pending.resolve(report);
      } else {
        pending.reject(new Error("Worker returned no report."));
      }
    };
  }
  return worker;
}

function analyze_with_worker(input: QualityAnalysisInput): Promise<QualityReport> {
  return new Promise((resolve, reject) => {
    const id = ++request_id;
    pending_requests.set(id, { resolve, reject });
    get_worker().postMessage({ id, input });
  });
}

export class QualityPanel {
  private panel_el: HTMLElement;
  private resize_el: HTMLElement;
  private title_el: HTMLElement;
  private subtitle_el: HTMLElement;
  private status_el: HTMLElement;
  private content_el: HTMLElement;
  private refresh_btn: HTMLButtonElement;
  private copy_btn: HTMLButtonElement;
  private download_btn: HTMLButtonElement;
  private trigger_btn: HTMLButtonElement;
  private close_btn: HTMLButtonElement;
  private on_resize: () => void;
  private get_project_path: () => string;
  private run_id = 0;
  private last_report: QualityReport | null = null;
  private last_project_path = "";

  constructor(on_resize: () => void, get_project_path: () => string) {
    this.on_resize = on_resize;
    this.get_project_path = get_project_path;

    this.panel_el = document.getElementById("quality-panel")!;
    this.resize_el = document.getElementById("quality-resize")!;
    this.title_el = document.getElementById("quality-title")!;
    this.subtitle_el = document.getElementById("quality-subtitle")!;
    this.status_el = document.getElementById("quality-status")!;
    this.content_el = document.getElementById("quality-content")!;
    this.refresh_btn = document.getElementById("btn-quality-refresh") as HTMLButtonElement;
    this.copy_btn = document.getElementById("btn-quality-copy") as HTMLButtonElement;
    this.download_btn = document.getElementById("btn-quality-download") as HTMLButtonElement;
    this.trigger_btn = document.getElementById("btn-quality-panel") as HTMLButtonElement;
    this.close_btn = document.getElementById("btn-close-quality") as HTMLButtonElement;

    this.refresh_btn.addEventListener("click", () => void this.run_analysis());
    this.copy_btn.addEventListener("click", () => void this.copy_report());
    this.download_btn.addEventListener("click", () => this.download_report());
    this.close_btn.addEventListener("click", () => this.close());
    this.content_el.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest("[data-quality-action]") as HTMLElement | null;
      if (!button) return;
      if (button.dataset.qualityAction === "run") {
        void this.run_analysis();
      }
    });

    this.render_idle_state();
  }

  open() {
    if (this.panel_el.classList.contains("hidden")) {
      this.panel_el.classList.remove("hidden");
      this.resize_el.classList.remove("hidden");
      this.trigger_btn.classList.add("active");
      setTimeout(() => this.on_resize(), 0);
    }

    if (this.last_project_path !== this.get_project_path()) {
      this.render_idle_state();
    }
    void this.run_analysis();
  }

  close() {
    this.panel_el.classList.add("hidden");
    this.resize_el.classList.add("hidden");
    this.trigger_btn.classList.remove("active");
    setTimeout(() => this.on_resize(), 0);
  }

  async refresh_if_open() {
    if (this.panel_el.classList.contains("hidden")) return;
    await this.run_analysis();
  }

  private set_busy_state(is_busy: boolean) {
    this.refresh_btn.disabled = is_busy;
    this.copy_btn.disabled = is_busy || !this.last_report;
    this.download_btn.disabled = is_busy || !this.last_report;
    this.panel_el.classList.toggle("quality-panel-loading", is_busy);
  }

  private render_idle_state() {
    this.title_el.textContent = "Quality Panel";
    this.subtitle_el.textContent = "Static analysis for the current workspace";
    this.render_status("idle", "Ready", "Run a static quality scan for the open project.");
    this.content_el.innerHTML = `
      <div class="quality-idle-cta">
        <p class="quality-idle-hint">Analyze the current workspace to generate a structured quality report.</p>
        <button class="quality-run-btn" data-quality-action="run">
          ${this.play_icon()}
          Run Quality Scan
        </button>
      </div>
    `;
    this.last_report = null;
    this.copy_btn.disabled = true;
    this.download_btn.disabled = true;
  }

  private render_status(kind: StatusKind, title: string, text: string) {
    this.status_el.className = `quality-status quality-status-${kind}`;
    this.status_el.innerHTML = `
      <div class="quality-status-icon">${this.status_icon(kind)}</div>
      <div class="quality-status-copy">
        <div class="quality-status-title">${escape_html(title)}</div>
        <div class="quality-status-text">${escape_html(text)}</div>
      </div>
    `;
  }

  private async run_analysis() {
    const project_path = this.get_project_path();
    if (!project_path) {
      this.render_status("warning", "No project", "Open a project before running quality analysis.");
      this.render_idle_state();
      return;
    }

    const run_id = ++this.run_id;
    this.last_project_path = project_path;
    this.set_busy_state(true);
    this.title_el.textContent = "Quality Panel";
    this.subtitle_el.textContent = "Static analysis for the current workspace";
    this.render_status("loading", "Scanning project", "Collecting source files and building the report.");

    try {
      const config = await this.load_config(project_path);
      const input = await this.collect_analysis_input(project_path, config);
      const report = await analyze_with_worker(input);
      if (run_id !== this.run_id) return;

      this.last_report = report;
      this.copy_btn.disabled = false;
      this.download_btn.disabled = false;
      this.render_status(
        report.summary.riskLevel === "high"
          ? "warning"
          : report.summary.totalIssues > 0
            ? "success"
            : "success",
        `Score ${report.summary.score}`,
        `${report.summary.totalIssues} issues across ${report.summary.totalFiles} files.`
      );
      this.render_report(report);
    } catch (error) {
      if (run_id !== this.run_id) return;
      const message = error instanceof Error ? error.message : "Unknown analysis error";
      this.render_status("error", "Scan failed", message);
      this.content_el.innerHTML = `
        <div class="quality-empty-state">
          <p>${escape_html(message)}</p>
          <button class="quality-run-btn" data-quality-action="run">
            ${this.play_icon()}
            Retry Quality Scan
          </button>
        </div>
      `;
    } finally {
      if (run_id === this.run_id) {
        this.set_busy_state(false);
      }
    }
  }

  private async load_config(project_path: string): Promise<QualityPanelConfig | undefined> {
    for (const candidate of CONFIG_CANDIDATES) {
      try {
        const raw = await invoke<string>("read_file", {
          path: `${project_path}/${candidate}`,
        });
        return JSON.parse(raw) as QualityPanelConfig;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async collect_analysis_input(
    project_path: string,
    config: QualityPanelConfig | undefined
  ): Promise<QualityAnalysisInput> {
    const resolved_config = merge_quality_config(config);
    const files: QualitySourceFile[] = [];
    const package_manifests: QualityPackageManifest[] = [];
    await this.scan_directory(project_path, project_path, resolved_config.ignorePaths, files, package_manifests);
    return {
      rootPath: project_path,
      config: resolved_config,
      files,
      packageManifests: package_manifests,
    };
  }

  private async scan_directory(
    root_path: string,
    directory_path: string,
    ignore_paths: string[],
    files: QualitySourceFile[],
    package_manifests: QualityPackageManifest[]
  ) {
    const entries = await invoke<FileEntry[]>("read_dir", { path: directory_path });
    const relative_directory = relative_path(root_path, directory_path);
    const file_reads: Promise<void>[] = [];
    const directory_reads: Promise<void>[] = [];

    entries.forEach((entry) => {
      const relative_entry = relative_path(root_path, entry.path);
      if (entry.is_dir) {
        if (should_skip_directory(entry.name, relative_entry, ignore_paths)) return;
        directory_reads.push(
          this.scan_directory(root_path, entry.path, ignore_paths, files, package_manifests)
        );
        return;
      }

      if (entry.name === "package.json") {
        file_reads.push(
          invoke<string>("read_file", { path: entry.path })
            .then((content) => {
              package_manifests.push({
                path: entry.path,
                relativePath: relative_entry || "package.json",
                content,
              });
            })
            .catch(() => {})
        );
        return;
      }

      if (!should_include_quality_file(relative_entry, ignore_paths)) return;
      file_reads.push(
        invoke<string>("read_file", { path: entry.path })
          .then((content) => {
            files.push({
              path: entry.path,
              relativePath: relative_entry,
              content,
            });
          })
          .catch(() => {})
      );
    });

    await Promise.all(file_reads);
    await Promise.all(directory_reads);

    if (!relative_directory) {
      files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      package_manifests.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    }
  }

  private render_report(report: QualityReport) {
    this.content_el.innerHTML = `
      <div class="quality-summary-card">
        <div class="quality-summary-main">
          <div class="quality-score quality-score-${report.summary.riskLevel}">
            <span class="quality-score-value">${report.summary.score}</span>
            <span class="quality-score-label">Score</span>
          </div>
          <div class="quality-summary-copy">
            <div class="quality-summary-title">Risk: ${escape_html(report.summary.riskLevel)}</div>
            <p class="quality-summary-text">Static analysis found ${report.summary.totalIssues} issues across ${report.summary.totalFiles} scanned files.</p>
            <div class="quality-summary-meta">
              <span>Naming: ${report.config.namingConvention}</span>
              <span>Complexity threshold: ${report.config.complexityThreshold}</span>
              <span>Max function length: ${report.config.maxFunctionLength}</span>
            </div>
          </div>
        </div>
      </div>

      <section class="quality-section-block">
        <div class="quality-block-header">
          <h3>Insights</h3>
          <span>${report.insights.length}</span>
        </div>
        <div class="quality-insights-list">
          ${report.insights.map((insight) => `<div class="quality-insight-item">${escape_html(insight)}</div>`).join("")}
        </div>
      </section>

      <section class="quality-section-block">
        <div class="quality-block-header">
          <h3>Sections</h3>
          <span>8 modules</span>
        </div>
        <div class="quality-section-grid">
          ${this.render_section_cards(report)}
        </div>
      </section>

      <section class="quality-section-block">
        <div class="quality-block-header">
          <h3>Top Violations</h3>
          <span>${report.violations.length}</span>
        </div>
        <div class="quality-violations-list">
          ${this.render_violations(report.violations.slice(0, 24))}
        </div>
      </section>
    `;
  }

  private render_section_cards(report: QualityReport): string {
    const section_cards = [
      this.render_section_card("Naming", report.sections.naming.score, [
        `${report.sections.naming.issueCount} issues`,
        `Dominant: ${report.sections.naming.dominantConvention || report.config.namingConvention}`,
        `Files off-pattern: ${report.sections.naming.violations.filter((item) => item.message.includes("File name")).length}`,
      ]),
      this.render_section_card("Imports", report.sections.imports.score, [
        `Unused imports: ${report.sections.imports.unusedImports}`,
        `Unused exports: ${report.sections.imports.unusedExports}`,
        `Cycles: ${report.sections.imports.circularDependencies.length}`,
      ]),
      this.render_section_card("Complexity", report.sections.complexity.score, [
        `Avg complexity: ${report.sections.complexity.averageCyclomaticComplexity}`,
        `High-complexity funcs: ${report.sections.complexity.highComplexityFunctions}`,
        `Large files: ${report.sections.complexity.largeFiles}`,
      ]),
      this.render_section_card("Quality", report.sections.quality.score, [
        `Duplicate blocks: ${report.sections.quality.duplicateCodeBlocks}`,
        `TODO/FIXME: ${report.sections.quality.todoCount}`,
        `Unhandled promises: ${report.sections.quality.unhandledPromises}`,
      ]),
      this.render_section_card("Types", report.sections.types.score, [
        report.sections.types.applicable
          ? `Type coverage: ${report.sections.types.typeCoverage}%`
          : "No TS files detected",
        `any usage: ${report.sections.types.anyUsageCount}`,
        `Unsafe casts: ${report.sections.types.unsafeCasts}`,
      ]),
      this.render_section_card("Architecture", report.sections.architecture.score, [
        `Layer violations: ${report.sections.architecture.layerViolations}`,
        `Boundary leaks: ${report.sections.architecture.moduleBoundaryViolations}`,
        `Hotspots: ${report.sections.architecture.tightCouplingHotspots.length}`,
      ]),
      this.render_section_card("Dependencies", report.sections.dependencies.score, [
        `Declared deps: ${report.sections.dependencies.totalDependencies}`,
        `Unused deps: ${report.sections.dependencies.unusedDependencies.length}`,
        `Version drifts: ${report.sections.dependencies.versionInconsistencies.length}`,
      ]),
      this.render_section_card("Security", report.sections.security.score, [
        `Secrets: ${report.sections.security.hardcodedSecrets}`,
        `Unsafe patterns: ${report.sections.security.unsafePatterns}`,
        `Validation gaps: ${report.sections.security.missingInputValidation}`,
      ]),
    ];

    return section_cards.join("");
  }

  private render_section_card(title: string, score: number, metrics: string[]): string {
    return `
      <article class="quality-section-card">
        <div class="quality-section-card-head">
          <h4>${escape_html(title)}</h4>
          <span class="quality-pill quality-pill-${score >= 85 ? "good" : score >= 65 ? "warn" : "risk"}">${score}</span>
        </div>
        <div class="quality-section-card-body">
          ${metrics.map((metric) => `<div class="quality-section-metric">${escape_html(metric)}</div>`).join("")}
        </div>
      </article>
    `;
  }

  private render_violations(violations: QualityViolation[]): string {
    if (violations.length === 0) {
      return `<div class="quality-empty-state">No violations were recorded for this scan.</div>`;
    }

    return violations
      .map(
        (violation) => `
          <article class="quality-violation-card">
            <div class="quality-violation-head">
              <span class="quality-pill quality-pill-${violation.severity === "high" ? "risk" : violation.severity === "medium" ? "warn" : "good"}">${escape_html(violation.severity)}</span>
              <span class="quality-violation-type">${escape_html(violation.type)}</span>
            </div>
            <div class="quality-violation-message">${escape_html(violation.message)}</div>
            <div class="quality-violation-meta">
              <span>${escape_html(violation.file)}</span>
              ${typeof violation.line === "number" ? `<span>Line ${violation.line}</span>` : ""}
            </div>
          </article>
        `
      )
      .join("");
  }

  private async copy_report() {
    if (!this.last_report) return;
    const json = JSON.stringify(this.last_report, null, 2);
    await navigator.clipboard.writeText(json);
    this.render_status("success", "Copied", "Quality report JSON copied to the clipboard.");
  }

  private download_report() {
    if (!this.last_report) return;
    const json = JSON.stringify(this.last_report, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "quality-report.json";
    link.click();
    URL.revokeObjectURL(url);
    this.render_status("success", "Downloaded", "Quality report JSON download started.");
  }

  private status_icon(kind: StatusKind): string {
    if (kind === "loading") return `<span class="quality-spinner"></span>`;
    if (kind === "success") return "✓";
    if (kind === "warning") return "!";
    if (kind === "error") return "×";
    return "·";
  }

  private play_icon(): string {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a.5.5 0 0 1 .812-.39l8 5.5a.5.5 0 0 1 0 .78l-8 5.5A.5.5 0 0 1 4 13V2z"/></svg>`;
  }
}

function should_skip_directory(
  name: string,
  relative_path_value: string,
  ignore_paths: string[]
): boolean {
  if (name.startsWith(".")) return true;
  if (["node_modules", "dist", "dist-cli", "build", "coverage", "target", "__pycache__"].includes(name)) {
    return true;
  }
  return ignore_paths.some((value) => {
    const normalized = normalize_path(value).replace(/^\/+/, "");
    return relative_path_value === normalized || relative_path_value.startsWith(`${normalized}/`);
  });
}

function relative_path(root_path: string, target_path: string): string {
  const root = normalize_path(root_path).replace(/\/+$/, "");
  const target = normalize_path(target_path);
  if (target === root) return "";
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

function normalize_path(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function escape_html(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
