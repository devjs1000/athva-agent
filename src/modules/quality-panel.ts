import { invoke } from "@tauri-apps/api/core";
import {
  merge_quality_config,
  should_include_quality_file,
  type QualityAnalysisInput,
  type QualityPackageManifest,
  type QualityPanelConfig,
  type QualityReport,
  type QualitySections,
  type QualitySourceFile,
  type QualityViolation,
} from "./quality-core";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

type StatusKind = "idle" | "loading" | "success" | "warning" | "error";
type QualityViewMode = "report" | "config";

interface LoadedQualityConfig {
  config: QualityPanelConfig;
  path: string;
}

interface QualityPreset {
  key: "strict" | "balanced" | "legacy";
  label: string;
  description: string;
  config: QualityPanelConfig;
}

type QualitySectionKey = keyof QualitySections;

const CONFIG_CANDIDATES = [
  ".athva/quality-panel.json",
  "quality-panel.config.json",
  "quality-panel.json",
];
const PRIMARY_CONFIG_PATH = ".athva/quality-panel.json";
const NAMING_OPTIONS = ["camelCase", "snake_case", "PascalCase", "kebab-case", "UPPER_CASE"] as const;
const SECTION_LABELS: Record<QualitySectionKey, string> = {
  naming: "Naming",
  imports: "Imports",
  complexity: "Complexity",
  quality: "Quality",
  types: "Types",
  architecture: "Architecture",
  dependencies: "Dependencies",
  security: "Security",
};

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
  private config_btn: HTMLButtonElement;
  private trigger_btn: HTMLButtonElement;
  private close_btn: HTMLButtonElement;
  private on_resize: () => void;
  private get_project_path: () => string;
  private run_id = 0;
  private last_report: QualityReport | null = null;
  private last_project_path = "";
  private current_config: Required<QualityPanelConfig> = merge_quality_config(undefined);
  private current_config_path = PRIMARY_CONFIG_PATH;
  private view_mode: QualityViewMode = "report";
  private save_in_flight = false;

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
    this.config_btn = document.getElementById("btn-quality-config") as HTMLButtonElement;
    this.trigger_btn = document.getElementById("btn-quality-panel") as HTMLButtonElement;
    this.close_btn = document.getElementById("btn-close-quality") as HTMLButtonElement;

    this.refresh_btn.addEventListener("click", () => void this.run_analysis());
    this.copy_btn.addEventListener("click", () => void this.copy_report());
    this.download_btn.addEventListener("click", () => this.download_report());
    this.config_btn.addEventListener("click", () => void this.open_config_view());
    this.close_btn.addEventListener("click", () => this.close());
    this.content_el.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest("[data-quality-action]") as HTMLElement | null;
      if (!button) return;
      const action = button.dataset.qualityAction;
      if (action === "run") {
        void this.run_analysis();
      } else if (action === "open-config") {
        void this.open_config_view();
      } else if (action === "cancel-config") {
        this.view_mode = "report";
        this.render_last_view();
      } else if (action === "use-preset") {
        this.apply_preset(button.dataset.preset as QualityPreset["key"] | undefined);
      } else if (action === "recommended-preset") {
        this.apply_recommended_preset();
      } else if (action === "jump-section") {
        this.scroll_to_target(button.dataset.qualityTarget);
      } else if (action === "jump-violation") {
        this.scroll_to_target(button.dataset.qualityTarget);
      }
    });
    this.content_el.addEventListener("submit", (event) => {
      const form = event.target as HTMLFormElement;
      if (!form.matches("[data-quality-form='config']")) return;
      event.preventDefault();
      void this.save_guided_config(form);
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
    this.config_btn.disabled = is_busy || this.save_in_flight;
    this.panel_el.classList.toggle("quality-panel-loading", is_busy);
  }

  private render_idle_state() {
    this.view_mode = "report";
    this.title_el.textContent = "Quality Panel";
    this.subtitle_el.textContent = "Static analysis for the current workspace";
    this.render_status("idle", "Ready", "Run a static quality scan for the open project.");
    this.content_el.innerHTML = `
      <div class="quality-idle-cta">
        <p class="quality-idle-hint">Analyze the current workspace to generate a structured quality report.</p>
        <div class="quality-cta-actions">
          <button class="quality-run-btn" data-quality-action="run">
            ${this.play_icon()}
            Run Quality Scan
          </button>
          <button class="quality-secondary-btn" data-quality-action="open-config">
            Set Ideal Config
          </button>
        </div>
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
    this.view_mode = "report";
    this.set_busy_state(true);
    this.title_el.textContent = "Quality Panel";
    this.subtitle_el.textContent = "Static analysis for the current workspace";
    this.render_status("loading", "Scanning project", "Collecting source files and building the report.");

    try {
      const loaded_config = await this.load_config(project_path);
      this.current_config = merge_quality_config(loaded_config?.config);
      this.current_config_path = loaded_config?.path ?? PRIMARY_CONFIG_PATH;
      const input = await this.collect_analysis_input(project_path, this.current_config);
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

  private async open_config_view() {
    const project_path = this.get_project_path();
    if (!project_path) {
      this.render_status("warning", "No project", "Open a project before configuring quality standards.");
      return;
    }

    const loaded_config = await this.load_config(project_path);
    this.current_config = merge_quality_config(loaded_config?.config);
    this.current_config_path = loaded_config?.path ?? PRIMARY_CONFIG_PATH;
    this.view_mode = "config";
    this.render_status(
      "idle",
      "Guided config",
      "Set the ideal quality rules for this project and save them as a project-level config."
    );
    this.render_config_form();
  }

  private async load_config(project_path: string): Promise<LoadedQualityConfig | undefined> {
    for (const candidate of CONFIG_CANDIDATES) {
      try {
        const raw = await invoke<string>("read_file", {
          path: `${project_path}/${candidate}`,
        });
        return {
          config: JSON.parse(raw) as QualityPanelConfig,
          path: candidate,
        };
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

  private render_config_form() {
    const presets = this.get_presets();
    const recommended_preset = this.get_recommended_preset();
    const ignore_paths = this.current_config.ignorePaths.join(", ");
    this.title_el.textContent = "Ideal Quality Config";
    this.subtitle_el.textContent = this.current_config_path;
    this.content_el.innerHTML = `
      <section class="quality-section-block quality-config-block">
        <div class="quality-block-header">
          <h3>Guided Setup</h3>
          <span>Saved in ${escape_html(this.current_config_path)}</span>
        </div>
        <p class="quality-config-intro">Use a preset to start fast, then tune the rules for this project. The saved config becomes the baseline for future scans.</p>

        <div class="quality-preset-grid">
          ${presets.map((preset) => `
            <button
              class="quality-preset-card${this.matches_preset(preset) ? " active" : ""}${recommended_preset.key === preset.key ? " recommended" : ""}"
              type="button"
              data-quality-action="use-preset"
              data-preset="${preset.key}"
            >
              <div class="quality-preset-head">
                <span class="quality-preset-title">${escape_html(preset.label)}</span>
                ${recommended_preset.key === preset.key ? `<span class="quality-pill quality-pill-good">Recommended</span>` : ""}
              </div>
              <div class="quality-preset-copy">${escape_html(preset.description)}</div>
              <div class="quality-preset-meta">
                <span>Files: ${preset.config.fileNamingConvention}</span>
                <span>Functions: ${preset.config.functionNamingConvention}</span>
                <span>Complexity: ${preset.config.complexityThreshold}</span>
                <span>Function length: ${preset.config.maxFunctionLength}</span>
              </div>
            </button>
          `).join("")}
        </div>

        <button class="quality-secondary-btn quality-recommended-btn" type="button" data-quality-action="recommended-preset">
          Use Recommended Preset
        </button>
      </section>

      <form class="quality-config-form" data-quality-form="config">
        <section class="quality-section-block quality-config-block">
          <div class="quality-block-header">
            <h3>Core Rules</h3>
            <span>Plain-language controls</span>
          </div>

          <label class="quality-field">
            <span class="quality-field-label">File naming style</span>
            <span class="quality-field-help">Set the ideal file casing for modules in this project.</span>
            <select name="fileNamingConvention" class="quality-field-input">
              ${NAMING_OPTIONS.filter((value) => value !== "UPPER_CASE").map((value) => `
                <option value="${value}"${this.current_config.fileNamingConvention === value ? " selected" : ""}>${value}</option>
              `).join("")}
            </select>
          </label>

          <div class="quality-field-grid">
            <label class="quality-field">
              <span class="quality-field-label">Function naming</span>
              <span class="quality-field-help">How functions should be named.</span>
              <select name="functionNamingConvention" class="quality-field-input">
                ${NAMING_OPTIONS.filter((value) => value !== "UPPER_CASE").map((value) => `
                  <option value="${value}"${this.current_config.functionNamingConvention === value ? " selected" : ""}>${value}</option>
                `).join("")}
              </select>
            </label>

            <label class="quality-field">
              <span class="quality-field-label">Variable naming</span>
              <span class="quality-field-help">How local variables and fields should read.</span>
              <select name="variableNamingConvention" class="quality-field-input">
                ${NAMING_OPTIONS.filter((value) => value !== "UPPER_CASE").map((value) => `
                  <option value="${value}"${this.current_config.variableNamingConvention === value ? " selected" : ""}>${value}</option>
                `).join("")}
              </select>
            </label>
          </div>

          <div class="quality-field-grid">
            <label class="quality-field">
              <span class="quality-field-label">Class naming</span>
              <span class="quality-field-help">The expected style for classes and components.</span>
              <select name="classNamingConvention" class="quality-field-input">
                ${NAMING_OPTIONS.filter((value) => value !== "UPPER_CASE").map((value) => `
                  <option value="${value}"${this.current_config.classNamingConvention === value ? " selected" : ""}>${value}</option>
                `).join("")}
              </select>
            </label>

            <label class="quality-field">
              <span class="quality-field-label">Constant naming</span>
              <span class="quality-field-help">The expected style for stable constants and flags.</span>
              <select name="constantNamingConvention" class="quality-field-input">
                ${NAMING_OPTIONS.map((value) => `
                  <option value="${value}"${this.current_config.constantNamingConvention === value ? " selected" : ""}>${value}</option>
                `).join("")}
              </select>
            </label>
          </div>

          <label class="quality-field">
            <span class="quality-field-label">Team default naming</span>
            <span class="quality-field-help">Used as the general project default and for compatibility with older configs.</span>
            <select name="namingConvention" class="quality-field-input">
              ${NAMING_OPTIONS.filter((value) => value !== "UPPER_CASE").map((value) => `
                <option value="${value}"${this.current_config.namingConvention === value ? " selected" : ""}>${value}</option>
              `).join("")}
            </select>
          </label>

          <label class="quality-field">
            <span class="quality-field-label">Complexity threshold</span>
            <span class="quality-field-help">Functions above this cyclomatic complexity are flagged as high risk.</span>
            <div class="quality-range-row">
              <input
                type="range"
                min="4"
                max="20"
                step="1"
                name="complexityThreshold"
                value="${this.current_config.complexityThreshold}"
                class="quality-range-input"
                oninput="this.nextElementSibling.value=this.value"
              />
              <output class="quality-range-value">${this.current_config.complexityThreshold}</output>
            </div>
          </label>

          <label class="quality-field">
            <span class="quality-field-label">Max function length</span>
            <span class="quality-field-help">Longer functions are harder to review and maintain. Pick a soft limit that suits the codebase.</span>
            <input
              type="number"
              min="20"
              max="200"
              step="5"
              name="maxFunctionLength"
              value="${this.current_config.maxFunctionLength}"
              class="quality-field-input"
            />
          </label>

          <label class="quality-field">
            <span class="quality-field-label">Ignored paths</span>
            <span class="quality-field-help">Comma-separated folders to skip during scans.</span>
            <textarea
              name="ignorePaths"
              rows="3"
              class="quality-field-input quality-field-textarea"
              placeholder="node_modules, dist, coverage"
            >${escape_html(ignore_paths)}</textarea>
          </label>
        </section>

        <section class="quality-section-block quality-config-block">
          <div class="quality-block-header">
            <h3>What This Means</h3>
            <span>Guided summary</span>
          </div>
          <div class="quality-guidance-list">
            <div class="quality-guidance-item"><strong>Strict:</strong> lower complexity and shorter functions. Good for greenfield or disciplined TS codebases.</div>
            <div class="quality-guidance-item"><strong>Balanced:</strong> practical defaults for most active projects.</div>
            <div class="quality-guidance-item"><strong>Legacy-friendly:</strong> looser limits while you improve an existing codebase gradually.</div>
          </div>
        </section>

        <div class="quality-config-actions">
          <button type="button" class="quality-secondary-btn" data-quality-action="cancel-config">Back To Report</button>
          <button type="submit" class="quality-run-btn"${this.save_in_flight ? " disabled" : ""}>Save Ideal Config</button>
        </div>
      </form>
    `;
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
              <span>Files: ${report.config.fileNamingConvention}</span>
              <span>Functions: ${report.config.functionNamingConvention}</span>
              <span>Complexity threshold: ${report.config.complexityThreshold}</span>
              <span>Max function length: ${report.config.maxFunctionLength}</span>
            </div>
            <div class="quality-cta-actions">
              <button class="quality-secondary-btn" data-quality-action="open-config">
                Tune Ideal Config
              </button>
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
          <h3>Scoreboard</h3>
          <span>Visual overview</span>
        </div>
        <div class="quality-chart-grid">
          ${this.render_score_chart(report)}
          ${this.render_severity_chart(report)}
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

      <section class="quality-section-block" id="quality-issues-root">
        <div class="quality-block-header">
          <h3>Issue Sections</h3>
          <span>Jump targets</span>
        </div>
        <div class="quality-detailed-sections">
          ${this.render_issue_sections(report)}
        </div>
      </section>
    `;
  }

  private render_section_cards(report: QualityReport): string {
    const section_cards = [
      this.render_section_card("naming", report.sections.naming.score, [
        `${report.sections.naming.issueCount} issues`,
        `Dominant: ${report.sections.naming.dominantConvention || report.config.namingConvention}`,
        `Files off-pattern: ${report.sections.naming.violations.filter((item) => item.message.includes("File name")).length}`,
      ]),
      this.render_section_card("imports", report.sections.imports.score, [
        `Unused imports: ${report.sections.imports.unusedImports}`,
        `Unused exports: ${report.sections.imports.unusedExports}`,
        `Cycles: ${report.sections.imports.circularDependencies.length}`,
      ]),
      this.render_section_card("complexity", report.sections.complexity.score, [
        `Avg complexity: ${report.sections.complexity.averageCyclomaticComplexity}`,
        `High-complexity funcs: ${report.sections.complexity.highComplexityFunctions}`,
        `Large files: ${report.sections.complexity.largeFiles}`,
      ]),
      this.render_section_card("quality", report.sections.quality.score, [
        `Duplicate blocks: ${report.sections.quality.duplicateCodeBlocks}`,
        `TODO/FIXME: ${report.sections.quality.todoCount}`,
        `Unhandled promises: ${report.sections.quality.unhandledPromises}`,
      ]),
      this.render_section_card("types", report.sections.types.score, [
        report.sections.types.applicable
          ? `Type coverage: ${report.sections.types.typeCoverage}%`
          : "No TS files detected",
        `any usage: ${report.sections.types.anyUsageCount}`,
        `Unsafe casts: ${report.sections.types.unsafeCasts}`,
      ]),
      this.render_section_card("architecture", report.sections.architecture.score, [
        `Layer violations: ${report.sections.architecture.layerViolations}`,
        `Boundary leaks: ${report.sections.architecture.moduleBoundaryViolations}`,
        `Hotspots: ${report.sections.architecture.tightCouplingHotspots.length}`,
      ]),
      this.render_section_card("dependencies", report.sections.dependencies.score, [
        `Declared deps: ${report.sections.dependencies.totalDependencies}`,
        `Unused deps: ${report.sections.dependencies.unusedDependencies.length}`,
        `Version drifts: ${report.sections.dependencies.versionInconsistencies.length}`,
      ]),
      this.render_section_card("security", report.sections.security.score, [
        `Secrets: ${report.sections.security.hardcodedSecrets}`,
        `Unsafe patterns: ${report.sections.security.unsafePatterns}`,
        `Validation gaps: ${report.sections.security.missingInputValidation}`,
      ]),
    ];

    return section_cards.join("");
  }

  private render_section_card(section: QualitySectionKey, score: number, metrics: string[]): string {
    return `
      <button
        class="quality-section-card"
        type="button"
        data-quality-action="jump-section"
        data-quality-target="quality-issues-${section}"
      >
        <div class="quality-section-card-head">
          <h4>${escape_html(SECTION_LABELS[section])}</h4>
          <span class="quality-pill quality-pill-${score >= 85 ? "good" : score >= 65 ? "warn" : "risk"}">${score}</span>
        </div>
        <div class="quality-section-card-body">
          ${metrics.map((metric) => `<div class="quality-section-metric">${escape_html(metric)}</div>`).join("")}
        </div>
      </button>
    `;
  }

  private render_violations(violations: QualityViolation[]): string {
    if (violations.length === 0) {
      return `<div class="quality-empty-state">No violations were recorded for this scan.</div>`;
    }

    return violations
      .map(
        (violation) => `
          <button
            class="quality-violation-card quality-violation-card-button"
            type="button"
            data-quality-action="jump-violation"
            data-quality-target="quality-issues-${violation.type}"
          >
            <div class="quality-violation-head">
              <span class="quality-pill quality-pill-${violation.severity === "high" ? "risk" : violation.severity === "medium" ? "warn" : "good"}">${escape_html(violation.severity)}</span>
              <span class="quality-violation-type">${escape_html(violation.type)}</span>
            </div>
            <div class="quality-violation-message">${escape_html(violation.message)}</div>
            <div class="quality-violation-meta">
              <span>${escape_html(violation.file)}</span>
              ${typeof violation.line === "number" ? `<span>Line ${violation.line}</span>` : ""}
            </div>
          </button>
        `
      )
      .join("");
  }

  private render_score_chart(report: QualityReport): string {
    const items: Array<{ key: QualitySectionKey; score: number }> = [
      { key: "naming", score: report.sections.naming.score },
      { key: "imports", score: report.sections.imports.score },
      { key: "complexity", score: report.sections.complexity.score },
      { key: "quality", score: report.sections.quality.score },
      { key: "types", score: report.sections.types.score },
      { key: "architecture", score: report.sections.architecture.score },
      { key: "dependencies", score: report.sections.dependencies.score },
      { key: "security", score: report.sections.security.score },
    ];

    return `
      <div class="quality-chart-card">
        <div class="quality-chart-title">Section Scores</div>
        <div class="quality-bar-chart">
          ${items.map((item) => `
            <button
              type="button"
              class="quality-bar-row"
              data-quality-action="jump-section"
              data-quality-target="quality-issues-${item.key}"
            >
              <span class="quality-bar-label">${escape_html(SECTION_LABELS[item.key])}</span>
              <span class="quality-bar-track">
                <span class="quality-bar-fill quality-bar-fill-${this.score_tone(item.score)}" style="width: ${item.score}%"></span>
              </span>
              <span class="quality-bar-value">${item.score}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  private render_severity_chart(report: QualityReport): string {
    const severity_counts = {
      high: report.violations.filter((violation) => violation.severity === "high").length,
      medium: report.violations.filter((violation) => violation.severity === "medium").length,
      low: report.violations.filter((violation) => violation.severity === "low").length,
    };
    const total = Math.max(report.violations.length, 1);
    return `
      <div class="quality-chart-card">
        <div class="quality-chart-title">Issue Severity</div>
        <div class="quality-severity-chart">
          ${(["high", "medium", "low"] as const).map((severity) => `
            <div class="quality-severity-item">
              <div class="quality-severity-head">
                <span class="quality-pill quality-pill-${severity === "high" ? "risk" : severity === "medium" ? "warn" : "good"}">${severity}</span>
                <span class="quality-severity-count">${severity_counts[severity]}</span>
              </div>
              <div class="quality-bar-track">
                <span class="quality-bar-fill quality-bar-fill-${severity === "high" ? "risk" : severity === "medium" ? "warn" : "good"}" style="width: ${Math.max(4, (severity_counts[severity] / total) * 100)}%"></span>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  private render_issue_sections(report: QualityReport): string {
    const orderedSections: QualitySectionKey[] = [
      "naming",
      "imports",
      "complexity",
      "quality",
      "types",
      "architecture",
      "dependencies",
      "security",
    ];

    return orderedSections.map((section) => {
      const sectionData = report.sections[section];
      return `
        <section class="quality-issue-section" id="quality-issues-${section}">
          <div class="quality-issue-section-head">
            <div>
              <h4>${escape_html(SECTION_LABELS[section])}</h4>
              <div class="quality-issue-section-meta">${sectionData.issueCount} issues</div>
            </div>
            <span class="quality-pill quality-pill-${this.score_tone(sectionData.score)}">${sectionData.score}</span>
          </div>
          <div class="quality-violations-list">
            ${sectionData.violations.length > 0
              ? this.render_section_violations(sectionData.violations.slice(0, 18))
              : `<div class="quality-empty-state">No issues in this section for the current config.</div>`}
          </div>
        </section>
      `;
    }).join("");
  }

  private render_section_violations(violations: QualityViolation[]): string {
    return violations.map((violation) => `
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
    `).join("");
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

  private get_presets(): QualityPreset[] {
    return [
      {
        key: "strict",
        label: "Strict",
        description: "Best for greenfield or disciplined TypeScript projects that want tighter maintainability checks.",
        config: {
          namingConvention: "camelCase",
          fileNamingConvention: "kebab-case",
          functionNamingConvention: "camelCase",
          variableNamingConvention: "camelCase",
          classNamingConvention: "PascalCase",
          constantNamingConvention: "UPPER_CASE",
          complexityThreshold: 8,
          maxFunctionLength: 40,
          ignorePaths: ["node_modules", "dist", "dist-cli", "build", "coverage", "target", ".next", "out"],
        },
      },
      {
        key: "balanced",
        label: "Balanced",
        description: "Recommended for most active repos. Keeps the signal high without creating too much noise.",
        config: {
          namingConvention: "camelCase",
          fileNamingConvention: "kebab-case",
          functionNamingConvention: "camelCase",
          variableNamingConvention: "camelCase",
          classNamingConvention: "PascalCase",
          constantNamingConvention: "UPPER_CASE",
          complexityThreshold: 10,
          maxFunctionLength: 50,
          ignorePaths: ["node_modules", "dist", "dist-cli", "build", "coverage", "target", ".next", "out"],
        },
      },
      {
        key: "legacy",
        label: "Legacy-Friendly",
        description: "Good for mature codebases that need gradual improvement without overwhelming the team.",
        config: {
          namingConvention: "camelCase",
          fileNamingConvention: "kebab-case",
          functionNamingConvention: "camelCase",
          variableNamingConvention: "camelCase",
          classNamingConvention: "PascalCase",
          constantNamingConvention: "UPPER_CASE",
          complexityThreshold: 14,
          maxFunctionLength: 75,
          ignorePaths: ["node_modules", "dist", "dist-cli", "build", "coverage", "target", ".next", "out"],
        },
      },
    ];
  }

  private get_recommended_preset(): QualityPreset {
    if (this.last_report && this.last_report.summary.totalIssues > 250) {
      return this.get_presets().find((preset) => preset.key === "legacy")!;
    }
    return this.get_presets().find((preset) => preset.key === "balanced")!;
  }

  private matches_preset(preset: QualityPreset): boolean {
    const left = merge_quality_config(preset.config);
    const right = merge_quality_config(this.current_config);
    return (
      left.namingConvention === right.namingConvention &&
      left.fileNamingConvention === right.fileNamingConvention &&
      left.functionNamingConvention === right.functionNamingConvention &&
      left.variableNamingConvention === right.variableNamingConvention &&
      left.classNamingConvention === right.classNamingConvention &&
      left.constantNamingConvention === right.constantNamingConvention &&
      left.complexityThreshold === right.complexityThreshold &&
      left.maxFunctionLength === right.maxFunctionLength &&
      left.ignorePaths.join("|") === right.ignorePaths.join("|")
    );
  }

  private apply_preset(preset_key: QualityPreset["key"] | undefined) {
    if (!preset_key) return;
    const preset = this.get_presets().find((item) => item.key === preset_key);
    if (!preset) return;
    this.current_config = merge_quality_config(preset.config);
    this.render_config_form();
  }

  private apply_recommended_preset() {
    this.current_config = merge_quality_config(this.get_recommended_preset().config);
    this.render_config_form();
  }

  private async save_guided_config(form: HTMLFormElement) {
    const project_path = this.get_project_path();
    if (!project_path || this.save_in_flight) return;

    const form_data = new FormData(form);
    const next_config: QualityPanelConfig = {
      namingConvention: String(form_data.get("namingConvention") || "camelCase") as QualityPanelConfig["namingConvention"],
      fileNamingConvention: String(form_data.get("fileNamingConvention") || "kebab-case") as QualityPanelConfig["fileNamingConvention"],
      functionNamingConvention: String(form_data.get("functionNamingConvention") || "camelCase") as QualityPanelConfig["functionNamingConvention"],
      variableNamingConvention: String(form_data.get("variableNamingConvention") || "camelCase") as QualityPanelConfig["variableNamingConvention"],
      classNamingConvention: String(form_data.get("classNamingConvention") || "PascalCase") as QualityPanelConfig["classNamingConvention"],
      constantNamingConvention: String(form_data.get("constantNamingConvention") || "UPPER_CASE") as QualityPanelConfig["constantNamingConvention"],
      complexityThreshold: Number(form_data.get("complexityThreshold") || 10),
      maxFunctionLength: Number(form_data.get("maxFunctionLength") || 50),
      ignorePaths: String(form_data.get("ignorePaths") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };

    this.save_in_flight = true;
    this.set_busy_state(true);
    try {
      await invoke("create_dir", { path: `${project_path}/.athva` }).catch(() => {});
      await invoke("write_file", {
        path: `${project_path}/${PRIMARY_CONFIG_PATH}`,
        content: JSON.stringify(next_config, null, 2),
      });
      this.current_config = merge_quality_config(next_config);
      this.current_config_path = PRIMARY_CONFIG_PATH;
      this.view_mode = "report";
      this.render_status("success", "Config saved", "Ideal quality settings were saved for this project. Refreshing the report.");
      await this.run_analysis();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save the quality config.";
      this.render_status("error", "Save failed", message);
      this.render_config_form();
    } finally {
      this.save_in_flight = false;
      this.set_busy_state(false);
    }
  }

  private render_last_view() {
    if (this.view_mode === "config") {
      this.render_status(
        "idle",
        "Guided config",
        "Set the ideal quality rules for this project and save them as a project-level config."
      );
      this.render_config_form();
      return;
    }
    if (this.last_report) {
      this.render_status(
        this.last_report.summary.riskLevel === "high" ? "warning" : "success",
        `Score ${this.last_report.summary.score}`,
        `${this.last_report.summary.totalIssues} issues across ${this.last_report.summary.totalFiles} files.`
      );
      this.render_report(this.last_report);
      return;
    }
    this.render_idle_state();
  }

  private scroll_to_target(target_id: string | undefined) {
    if (!target_id) return;
    const target = this.content_el.querySelector(`#${CSS.escape(target_id)}`) as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("quality-jump-highlight");
    window.setTimeout(() => target.classList.remove("quality-jump-highlight"), 1400);
  }

  private score_tone(score: number): "good" | "warn" | "risk" {
    if (score >= 85) return "good";
    if (score >= 65) return "warn";
    return "risk";
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
