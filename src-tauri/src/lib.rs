use regex::RegexBuilder;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewBuilder, WebviewUrl, WebviewWindowBuilder};

// ── Modules ──
pub mod network;
pub mod audio;

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

static STARTUP_OPEN_PATH: OnceLock<Option<String>> = OnceLock::new();

fn compute_startup_open_path() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.trim().is_empty() {
            continue;
        }
        // macOS can launch GUI apps with a `-psn_*` argument.
        if arg.starts_with('-') {
            continue;
        }
        let raw = arg.trim().to_string();
        let mut candidate = PathBuf::from(&raw);
        if candidate.is_relative() {
            if let Ok(cwd) = std::env::current_dir() {
                candidate = cwd.join(candidate);
            }
        }
        if !candidate.exists() {
            continue;
        }
        if candidate.is_file() {
            if let Some(parent) = candidate.parent() {
                candidate = parent.to_path_buf();
            }
        }
        if !candidate.is_dir() {
            continue;
        }
        let canonical = fs::canonicalize(&candidate).unwrap_or(candidate);
        return Some(canonical.to_string_lossy().to_string());
    }
    None
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
fn get_startup_open_path() -> Option<String> {
    STARTUP_OPEN_PATH.get().cloned().unwrap_or(None)
}

#[tauri::command]
fn read_env_masked(path: String) -> Result<String, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || !trimmed.contains('=') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let (lhs, rhs) = line.split_once('=').unwrap_or((line, ""));
        let rhs_trim = rhs.trim();
        if rhs_trim.is_empty() {
            out.push_str(lhs);
            out.push('=');
            out.push_str(rhs);
            out.push('\n');
            continue;
        }
        out.push_str(lhs);
        out.push('=');
        // Preserve surrounding quotes if present.
        let quote = rhs_trim.chars().next().unwrap_or('\0');
        if (quote == '"' || quote == '\'') && rhs_trim.ends_with(quote) && rhs_trim.len() >= 2 {
            out.push(quote);
            out.push_str("********");
            out.push(quote);
        } else {
            out.push_str("********");
        }
        out.push('\n');
    }
    Ok(out)
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


#[derive(Debug, Deserialize)]
struct HttpRequestPayload {
    method: String,
    url: String,
    headers: Option<BTreeMap<String, String>>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct HttpResponsePayload {
    status: u16,
    status_text: String,
    headers: BTreeMap<String, String>,
    body: String,
}

#[tauri::command]
async fn http_request(payload: HttpRequestPayload) -> Result<HttpResponsePayload, String> {
    let method = reqwest::Method::from_bytes(payload.method.trim().as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {}", e))?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.request(method.clone(), payload.url.trim());
    if let Some(headers) = payload.headers {
        let mut map = reqwest::header::HeaderMap::new();
        for (k, v) in headers {
            let name = reqwest::header::HeaderName::from_bytes(k.trim().as_bytes())
                .map_err(|e| format!("Invalid header name '{}': {}", k, e))?;
            let value = reqwest::header::HeaderValue::from_str(v.trim())
                .map_err(|e| format!("Invalid header value for '{}': {}", k, e))?;
            map.insert(name, value);
        }
        req = req.headers(map);
    }

    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        if let Some(body) = payload.body {
            if !body.is_empty() {
                req = req.body(body);
            }
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();

    let mut out_headers = BTreeMap::new();
    for (k, v) in resp.headers() {
        out_headers.insert(k.to_string(), v.to_str().unwrap_or("").to_string());
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(HttpResponsePayload {
        status: status.as_u16(),
        status_text,
        headers: out_headers,
        body,
    })
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

fn validate_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("Path traversal not allowed".to_string());
    }
    Ok(p)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}

// ── File operations (for context menu) ──

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
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
    let p = validate_path(&path)?;
    if p.exists() {
        return Err("Directory already exists".to_string());
    }
    fs::create_dir_all(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let src = validate_path(&old_path)?;
    let dst = validate_path(&new_path)?;
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
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

fn run_git_bytes(dir: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(output.stdout)
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
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("HEAD...{}", upstream),
                ],
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

#[derive(Debug, Serialize, Clone)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
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

#[tauri::command]
fn git_list_branches(path: String) -> Result<Vec<GitBranch>, String> {
    let current = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let output = run_git(
        &path,
        &[
            "branch",
            "--sort=-committerdate",
            "--format=%(refname:short)",
        ],
    )?;

    let branches = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|name| GitBranch {
            name: name.to_string(),
            current: name == current,
        })
        .collect();

    Ok(branches)
}

#[tauri::command]
fn git_switch_branch(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["checkout", &branch])
}

// ── Source Control: detailed file status ──

#[derive(Debug, Serialize, Clone)]
pub struct GitFileChange {
    pub path: String,
    pub status: String, // "M", "A", "D", "R", "?", "U"
    pub staged: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitContributionDay {
    pub date: String, // YYYY-MM-DD
    pub count: u32,
}

#[tauri::command]
fn git_changed_files(path: String) -> Result<Vec<GitFileChange>, String> {
    let output = run_git_bytes(&path, &["status", "--porcelain=v1", "-z", "-uall"])?;
    let mut files: Vec<GitFileChange> = Vec::new();
    let mut entries = output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());

    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let index_status = entry[0] as char;
        let worktree_status = entry[1] as char;

        // Skip ignored files (!!)
        if index_status == '!' && worktree_status == '!' {
            continue;
        }

        let current_path = String::from_utf8_lossy(&entry[3..]).to_string();
        // In porcelain -z, rename/copy records are followed by the original path.
        let display_path = if index_status == 'R' || index_status == 'C' {
            let _old_path = entries.next();
            current_path
        } else {
            current_path
        };

        if display_path.is_empty() {
            continue;
        }

        // Staged change: index has a real modification (not untracked, not ignored, not unmerged)
        if index_status != ' ' && index_status != '?' && index_status != '!' && index_status != 'U'
        {
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
    // repos with no commits yet have no HEAD — fall back to rm --cached
    run_git(&path, &["reset", "HEAD", "--", &file])
        .or_else(|_| run_git(&path, &["rm", "--cached", "--force", "--", &file]))
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

#[tauri::command]
fn git_contribution_days(
    path: String,
    since: Option<String>,
    until: Option<String>,
) -> Result<Vec<GitContributionDay>, String> {
    let mut args = vec!["log", "--date=short", "--pretty=format:%ad"];
    if let Some(s) = since.as_deref() {
        if !s.trim().is_empty() {
            args.push("--since");
            args.push(s);
        }
    }
    if let Some(u) = until.as_deref() {
        if !u.trim().is_empty() {
            args.push("--until");
            args.push(u);
        }
    }
    let output = run_git(&path, &args)?;
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for line in output.lines() {
        let date = line.trim();
        if date.len() == 10 {
            *counts.entry(date.to_string()).or_insert(0) += 1;
        }
    }

    Ok(counts
        .into_iter()
        .map(|(date, count)| GitContributionDay { date, count })
        .collect())
}

// ── Git Graph ──

#[derive(Debug, Serialize, Clone)]
struct GitLogEntry {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    author: String,
    date: String,
    subject: String,
    refs: String,
}

#[tauri::command]
fn git_log_graph(path: String, max_count: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let max = max_count.unwrap_or(500).to_string();
    let output = run_git(
        &path,
        &[
            "log",
            "--all",
            "--topo-order",
            "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%as%x1f%s%x1f%D",
            &format!("--max-count={}", max),
        ],
    )?;
    let mut entries = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.splitn(7, '\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        let parents: Vec<String> = parts[2]
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        entries.push(GitLogEntry {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            parents,
            author: parts[3].to_string(),
            date: parts[4].to_string(),
            subject: parts[5].to_string(),
            refs: parts[6].to_string(),
        });
    }
    Ok(entries)
}

#[derive(Debug, Serialize)]
struct GitAuthorStat {
    author: String,
    commits: u32,
}

#[tauri::command]
fn git_author_stats(path: String) -> Result<Vec<GitAuthorStat>, String> {
    let output = run_git(&path, &["shortlog", "-sn", "--all", "HEAD"])?;
    let mut result = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(tab_idx) = trimmed.find('\t') {
            let count: u32 = trimmed[..tab_idx].trim().parse().unwrap_or(0);
            let author = trimmed[tab_idx + 1..].trim().to_string();
            result.push(GitAuthorStat { author, commits: count });
        }
    }
    Ok(result)
}

// ── Git Blame ──

#[derive(Debug, Serialize)]
struct GitBlameLine {
    line: u32,
    hash: String,
    author: String,
    date: String,
    summary: String,
}

fn unix_to_ymd(ts: i64) -> String {
    let z = ts / 86400 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[tauri::command]
fn git_blame_file(path: String, file: String) -> Result<Vec<GitBlameLine>, String> {
    let output = run_git(&path, &["blame", "--line-porcelain", "--", &file])?;
    let mut result: Vec<GitBlameLine> = Vec::new();
    let mut hash = String::new();
    let mut author = String::new();
    let mut author_time: i64 = 0;
    let mut summary = String::new();

    for line in output.lines() {
        if line.starts_with('\t') {
            result.push(GitBlameLine {
                line: result.len() as u32 + 1,
                hash: hash[..8.min(hash.len())].to_string(),
                author: author.clone(),
                date: unix_to_ymd(author_time),
                summary: summary.clone(),
            });
        } else if line.len() >= 40 && line[..40].chars().all(|c| c.is_ascii_hexdigit()) {
            hash = line[..40].to_string();
        } else if let Some(a) = line.strip_prefix("author ") {
            author = a.to_string();
        } else if let Some(t) = line.strip_prefix("author-time ") {
            author_time = t.trim().parse().unwrap_or(0);
        } else if let Some(s) = line.strip_prefix("summary ") {
            summary = s.to_string();
        }
    }
    Ok(result)
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

#[tauri::command]
fn set_secret(key: String, value: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let service = "com.devjs1000.athva-agent";
        let status = Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                service,
                "-a",
                key.as_str(),
                "-w",
                value.as_str(),
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("security command failed with status {}", status));
    }
    #[allow(unreachable_code)]
    Err("Secure secret storage is not supported on this platform yet".to_string())
}

#[tauri::command]
fn get_secret(key: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let service = "com.devjs1000.athva-agent";
        let out = Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", key.as_str(), "-w"])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if value.is_empty() {
                return Ok(None);
            }
            return Ok(Some(value));
        }
        return Ok(None);
    }
    #[allow(unreachable_code)]
    Ok(None)
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let service = "com.devjs1000.athva-agent";
        let out = Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", key.as_str()])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("could not be found") {
            return Ok(());
        }
        return Err(format!("security delete failed: {}", stderr.trim()));
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
fn set_window_translucent_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let window = app.get_window("main").ok_or("main window not found")?;
        if enabled {
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                Some(NSVisualEffectState::Active),
                Some(16.0),
            )
            .map_err(|e| e.to_string())?;
        } else {
            clear_vibrancy(&window).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
    }
    Ok(())
}

// ── VS Code marketplace / extension install support ──

#[derive(Debug, Serialize, Clone)]
pub struct MarketplaceExtension {
    pub identifier: String,
    pub publisher: String,
    pub publisher_display_name: String,
    pub extension_name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub icon_url: String,
    pub installs: u64,
    pub average_rating: f64,
    pub rating_count: u64,
    pub download_url: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct InstalledExtension {
    pub identifier: String,
    pub publisher: String,
    pub extension_name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub install_path: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ExtensionUpdateQuery {
    pub publisher: String,
    pub extension_name: String,
    pub version: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExtensionUpdateInfo {
    pub identifier: String,
    pub installed_version: String,
    pub latest_version: String,
    pub update_available: bool,
}

fn extensions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let root = data_dir.join("extensions");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn sanitize_extension_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn marketplace_download_url(publisher: &str, extension_name: &str, version: &str) -> String {
    format!(
        "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{publisher}/vsextensions/{extension_name}/{version}/vspackage"
    )
}

fn compare_version_parts(installed: &str, latest: &str) -> std::cmp::Ordering {
    let split = |value: &str| {
        value
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .filter(|part| !part.is_empty())
            .map(|part| part.to_ascii_lowercase())
            .collect::<Vec<String>>()
    };
    let a = split(installed);
    let b = split(latest);
    let len = a.len().max(b.len());
    for idx in 0..len {
        let left = a.get(idx).cloned().unwrap_or_else(|| "0".to_string());
        let right = b.get(idx).cloned().unwrap_or_else(|| "0".to_string());
        let left_num = left.parse::<u64>();
        let right_num = right.parse::<u64>();
        let ord = match (left_num, right_num) {
            (Ok(l), Ok(r)) => l.cmp(&r),
            _ => left.cmp(&right),
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}

fn pick_latest_version(extension: &Value) -> Option<&Value> {
    extension
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|versions| versions.first())
}

fn pick_extension_file(version: &Value, asset_type: &str) -> Option<String> {
    version
        .get("files")
        .and_then(Value::as_array)
        .and_then(|files| {
            files.iter().find_map(|file| {
                if file.get("assetType").and_then(Value::as_str) == Some(asset_type) {
                    file.get("source")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
}

fn parse_marketplace_extension(extension: &Value) -> Option<MarketplaceExtension> {
    let publisher = extension
        .get("publisher")
        .and_then(|value| value.get("publisherName"))
        .and_then(Value::as_str)?
        .to_string();
    let publisher_display_name = extension
        .get("publisher")
        .and_then(|value| value.get("displayName"))
        .and_then(Value::as_str)
        .unwrap_or(&publisher)
        .to_string();
    let extension_name = extension
        .get("extensionName")
        .and_then(Value::as_str)?
        .to_string();
    let display_name = extension
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&extension_name)
        .to_string();
    let description = extension
        .get("shortDescription")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let latest = pick_latest_version(extension)?;
    let version = latest.get("version").and_then(Value::as_str)?.to_string();
    let icon_url = pick_extension_file(latest, "Microsoft.VisualStudio.Services.Icons.Default")
        .or_else(|| pick_extension_file(latest, "Microsoft.VisualStudio.Services.Icons.Small"))
        .unwrap_or_default();
    let download_url = pick_extension_file(latest, "Microsoft.VisualStudio.Services.VSIXPackage")
        .unwrap_or_else(|| marketplace_download_url(&publisher, &extension_name, &version));

    let mut installs = 0_u64;
    let mut average_rating = 0.0_f64;
    let mut rating_count = 0_u64;
    if let Some(stats) = extension.get("statistics").and_then(Value::as_array) {
        for stat in stats {
            let name = stat
                .get("statisticName")
                .and_then(Value::as_str)
                .unwrap_or("");
            let value = stat.get("value").and_then(Value::as_f64).unwrap_or(0.0);
            match name {
                "install" => installs = value.max(0.0) as u64,
                "averagerating" => average_rating = value,
                "ratingcount" => rating_count = value.max(0.0) as u64,
                _ => {}
            }
        }
    }

    Some(MarketplaceExtension {
        identifier: format!("{publisher}.{extension_name}"),
        publisher,
        publisher_display_name,
        extension_name,
        display_name,
        description,
        version,
        icon_url,
        installs,
        average_rating,
        rating_count,
        download_url,
    })
}

fn read_installed_extension(dir: PathBuf) -> Option<InstalledExtension> {
    let manifest_path = if dir.join("extension").join("package.json").is_file() {
        dir.join("extension").join("package.json")
    } else if dir.join("package.json").is_file() {
        dir.join("package.json")
    } else {
        return None;
    };

    let raw = fs::read_to_string(&manifest_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let publisher = parsed.get("publisher").and_then(Value::as_str)?.to_string();
    let extension_name = parsed.get("name").and_then(Value::as_str)?.to_string();
    let display_name = parsed
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&extension_name)
        .to_string();
    let description = parsed
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let version = parsed
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Some(InstalledExtension {
        identifier: format!("{publisher}.{extension_name}"),
        publisher,
        extension_name,
        display_name,
        description,
        version,
        install_path: dir.to_string_lossy().to_string(),
    })
}

fn remove_existing_extension_versions(
    root: &PathBuf,
    identifier_prefix: &str,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with(identifier_prefix) {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn remove_extension_by_identifier(root: &PathBuf, identifier: &str) -> Result<bool, String> {
    if !root.exists() {
        return Ok(false);
    }
    let mut removed = false;
    let prefix = format!("{}-", sanitize_extension_segment(identifier));
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            removed = true;
        }
    }
    Ok(removed)
}

fn download_file(url: &str, destination: &PathBuf) -> Result<(), String> {
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "90",
            "-o",
            &destination.to_string_lossy(),
            url,
        ])
        .output()
        .map_err(|e| format!("Failed to start curl: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "Marketplace download failed.".to_string()
        } else {
            stderr
        })
    }
}

fn extract_vsix(vsix_path: &PathBuf, destination: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                vsix_path.to_string_lossy().replace('\'', "''"),
                destination.to_string_lossy().replace('\'', "''")
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to start PowerShell: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("unzip")
        .args([
            "-oq",
            &vsix_path.to_string_lossy(),
            "-d",
            &destination.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("Failed to start unzip: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "VSIX extraction failed.".to_string()
        } else {
            stderr
        })
    }
}

#[tauri::command]
fn search_vscode_extensions(
    query: String,
    limit: usize,
) -> Result<Vec<MarketplaceExtension>, String> {
    let search_text = query.trim();
    let page_size = limit.clamp(1, 50);
    let body = if search_text.is_empty() {
        serde_json::json!({
            "filters": [{
                "pageNumber": 1,
                "pageSize": page_size,
                "sortBy": 4,
                "sortOrder": 0,
                "criteria": [
                    { "filterType": 8, "value": "Microsoft.VisualStudio.Code" }
                ]
            }],
            "assetTypes": [
                "Microsoft.VisualStudio.Services.Icons.Default",
                "Microsoft.VisualStudio.Services.Icons.Small",
                "Microsoft.VisualStudio.Services.VSIXPackage"
            ],
            "flags": 914
        })
    } else {
        serde_json::json!({
            "filters": [{
                "pageNumber": 1,
                "pageSize": page_size,
                "sortBy": 0,
                "sortOrder": 0,
                "criteria": [
                    { "filterType": 8, "value": "Microsoft.VisualStudio.Code" },
                    { "filterType": 10, "value": search_text }
                ]
            }],
            "assetTypes": [
                "Microsoft.VisualStudio.Services.Icons.Default",
                "Microsoft.VisualStudio.Services.Icons.Small",
                "Microsoft.VisualStudio.Services.VSIXPackage"
            ],
            "flags": 914
        })
    };

    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "60",
            "-X",
            "POST",
            "-H",
            "Accept: application/json;api-version=7.2-preview.1",
            "-H",
            "Content-Type: application/json",
            "-H",
            "X-Market-Client-Id: athva-agent",
            "--data",
            &body.to_string(),
            "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1",
        ])
        .output()
        .map_err(|e| format!("Failed to start curl: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Marketplace search failed.".to_string()
        } else {
            stderr
        });
    }

    let response_text = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(&response_text).map_err(|e| e.to_string())?;
    let items = parsed
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| results.first())
        .and_then(|result| result.get("extensions"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Marketplace response did not include extensions.".to_string())?;

    Ok(items
        .iter()
        .filter_map(parse_marketplace_extension)
        .collect())
}

#[tauri::command]
fn list_installed_vscode_extensions(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<Vec<InstalledExtension>, String> {
    let _ = project_path;
    let root = extensions_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut installed = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(extension) = read_installed_extension(path) {
            installed.push(extension);
        }
    }
    installed.sort_by(|a, b| a.identifier.cmp(&b.identifier));
    Ok(installed)
}

#[tauri::command]
fn install_vscode_extension(
    app: tauri::AppHandle,
    project_path: String,
    publisher: String,
    extension_name: String,
    version: String,
    download_url: Option<String>,
) -> Result<InstalledExtension, String> {
    let _ = project_path;
    let root = extensions_root(&app)?;

    let identifier = format!(
        "{}.{}",
        sanitize_extension_segment(&publisher),
        sanitize_extension_segment(&extension_name)
    );
    remove_existing_extension_versions(&root, &format!("{identifier}-"))?;

    let install_dir = root.join(format!(
        "{}-{}",
        identifier,
        sanitize_extension_segment(&version)
    ));
    if install_dir.exists() {
        fs::remove_dir_all(&install_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;

    let vsix_url = download_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| marketplace_download_url(&publisher, &extension_name, &version));
    let temp_vsix = std::env::temp_dir().join(format!(
        "athva-{}-{}.vsix",
        sanitize_extension_segment(&publisher),
        sanitize_extension_segment(&extension_name)
    ));

    download_file(&vsix_url, &temp_vsix)?;
    let extract_result = extract_vsix(&temp_vsix, &install_dir);
    let _ = fs::remove_file(&temp_vsix);
    extract_result?;

    read_installed_extension(install_dir).ok_or_else(|| {
        "Extension was downloaded, but its manifest could not be read after extraction.".to_string()
    })
}

#[tauri::command]
fn uninstall_vscode_extension(
    app: tauri::AppHandle,
    identifier: String,
) -> Result<(), String> {
    let root = extensions_root(&app)?;
    let removed = remove_extension_by_identifier(&root, &identifier)?;
    if removed {
        Ok(())
    } else {
        Err(format!("Extension not found: {identifier}"))
    }
}

#[tauri::command]
fn check_vscode_extension_updates(
    extensions: Vec<ExtensionUpdateQuery>,
) -> Result<Vec<ExtensionUpdateInfo>, String> {
    let mut updates = Vec::new();
    for ext in extensions {
        let identifier = format!("{}.{}", ext.publisher, ext.extension_name);
        let query = format!("{} {}", ext.publisher, ext.extension_name);
        let results = search_vscode_extensions(query, 25)?;
        let matched = results
            .into_iter()
            .find(|item| item.identifier.eq_ignore_ascii_case(&identifier));
        let latest_version = matched
            .map(|item| item.version)
            .unwrap_or_else(|| ext.version.clone());
        let update_available = compare_version_parts(&ext.version, &latest_version).is_lt();
        updates.push(ExtensionUpdateInfo {
            identifier,
            installed_version: ext.version,
            latest_version,
            update_available,
        });
    }
    Ok(updates)
}

// ── Embedded web tab (child webview inside main window) ──

const WEB_TAB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebMediaStateEvent {
    label: String,
    is_playing: bool,
}

fn emit_web_media_state(app: &tauri::AppHandle, label: &str, is_playing: bool) {
    let _ = app.emit(
        "web-media-state",
        WebMediaStateEvent {
            label: label.to_string(),
            is_playing,
        },
    );
}

fn build_web_media_observer_script(label: &str) -> String {
    let label_json = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".to_string());
    r#"(function () {
  const label = __ATHVA_LABEL__;
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;

  const storeKey = "__ATHVA_MEDIA_MONITOR__";
  if (window[storeKey] && typeof window[storeKey].cleanup === "function") {
    window[storeKey].cleanup();
  }
  window[storeKey] = { last: undefined };

  const reportState = () => {
    let isPlaying = false;
    try {
      isPlaying = Array.from(document.querySelectorAll("audio,video")).some((media) => {
        return !media.paused && !media.ended && media.readyState > 2;
      });
      if (!isPlaying && navigator.mediaSession && navigator.mediaSession.playbackState === "playing") {
        isPlaying = true;
      }
    } catch (_) {
      isPlaying = false;
    }

    if (window[storeKey] && window[storeKey].last === isPlaying) {
      return;
    }
    window[storeKey].last = isPlaying;
    invoke("report_web_media_state", { label, isPlaying }).catch(() => {});
  };

  const mediaEvents = ["play", "playing", "pause", "ended", "emptied", "loadstart", "canplay", "seeked", "volumechange"];
  const onMediaEvent = () => {
    window.setTimeout(reportState, 0);
  };

  mediaEvents.forEach((eventName) => {
    document.addEventListener(eventName, onMediaEvent, true);
  });
  document.addEventListener("visibilitychange", onMediaEvent, true);

  const mutationObserver = new MutationObserver(() => {
    window.setTimeout(reportState, 0);
  });
  if (document.documentElement) {
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  }

  const intervalId = window.setInterval(reportState, 1500);
  reportState();

  window[storeKey] = {
    last: window[storeKey] ? window[storeKey].last : undefined,
    cleanup() {
      mutationObserver.disconnect();
      window.clearInterval(intervalId);
      mediaEvents.forEach((eventName) => {
        document.removeEventListener(eventName, onMediaEvent, true);
      });
      document.removeEventListener("visibilitychange", onMediaEvent, true);
    },
  };
})();"#
        .replace("__ATHVA_LABEL__", &label_json)
}

#[tauri::command]
fn open_web_window(
    app: tauri::AppHandle,
    url: String,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = WebviewUrl::External(
        url.parse()
            .unwrap_or_else(|_| "https://example.com".parse().unwrap()),
    );

    // If already open, just show + reposition it
    if let Some(existing) = app.get_webview(&label) {
        existing.show().map_err(|e| e.to_string())?;
        existing
            .set_bounds(Rect {
                position: LogicalPosition::new(x, y).into(),
                size: LogicalSize::new(width, height).into(),
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let main_window = app.get_window("main").ok_or("main window not found")?;
    let page_load_label = label.clone();
    let page_load_app = app.clone();

    let builder = WebviewBuilder::new(&label, parsed)
        .user_agent(WEB_TAB_USER_AGENT)
        .on_navigation(move |_url| true)
        .on_new_window(move |_url, _features| {
            // Return Allow so wry creates the popup natively using the same
            // WKWebViewConfiguration as the opener. This preserves window.opener
            // and the shared cookie/session store — both required for OAuth flows
            // (Figma → Google, Grok → Google, etc.) to complete and post the
            // auth token back to the parent page via window.opener.postMessage().
            // Using NewWindowResponse::Create { window } breaks this because a
            // Tauri WebviewWindow is a separate WKWebView instance with no opener.
            NewWindowResponse::Allow
        })
        .initialization_script(r#"(function () {
            'use strict';
            var d = Object.defineProperty.bind(Object);
            var _nativeSend = window.webkit
                && window.webkit.messageHandlers
                && window.webkit.messageHandlers.ipc
                ? window.webkit.messageHandlers.ipc.postMessage.bind(window.webkit.messageHandlers.ipc)
                : null;

            // ── 1. Navigator spoofing ─────────────────────────────────────────────
            var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
            try { d(navigator, 'userAgent',      { get: function(){ return UA; },            configurable: false }); } catch(_) {}
            try { d(navigator, 'appVersion',     { get: function(){ return '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'; }, configurable: false }); } catch(_) {}
            try { d(navigator, 'vendor',         { get: function(){ return 'Google Inc.'; }, configurable: false }); } catch(_) {}
            try { d(navigator, 'platform',       { get: function(){ return 'MacIntel'; },   configurable: false }); } catch(_) {}
            try { d(navigator, 'webdriver',      { get: function(){ return false; },         configurable: false }); } catch(_) {}
            try { d(navigator, 'language',       { get: function(){ return 'en-US'; },       configurable: false }); } catch(_) {}
            try { d(navigator, 'languages',      { get: function(){ return ['en-US','en']; },configurable: false }); } catch(_) {}
            try { d(navigator, 'hardwareConcurrency', { get: function(){ return 8; },        configurable: false }); } catch(_) {}
            try { d(navigator, 'deviceMemory',   { get: function(){ return 8; },             configurable: false }); } catch(_) {}
            try { d(navigator, 'maxTouchPoints', { get: function(){ return 0; },             configurable: false }); } catch(_) {}

            // ── 2. Plugins / mimeTypes (empty in WKWebView, non-empty in Chrome) ──
            var _fakeMime = function(type, suf, desc) {
                return { type: type, suffixes: suf, description: desc, enabledPlugin: null };
            };
            var _fakePlugin = function(name, desc, file, mimes) {
                var p = { name: name, description: desc, filename: file, length: mimes.length };
                mimes.forEach(function(m, i) { p[i] = m; m.enabledPlugin = p; });
                p.item = function(i) { return p[i]; };
                p.namedItem = function(n) { for(var i=0;i<mimes.length;i++) if(mimes[i].type===n) return mimes[i]; return null; };
                return p;
            };
            var _pdfMime    = _fakeMime('application/pdf','pdf','Portable Document Format');
            var _pdfPlugin  = _fakePlugin('PDF Viewer','Portable Document Format','internal-pdf-viewer',[_pdfMime]);
            var _plugins = [_pdfPlugin];
            var _mimes   = [_pdfMime];
            var _pArr = Object.assign([_pdfPlugin], {
                item: function(i){ return _plugins[i]||null; },
                namedItem: function(n){ return _plugins.find(function(p){return p.name===n;})||null; },
                refresh: function(){}
            });
            var _mArr = Object.assign([_pdfMime], {
                item: function(i){ return _mimes[i]||null; },
                namedItem: function(t){ return _mimes.find(function(m){return m.type===t;})||null; }
            });
            try { d(navigator, 'plugins',   { get: function(){ return _pArr; }, configurable: false }); } catch(_) {}
            try { d(navigator, 'mimeTypes', { get: function(){ return _mArr; }, configurable: false }); } catch(_) {}

            // ── 3. window.chrome (absent in WKWebView, present in Chrome) ─────────
            try {
                d(window, 'chrome', {
                    value: {
                        app: { isInstalled: false, InstallState: { DISABLED:'disabled',INSTALLED:'installed',NOT_INSTALLED:'not_installed' }, RunningState: { CANNOT_RUN:'cannot_run',READY_TO_RUN:'ready_to_run',RUNNING:'running' } },
                        runtime: { OnInstalledReason: { CHROME_UPDATE:'chrome_update',INSTALL:'install',SHARED_MODULE_UPDATE:'shared_module_update',UPDATE:'update' }, OnRestartRequiredReason: { APP_UPDATE:'app_update',OS_UPDATE:'os_update',PERIODIC:'periodic' }, PlatformArch: { ARM:'arm',ARM64:'arm64',MIPS:'mips',MIPS64:'mips64',X86_32:'x86-32',X86_64:'x86-64' }, PlatformNaclArch: { ARM:'arm',MIPS:'mips',MIPS64:'mips64',X86_32:'x86-32',X86_64:'x86-64' }, PlatformOs: { ANDROID:'android',CROS:'cros',LINUX:'linux',MAC:'mac',OPENBSD:'openbsd',WIN:'win' }, RequestUpdateCheckStatus: { NO_UPDATE:'no_update',THROTTLED:'throttled',UPDATE_AVAILABLE:'update_available' } },
                        loadTimes: function() { return { requestTime: performance.timing ? performance.timing.navigationStart/1000 : 0, startLoadTime: performance.timing ? performance.timing.navigationStart/1000 : 0, commitLoadTime: performance.timing ? performance.timing.responseStart/1000 : 0, finishDocumentLoadTime: performance.timing ? performance.timing.domContentLoadedEventEnd/1000 : 0, finishLoadTime: performance.timing ? performance.timing.loadEventEnd/1000 : 0, firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: false, npnNegotiatedProtocol: 'http/1.1', wasAlternateProtocolAvailable: false, connectionInfo: 'http/1.1' }; },
                        csi: function() { return { startE: performance.timing ? performance.timing.navigationStart : 0, onloadT: performance.timing ? performance.timing.loadEventEnd : 0, pageT: performance.now(), tran: 15 }; }
                    },
                    writable: false, configurable: false
                });
            } catch(_) {}

            // ── 4. Permissions API (WKWebView has no Notification/geolocation perms)
            try {
                var _origQuery = window.Notification && window.Notification.permission;
                if (navigator.permissions && navigator.permissions.query) {
                    var _origPermsQuery = navigator.permissions.query.bind(navigator.permissions);
                    navigator.permissions.query = function(desc) {
                        return _origPermsQuery(desc).catch(function() {
                            return Promise.resolve({ state: 'prompt', onchange: null });
                        });
                    };
                }
            } catch(_) {}

            // ── 5. Hide window.webkit (WKWebView signal) ──────────────────────────
            try { delete window.webkit; } catch(_) {}
            try { d(window, 'webkit', { get: function(){ return undefined; }, configurable: false }); } catch(_) {}

            // ── 6. Hide Tauri identity globals (bot-detection signals) ────────────
            // isTauri and __TAURI__ are pure identity flags — safe to hide.
            // __TAURI_INTERNALS__ must stay because our media IPC uses it;
            // we only remove the 'metadata' sub-key that leaks the window label.
            try { d(window, 'isTauri', { get: function(){ return undefined; }, configurable: false }); } catch(_) {}
            try { d(window, '__TAURI__', { get: function(){ return undefined; }, configurable: false }); } catch(_) {}
            try { if (window.__TAURI_INTERNALS__) { delete window.__TAURI_INTERNALS__.metadata; } } catch(_) {}

            // ── 7. Restore window.ipc for Tauri IPC (now webkit is hidden) ────────
            if (_nativeSend) {
                try {
                    d(window, 'ipc', {
                        value: Object.freeze({ postMessage: function(s){ _nativeSend(s); } }),
                        writable: false, configurable: false
                    });
                } catch(_) {}
            }

            // ── 8. Silence ipc:// fetch attempts (CSP violation suppression) ──────
            (function() {
                var _F = window.fetch;
                window.fetch = function(input, init) {
                    var url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
                    if (url.slice(0,6) === 'ipc://' || url.slice(0,4) === 'ipc:') {
                        return Promise.reject(new TypeError('NetworkError'));
                    }
                    return _F.apply(this, arguments);
                };
            })();

            // ── 9. WebGL renderer masking ─────────────────────────────────────────
            (function() {
                var _getCtx = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function(type, attrs) {
                    var ctx = _getCtx.call(this, type, attrs);
                    if (!ctx) return ctx;
                    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
                        var _getParam = ctx.getParameter.bind(ctx);
                        ctx.getParameter = function(param) {
                            if (param === 37445) return 'Google Inc. (Apple)';       // UNMASKED_VENDOR_WEBGL
                            if (param === 37446) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M-Series GPU, Unspecified Version)'; // UNMASKED_RENDERER_WEBGL
                            return _getParam(param);
                        };
                    }
                    return ctx;
                };
            })();
            })();"#,
        )
        .on_page_load(move |webview, payload| match payload.event() {
            PageLoadEvent::Started => {
                emit_web_media_state(&page_load_app, &page_load_label, false);
            }
            PageLoadEvent::Finished => {
                emit_web_media_state(&page_load_app, &page_load_label, false);
                let _ = webview.eval(build_web_media_observer_script(&page_load_label));
            }
        })
        .auto_resize();

    let child = main_window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    // Disable WKWebView's cross-origin frame access restriction so that
    // Cloudflare Turnstile's iframe (challenges.cloudflare.com) can
    // postMessage to its parent frame (chatgpt.com / figma.com).
    // This uses a private WebKit API — the same technique Electron uses.
    #[cfg(target_os = "macos")]
    child
        .with_webview(|wv| {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            unsafe {
                let raw: *mut AnyObject = wv.inner() as *mut AnyObject;
                // Get WKPreferences from the WKWebView's configuration
                let config: *mut AnyObject = msg_send![raw, configuration];
                let prefs: *mut AnyObject = msg_send![config, preferences];
                // _setWebSecurityEnabled:NO — private API, disables cross-origin checks
                let _: () = msg_send![prefs, _setWebSecurityEnabled: false];
            }
        })
        .ok();

    Ok(())
}

#[tauri::command]
fn focus_web_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_app_window(app: tauri::AppHandle, project: String) -> Result<(), String> {
    // Generate a unique label so multiple windows can coexist
    let label = format!("app-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let mut encoded = String::with_capacity(project.len() * 3);
    for b in project.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{b:02X}"));
            }
        }
    }
    let url = if cfg!(debug_assertions) {
        let raw = format!("http://localhost:1420/?project={encoded}");
        WebviewUrl::External(raw.parse().unwrap_or_else(|_| "http://localhost:1420".parse().unwrap()))
    } else {
        WebviewUrl::App(format!("index.html?project={encoded}").into())
    };

    WebviewWindowBuilder::new(&app, &label, url)
        .title("Athva")
        .inner_size(900.0, 650.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn close_web_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_web_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_web_window(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn report_web_media_state(
    app: tauri::AppHandle,
    label: String,
    is_playing: bool,
) -> Result<(), String> {
    emit_web_media_state(&app, &label, is_playing);
    Ok(())
}

// ── Touch ID (macOS) ──

#[tauri::command]
fn touchid_authenticate(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // Use swift one-liner via swiftc inline, or fallback to osascript
        // We use a small Swift script executed via `swift -`
        let script = format!(
            r#"import LocalAuthentication
let ctx = LAContext()
var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {{
    print("unavailable")
    exit(1)
}}
let sema = DispatchSemaphore(value: 0)
var ok = false
ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "{reason}") {{ success, _ in
    ok = success
    sema.signal()
}}
sema.wait()
print(ok ? "ok" : "fail")
"#,
            reason = reason.replace('"', "'")
        );

        let output = std::process::Command::new("swift")
            .args(["-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(stdin) = child.stdin.take() {
                    let mut stdin = stdin;
                    let _ = stdin.write_all(script.as_bytes());
                }
                child.wait_with_output()
            })
            .map_err(|e| e.to_string())?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.trim() == "ok" {
            return Ok(true);
        }
        if stdout.trim() == "unavailable" {
            return Err("Touch ID is not available on this device".to_string());
        }
        return Ok(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Touch ID is only available on macOS".to_string())
    }
}

#[tauri::command]
fn touchid_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let script = r#"import LocalAuthentication
let ctx = LAContext()
var err: NSError?
let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
print(ok ? "yes" : "no")
"#;
        let output = std::process::Command::new("swift")
            .args(["-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(stdin) = child.stdin.take() {
                    let mut stdin = stdin;
                    let _ = stdin.write_all(script.as_bytes());
                }
                child.wait_with_output()
            })
            .ok();
        output.map_or(false, |o| {
            String::from_utf8_lossy(&o.stdout).trim() == "yes"
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
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
        let rows = stmt
            .query_map(params![proj], |row| {
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
        let rows = stmt
            .query_map(params![memory_type, project_path], |row| {
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

// ── Voice Call Commands ──

#[tauri::command]
async fn voice_initiate_call(
    peer_id: String,
    state: tauri::State<'_, network::VoiceCallManagerState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mgr = state.0.read().await;
    let call_id = mgr.initiate_call(network::PeerId::from_string(peer_id)).await?;
    app.emit("voice:call-state-changed", serde_json::json!({
        "callId": call_id.as_str(),
        "state": "RINGING"
    })).ok();
    Ok(call_id.as_str().to_string())
}

#[tauri::command]
async fn voice_accept_call(
    call_id: String,
    state: tauri::State<'_, network::VoiceCallManagerState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mgr = state.0.read().await;
    let cid = network::CallId::from_string(call_id.clone());
    mgr.accept_call(&cid).await?;
    app.emit("voice:call-established", serde_json::json!({ "callId": call_id })).ok();
    Ok(())
}

#[tauri::command]
async fn voice_reject_call(
    call_id: String,
    state: tauri::State<'_, network::VoiceCallManagerState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mgr = state.0.read().await;
    let cid = network::CallId::from_string(call_id.clone());
    mgr.reject_call(&cid).await?;
    app.emit("voice:call-ended", serde_json::json!({ "callId": call_id, "reason": "rejected" })).ok();
    Ok(())
}

#[tauri::command]
async fn voice_end_call(
    call_id: String,
    state: tauri::State<'_, network::VoiceCallManagerState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mgr = state.0.read().await;
    let cid = network::CallId::from_string(call_id.clone());
    mgr.end_call(&cid).await?;
    app.emit("voice:call-ended", serde_json::json!({ "callId": call_id, "reason": "ended" })).ok();
    Ok(())
}

#[tauri::command]
async fn voice_get_peers(
    state: tauri::State<'_, network::VoiceCallManagerState>,
) -> Result<Vec<network::Peer>, String> {
    let mgr = state.0.read().await;
    mgr.get_peers().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = STARTUP_OPEN_PATH.set(compute_startup_open_path());
    tauri::Builder::default()
        .manage(network::VoiceCallManagerState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Override the default Tauri menu which includes selectAll:/copy:/cut: selectors.
            // Those native actions fire at the macOS level before JS keydown events, which
            // prevents Monaco from handling Cmd+A/C/X in the editor. We replace it with a
            // minimal menu that only has Quit (required on macOS) and no Edit actions.
            let app_menu = SubmenuBuilder::new(app, "Athva")
                .about(Some(AboutMetadataBuilder::new().build()))
                .separator()
                .quit()
                .build()?;
            let menu = MenuBuilder::new(app).item(&app_menu).build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_open_path,
            read_env_masked,
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
            git_list_branches,
            git_switch_branch,
            git_changed_files,
            git_stage,
            git_unstage,
            git_stage_all,
            git_unstage_all,
            git_discard_file,
            git_commit,
            git_diff_stat,
            git_diff_file,
            git_contribution_days,
            git_log_graph,
            git_author_stats,
            git_blame_file,
            load_settings,
            save_settings,
            set_secret,
            get_secret,
            delete_secret,
            set_window_translucent_mode,
            search_vscode_extensions,
            list_installed_vscode_extensions,
            install_vscode_extension,
            uninstall_vscode_extension,
            check_vscode_extension_updates,
            memory_init,
            memory_add,
            memory_search,
            memory_list,
            memory_delete,
            memory_clear,
            memory_stats,
            open_app_window,
            open_web_window,
            focus_web_window,
            close_web_window,
            hide_web_window,
            resize_web_window,
            report_web_media_state,
            touchid_authenticate,
            touchid_available,
            http_request,
            voice_initiate_call,
            voice_accept_call,
            voice_reject_call,
            voice_end_call,
            voice_get_peers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
