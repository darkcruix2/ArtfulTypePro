use std::fs::File;
use std::io::{Read, Write};
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

const GITHUB_API_LATEST_RELEASE: &str =
    "https://api.github.com/repos/darkcruix2/ArtfulTypePro/releases/latest";
const USER_AGENT: &str = "ArtfulTypePro-Updater";

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct GithubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    #[serde(default)]
    content_type: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    html_url: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_name: String,
    pub release_notes: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size: Option<u64>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct UpdateProgressPayload {
    pub percent: u32,
    pub downloaded: u64,
    pub total: u64,
    pub stage: String,
    pub message: String,
}

pub fn parse_semver(ver: &str) -> Option<(u32, u32, u32)> {
    let clean = ver.trim().trim_start_matches('v').trim_start_matches('V');
    let base = clean.split('-').next().unwrap_or(clean);
    let parts: Vec<&str> = base.split('.').collect();
    if parts.len() >= 2 {
        let major = parts[0].parse::<u32>().ok()?;
        let minor = parts[1].parse::<u32>().ok()?;
        let patch = if parts.len() >= 3 {
            parts[2].parse::<u32>().unwrap_or(0)
        } else {
            0
        };
        Some((major, minor, patch))
    } else {
        None
    }
}

pub fn is_newer_version(latest_str: &str, current_str: &str) -> bool {
    match (parse_semver(latest_str), parse_semver(current_str)) {
        (Some((l_maj, l_min, l_pat)), Some((c_maj, c_min, c_pat))) => {
            (l_maj, l_min, l_pat) > (c_maj, c_min, c_pat)
        }
        _ => {
            // Fallback string inequality check
            latest_str.trim().trim_start_matches('v') != current_str.trim().trim_start_matches('v')
        }
    }
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

        let resp = client
            .get(GITHUB_API_LATEST_RELEASE)
            .send()
            .map_err(|e| format!("Could not connect to GitHub Releases: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "GitHub API returned error: HTTP {}",
                resp.status()
            ));
        }

        let release: GithubRelease = resp
            .json()
            .map_err(|e| format!("Failed to parse GitHub release data: {e}"))?;

        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let latest_tag = release.tag_name.clone();
        let clean_latest = latest_tag.trim_start_matches('v').to_string();

        let update_available = is_newer_version(&clean_latest, &current_version);

        // Detect system architecture to match the appropriate deb package
        let arch = std::env::consts::ARCH; // "x86_64" or "aarch64"
        let arch_keyword = match arch {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            _ => "amd64",
        };

        // Find GUI deb package matching architecture
        let matching_asset = release.assets.iter().find(|asset| {
            let name = asset.name.to_lowercase();
            name.starts_with("artfultype-rs")
                && name.ends_with(".deb")
                && name.contains(arch_keyword)
        }).or_else(|| {
            // Fallback: any artfultype-rs deb
            release.assets.iter().find(|asset| {
                let name = asset.name.to_lowercase();
                name.starts_with("artfultype-rs") && name.ends_with(".deb")
            })
        });

        let download_url = matching_asset.map(|a| a.browser_download_url.clone());
        let asset_name = matching_asset.map(|a| a.name.clone());
        let asset_size = matching_asset.map(|a| a.size);

        Ok(UpdateCheckResult {
            update_available,
            current_version,
            latest_version: clean_latest,
            release_name: release.name.unwrap_or(latest_tag),
            release_notes: release.body.unwrap_or_default(),
            download_url,
            asset_name,
            asset_size,
            release_url: release.html_url,
            published_at: release.published_at,
        })
    })
    .await
    .map_err(|e| format!("Task execution failed: {e}"))?
}

#[tauri::command]
pub async fn download_and_install_update(
    app_handle: tauri::AppHandle,
    download_url: String,
    _asset_name: String,
) -> Result<String, String> {
    // Security check: ensure URL is from GitHub Releases for ArtfulTypePro
    if !download_url.starts_with("https://github.com/darkcruix2/ArtfulTypePro/releases/download/")
        && !download_url.starts_with("https://objects.githubusercontent.com/")
    {
        return Err("Security validation failed: download URL is not from trusted repository".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

        // 1. Initial stage notification
        let _ = app_handle.emit(
            "update-progress",
            UpdateProgressPayload {
                percent: 0,
                downloaded: 0,
                total: 0,
                stage: "downloading".to_string(),
                message: "Connecting to GitHub...".to_string(),
            },
        );

        let mut resp = client
            .get(&download_url)
            .send()
            .map_err(|e| format!("Failed to start package download: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Download failed: HTTP {}", resp.status()));
        }

        let total_size = resp.content_length().unwrap_or(0);
        let dest_path = "/tmp/artfultype-update.deb";

        let mut dest_file = File::create(dest_path)
            .map_err(|e| format!("Failed to create temporary destination file: {e}"))?;

        let mut downloaded: u64 = 0;
        let mut buffer = [0u8; 65536]; // 64KB buffer
        let mut last_emit_percent = 0;

        loop {
            let bytes_read = resp
                .read(&mut buffer)
                .map_err(|e| format!("Error during package download: {e}"))?;

            if bytes_read == 0 {
                break;
            }

            dest_file
                .write_all(&buffer[..bytes_read])
                .map_err(|e| format!("Error writing package to disk: {e}"))?;

            downloaded += bytes_read as u64;

            let percent = if total_size > 0 {
                ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u32
            } else {
                50
            };

            // Emit update if percent changed or at completion
            if percent != last_emit_percent || downloaded == total_size {
                last_emit_percent = percent;
                let _ = app_handle.emit(
                    "update-progress",
                    UpdateProgressPayload {
                        percent,
                        downloaded,
                        total: total_size,
                        stage: "downloading".to_string(),
                        message: format!("Downloading: {}% ({:.1} MB)", percent, downloaded as f64 / 1_048_576.0),
                    },
                );
            }
        }

        dest_file.flush().map_err(|e| format!("Failed to flush written file: {e}"))?;

        // 2. Installation Stage
        let _ = app_handle.emit(
            "update-progress",
            UpdateProgressPayload {
                percent: 100,
                downloaded,
                total: total_size,
                stage: "installing".to_string(),
                message: "Installing package...".to_string(),
            },
        );

        // Attempt installation:
        // Try A: Non-interactive sudo (works seamlessly if user has NOPASSWD or cached credential)
        let sudo_res = Command::new("sudo")
            .args(["-n", "dpkg", "-i", dest_path])
            .output();

        if let Ok(output) = sudo_res {
            if output.status.success() {
                let _ = app_handle.emit(
                    "update-progress",
                    UpdateProgressPayload {
                        percent: 100,
                        downloaded,
                        total: total_size,
                        stage: "done".to_string(),
                        message: "Installation successful! Restart ArtfulType Pro to apply.".to_string(),
                    },
                );
                return Ok("Update installed successfully via sudo".to_string());
            }
        }

        // Try B: pkexec (Polkit graphical root authentication prompt)
        let pkexec_res = Command::new("pkexec")
            .args(["dpkg", "-i", dest_path])
            .output();

        if let Ok(output) = pkexec_res {
            if output.status.success() {
                let _ = app_handle.emit(
                    "update-progress",
                    UpdateProgressPayload {
                        percent: 100,
                        downloaded,
                        total: total_size,
                        stage: "done".to_string(),
                        message: "Installation successful! Restart ArtfulType Pro to apply.".to_string(),
                    },
                );
                return Ok("Update installed successfully via pkexec".to_string());
            }
        }

        // Try C: xdg-open to open in system package installer (GDebi / Software Center)
        let xdg_res = Command::new("xdg-open")
            .arg(dest_path)
            .spawn();

        if xdg_res.is_ok() {
            let _ = app_handle.emit(
                "update-progress",
                UpdateProgressPayload {
                    percent: 100,
                    downloaded,
                    total: total_size,
                    stage: "done".to_string(),
                    message: "Package downloaded to /tmp/artfultype-update.deb and opened in Software Installer. Click Install in the installer window.".to_string(),
                },
            );
            return Ok("Opened package in system installer".to_string());
        }

        Err("Package downloaded to /tmp/artfultype-update.deb. Please run 'sudo dpkg -i /tmp/artfultype-update.deb' in your terminal.".to_string())
    })
    .await
    .map_err(|e| format!("Task execution failed: {e}"))?
}

#[tauri::command]
pub fn restart_app(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_semver() {
        assert_eq!(parse_semver("v0.30.13"), Some((0, 30, 13)));
        assert_eq!(parse_semver("0.30.14"), Some((0, 30, 14)));
        assert_eq!(parse_semver("v1.2.3-rc.1"), Some((1, 2, 3)));
        assert_eq!(parse_semver("2.0"), Some((2, 0, 0)));
        assert_eq!(parse_semver("invalid"), None);
    }

    #[test]
    fn test_is_newer_version() {
        assert!(is_newer_version("0.30.14", "0.30.13"));
        assert!(is_newer_version("v0.30.14", "0.30.13"));
        assert!(is_newer_version("0.31.0", "0.30.13"));
        assert!(is_newer_version("1.0.0", "0.30.13"));
        assert!(!is_newer_version("0.30.13", "0.30.13"));
        assert!(!is_newer_version("0.30.12", "0.30.13"));
        assert!(!is_newer_version("0.29.99", "0.30.13"));
    }

    #[tokio::test]
    async fn test_check_for_updates_live() {
        let res = check_for_updates().await;
        assert!(res.is_ok(), "check_for_updates failed: {:?}", res.err());
        let info = res.unwrap();
        assert_eq!(info.latest_version, "0.30.13");
        assert!(info.download_url.is_some(), "Expected download URL for current architecture");
    }
}


