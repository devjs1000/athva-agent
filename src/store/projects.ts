import { invoke } from "@tauri-apps/api/core";

export interface Project {
  name: string;
  path: string;
  last_opened: number;
}

export interface ProjectsStore {
  projects: Project[];
}

export async function getProjects(): Promise<ProjectsStore> {
  return await invoke<ProjectsStore>("get_projects");
}

export async function addProject(path: string): Promise<Project> {
  return await invoke<Project>("add_project", { path });
}

export async function removeProject(path: string): Promise<void> {
  await invoke("remove_project", { path });
}

export async function checkPathExists(path: string): Promise<boolean> {
  return await invoke<boolean>("check_path_exists", { path });
}
