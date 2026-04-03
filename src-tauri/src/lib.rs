use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub last_opened: u64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ProjectsStore {
    pub projects: Vec<Project>,
}

fn get_config_path(app: &tauri::AppHandle) -> PathBuf {
    let config_dir = app.path().app_config_dir().expect("failed to get config dir");
    fs::create_dir_all(&config_dir).ok();
    config_dir.join("projects.json")
}

#[tauri::command]
fn get_projects(app: tauri::AppHandle) -> ProjectsStore {
    let path = get_config_path(&app);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        ProjectsStore::default()
    }
}

#[tauri::command]
fn add_project(app: tauri::AppHandle, path: String) -> Project {
    let config_path = get_config_path(&app);
    let mut store = if config_path.exists() {
        let data = fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        ProjectsStore::default()
    };

    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Remove existing entry with same path
    store.projects.retain(|p| p.path != path);

    let project = Project {
        name,
        path,
        last_opened: now,
    };

    store.projects.insert(0, project.clone());

    let json = serde_json::to_string_pretty(&store).unwrap();
    fs::write(&config_path, json).ok();

    project
}

#[tauri::command]
fn remove_project(app: tauri::AppHandle, path: String) {
    let config_path = get_config_path(&app);
    if config_path.exists() {
        let data = fs::read_to_string(&config_path).unwrap_or_default();
        let mut store: ProjectsStore = serde_json::from_str(&data).unwrap_or_default();
        store.projects.retain(|p| p.path != path);
        let json = serde_json::to_string_pretty(&store).unwrap();
        fs::write(&config_path, json).ok();
    }
}

#[tauri::command]
fn check_path_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_projects,
            add_project,
            remove_project,
            check_path_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
