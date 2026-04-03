use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// ── Project management ──

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
    let config_dir = app
        .path()
        .app_config_dir()
        .expect("failed to get config dir");
    fs::create_dir_all(&config_dir).ok();
    config_dir.join("projects.json")
}

fn get_settings_path(app: &tauri::AppHandle) -> PathBuf {
    let config_dir = app
        .path()
        .app_config_dir()
        .expect("failed to get config dir");
    fs::create_dir_all(&config_dir).ok();
    config_dir.join("settings.json")
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

// ── File system commands ──

#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut entries: Vec<FileEntry> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden files/dirs
            if name.starts_with('.') {
                return None;
            }
            let path = entry.path().to_string_lossy().to_string();
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(FileEntry { name, path, is_dir })
        })
        .collect();

    // Sort: dirs first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

// ── File search (recursive listing for quick-open) ──

#[tauri::command]
fn search_files(root: String, query: String, max_results: usize) -> Vec<FileEntry> {
    let root_path = PathBuf::from(&root);
    let query_lower = query.to_lowercase();
    let max = if max_results == 0 { 200 } else { max_results };
    let mut results = Vec::new();
    collect_files(&root_path, &root_path, &query_lower, max, &mut results);
    results
}

fn collect_files(
    base: &PathBuf,
    dir: &PathBuf,
    query: &str,
    max: usize,
    results: &mut Vec<FileEntry>,
) {
    if results.len() >= max {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries {
        if results.len() >= max {
            return;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden dirs and common noise
        if name.starts_with('.') {
            continue;
        }
        if matches!(
            name.as_str(),
            "node_modules" | "target" | "dist" | "build" | ".git" | "__pycache__"
        ) {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();

        if is_dir {
            collect_files(base, &path, query, max, results);
        } else {
            // Get relative path for display
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            if query.is_empty() || rel.to_lowercase().contains(query) {
                results.push(FileEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir: false,
                });
            }
        }
    }
}

// ── Settings ──

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> String {
    let path = get_settings_path(&app);
    if path.exists() {
        fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string())
    } else {
        "{}".to_string()
    }
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    let path = get_settings_path(&app);
    fs::write(&path, settings).map_err(|e| e.to_string())
}

// ── App entry ──

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
            read_dir,
            read_file,
            write_file,
            search_files,
            load_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
