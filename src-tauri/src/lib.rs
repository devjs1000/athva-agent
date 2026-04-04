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

// ── File operations (for context menu) ──

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("Directory already exists".to_string());
    }
    fs::create_dir_all(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(PathBuf::from(&path).parent().unwrap_or(&PathBuf::from(".")))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

// ── Git commands ──

#[derive(Debug, Serialize, Clone)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub is_repo: bool,
}

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_status(path: String) -> GitStatus {
    // Check if it's a git repo
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return GitStatus {
            branch: String::new(),
            ahead: 0,
            behind: 0,
            is_repo: false,
        };
    }

    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();

    // Get ahead/behind counts
    let mut ahead = 0;
    let mut behind = 0;
    if let Ok(upstream) = run_git(&path, &["rev-parse", "--abbrev-ref", "@{u}"]) {
        if !upstream.is_empty() {
            if let Ok(count) = run_git(
                &path,
                &["rev-list", "--left-right", "--count", &format!("HEAD...{}", upstream)],
            ) {
                let parts: Vec<&str> = count.split('\t').collect();
                if parts.len() == 2 {
                    ahead = parts[0].parse().unwrap_or(0);
                    behind = parts[1].parse().unwrap_or(0);
                }
            }
        }
    }

    GitStatus {
        branch,
        ahead,
        behind,
        is_repo: true,
    }
}

#[tauri::command]
fn git_sync(path: String) -> Result<String, String> {
    // Pull then push
    run_git(&path, &["pull", "--rebase"])?;
    run_git(&path, &["push"])?;
    Ok("Synced successfully".to_string())
}

#[tauri::command]
fn git_pull(path: String) -> Result<String, String> {
    run_git(&path, &["pull"])
}

#[tauri::command]
fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

// ── Source Control: detailed file status ──

#[derive(Debug, Serialize, Clone)]
pub struct GitFileChange {
    pub path: String,
    pub status: String,       // "M", "A", "D", "R", "?", "U"
    pub staged: bool,
}

#[tauri::command]
fn git_changed_files(path: String) -> Result<Vec<GitFileChange>, String> {
    let output = run_git(&path, &["status", "--porcelain=v1", "-uall"])?;
    let mut files: Vec<GitFileChange> = Vec::new();

    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }
        let index_status = line.chars().nth(0).unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let file_path = line[3..].to_string();
        // Handle renames: "R  old -> new"
        let display_path = if file_path.contains(" -> ") {
            file_path.split(" -> ").last().unwrap_or(&file_path).to_string()
        } else {
            file_path.clone()
        };

        // Staged change
        if index_status != ' ' && index_status != '?' {
            files.push(GitFileChange {
                path: display_path.clone(),
                status: index_status.to_string(),
                staged: true,
            });
        }

        // Unstaged change (working tree)
        if worktree_status != ' ' {
            let st = if index_status == '?' { "?".to_string() } else { worktree_status.to_string() };
            files.push(GitFileChange {
                path: display_path.clone(),
                status: st,
                staged: false,
            });
        }
    }

    Ok(files)
}

#[tauri::command]
fn git_stage(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["add", "--", &file])
}

#[tauri::command]
fn git_unstage(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["reset", "HEAD", "--", &file])
}

#[tauri::command]
fn git_stage_all(path: String) -> Result<String, String> {
    run_git(&path, &["add", "-A"])
}

#[tauri::command]
fn git_unstage_all(path: String) -> Result<String, String> {
    run_git(&path, &["reset", "HEAD"])
}

#[tauri::command]
fn git_discard_file(path: String, file: String) -> Result<String, String> {
    // Check if the file is untracked
    let status = run_git(&path, &["status", "--porcelain", "--", &file])?;
    if status.starts_with("??") {
        // Untracked file — remove it
        let full = std::path::Path::new(&path).join(&file);
        fs::remove_file(&full).map_err(|e| e.to_string())?;
        Ok("Removed untracked file".to_string())
    } else {
        run_git(&path, &["checkout", "--", &file])
    }
}

#[tauri::command]
fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message])
}

#[tauri::command]
fn git_diff_stat(path: String) -> Result<String, String> {
    // Compact summary: staged + unstaged stat
    let staged = run_git(&path, &["diff", "--cached", "--stat"]).unwrap_or_default();
    let unstaged = run_git(&path, &["diff", "--stat"]).unwrap_or_default();
    let mut result = String::new();
    if !staged.is_empty() {
        result.push_str("Staged:\n");
        result.push_str(&staged);
        result.push('\n');
    }
    if !unstaged.is_empty() {
        result.push_str("Unstaged:\n");
        result.push_str(&unstaged);
    }
    Ok(result)
}

#[tauri::command]
fn git_diff_file(path: String, file: String, staged: bool) -> Result<String, String> {
    if staged {
        run_git(&path, &["diff", "--cached", "--", &file])
    } else {
        run_git(&path, &["diff", "--", &file])
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
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_projects,
            add_project,
            remove_project,
            check_path_exists,
            read_dir,
            read_file,
            write_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            reveal_in_explorer,
            search_files,
            git_status,
            git_sync,
            git_pull,
            git_push,
            git_changed_files,
            git_stage,
            git_unstage,
            git_stage_all,
            git_unstage_all,
            git_discard_file,
            git_commit,
            git_diff_stat,
            git_diff_file,
            load_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
