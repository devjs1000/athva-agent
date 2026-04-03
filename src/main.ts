import { open } from "@tauri-apps/plugin-dialog";
import { getProjects, addProject, removeProject, type Project } from "./store/projects";

// DOM references
let welcomePage: HTMLElement;
let workspacePage: HTMLElement;
let createDialog: HTMLElement;
let recentProjectsList: HTMLElement;
let projectPathInput: HTMLInputElement;
let workspaceProjectName: HTMLElement;
let workspaceProjectPath: HTMLElement;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

// Render recent projects list
async function renderRecentProjects() {
  const store = await getProjects();
  const projects = store.projects;

  if (projects.length === 0) {
    recentProjectsList.innerHTML = `<p class="empty-state">No recent projects</p>`;
    return;
  }

  recentProjectsList.innerHTML = projects
    .map(
      (p) => `
    <div class="recent-item" data-path="${escapeHtml(p.path)}">
      <div class="recent-item-info">
        <span class="recent-item-name">${escapeHtml(p.name)}</span>
        <span class="recent-item-path">${escapeHtml(p.path)}</span>
      </div>
      <button class="recent-item-remove" data-remove="${escapeHtml(p.path)}" title="Remove from recent">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
        </svg>
      </button>
    </div>
  `
    )
    .join("");

  // Bind click to open project
  recentProjectsList.querySelectorAll(".recent-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".recent-item-remove")) return;
      const path = (el as HTMLElement).dataset.path!;
      openProject(path);
    });
  });

  // Bind remove buttons
  recentProjectsList.querySelectorAll(".recent-item-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const path = (btn as HTMLElement).dataset.remove!;
      await removeProject(path);
      await renderRecentProjects();
    });
  });
}

// Open a project and switch to workspace view
async function openProject(path: string) {
  const project = await addProject(path);
  showWorkspace(project);
}

function showWorkspace(project: Project) {
  workspaceProjectName.textContent = project.name;
  workspaceProjectPath.textContent = project.path;
  welcomePage.classList.add("hidden");
  createDialog.classList.add("hidden");
  workspacePage.classList.remove("hidden");
}

function showWelcome() {
  workspacePage.classList.add("hidden");
  createDialog.classList.add("hidden");
  welcomePage.classList.remove("hidden");
  renderRecentProjects();
}

// Open folder dialog
async function handleOpenFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Project Folder",
  });

  if (selected) {
    await openProject(selected as string);
  }
}

// Create project dialog
function showCreateDialog() {
  projectPathInput.value = "";
  createDialog.classList.remove("hidden");
  projectPathInput.focus();
}

function hideCreateDialog() {
  createDialog.classList.add("hidden");
}

async function handleBrowsePath() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select Project Location",
  });

  if (selected) {
    projectPathInput.value = selected as string;
  }
}

async function handleConfirmCreate() {
  const path = projectPathInput.value.trim();
  if (!path) return;
  await openProject(path);
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Init
window.addEventListener("DOMContentLoaded", () => {
  welcomePage = $("welcome-page");
  workspacePage = $("workspace-page");
  createDialog = $("create-dialog");
  recentProjectsList = $("recent-projects");
  projectPathInput = $("project-path-input") as HTMLInputElement;
  workspaceProjectName = $("workspace-project-name");
  workspaceProjectPath = $("workspace-project-path");

  $("btn-open-folder").addEventListener("click", handleOpenFolder);
  $("btn-create-project").addEventListener("click", showCreateDialog);
  $("btn-browse-path").addEventListener("click", handleBrowsePath);
  $("btn-cancel-create").addEventListener("click", hideCreateDialog);
  $("btn-confirm-create").addEventListener("click", handleConfirmCreate);
  $("btn-back-home").addEventListener("click", showWelcome);

  // Allow Enter key in path input
  projectPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConfirmCreate();
    if (e.key === "Escape") hideCreateDialog();
  });

  // Close dialog on overlay click
  createDialog.addEventListener("click", (e) => {
    if (e.target === createDialog) hideCreateDialog();
  });

  renderRecentProjects();
});
