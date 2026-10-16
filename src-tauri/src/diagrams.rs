//! Diagram renderers used by the Writer view.
//!
//! * **ASCII / Unicode text diagrams** are rendered in-process with `svgbob`.
//! * **PlantUML** and **D2** are rendered by the locally installed CLI tools
//!   (`plantuml` / `java -jar plantuml.jar`, `d2`). Nothing is sent over the
//!   network: diagram sources may contain private information.
//!
//! Robustness / security notes:
//! * Only a fixed allow-list of programs is ever executed. User-supplied
//!   overrides (env vars) must be absolute paths to existing files.
//! * Diagram source is passed through **stdin only**, never as an argument,
//!   so it can't inject CLI flags.
//! * Every external render has a hard timeout and the process is killed.
//! * Output size is capped; the frontend additionally sanitises the SVG.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_SOURCE_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const RENDER_TIMEOUT: Duration = Duration::from_secs(20);

fn check_source(source: &str) -> Result<(), String> {
    if source.trim().is_empty() {
        return Err("Empty diagram".into());
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(format!("Diagram source too large (max {} KB)", MAX_SOURCE_BYTES / 1024));
    }
    Ok(())
}

/// Find an executable in PATH (plus a few common install dirs that GUI
/// launchers frequently omit from PATH, e.g. Homebrew / ~/.local/bin / Go).
fn find_in_path(name: &str) -> Option<PathBuf> {
    let exe_names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.bat"), format!("{name}.cmd")]
    } else {
        vec![name.to_string()]
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("go/bin"));
        dirs.push(home.join("bin"));
    }
    for dir in dirs {
        for n in &exe_names {
            let candidate = dir.join(n);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Validate a user-supplied override path: must be absolute and an existing file.
fn env_override(var: &str) -> Option<PathBuf> {
    let raw = std::env::var_os(var)?;
    let p = PathBuf::from(raw);
    if p.is_absolute() && p.is_file() {
        Some(p)
    } else {
        eprintln!("[diagrams] ignoring {var}: must be an absolute path to an existing file");
        None
    }
}

/// Run `program args…`, feed `input` on stdin, return stdout.
/// Enforces a timeout and an output size cap. On non-zero exit returns stderr.
/// If `accept_svg_on_failure` is set, a non-zero exit that still produced an
/// SVG (PlantUML's rendered error image) is returned as success.
fn run_renderer(
    program: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    input: &str,
    accept_svg_on_failure: bool,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", program.display()))?;

    // Write stdin and read stdout/stderr on threads to avoid pipe deadlocks.
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let input_owned = input.to_owned();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(input_owned.as_bytes());
        // dropping stdin closes the pipe → EOF for the renderer
    });
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(MAX_OUTPUT_BYTES as u64 + 1).read_to_end(&mut buf);
        buf
    });
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > RENDER_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Rendering timed out after {} s",
                        RENDER_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return Err(format!("Renderer error: {e}")),
        }
    };
    let _ = writer.join();
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();

    if out.len() > MAX_OUTPUT_BYTES {
        return Err("Rendered diagram is too large".into());
    }
    let out = String::from_utf8_lossy(&out).into_owned();
    if status.success() || (accept_svg_on_failure && out.contains("<svg")) {
        if !out.contains("<svg") {
            return Err("Renderer produced no SVG output".into());
        }
        return Ok(out);
    }
    let err = String::from_utf8_lossy(&err).trim().to_string();
    Err(if err.is_empty() {
        format!("Renderer exited with {status}")
    } else {
        err
    })
}

// ── PlantUML ──────────────────────────────────────────────────────────────────

enum PlantUml {
    Exe(PathBuf),
    Jar { java: PathBuf, jar: PathBuf },
}

fn locate_plantuml() -> Option<PlantUml> {
    let java = || {
        std::env::var_os("JAVA_HOME")
            .map(|h| PathBuf::from(h).join("bin").join(if cfg!(windows) { "java.exe" } else { "java" }))
            .filter(|p| p.is_file())
            .or_else(|| find_in_path("java"))
    };

    if let Some(p) = env_override("ARTFULTYPE_PLANTUML") {
        let is_jar = p.extension().map(|e| e.eq_ignore_ascii_case("jar")).unwrap_or(false);
        return if is_jar {
            java().map(|java| PlantUml::Jar { java, jar: p })
        } else {
            Some(PlantUml::Exe(p))
        };
    }
    if let Some(p) = find_in_path("plantuml") {
        return Some(PlantUml::Exe(p));
    }
    let mut jars: Vec<PathBuf> = [
        "/usr/share/plantuml/plantuml.jar",
        "/usr/share/java/plantuml.jar",
        "/usr/share/java/plantuml/plantuml.jar",
        "/opt/plantuml/plantuml.jar",
        "/opt/homebrew/opt/plantuml/libexec/plantuml.jar",
        "/usr/local/opt/plantuml/libexec/plantuml.jar",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        jars.push(home.join(".local/share/plantuml/plantuml.jar"));
        jars.push(home.join(".local/share/plantuml.jar"));
        jars.push(home.join("plantuml.jar"));
    }
    let jar = jars.into_iter().find(|j| j.is_file())?;
    java().map(|java| PlantUml::Jar { java, jar })
}

/// Wrap bare PlantUML sources in `@startuml … @enduml`.
fn normalize_plantuml(source: &str) -> String {
    let has_start = source.lines().any(|l| l.trim_start().starts_with("@start"));
    if has_start {
        source.to_string()
    } else {
        format!("@startuml\n{}\n@enduml\n", source.trim_end())
    }
}

fn render_plantuml_blocking(source: String, dark: bool) -> Result<String, String> {
    check_source(&source)?;
    let tool = locate_plantuml().ok_or(
        "PlantUML not found. Install it (e.g. `sudo apt install plantuml`, \
         `brew install plantuml`) or set ARTFULTYPE_PLANTUML to the plantuml \
         executable or plantuml.jar.",
    )?;
    let mut src = normalize_plantuml(&source);
    if dark && !src.contains("skinparam backgroundColor") && !src.contains("!theme") {
        // Make diagrams readable on dark backgrounds without altering the file.
        src = src.replacen("\n", "\nskinparam backgroundColor transparent\n!theme cyborg\n", 1);
    } else if !src.contains("skinparam backgroundColor") {
        src = src.replacen("\n", "\nskinparam backgroundColor transparent\n", 1);
    }
    // SANDBOX disables !include of local files/URLs and other I/O.
    let envs = [("PLANTUML_SECURITY_PROFILE", "SANDBOX"), ("JAVA_TOOL_OPTIONS", "-Djava.awt.headless=true")];
    let common = ["-tsvg", "-pipe", "-charset", "UTF-8", "-nometadata", "-nbthread", "1"];
    match tool {
        PlantUml::Exe(exe) => run_renderer(&exe, &common, &envs, &src, true),
        PlantUml::Jar { java, jar } => {
            let jar_s = jar.to_string_lossy().into_owned();
            let mut args: Vec<&str> = vec![
                "-Djava.awt.headless=true",
                "-DPLANTUML_SECURITY_PROFILE=SANDBOX",
                "-jar",
                &jar_s,
            ];
            args.extend_from_slice(&common);
            run_renderer(&java, &args, &envs, &src, true)
        }
    }
}

#[tauri::command]
pub async fn render_plantuml(source: String, dark: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || render_plantuml_blocking(source, dark))
        .await
        .map_err(|e| format!("Render task failed: {e}"))?
}

// ── D2 ────────────────────────────────────────────────────────────────────────

fn render_d2_blocking(source: String, dark: bool) -> Result<String, String> {
    check_source(&source)?;
    let d2 = env_override("ARTFULTYPE_D2").or_else(|| find_in_path("d2")).ok_or(
        "D2 not found. Install it from https://d2lang.com (e.g. \
         `curl -fsSL https://d2lang.com/install.sh | sh -s --`, `brew install d2`) \
         or set ARTFULTYPE_D2 to the d2 executable.",
    )?;
    // Theme 0 = Neutral default, 200 = Dark Mauve.
    let theme = if dark { "200" } else { "0" };
    let args = ["--theme", theme, "--pad", "16", "--layout", "dagre", "-", "-"];
    let out = run_renderer(&d2, &args, &[("D2_LAYOUT", "dagre")], &source, false)?;
    // d2 prints a leading XML declaration on some versions; strip anything before <svg.
    Ok(match out.find("<svg") {
        Some(i) => out[i..].to_string(),
        None => out,
    })
}

#[tauri::command]
pub async fn render_d2(source: String, dark: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || render_d2_blocking(source, dark))
        .await
        .map_err(|e| format!("Render task failed: {e}"))?
}

// ── ASCII / Unicode text diagrams (svgbob) ────────────────────────────────────

fn render_svgbob_blocking(source: String) -> Result<String, String> {
    check_source(&source)?;
    // Normalise tabs (svgbob works on a character grid).
    let src = source.replace('\t', "    ");
    let settings = svgbob::Settings {
        font_family: "JetBrains Mono, monospace".into(),
        fill_color: "currentColor".into(),
        stroke_color: "currentColor".into(),
        background: "transparent".into(),
        include_backdrop: false,
        ..Default::default()
    };
    Ok(svgbob::to_svg_with_settings(&src, &settings))
}

#[tauri::command]
pub async fn render_svgbob(source: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || render_svgbob_blocking(source))
        .await
        .map_err(|e| format!("Render task failed: {e}"))?
}

/// Report which external renderers are available (for UI hints).
#[tauri::command]
pub fn diagram_capabilities() -> serde_json::Value {
    serde_json::json!({
        "plantuml": locate_plantuml().is_some(),
        "d2": env_override("ARTFULTYPE_D2").or_else(|| find_in_path("d2")).is_some(),
        "svgbob": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svgbob_renders_box() {
        let svg = render_svgbob_blocking("+---+\n| A |--> B\n+---+".into()).unwrap();
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn svgbob_renders_unicode_box() {
        let svg = render_svgbob_blocking("┌───┐\n│ A │──▶ B\n└───┘".into()).unwrap();
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn plantuml_wraps_bare_source() {
        assert!(normalize_plantuml("A -> B").starts_with("@startuml\n"));
        assert_eq!(normalize_plantuml("@startmindmap\n* a\n@endmindmap"), "@startmindmap\n* a\n@endmindmap");
    }

    #[test]
    fn rejects_empty_and_huge() {
        assert!(check_source("   ").is_err());
        assert!(check_source(&"x".repeat(MAX_SOURCE_BYTES + 1)).is_err());
    }
}
