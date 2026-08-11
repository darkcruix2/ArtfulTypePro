use serde::{Serialize, Deserialize};
use std::fs;
use std::path::PathBuf;
use reqwest::blocking::Client;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct NextcloudConfig {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct NextcloudEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

pub fn get_config_dir() -> PathBuf {
    if let Some(dir) = dirs_next() {
        return dir;
    }
    PathBuf::from(".config/artfultype")
}

fn dirs_next() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".config").join("artfultype");
        let _ = fs::create_dir_all(&p);
        return Some(p);
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(profile).join(".config").join("artfultype");
        let _ = fs::create_dir_all(&p);
        return Some(p);
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = PathBuf::from(appdata).join("artfultype");
        let _ = fs::create_dir_all(&p);
        return Some(p);
    }
    None
}

pub fn get_config_path() -> PathBuf {
    get_config_dir().join("nextcloud.json")
}

pub fn load_config() -> Option<NextcloudConfig> {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str::<NextcloudConfig>(&content) {
                return Some(config);
            }
        }
    }
    None
}

pub fn save_config(config: &NextcloudConfig) -> Result<(), String> {
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn unlink_config() -> Result<(), String> {
    let path = get_config_path();
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CliSettings {
    pub theme: String,
    pub word_wrap: bool,
    pub view_mode: String,
    #[serde(default)]
    pub recent_nextcloud_files: Vec<(String, String)>,
    #[serde(default = "default_true")]
    pub syntax_highlighting: bool,
}

impl Default for CliSettings {
    fn default() -> Self {
        CliSettings {
            theme: "dracula".to_string(),
            word_wrap: true,
            view_mode: "writer".to_string(),
            recent_nextcloud_files: Vec::new(),
            syntax_highlighting: true,
        }
    }
}

pub fn get_cli_settings_path() -> PathBuf {
    get_config_dir().join("cli_settings.json")
}

pub fn load_cli_settings() -> CliSettings {
    let path = get_cli_settings_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(settings) = serde_json::from_str::<CliSettings>(&content) {
                return settings;
            }
        }
    }
    CliSettings::default()
}

pub fn save_cli_settings(settings: &CliSettings) -> Result<(), String> {
    let path = get_cli_settings_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn build_webdav_base_url(config: &NextcloudConfig) -> String {
    let mut server = config.server_url.trim().to_string();
    if server.ends_with('/') {
        server.pop();
    }
    if !server.starts_with("http://") && !server.starts_with("https://") {
        server = format!("https://{server}");
    }
    format!("{server}/remote.php/dav/files/{}/", config.username.trim())
}

pub fn build_webdav_url(config: &NextcloudConfig, relative_path: &str) -> String {
    let base = build_webdav_base_url(config);
    let rel = relative_path.trim_start_matches('/');
    if rel.is_empty() {
        base
    } else {
        format!("{base}{rel}")
    }
}

fn create_webdav_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

pub fn test_connection(config: &NextcloudConfig) -> Result<String, String> {
    if config.server_url.trim().is_empty() || config.username.trim().is_empty() {
        return Err("Server URL and Username are required".to_string());
    }

    let client = create_webdav_client()?;
    let url = build_webdav_base_url(config);

    let res = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .basic_auth(&config.username, Some(&config.password))
        .header("Depth", "0")
        .send()
        .map_err(|e| format!("Connection failed: {e}"))?;

    let status = res.status();
    if status.is_success() || status.as_u16() == 207 {
        Ok(format!("Connected successfully to {}", config.server_url))
    } else if status.as_u16() == 401 {
        Err("Authentication failed: Invalid username or app password".to_string())
    } else {
        Err(format!("Server returned HTTP status {}", status))
    }
}

pub fn list_folder(config: &NextcloudConfig, relative_path: &str) -> Result<Vec<NextcloudEntry>, String> {
    let client = create_webdav_client()?;
    let url = build_webdav_url(config, relative_path);

    let res = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .basic_auth(&config.username, Some(&config.password))
        .header("Depth", "1")
        .header("Content-Type", "application/xml")
        .send()
        .map_err(|e| format!("Failed to list folder: {e}"))?;

    let status = res.status();
    if !status.is_success() && status.as_u16() != 207 {
        return Err(format!("HTTP error {status} listing folder {relative_path}"));
    }

    let xml_body = res.text().map_err(|e| format!("Failed to read response body: {e}"))?;
    parse_webdav_propfind_xml(&xml_body, relative_path, &config.username)
}

fn parse_webdav_propfind_xml(xml: &str, current_rel_path: &str, username: &str) -> Result<Vec<NextcloudEntry>, String> {
    let mut entries = Vec::new();
    let current_clean = current_rel_path.trim_matches('/');

    let lower_xml = xml.to_lowercase();
    let response_tag = if lower_xml.contains("<d:response") {
        "<d:response"
    } else if lower_xml.contains("<response") {
        "<response"
    } else {
        "<response"
    };

    let mut block_starts = Vec::new();
    let mut search_idx = 0;
    while let Some(idx) = lower_xml[search_idx..].find(response_tag) {
        let abs_idx = search_idx + idx;
        block_starts.push(abs_idx);
        search_idx = abs_idx + response_tag.len();
    }

    let mut blocks = Vec::new();
    for i in 0..block_starts.len() {
        let start = block_starts[i];
        let end = if i + 1 < block_starts.len() { block_starts[i + 1] } else { xml.len() };
        blocks.push(&xml[start..end]);
    }

    let user_pattern = format!("/remote.php/dav/files/{}/", username.trim());
    let user_pattern_lower = user_pattern.to_lowercase();

    for block in blocks {
        let href = extract_tag_value(block, "href")
            .unwrap_or_default();
        
        if href.is_empty() {
            continue;
        }

        let decoded_href = urlencoding_decode(&href);
        let href_lower = decoded_href.to_lowercase();
        
        let rel_path = if let Some(idx) = href_lower.find(&user_pattern_lower) {
            decoded_href[idx + user_pattern_lower.len()..].trim_matches('/').to_string()
        } else if let Some(idx) = href_lower.find("/remote.php/dav/files/") {
            let after_files = &decoded_href[idx + 22..];
            if let Some(slash_idx) = after_files.find('/') {
                after_files[slash_idx + 1..].trim_matches('/').to_string()
            } else {
                after_files.trim_matches('/').to_string()
            }
        } else {
            decoded_href.trim_matches('/').to_string()
        };

        if rel_path == current_clean || (current_clean.is_empty() && rel_path.is_empty()) {
            continue;
        }

        let block_lower = block.to_lowercase();
        let is_dir = block_lower.contains("collection");
        
        let name = if let Some(dn) = extract_tag_value(block, "displayname") {
            dn
        } else {
            rel_path.split('/').last().unwrap_or(&rel_path).to_string()
        };

        if name.is_empty() {
            continue;
        }

        let size_str = extract_tag_value(block, "getcontentlength")
            .unwrap_or_else(|| "0".to_string());
        let size = size_str.parse::<u64>().unwrap_or(0);

        let modified = extract_tag_value(block, "getlastmodified")
            .unwrap_or_default();

        entries.push(NextcloudEntry {
            name,
            path: rel_path,
            is_dir,
            size,
            modified,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

fn extract_tag_value(xml_chunk: &str, tag_name: &str) -> Option<String> {
    let lower_chunk = xml_chunk.to_lowercase();
    let lower_tag = tag_name.to_lowercase();

    let search_patterns = vec![
        format!("<{lower_tag}>"),
        format!("<d:{lower_tag}>"),
        format!("<{lower_tag} "),
        format!("<d:{lower_tag} "),
    ];

    for pat in search_patterns {
        if let Some(start_idx) = lower_chunk.find(&pat) {
            let content_start_search = xml_chunk[start_idx..].find('>')?;
            let content_start = start_idx + content_start_search + 1;
            
            let close_patterns = vec![
                format!("</{lower_tag}>"),
                format!("</d:{lower_tag}>"),
            ];

            for close_pat in close_patterns {
                if let Some(end_idx) = lower_chunk[content_start..].find(&close_pat) {
                    return Some(xml_chunk[content_start..content_start + end_idx].trim().to_string());
                }
            }
        }
    }
    None
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let hex = format!("{h1}{h2}");
                if let Ok(b) = u8::from_str_radix(&hex, 16) {
                    result.push(b as char);
                    continue;
                }
            }
        }
        result.push(c);
    }
    result
}

pub fn read_file(config: &NextcloudConfig, relative_path: &str) -> Result<String, String> {
    let client = create_webdav_client()?;
    let url = build_webdav_url(config, relative_path);

    let res = client
        .get(&url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .map_err(|e| format!("Failed to fetch remote file: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP error {} reading file {}", res.status(), relative_path));
    }

    res.text().map_err(|e| format!("Failed to read file content: {e}"))
}

pub fn write_file(config: &NextcloudConfig, relative_path: &str, content: &str) -> Result<(), String> {
    let client = create_webdav_client()?;
    let url = build_webdav_url(config, relative_path);

    let res = client
        .put(&url)
        .basic_auth(&config.username, Some(&config.password))
        .header("Content-Type", "text/markdown; charset=utf-8")
        .body(content.to_string())
        .send()
        .map_err(|e| format!("Failed to save remote file: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP error {} saving file {}", res.status(), relative_path));
    }

    Ok(())
}

pub fn delete_entry(config: &NextcloudConfig, relative_path: &str) -> Result<(), String> {
    let client = create_webdav_client()?;
    let url = build_webdav_url(config, relative_path);

    let res = client
        .delete(&url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .map_err(|e| format!("Failed to delete remote item: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP error {} deleting {}", res.status(), relative_path));
    }

    Ok(())
}

pub fn create_folder(config: &NextcloudConfig, relative_path: &str) -> Result<(), String> {
    let client = create_webdav_client()?;
    let url = build_webdav_url(config, relative_path);

    let res = client
        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .map_err(|e| format!("Failed to create remote directory: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP error {} creating directory {}", res.status(), relative_path));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_webdav_url_building() {
        let config = NextcloudConfig {
            server_url: "https://cloud.example.com/".to_string(),
            username: "testuser".to_string(),
            password: "secret".to_string(),
            enabled: true,
        };

        assert_eq!(
            build_webdav_base_url(&config),
            "https://cloud.example.com/remote.php/dav/files/testuser/"
        );

        assert_eq!(
            build_webdav_url(&config, "Documents/Notes.md"),
            "https://cloud.example.com/remote.php/dav/files/testuser/Documents/Notes.md"
        );
    }

    #[test]
    fn test_xml_propfind_parsing() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/testuser/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/testuser/Notes/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Notes</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/testuser/todo.md</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>todo.md</d:displayname>
        <d:getcontentlength>128</d:getcontentlength>
        <d:resourcetype/>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

        let entries = parse_webdav_propfind_xml(xml, "", "testuser").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "Notes");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, "todo.md");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].size, 128);
    }
}
