// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use pulldown_cmark::{Parser, Options, html};
use rfd::AsyncFileDialog;
use std::fs;
use std::path::Path;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Serialize, Deserialize};

#[tauri::command]
fn parse_markdown(text: &str) -> String {
    // Enable common markdown extensions for better rendering
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(text, opts);
    let mut html_output = String::with_capacity(text.len() * 2);
    html::push_html(&mut html_output, parser);
    html_output
}

#[derive(Serialize, Deserialize)]
struct FileData {
    path: String,
    name: String,
    content: String,
}

/// Returns the current platform so the frontend can adjust keyboard shortcuts.
/// Values: "linux", "windows", "macos"
#[tauri::command]
fn get_platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "macos"
    }
}

/// Opens a native file-picker dialog asynchronously.
/// Using AsyncFileDialog prevents the GTK dialog from blocking the main thread
/// on Linux, which was the cause of the application freeze.
#[tauri::command]
async fn open_file_dialog() -> Option<FileData> {
    let file = AsyncFileDialog::new()
        .add_filter("Text & Markdown Files", &["md", "markdown", "txt", "text", "org", "rst", "log", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "rs", "py", "c", "h", "cpp", "sh", "ini", "cfg", "toml", "env", "csv", "tsv", "tex", "sql"])
        .add_filter("Image Files", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"])
        .add_filter("All Text Files", &["*"])
        .pick_file()
        .await;

    if let Some(handle) = file {
        let path = handle.path().to_path_buf();
        // Read file content asynchronously to avoid blocking
        let content = fs::read_to_string(&path).unwrap_or_default();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "untitled.md".to_string());
        return Some(FileData {
            path: path.to_string_lossy().into_owned(),
            name,
            content,
        });
    }
    None
}

/// Opens a native save dialog asynchronously.
#[tauri::command]
async fn save_file_dialog(content: String) -> Option<String> {
    let file = AsyncFileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .save_file()
        .await;

    if let Some(handle) = file {
        let path = handle.path().to_path_buf();
        let _ = fs::write(&path, content.as_bytes());
        return Some(path.to_string_lossy().into_owned());
    }
    None
}

#[tauri::command]
fn save_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

/// Opens a file by absolute path without showing a dialog.
/// Used by the recent-files sidebar.
#[tauri::command]
fn read_file(path: String) -> Result<FileData, String> {
    let path_buf = std::path::PathBuf::from(&path);
    let content = fs::read_to_string(&path_buf)
        .map_err(|e| format!("Cannot open {path}: {e}"))?;
    let name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled.md".into());
    Ok(FileData { path, name, content })
}

/// Reads an image from an absolute local path and returns it as a
/// "data:image/TYPE;base64,DATA" URL ready to use as an <img src>.
/// This avoids all asset-protocol / CSP / scope issues.
#[tauri::command]
fn read_image_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png"  => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif"  => "image/gif",
        "webp" => "image/webp",
        "svg"  => "image/svg+xml",
        "bmp"  => "image/bmp",
        "ico"  => "image/x-icon",
        "avif" => "image/avif",
        _      => "application/octet-stream",
    };
    let b64 = STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CliPayload {
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    pub file_content: Option<String>,
    pub mode: Option<String>,
    pub theme: Option<String>,
}

#[tauri::command]
fn get_cli_args() -> CliPayload {
    let args: Vec<String> = std::env::args().collect();
    let mut payload = CliPayload::default();

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--mode" && i + 1 < args.len() {
            payload.mode = Some(args[i + 1].clone());
            i += 2;
            continue;
        } else if arg.starts_with("--mode=") {
            payload.mode = Some(arg.trim_start_matches("--mode=").to_string());
            i += 1;
            continue;
        } else if arg == "--theme" && i + 1 < args.len() {
            payload.theme = Some(args[i + 1].clone());
            i += 2;
            continue;
        } else if arg.starts_with("--theme=") {
            payload.theme = Some(arg.trim_start_matches("--theme=").to_string());
            i += 1;
            continue;
        } else if !arg.starts_with('-') && payload.file_path.is_none() {
            let path_buf = std::path::PathBuf::from(arg);
            let abs_path = fs::canonicalize(&path_buf).unwrap_or_else(|_| path_buf.clone());
            let path_str = abs_path.to_string_lossy().into_owned();
            let name = abs_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "untitled.md".into());
            
            if let Ok(content) = fs::read_to_string(&abs_path) {
                payload.file_path = Some(path_str);
                payload.file_name = Some(name);
                payload.file_content = Some(content);
            }
            i += 1;
            continue;
        }
        i += 1;
    }

    payload
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_nextcloud_config() -> Option<artfultype_rs_lib::nextcloud::NextcloudConfig> {
    artfultype_rs_lib::nextcloud::load_config()
}

#[tauri::command]
fn save_nextcloud_config(config: artfultype_rs_lib::nextcloud::NextcloudConfig) -> Result<(), String> {
    artfultype_rs_lib::nextcloud::save_config(&config)
}

#[tauri::command]
fn unlink_nextcloud() -> Result<(), String> {
    artfultype_rs_lib::nextcloud::unlink_config()
}

#[tauri::command]
fn test_nextcloud_connection(config: artfultype_rs_lib::nextcloud::NextcloudConfig) -> Result<String, String> {
    artfultype_rs_lib::nextcloud::test_connection(&config)
}

#[tauri::command]
fn list_nextcloud_folder(path: String) -> Result<Vec<artfultype_rs_lib::nextcloud::NextcloudEntry>, String> {
    let cfg = artfultype_rs_lib::nextcloud::load_config().ok_or_else(|| "Nextcloud is not linked".to_string())?;
    artfultype_rs_lib::nextcloud::list_folder(&cfg, &path)
}

#[tauri::command]
fn read_nextcloud_file(path: String) -> Result<String, String> {
    let cfg = artfultype_rs_lib::nextcloud::load_config().ok_or_else(|| "Nextcloud is not linked".to_string())?;
    artfultype_rs_lib::nextcloud::read_file(&cfg, &path)
}

#[tauri::command]
fn read_nextcloud_image_base64(path: String) -> Result<String, String> {
    let cfg = artfultype_rs_lib::nextcloud::load_config().ok_or_else(|| "Nextcloud is not linked".to_string())?;
    artfultype_rs_lib::nextcloud::read_image_base64(&cfg, &path)
}

#[tauri::command]
fn write_nextcloud_file(path: String, content: String) -> Result<(), String> {
    let cfg = artfultype_rs_lib::nextcloud::load_config().ok_or_else(|| "Nextcloud is not linked".to_string())?;
    artfultype_rs_lib::nextcloud::write_file(&cfg, &path, &content)
}

#[tauri::command]
fn delete_nextcloud_entry(path: String) -> Result<(), String> {
    let cfg = artfultype_rs_lib::nextcloud::load_config().ok_or_else(|| "Nextcloud is not linked".to_string())?;
    artfultype_rs_lib::nextcloud::delete_entry(&cfg, &path)
}

#[tauri::command]
fn create_nextcloud_folder(path: String) -> Result<(), String> {
    let cfg = artfultype_rs_lib::nextcloud::load_config().ok_or_else(|| "Nextcloud is not linked".to_string())?;
    artfultype_rs_lib::nextcloud::create_folder(&cfg, &path)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    for arg in &args[1..] {
        if arg == "-h" || arg == "--help" {
            println!("ArtfulType Terminal / CLI WebKit Executable v0.30.3");
            println!("Usage: artfultype-rs [OPTIONS] [FILE]\n");
            println!("Options:");
            println!("  --mode <MODE>      Set initial view mode (writer | markdown | split)");
            println!("  --theme <THEME>    Set initial theme (dark-antigravity | retro-green | retro-amber | dracula)");
            println!("  -h, --help         Print help information");
            println!("  -v, --version      Print version information");
            return;
        } else if arg == "-v" || arg == "--version" {
            println!("ArtfulType Terminal / CLI WebKit Executable v0.30.3");
            return;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            parse_markdown,
            get_platform,
            get_cli_args,
            open_file_dialog,
            save_file_dialog,
            save_file,
            read_file,
            read_image_base64,
            rename_file,
            delete_file,
            get_nextcloud_config,
            save_nextcloud_config,
            unlink_nextcloud,
            test_nextcloud_connection,
            list_nextcloud_folder,
            read_nextcloud_file,
            read_nextcloud_image_base64,
            write_nextcloud_file,
            delete_nextcloud_entry,
            create_nextcloud_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

