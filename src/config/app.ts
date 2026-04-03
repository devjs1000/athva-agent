export const APP_CONFIG = {
  brand: "Athva",
  name: "Athva Agent",
  version: "0.1.0",
  identifier: "com.devjs1000.athva-agent",
  description: "AI-powered development agent by Athva",
} as const;

export const STORAGE_KEYS = {
  recentProjects: "athva_recent_projects",
  appSettings: "athva_app_settings",
} as const;

export const PATHS = {
  configDir: ".athva",
  projectsFile: "projects.json",
} as const;
