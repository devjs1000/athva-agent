use regex::RegexBuilder;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;
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

#[tauri::command]
fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut pids = collect_child_pids(pid)?;
        pids.push(pid);

        let pid_args: Vec<String> = pids.iter().map(|p| p.to_string()).collect();
        if !pid_args.is_empty() {
            let _ = Command::new("kill").arg("-TERM").args(&pid_args).status();
            thread::sleep(Duration::from_millis(250));
            let _ = Command::new("kill").arg("-KILL").args(&pid_args).status();
        }

        return Ok(());
    }
}

#[cfg(not(target_os = "windows"))]
fn collect_child_pids(pid: u32) -> Result<Vec<u32>, String> {
    let output = Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let child_pid = match line.trim().parse::<u32>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        pids.push(child_pid);
        pids.extend(collect_child_pids(child_pid)?);
    }
    Ok(pids)
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

// ── Global search (search/replace in files) ──

#[derive(Debug, Serialize, Clone)]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[tauri::command]
fn search_in_files(
    root: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    max_results: usize,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let max = if max_results == 0 { 500 } else { max_results };
    let pat = if use_regex {
        query.clone()
    } else {
        regex::escape(&query)
    };
    let re = RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    grep_dir(&PathBuf::from(&root), &re, max, &mut results);
    Ok(results)
}

fn grep_dir(dir: &PathBuf, re: &regex::Regex, max: usize, results: &mut Vec<SearchMatch>) {
    if results.len() >= max {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut entries_vec: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries_vec.sort_by_key(|e| e.file_name());
    for entry in entries_vec {
        if results.len() >= max {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
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
        if path.is_dir() {
            grep_dir(&path, re, max, results);
        } else {
            grep_file(&path, re, max, results);
        }
    }
}

fn grep_file(path: &PathBuf, re: &regex::Regex, max: usize, results: &mut Vec<SearchMatch>) {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return,
    };
    // Skip binary files
    if bytes[..bytes.len().min(512)].contains(&0u8) {
        return;
    }
    let content = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return,
    };
    let path_str = path.to_string_lossy().to_string();
    for (line_idx, line) in content.lines().enumerate() {
        if results.len() >= max {
            break;
        }
        if let Some(m) = re.find(line) {
            results.push(SearchMatch {
                path: path_str.clone(),
                line: line_idx + 1,
                col: m.start(),
                line_content: line.to_string(),
                match_start: m.start(),
                match_end: m.end(),
            });
        }
    }
}

#[tauri::command]
fn replace_in_files(
    paths: Vec<String>,
    query: String,
    replacement: String,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<usize, String> {
    if query.is_empty() {
        return Ok(0);
    }
    let pat = if use_regex {
        query.clone()
    } else {
        regex::escape(&query)
    };
    let re = RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;

    let mut total = 0usize;
    for path_str in &paths {
        let path = PathBuf::from(path_str);
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let count = re.find_iter(&content).count();
        if count == 0 {
            continue;
        }
        let new_content = re.replace_all(&content, regex::NoExpand(replacement.as_str()));
        fs::write(&path, new_content.as_bytes()).map_err(|e| e.to_string())?;
        total += count;
    }
    Ok(total)
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

        // Skip ignored files (!!)
        if index_status == '!' && worktree_status == '!' {
            continue;
        }

        let file_path = line[3..].to_string();
        // Handle renames: "old -> new" — take the new name
        let raw_path = if file_path.contains(" -> ") {
            file_path.split(" -> ").last().unwrap_or(&file_path).to_string()
        } else {
            file_path.clone()
        };
        // Trim stray whitespace / control chars that can shift display
        let display_path = raw_path.trim().to_string();
        if display_path.is_empty() {
            continue;
        }

        // Staged change: index has a real modification (not untracked, not ignored, not unmerged)
        if index_status != ' ' && index_status != '?' && index_status != '!' && index_status != 'U' {
            files.push(GitFileChange {
                path: display_path.clone(),
                status: index_status.to_string(),
                staged: true,
            });
        }

        // Unstaged / worktree change
        if worktree_status != ' ' && worktree_status != '!' {
            let st = match index_status {
                '?' => "?".to_string(),
                'U' => "U".to_string(), // conflict
                _ => worktree_status.to_string(),
            };
            files.push(GitFileChange {
                path: display_path.clone(),
                status: st,
                staged: false,
            });
        }

        // Unmerged conflict (both sides modified — UU, AA, DD, etc.)
        if index_status == 'U' || worktree_status == 'U' {
            // Already handled above as unstaged; ensure it doesn't slip into staged
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

// ── Agent Memory ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryEntry {
    pub id: i64,
    pub content: String,
    pub memory_type: String,
    pub project_path: Option<String>,
    pub tags: String,
    pub created_at: i64,
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryStats {
    pub global_count: i64,
    pub project_count: i64,
}

fn memories_db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(home).join(".athva");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("memories.db"))
}

fn get_conn() -> Result<Connection, String> {
    let path = memories_db_path()?;
    Connection::open(path).map_err(|e| e.to_string())
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

fn blob_to_f32(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn f32_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

#[tauri::command]
fn memory_init() -> Result<(), String> {
    let conn = get_conn()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memories (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            content      TEXT    NOT NULL,
            embedding    BLOB    NOT NULL,
            memory_type  TEXT    NOT NULL,
            project_path TEXT,
            tags         TEXT    DEFAULT '',
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_type_proj ON memories(memory_type, project_path);",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_add(
    content: String,
    embedding: Vec<f32>,
    memory_type: String,
    project_path: Option<String>,
    tags: String,
) -> Result<i64, String> {
    let conn = get_conn()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let blob = f32_to_blob(&embedding);
    conn.execute(
        "INSERT INTO memories (content, embedding, memory_type, project_path, tags, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![content, blob, memory_type, project_path, tags, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn memory_search(
    query_embedding: Vec<f32>,
    memory_type: String,
    project_path: Option<String>,
    limit: usize,
) -> Result<Vec<MemoryEntry>, String> {
    let conn = get_conn()?;
    let rows = if memory_type == "all" {
        // search both global and project
        let mut stmt = conn
            .prepare("SELECT id, content, embedding, memory_type, project_path, tags, created_at FROM memories WHERE memory_type = 'global' OR (memory_type = 'project' AND project_path = ?1)")
            .map_err(|e| e.to_string())?;
        let proj = project_path.as_deref().unwrap_or("");
        let rows = stmt.query_map(params![proj], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();
        rows
    } else {
        let mut stmt = conn
            .prepare("SELECT id, content, embedding, memory_type, project_path, tags, created_at FROM memories WHERE memory_type = ?1 AND (?2 IS NULL OR project_path = ?2)")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![memory_type, project_path], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();
        rows
    };

    let mut scored: Vec<(f32, MemoryEntry)> = rows
        .into_iter()
        .map(|(id, content, blob, mtype, proj, tags, created_at)| {
            let emb = blob_to_f32(&blob);
            let score = cosine_similarity(&query_embedding, &emb);
            (
                score,
                MemoryEntry {
                    id,
                    content,
                    memory_type: mtype,
                    project_path: proj,
                    tags,
                    created_at,
                    score,
                },
            )
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored.into_iter().take(limit).map(|(_, e)| e).collect())
}

#[tauri::command]
fn memory_list(
    memory_type: String,
    project_path: Option<String>,
) -> Result<Vec<MemoryEntry>, String> {
    let conn = get_conn()?;
    let mut stmt = conn
        .prepare("SELECT id, content, memory_type, project_path, tags, created_at FROM memories WHERE memory_type = ?1 AND (?2 IS NULL OR project_path = ?2) ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(params![memory_type, project_path], |row| {
            Ok(MemoryEntry {
                id: row.get(0)?,
                content: row.get(1)?,
                memory_type: row.get(2)?,
                project_path: row.get(3)?,
                tags: row.get(4)?,
                created_at: row.get(5)?,
                score: 0.0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

#[tauri::command]
fn memory_delete(id: i64) -> Result<(), String> {
    let conn = get_conn()?;
    conn.execute("DELETE FROM memories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn memory_clear(memory_type: String, project_path: Option<String>) -> Result<(), String> {
    let conn = get_conn()?;
    conn.execute(
        "DELETE FROM memories WHERE memory_type = ?1 AND (?2 IS NULL OR project_path = ?2)",
        params![memory_type, project_path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn memory_stats(project_path: Option<String>) -> Result<MemoryStats, String> {
    let conn = get_conn()?;
    let global_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE memory_type = 'global'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let project_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE memory_type = 'project' AND (?1 IS NULL OR project_path = ?1)",
            params![project_path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(MemoryStats {
        global_count,
        project_count,
    })
}

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
            kill_process_tree,
            read_dir,
            read_file,
            write_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            reveal_in_explorer,
            search_files,
            search_in_files,
            replace_in_files,
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
            memory_init,
            memory_add,
            memory_search,
            memory_list,
            memory_delete,
            memory_clear,
            memory_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
