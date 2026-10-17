pub mod nextcloud;
pub mod diagrams;
pub mod updater;
// Prevents additional console window on Windows in release, DO NOT REMOVE!!

use pulldown_cmark::{html, CodeBlockKind, Event, MetadataBlockKind, Options, Parser, Tag, TagEnd};
use std::fs;
use std::path::Path;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Serialize, Deserialize};
use tauri::Manager;

#[cfg(not(target_os = "android"))]
use rfd::AsyncFileDialog;

fn preprocess_mmd_metadata(input: &str) -> (Option<String>, &str) {
    // If input already starts with YAML/TOML frontmatter ("---" or "+++"), leave it for pulldown-cmark
    let trimmed = input.trim_start();
    if trimmed.starts_with("---") || trimmed.starts_with("+++") {
        return (None, input);
    }

    // Check if input begins with MultiMarkdown key-value lines followed by a blank line
    let mut lines = input.lines();
    let mut mmd_lines = Vec::new();
    let mut is_mmd = false;

    // First line must match `^[A-Za-z0-9_-]+:\s*.*$`
    if let Some(first_line) = lines.next() {
        if let Some(colon_pos) = first_line.find(':') {
            let key = &first_line[..colon_pos].trim();
            if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                mmd_lines.push(first_line);
                let mut valid = true;
                let mut consumed_bytes = first_line.len() + if input.starts_with(&format!("{first_line}\r\n")) { 2 } else { 1 };

                for line in lines {
                    if line.trim().is_empty() {
                        // End of MMD metadata header
                        is_mmd = true;
                        consumed_bytes += line.len() + 1;
                        break;
                    }
                    if line.starts_with(" ") || line.starts_with("\t") || line.contains(':') {
                        mmd_lines.push(line);
                        consumed_bytes += line.len() + 1;
                    } else {
                        valid = false;
                        break;
                    }
                }
                if is_mmd && valid && !mmd_lines.is_empty() {
                    let mmd_content = mmd_lines.join("\n");
                    let rest = if consumed_bytes <= input.len() { &input[consumed_bytes..] } else { "" };
                    return (Some(mmd_content), rest);
                }
            }
        }
    }

    (None, input)
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn preprocess_json_frontmatter(input: &str) -> (Option<String>, &str) {
    let trimmed = input.trim_start();
    if trimmed.starts_with(";;;") {
        let after = &trimmed[3..];
        let after_trimmed = after.trim_start_matches(|c: char| c == '\r' || c == '\n');
        if let Some(pos) = after_trimmed.find(";;;") {
            let json_body = after_trimmed[..pos].trim();
            let mut rest = &after_trimmed[pos + 3..];
            if rest.starts_with('\r') { rest = &rest[1..]; }
            if rest.starts_with('\n') { rest = &rest[1..]; }
            return (Some(json_body.to_string()), rest);
        }
    }
    (None, input)
}

fn preprocess_inline_footnotes(input: &str) -> String {
    if !input.contains("^[") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut footnotes = Vec::new();
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut count = 0;

    while i < len {
        if i + 1 < len && bytes[i] == b'^' && bytes[i + 1] == b'[' {
            let start = i + 2;
            let mut depth = 1;
            let mut j = start;
            while j < len && depth > 0 {
                if bytes[j] == b'[' {
                    depth += 1;
                } else if bytes[j] == b']' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if depth == 0 {
                count += 1;
                let fn_text = &input[start..j];
                let label = format!("_inline_fn_{count}");
                out.push_str(&format!("[^{label}]"));
                footnotes.push((label, fn_text.to_string()));
                i = j + 1;
                continue;
            }
        }
        if let Some(ch) = input[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }

    if !footnotes.is_empty() {
        out.push_str("\n\n");
        for (label, text) in footnotes {
            out.push_str(&format!("[^{label}]: {text}\n"));
        }
    }
    out
}

fn preprocess_fenced_divs(input: &str) -> String {
    let mut out = Vec::new();
    let mut in_code = false;

    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            out.push(line.to_string());
            continue;
        }
        if !in_code && trimmed.starts_with(":::") {
            let after = trimmed[3..].trim();
            if after.is_empty() {
                out.push("</div>\n".to_string());
            } else {
                let clean = after.trim_start_matches('{').trim_end_matches('}').trim();
                let class_name = clean.split_whitespace().next().unwrap_or("div").trim_start_matches('.');
                out.push(format!("<div class=\"fenced-div fenced-div-{class_name}\" data-fenced-class=\"{class_name}\">\n"));
            }
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

fn preprocess_critic_markup(input: &str) -> String {
    if !input.contains("{+") && !input.contains("{-") && !input.contains("{~") && !input.contains("{=") && !input.contains("{>") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut in_code = false;

    while i < len {
        let rem = &input[i..];
        if rem.starts_with("```") || rem.starts_with("~~~") {
            in_code = !in_code;
            let fence = if rem.starts_with("```") { "```" } else { "~~~" };
            out.push_str(fence);
            i += 3;
            continue;
        }
        if in_code {
            if let Some(ch) = rem.chars().next() {
                out.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
            continue;
        }

        // {++add++}
        if rem.starts_with("{++") {
            if let Some(close) = rem[3..].find("++}") {
                let inner = &rem[3..3 + close];
                out.push_str(&format!("<ins class=\"critic critic-add\">{}</ins>", escape_html(inner)));
                i += 3 + close + 3;
                continue;
            }
        }

        // {--del--}
        if rem.starts_with("{--") {
            if let Some(close) = rem[3..].find("--}") {
                let inner = &rem[3..3 + close];
                out.push_str(&format!("<del class=\"critic critic-del\">{}</del>", escape_html(inner)));
                i += 3 + close + 3;
                continue;
            }
        }

        // {==highlight==}
        if rem.starts_with("{==") {
            if let Some(close) = rem[3..].find("==}") {
                let inner = &rem[3..3 + close];
                out.push_str(&format!("<mark class=\"critic critic-highlight\">{}</mark>", escape_html(inner)));
                i += 3 + close + 3;
                continue;
            }
        }

        // {>>comment<<}
        if rem.starts_with("{>>") {
            if let Some(close) = rem[3..].find("<<}") {
                let inner = &rem[3..3 + close];
                let esc = escape_html(inner);
                out.push_str(&format!("<span class=\"critic critic-comment\" data-comment-text=\"{esc}\" title=\"CriticMarkup Comment\"><span class=\"critic-icon\">💬</span> {esc}</span>"));
                i += 3 + close + 3;
                continue;
            }
        }

        // {~~old~>new~~}
        if rem.starts_with("{~~") {
            if let Some(close) = rem[3..].find("~~}") {
                let inner = &rem[3..3 + close];
                if let Some(arrow) = inner.find("~>") {
                    let old_text = &inner[..arrow];
                    let new_text = &inner[arrow + 2..];
                    out.push_str(&format!("<span class=\"critic critic-sub\"><del class=\"critic-old\">{}</del><ins class=\"critic-new\">{}</ins></span>", escape_html(old_text), escape_html(new_text)));
                    i += 3 + close + 3;
                    continue;
                }
            }
        }

        if let Some(ch) = rem.chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }

    out
}


fn postprocess_pkm(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    let bytes = html.as_bytes();
    let len = bytes.len();
    let mut in_tag = false;
    let mut in_pre_code = false;

    while i < len {
        if bytes[i] == b'<' {
            let rem = &html[i..];
            if rem.starts_with("<pre") || rem.starts_with("<code") {
                in_pre_code = true;
            } else if rem.starts_with("</pre>") || rem.starts_with("</code>") {
                in_pre_code = false;
            }
            in_tag = true;
            out.push('<');
            i += 1;
            continue;
        }
        if bytes[i] == b'>' && in_tag {
            in_tag = false;
            out.push('>');
            i += 1;
            continue;
        }
        if in_tag || in_pre_code {
            if let Some(ch) = html[i..].chars().next() {
                out.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
            continue;
        }

        // ==highlight==
        if i + 3 < len && bytes[i] == b'=' && bytes[i + 1] == b'=' {
            if let Some(close) = html[i + 2..].find("==") {
                let inner = &html[i + 2..i + 2 + close];
                if !inner.contains('\n') && !inner.is_empty() {
                    out.push_str("<mark class=\"pkm-highlight\">");
                    out.push_str(inner);
                    out.push_str("</mark>");
                    i = i + 2 + close + 2;
                    continue;
                }
            }
        }

        // ![[Embed]]
        if i + 4 < len && bytes[i] == b'!' && bytes[i + 1] == b'[' && bytes[i + 2] == b'[' {
            if let Some(close) = html[i + 3..].find("]]") {
                let inner = &html[i + 3..i + 3 + close];
                if !inner.contains('\n') && !inner.is_empty() {
                    let (target, _opt) = if let Some(pipe) = inner.find('|') {
                        (&inner[..pipe], Some(&inner[pipe + 1..]))
                    } else {
                        (inner, None)
                    };
                    let target_clean = target.trim();
                    let lower = target_clean.to_lowercase();
                    if lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")
                        || lower.ends_with(".gif") || lower.ends_with(".svg") || lower.ends_with(".webp")
                    {
                        let esc_target = escape_html(target_clean);
                        out.push_str(&format!("<img class=\"transclusion-image\" src=\"{esc_target}\" alt=\"{esc_target}\" />"));
                    } else {
                        let esc_target = escape_html(target_clean);
                        out.push_str(&format!(
                            "<div class=\"transclusion-card\" data-transclude=\"{esc_target}\"><div class=\"transclusion-header\"><span class=\"transclusion-badge\">Transclusion</span><span class=\"transclusion-title\">📄 {esc_target}</span></div><div class=\"transclusion-content\">Embedded note: <em>{esc_target}</em></div></div>"
                        ));
                    }
                    i = i + 3 + close + 2;
                    continue;
                }
            }
        }

        // [[Target|Alias]] or [[Target]]
        if i + 3 < len && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = html[i + 2..].find("]]") {
                let inner = &html[i + 2..i + 2 + close];
                if !inner.contains('\n') && !inner.is_empty() {
                    let (target, label) = if let Some(pipe) = inner.find('|') {
                        (&inner[..pipe], &inner[pipe + 1..])
                    } else {
                        (inner, inner)
                    };
                    let esc_target = escape_html(target.trim());
                    let esc_label = escape_html(label.trim());
                    out.push_str(&format!(
                        "<a class=\"wikilink\" data-wikilink=\"{esc_target}\" href=\"#note:{esc_target}\"><span class=\"wikilink-icon\">📄</span> <span class=\"wikilink-label\">{esc_label}</span></a>"
                    ));
                    i = i + 2 + close + 2;
                    continue;
                }
            }
        }

        if let Some(ch) = html[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn postprocess_pandoc_spans_and_citations(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    let bytes = html.as_bytes();
    let len = bytes.len();
    let mut in_tag = false;
    let mut in_pre_code = false;

    while i < len {
        if bytes[i] == b'<' {
            let rem = &html[i..];
            if rem.starts_with("<pre") || rem.starts_with("<code") {
                in_pre_code = true;
            } else if rem.starts_with("</pre>") || rem.starts_with("</code>") {
                in_pre_code = false;
            }
            in_tag = true;
            out.push('<');
            i += 1;
            continue;
        }
        if bytes[i] == b'>' && in_tag {
            in_tag = false;
            out.push('>');
            i += 1;
            continue;
        }
        if in_tag || in_pre_code {
            if let Some(ch) = html[i..].chars().next() {
                out.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
            continue;
        }

        // Bracketed spans: [text]{.class #id}
        if bytes[i] == b'[' {
            if let Some(close_bracket) = html[i + 1..].find(']') {
                let bracket_end = i + 1 + close_bracket;
                if bracket_end + 1 < len && bytes[bracket_end + 1] == b'{' {
                    if let Some(close_brace) = html[bracket_end + 2..].find('}') {
                        let brace_end = bracket_end + 2 + close_brace;
                        let text = &html[i + 1..bracket_end];
                        let attr_str = &html[bracket_end + 2..brace_end].trim();
                        if !text.contains('\n') && !attr_str.contains('\n') {
                            let mut classes = Vec::new();
                            let mut id_attr = String::new();
                            for part in attr_str.split_whitespace() {
                                if let Some(cls) = part.strip_prefix('.') {
                                    classes.push(cls);
                                } else if let Some(id) = part.strip_prefix('#') {
                                    id_attr = format!(" id=\"{}\"", escape_html(id));
                                }
                            }
                            let class_attr = if classes.is_empty() {
                                "pandoc-span".to_string()
                            } else {
                                format!("pandoc-span {}", classes.join(" "))
                            };
                            out.push_str(&format!("<span class=\"{}\"{id_attr}>{}</span>", class_attr, text));
                            i = brace_end + 1;
                            continue;
                        }
                    }
                }
            }
        }

        // Bracketed citation: [@smith2024]
        if bytes[i] == b'[' && i + 1 < len && bytes[i + 1] == b'@' {
            if let Some(close) = html[i + 2..].find(']') {
                let inner = &html[i + 1..i + 2 + close];
                if !inner.contains('\n') {
                    let esc = escape_html(inner);
                    out.push_str(&format!("<cite class=\"citation citation-pandoc\" data-cite=\"{esc}\">[{esc}]</cite>"));
                    i = i + 2 + close + 1;
                    continue;
                }
            }
        }

        // In-text citation: @smith2024
        if bytes[i] == b'@' && (i == 0 || bytes[i - 1].is_ascii_whitespace() || bytes[i - 1] == b'(') {
            let mut j = i + 1;
            while j < len && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-' || bytes[j] == b':') {
                j += 1;
            }
            if j > i + 1 {
                let key = &html[i + 1..j];
                let esc = escape_html(key);
                out.push_str(&format!("<cite class=\"citation citation-pandoc\" data-cite=\"@{esc}\">@{esc}</cite>"));
                i = j;
                continue;
            }
        }

        if let Some(ch) = html[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn sanitize_html(html: &str) -> String {
    let dangerous = ["script", "iframe", "object", "embed", "applet", "form"];
    let mut s = html.to_string();
    for tag in dangerous {
        let open_pat = format!("<{}", tag);
        while let Some(start) = s.to_lowercase().find(&open_pat) {
            if let Some(end) = s[start..].find('>') {
                s.replace_range(start..start + end + 1, "");
            } else {
                break;
            }
        }
        let close_pat = format!("</{}", tag);
        while let Some(start) = s.to_lowercase().find(&close_pat) {
            if let Some(end) = s[start..].find('>') {
                s.replace_range(start..start + end + 1, "");
            } else {
                break;
            }
        }
    }
    s = s.replace("javascript:", "blocked:");
    let mut clean = String::with_capacity(s.len());
    let mut in_tag = false;
    let mut tag_buf = String::new();

    for ch in s.chars() {
        if ch == '<' {
            in_tag = true;
            tag_buf.clear();
            tag_buf.push('<');
        } else if ch == '>' && in_tag {
            tag_buf.push('>');
            in_tag = false;
            let mut cleaned_tag = String::new();
            let mut parts = tag_buf.split_whitespace();
            if let Some(first) = parts.next() {
                cleaned_tag.push_str(first);
                for attr in parts {
                    let lower = attr.to_lowercase();
                    if lower.starts_with("on") && (lower.contains('=') || lower.ends_with('>')) {
                        if attr.ends_with('>') {
                            cleaned_tag.push('>');
                        }
                    } else {
                        cleaned_tag.push(' ');
                        cleaned_tag.push_str(attr);
                    }
                }
            }
            clean.push_str(&cleaned_tag);
        } else if in_tag {
            tag_buf.push(ch);
        } else {
            clean.push(ch);
        }
    }
    clean
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkdownCompat {
    #[serde(default = "default_true")]
    pub commonmark: bool,
    #[serde(default = "default_true")]
    pub gfm: bool,
    #[serde(default = "default_true")]
    pub pkm: bool,
    #[serde(default = "default_true")]
    pub pandoc: bool,
    #[serde(default = "default_true")]
    pub markdown_extra: bool,
    #[serde(default = "default_true")]
    pub multimarkdown: bool,
    #[serde(default = "default_true")]
    pub rmarkdown: bool,
    #[serde(default = "default_true")]
    pub frontmatter: bool,
    #[serde(default = "default_true")]
    pub smart_typography: bool,
    #[serde(default = "default_true")]
    pub html_passthrough: bool,
}

fn default_true() -> bool {
    true
}

impl Default for MarkdownCompat {
    fn default() -> Self {
        Self {
            commonmark: true,
            gfm: true,
            pkm: true,
            pandoc: true,
            markdown_extra: true,
            multimarkdown: true,
            rmarkdown: true,
            frontmatter: true,
            smart_typography: true,
            html_passthrough: true,
        }
    }
}

#[tauri::command]
fn parse_markdown(text: &str, compat: Option<MarkdownCompat>) -> String {
    let compat = compat.unwrap_or_default();

    // Check if any extension is selected
    let has_any_extension = compat.gfm
        || compat.pkm
        || compat.pandoc
        || compat.markdown_extra
        || compat.multimarkdown
        || compat.rmarkdown
        || compat.frontmatter
        || compat.smart_typography;

    // If commonmark is explicitly false AND no extensions are selected, fallback to plain paragraphs
    if !compat.commonmark && !has_any_extension {
        let mut out = String::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                out.push_str("<p><br></p>\n");
            } else {
                out.push_str("<p>");
                out.push_str(&escape_html(line));
                out.push_str("</p>\n");
            }
        }
        return out;
    }

    // Preprocessing pipeline
    let (json_meta, text_after_json) = if compat.frontmatter {
        preprocess_json_frontmatter(text)
    } else {
        (None, text)
    };

    let (mmd_meta, text_after_meta) = if compat.frontmatter || compat.multimarkdown {
        preprocess_mmd_metadata(text_after_json)
    } else {
        (None, text_after_json)
    };

    let text_with_footnotes = if compat.pandoc {
        preprocess_inline_footnotes(text_after_meta)
    } else {
        text_after_meta.to_string()
    };

    let text_with_divs = if compat.pandoc {
        preprocess_fenced_divs(&text_with_footnotes)
    } else {
        text_with_footnotes
    };

    let preprocessed_text = if compat.multimarkdown {
        preprocess_critic_markup(&text_with_divs)
    } else {
        text_with_divs
    };

    let mut opts = Options::empty();

    if compat.gfm {
        opts.insert(Options::ENABLE_GFM);
        opts.insert(Options::ENABLE_TABLES);
        opts.insert(Options::ENABLE_STRIKETHROUGH);
        opts.insert(Options::ENABLE_TASKLISTS);
    }

    if compat.markdown_extra {
        opts.insert(Options::ENABLE_HEADING_ATTRIBUTES);
        opts.insert(Options::ENABLE_DEFINITION_LIST);
        opts.insert(Options::ENABLE_FOOTNOTES);
    }

    if compat.multimarkdown {
        opts.insert(Options::ENABLE_MATH);
        opts.insert(Options::ENABLE_SUPERSCRIPT);
        opts.insert(Options::ENABLE_SUBSCRIPT);
        opts.insert(Options::ENABLE_FOOTNOTES);
    }

    if compat.pandoc {
        opts.insert(Options::ENABLE_FOOTNOTES);
    }

    if compat.rmarkdown {
        opts.insert(Options::ENABLE_MATH);
        opts.insert(Options::ENABLE_TABLES);
    }

    if compat.frontmatter || compat.rmarkdown {
        opts.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
        opts.insert(Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS);
    }

    if compat.smart_typography {
        opts.insert(Options::ENABLE_SMART_PUNCTUATION);
    }

    let parser = Parser::new_ext(&preprocessed_text, opts);
    let mut html_output = String::with_capacity(text.len() * 2);

    // Output JSON frontmatter block if present
    if let Some(json) = json_meta {
        html_output.push_str("<div class=\"frontmatter-block\" data-frontmatter-kind=\"json\" contenteditable=\"false\">");
        html_output.push_str("<div class=\"frontmatter-header\"><span class=\"frontmatter-badge\">JSON Frontmatter</span></div>");
        html_output.push_str("<pre class=\"frontmatter-raw\"><code class=\"language-json\">");
        html_output.push_str(&escape_html(&json));
        html_output.push_str("</code></pre></div>\n");
    }

    // Output MultiMarkdown metadata header if present
    if let Some(meta) = mmd_meta {
        html_output.push_str("<div class=\"frontmatter-block\" data-frontmatter-kind=\"mmd\" contenteditable=\"false\">");
        html_output.push_str("<div class=\"frontmatter-header\"><span class=\"frontmatter-badge\">MultiMarkdown Metadata</span></div>");
        html_output.push_str("<pre class=\"frontmatter-raw\"><code class=\"language-yaml\">");
        html_output.push_str(&escape_html(&meta));
        html_output.push_str("</code></pre></div>\n");
    }

    let mut in_metadata_block = false;
    let mut metadata_kind = "yaml";
    let mut metadata_buf = String::new();

    let mut in_custom_code_block = false;
    let mut custom_code_info = String::new();
    let mut custom_code_buf = String::new();

    let mut standard_events = Vec::new();

    for event in parser {
        match event {
            Event::Start(Tag::MetadataBlock(kind)) if compat.frontmatter || compat.rmarkdown => {
                if !standard_events.is_empty() {
                    html::push_html(&mut html_output, standard_events.drain(..));
                }
                in_metadata_block = true;
                metadata_kind = match kind {
                    MetadataBlockKind::YamlStyle => "yaml",
                    MetadataBlockKind::PlusesStyle => "toml",
                };
                metadata_buf.clear();
            }
            Event::End(TagEnd::MetadataBlock(_)) if compat.frontmatter || compat.rmarkdown => {
                in_metadata_block = false;
                let badge_label = if metadata_kind == "toml" { "TOML Metadata" } else { "YAML Metadata" };
                html_output.push_str(&format!(
                    "<div class=\"frontmatter-block\" data-frontmatter-kind=\"{metadata_kind}\" contenteditable=\"false\"><div class=\"frontmatter-header\"><span class=\"frontmatter-badge\">{badge_label}</span></div><pre class=\"frontmatter-raw\"><code class=\"language-{metadata_kind}\">{}</code></pre></div>\n",
                    escape_html(metadata_buf.trim_end())
                ));
                metadata_buf.clear();
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(ref info))) if compat.rmarkdown && (info.contains(' ') || info.starts_with('{')) => {
                if !standard_events.is_empty() {
                    html::push_html(&mut html_output, standard_events.drain(..));
                }
                in_custom_code_block = true;
                custom_code_info = info.to_string();
                custom_code_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) if in_custom_code_block => {
                in_custom_code_block = false;
                let raw_info = custom_code_info.trim();
                let clean_lang = raw_info
                    .trim_start_matches('{')
                    .trim_start_matches('.')
                    .split(|c: char| c.is_whitespace() || c == ',' || c == '#')
                    .next()
                    .unwrap_or("")
                    .to_lowercase();
                let lang_attr = if clean_lang.is_empty() { "text" } else { &clean_lang };

                html_output.push_str(&format!(
                    "<pre class=\"code-chunk\" data-code-info=\"{}\"><div class=\"code-chunk-header\" contenteditable=\"false\"><span class=\"code-chunk-badge\">{}</span><span class=\"code-chunk-options\">{}</span></div><code class=\"language-{}\">{}</code></pre>\n",
                    escape_html(raw_info),
                    escape_html(if lang_attr == "r" { "R Chunk" } else { lang_attr }),
                    escape_html(raw_info),
                    escape_html(lang_attr),
                    escape_html(&custom_code_buf)
                ));
                custom_code_info.clear();
                custom_code_buf.clear();
            }
            _ => {
                if in_metadata_block {
                    match event {
                        Event::Text(t) => metadata_buf.push_str(&t),
                        _ => {}
                    }
                } else if in_custom_code_block {
                    match event {
                        Event::Text(t) => custom_code_buf.push_str(&t),
                        _ => {}
                    }
                } else {
                    standard_events.push(event);
                }
            }
        }
    }

    if !standard_events.is_empty() {
        html::push_html(&mut html_output, standard_events.drain(..));
    }

    // Postprocessing passes
    if compat.pkm {
        html_output = postprocess_pkm(&html_output);
    }

    if compat.pandoc {
        html_output = postprocess_pandoc_spans_and_citations(&html_output);
    }

    if !compat.html_passthrough {
        html_output = sanitize_html(&html_output);
    }

    html_output
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn test_parse_markdown_extensions() {
        let input = r#"---
title: "Document Title"
author: "Author Name"
---

# Heading 1 {#custom-id .custom-class}

Term 1
: Definition 1
: Definition 1b

Inline math $E = mc^2$ and block math:
$$
\int_0^1 x^2 dx
$$

Sub ~sub~ and sup ^sup^ and ~~strike~~.

- [x] Done task
- [ ] Todo task

```{r setup, include=FALSE, echo=TRUE}
knitr::opts_chunk$set(echo = TRUE)
```
"#;
        let out = parse_markdown(input, None);
        println!("RENDERED:\n{}", out);
        assert!(out.contains("frontmatter-block"));
        assert!(out.contains("custom-id"));
        assert!(out.contains("<dl>"));
        assert!(out.contains("math-inline"));
        assert!(out.contains("code-chunk"));
        assert!(out.contains("data-code-info=\"{r setup, include=FALSE, echo=TRUE}\""));
    }

    #[test]
    fn test_parse_citations_and_criticmarkup() {
        let input = r#"
Citation MMD: [#smith2004] and [#smith2004, p. 12]
Citation RMD: [@knuth1984] and [-@knuth1984] and [@knuth1984; @smith2020]
CriticMarkup: {++added++} and {--deleted--} and {~~old~>new~~} and {>>comment<<} and {==highlight==}
Inline code: `r Sys.Date()` and `python 1+1`
"#;
        let out = parse_markdown(input, None);
        assert!(out.contains("smith2004"));
        assert!(out.contains("knuth1984"));
        assert!(out.contains("added"));
    }

    #[test]
    fn test_parse_showcase_file() {
        let showcase = include_str!("../../examples/markdown-flavors-showcase.md");
        let out = parse_markdown(showcase, None);
        assert!(out.contains("frontmatter-block"), "YAML frontmatter preserved");
        assert!(out.contains("custom-anchor"), "Markdown Extra heading id preserved");
        assert!(out.contains("<dl>"), "Definition lists preserved");
        assert!(out.contains("math-inline"), "Inline math preserved");
        assert!(out.contains("math-display"), "Display math preserved");
        assert!(out.contains("code-chunk"), "R code chunk preserved");
        assert!(out.contains("data-code-info=\"{r data-summary, echo=TRUE, eval=FALSE, fig.width=8}\""));
        assert!(out.contains("<table>"), "GFM tables preserved");
        assert!(out.contains("type=\"checkbox\""), "Task lists preserved");
    }

    #[test]
    fn test_parse_selective_compatibility() {
        let input = r#"---
title: "Doc"
---

Term 1
: Def 1

- [ ] Task

```{r test}
x <- 1
```
"#;
        // User selects ONLY CommonMark and R Markdown:
        let compat = MarkdownCompat {
            commonmark: true,
            rmarkdown: true,
            gfm: false,
            pkm: false,
            pandoc: false,
            markdown_extra: false,
            multimarkdown: false,
            frontmatter: true,
            smart_typography: false,
            html_passthrough: true,
        };
        let out = parse_markdown(input, Some(compat));
        assert!(out.contains("code-chunk"), "R chunk should be rendered");
        assert!(out.contains("frontmatter-block"), "YAML metadata should be rendered");
        assert!(!out.contains("<dl>"), "Definition lists should NOT be rendered when Extra is disabled");
        assert!(!out.contains("task-list-item"), "Task lists should NOT be rendered when GFM is disabled");
    }

    #[test]
    fn test_baseline_markdown_when_nothing_selected() {
        let input = r#"# Baseline Heading

This is **bold** and *italic*.

- List Item 1
- List Item 2

> A standard blockquote

| Col A | Col B |
|---|---|
| 1 | 2 |

- [ ] Unchecked Task

[[Wikilink Target|Alias]]

==highlighted text==

::: warning
Pandoc Container
:::

^[Inline footnote text]

$$x = y$$

"Quotes" and -- dashes and ellipsis...
"#;
        // When nothing is selected (all extensions false), it should ONLY support baseline CommonMark!
        let nothing_selected = MarkdownCompat {
            commonmark: true,
            gfm: false,
            pkm: false,
            pandoc: false,
            markdown_extra: false,
            multimarkdown: false,
            rmarkdown: false,
            frontmatter: false,
            smart_typography: false,
            html_passthrough: false,
        };

        let out = parse_markdown(input, Some(nothing_selected));

        // Baseline CommonMark constructs MUST be rendered:
        assert!(out.contains("<h1>Baseline Heading</h1>"), "Baseline heading rendered");
        assert!(out.contains("<strong>bold</strong>"), "Baseline bold rendered");
        assert!(out.contains("<em>italic</em>"), "Baseline italic rendered");
        assert!(out.contains("<li>List Item 1</li>"), "Baseline lists rendered");
        assert!(out.contains("<blockquote>"), "Baseline blockquote rendered");

        // Extensions MUST NOT be rendered:
        assert!(!out.contains("<table>"), "GFM table not rendered");
        assert!(!out.contains("type=\"checkbox\""), "GFM task list not rendered");
        assert!(!out.contains("wikilink"), "PKM wikilink not rendered");
        assert!(!out.contains("<mark"), "Highlight not rendered");
        assert!(!out.contains("fenced-div"), "Pandoc fenced div not rendered");
        assert!(!out.contains("math-display"), "Math not rendered");
        assert!(!out.contains("“Quotes”"), "Quotes remain straight, not smart");
        assert!(out.contains("\"Quotes\""), "Straight quotes preserved in baseline");
    }

    #[test]
    fn test_pkm_and_pandoc_extensions() {
        let input = r#"
[[Project Alpha|Alpha Notes]] and ![[diagram.png]]

Highlight: ==important section==

::: warning
Careful with this configuration.
:::

Pandoc span: [styled text]{.badge-danger #my-badge}

In-text @knuth1984 and bracketed [@knuth1984; @lamport1994]

Inline footnote^[This is defined directly in text].
"#;
        let compat = MarkdownCompat {
            commonmark: true,
            gfm: true,
            pkm: true,
            pandoc: true,
            markdown_extra: true,
            multimarkdown: true,
            rmarkdown: true,
            frontmatter: true,
            smart_typography: true,
            html_passthrough: true,
        };
        let out = parse_markdown(input, Some(compat));

        // PKM:
        assert!(out.contains("data-wikilink=\"Project Alpha\""), "Wikilink resolved");
        assert!(out.contains("Alpha Notes"), "Wikilink alias rendered");
        assert!(out.contains("transclusion-image"), "Image transclusion rendered");
        assert!(out.contains("<mark class=\"pkm-highlight\">important section</mark>"), "Highlight rendered");

        // Pandoc:
        assert!(out.contains("fenced-div-warning"), "Fenced div rendered");
        assert!(out.contains("pandoc-span badge-danger"), "Bracketed span class rendered");
        assert!(out.contains("id=\"my-badge\""), "Bracketed span id rendered");
        assert!(out.contains("citation citation-pandoc"), "Citations rendered");
        assert!(out.contains("footnote-definition") || out.contains("footnote-ref"), "Inline footnote converted to footnote");
    }

    #[test]
    fn test_json_frontmatter_and_smart_typography() {
        let input = r#";;;
{
  "title": "Hugo Zola Post",
  "tags": ["docs", "tutorial"]
}
;;;

# Title

"Smart quotes" and -- en-dash and --- em-dash and ...
"#;
        let compat = MarkdownCompat {
            commonmark: true,
            gfm: true,
            pkm: true,
            pandoc: true,
            markdown_extra: true,
            multimarkdown: true,
            rmarkdown: true,
            frontmatter: true,
            smart_typography: true,
            html_passthrough: true,
        };
        let out = parse_markdown(input, Some(compat));
        assert!(out.contains("data-frontmatter-kind=\"json\""), "JSON frontmatter rendered");
        assert!(out.contains("Hugo Zola Post"), "JSON frontmatter body preserved");
        assert!(out.contains("“Smart quotes”"), "Smart quotes converted");
        assert!(out.contains("–") || out.contains("—"), "Dashes converted");
        assert!(out.contains("…"), "Ellipsis converted");
    }

    #[test]
    fn test_html_sanitization() {
        let input = r#"
Safe embed: <kbd>Ctrl+S</kbd> and <details><summary>More info</summary><p>Hidden details</p></details>
Unsafe embed: <script>alert('xss')</script><iframe src="evil.com"></iframe><img src="x" onerror="alert(1)">
"#;
        let compat_sanitized = MarkdownCompat {
            commonmark: true,
            gfm: true,
            pkm: true,
            pandoc: true,
            markdown_extra: true,
            multimarkdown: true,
            rmarkdown: true,
            frontmatter: true,
            smart_typography: true,
            html_passthrough: false, // Strict sanitization ON
        };
        let out = parse_markdown(input, Some(compat_sanitized));
        assert!(out.contains("<kbd>Ctrl+S</kbd>"), "Safe <kbd> tag preserved");
        assert!(out.contains("<details>"), "Safe <details> tag preserved");
        assert!(!out.contains("<script"), "<script> tag stripped");
        assert!(!out.contains("<iframe"), "<iframe> tag stripped");
        assert!(!out.contains("onerror"), "onerror event handler stripped");
    }
}

#[derive(Serialize, Deserialize)]
struct FileData {
    path: String,
    name: String,
    content: String,
}

/// Returns the current platform so the frontend can adjust keyboard shortcuts
/// and file-dialog strategy. Values: "linux", "windows", "macos", "android"
#[tauri::command]
fn get_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "macos"
    }
}

// ── Desktop file dialogs (rfd) ────────────────────────────────────────────────

/// Opens a native file-picker dialog asynchronously (desktop only).
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn open_file_dialog() -> Option<FileData> {
    let file = AsyncFileDialog::new()
        .add_filter(
            "Text & Markdown Files",
            &[
                "md", "markdown", "txt", "text", "org", "rst", "log", "json", "yaml", "yml",
                "xml", "html", "css", "js", "ts", "rs", "py", "c", "h", "cpp", "sh", "ini",
                "cfg", "toml", "env", "csv", "tsv", "tex", "sql",
            ],
        )
        .add_filter("Image Files", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"])
        .add_filter("All Text Files", &["*"])
        .pick_file()
        .await;

    if let Some(handle) = file {
        let path = handle.path().to_path_buf();
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

/// Opens a native save dialog asynchronously (desktop only).
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn save_file_dialog(content: String, default_name: Option<String>) -> Result<Option<String>, String> {
    // Only use the final path component of the suggested name.
    let suggested = default_name
        .as_deref()
        .and_then(|n| Path::new(n.trim()).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "untitled.md".to_string());
    let file = AsyncFileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .set_file_name(&suggested)
        .save_file()
        .await;

    if let Some(handle) = file {
        let path = handle.path().to_path_buf();
        fs::write(&path, content.as_bytes())
            .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    Ok(None)
}

// Android uses the Storage Access Framework via the dialog/fs plugins instead.
#[cfg(target_os = "android")]
#[tauri::command]
async fn open_file_dialog() -> Option<FileData> {
    None
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn save_file_dialog(_content: String, _default_name: Option<String>) -> Result<Option<String>, String> {
    Err("Native save dialog is not available on Android".into())
}

// ── Shared file storage directory ─────────────────────────────────────────────

/// Returns the app-private files directory (equivalent to Context.getFilesDir() on Android).
#[tauri::command]
fn get_files_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))
}

// ── Shared file commands ──────────────────────────────────────────────────────

#[tauri::command]
fn save_file(path: &str, content: &str) -> Result<(), String> {
    // Ensure parent directories exist (needed for Android private storage paths)
    if let Some(parent) = Path::new(path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {e}"))?;
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_binary_file(path: &str, content: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {e}"))?;
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

/// Opens a file by absolute path without showing a dialog.
/// Used by the recent-files list and the Android file browser.
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

/// Lists files in a directory. On Android this is used to show the
/// app-private documents folder since there's no sidebar filesystem view.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("Cannot read dir: {e}"))?;
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        result.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "is_dir": meta.is_dir(),
            "size": meta.len(),
        }));
    }
    result.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        if a_dir != b_dir {
            b_dir.cmp(&a_dir)
        } else {
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
        }
    });
    Ok(result)
}

/// Reads an image from an absolute local path and returns it as a base64 data URL.
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
fn get_nextcloud_config(app: tauri::AppHandle) -> Option<crate::nextcloud::NextcloudConfig> {
    crate::nextcloud::load_config(Some(&app))
}

#[tauri::command]
fn save_nextcloud_config(app: tauri::AppHandle, config: crate::nextcloud::NextcloudConfig) -> Result<(), String> {
    crate::nextcloud::save_config(Some(&app), &config)
}

#[tauri::command]
fn unlink_nextcloud(app: tauri::AppHandle) -> Result<(), String> {
    crate::nextcloud::unlink_config(Some(&app))
}

#[tauri::command]
async fn test_nextcloud_connection(config: crate::nextcloud::NextcloudConfig) -> Result<String, String> {
    crate::nextcloud::test_connection(config).await
}

#[tauri::command]
async fn list_nextcloud_folder(app: tauri::AppHandle, path: String) -> Result<Vec<crate::nextcloud::NextcloudEntry>, String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::list_folder(cfg, path).await
}

#[tauri::command]
async fn read_nextcloud_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::read_file(cfg, path).await
}

#[tauri::command]
async fn read_nextcloud_image_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::read_image_base64(cfg, path).await
}

#[tauri::command]
async fn write_nextcloud_file(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::write_file(cfg, path, content).await
}

#[tauri::command]
async fn write_nextcloud_binary_file(app: tauri::AppHandle, path: String, content: Vec<u8>) -> Result<(), String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::write_binary_file(cfg, path, content).await
}

#[tauri::command]
async fn delete_nextcloud_entry(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::delete_entry(cfg, path).await
}

#[tauri::command]
async fn create_nextcloud_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let cfg = crate::nextcloud::load_config(Some(&app))
        .ok_or_else(|| "Nextcloud is not linked".to_string())?;
    crate::nextcloud::create_folder(cfg, path).await
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Desktop: handle --help / --version flags
    #[cfg(not(target_os = "android"))]
    {
        let args: Vec<String> = std::env::args().collect();
        for arg in &args[1..] {
            if arg == "-h" || arg == "--help" {
                println!("ArtfulType Pro v{}", env!("CARGO_PKG_VERSION"));
                println!("Usage: artfultype-rs [OPTIONS] [FILE]\n");
                println!("Options:");
                println!("  --mode <MODE>      Set initial view mode (writer | markdown | split)");
                println!("  --theme <THEME>    Set initial theme (standard-daylight | standard-night | dracula | calm-rs | classic-mac | win98 | solaris-cde | beos)");
                println!("  -h, --help         Print help information");
                println!("  -v, --version      Print version information");
                return;
            } else if arg == "-v" || arg == "--version" {
                println!("ArtfulType Pro v{}", env!("CARGO_PKG_VERSION"));
                return;
            }
        }
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            parse_markdown,
            open_file_dialog,
            save_file_dialog,
            get_platform,
            get_cli_args,
            get_files_dir,
            save_file,
            save_binary_file,
            read_file,
            list_dir,
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
            write_nextcloud_binary_file,
            delete_nextcloud_entry,
            create_nextcloud_folder,
            diagrams::render_plantuml,
            diagrams::render_d2,
            diagrams::render_svgbob,
            diagrams::diagram_capabilities,
            updater::check_for_updates,
            updater::download_and_install_update,
            updater::restart_app,
        ]);

    // ── Desktop-only plugins & commands ──────────────────────────────────────
    #[cfg(not(target_os = "android"))]
    {
        builder = builder
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
