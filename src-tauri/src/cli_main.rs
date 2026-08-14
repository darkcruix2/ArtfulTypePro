use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph},
    Terminal,
};
use std::{
    env, fs,
    io::{self, stdout},
    path::PathBuf,
};

#[derive(Debug, Clone, Copy, PartialEq)]
enum ViewMode {
    Writer,
    Markdown,
    Split,
    PureText,
}

#[derive(Debug, Clone, PartialEq)]
enum PopupState {
    None,
    QuitConfirm,
    SaveAs {
        current_dir: String,
        entries: Vec<(String, bool)>,
        selected: usize,
        scroll: usize,
        input: String,
        input_focused: bool,
    },
    NextcloudSaveAs {
        remote_path: String,
        entries: Vec<artfultype_rs_lib::nextcloud::NextcloudEntry>,
        selected: usize,
        scroll: usize,
        input: String,
        input_focused: bool,
    },
    OverwriteConfirm {
        target_path: Option<String>,
        target_remote_path: Option<String>,
        file_name: String,
        is_nextcloud: bool,
    },
    OpenFile {
        current_dir: String,
        entries: Vec<(String, bool)>,
        selected: usize,
        scroll: usize,
    },
    NextcloudConfig {
        url_input: String,
        username_input: String,
        password_input: String,
        focus: usize, // 0: url, 1: username, 2: password, 3: link, 4: unlink
        status_msg: String,
    },
    NextcloudOpen {
        remote_path: String,
        entries: Vec<artfultype_rs_lib::nextcloud::NextcloudEntry>,
        selected: usize,
        scroll: usize,
    },
    Search { input: String },
    SearchReplace { search: String, replace: String, step: u8 }, // step 0: search, step 1: replace
    About,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Theme {
    DarkAntigravity,
    RetroGreen,
    RetroAmber,
    Dracula,
    DosEdit,
    VT100,
}

impl Theme {
    fn colors(&self) -> ThemeColors {
        match self {
            Theme::DarkAntigravity => ThemeColors {
                bg: Color::Rgb(10, 14, 20),
                fg: Color::Rgb(0, 240, 255),
                accent: Color::Rgb(0, 240, 255),
                muted: Color::Rgb(92, 110, 140),
                border: Color::Rgb(27, 37, 54),
                header: Color::Rgb(112, 0, 255),
                quote: Color::Rgb(255, 0, 127),
                sel_bg: Color::Rgb(30, 60, 100),
                sel_fg: Color::Rgb(220, 240, 255),
            },
            Theme::RetroGreen => ThemeColors {
                bg: Color::Rgb(5, 14, 5),
                fg: Color::Rgb(51, 255, 51),
                accent: Color::Rgb(102, 255, 102),
                muted: Color::Rgb(31, 128, 31),
                border: Color::Rgb(25, 64, 25),
                header: Color::Rgb(51, 255, 51),
                quote: Color::Rgb(153, 255, 51),
                sel_bg: Color::Rgb(20, 80, 20),
                sel_fg: Color::Rgb(200, 255, 200),
            },
            Theme::RetroAmber => ThemeColors {
                bg: Color::Rgb(15, 11, 0),
                fg: Color::Rgb(255, 176, 0),
                accent: Color::Rgb(255, 208, 102),
                muted: Color::Rgb(153, 106, 0),
                border: Color::Rgb(77, 54, 0),
                header: Color::Rgb(255, 176, 0),
                quote: Color::Rgb(255, 128, 0),
                sel_bg: Color::Rgb(80, 55, 0),
                sel_fg: Color::Rgb(255, 230, 150),
            },
            Theme::Dracula => ThemeColors {
                bg: Color::Rgb(40, 42, 54),
                fg: Color::Rgb(248, 248, 242),
                accent: Color::Rgb(189, 147, 249),
                muted: Color::Rgb(98, 114, 164),
                border: Color::Rgb(98, 114, 164),
                header: Color::Rgb(255, 121, 198),
                quote: Color::Rgb(241, 250, 140),
                sel_bg: Color::Rgb(68, 71, 90),
                sel_fg: Color::Rgb(248, 248, 242),
            },
            Theme::DosEdit => ThemeColors {
                bg: Color::Rgb(0, 0, 170),      // Classic DOS Edit Blue
                fg: Color::Rgb(255, 255, 255),  // High-Contrast White Text
                accent: Color::Rgb(85, 255, 255),// Light Cyan
                muted: Color::Rgb(170, 170, 170),// Light Grey
                border: Color::Rgb(0, 170, 170), // DOS Cyan for Menus/Statusbar
                header: Color::Rgb(255, 255, 85),// Classic DOS Yellow
                quote: Color::Rgb(85, 255, 85),  // Light Green
                sel_bg: Color::Rgb(0, 170, 170), // DOS Cyan selection
                sel_fg: Color::Rgb(0, 0, 0),     // Black selection text
            },
            Theme::VT100 => ThemeColors {
                bg: Color::Rgb(0, 0, 0),    // True-color black; bypasses ANSI palette detection with TERM=vt100
                fg: Color::White,
                accent: Color::Green,
                muted: Color::Gray,
                border: Color::Rgb(40, 40, 40),  // Dark grey for menubar/statusbar strip
                header: Color::Green,
                quote: Color::Yellow,
                sel_bg: Color::Blue,
                sel_fg: Color::White,
            },
        }
    }
}

struct ThemeColors {
    bg: Color,
    fg: Color,
    accent: Color,
    muted: Color,
    border: Color,
    header: Color,
    quote: Color,
    sel_bg: Color,
    sel_fg: Color,
}

fn read_dir_entries(dir: &str) -> Vec<(String, bool)> {
    let mut entries = Vec::new();
    if let Ok(path) = std::path::PathBuf::from(dir).canonicalize() {
        if path.parent().is_some() {
            entries.push(("..".to_string(), true));
        }
        if let Ok(read_dir) = std::fs::read_dir(&path) {
            let mut dirs = Vec::new();
            let mut files = Vec::new();
            for entry in read_dir.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if metadata.is_dir() {
                        dirs.push((name, true));
                    } else {
                        files.push((name, false));
                    }
                }
            }
            dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
            files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
            entries.extend(dirs);
            entries.extend(files);
        }
    }
    entries
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ActiveMenu {
    None,
    File,
    Edit,
    Format,
    Manipulation,
    View,
    Theme,
    Help,
}

#[derive(Debug, Clone, Copy)]
enum MenuAction {
    NewFile,
    OpenFile,
    SaveFile,
    SaveAs,
    NextcloudConfig,
    NextcloudOpen,
    Quit,
    Heading1,
    Heading2,
    Heading3,
    Bold,
    Italic,
    Code,
    CalloutNote,
    TaskCheckbox,
    ViewWriter,
    ViewMarkdown,
    ViewSplit,
    ViewPureText,
    ThemeDarkAntigravity,
    ThemeRetroGreen,
    ThemeRetroAmber,
    ThemeDracula,
    ThemeDosEdit,
    ThemeVT100,
    WordWrap,
    SyntaxHighlighting,
    Undo,
    Redo,
    Search,
    SearchReplace,
    ReplaceAll,
    Indent,
    Unindent,
    About,
    NoOp,
}

struct App {
    file_path: Option<String>,
    file_name: String,
    content: String,
    cursor_line: usize,
    cursor_col: usize,
    scroll_top: usize,
    scroll_left: usize,
    // Selection anchor: set when Shift-movement begins; None = no selection.
    selection_anchor: Option<(usize, usize)>,
    // Internal clipboard for cut/copy/paste.
    clipboard: String,
    history: Vec<String>,
    history_index: usize,
    view_mode: ViewMode,
    theme: Theme,
    active_menu: ActiveMenu,
    menu_selected: usize,
    popup: PopupState,
    dirty: bool,
    status_msg: String,
    should_quit: bool,
    quit_after_save: bool,
    snapshot_disabled: bool,
    word_wrap: bool,
    syntax_highlighting: bool,
    recent_nextcloud_files: Vec<(String, String)>,
    is_nextcloud_file: bool,
    nextcloud_remote_path: Option<String>,
    nextcloud_config: Option<artfultype_rs_lib::nextcloud::NextcloudConfig>,
    is_welcome_screen: bool,
}

fn is_code_file_extension(path_or_name: &str) -> bool {
    let lower = path_or_name.to_lowercase();
    let ext = std::path::Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "rs" | "py" | "c" | "h" | "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" | "js" | "ts"
        | "jsx" | "tsx" | "go" | "java" | "sh" | "bash" | "zsh" | "json" | "yaml" | "yml"
        | "toml" | "sql" | "css" | "html" | "htm" | "xml" | "cmake" | "make" | "pde" | "php"
        | "rb" | "kt" | "kts" | "swift" | "scala" | "cs" | "fs" | "elm" | "ex" | "exs" | "clj"
        | "ps1" | "psm1" | "psd1" | "pwsh" | "powershell" => true,
        _ => lower.ends_with("makefile") || lower.ends_with("cmakelists.txt") || lower.ends_with("dockerfile"),
    }
}

impl App {
    fn new(
        file_path: Option<String>,
        initial_mode: Option<ViewMode>,
        initial_theme: Option<Theme>,
    ) -> App {
        let mut content = String::new();
        let mut file_name = "untitled.md".to_string();
        let mut is_welcome_screen = false;

        if let Some(ref path) = file_path {
            let p = PathBuf::from(path);
            if let Ok(c) = fs::read_to_string(&p) {
                content = c;
                if let Some(n) = p.file_name() {
                    file_name = n.to_string_lossy().to_string();
                }
            }
        } else {
            is_welcome_screen = true;
            content = "# Welcome to art TUI\n\n\
                       A distraction-free Markdown Writer & TUI Editor.\n\n\
                       ## Features\n\n\
                       - [x] **Writer mode** — live styled preview in terminal\n\
                       - [x] **Markdown mode** — raw syntax editor\n\
                       - [x] **Split mode** — side-by-side view\n\
                       - [x] **Pure Text mode** — full code & plain text editor with syntax highlighting\n\
                       - [x] VT100 / Pure ASCII Mode (--vt100)\n\n\
                       > [!NOTE]\n\
                       > Press Alt+F, Alt+O, Alt+V, Alt+T or use Arrow keys inside menus.\n\n\
                       ---"
                .to_string();
        }

        let saved_settings = artfultype_rs_lib::nextcloud::load_cli_settings();
        let is_code = file_path.as_deref().map_or(false, is_code_file_extension);
        let default_mode = if initial_mode.is_none() && is_code {
            ViewMode::PureText
        } else {
            match saved_settings.view_mode.as_str() {
                "markdown" => ViewMode::Markdown,
                "split" => ViewMode::Split,
                "pure-text" => ViewMode::PureText,
                _ => ViewMode::Writer,
            }
        };
        let default_theme = match saved_settings.theme.as_str() {
            "dark-antigravity" => Theme::DarkAntigravity,
            "retro-green" => Theme::RetroGreen,
            "retro-amber" => Theme::RetroAmber,
            "dos-edit" | "dos" => Theme::DosEdit,
            "vt100" => Theme::VT100,
            _ => Theme::Dracula,
        };

        let nc_cfg = artfultype_rs_lib::nextcloud::load_config(None);
        App {
            file_path,
            file_name,
            content: content.clone(),
            cursor_line: 0,
            cursor_col: 0,
            scroll_top: 0,
            scroll_left: 0,
            selection_anchor: None,
            clipboard: String::new(),
            history: vec![content.clone()],
            history_index: 0,
            view_mode: initial_mode.unwrap_or(default_mode),
            theme: initial_theme.unwrap_or(default_theme),
            active_menu: ActiveMenu::None,
            menu_selected: 0,
            popup: PopupState::None,
            dirty: false,
            status_msg: "Ready".to_string(),
            should_quit: false,
            quit_after_save: false,
            snapshot_disabled: false,
            word_wrap: saved_settings.word_wrap,
            syntax_highlighting: saved_settings.syntax_highlighting,
            recent_nextcloud_files: saved_settings.recent_nextcloud_files,
            is_nextcloud_file: false,
            nextcloud_remote_path: None,
            nextcloud_config: nc_cfg,
            is_welcome_screen,
        }
    }

    fn clear_welcome(&mut self) {
        self.is_welcome_screen = false;
        self.content = String::new();
        self.cursor_line = 0;
        self.cursor_col = 0;
        self.scroll_top = 0;
        self.scroll_left = 0;
        self.selection_anchor = None;
        self.history = vec![String::new()];
        self.history_index = 0;
        self.dirty = false;
    }

    fn record_nextcloud_recent(&mut self, remote_path: &str, display_name: &str) {
        self.recent_nextcloud_files.retain(|(p, _)| p != remote_path);
        self.recent_nextcloud_files.insert(0, (remote_path.to_string(), display_name.to_string()));
        if self.recent_nextcloud_files.len() > 2 {
            self.recent_nextcloud_files.truncate(2);
        }
        self.save_settings();
    }

    fn save_settings(&self) {
        let s = artfultype_rs_lib::nextcloud::CliSettings {
            theme: match self.theme {
                Theme::DarkAntigravity => "dark-antigravity".to_string(),
                Theme::RetroGreen => "retro-green".to_string(),
                Theme::RetroAmber => "retro-amber".to_string(),
                Theme::Dracula => "dracula".to_string(),
                Theme::DosEdit => "dos-edit".to_string(),
                Theme::VT100 => "vt100".to_string(),
            },
            word_wrap: self.word_wrap,
            view_mode: match self.view_mode {
                ViewMode::Writer => "writer".to_string(),
                ViewMode::Markdown => "markdown".to_string(),
                ViewMode::Split => "split".to_string(),
                ViewMode::PureText => "pure-text".to_string(),
            },
            recent_nextcloud_files: self.recent_nextcloud_files.clone(),
            syntax_highlighting: self.syntax_highlighting,
        };
        let _ = artfultype_rs_lib::nextcloud::save_cli_settings(&s);
    }

    fn snapshot(&mut self) {
        if self.snapshot_disabled { return; }
        // truncate future redo history
        self.history.truncate(self.history_index + 1);
        self.history.push(self.content.clone());
        if self.history.len() > 11 { // Keep up to 10 changes + initial state
            self.history.remove(0);
        }
        self.history_index = self.history.len() - 1;
        self.dirty = true;
    }

    fn undo(&mut self) {
        if self.history_index > 0 {
            self.history_index -= 1;
            self.content = self.history[self.history_index].clone();
            self.dirty = true; // or check if history_index == saved_index, but for simplicity let's set it dirty
            self.ensure_cursor_valid();
            self.status_msg = "Undo".to_string();
        }
    }

    fn redo(&mut self) {
        if self.history_index + 1 < self.history.len() {
            self.history_index += 1;
            self.content = self.history[self.history_index].clone();
            self.dirty = true;
            self.ensure_cursor_valid();
            self.status_msg = "Redo".to_string();
        }
    }

    fn open_menu(&mut self, menu: ActiveMenu) {
        self.active_menu = menu;
        self.menu_selected = 0;
    }

    fn get_lines(&self) -> Vec<&str> {
        if self.content.is_empty() {
            return vec![""];
        }
        let v: Vec<&str> = self.content.split('\n').collect();
        if v.is_empty() { vec![""] } else { v }
    }

    fn ensure_cursor_valid(&mut self) {
        let lc = self.get_lines().len();
        if lc == 0 {
            self.cursor_line = 0;
            self.cursor_col = 0;
            return;
        }
        if self.cursor_line >= lc {
            self.cursor_line = lc - 1;
        }
        let lines = self.get_lines();
        let ll = lines[self.cursor_line].chars().count();
        if self.cursor_col > ll {
            self.cursor_col = ll;
        }
    }

    fn line_vis_h(&self, line: &str, inner_width: usize) -> usize {
        if !self.word_wrap || inner_width == 0 {
            1
        } else {
            let chars: Vec<char> = line.chars().collect();
            wrap_line_chars(&chars, inner_width).len().max(1)
        }
    }

    /// Keep scroll_top so that cursor_line is always visible inside inner_height rows.
    fn clamp_scroll(&mut self, inner_height: usize, inner_width: usize) {
        let h = inner_height.max(1);
        let lines: Vec<String> = self.get_lines().into_iter().map(|s| s.to_string()).collect();
        if lines.is_empty() {
            self.scroll_top = 0;
            return;
        }

        if self.cursor_line >= lines.len() {
            self.cursor_line = lines.len().saturating_sub(1);
        }

        if self.cursor_line < self.scroll_top {
            self.scroll_top = self.cursor_line;
        }

        let mut vis_h = 0;
        for i in self.scroll_top..=self.cursor_line {
            vis_h += self.line_vis_h(&lines[i], inner_width);
        }

        while vis_h > h && self.scroll_top < self.cursor_line {
            let sub = self.line_vis_h(&lines[self.scroll_top], inner_width);
            vis_h = vis_h.saturating_sub(sub);
            self.scroll_top += 1;
        }

        self.scroll_top = self.scroll_top.min(lines.len().saturating_sub(1));
    }

    fn clamp_scroll_h(&mut self, inner_height: usize) {
        self.clamp_scroll(inner_height, 80);
    }

    /// Keep scroll_left so that cursor_col is always visible inside inner_width columns.
    fn clamp_scroll_x(&mut self, inner_width: usize) {
        let w = inner_width.max(1);
        // Add a small margin or just keep it tight
        if self.cursor_col < self.scroll_left {
            self.scroll_left = self.cursor_col;
        } else if self.cursor_col >= self.scroll_left + w {
            self.scroll_left = self.cursor_col + 1 - w;
        }
    }

    fn sync_content_from_lines(&mut self, lines: Vec<String>) {
        self.snapshot();
        self.content = lines.join("\n");
        self.dirty = true;
    }

    // ── Selection helpers ──────────────────────────────────────────────────

    /// If no anchor is set, drop one at the current cursor position.
    fn start_selection(&mut self) {
        if self.selection_anchor.is_none() {
            self.selection_anchor = Some((self.cursor_line, self.cursor_col));
        }
    }

    /// Clear the selection without moving the cursor.
    fn clear_selection(&mut self) {
        self.selection_anchor = None;
    }

    /// Returns (start, end) in document order where start <= end.
    fn selection_range(&self) -> Option<((usize, usize), (usize, usize))> {
        self.selection_anchor.map(|anchor| {
            let cursor = (self.cursor_line, self.cursor_col);
            if anchor <= cursor {
                (anchor, cursor)
            } else {
                (cursor, anchor)
            }
        })
    }

    /// Extract the currently selected text as a String.
    fn selected_text(&self) -> String {
        let range = match self.selection_range() {
            Some(r) => r,
            None => return String::new(),
        };
        let ((sl, sc), (el, ec)) = range;
        let lines = self.get_lines();
        if sl == el {
            let line = lines[sl];
            let chars: Vec<char> = line.chars().collect();
            let end = ec.min(chars.len());
            let start = sc.min(end);
            chars[start..end].iter().collect()
        } else {
            let mut out = String::new();
            for li in sl..=el {
                if li >= lines.len() { break; }
                let chars: Vec<char> = lines[li].chars().collect();
                if li == sl {
                    out.push_str(&chars[sc.min(chars.len())..].iter().collect::<String>());
                    out.push('\n');
                } else if li == el {
                    let end = ec.min(chars.len());
                    out.push_str(&chars[..end].iter().collect::<String>());
                } else {
                    out.push_str(&chars.iter().collect::<String>());
                    out.push('\n');
                }
            }
            out
        }
    }

    /// Delete selected text, move cursor to selection start, clear selection.
    fn delete_selection(&mut self) {
        let range = match self.selection_range() {
            Some(r) => r,
            None => return,
        };
        let ((sl, sc), (el, ec)) = range;
        let mut lines: Vec<String> = self.get_lines().iter().map(|s| s.to_string()).collect();

        if sl == el {
            // single-line deletion
            let chars: Vec<char> = lines[sl].chars().collect();
            let before: String = chars[..sc].iter().collect();
            let after: String = chars[ec.min(chars.len())..].iter().collect();
            lines[sl] = before + &after;
        } else {
            // multi-line deletion: merge sl tail and el head
            let sl_chars: Vec<char> = lines[sl].chars().collect();
            let el_chars: Vec<char> = lines[el].chars().collect();
            let before: String = sl_chars[..sc.min(sl_chars.len())].iter().collect();
            let after: String = el_chars[ec.min(el_chars.len())..].iter().collect();
            lines[sl] = before + &after;
            // remove lines sl+1 through el
            lines.drain((sl + 1)..=(el.min(lines.len() - 1)));
        }

        self.cursor_line = sl;
        self.cursor_col = sc;
        self.selection_anchor = None;
        self.sync_content_from_lines(lines);
    }

    // ── Cursor movement (no-selection variants) ────────────────────────────

    fn move_up(&mut self, inner_height: usize, inner_width: usize) {
        if self.cursor_line > 0 {
            self.cursor_line -= 1;
        }
        self.ensure_cursor_valid();
        self.clamp_scroll(inner_height, inner_width);
    }

    fn move_down(&mut self, inner_height: usize, inner_width: usize) {
        let lc = self.get_lines().len();
        if self.cursor_line + 1 < lc {
            self.cursor_line += 1;
        }
        self.ensure_cursor_valid();
        self.clamp_scroll(inner_height, inner_width);
    }

    fn move_left(&mut self, inner_height: usize, inner_width: usize) {
        if self.cursor_col > 0 {
            self.cursor_col -= 1;
        } else if self.cursor_line > 0 {
            self.cursor_line -= 1;
            let lines = self.get_lines();
            self.cursor_col = lines[self.cursor_line].chars().count();
        }
        self.ensure_cursor_valid();
        self.clamp_scroll(inner_height, inner_width);
    }

    fn move_right(&mut self, inner_height: usize, inner_width: usize) {
        let lines = self.get_lines();
        if self.cursor_line < lines.len() {
            let ll = lines[self.cursor_line].chars().count();
            if self.cursor_col < ll {
                self.cursor_col += 1;
            } else if self.cursor_line + 1 < lines.len() {
                self.cursor_line += 1;
                self.cursor_col = 0;
            }
        }
        self.ensure_cursor_valid();
        self.clamp_scroll(inner_height, inner_width);
    }

    fn move_home(&mut self) {
        self.cursor_col = 0;
    }

    fn move_end(&mut self) {
        let lines = self.get_lines();
        if self.cursor_line < lines.len() {
            self.cursor_col = lines[self.cursor_line].chars().count();
        }
    }

    fn move_to_file_start(&mut self) {
        self.cursor_line = 0;
        self.cursor_col = 0;
        self.scroll_top = 0;
    }

    fn move_to_file_end(&mut self, inner_height: usize, inner_width: usize) {
        let lc = self.get_lines().len();
        if lc > 0 {
            self.cursor_line = lc - 1;
            let lines = self.get_lines();
            self.cursor_col = lines[self.cursor_line].chars().count();
        }
        self.clamp_scroll(inner_height, inner_width);
    }

    fn move_page_up(&mut self, inner_height: usize, inner_width: usize) {
        let page = inner_height.max(1);
        self.cursor_line = self.cursor_line.saturating_sub(page);
        self.ensure_cursor_valid();
        self.clamp_scroll(inner_height, inner_width);
    }

    fn move_page_down(&mut self, inner_height: usize, inner_width: usize) {
        let lc = self.get_lines().len();
        let page = inner_height.max(1);
        self.cursor_line = (self.cursor_line + page).min(lc.saturating_sub(1));
        self.ensure_cursor_valid();
        self.clamp_scroll(inner_height, inner_width);
    }

    // ── Editing ───────────────────────────────────────────────────────────

    fn insert_char(&mut self, c: char) {
        if self.selection_anchor.is_some() {
            self.delete_selection();
        }
        let mut lines: Vec<String> =
            self.get_lines().iter().map(|s| s.to_string()).collect();
        if self.cursor_line >= lines.len() {
            self.cursor_line = lines.len().saturating_sub(1);
        }
        let line = &mut lines[self.cursor_line];
        let bi = line
            .char_indices()
            .map(|(i, _)| i)
            .nth(self.cursor_col)
            .unwrap_or(line.len());
        line.insert(bi, c);
        self.cursor_col += 1;
        self.sync_content_from_lines(lines);
    }

    fn insert_newline(&mut self) {
        if self.selection_anchor.is_some() {
            self.delete_selection();
        }
        let mut lines: Vec<String> =
            self.get_lines().iter().map(|s| s.to_string()).collect();
        if self.cursor_line >= lines.len() {
            self.cursor_line = lines.len().saturating_sub(1);
        }

        let cur_line = lines[self.cursor_line].clone();
        let (prefix, is_empty_bullet) = if cur_line == "- " || cur_line == "* " || cur_line == "> " {
            ("", true)
        } else if cur_line == "- [ ] " || cur_line == "- [x] " || cur_line == "- [X] " {
            ("", true)
        } else if cur_line.starts_with("- [ ] ") || cur_line.starts_with("- [x] ") || cur_line.starts_with("- [X] ") {
            ("- [ ] ", false)
        } else if cur_line.starts_with("- ") {
            ("- ", false)
        } else if cur_line.starts_with("* ") {
            ("* ", false)
        } else if cur_line.starts_with("> ") {
            ("> ", false)
        } else {
            ("", false)
        };

        if is_empty_bullet {
            lines[self.cursor_line].clear();
            self.cursor_col = 0;
            self.sync_content_from_lines(lines);
            return;
        }

        let bi = cur_line
            .char_indices()
            .map(|(i, _)| i)
            .nth(self.cursor_col)
            .unwrap_or(cur_line.len());
        let tail = cur_line[bi..].to_string();
        lines[self.cursor_line].truncate(bi);

        let mut indent = prefix.to_string();
        if prefix.is_empty() {
            let leading: String = cur_line.chars().take_while(|c| c.is_whitespace()).collect();
            indent = leading;
            let head = cur_line[..bi].trim_end();
            if head.ends_with('{') || head.ends_with(':') || head.ends_with('(') || head.ends_with('[') {
                indent.push_str("    ");
            }
        }

        let new_line = format!("{}{}", indent, tail);
        lines.insert(self.cursor_line + 1, new_line);
        self.cursor_line += 1;
        self.cursor_col = indent.chars().count();
        self.sync_content_from_lines(lines);
    }

    fn duplicate_line_or_selection(&mut self) {
        self.snapshot();
        let mut lines: Vec<String> = self.get_lines().iter().map(|s| s.to_string()).collect();
        if self.selection_anchor.is_some() {
            let selected = self.selected_text();
            if !selected.is_empty() {
                self.insert_str_at_cursor(&selected);
            }
        } else if self.cursor_line < lines.len() {
            let dup = lines[self.cursor_line].clone();
            lines.insert(self.cursor_line + 1, dup);
            self.cursor_line += 1;
            self.sync_content_from_lines(lines);
        }
    }

    fn move_line_up(&mut self) {
        if self.cursor_line == 0 { return; }
        self.snapshot();
        let mut lines: Vec<String> = self.get_lines().iter().map(|s| s.to_string()).collect();
        lines.swap(self.cursor_line, self.cursor_line - 1);
        self.cursor_line -= 1;
        self.sync_content_from_lines(lines);
    }

    fn move_line_down(&mut self) {
        let count = self.get_lines().len();
        if self.cursor_line + 1 >= count { return; }
        self.snapshot();
        let mut lines: Vec<String> = self.get_lines().iter().map(|s| s.to_string()).collect();
        lines.swap(self.cursor_line, self.cursor_line + 1);
        self.cursor_line += 1;
        self.sync_content_from_lines(lines);
    }

    fn wrap_selection_delimiter(&mut self, open: &str, close: &str) -> bool {
        if self.selection_anchor.is_none() { return false; }
        let selected = self.selected_text();
        if selected.is_empty() { return false; }
        self.delete_selection();
        let wrapped = format!("{}{}{}", open, selected, close);
        self.insert_str_at_cursor(&wrapped);
        true
    }

    fn backspace(&mut self, inner_height: usize) {
        if self.selection_anchor.is_some() {
            self.delete_selection();
            self.clamp_scroll_h(inner_height);
            return;
        }
        let mut lines: Vec<String> =
            self.get_lines().iter().map(|s| s.to_string()).collect();
        if self.cursor_line >= lines.len() {
            self.cursor_line = lines.len().saturating_sub(1);
        }
        if self.cursor_col > 0 {
            let bi = lines[self.cursor_line]
                .char_indices()
                .map(|(i, _)| i)
                .nth(self.cursor_col - 1);
            if let Some(pos) = bi {
                lines[self.cursor_line].remove(pos);
                self.cursor_col -= 1;
            }
            self.sync_content_from_lines(lines);
        } else if self.cursor_line > 0 {
            let curr = lines.remove(self.cursor_line);
            self.cursor_line -= 1;
            self.cursor_col = lines[self.cursor_line].chars().count();
            lines[self.cursor_line].push_str(&curr);
            self.sync_content_from_lines(lines);
            self.clamp_scroll_h(inner_height);
        }
    }

    fn delete_forward(&mut self) {
        if self.selection_anchor.is_some() {
            self.delete_selection();
            return;
        }
        let mut lines: Vec<String> =
            self.get_lines().iter().map(|s| s.to_string()).collect();
        if self.cursor_line >= lines.len() {
            self.cursor_line = lines.len().saturating_sub(1);
        }
        let ll = lines[self.cursor_line].chars().count();
        if self.cursor_col < ll {
            let bi = lines[self.cursor_line]
                .char_indices()
                .map(|(i, _)| i)
                .nth(self.cursor_col);
            if let Some(pos) = bi {
                lines[self.cursor_line].remove(pos);
            }
            self.sync_content_from_lines(lines);
        } else if self.cursor_line + 1 < lines.len() {
            let next = lines.remove(self.cursor_line + 1);
            lines[self.cursor_line].push_str(&next);
            self.sync_content_from_lines(lines);
        }
    }

    fn copy_selection(&mut self) {
        let text = self.selected_text();
        if !text.is_empty() {
            self.clipboard = text.clone();
            copy_to_system_clipboard(&text);
            self.status_msg = "Copied".to_string();
        }
    }

    fn cut_selection(&mut self, inner_height: usize) {
        let text = self.selected_text();
        if !text.is_empty() {
            self.clipboard = text.clone();
            copy_to_system_clipboard(&text);
            self.delete_selection();
            self.clamp_scroll_h(inner_height);
            self.status_msg = "Cut".to_string();
        }
    }

    fn paste(&mut self) {
        if self.selection_anchor.is_some() {
            self.delete_selection();
        }
        self.snapshot();
        self.snapshot_disabled = true;
        let text = self.clipboard.clone();
        for c in text.chars() {
            if c == '\n' {
                self.insert_newline();
            } else {
                self.insert_char(c);
            }
        }
        self.snapshot_disabled = false;
        self.status_msg = "Pasted".to_string();
    }

    fn insert_str_at_cursor(&mut self, text: &str) {
        for c in text.chars() {
            if c == '\n' {
                self.insert_newline();
            } else {
                self.insert_char(c);
            }
        }
    }

    /// If text is selected, wraps it with `prefix` and `suffix` (e.g. ** and **).
    /// If nothing is selected, inserts `fallback` at the cursor.
    fn wrap_selection_or_insert(&mut self, prefix: &str, suffix: &str, fallback: &str) {
        if self.selection_anchor.is_some() {
            let selected = self.selected_text();
            if !selected.is_empty() {
                self.delete_selection();
                let wrapped = format!("{}{}{}", prefix, selected, suffix);
                self.insert_str_at_cursor(&wrapped);
                return;
            }
        }
        self.insert_str_at_cursor(fallback);
    }

    fn save_file(&mut self) {
        if self.is_nextcloud_file {
            if let (Some(ref cfg), Some(ref remote_path)) = (&self.nextcloud_config, &self.nextcloud_remote_path) {
                let remote_path_clone = remote_path.clone();
                match artfultype_rs_lib::nextcloud::write_file_sync(cfg, &remote_path_clone, &self.content) {
                    Ok(_) => {
                        self.dirty = false;
                        let clean_name = self.file_name.trim_start_matches("☁ ").to_string();
                        self.record_nextcloud_recent(&remote_path_clone, &clean_name);
                        self.status_msg = format!("Saved to Nextcloud: {}", self.file_name);
                    }
                    Err(e) => {
                        self.status_msg = format!("Nextcloud save error: {}", e);
                    }
                }
                return;
            }
        }

        if let Some(ref path) = self.file_path {
            if std::fs::write(path, &self.content).is_ok() {
                self.dirty = false;
                self.status_msg = format!("Saved: {}", self.file_name);
            } else {
                self.status_msg = "Error saving file".to_string();
            }
        } else {
            let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).to_string_lossy().to_string();
            let entries = read_dir_entries(&dir);
            let init_name = self.file_name.trim_start_matches("☁ ").trim().to_string();
            self.popup = PopupState::SaveAs {
                current_dir: dir,
                entries,
                selected: 0,
                scroll: 0,
                input: init_name,
                input_focused: true,
            };
        }
    }

    fn select_all(&mut self) {
        self.selection_anchor = Some((0, 0));
        let (len, last_col) = {
            let lines = self.get_lines();
            (lines.len(), lines.last().map_or(0, |l| l.chars().count()))
        };
        self.cursor_line = len.saturating_sub(1);
        self.cursor_col = last_col;
    }

    fn delete_to_end_of_line(&mut self) {
        self.snapshot();
        let mut lines = self.get_lines().iter().map(|s| s.to_string()).collect::<Vec<_>>();
        if self.cursor_line < lines.len() {
            let line = &lines[self.cursor_line];
            let bi = line.char_indices().map(|(i, _)| i).nth(self.cursor_col).unwrap_or(line.len());
            let deleted = line[bi..].to_string();
            if !deleted.is_empty() {
                self.clipboard = deleted.clone();
                copy_to_system_clipboard(&deleted);
            }
            lines[self.cursor_line] = line[..bi].to_string();
            self.sync_content_from_lines(lines);
        }
    }

    fn search_forward(&mut self, query: &str, inner_height: usize) {
        if query.is_empty() { return; }
        
        let target = {
            let lines = self.get_lines();
            let mut res = None;
            for (i, line) in lines.iter().enumerate().skip(self.cursor_line) {
                let start_col = if i == self.cursor_line { self.cursor_col + 1 } else { 0 };
                let bi = line.char_indices().map(|(idx, _)| idx).nth(start_col).unwrap_or(line.len());
                if bi < line.len() {
                    if let Some(pos) = line[bi..].find(query) {
                        let prefix = &line[..bi + pos];
                        res = Some((i, prefix.chars().count()));
                        break;
                    }
                }
            }
            res
        };
        
        if let Some((i, col)) = target {
            self.cursor_line = i;
            self.cursor_col = col;
            self.clamp_scroll_h(inner_height);
            self.start_selection();
            self.cursor_col += query.chars().count();
            self.clamp_scroll_h(inner_height);
            self.status_msg = format!("Found '{}'", query);
        } else {
            self.status_msg = format!("'{}' not found", query);
        }
    }

    fn replace_all(&mut self, search: &str, replace: &str) {
        if search.is_empty() { return; }
        self.snapshot();
        self.content = self.content.replace(search, replace);
        self.dirty = true;
        self.ensure_cursor_valid();
        self.status_msg = format!("Replaced all occurrences of '{}'", search);
    }

    fn indent_selection(&mut self) {
        self.snapshot();
        let mut lines = self.get_lines().iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (start_line, end_line) = match self.selection_range() {
            Some(((sl, _), (el, _))) => (sl, el),
            None => (self.cursor_line, self.cursor_line),
        };
        for i in start_line..=end_line {
            if i < lines.len() {
                lines[i].insert_str(0, "    ");
            }
        }
        self.sync_content_from_lines(lines);
        self.cursor_col += 4;
    }

    fn unindent_selection(&mut self) {
        self.snapshot();
        let mut lines = self.get_lines().iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (start_line, end_line) = match self.selection_range() {
            Some(((sl, _), (el, _))) => (sl, el),
            None => (self.cursor_line, self.cursor_line),
        };
        for i in start_line..=end_line {
            if i < lines.len() {
                if lines[i].starts_with("    ") {
                    lines[i] = lines[i][4..].to_string();
                } else if lines[i].starts_with('\t') {
                    lines[i] = lines[i][1..].to_string();
                }
            }
        }
        self.sync_content_from_lines(lines);
        self.cursor_col = self.cursor_col.saturating_sub(4);
    }

    fn execute_action(&mut self, action: MenuAction, inner_height: usize) {
        match action {
            MenuAction::NewFile => {
                self.is_welcome_screen = false;
                self.content = String::new();
                self.file_path = None;
                self.file_name = "untitled.md".to_string();
                self.cursor_line = 0;
                self.cursor_col = 0;
                self.scroll_top = 0;
                self.scroll_left = 0;
                self.dirty = false;
                self.history.clear();
                self.history_index = 0;
                self.snapshot();
                self.clear_selection();
                self.status_msg = "New file".to_string();
            }
            MenuAction::OpenFile => {
                let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).to_string_lossy().to_string();
                let entries = read_dir_entries(&dir);
                self.popup = PopupState::OpenFile {
                    current_dir: dir,
                    entries,
                    selected: 0,
                    scroll: 0,
                };
            }
            MenuAction::SaveFile => self.save_file(),
            MenuAction::SaveAs => {
                let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).to_string_lossy().to_string();
                let entries = read_dir_entries(&dir);
                let init_name = self.file_name.trim_start_matches("☁ ").trim().to_string();
                self.popup = PopupState::SaveAs {
                    current_dir: dir,
                    entries,
                    selected: 0,
                    scroll: 0,
                    input: init_name,
                    input_focused: true,
                };
            }
            MenuAction::NextcloudConfig => {
                if self.nextcloud_config.is_none() {
                    self.nextcloud_config = artfultype_rs_lib::nextcloud::load_config(None);
                }
                let (url, user, pass) = if let Some(ref cfg) = self.nextcloud_config {
                    (cfg.server_url.clone(), cfg.username.clone(), cfg.password.clone())
                } else {
                    ("https://cloud.example.com".to_string(), "".to_string(), "".to_string())
                };
                self.popup = PopupState::NextcloudConfig {
                    url_input: url,
                    username_input: user,
                    password_input: pass,
                    focus: 0,
                    status_msg: "Configure Nextcloud integration".to_string(),
                };
            }
            MenuAction::NextcloudOpen => {
                if self.nextcloud_config.is_none() {
                    self.nextcloud_config = artfultype_rs_lib::nextcloud::load_config(None);
                }
                if let Some(ref cfg) = self.nextcloud_config {
                    match artfultype_rs_lib::nextcloud::list_folder_sync(cfg, "") {
                        Ok(entries) => {
                            self.popup = PopupState::NextcloudOpen {
                                remote_path: "".to_string(),
                                entries,
                                selected: 0,
                                scroll: 0,
                            };
                        }
                        Err(e) => {
                            self.status_msg = format!("Nextcloud error: {}", e);
                        }
                    }
                } else {
                    let (url, user, pass) = ("https://cloud.example.com".to_string(), "".to_string(), "".to_string());
                    self.popup = PopupState::NextcloudConfig {
                        url_input: url,
                        username_input: user,
                        password_input: pass,
                        focus: 0,
                        status_msg: "Nextcloud is not linked yet. Enter credentials below:".to_string(),
                    };
                }
            }
            MenuAction::About => {
                self.popup = PopupState::About;
            }
            MenuAction::Quit => {
                self.popup = PopupState::QuitConfirm;
            }
            MenuAction::Heading1 => self.insert_str_at_cursor("# "),
            MenuAction::Heading2 => self.insert_str_at_cursor("## "),
            MenuAction::Heading3 => self.insert_str_at_cursor("### "),
            MenuAction::Bold => self.wrap_selection_or_insert("**", "**", "**bold**"),
            MenuAction::Italic => self.wrap_selection_or_insert("*", "*", "*italic*"),
            MenuAction::Code => self.wrap_selection_or_insert("`", "`", "`code`"),
            MenuAction::CalloutNote => self.insert_str_at_cursor("> [!NOTE]\n> "),
            MenuAction::TaskCheckbox => self.insert_str_at_cursor("- [ ] "),
            MenuAction::ViewWriter => {
                self.view_mode = ViewMode::Writer;
                if self.active_menu == ActiveMenu::Manipulation { self.active_menu = ActiveMenu::Format; }
                self.save_settings();
            }
            MenuAction::ViewMarkdown => {
                self.view_mode = ViewMode::Markdown;
                if self.active_menu == ActiveMenu::Manipulation { self.active_menu = ActiveMenu::Format; }
                self.save_settings();
            }
            MenuAction::ViewSplit => {
                self.view_mode = ViewMode::Split;
                if self.active_menu == ActiveMenu::Manipulation { self.active_menu = ActiveMenu::Format; }
                self.save_settings();
            }
            MenuAction::ViewPureText => {
                self.view_mode = ViewMode::PureText;
                if self.active_menu == ActiveMenu::Format { self.active_menu = ActiveMenu::Manipulation; }
                self.save_settings();
            }
            MenuAction::ThemeDarkAntigravity => { self.theme = Theme::DarkAntigravity; self.save_settings(); }
            MenuAction::ThemeRetroGreen => { self.theme = Theme::RetroGreen; self.save_settings(); }
            MenuAction::ThemeRetroAmber => { self.theme = Theme::RetroAmber; self.save_settings(); }
            MenuAction::ThemeDracula => { self.theme = Theme::Dracula; self.save_settings(); }
            MenuAction::ThemeDosEdit => { self.theme = Theme::DosEdit; self.save_settings(); }
            MenuAction::ThemeVT100 => { self.theme = Theme::VT100; self.save_settings(); }
            MenuAction::WordWrap => { self.word_wrap = !self.word_wrap; self.save_settings(); }
            MenuAction::SyntaxHighlighting => { self.syntax_highlighting = !self.syntax_highlighting; self.save_settings(); }
            MenuAction::Undo => self.undo(),
            MenuAction::Redo => self.redo(),
            MenuAction::Search => {
                self.popup = PopupState::Search { input: String::new() };
            }
            MenuAction::SearchReplace => {
                self.popup = PopupState::SearchReplace { search: String::new(), replace: String::new(), step: 0 };
            }
            MenuAction::ReplaceAll => {
                self.popup = PopupState::SearchReplace { search: String::new(), replace: String::new(), step: 0 };
            }
            MenuAction::Indent => self.indent_selection(),
            MenuAction::Unindent => self.unindent_selection(),
            MenuAction::NoOp => {}
        }
        self.clamp_scroll_h(inner_height);
        // If a popup was opened, don't close active menu until popup is done,
        // or close it now? Let's close the dropdown.
        if self.popup == PopupState::None {
            self.active_menu = ActiveMenu::None;
        } else {
            self.active_menu = ActiveMenu::None;
        }
    }
}

fn get_menu_items(menu: ActiveMenu) -> Vec<(&'static str, MenuAction)> {
    match menu {
        ActiveMenu::File => vec![
            ("[N] New File          (Ctrl+N)", MenuAction::NewFile),
            ("[O] Open Local File   (Ctrl+O)", MenuAction::OpenFile),
            ("[C] Open Nextcloud... (Ctrl+Shift+O)", MenuAction::NextcloudOpen),
            ("[S] Save File         (Ctrl+S)", MenuAction::SaveFile),
            ("[A] Save As...", MenuAction::SaveAs),
            ("[L] Nextcloud Settings(Ctrl+L)", MenuAction::NextcloudConfig),
            ("[Q] Quit              (Ctrl+Q)", MenuAction::Quit),
        ],
        ActiveMenu::Edit => vec![
            ("Undo          (Ctrl+Alt+Z)", MenuAction::Undo),
            ("Redo          (Ctrl+Alt+Y)", MenuAction::Redo),
            ("Copy          (Ctrl+Alt+C)", MenuAction::NoOp),
            ("Cut           (Ctrl+Alt+X)", MenuAction::NoOp),
            ("Paste         (Ctrl+Alt+V)", MenuAction::NoOp),
        ],
        ActiveMenu::Format => vec![
            ("H1 Heading 1  (Ctrl+1)", MenuAction::Heading1),
            ("H2 Heading 2  (Ctrl+2)", MenuAction::Heading2),
            ("H3 Heading 3  (Ctrl+3)", MenuAction::Heading3),
            ("Bold      (Ctrl+Alt+B)", MenuAction::Bold),
            ("Italic    (Ctrl+Alt+I)", MenuAction::Italic),
            ("Code      (Ctrl+Alt+K)", MenuAction::Code),
            ("Callout Note", MenuAction::CalloutNote),
            ("Task Checkbox", MenuAction::TaskCheckbox),
        ],
        ActiveMenu::Manipulation => vec![
            ("Search", MenuAction::Search),
            ("Search and Replace", MenuAction::SearchReplace),
            ("Replace All", MenuAction::ReplaceAll),
            ("Indent Selection (Tab)", MenuAction::Indent),
            ("Unindent Selection (Shift+Tab)", MenuAction::Unindent),
            ("Syntax Highlighting (F6 / Ctrl+H)", MenuAction::SyntaxHighlighting),
        ],
        ActiveMenu::View => vec![
            ("Writer Mode   (Cmd+Alt+2 / F2)", MenuAction::ViewWriter),
            ("Markdown Mode (Cmd+Alt+3 / F3)", MenuAction::ViewMarkdown),
            ("Split Mode    (Cmd+Alt+4 / F4)", MenuAction::ViewSplit),
            ("Pure Text / Code (Cmd+Alt+5 / F5)", MenuAction::ViewPureText),
            ("Word Wrap", MenuAction::WordWrap),
            ("Syntax Highlighting (Cmd+Alt+6 / F6)", MenuAction::SyntaxHighlighting),
        ],
        ActiveMenu::Theme => vec![
            ("Dark Antigravity", MenuAction::ThemeDarkAntigravity),
            ("Retro Green CRT", MenuAction::ThemeRetroGreen),
            ("Retro Amber CRT", MenuAction::ThemeRetroAmber),
            ("Dracula Standard", MenuAction::ThemeDracula),
            ("DOS Edit (Classic Blue)", MenuAction::ThemeDosEdit),
            ("VT100 Pure ASCII", MenuAction::ThemeVT100),
        ],
        ActiveMenu::Help => vec![
            ("About art", MenuAction::About),
            ("Maintainer: Roland Huber", MenuAction::About),
            ("Original Creator: Sean Malseed", MenuAction::About),
            ("Cmd+Alt+2:Writer 3:MD 4:Split 5:Text", MenuAction::NoOp),
            ("Cmd+Alt+6 / F6 / Ctrl+H: Syntax Highlight", MenuAction::NoOp),
            ("Shift+Arrows: Select text", MenuAction::NoOp),
            ("Ctrl+D: Duplicate Line", MenuAction::NoOp),
            ("Alt/Cmd+Up/Down: Move Line Up/Down", MenuAction::NoOp),
            ("Tab / Shift+Tab: Indent / Unindent", MenuAction::NoOp),
            ("Ctrl+S:Save  Ctrl+Q:Quit", MenuAction::NoOp),
        ],
        ActiveMenu::None => vec![],
    }
}

fn next_menu(m: ActiveMenu, is_pure_text: bool) -> ActiveMenu {
    match m {
        ActiveMenu::File => ActiveMenu::Edit,
        ActiveMenu::Edit => if is_pure_text { ActiveMenu::Manipulation } else { ActiveMenu::Format },
        ActiveMenu::Format => ActiveMenu::View,
        ActiveMenu::Manipulation => ActiveMenu::View,
        ActiveMenu::View => ActiveMenu::Theme,
        ActiveMenu::Theme => ActiveMenu::Help,
        _ => ActiveMenu::File,
    }
}

fn prev_menu(m: ActiveMenu, is_pure_text: bool) -> ActiveMenu {
    match m {
        ActiveMenu::Edit => ActiveMenu::File,
        ActiveMenu::Format => ActiveMenu::Edit,
        ActiveMenu::Manipulation => ActiveMenu::Edit,
        ActiveMenu::View => if is_pure_text { ActiveMenu::Manipulation } else { ActiveMenu::Format },
        ActiveMenu::Theme => ActiveMenu::View,
        ActiveMenu::Help => ActiveMenu::Theme,
        _ => ActiveMenu::Help,
    }
}

fn copy_to_system_clipboard(text: &str) {
    use base64::prelude::*;
    use std::io::Write;
    let b64 = BASE64_STANDARD.encode(text);
    print!("\x1B]52;c;{}\x07", b64);
    let _ = std::io::stdout().flush();

    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};
        if let Ok(mut child) = Command::new("clip.exe").stdin(Stdio::piped()).spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let mut initial_file = None;
    let mut initial_mode = None;
    let mut initial_theme = None;

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-h" || arg == "--help" {
            println!("art Terminal / TUI v0.30.3");
            println!("Usage: art [OPTIONS] [FILE]\n");
            println!("  -t, --text, --code Set initial mode to Pure Text / Code editor");
            println!("  --mode writer|markdown|split|pure-text|code");
            println!("  --theme dark-antigravity|retro-green|retro-amber|dracula|dos-edit|vt100");
            println!("  --vt100, --ascii   Force VT100/ASCII mode");
            println!("  -h, --help         Help");
            println!("  -v, --version      Version");
            return Ok(());
        } else if arg == "-v" || arg == "--version" {
            println!("art Terminal / TUI v0.30.3");
            return Ok(());
        } else if arg == "--vt100" || arg == "--ascii" {
            initial_theme = Some(Theme::VT100);
        } else if arg == "-t" || arg == "--text" || arg == "--pure-text" || arg == "--code" {
            initial_mode = Some(ViewMode::PureText);
        } else if (arg == "--mode") && i + 1 < args.len() {
            match args[i + 1].to_lowercase().as_str() {
                "writer" => initial_mode = Some(ViewMode::Writer),
                "markdown" => initial_mode = Some(ViewMode::Markdown),
                "split" => initial_mode = Some(ViewMode::Split),
                "pure-text" | "text" | "code" => initial_mode = Some(ViewMode::PureText),
                _ => {}
            }
            i += 1;
        } else if let Some(m) = arg.strip_prefix("--mode=") {
            match m.to_lowercase().as_str() {
                "writer" => initial_mode = Some(ViewMode::Writer),
                "markdown" => initial_mode = Some(ViewMode::Markdown),
                "split" => initial_mode = Some(ViewMode::Split),
                "pure-text" | "text" | "code" => initial_mode = Some(ViewMode::PureText),
                _ => {}
            }
        } else if (arg == "--theme") && i + 1 < args.len() {
            match args[i + 1].to_lowercase().as_str() {
                "retro-green" => initial_theme = Some(Theme::RetroGreen),
                "retro-amber" => initial_theme = Some(Theme::RetroAmber),
                "dracula" => initial_theme = Some(Theme::Dracula),
                "dos-edit" | "dos" => initial_theme = Some(Theme::DosEdit),
                "vt100" | "ascii" => initial_theme = Some(Theme::VT100),
                _ => initial_theme = Some(Theme::DarkAntigravity),
            }
            i += 1;
        } else if let Some(t) = arg.strip_prefix("--theme=") {
            match t.to_lowercase().as_str() {
                "retro-green" => initial_theme = Some(Theme::RetroGreen),
                "retro-amber" => initial_theme = Some(Theme::RetroAmber),
                "dracula" => initial_theme = Some(Theme::Dracula),
                "dos-edit" | "dos" => initial_theme = Some(Theme::DosEdit),
                "vt100" | "ascii" => initial_theme = Some(Theme::VT100),
                _ => initial_theme = Some(Theme::DarkAntigravity),
            }
        } else if !arg.starts_with('-') && initial_file.is_none() {
            initial_file = Some(arg.clone());
        }
        i += 1;
    }

    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let _ = execute!(stdout, event::PushKeyboardEnhancementFlags(event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES));
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(initial_file, initial_mode, initial_theme);
    let res = run_app(&mut terminal, &mut app);

    let _ = execute!(terminal.backend_mut(), event::PopKeyboardEnhancementFlags);
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    if let Err(err) = res {
        println!("Error: {err:?}");
    }
    Ok(())
}

fn run_app<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
) -> io::Result<()> {
    loop {
        terminal.draw(|f| ui(f, app))?;

        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == event::KeyEventKind::Release {
                    continue;
                }
                if app.is_welcome_screen {
                    app.clear_welcome();
                }
                // Compute inner height: full height minus menubar(1) + statusbar(1) + borders(2).
                let ts = terminal.size()?;
                let inner_h = ts.height.saturating_sub(4) as usize;
                let inner_w = match app.view_mode {
                    ViewMode::Split => (ts.width / 2).saturating_sub(8) as usize,
                    ViewMode::Writer => ts.width.saturating_sub(2) as usize,
                    _ => ts.width.saturating_sub(8) as usize,
                };

                let shift = key.modifiers.contains(KeyModifiers::SHIFT);
                let ctrl  = key.modifiers.contains(KeyModifiers::CONTROL);
                let alt   = key.modifiers.contains(KeyModifiers::ALT);
                let cmd   = key.modifiers.contains(KeyModifiers::SUPER);

                // Option+Cmd / Cmd+Alt / Ctrl+Alt modifier check for macOS & cross-platform
                let is_cmd_alt = (alt && cmd) || (ctrl && alt) || (ctrl && cmd);
                let has_alt_or_cmd = alt || cmd || is_cmd_alt;

                // ── macOS Option unicode characters (Terminal.app native Option mapping) ──
                let is_mac_option_char = match key.code {
                    KeyCode::Char('ƒ') | KeyCode::Char('Ï') => { app.open_menu(ActiveMenu::File); true }
                    KeyCode::Char('´') => { app.open_menu(ActiveMenu::Edit); true }
                    KeyCode::Char('ø') | KeyCode::Char('Ø') => {
                        if app.view_mode == ViewMode::PureText {
                            app.open_menu(ActiveMenu::Manipulation);
                        } else {
                            app.open_menu(ActiveMenu::Format);
                        }
                        true
                    }
                    KeyCode::Char('√') | KeyCode::Char('◊') => { app.open_menu(ActiveMenu::View); true }
                    KeyCode::Char('†') | KeyCode::Char('‡') => { app.open_menu(ActiveMenu::Theme); true }
                    KeyCode::Char('˙') | KeyCode::Char('Ó') => { app.open_menu(ActiveMenu::Help); true }
                    KeyCode::Char('™') => { app.view_mode = ViewMode::Writer; app.save_settings(); true }
                    KeyCode::Char('£') => { app.view_mode = ViewMode::Markdown; app.save_settings(); true }
                    KeyCode::Char('¢') => { app.view_mode = ViewMode::Split; app.save_settings(); true }
                    KeyCode::Char('∞') => { app.view_mode = ViewMode::PureText; app.save_settings(); true }
                    KeyCode::Char('§') => { app.execute_action(MenuAction::SyntaxHighlighting, inner_h); true }
                    _ => false,
                };
                if is_mac_option_char {
                    continue;
                }

                // ── Mode switching shortcuts (Cmd+Alt+2..6, Alt+2..6, F2..F6) ─────
                if has_alt_or_cmd {
                    match key.code {
                        KeyCode::Char('2') => { app.view_mode = ViewMode::Writer; app.save_settings(); continue; }
                        KeyCode::Char('3') => { app.view_mode = ViewMode::Markdown; app.save_settings(); continue; }
                        KeyCode::Char('4') => { app.view_mode = ViewMode::Split; app.save_settings(); continue; }
                        KeyCode::Char('5') => { app.view_mode = ViewMode::PureText; app.save_settings(); continue; }
                        KeyCode::Char('6') => { app.execute_action(MenuAction::SyntaxHighlighting, inner_h); continue; }
                        _ => {}
                    }
                }

                // ── Alt / Cmd+Alt key: open menus ────────────────────────
                if has_alt_or_cmd && !ctrl {
                    match key.code {
                        KeyCode::Char('f') | KeyCode::Char('F') => { app.open_menu(ActiveMenu::File); continue; }
                        KeyCode::Char('e') | KeyCode::Char('E') => { app.open_menu(ActiveMenu::Edit); continue; }
                        KeyCode::Char('o') | KeyCode::Char('O') => {
                            if app.view_mode == ViewMode::PureText {
                                app.open_menu(ActiveMenu::Manipulation);
                            } else {
                                app.open_menu(ActiveMenu::Format);
                            }
                            continue;
                        }
                        KeyCode::Char('v') | KeyCode::Char('V') => { app.open_menu(ActiveMenu::View); continue; }
                        KeyCode::Char('t') | KeyCode::Char('T') => { app.open_menu(ActiveMenu::Theme); continue; }
                        KeyCode::Char('h') | KeyCode::Char('H') => { app.open_menu(ActiveMenu::Help); continue; }
                        KeyCode::Up => { app.move_line_up(); continue; }
                        KeyCode::Down => { app.move_line_down(); continue; }
                        KeyCode::Home => { app.move_to_file_start(); continue; }
                        KeyCode::End => { app.move_to_file_end(inner_h, inner_w); continue; }
                        _ => {}
                    }
                }

                // ── Popup handling ───────────────────────────────────────
                if app.popup != PopupState::None {
                    match app.popup.clone() {
                        PopupState::QuitConfirm => {
                            match key.code {
                                KeyCode::Char('y') | KeyCode::Char('Y') => {
                                    app.quit_after_save = true;
                                    app.save_file();
                                    if !matches!(app.popup, PopupState::SaveAs { .. } | PopupState::NextcloudSaveAs { .. } | PopupState::OverwriteConfirm { .. }) {
                                        app.should_quit = true;
                                        app.popup = PopupState::None;
                                    }
                                }
                                KeyCode::Char('n') | KeyCode::Char('N') => {
                                    app.should_quit = true;
                                    app.popup = PopupState::None;
                                }
                                KeyCode::Enter => {
                                    if app.dirty {
                                        app.quit_after_save = true;
                                        app.save_file();
                                        if !matches!(app.popup, PopupState::SaveAs { .. } | PopupState::NextcloudSaveAs { .. } | PopupState::OverwriteConfirm { .. }) {
                                            app.should_quit = true;
                                            app.popup = PopupState::None;
                                        }
                                    } else {
                                        app.should_quit = true;
                                        app.popup = PopupState::None;
                                    }
                                }
                                KeyCode::Esc => {
                                    app.popup = PopupState::None;
                                    app.status_msg = "Quit cancelled".to_string();
                                }
                                _ => {}
                            }
                        }
                        PopupState::SaveAs { mut current_dir, mut entries, mut selected, mut scroll, mut input, input_focused } => {
                            match key.code {
                                KeyCode::Tab => {
                                    if app.nextcloud_config.is_none() {
                                        app.nextcloud_config = artfultype_rs_lib::nextcloud::load_config(None);
                                    }
                                    if let Some(ref cfg) = app.nextcloud_config {
                                        if let Ok(nc_entries) = artfultype_rs_lib::nextcloud::list_folder_sync(cfg, "") {
                                            let clean_input = input.trim_start_matches("☁ ").trim().to_string();
                                            app.popup = PopupState::NextcloudSaveAs {
                                                remote_path: "".to_string(),
                                                entries: nc_entries,
                                                selected: 0,
                                                scroll: 0,
                                                input: if clean_input.is_empty() { app.file_name.trim_start_matches("☁ ").trim().to_string() } else { clean_input },
                                                input_focused: true,
                                            };
                                        } else {
                                            app.status_msg = "Failed to list Nextcloud folder".to_string();
                                        }
                                    } else {
                                        let (url, user, pass) = ("https://cloud.example.com".to_string(), "".to_string(), "".to_string());
                                        app.popup = PopupState::NextcloudConfig {
                                            url_input: url,
                                            username_input: user,
                                            password_input: pass,
                                            focus: 0,
                                            status_msg: "Nextcloud is not linked yet. Enter credentials below:".to_string(),
                                        };
                                    }
                                }
                                KeyCode::Up => {
                                    if selected > 0 {
                                        selected -= 1;
                                        if selected < scroll {
                                            scroll = selected;
                                        }
                                        if !entries.is_empty() && selected < entries.len() {
                                            let (name, is_dir) = &entries[selected];
                                            if !*is_dir {
                                                input = name.clone();
                                            }
                                        }
                                    }
                                    app.popup = PopupState::SaveAs { current_dir, entries, selected, scroll, input, input_focused };
                                }
                                KeyCode::Down => {
                                    if !entries.is_empty() && selected < entries.len() - 1 {
                                        selected += 1;
                                        if selected >= scroll + 12 {
                                            scroll = selected.saturating_sub(11);
                                        }
                                        if !entries.is_empty() && selected < entries.len() {
                                            let (name, is_dir) = &entries[selected];
                                            if !*is_dir {
                                                input = name.clone();
                                            }
                                        }
                                    }
                                    app.popup = PopupState::SaveAs { current_dir, entries, selected, scroll, input, input_focused };
                                }
                                KeyCode::Char('s') | KeyCode::Char('S') if ctrl => {
                                    if !input.is_empty() {
                                        let clean_input = input.trim_start_matches("☁ ").trim().to_string();
                                        let file_path = std::path::PathBuf::from(&current_dir).join(&clean_input);
                                        let target_str = file_path.to_string_lossy().to_string();
                                        if file_path.exists() {
                                            app.popup = PopupState::OverwriteConfirm {
                                                target_path: Some(target_str),
                                                target_remote_path: None,
                                                file_name: clean_input,
                                                is_nextcloud: false,
                                            };
                                        } else {
                                            app.file_path = Some(target_str);
                                            app.file_name = clean_input;
                                            app.is_nextcloud_file = false;
                                            app.nextcloud_remote_path = None;
                                            app.save_file();
                                            app.popup = PopupState::None;
                                            if app.quit_after_save {
                                                app.should_quit = true;
                                            }
                                        }
                                    }
                                }
                                KeyCode::Enter => {
                                    if ctrl && !input.is_empty() {
                                        let clean_input = input.trim_start_matches("☁ ").trim().to_string();
                                        let file_path = std::path::PathBuf::from(&current_dir).join(&clean_input);
                                        let target_str = file_path.to_string_lossy().to_string();
                                        if file_path.exists() {
                                            app.popup = PopupState::OverwriteConfirm {
                                                target_path: Some(target_str),
                                                target_remote_path: None,
                                                file_name: clean_input,
                                                is_nextcloud: false,
                                            };
                                        } else {
                                            app.file_path = Some(target_str);
                                            app.file_name = clean_input;
                                            app.is_nextcloud_file = false;
                                            app.nextcloud_remote_path = None;
                                            app.save_file();
                                            app.popup = PopupState::None;
                                            if app.quit_after_save {
                                                app.should_quit = true;
                                            }
                                        }
                                    } else {
                                        let is_on_dir = !entries.is_empty() && selected < entries.len() && entries[selected].1;
                                        if is_on_dir {
                                            let name = &entries[selected].0;
                                            let new_path = if name == ".." {
                                                std::path::PathBuf::from(&current_dir).parent().unwrap_or_else(|| std::path::Path::new(&current_dir)).to_path_buf()
                                            } else {
                                                std::path::PathBuf::from(&current_dir).join(name)
                                            };
                                            if let Ok(canon) = new_path.canonicalize() {
                                                current_dir = canon.to_string_lossy().to_string();
                                                entries = read_dir_entries(&current_dir);
                                                selected = 0;
                                                scroll = 0;
                                                app.popup = PopupState::SaveAs { current_dir, entries, selected, scroll, input, input_focused };
                                            }
                                        } else if !input.is_empty() {
                                            let clean_input = input.trim_start_matches("☁ ").trim().to_string();
                                            let file_path = std::path::PathBuf::from(&current_dir).join(&clean_input);
                                            let target_str = file_path.to_string_lossy().to_string();
                                            if file_path.exists() {
                                                app.popup = PopupState::OverwriteConfirm {
                                                    target_path: Some(target_str),
                                                    target_remote_path: None,
                                                    file_name: clean_input,
                                                    is_nextcloud: false,
                                                };
                                            } else {
                                                app.file_path = Some(target_str);
                                                app.file_name = clean_input;
                                                app.is_nextcloud_file = false;
                                                app.nextcloud_remote_path = None;
                                                app.save_file();
                                                app.popup = PopupState::None;
                                                if app.quit_after_save {
                                                    app.should_quit = true;
                                                }
                                            }
                                        }
                                    }
                                }
                                KeyCode::Esc => {
                                    app.popup = PopupState::None;
                                    app.quit_after_save = false;
                                }
                                KeyCode::Char(c) => {
                                    if !ctrl && !alt {
                                        input.push(c);
                                        app.popup = PopupState::SaveAs { current_dir, entries, selected, scroll, input, input_focused };
                                    }
                                }
                                KeyCode::Backspace => {
                                    input.pop();
                                    app.popup = PopupState::SaveAs { current_dir, entries, selected, scroll, input, input_focused };
                                }
                                _ => {}
                            }
                        }
                        PopupState::NextcloudSaveAs { mut remote_path, mut entries, mut selected, mut scroll, mut input, input_focused } => {
                            match key.code {
                                KeyCode::Tab => {
                                    let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).to_string_lossy().to_string();
                                    let entries = read_dir_entries(&dir);
                                    let clean_input = input.trim_start_matches("☁ ").trim().to_string();
                                    app.popup = PopupState::SaveAs {
                                        current_dir: dir,
                                        entries,
                                        selected: 0,
                                        scroll: 0,
                                        input: if clean_input.is_empty() { app.file_name.trim_start_matches("☁ ").trim().to_string() } else { clean_input },
                                        input_focused: true,
                                    };
                                }
                                KeyCode::Up => {
                                    if selected > 0 {
                                        selected -= 1;
                                        if selected < scroll {
                                            scroll = selected;
                                        }
                                        if !entries.is_empty() && selected < entries.len() {
                                            let item = &entries[selected];
                                            if !item.is_dir {
                                                input = item.name.clone();
                                            }
                                        }
                                    }
                                    app.popup = PopupState::NextcloudSaveAs { remote_path, entries, selected, scroll, input, input_focused };
                                }
                                KeyCode::Down => {
                                    if !entries.is_empty() && selected < entries.len() - 1 {
                                        selected += 1;
                                        if selected >= scroll + 12 {
                                            scroll = selected.saturating_sub(11);
                                        }
                                        if !entries.is_empty() && selected < entries.len() {
                                            let item = &entries[selected];
                                            if !item.is_dir {
                                                input = item.name.clone();
                                            }
                                        }
                                    }
                                    app.popup = PopupState::NextcloudSaveAs { remote_path, entries, selected, scroll, input, input_focused };
                                }
                                KeyCode::Char('s') | KeyCode::Char('S') if ctrl => {
                                    if !input.is_empty() {
                                        let clean_name = input.trim_start_matches("☁ ").trim().to_string();
                                        let remote_target = if remote_path.is_empty() {
                                            clean_name.clone()
                                        } else {
                                            format!("{}/{}", remote_path, clean_name)
                                        };
                                        let exists = entries.iter().any(|e| !e.is_dir && e.name == clean_name);
                                        if exists {
                                            app.popup = PopupState::OverwriteConfirm {
                                                target_path: None,
                                                target_remote_path: Some(remote_target),
                                                file_name: clean_name,
                                                is_nextcloud: true,
                                            };
                                        } else {
                                            app.is_nextcloud_file = true;
                                            app.nextcloud_remote_path = Some(remote_target);
                                            app.file_name = format!("☁ {}", clean_name);
                                            app.file_path = None;
                                            app.save_file();
                                            app.popup = PopupState::None;
                                            if app.quit_after_save {
                                                app.should_quit = true;
                                            }
                                        }
                                    }
                                }
                                KeyCode::Enter => {
                                    if ctrl && !input.is_empty() {
                                        let clean_name = input.trim_start_matches("☁ ").trim().to_string();
                                        let remote_target = if remote_path.is_empty() {
                                            clean_name.clone()
                                        } else {
                                            format!("{}/{}", remote_path, clean_name)
                                        };
                                        let exists = entries.iter().any(|e| !e.is_dir && e.name == clean_name);
                                        if exists {
                                            app.popup = PopupState::OverwriteConfirm {
                                                target_path: None,
                                                target_remote_path: Some(remote_target),
                                                file_name: clean_name,
                                                is_nextcloud: true,
                                            };
                                        } else {
                                            app.is_nextcloud_file = true;
                                            app.nextcloud_remote_path = Some(remote_target);
                                            app.file_name = format!("☁ {}", clean_name);
                                            app.file_path = None;
                                            app.save_file();
                                            app.popup = PopupState::None;
                                            if app.quit_after_save {
                                                app.should_quit = true;
                                            }
                                        }
                                    } else {
                                        let is_on_dir = !entries.is_empty() && selected < entries.len() && entries[selected].is_dir;
                                        if is_on_dir {
                                            let item = &entries[selected];
                                            if item.name == ".." {
                                                let parent = std::path::Path::new(&remote_path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                                                if let Some(ref cfg) = app.nextcloud_config {
                                                    if let Ok(mut new_entries) = artfultype_rs_lib::nextcloud::list_folder_sync(cfg, &parent) {
                                                        if !parent.is_empty() {
                                                            let p_dir = std::path::Path::new(&parent).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                                                            new_entries.insert(0, artfultype_rs_lib::nextcloud::NextcloudEntry { name: "..".to_string(), path: p_dir, is_dir: true, size: 0, modified: String::new() });
                                                        }
                                                        remote_path = parent;
                                                        entries = new_entries;
                                                        selected = 0;
                                                        scroll = 0;
                                                    }
                                                }
                                            } else if let Some(ref cfg) = app.nextcloud_config {
                                                if let Ok(mut new_entries) = artfultype_rs_lib::nextcloud::list_folder_sync(cfg, &item.path) {
                                                    new_entries.insert(0, artfultype_rs_lib::nextcloud::NextcloudEntry { name: "..".to_string(), path: remote_path.clone(), is_dir: true, size: 0, modified: String::new() });
                                                    remote_path = item.path.clone();
                                                    entries = new_entries;
                                                    selected = 0;
                                                    scroll = 0;
                                                }
                                            }
                                            app.popup = PopupState::NextcloudSaveAs { remote_path, entries, selected, scroll, input, input_focused };
                                        } else if !input.is_empty() {
                                            let clean_name = input.trim_start_matches("☁ ").trim().to_string();
                                            let remote_target = if remote_path.is_empty() {
                                                clean_name.clone()
                                            } else {
                                                format!("{}/{}", remote_path, clean_name)
                                            };
                                            let exists = entries.iter().any(|e| !e.is_dir && e.name == clean_name);
                                            if exists {
                                                app.popup = PopupState::OverwriteConfirm {
                                                    target_path: None,
                                                    target_remote_path: Some(remote_target),
                                                    file_name: clean_name,
                                                    is_nextcloud: true,
                                                };
                                            } else {
                                                app.is_nextcloud_file = true;
                                                app.nextcloud_remote_path = Some(remote_target);
                                                app.file_name = format!("☁ {}", clean_name);
                                                app.file_path = None;
                                                app.save_file();
                                                app.popup = PopupState::None;
                                                if app.quit_after_save {
                                                    app.should_quit = true;
                                                }
                                            }
                                        }
                                    }
                                }
                                KeyCode::Esc => {
                                    app.popup = PopupState::None;
                                    app.quit_after_save = false;
                                }
                                KeyCode::Char(c) => {
                                    if !ctrl && !alt {
                                        input.push(c);
                                        app.popup = PopupState::NextcloudSaveAs { remote_path, entries, selected, scroll, input, input_focused };
                                    }
                                }
                                KeyCode::Backspace => {
                                    input.pop();
                                    app.popup = PopupState::NextcloudSaveAs { remote_path, entries, selected, scroll, input, input_focused };
                                }
                                _ => {}
                            }
                        }
                        PopupState::OverwriteConfirm { target_path, target_remote_path, file_name, is_nextcloud } => {
                            match key.code {
                                KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                                    if is_nextcloud {
                                        if let Some(remote_target) = target_remote_path {
                                            app.is_nextcloud_file = true;
                                            app.nextcloud_remote_path = Some(remote_target);
                                            app.file_name = format!("☁ {}", file_name);
                                            app.file_path = None;
                                            app.save_file();
                                        }
                                    } else {
                                        if let Some(local_path) = target_path {
                                            app.file_path = Some(local_path);
                                            app.file_name = file_name;
                                            app.is_nextcloud_file = false;
                                            app.nextcloud_remote_path = None;
                                            app.save_file();
                                        }
                                    }
                                    app.popup = PopupState::None;
                                    if app.quit_after_save {
                                        app.should_quit = true;
                                    }
                                }
                                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                                    app.popup = PopupState::None;
                                    app.quit_after_save = false;
                                    app.status_msg = "Save cancelled".to_string();
                                }
                                _ => {}
                            }
                        }
                        PopupState::OpenFile { mut current_dir, mut entries, mut selected, mut scroll } => {
                            match key.code {
                                KeyCode::Up => {
                                    if selected > 0 {
                                        selected -= 1;
                                        if selected < scroll {
                                            scroll = selected;
                                        }
                                    }
                                    app.popup = PopupState::OpenFile { current_dir, entries, selected, scroll };
                                }
                                KeyCode::Down => {
                                    if !entries.is_empty() && selected < entries.len() - 1 {
                                        selected += 1;
                                        // Assume height of 15 items in popup
                                        if selected >= scroll + 15 {
                                            scroll = selected.saturating_sub(14);
                                        }
                                    }
                                    app.popup = PopupState::OpenFile { current_dir, entries, selected, scroll };
                                }
                                KeyCode::Enter => {
                                    if !entries.is_empty() && selected < entries.len() {
                                        let (name, is_dir) = &entries[selected];
                                        if *is_dir {
                                            let new_path = if name == ".." {
                                                std::path::PathBuf::from(&current_dir).parent().unwrap_or_else(|| std::path::Path::new(&current_dir)).to_path_buf()
                                            } else {
                                                std::path::PathBuf::from(&current_dir).join(name)
                                            };
                                            if let Ok(canon) = new_path.canonicalize() {
                                                current_dir = canon.to_string_lossy().to_string();
                                                entries = read_dir_entries(&current_dir);
                                                selected = 0;
                                                scroll = 0;
                                                app.popup = PopupState::OpenFile { current_dir, entries, selected, scroll };
                                            }
                                        } else {
                                            let file_path = std::path::PathBuf::from(&current_dir).join(name);
                                            if let Ok(content) = std::fs::read_to_string(&file_path) {
                                                app.is_welcome_screen = false;
                                                app.content = content;
                                                app.file_path = Some(file_path.to_string_lossy().to_string());
                                                app.file_name = name.clone();
                                                app.cursor_line = 0;
                                                app.cursor_col = 0;
                                                app.scroll_top = 0;
                                                app.scroll_left = 0;
                                                app.dirty = false;
                                                app.history.clear();
                                                app.history_index = 0;
                                                app.snapshot();
                                                app.clear_selection();
                                                app.status_msg = format!("Opened file {}", app.file_name);
                                            } else {
                                                app.status_msg = format!("Failed to read file: {}", file_path.to_string_lossy());
                                            }
                                            app.popup = PopupState::None;
                                        }
                                    }
                                }
                                 KeyCode::Esc => app.popup = PopupState::None,
                                 KeyCode::Tab => {
                                     if app.nextcloud_config.is_none() {
                                         app.nextcloud_config = artfultype_rs_lib::nextcloud::load_config(None);
                                     }
                                     if let Some(ref cfg) = app.nextcloud_config {
                                         if let Ok(nc_entries) = artfultype_rs_lib::nextcloud::list_folder_sync(cfg, "") {
                                             app.popup = PopupState::NextcloudOpen {
                                                 remote_path: "".to_string(),
                                                 entries: nc_entries,
                                                 selected: 0,
                                                 scroll: 0,
                                             };
                                         } else {
                                             app.status_msg = "Failed to list Nextcloud folder".to_string();
                                         }
                                     } else {
                                         app.status_msg = "Nextcloud is not linked (Press Ctrl+L)".to_string();
                                     }
                                 }
                                 _ => {}
                             }
                         }
                         PopupState::NextcloudConfig { mut url_input, mut username_input, mut password_input, mut focus, mut status_msg } => {
                             match key.code {
                                 KeyCode::Tab | KeyCode::Down => {
                                     focus = (focus + 1) % 5;
                                     app.popup = PopupState::NextcloudConfig { url_input, username_input, password_input, focus, status_msg };
                                 }
                                 KeyCode::Up => {
                                     focus = if focus == 0 { 4 } else { focus - 1 };
                                     app.popup = PopupState::NextcloudConfig { url_input, username_input, password_input, focus, status_msg };
                                 }
                                 KeyCode::Enter => {
                                     if focus == 4 {
                                         let _ = artfultype_rs_lib::nextcloud::unlink_config(None);
                                         app.nextcloud_config = None;
                                         app.popup = PopupState::None;
                                         app.status_msg = "Unlinked Nextcloud account".to_string();
                                     } else {
                                         let cfg = artfultype_rs_lib::nextcloud::NextcloudConfig {
                                             server_url: url_input.clone(),
                                             username: username_input.clone(),
                                             password: password_input.clone(),
                                             enabled: true,
                                         };
                                         match artfultype_rs_lib::nextcloud::test_connection_sync(&cfg) {
                                             Ok(msg) => {
                                                 let _ = artfultype_rs_lib::nextcloud::save_config(None, &cfg);
                                                 app.nextcloud_config = Some(cfg);
                                                 app.popup = PopupState::None;
                                                 app.status_msg = format!("Nextcloud linked: {}", msg);
                                             }
                                             Err(err) => {
                                                 status_msg = format!("Error: {}", err);
                                                 app.popup = PopupState::NextcloudConfig { url_input, username_input, password_input, focus, status_msg };
                                             }
                                         }
                                     }
                                 }
                                 KeyCode::Esc => app.popup = PopupState::None,
                                 KeyCode::Char(c) => {
                                     match focus {
                                         0 => url_input.push(c),
                                         1 => username_input.push(c),
                                         2 => password_input.push(c),
                                         _ => {}
                                     }
                                     app.popup = PopupState::NextcloudConfig { url_input, username_input, password_input, focus, status_msg };
                                 }
                                 KeyCode::Backspace => {
                                     match focus {
                                         0 => { url_input.pop(); }
                                         1 => { username_input.pop(); }
                                         2 => { password_input.pop(); }
                                         _ => {}
                                     }
                                     app.popup = PopupState::NextcloudConfig { url_input, username_input, password_input, focus, status_msg };
                                 }
                                 _ => {}
                             }
                         }
                         PopupState::NextcloudOpen { mut remote_path, mut entries, mut selected, mut scroll } => {
                             match key.code {
                                 KeyCode::Char('1') | KeyCode::Char('2') => {
                                     let rec_idx = if key.code == KeyCode::Char('1') { 0 } else { 1 };
                                     if let Some((path, name)) = app.recent_nextcloud_files.get(rec_idx).cloned() {
                                         if let Some(ref cfg) = app.nextcloud_config {
                                             match artfultype_rs_lib::nextcloud::read_file_sync(cfg, &path) {
                                                 Ok(content) => {
                                                     app.content = content;
                                                     app.file_path = None;
                                                     app.is_nextcloud_file = true;
                                                     app.nextcloud_remote_path = Some(path.clone());
                                                     app.file_name = format!("☁ {}", name);
                                                     app.cursor_line = 0;
                                                     app.cursor_col = 0;
                                                     app.scroll_top = 0;
                                                     app.scroll_left = 0;
                                                     app.dirty = false;
                                                     app.history.clear();
                                                     app.history_index = 0;
                                                     app.snapshot();
                                                     app.clear_selection();
                                                     app.record_nextcloud_recent(&path, &name);
                                                     app.status_msg = format!("Opened recent Nextcloud file: {}", name);
                                                 }
                                                 Err(e) => app.status_msg = format!("Failed to open recent Nextcloud file: {}", e),
                                             }
                                         }
                                         app.popup = PopupState::None;
                                     }
                                 }
                                 KeyCode::Up => {
                                     if selected > 0 {
                                         selected -= 1;
                                         if selected < scroll { scroll = selected; }
                                     }
                                     app.popup = PopupState::NextcloudOpen { remote_path, entries, selected, scroll };
                                 }
                                 KeyCode::Down => {
                                     if !entries.is_empty() && selected < entries.len() - 1 {
                                         selected += 1;
                                         if selected >= scroll + 15 { scroll = selected.saturating_sub(14); }
                                     }
                                     app.popup = PopupState::NextcloudOpen { remote_path, entries, selected, scroll };
                                 }
                                 KeyCode::Tab => {
                                     let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).to_string_lossy().to_string();
                                     let local_entries = read_dir_entries(&dir);
                                     app.popup = PopupState::OpenFile { current_dir: dir, entries: local_entries, selected: 0, scroll: 0 };
                                 }
                                 KeyCode::Enter => {
                                     if !entries.is_empty() && selected < entries.len() {
                                         let item = entries[selected].clone();
                                         if item.is_dir {
                                             if item.name == ".." {
                                                 let parent = std::path::Path::new(&remote_path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                                                 if let Some(ref cfg) = app.nextcloud_config {
                                                     if let Ok(mut new_entries) = artfultype_rs_lib::nextcloud::list_folder_sync(cfg, &parent) {
                                                         if !parent.is_empty() {
                                                             let p_dir = std::path::Path::new(&parent).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                                                             new_entries.insert(0, artfultype_rs_lib::nextcloud::NextcloudEntry { name: "..".to_string(), path: p_dir, is_dir: true, size: 0, modified: String::new() });
                                                         }
                                                         remote_path = parent;
                                                         entries = new_entries;
                                                         selected = 0;
                                                         scroll = 0;
                                                     }
                                                 }
                                             } else if let Some(ref cfg) = app.nextcloud_config {
                                                 if let Ok(mut new_entries) = artfultype_rs_lib::nextcloud::list_folder_sync(cfg, &item.path) {
                                                     new_entries.insert(0, artfultype_rs_lib::nextcloud::NextcloudEntry { name: "..".to_string(), path: remote_path.clone(), is_dir: true, size: 0, modified: String::new() });
                                                     remote_path = item.path;
                                                     entries = new_entries;
                                                     selected = 0;
                                                     scroll = 0;
                                                 }
                                             }
                                             app.popup = PopupState::NextcloudOpen { remote_path, entries, selected, scroll };
                                         } else {
                                             if let Some(ref cfg) = app.nextcloud_config {
                                                 match artfultype_rs_lib::nextcloud::read_file_sync(cfg, &item.path) {
                                                     Ok(content) => {
                                                         app.content = content;
                                                         app.file_path = None;
                                                         app.is_nextcloud_file = true;
                                                         app.nextcloud_remote_path = Some(item.path.clone());
                                                         app.file_name = format!("☁ {}", item.name);
                                                         app.cursor_line = 0;
                                                         app.cursor_col = 0;
                                                         app.scroll_top = 0;
                                                         app.scroll_left = 0;
                                                         app.dirty = false;
                                                         app.history.clear();
                                                         app.history_index = 0;
                                                         app.snapshot();
                                                         app.clear_selection();
                                                         app.record_nextcloud_recent(&item.path, &item.name);
                                                         app.status_msg = format!("Opened Nextcloud file: {}", item.name);
                                                     }
                                                     Err(e) => app.status_msg = format!("Failed to open Nextcloud file: {}", e),
                                                 }
                                             }
                                             app.popup = PopupState::None;
                                         }
                                     }
                                 }
                                 KeyCode::Esc => app.popup = PopupState::None,
                                 _ => {}
                             }
                         }
                        PopupState::Search { mut input } => {
                            match key.code {
                                KeyCode::Enter => {
                                    let query = input.clone();
                                    app.popup = PopupState::None;
                                    app.search_forward(&query, inner_h);
                                }
                                KeyCode::Esc => app.popup = PopupState::None,
                                KeyCode::Char(c) => {
                                    input.push(c);
                                    app.popup = PopupState::Search { input };
                                }
                                KeyCode::Backspace => {
                                    input.pop();
                                    app.popup = PopupState::Search { input };
                                }
                                _ => {}
                            }
                        }
                        PopupState::SearchReplace { mut search, mut replace, step } => {
                            match key.code {
                                KeyCode::Enter => {
                                    if step == 0 {
                                        app.popup = PopupState::SearchReplace { search, replace, step: 1 };
                                    } else {
                                        let s = search.clone();
                                        let r = replace.clone();
                                        app.popup = PopupState::None;
                                        app.replace_all(&s, &r);
                                    }
                                }
                                KeyCode::Esc => app.popup = PopupState::None,
                                KeyCode::Char(c) => {
                                    if step == 0 {
                                        search.push(c);
                                    } else {
                                        replace.push(c);
                                    }
                                    app.popup = PopupState::SearchReplace { search, replace, step };
                                }
                                KeyCode::Backspace => {
                                    if step == 0 {
                                        search.pop();
                                    } else {
                                        replace.pop();
                                    }
                                    app.popup = PopupState::SearchReplace { search, replace, step };
                                }
                                _ => {}
                            }
                        }
                        PopupState::About => {
                            match key.code {
                                KeyCode::Enter | KeyCode::Esc | KeyCode::Char(' ') => app.popup = PopupState::None,
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                    continue;
                }



                // ── Dropdown menu navigation ─────────────────────────────
                if app.active_menu != ActiveMenu::None {
                    let items = get_menu_items(app.active_menu);
                    match key.code {
                        KeyCode::Esc => app.active_menu = ActiveMenu::None,
                        KeyCode::Up => {
                            if !items.is_empty() {
                                app.menu_selected = app.menu_selected.saturating_sub(1);
                            }
                        }
                        KeyCode::Down => {
                            if !items.is_empty() {
                                app.menu_selected =
                                    (app.menu_selected + 1).min(items.len() - 1);
                            }
                        }
                        KeyCode::Left => app.open_menu(prev_menu(app.active_menu, app.view_mode == ViewMode::PureText)),
                        KeyCode::Right => app.open_menu(next_menu(app.active_menu, app.view_mode == ViewMode::PureText)),
                        KeyCode::Enter | KeyCode::Char(' ') => {
                            if app.menu_selected < items.len() {
                                let action = items[app.menu_selected].1;
                                app.execute_action(action, inner_h);
                            } else {
                                app.active_menu = ActiveMenu::None;
                            }
                        }
                        _ => {}
                    }
                    continue;
                }

                // ── Ctrl shortcuts ───────────────────────────────────────
                if ctrl {
                    if alt {
                        match key.code {
                            KeyCode::Char('z') => app.undo(),
                            KeyCode::Char('y') => app.redo(),
                            KeyCode::Char('c') => app.copy_selection(),
                            KeyCode::Char('x') => app.cut_selection(inner_h),
                            KeyCode::Char('v') => app.paste(),
                            KeyCode::Char('b') => app.wrap_selection_or_insert("**", "**", "**bold**"),
                            KeyCode::Char('i') => app.wrap_selection_or_insert("*", "*", "*italic*"),
                            KeyCode::Char('k') => app.wrap_selection_or_insert("`", "`", "`code`"),
                            KeyCode::Char('a') => app.select_all(),
                            _ => {}
                        }
                    } else {
                        match key.code {
                            KeyCode::Char('a') => app.select_all(),
                            KeyCode::Char('d') => app.duplicate_line_or_selection(),
                            KeyCode::Char('h') => app.execute_action(MenuAction::SyntaxHighlighting, inner_h),
                            KeyCode::Char('k') => app.delete_to_end_of_line(),
                            KeyCode::Char('q') => {
                                app.popup = PopupState::QuitConfirm;
                            }
                            KeyCode::Char('s') => app.save_file(),
                            KeyCode::Char('o') => {
                                if shift {
                                    app.execute_action(MenuAction::NextcloudOpen, inner_h);
                                } else {
                                    app.execute_action(MenuAction::OpenFile, inner_h);
                                }
                            }
                            KeyCode::Char('l') => app.execute_action(MenuAction::NextcloudConfig, inner_h),
                            KeyCode::Char('n') => app.execute_action(MenuAction::NewFile, inner_h),
                            KeyCode::Char('1') => app.insert_str_at_cursor("# "),
                            KeyCode::Char('2') => app.insert_str_at_cursor("## "),
                            KeyCode::Char('3') => app.insert_str_at_cursor("### "),
                            KeyCode::Home | KeyCode::Up => app.move_to_file_start(),
                            KeyCode::End | KeyCode::Down => app.move_to_file_end(inner_h, inner_w),
                            KeyCode::F(2) => { app.view_mode = ViewMode::PureText; app.save_settings(); }
                            _ => {}
                        }
                    }
                    app.clamp_scroll(inner_h, inner_w);
                    app.clamp_scroll_x(inner_w);
                    continue;
                }

                // ── Shift + movement: extend selection ───────────────────
                if shift {
                    match key.code {
                        KeyCode::Up => {
                            app.start_selection();
                            app.move_up(inner_h, inner_w);
                        }
                        KeyCode::Down => {
                            app.start_selection();
                            app.move_down(inner_h, inner_w);
                        }
                        KeyCode::Left => {
                            app.start_selection();
                            app.move_left(inner_h, inner_w);
                        }
                        KeyCode::Right => {
                            app.start_selection();
                            app.move_right(inner_h, inner_w);
                        }
                        KeyCode::Home => {
                            app.start_selection();
                            app.move_home();
                        }
                        KeyCode::End => {
                            app.start_selection();
                            app.move_end();
                        }
                        KeyCode::PageUp => {
                            app.start_selection();
                            app.move_page_up(inner_h, inner_w);
                        }
                        KeyCode::PageDown => {
                            app.start_selection();
                            app.move_page_down(inner_h, inner_w);
                        }
                        // Shift+Char: just insert the uppercase character normally
                        KeyCode::Char(c) => {
                            let wrapped = match c {
                                '(' => app.wrap_selection_delimiter("(", ")"),
                                '[' => app.wrap_selection_delimiter("[", "]"),
                                '{' => app.wrap_selection_delimiter("{", "}"),
                                '"' => app.wrap_selection_delimiter("\"", "\""),
                                '\'' => app.wrap_selection_delimiter("'", "'"),
                                '`' => app.wrap_selection_delimiter("`", "`"),
                                _ => false,
                            };
                            if !wrapped {
                                app.clear_selection();
                                app.insert_char(c);
                            }
                        }
                        _ => {}
                    }
                    app.clamp_scroll(inner_h, inner_w);
                    app.clamp_scroll_x(inner_w);
                    continue;
                }

                // ── Regular (unmodified) keys ────────────────────────────
                match key.code {
                    KeyCode::F(2) => { app.view_mode = ViewMode::Writer; app.save_settings(); }
                    KeyCode::F(3) => { app.view_mode = ViewMode::Markdown; app.save_settings(); }
                    KeyCode::F(4) => { app.view_mode = ViewMode::Split; app.save_settings(); }
                    KeyCode::F(5) => { app.view_mode = ViewMode::PureText; app.save_settings(); }
                    KeyCode::F(6) => { app.execute_action(MenuAction::SyntaxHighlighting, inner_h); }
                    KeyCode::Tab => {
                        if app.selection_anchor.is_some() {
                            app.indent_selection();
                        } else {
                            app.insert_str_at_cursor("    ");
                        }
                    }
                    KeyCode::BackTab => app.unindent_selection(),
                    // Movement keys clear selection
                    KeyCode::Up => { app.clear_selection(); app.move_up(inner_h, inner_w); }
                    KeyCode::Down => { app.clear_selection(); app.move_down(inner_h, inner_w); }
                    KeyCode::Left => { app.clear_selection(); app.move_left(inner_h, inner_w); }
                    KeyCode::Right => { app.clear_selection(); app.move_right(inner_h, inner_w); }
                    KeyCode::Home => { app.clear_selection(); app.move_home(); }
                    KeyCode::End => { app.clear_selection(); app.move_end(); }
                    KeyCode::PageUp => { app.clear_selection(); app.move_page_up(inner_h, inner_w); }
                    KeyCode::PageDown => { app.clear_selection(); app.move_page_down(inner_h, inner_w); }
                    // Editing
                    KeyCode::Char(c) => {
                        let wrapped = match c {
                            '(' => app.wrap_selection_delimiter("(", ")"),
                            '[' => app.wrap_selection_delimiter("[", "]"),
                            '{' => app.wrap_selection_delimiter("{", "}"),
                            '"' => app.wrap_selection_delimiter("\"", "\""),
                            '\'' => app.wrap_selection_delimiter("'", "'"),
                            '`' => app.wrap_selection_delimiter("`", "`"),
                            _ => false,
                        };
                        if !wrapped {
                            app.insert_char(c);
                        }
                    }
                    KeyCode::Enter => app.insert_newline(),
                    KeyCode::Backspace => app.backspace(inner_h),
                    KeyCode::Delete => app.delete_forward(),
                    KeyCode::Esc => app.clear_selection(),
                    _ => {}
                }
                // Sync scroll after every keypress
                app.clamp_scroll(inner_h, inner_w);
                app.clamp_scroll_x(inner_w);
            }
        }

        if app.should_quit {
            return Ok(());
        }
    }
}

fn ui(f: &mut ratatui::Frame, app: &mut App) {
    let colors = app.theme.colors();
    let size = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // menubar
            Constraint::Min(1),    // editor area
            Constraint::Length(1), // statusbar
        ])
        .split(size);

    // ── Editor area ──
    let editor_rect = chunks[1];
    let inner_h = editor_rect.height.saturating_sub(2) as usize;
    let inner_w = match app.view_mode {
        ViewMode::Split => (editor_rect.width / 2).saturating_sub(8) as usize,
        ViewMode::Writer => editor_rect.width.saturating_sub(2) as usize,
        _ => editor_rect.width.saturating_sub(8) as usize,
    };

    app.clamp_scroll(inner_h, inner_w);

    // ── Menubar ──
    let menu_spans = vec![
        Span::styled(
            " [File] ",
            if app.active_menu == ActiveMenu::File {
                Style::default().bg(colors.accent).fg(colors.bg).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.fg)
            },
        ),
        Span::styled(
            " [Edit] ",
            if app.active_menu == ActiveMenu::Edit {
                Style::default().bg(colors.accent).fg(colors.bg).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.fg)
            },
        ),
        Span::styled(
            if app.view_mode == ViewMode::PureText { " [Manipulation] " } else { " [Format] " },
            if app.active_menu == ActiveMenu::Format || app.active_menu == ActiveMenu::Manipulation {
                Style::default().bg(colors.accent).fg(colors.bg).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.fg)
            },
        ),
        Span::styled(
            " [View] ",
            if app.active_menu == ActiveMenu::View {
                Style::default().bg(colors.accent).fg(colors.bg).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.fg)
            },
        ),
        Span::styled(
            " [Theme] ",
            if app.active_menu == ActiveMenu::Theme {
                Style::default().bg(colors.accent).fg(colors.bg).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.fg)
            },
        ),
        Span::styled(
            " [Help] ",
            if app.active_menu == ActiveMenu::Help {
                Style::default().bg(colors.accent).fg(colors.bg).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.fg)
            },
        ),
        Span::styled("  | art v0.30.3", Style::default().fg(colors.muted)),
    ];
    f.render_widget(
        Paragraph::new(Line::from(menu_spans)).style(Style::default().bg(colors.border)),
        chunks[0],
    );

    let (_target_rect, pos_opt) = match app.view_mode {
        ViewMode::Markdown | ViewMode::PureText => (editor_rect, render_markdown_editor(f, editor_rect, app, &colors)),
        ViewMode::Writer => (editor_rect, render_writer_view(f, editor_rect, app, &colors)),
        ViewMode::Split => {
            let split = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(editor_rect);
            render_writer_view(f, split[1], app, &colors);
            (split[0], render_markdown_editor(f, split[0], app, &colors))
        }
    };

    if let Some((cx, cy)) = pos_opt {
        if app.active_menu == ActiveMenu::None { f.set_cursor_position((cx, cy)); }
    }

    // ── Statusbar ──
    let words = app.content.split_whitespace().count();
    let total_lines = app.get_lines().len();
    let mode_str = match app.view_mode {
        ViewMode::Writer => "Writer",
        ViewMode::Markdown => "Markdown",
        ViewMode::Split => "Split",
        ViewMode::PureText => "PureText",
    };
    let dirty = if app.dirty { " *" } else { "" };
    let theme_tag = if app.theme == Theme::VT100 { " (VT100)" } else { "" };
    let sel_tag = if app.selection_anchor.is_some() {
        let text = app.selected_text();
        format!(" | SEL:{} chars", text.len())
    } else {
        String::new()
    };
    let nc_str = match &app.nextcloud_config {
        Some(cfg) => format!(" | ☁ Linked ({})", cfg.username),
        None => " | ☁ Off".to_string(),
    };
    let syntax_tag = if app.syntax_highlighting { "SYNTAX: ON" } else { "SYNTAX: OFF" };
    let status = Line::from(vec![
        Span::styled(format!(" {} ", app.status_msg), Style::default().fg(colors.fg)),
        Span::styled(
            format!(
                " | {mode_str}{theme_tag} | {syntax_tag}{nc_str} | {} {dirty} | Ln:{}/{} Col:{}{sel_tag} | W:{words} ",
                app.file_name,
                app.cursor_line + 1,
                total_lines,
                app.cursor_col + 1
            ),
            Style::default().fg(colors.muted),
        ),
    ]);
    f.render_widget(
        Paragraph::new(status).style(Style::default().bg(colors.border)),
        chunks[2],
    );

    // ── Dropdown menus ──
    if app.active_menu != ActiveMenu::None {
        render_dropdown_popup(f, app, &colors);
    }

    // ── Popups ──
    if app.popup != PopupState::None {
        render_popup(f, app, &colors);
    }
}

fn render_popup(f: &mut ratatui::Frame, app: &App, colors: &ThemeColors) {
    let size = f.area();
    let mut height = 5;
    let mut width = 40;
    if let PopupState::OpenFile { .. } | PopupState::SaveAs { .. } | PopupState::NextcloudOpen { .. } | PopupState::NextcloudSaveAs { .. } | PopupState::NextcloudConfig { .. } = &app.popup {
        height = 20;
        width = 65;
    }

    let area = Rect::new(
        (size.width.saturating_sub(width)) / 2,
        (size.height.saturating_sub(height)) / 2,
        width.min(size.width),
        height.min(size.height),
    );
    f.render_widget(Clear, area);

    let (title, content_lines) = match &app.popup {
        PopupState::QuitConfirm => {
            let (default_prompt, title_msg) = if app.dirty {
                ("Save before quitting? [Y/n/Esc]", "File has unsaved changes.")
            } else {
                ("Quit app? [y/N/Esc]", "File has no unsaved changes.")
            };
            (
                " Quit ",
                vec![
                    title_msg.to_string(),
                    default_prompt.to_string(),
                ]
            )
        }
        PopupState::SaveAs { current_dir, entries, selected, scroll, input, input_focused } => {
            let mut lines = vec![format!("Local Dir: {}", current_dir), "".to_string()];
            let display_count = height.saturating_sub(8) as usize; // account for borders (2), headers/footers (6)
            for (i, (name, is_dir)) in entries.iter().skip(*scroll).take(display_count).enumerate() {
                let actual_idx = i + scroll;
                let cursor = if actual_idx == *selected { ">" } else { " " };
                let icon = if *is_dir { "📁" } else { "📄" };
                lines.push(format!("{} {} {}", cursor, icon, name));
            }
            if entries.len() > scroll + display_count {
                lines.push("   ...".to_string());
            }
            lines.push("".to_string());
            let input_cursor = if *input_focused { "_" } else { "" };
            lines.push(format!("Save as: {}{}", input, input_cursor));
            lines.push("[Ctrl+S] Save Here   [Tab] Nextcloud FS".to_string());
            (
                " Save As (Local FS) ",
                lines
            )
        }
        PopupState::NextcloudSaveAs { remote_path, entries, selected, scroll, input, input_focused } => {
            let mut lines = vec![
                format!("Remote Path: /{}", remote_path),
                "".to_string(),
            ];
            let display_count = height.saturating_sub(8) as usize;
            for (i, item) in entries.iter().skip(*scroll).take(display_count).enumerate() {
                let actual_idx = i + scroll;
                let cursor = if actual_idx == *selected { ">" } else { " " };
                let icon = if item.is_dir { "📁" } else { "📄" };
                lines.push(format!("{} {} {}", cursor, icon, item.name));
            }
            if entries.len() > scroll + display_count {
                lines.push("   ...".to_string());
            }
            lines.push("".to_string());
            let input_cursor = if *input_focused { "_" } else { "" };
            lines.push(format!("Save to Nextcloud: {}{}", input, input_cursor));
            lines.push("[Ctrl+S] Save Here   [Tab] Local FS".to_string());
            (
                " Save As (Nextcloud) ",
                lines
            )
        }
        PopupState::OverwriteConfirm { file_name, is_nextcloud, .. } => {
            let dest_type = if *is_nextcloud { "Nextcloud" } else { "Local disk" };
            (
                " Confirm Overwrite ",
                vec![
                    format!("File '{}' already exists on {}.", file_name, dest_type),
                    "Do you want to overwrite it?".to_string(),
                    "".to_string(),
                    "[y/Enter] Overwrite    [n/Esc] Cancel".to_string(),
                ]
            )
        }
        PopupState::OpenFile { current_dir, entries, selected, scroll } => {
            let mut lines = vec![format!("Local Dir: {}  [Press Tab for Nextcloud]", current_dir), "".to_string()];
            let display_count = height.saturating_sub(5) as usize; // account for borders (2), headers/footers (3)
            for (i, (name, is_dir)) in entries.iter().skip(*scroll).take(display_count).enumerate() {
                let actual_idx = i + scroll;
                let cursor = if actual_idx == *selected { ">" } else { " " };
                let icon = if *is_dir { "📁" } else { "📄" };
                lines.push(format!("{} {} {}", cursor, icon, name));
            }
            if entries.len() > scroll + display_count {
                lines.push("   ...".to_string());
            }
            (
                " Open File (Local FS) ",
                lines
            )
        }
        PopupState::NextcloudConfig { url_input, username_input, password_input, focus, status_msg } => {
            let u_sel = if *focus == 0 { "> " } else { "  " };
            let un_sel = if *focus == 1 { "> " } else { "  " };
            let p_sel = if *focus == 2 { "> " } else { "  " };
            let l_sel = if *focus == 3 { "> [ LINK ACCOUNT / TEST ] <" } else { "  [ Link Account / Test ]" };
            let ul_sel = if *focus == 4 { "> [ UNLINK ACCOUNT ] <" } else { "  [ Unlink Account ]" };

            let pass_mask = "*".repeat(password_input.len());

            (
                " Nextcloud Integration ",
                vec![
                    status_msg.clone(),
                    "".to_string(),
                    format!("{}Server URL: {}", u_sel, url_input),
                    format!("{}Username:   {}", un_sel, username_input),
                    format!("{}Password:   {}", p_sel, pass_mask),
                    "".to_string(),
                    l_sel.to_string(),
                    ul_sel.to_string(),
                    "".to_string(),
                    "[Tab/Up/Down] Focus | [Enter] Select/Save | [Esc] Close".to_string(),
                ]
            )
        }
        PopupState::NextcloudOpen { remote_path, entries, selected, scroll } => {
            let mut lines = vec![
                format!("Remote Path: /{}  [Tab: Local FS]", remote_path),
            ];
            if !app.recent_nextcloud_files.is_empty() {
                lines.push("Recent History (Press 1 or 2 to open):".to_string());
                for (rec_idx, (path, name)) in app.recent_nextcloud_files.iter().enumerate() {
                    lines.push(format!("  [{}] 🕒 {} ({})", rec_idx + 1, name, path));
                }
            }
            lines.push("".to_string());
            let extra_lines = if app.recent_nextcloud_files.is_empty() { 5 } else { 5 + app.recent_nextcloud_files.len() + 1 };
            let display_count = height.saturating_sub(extra_lines as u16) as usize;
            for (i, item) in entries.iter().skip(*scroll).take(display_count).enumerate() {
                let actual_idx = i + scroll;
                let cursor = if actual_idx == *selected { ">" } else { " " };
                let icon = if item.is_dir { "📁" } else { "📄" };
                lines.push(format!("{} {} {}", cursor, icon, item.name));
            }
            if entries.len() > scroll + display_count {
                lines.push("   ...".to_string());
            }
            (
                " Open Nextcloud File ",
                lines
            )
        }
        PopupState::Search { input } => {
            (
                " Search ",
                vec![
                    "Search for:".to_string(),
                    format!("> {}", input),
                ]
            )
        }
        PopupState::SearchReplace { search, replace, step } => {
            if *step == 0 {
                (
                    " Search & Replace ",
                    vec![
                        "Search for:".to_string(),
                        format!("> {}", search),
                    ]
                )
            } else {
                (
                    " Search & Replace ",
                    vec![
                        format!("Replace '{}' with:", search),
                        format!("> {}", replace),
                    ]
                )
            }
        }
        PopupState::About => {
            (
                " About art ",
                vec![
                    "art v0.30.3".to_string(),
                    "Distraction-free Markdown TUI Editor".to_string(),
                    "".to_string(),
                    "Maintainer:       Roland Huber".to_string(),
                    "Original Creator: Sean Malseed (Action Retro)".to_string(),
                    "License:          GPLv3".to_string(),
                    "".to_string(),
                    "[Enter / Esc] Close".to_string(),
                ]
            )
        }
        PopupState::None => ("", vec![]),
    };

    let p = Paragraph::new(
        content_lines.into_iter()
            .map(|l| Line::from(Span::styled(l, Style::default().fg(colors.fg))))
            .collect::<Vec<_>>()
    )
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(title)
            .border_style(Style::default().fg(colors.accent))
    )
    .style(Style::default().bg(colors.bg));

    f.render_widget(p, area);
}


fn wrap_line_chars(chars: &[char], width: usize) -> Vec<Vec<char>> {
    if chars.is_empty() { return vec![vec![]]; }
    let w = width.max(1);
    let mut lines = Vec::new();
    let mut current_line = Vec::new();
    let mut current_word = Vec::new();

    for &c in chars {
        current_word.push(c);
        if c == ' ' || c == '-' {
            if current_line.len() + current_word.len() > w && !current_line.is_empty() {
                lines.push(current_line);
                current_line = Vec::new();
            }
            current_line.extend(current_word.drain(..));
        } else {
            if current_line.len() + current_word.len() > w {
                if current_line.is_empty() {
                    if current_word.len() > w {
                        let last = current_word.pop().unwrap();
                        lines.push(current_word.drain(..).collect());
                        current_word.push(last);
                    }
                } else {
                    lines.push(current_line);
                    current_line = Vec::new();
                }
            }
        }
    }
    if !current_word.is_empty() {
        if current_line.len() + current_word.len() > w && !current_line.is_empty() {
            lines.push(current_line);
            current_line = Vec::new();
        }
        current_line.extend(current_word.drain(..));
    }
    if !current_line.is_empty() || lines.is_empty() {
        lines.push(current_line);
    }
    lines
}

fn tokenize_code_line(line: &str, colors: &ThemeColors) -> Vec<Span<'static>> {
    if line.is_empty() {
        return vec![Span::raw("")];
    }

    let mut spans = Vec::new();
    let trim_start = line.trim_start();
    let leading_spaces = &line[..line.len() - trim_start.len()];
    if !leading_spaces.is_empty() {
        spans.push(Span::styled(leading_spaces.to_string(), Style::default().fg(colors.fg)));
    }

    if trim_start.starts_with("//") || trim_start.starts_with('#') || trim_start.starts_with("--") || trim_start.starts_with(';') {
        spans.push(Span::styled(
            trim_start.to_string(),
            Style::default().fg(colors.muted).add_modifier(Modifier::ITALIC),
        ));
        return spans;
    }

    let keywords = [
        "fn", "fun", "function", "def", "let", "mut", "const", "var", "val",
        "pub", "private", "protected", "struct", "class", "enum", "trait", "impl", "interface", "type", "typedef",
        "if", "else", "elseif", "match", "switch", "case", "default", "for", "foreach", "while", "loop", "in", "do", "until", "return", "yield", "goto",
        "import", "from", "use", "include", "define", "pragma", "require", "package", "namespace", "as", "using", "param", "process", "begin", "end", "filter", "workflow", "configuration",
        "true", "false", "null", "none", "nil", "some", "ok", "err", "True", "False", "None",
        "try", "catch", "finally", "throw", "trap", "async", "await", "break", "continue", "static", "self", "this", "super",
        "select", "from", "where", "insert", "into", "update", "delete", "create", "table", "drop", "alter", "join", "on",
    ];

    let types = [
        "i8", "i16", "i32", "i64", "i128", "isize",
        "u8", "u16", "u32", "u64", "u128", "usize",
        "f32", "f64", "bool", "char", "str", "String",
        "int", "float", "double", "void", "long", "short", "unsigned", "signed",
        "size_t", "uint8_t", "uint16_t", "uint32_t", "int32_t", "int64_t",
        "Vec", "HashMap", "Option", "Result", "Box", "Rc", "Arc", "Object",
        "int64", "float64", "string", "byte", "rune", "vector", "map", "list",
    ];

    let chars: Vec<char> = trim_start.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];

        if c == '"' || c == '\'' || c == '`' {
            let quote = c;
            let start = i;
            i += 1;
            while i < len {
                if chars[i] == quote && (i == 0 || chars[i - 1] != '\\') {
                    i += 1;
                    break;
                }
                i += 1;
            }
            let s: String = chars[start..i].iter().collect();
            spans.push(Span::styled(s, Style::default().fg(colors.quote)));
            continue;
        }

        if (c == '/' && i + 1 < len && chars[i + 1] == '/') ||
           (c == '#' && (i == 0 || chars[i - 1].is_whitespace())) ||
           (c == '-' && i + 1 < len && chars[i + 1] == '-') {
            let s: String = chars[i..].iter().collect();
            spans.push(Span::styled(s, Style::default().fg(colors.muted).add_modifier(Modifier::ITALIC)));
            break;
        }

        if c.is_ascii_digit() && (i == 0 || (!chars[i - 1].is_alphanumeric() && chars[i - 1] != '_')) {
            let start = i;
            while i < len && (chars[i].is_ascii_hexdigit() || chars[i] == '.' || chars[i] == 'x' || chars[i] == 'X' || chars[i] == 'b' || chars[i] == 'B' || chars[i] == '_') {
                i += 1;
            }
            let s: String = chars[start..i].iter().collect();
            spans.push(Span::styled(s, Style::default().fg(colors.accent)));
            continue;
        }

        // PowerShell variables starting with $ (e.g. $var, $PSScriptRoot, $_, $true, $false, $null)
        if c == '$' {
            let start = i;
            i += 1;
            while i < len && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == ':' || chars[i] == '$' || chars[i] == '?') {
                i += 1;
            }
            let var_str: String = chars[start..i].iter().collect();
            let var_lower = var_str.to_lowercase();
            let style = if var_lower == "$true" || var_lower == "$false" || var_lower == "$null" {
                Style::default().fg(colors.accent).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.header)
            };
            spans.push(Span::styled(var_str, style));
            continue;
        }

        // PowerShell / CLI parameters & operators starting with - (e.g. -Path, -Force, -eq, -match)
        if c == '-' && i + 1 < len && (chars[i + 1].is_alphabetic() || chars[i + 1] == '_') && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(' || chars[i - 1] == '|' || chars[i - 1] == '{' || chars[i - 1] == ';') {
            let start = i;
            i += 1;
            while i < len && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '-') {
                i += 1;
            }
            let param_str: String = chars[start..i].iter().collect();
            spans.push(Span::styled(param_str, Style::default().fg(colors.accent)));
            continue;
        }

        // Identifiers & Cmdlets (including hyphenated Cmdlets like Get-ChildItem, Write-Host)
        if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < len && (chars[i].is_alphanumeric() || chars[i] == '_' || (chars[i] == '-' && i + 1 < len && chars[i + 1].is_alphabetic())) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let word_lower = word.to_lowercase();
            let is_kw = keywords.contains(&word_lower.as_str());
            let is_type = types.contains(&word.as_str()) || (word.chars().next().map_or(false, |f| f.is_uppercase()) && !is_kw && !word.contains('-'));
            let is_fn = (i < len && chars[i] == '(') || word.contains('-');

            let style = if is_kw {
                Style::default().fg(colors.header).add_modifier(Modifier::BOLD)
            } else if is_type {
                Style::default().fg(colors.accent).add_modifier(Modifier::BOLD)
            } else if is_fn {
                Style::default().fg(colors.header)
            } else {
                Style::default().fg(colors.fg)
            };

            spans.push(Span::styled(word, style));
            continue;
        }

        let start = i;
        i += 1;
        let s: String = chars[start..i].iter().collect();
        let op_style = match c {
            '=' | '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '!' | '<' | '>' | '?' => Style::default().fg(colors.accent),
            '{' | '}' | '(' | ')' | '[' | ']' => Style::default().fg(colors.header),
            _ => Style::default().fg(colors.muted),
        };
        spans.push(Span::styled(s, op_style));
    }

    spans
}

/// Styled writer preview — one rendered line per source line, no word-wrap.
fn render_writer_view(f: &mut ratatui::Frame, area: Rect, app: &App, colors: &ThemeColors) -> Option<(u16, u16)> {
    let is_vt100 = app.theme == Theme::VT100;
    let check   = if is_vt100 { "[x] " } else { "☑ " };
    let uncheck = if is_vt100 { "[ ] " } else { "☐ " };
    let bullet  = if is_vt100 { "* "  } else { "• " };
    let ct = if is_vt100 { "+-- " } else { "┌─ " };
    let cb = if is_vt100 { "| "  } else { "│ " };
    let ce = if is_vt100 { " --------" } else { " ────────" };
    let hr = if is_vt100 { "----------------------------" } else { "────────────────────────────" };

    let sel = app.selection_range();
    let (sel_bg, sel_fg) = (colors.sel_bg, colors.sel_fg);

    let inner_x = area.x + 1;
    let inner_y = area.y + 1;
    let inner_h = area.height.saturating_sub(2) as usize;
    let inner_width = area.width.saturating_sub(2) as usize;

    let mut cursor_pos = None;
    let mut visual_y = 0;
    let mut rendered = Vec::new();

    for (idx, line) in app.get_lines().into_iter().enumerate().skip(app.scroll_top) {
        if visual_y >= inner_h { break; }

        let source_len = line.chars().count();

        let indent_len = line.chars().take_while(|c| c.is_whitespace()).count();
        let trimmed_start = if indent_len < source_len {
            let byte_idx = line.char_indices().map(|(i, _)| i).nth(indent_len).unwrap_or(line.len());
            &line[byte_idx..]
        } else {
            ""
        };

        // prefix, icon_span, plain_text, col_offset
        let mut col_offset = indent_len;
        let mut icon_span: Option<Span> = None;
        let mut blank_icon_span: Option<Span> = None;
        let plain_text: String;
        let mut base_style = Style::default().fg(colors.fg);
        let mut sel_style = Style::default().fg(sel_fg).bg(sel_bg);

        let sel_style_bold_ul = Style::default().fg(sel_fg).bg(sel_bg).add_modifier(Modifier::BOLD | Modifier::UNDERLINED);
        let sel_style_bold    = Style::default().fg(sel_fg).bg(sel_bg).add_modifier(Modifier::BOLD);
        let sel_style_plain   = Style::default().fg(sel_fg).bg(sel_bg);

        let indent_prefix = " ".repeat(indent_len);

        if trimmed_start.starts_with("# ") {
            plain_text = trimmed_start["# ".len()..].to_string();
            col_offset += 2;
            base_style = Style::default().fg(colors.header).add_modifier(Modifier::BOLD | Modifier::UNDERLINED);
            sel_style = sel_style_bold_ul;
            if indent_len > 0 {
                icon_span = Some(Span::raw(indent_prefix));
            }
        } else if trimmed_start.starts_with("## ") {
            plain_text = trimmed_start["## ".len()..].to_string();
            col_offset += 3;
            base_style = Style::default().fg(colors.accent).add_modifier(Modifier::BOLD);
            sel_style = sel_style_bold;
            if indent_len > 0 {
                icon_span = Some(Span::raw(indent_prefix));
            }
        } else if trimmed_start.starts_with("### ") {
            plain_text = trimmed_start["### ".len()..].to_string();
            col_offset += 4;
            base_style = Style::default().fg(colors.quote).add_modifier(Modifier::BOLD);
            sel_style = sel_style_bold;
            if indent_len > 0 {
                icon_span = Some(Span::raw(indent_prefix));
            }
        } else if trimmed_start.starts_with("> [!") {
            plain_text = format!("{ct}{}{ce}", &trimmed_start["> ".len()..]);
            col_offset += 2;
            base_style = Style::default().fg(colors.quote).add_modifier(Modifier::BOLD);
            sel_style = sel_style_bold;
            if indent_len > 0 {
                icon_span = Some(Span::raw(indent_prefix));
            }
        } else if trimmed_start.starts_with("> ") {
            plain_text = format!("{cb}{}", &trimmed_start["> ".len()..]);
            col_offset += 2;
            base_style = Style::default().fg(colors.quote);
            sel_style = sel_style_plain;
            if indent_len > 0 {
                icon_span = Some(Span::raw(indent_prefix));
            }
        } else if trimmed_start.starts_with("- [x]") || trimmed_start.starts_with("- [X]") {
            let pref_len = if trimmed_start.starts_with("- [x] ") || trimmed_start.starts_with("- [X] ") { 6 } else { 5 };
            plain_text = trimmed_start[pref_len..].to_string();
            col_offset += pref_len;
            let icon_s = Style::default().fg(colors.accent).add_modifier(Modifier::BOLD);
            icon_span = Some(Span::styled(format!("{indent_prefix}{check}"), icon_s));
            blank_icon_span = Some(Span::styled(" ".repeat(indent_len + 4), Style::default()));
        } else if trimmed_start.starts_with("- [ ]") {
            let pref_len = if trimmed_start.starts_with("- [ ] ") { 6 } else { 5 };
            plain_text = trimmed_start[pref_len..].to_string();
            col_offset += pref_len;
            let icon_s = Style::default().fg(colors.muted);
            icon_span = Some(Span::styled(format!("{indent_prefix}{uncheck}"), icon_s));
            blank_icon_span = Some(Span::styled(" ".repeat(indent_len + 4), Style::default()));
        } else if trimmed_start.starts_with("- ") || trimmed_start.starts_with("* ") {
            plain_text = trimmed_start[2..].to_string();
            col_offset += 2;
            let icon_s = Style::default().fg(colors.accent);
            icon_span = Some(Span::styled(format!("{indent_prefix}{bullet}"), icon_s));
            blank_icon_span = Some(Span::styled(" ".repeat(indent_len + 2), Style::default()));
        } else if trimmed_start == "---" {
            plain_text = hr.to_string();
            base_style = Style::default().fg(colors.muted);
            if indent_len > 0 {
                icon_span = Some(Span::raw(indent_prefix));
            }
        } else {
            plain_text = line.to_string();
            col_offset = 0;
        }

        let chars: Vec<char> = plain_text.chars().collect();
        let display_chars: Vec<char> = if app.word_wrap {
            chars.clone()
        } else {
            chars.into_iter().skip(app.scroll_left).collect()
        };

        // Determine available text width.
        // If there's an icon span, it takes up some width.
        let prefix_width = icon_span.as_ref().map(|s| s.content.chars().count()).unwrap_or(0);
        let text_inner_width = inner_width.saturating_sub(prefix_width);

        let chunks = if app.word_wrap {
            wrap_line_chars(&display_chars, text_inner_width)
        } else {
            vec![display_chars]
        };

        let mut chunk_col_offset = if app.word_wrap { 0 } else { app.scroll_left };

        for (chunk_idx, chunk) in chunks.iter().enumerate() {
            if visual_y >= inner_h { break; }

            // Check cursor
            if idx == app.cursor_line && cursor_pos.is_none() {
                let chunk_len = chunk.len();
                let is_last_chunk = chunk_idx == chunks.len() - 1;
                let rel_col = app.cursor_col;
                let chunk_start_src = col_offset + chunk_col_offset;
                let chunk_end_src = col_offset + chunk_col_offset + chunk_len;

                let is_in_chunk = if chunk_idx == 0 {
                    rel_col < chunk_end_src || (is_last_chunk && rel_col >= chunk_start_src)
                } else {
                    rel_col >= chunk_start_src && (rel_col < chunk_end_src || (is_last_chunk && rel_col >= chunk_end_src))
                };

                if is_in_chunk {
                    let text_offset = if rel_col < chunk_start_src {
                        rel_col.min(prefix_width)
                    } else {
                        prefix_width + (rel_col - chunk_start_src)
                    };
                    let cx = inner_x + text_offset as u16;
                    let cy = inner_y + visual_y as u16;
                    cursor_pos = Some((cx, cy));
                }
            }

            let chunk_start = chunk_col_offset;
            let chunk_end = chunk_col_offset + chunk.len();
            chunk_col_offset += chunk.len();

            let prefix = if chunk_idx == 0 {
                icon_span.clone()
            } else {
                blank_icon_span.clone()
            };

            let sel_range: Option<(usize, usize)> = sel.and_then(|((sl, sc), (el, ec))| {
                if idx < sl || idx > el { return None; }
                let start = if idx == sl { sc.min(source_len) } else { 0 };
                let end   = if idx == el { ec.min(source_len) } else { source_len };
                
                let start_mapped = start.saturating_sub(col_offset);
                let end_mapped = end.saturating_sub(col_offset);

                if start_mapped >= chunk_end || end_mapped <= chunk_start { return None; }
                
                let adj_start = start_mapped.saturating_sub(chunk_start).min(chunk.len());
                let adj_end = end_mapped.saturating_sub(chunk_start).min(chunk.len());
                
                if adj_start == adj_end { None } else { Some((adj_start, adj_end)) }
            });

            match sel_range {
                None => {
                    let mut spans = vec![];
                    if let Some(p) = prefix { spans.push(p); }
                    spans.push(Span::styled(chunk.iter().collect::<String>(), base_style));
                    rendered.push(Line::from(spans));
                }
                Some((start, end)) if start == 0 && end == chunk.len() => {
                    let mut spans = vec![];
                    // Should we highlight the prefix? Only if it's not a blank icon span?
                    if let Some(p) = prefix {
                        if chunk_idx == 0 { spans.push(Span::styled(p.content.clone(), sel_style)); }
                        else { spans.push(p); }
                    }
                    spans.push(Span::styled(chunk.iter().collect::<String>(), sel_style));
                    rendered.push(Line::from(spans));
                }
                Some((start, end)) => {
                    let mut spans = vec![];
                    // highlight prefix if selection starts at 0 and it's the first chunk
                    if let Some(p) = prefix {
                        if chunk_idx == 0 && start == 0 { spans.push(Span::styled(p.content.clone(), sel_style)); }
                        else { spans.push(p); }
                    }

                    let before:   String = chunk[..start].iter().collect();
                    let selected: String = chunk[start..end].iter().collect();
                    let after:    String = chunk[end..].iter().collect();
                    
                    if !before.is_empty() { spans.push(Span::styled(before, base_style)); }
                    spans.push(Span::styled(selected, sel_style));
                    if !after.is_empty() { spans.push(Span::styled(after, base_style)); }
                    rendered.push(Line::from(spans));
                }
            }
            visual_y += 1;
        }
    }

    let right_scrolled = !app.word_wrap && app.get_lines().iter().skip(app.scroll_top).take(area.height as usize).any(|l| l.chars().count() > app.scroll_left + inner_width);
    
    let mut block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.accent))
        .title(ratatui::widgets::block::Title::from(" Writer Preview ").alignment(ratatui::layout::Alignment::Center));

    if app.scroll_left > 0 && !app.word_wrap {
        block = block.title(ratatui::widgets::block::Title::from(" < ").alignment(ratatui::layout::Alignment::Left));
    }
    if right_scrolled {
        block = block.title(ratatui::widgets::block::Title::from(" > ").alignment(ratatui::layout::Alignment::Right));
    }

    let p = Paragraph::new(Text::from(rendered)).block(block).style(Style::default().bg(colors.bg));
    f.render_widget(p, area);
    cursor_pos
}

/// Raw markdown editor with line numbers and selection highlighting.
fn render_markdown_editor(
    f: &mut ratatui::Frame,
    area: Rect,
    app: &App,
    colors: &ThemeColors,
) -> Option<(u16, u16)> {
    let sep = if app.theme == Theme::VT100 { "|" } else { "│" };
    let sel = app.selection_range();
    let (sel_bg, sel_fg) = (colors.sel_bg, colors.sel_fg);

    let inner_x = area.x + 1;
    let inner_y = area.y + 1;
    let inner_h = area.height.saturating_sub(2) as usize;
    let inner_width = area.width.saturating_sub(8) as usize;

    let mut cursor_pos = None;
    let mut visual_y = 0;
    
    let mut out_lines: Vec<Line> = Vec::new();

    for (idx, line) in app.get_lines().into_iter().enumerate().skip(app.scroll_top) {
        if visual_y >= inner_h { break; }

        let chars: Vec<char> = line.chars().collect();
        let len = chars.len();

        let mut line_sep = sep.to_string();
        let mut sep_style = Style::default().fg(colors.muted);

        if app.scroll_left > 0 && len > 0 && !app.word_wrap {
            line_sep = "<".to_string();
            sep_style = Style::default().fg(colors.accent).add_modifier(Modifier::BOLD);
        } else if !app.word_wrap && len > app.scroll_left + inner_width {
            line_sep = ">".to_string();
            sep_style = Style::default().fg(colors.accent).add_modifier(Modifier::BOLD);
        }

        let num_span = Span::styled(format!("{:3} {line_sep} ", idx + 1), sep_style);
        let blank_num_span = Span::styled(format!("    {line_sep} "), sep_style);

        let display_chars: Vec<char> = if app.word_wrap {
            chars.clone()
        } else {
            chars.into_iter().skip(app.scroll_left).collect()
        };

        let chunks = if app.word_wrap {
            wrap_line_chars(&display_chars, inner_width)
        } else {
            vec![display_chars]
        };

        let mut col_offset = if app.word_wrap { 0 } else { app.scroll_left };

        for (chunk_idx, chunk) in chunks.iter().enumerate() {
            if visual_y >= inner_h { break; }

            // Check cursor
            if idx == app.cursor_line && cursor_pos.is_none() {
                let chunk_len = chunk.len();
                let is_last_chunk = chunk_idx == chunks.len() - 1;
                let rel_col = app.cursor_col;

                if rel_col >= col_offset && (rel_col < col_offset + chunk_len || (is_last_chunk && rel_col == col_offset + chunk_len)) {
                    let cx = inner_x + 6 + (rel_col - col_offset) as u16;
                    let cy = inner_y + visual_y as u16;
                    cursor_pos = Some((cx, cy));
                }
            }

            let chunk_start = col_offset;
            let chunk_end = col_offset + chunk.len();
            col_offset += chunk.len();

            let prefix = if chunk_idx == 0 { num_span.clone() } else { blank_num_span.clone() };

            let sel_range: Option<(usize, usize)> = sel.and_then(|((sl, sc), (el, ec))| {
                if idx < sl || idx > el { return None; }
                let start = if idx == sl { sc.min(len) } else { 0 };
                let end   = if idx == el { ec.min(len) } else { len };
                
                if start >= chunk_end || end <= chunk_start { return None; }
                
                let adj_start = start.saturating_sub(chunk_start).min(chunk.len());
                let adj_end = end.saturating_sub(chunk_start).min(chunk.len());
                
                if adj_start == adj_end { None } else { Some((adj_start, adj_end)) }
            });

            let is_pure_text = app.view_mode == ViewMode::PureText;
            let chunk_str: String = chunk.iter().collect();

            match sel_range {
                None => {
                    let mut spans = vec![prefix];
                    if is_pure_text && app.syntax_highlighting {
                        spans.extend(tokenize_code_line(&chunk_str, colors));
                    } else {
                        spans.push(Span::styled(chunk_str, Style::default().fg(colors.fg)));
                    }
                    out_lines.push(Line::from(spans));
                }
                Some((start, end)) if start == 0 && end == chunk.len() => {
                    out_lines.push(Line::from(vec![prefix,
                        Span::styled(chunk_str, Style::default().fg(sel_fg).bg(sel_bg))]));
                }
                Some((start, end)) => {
                    let before:   String = chunk[..start].iter().collect();
                    let selected: String = chunk[start..end].iter().collect();
                    let after:    String = chunk[end..].iter().collect();
                    let mut spans = vec![prefix];
                    if !before.is_empty() {
                        if is_pure_text && app.syntax_highlighting {
                            spans.extend(tokenize_code_line(&before, colors));
                        } else {
                            spans.push(Span::styled(before, Style::default().fg(colors.fg)));
                        }
                    }
                    spans.push(Span::styled(selected, Style::default().fg(sel_fg).bg(sel_bg)));
                    if !after.is_empty() {
                        if is_pure_text && app.syntax_highlighting {
                            spans.extend(tokenize_code_line(&after, colors));
                        } else {
                            spans.push(Span::styled(after, Style::default().fg(colors.fg)));
                        }
                    }
                    out_lines.push(Line::from(spans));
                }
            }
            visual_y += 1;
        }
    }

    let base_title = if app.view_mode == ViewMode::PureText { " Pure Text Editor " } else { " Markdown Editor " };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .title(ratatui::widgets::block::Title::from(base_title).alignment(ratatui::layout::Alignment::Center));

    let p = Paragraph::new(Text::from(out_lines)).block(block).style(Style::default().bg(colors.bg));
    f.render_widget(p, area);
    cursor_pos
}

fn render_dropdown_popup(f: &mut ratatui::Frame, app: &App, colors: &ThemeColors) {
    let (title, x_off): (&str, u16) = match app.active_menu {
        ActiveMenu::File => (" File ", 1),
        ActiveMenu::Edit => (" Edit ", 9),
        ActiveMenu::Format => (" Format ", 17),
        ActiveMenu::View => (" View ", 27),
        ActiveMenu::Theme => (" Theme ", 35),
        ActiveMenu::Help => (" Help ", 44),
        ActiveMenu::Manipulation => (" Manipulation ", 17),
        ActiveMenu::None => return,
    };

    let items = get_menu_items(app.active_menu);
    let h = (items.len() as u16 + 2).max(4);
    let w = 34_u16;
    let area = Rect::new(
        x_off,
        1,
        w.min(f.area().width.saturating_sub(x_off)),
        h.min(f.area().height.saturating_sub(1)),
    );
    f.render_widget(Clear, area);

    let prefix = if app.theme == Theme::VT100 { " > " } else { " ► " };
    let list_items: Vec<ListItem> = items
        .iter()
        .enumerate()
        .map(|(idx, (label, action))| {
            let mut display_label = label.to_string();
            match action {
                MenuAction::WordWrap => {
                    let check = if app.theme == Theme::VT100 {
                        if app.word_wrap { "[x]" } else { "[ ]" }
                    } else {
                        if app.word_wrap { "☑" } else { "☐" }
                    };
                    display_label = format!("{} {}", check, label);
                }
                MenuAction::SyntaxHighlighting => {
                    let check = if app.theme == Theme::VT100 {
                        if app.syntax_highlighting { "[x]" } else { "[ ]" }
                    } else {
                        if app.syntax_highlighting { "☑" } else { "☐" }
                    };
                    display_label = format!("{} {}", check, label);
                }
                _ => {}
            }

            if idx == app.menu_selected {
                ListItem::new(Span::styled(
                    format!("{prefix}{display_label}"),
                    Style::default()
                        .bg(colors.accent)
                        .fg(colors.bg)
                        .add_modifier(Modifier::BOLD),
                ))
            } else {
                ListItem::new(Span::styled(
                    format!("   {display_label}"),
                    Style::default().fg(colors.fg),
                ))
            }
        })
        .collect();

    let list = List::new(list_items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(title)
                .border_style(Style::default().fg(colors.accent)),
        )
        .style(Style::default().bg(colors.bg));
    f.render_widget(list, area);
}
