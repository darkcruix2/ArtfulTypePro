const invoke = window.__TAURI__?.core?.invoke || (async (cmd, args) => {
  if (cmd === "get_platform") return "linux";
  if (cmd === "parse_markdown") {
    // Basic fallback HTML converter for standalone browser preview
    if (!args || !args.text) return "";
    let lines = args.text.split("\n");
    let inList = false;
    let htmlLines = [];
    for (let line of lines) {
      const taskMatch = line.match(/^(\s*)[\-\*\+]\s+\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        if (!inList) { htmlLines.push('<ul class="contains-task-list">'); inList = true; }
        const checked = taskMatch[2].toLowerCase() === "x" ? 'checked=""' : '';
        htmlLines.push(`<li class="task-list-item"><input type="checkbox" ${checked}/> ${taskMatch[3]}</li>`);
      } else {
        if (inList) { htmlLines.push('</ul>'); inList = false; }
        htmlLines.push(line);
      }
    }
    if (inList) htmlLines.push('</ul>');
    let html = htmlLines.join("\n")
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>')
      .replace(/==([^=\n]+)==/gim, '<mark>$1</mark>')
      .replace(/~~([^~\n]+)~~/gim, '<del>$1</del>')
      .replace(/(?<!~)~([^~\n]+)~(?!~)/gim, '<sub>$1</sub>')
      .replace(/(?<!\^)\^([^\^\n]+)\^(?!\^)/gim, '<sup>$1</sup>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>');
    return '<p>' + html + '</p>';
  }
  return null;
});

// ─── State ────────────────────────────────────────────────────────────────────
let markdownInputEl;
let writerViewEl;
let toggleModeBtn;
let modeIndicatorEl;
let isMarkdownMode = false;
let statusMessageEl;
let wordCountEl;
let charCountEl;
let openFiles = [];
let activeFileId = null;
let untitledCounter = 1;

function getActiveFile() { return openFiles.find(f => f.id === activeFileId); }
function getActiveFilePath() { const f = getActiveFile(); return f ? f.path : null; }
function getCurrentFileDir() { const p = getActiveFilePath(); return p ? p.replace(/[/\\][^/\\]+$/, "") : null; }

let platform = "linux";
let autoSaveTimer = null;

const RECENT_KEY    = "artfultype-recent-v1";
const RECENT_MAX    = 10;
const SETTINGS_KEY  = "artfultype-settings-v1";

// ─── Debounce ─────────────────────────────────────────────────────────────────
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// ─── Platform ─────────────────────────────────────────────────────────────────
function isPrimaryMod(e) {
  if (platform === "macos") return e.metaKey;
  return e.ctrlKey && !e.metaKey;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function saveSettings(obj) {
  const current = loadSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...obj }));
}

// ─── Dirty / Unsaved indicator ────────────────────────────────────────────────
function setDirty(dirty) {
  const f = getActiveFile();
  if (f) f.dirty = dirty;
  renderTabBar();
  renderFileList();
  const btn = document.getElementById("save-file-btn");
  if (!btn) return;
  if (dirty) {
    btn.classList.add("dirty");
    btn.title = "Unsaved changes – Save (Ctrl+S)";
  } else {
    btn.classList.remove("dirty");
    btn.title = "Save File (Ctrl+S)";
  }
}

// ─── Auto-save ────────────────────────────────────────────────────────────────
function startAutoSave(intervalMinutes) {
  clearInterval(autoSaveTimer);
  if (intervalMinutes > 0) {
    autoSaveTimer = setInterval(async () => {
      for (const f of openFiles) {
        if (f.dirty) {
          if (f.isNextcloud && f.remotePath) {
            try {
              await invoke("write_nextcloud_file", { path: f.remotePath, content: f.content });
              f.dirty = false;
              renderTabBar();
              renderFileList();
            } catch (err) {
              console.error("Auto-save Nextcloud error:", err);
            }
          } else if (f.path) {
            await invoke("save_file", { path: f.path, content: f.content });
            f.dirty = false;
            renderTabBar();
            renderFileList();
          } else {
             new Notification("ArtfulType Autosave", { body: "You have an unsaved file: " + f.name });
          }
        }
      }
      const active = getActiveFile();
      if (active && !active.dirty) {
        const btn = document.getElementById("save-file-btn");
        if (btn) { btn.classList.remove("dirty"); btn.title = "Save File (Ctrl+S)"; }
      }
    }, intervalMinutes * 60 * 1000);
  }
}

function applyAutoSaveSetting(intervalMinutes) {
  saveSettings({ autoSaveMinutes: intervalMinutes });
  startAutoSave(intervalMinutes);
  updateAutoSaveUI(intervalMinutes);
}

function updateAutoSaveUI(intervalMinutes) {
  const select = document.getElementById("autosave-select");
  if (select) {
    select.value = String(intervalMinutes);
  }
}

// ─── Theme Management ─────────────────────────────────────────────────────────
const VALID_THEMES = new Set(["dracula", "classic-mac", "win98", "solaris-cde", "beos", "calm-rs"]);

function applyThemeSetting(themeName) {
  const validTheme = VALID_THEMES.has(themeName) ? themeName : "dracula";
  saveSettings({ theme: validTheme });
  document.documentElement.setAttribute("data-theme", validTheme);
  updateThemeUI(validTheme);
}

function updateThemeUI(themeName) {
  const select = document.getElementById("theme-select");
  if (select) {
    select.value = themeName;
  }
}

// ─── Word Wrap ────────────────────────────────────────────────────────────────
function applyWordWrapSetting(enabled) {
  saveSettings({ wordWrap: enabled });
  const editorArea = document.getElementById("editor-area");
  const check = document.getElementById("wordwrap-check");
  if (enabled) {
    editorArea.classList.remove("no-word-wrap");
    if (check) check.style.visibility = "visible";
  } else {
    editorArea.classList.add("no-word-wrap");
    if (check) check.style.visibility = "hidden";
  }
}

function toggleWordWrap() {
  const settings = loadSettings();
  const current = settings.wordWrap ?? true;
  applyWordWrapSetting(!current);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats(text) {
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  wordCountEl.textContent = `${words} words`;
  charCountEl.textContent = `${text.length} chars`;
}

const debouncedStats = debounce(() => {
  const text = isMarkdownMode
    ? markdownInputEl.value
    : (writerViewEl.innerText || writerViewEl.textContent || "");
  updateStats(text);
  setDirty(true);
}, 150);

// ─── Saved Selection (for toolbar buttons that steal focus) ───────────────────
// When a toolbar button is clicked, the browser moves focus away from the
// contenteditable and the selection is lost. We save the last known range
// and restore it before any format operation so it targets the right place.
let _savedRange = null;

function saveSelection() {
  if (isMarkdownMode) return;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    _savedRange = sel.getRangeAt(0).cloneRange();
  }
}

function restoreSelection() {
  if (!_savedRange || isMarkdownMode) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(_savedRange);
}

// ─── Recent Files ─────────────────────────────────────────────────────────────
function loadRecentFiles() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch { return []; }
}
function saveRecentFiles(list) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}
function addToRecentFiles(path, name) {
  let recent = loadRecentFiles().filter(f => f.path !== path);
  recent.unshift({ path, name });
  recent = recent.slice(0, RECENT_MAX);
  saveRecentFiles(recent);
  renderFileList();
}
function removeFromRecentFiles(path) {
  saveRecentFiles(loadRecentFiles().filter(f => f.path !== path));
  renderFileList();
}

let currentRenamePath = null;

async function renameSidebarFile(e, path) {
  e.stopPropagation();
  currentRenamePath = path;
  document.getElementById("rename-file-path").textContent = path;
  document.getElementById("rename-input").value = path.split(/[/\\]/).pop();
  openModal("rename-modal");
  document.getElementById("rename-input").focus();
}

async function confirmRename() {
  if (!currentRenamePath) return;
  const newName = document.getElementById("rename-input").value.trim();
  if (!newName) return;
  const path = currentRenamePath;
  const newPath = path.replace(/[/\\][^/\\]+$/, "/" + newName);
  try {
    await invoke("rename_file", { oldPath: path, newPath: newPath });
    let recent = loadRecentFiles();
    const idx = recent.findIndex(f => f.path === path);
    if (idx !== -1) {
       recent[idx].path = newPath;
       recent[idx].name = newName;
       saveRecentFiles(recent);
    }
    renderFileList();
    closeModal("rename-modal");
    statusMessageEl.textContent = "Renamed file.";
  } catch(err) {
    statusMessageEl.textContent = "Rename failed: " + err;
  }
}

async function deleteSidebarFile(e, path) {
  e.stopPropagation();
  const filename = path.split(/[/\\]/).pop();
  const confirmed = await promptConfirm("Delete File", `Are you sure you want to delete "${filename}"?`, "Delete", true);
  if (!confirmed) return;
  try {
    await invoke("delete_file", { path: path });
    removeFromRecentFiles(path);
    statusMessageEl.textContent = "Deleted file.";
  } catch(err) {
    statusMessageEl.textContent = "Delete failed: " + err;
  }
}

function renderFileList() {
  const list = document.getElementById("file-list");
  if(!list) return;
  list.innerHTML = "";
  
  const openLabel = document.createElement("div");
  openLabel.style.fontSize = "0.7rem"; openLabel.style.padding = "4px 8px"; openLabel.style.color = "var(--purple)"; openLabel.textContent = "OPEN FILES";
  list.appendChild(openLabel);
  
  for (const f of openFiles) {
    const li = document.createElement("li");
    li.className = "file-item" + (f.id === activeFileId ? " active" : "");
    li.textContent = f.name + (f.dirty ? " *" : "");
    li.title = f.path || f.name;
    li.addEventListener("click", () => switchTab(f.id));
    list.appendChild(li);
  }

  const recentLabel = document.createElement("div");
  recentLabel.style.fontSize = "0.7rem"; recentLabel.style.padding = "4px 8px"; recentLabel.style.color = "var(--comment)"; recentLabel.style.marginTop = "8px"; recentLabel.textContent = "RECENT FILES";
  list.appendChild(recentLabel);
  
  const openPaths = new Set(openFiles.map(f => f.path).filter(Boolean));
  for (const f of loadRecentFiles()) {
    if (openPaths.has(f.path)) continue;
    const li = document.createElement("li");
    li.className = "file-item";
    li.title = f.path;
    
    const nameSpan = document.createElement("span");
    nameSpan.className = "file-item-name";
    nameSpan.textContent = f.name;
    li.appendChild(nameSpan);
    
    const actions = document.createElement("div");
    actions.className = "file-item-actions";
    
    const renBtn = document.createElement("button");
    renBtn.className = "file-action-btn"; renBtn.innerHTML = "✎"; renBtn.title = "Rename";
    renBtn.onclick = (e) => renameSidebarFile(e, f.path);
    
    const delBtn = document.createElement("button");
    delBtn.className = "file-action-btn"; delBtn.innerHTML = "✕"; delBtn.title = "Delete";
    delBtn.onclick = (e) => deleteSidebarFile(e, f.path);
    
    actions.appendChild(renBtn); actions.appendChild(delBtn);
    li.appendChild(actions);
    
    li.addEventListener("click", () => openRecentFile(f));
    list.appendChild(li);
  }
}

async function openRecentFile(item) {
  if (!isTextFile(item.name) && !isImageFile(item.name)) {
    statusMessageEl.textContent = `Cannot open "${item.name}": Not a text file.`;
    alert(`Cannot open "${item.name}": ArtfulType Pro only opens text files.`);
    return;
  }
  try {
    statusMessageEl.textContent = `Opening ${item.name}…`;
    if (isImageFile(item.name)) {
      await applyOpenedFile({ path: item.path, name: item.name, content: "" });
      return;
    }
    const fileData = await invoke("read_file", { path: item.path });
    await applyOpenedFile(fileData);
    statusMessageEl.textContent = `Opened: ${fileData.name}`;
  } catch (e) {
    console.error(e);
    statusMessageEl.textContent = `Cannot open: ${item.name}`;
    removeFromRecentFiles(item.path);
  }
}

// ─── File Validation & Image Helpers ──────────────────────────────────────────
const TEXT_FILE_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "org", "rst", "log",
  "json", "json5", "yaml", "yml", "xml", "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "py", "c", "h", "cpp", "hpp", "cc", "cs",
  "go", "java", "kt", "sh", "bash", "zsh", "fish", "ini", "cfg", "conf", "toml", "env",
  "csv", "tsv", "tex", "sql", "patch", "diff", "properties", "gitignore", "dockerfile", "makefile"
]);

const IMAGE_FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"
]);

function getFileExtension(pathOrName) {
  if (!pathOrName) return "";
  const name = pathOrName.split(/[/\\]/).pop();
  if (name.startsWith(".") && !name.slice(1).includes(".")) return name.slice(1).toLowerCase();
  const parts = name.split(".");
  if (parts.length <= 1) return "";
  return parts.pop().toLowerCase();
}

function isTextFile(pathOrName) {
  if (!pathOrName) return true;
  const ext = getFileExtension(pathOrName);
  if (!ext) return true;
  return TEXT_FILE_EXTENSIONS.has(ext);
}

function isImageFile(pathOrName) {
  if (!pathOrName) return false;
  const ext = getFileExtension(pathOrName);
  return IMAGE_FILE_EXTENSIONS.has(ext);
}

function isLocalPath(src) {
  if (!src) return false;
  return !/^(https?:|data:|blob:|asset:|tauri:)/i.test(src);
}

function normalizePath(path) {
  const parts = path.split("/");
  const out = [];
  for (const p of parts) {
    if (p === ".." && out.length > 0) out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

function resolveToAbsolute(src) {
  if (!isLocalPath(src)) return null;
  if (src.startsWith("/")) return normalizePath(src);
  if (getCurrentFileDir()) return normalizePath(getCurrentFileDir().replace(/\\/g, "/") + "/" + src);
  return null;
}

function resolveNextcloudImagePath(src, docRemotePath) {
  if (!src) return null;
  let cleanSrc = src.trim();
  if (cleanSrc.includes("/remote.php/dav/files/")) {
    const idx = cleanSrc.indexOf("/remote.php/dav/files/");
    const afterFiles = cleanSrc.slice(idx + 22);
    const firstSlash = afterFiles.indexOf("/");
    if (firstSlash !== -1) {
      return normalizePath(afterFiles.slice(firstSlash + 1));
    }
  }
  if (cleanSrc.startsWith("/")) {
    return normalizePath(cleanSrc.slice(1));
  }
  if (docRemotePath) {
    const docDir = docRemotePath.includes("/") ? docRemotePath.replace(/\/[^/]+$/, "") : "";
    const combined = docDir ? `${docDir}/${cleanSrc}` : cleanSrc;
    return normalizePath(combined);
  }
  return normalizePath(cleanSrc);
}

async function loadLocalImage(img, src) {
  const active = getActiveFile();
  if (active && active.isNextcloud) {
    const ncPath = resolveNextcloudImagePath(src, active.remotePath);
    if (ncPath) {
      try {
        const dataUrl = await invoke("read_nextcloud_image_base64", { path: ncPath });
        img.setAttribute("src", dataUrl);
        return;
      } catch (err) {
        console.warn(`Nextcloud image not found: ${ncPath}`, err);
        img.setAttribute("alt", (img.getAttribute("alt") || "") + " [Nextcloud image not found]");
        return;
      }
    }
  }

  if (src && (src.includes("/remote.php/dav/files/") || src.startsWith("webdav://"))) {
    const ncPath = resolveNextcloudImagePath(src, null);
    if (ncPath) {
      try {
        const dataUrl = await invoke("read_nextcloud_image_base64", { path: ncPath });
        img.setAttribute("src", dataUrl);
        return;
      } catch (err) {
        console.warn(`Nextcloud image not found: ${ncPath}`, err);
      }
    }
  }

  const absPath = resolveToAbsolute(src);
  if (!absPath) return;
  try {
    const dataUrl = await invoke("read_image_base64", { path: absPath });
    img.setAttribute("src", dataUrl);
  } catch (err) {
    console.warn(`Image not found: ${absPath}`, err);
    img.setAttribute("alt", (img.getAttribute("alt") || "") + " [not found]");
  }
}

async function fixImageSrcs(el) {
  const imgs = Array.from(el.querySelectorAll("img"));
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute("src");
    if (!src) return;
    img.dataset.originalSrc = src;
    await loadLocalImage(img, src);
  }));
}

// ─── HTML → Markdown Serializer ──────────────────────────────────────────────

// Fix 6: Escape characters that Markdown would misinterpret in plain text nodes.
// Only applied to raw text nodes, NOT inside inline code or code blocks.
function escapeMarkdownText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/^(#{1,6}) /gm, "\\$1 ")  // prevent accidental headings at line start
    .replace(/^([-*+]) /gm, "\\$1 ")   // prevent accidental list items at line start
    .replace(/^(\d+)\. /gm, "$1\\. "); // prevent accidental ordered list items
}

function getAdmonitionIcon(type) {
  const t = (type || "").toUpperCase();
  switch (t) {
    case "NOTE": case "INFO": return "ℹ️";
    case "TIP": case "HINT": return "💡";
    case "IMPORTANT": case "QUOTE": return "⚡";
    case "WARNING": return "⚠️";
    case "CAUTION": case "DANGER": return "🛑";
    case "SUCCESS": return "✅";
    case "BUG": return "🐛";
    default: return "ℹ️";
  }
}

function admonitionToMd(node) {
  const type = (node.dataset.admonitionType || "NOTE").toUpperCase();
  const titleEl = node.querySelector(".admonition-title");
  const customTitle = titleEl ? titleEl.textContent.trim() : "";
  const defaultTitle = type.charAt(0) + type.slice(1).toLowerCase();

  const titleHeader = (customTitle && customTitle !== defaultTitle && customTitle !== type)
    ? ` "${customTitle}"`
    : "";

  const contentEl = node.querySelector(".admonition-content") || node;
  const inner = nodeToMd(contentEl, true).trim();

  const lines = [`> [!${type}]${titleHeader}`];
  if (inner) {
    inner.split("\n").forEach(l => lines.push(`> ${l}`));
  } else {
    lines.push(`> `);
  }
  return lines.join("\n") + "\n\n";
}

// Fix 2: Recursively serialise a blockquote, adding one `>` level per nesting depth.
function blockquoteToMd(node, depth) {
  const prefix = "> ".repeat(depth);
  const lines = [];
  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "blockquote") {
      // Nested blockquote — recurse, then trim trailing blank line
      const nested = blockquoteToMd(child, depth + 1).trimEnd();
      lines.push(nested);
    } else {
      const inner = nodeToMd(child, true /* insideBlock */).trimEnd();
      if (inner) {
        inner.split("\n").forEach(l => lines.push(prefix + l));
      }
    }
  }
  return lines.join("\n") + "\n\n";
}

function isInsideFootnotes(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== writerViewEl) {
    if (el.classList?.contains("footnote-definition") ||
        ((el.tagName === "SECTION" || el.tagName === "DIV" || el.tagName === "FOOTER" || el.tagName === "OL") &&
         (el.classList?.contains("footnotes") || el.classList?.contains("footnote-definition")))) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

function nodeToMd(node, insideBlock = false) {
  if (isInsideFootnotes(node)) return "";
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.textContent.replace(/\u200B/g, "");
    // Fix 6: escape only when outside a <code>/<pre> ancestor
    if (!insideBlock) {
      let ancestor = node.parentElement;
      while (ancestor) {
        const t = ancestor.tagName?.toLowerCase();
        if (t === "code" || t === "pre") return raw; // raw inside code
        ancestor = ancestor.parentElement;
      }
    }
    return insideBlock ? raw : escapeMarkdownText(raw);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  const children = (ib = insideBlock) => Array.from(node.childNodes).map(n => nodeToMd(n, ib)).join("");
  switch (tag) {
    case "h1": return `# ${children(true).trim()}\n\n`;
    case "h2": return `## ${children(true).trim()}\n\n`;
    case "h3": return `### ${children(true).trim()}\n\n`;
    case "h4": return `#### ${children(true).trim()}\n\n`;
    case "h5": return `##### ${children(true).trim()}\n\n`;
    case "h6": return `###### ${children(true).trim()}\n\n`;
    case "p":  return `${children()}\n\n`;
    case "br": return "  \n";
    // Fix 1: Bold+Italic — detect <strong><em> or <em><strong> nesting → ***text***
    case "strong": case "b": {
      const inner = children(true);
      // Check if the only child is an <em>/<i> (and vice versa)
      const soleChild = node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.ELEMENT_NODE
        ? node.childNodes[0].tagName.toLowerCase() : null;
      if (soleChild === "em" || soleChild === "i") {
        return `***${node.childNodes[0].textContent}***`;
      }
      return `**${inner}**`;
    }
    case "em": case "i": {
      const inner = children(true);
      const soleChild = node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.ELEMENT_NODE
        ? node.childNodes[0].tagName.toLowerCase() : null;
      if (soleChild === "strong" || soleChild === "b") {
        return `***${node.childNodes[0].textContent}***`;
      }
      return `*${inner}*`;
    }
    case "del": case "s": return `~~${children(true)}~~`;
    case "mark": {
      if (node.classList.contains("find-match")) return children(true);
      return `==${children(true)}==`;
    }
    case "code": {
      if (node.parentElement?.tagName.toLowerCase() === "pre") return node.textContent;
      // If the code content itself contains backticks, use double backticks as delimiter
      const codeText = node.textContent;
      const delim = codeText.includes("`") ? "`` " : "`";
      const suffix = codeText.includes("`") ? " ``" : "`";
      return `${delim}${codeText}${suffix}`;
    }
    case "pre": {
      const codeEl = node.querySelector("code");
      const lang = codeEl ? codeEl.className.replace(/language-/, "").trim() : "";
      // Walk child nodes so <br> → "\n" and text nodes → their text.
      // .textContent misses <br>-based line breaks (BR contributes "" to textContent).
      const source = codeEl || node;
      let codeText = "";
      source.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          codeText += child.textContent;
        } else if (child.nodeName === "BR") {
          codeText += "\n";
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // <div> or <p> — line block; <span> (syntax token) — inline text token
          const isLineBlock = child.nodeName === "DIV" || child.nodeName === "P";
          codeText += child.textContent + (isLineBlock ? "\n" : "");
        }
      });
      // Strip WebKit-inserted leading/trailing BR artefacts.
      codeText = codeText.replace(/^\n+/, "").replace(/\n+$/, "");
      return `\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
    }
    // Fix 3: Preserve link title attribute
    case "a": {
      const href = node.getAttribute("href") || "";
      const title = node.getAttribute("title");
      const label = children(true);
      if (title) return `[${label}](${href} "${title}")`;  
      return `[${label}](${href})`;
    }
    // Fix 4: Preserve image title attribute
    case "img": {
      const src = node.dataset.originalSrc || node.getAttribute("src") || "";
      const alt = node.getAttribute("alt") || "";
      const title = node.getAttribute("title");
      if (title) return `![${alt}](${src} "${title}")`;
      return `![${alt}](${src})`;
    }
    case "ul": {
      const items = Array.from(node.children).map((li) => `- ${liToMd(li)}`).join("\n");
      return `${items}\n\n`;
    }
    // Fix 5: Preserve ordered list start attribute
    case "ol": {
      const startAttr = parseInt(node.getAttribute("start") || "1", 10);
      const start = isNaN(startAttr) ? 1 : startAttr;
      const items = Array.from(node.children)
        .map((li, i) => `${start + i}. ${liToMd(li)}`).join("\n");
      return `${items}\n\n`;
    }
    case "li": return liToMd(node);
    case "blockquote": {
      if (node.classList.contains("admonition")) return admonitionToMd(node);
      return blockquoteToMd(node, 1);
    }
    case "hr": return `---\n\n`;
    case "table": {
      const rows = Array.from(node.querySelectorAll("tr"));
      if (!rows.length) return children();

      // Extract all grid cells as string matrix
      const matrix = rows.map(r => {
        return Array.from(r.querySelectorAll("th, td")).map(c => {
          // Convert cell children to markdown text without line breaks, escaping pipe symbols
          const text = nodeToMd(c, true).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
          return text;
        });
      });

      if (!matrix.length || !matrix[0].length) return "";

      const colCount = Math.max(...matrix.map(r => r.length));

      // Determine alignment per column
      const alignments = [];
      for (let j = 0; j < colCount; j++) {
        let align = "left";
        for (const r of rows) {
          const cells = Array.from(r.querySelectorAll("th, td"));
          const cell = cells[j];
          if (cell) {
            const a = (cell.getAttribute("align") || cell.style.textAlign || "").toLowerCase();
            if (a === "center" || a === "right" || a === "left") {
              align = a;
              break;
            }
          }
        }
        alignments.push(align);
      }

      // Calculate max width for each column j
      const colWidths = new Array(colCount).fill(3);
      for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < colCount; j++) {
          const val = matrix[i][j] || "";
          if (val.length > colWidths[j]) {
            colWidths[j] = val.length;
          }
        }
      }
      for (let j = 0; j < colCount; j++) {
        const minW = alignments[j] === "center" ? 5 : (alignments[j] === "right" || alignments[j] === "left" ? 4 : 3);
        if (colWidths[j] < minW) colWidths[j] = minW;
      }

      // Helper to pad cell string based on alignment
      const padCell = (text, width, align) => {
        const totalPad = Math.max(0, width - text.length);
        if (align === "right") {
          return " ".repeat(totalPad) + text;
        } else if (align === "center") {
          const leftPad = Math.floor(totalPad / 2);
          const rightPad = totalPad - leftPad;
          return " ".repeat(leftPad) + text + " ".repeat(rightPad);
        } else {
          return text + " ".repeat(totalPad);
        }
      };

      // Header row
      const headerRow = matrix[0];
      const headerLine = "| " + colWidths.map((w, j) => padCell(headerRow[j] || "", w, alignments[j])).join(" | ") + " |";

      // Delimiter row
      const delimiterLine = "| " + colWidths.map((w, j) => {
        const align = alignments[j];
        if (align === "center") {
          return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
        } else if (align === "right") {
          return "-".repeat(Math.max(2, w - 1)) + ":";
        } else if (align === "left") {
          return ":" + "-".repeat(Math.max(2, w - 1));
        } else {
          return "-".repeat(w);
        }
      }).join(" | ") + " |";

      // Body rows
      const bodyLines = matrix.slice(1).map(row => {
        return "| " + colWidths.map((w, j) => padCell(row[j] || "", w, alignments[j])).join(" | ") + " |";
      });

      return [headerLine, delimiterLine, ...bodyLines].join("\n") + "\n\n";
    }
    case "sub": return `~${children(true)}~`;
    case "sup": {
      if (isInsideFootnotes(node)) return "";
      const isFnRef = node.classList.contains("footnote-reference") ||
                      node.classList.contains("footnote-ref") ||
                      node.dataset.footnoteId != null ||
                      node.querySelector("a[href]") != null;
      if (isFnRef) {
        const rawId = node.dataset.footnoteId ||
                      node.querySelector("a")?.getAttribute("href") ||
                      node.textContent;
        const cleanId = String(rawId).replace(/^[#\[\^]*fn-?|^#/gi, "").replace(/[\]\$]*$/g, "").trim();
        return `[^${cleanId}]`;
      }
      return `^${children(true)}^`;
    }
    case "input": return "";
    case "div": case "section": case "article": {
      if (node.classList.contains("footnotes")) return "";
      const inner = children();
      return inner.endsWith("\n") ? inner : inner + "\n";
    }
    case "span": return children();
    case "script": case "style": return "";
    default: return children();
  }
}
function liToMd(li) {
  let inlineText = "";
  let checkboxPrefix = "";
  const checkbox = li.querySelector(":scope > input[type='checkbox'], :scope > label > input[type='checkbox']");
  if (checkbox) {
    checkboxPrefix = checkbox.checked ? "[x] " : "[ ] ";
  }

  const nestedLists = [];

  for (const child of li.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      inlineText += child.textContent.replace(/\u200B/g, "");
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const t = child.tagName.toLowerCase();
      if (t === "input") continue;
      if (t === "ul" || t === "ol") {
        nestedLists.push(child);
      } else if (t === "br") {
        inlineText += "  \n";
      } else {
        inlineText += nodeToMd(child);
      }
    }
  }

  let result = (checkboxPrefix + inlineText.trim()).trim();

  if (nestedLists.length > 0) {
    for (const nestedList of nestedLists) {
      const nestedMd = nodeToMd(nestedList).trimEnd();
      if (nestedMd) {
        const indented = nestedMd.split("\n").map(line => line ? `  ${line}` : "").join("\n");
        result += "\n" + indented;
      }
    }
  }

  return result;
}
function htmlToMarkdown(el) {
  let md = Array.from(el.childNodes)
    .map(n => {
      const res = nodeToMd(n);
      if (!res) return "";
      return res.endsWith("\n") ? res : res + "\n\n";
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const seenIds = new Set();
  const uniqueFnLines = [];
  if (docFootnotes && docFootnotes.length > 0) {
    for (const f of docFootnotes) {
      const cleanId = (f.id || "").replace(/^#?fn-?/gi, "").trim();
      if (cleanId && f.text.trim() && !seenIds.has(cleanId)) {
        seenIds.add(cleanId);
        uniqueFnLines.push(`[^${cleanId}]: ${f.text.trim()}`);
      }
    }
  }

  if (uniqueFnLines.length > 0) {
    md += "\n\n" + uniqueFnLines.join("\n");
  }
  return md;
}

// ─── Footnote Manager & Drawer ────────────────────────────────────────────────
let docFootnotes = [];

function getNextFootnoteId() {
  let maxNum = 0;
  for (const fn of docFootnotes) {
    const num = parseInt(fn.id, 10);
    if (!isNaN(num) && num > maxNum) maxNum = num;
  }
  return String(maxNum + 1);
}

function parseFootnotesFromMarkdown(mdText) {
  const fns = [];
  if (!mdText) return fns;
  const rx = /^\[\^([^\]]+)\]:\s*(.*)$/gm;
  let m;
  while ((m = rx.exec(mdText)) !== null) {
    fns.push({ id: m[1], text: m[2] });
  }
  return fns;
}

function openFootnoteDrawer(focusId = null) {
  const drawer = document.getElementById("footnote-drawer");
  if (!drawer) return;
  drawer.classList.remove("hidden");
  renderFootnoteDrawer();
  if (focusId) {
    const input = drawer.querySelector(`.footnote-input[data-footnote-id="${CSS.escape(focusId)}"]`);
    if (input) {
      input.focus();
      input.select();
      const row = input.closest(".footnote-row");
      if (row) {
        row.classList.add("active-row");
        setTimeout(() => row.classList.remove("active-row"), 1500);
      }
    }
  }
}

function closeFootnoteDrawer() {
  const drawer = document.getElementById("footnote-drawer");
  if (drawer) drawer.classList.add("hidden");
}

function toggleFootnoteDrawer() {
  const drawer = document.getElementById("footnote-drawer");
  if (!drawer) return;
  if (drawer.classList.contains("hidden")) {
    openFootnoteDrawer();
  } else {
    closeFootnoteDrawer();
  }
}

function renderFootnoteDrawer() {
  const list = document.getElementById("footnote-list");
  const countBadge = document.getElementById("footnote-count-badge");
  if (!list) return;

  if (countBadge) countBadge.textContent = String(docFootnotes.length);
  list.innerHTML = "";

  if (docFootnotes.length === 0) {
    const hint = document.createElement("div");
    hint.className = "footnote-empty-hint";
    hint.textContent = "No footnotes added yet. Click '➕ Add Footnote' or the toolbar button to create one.";
    list.appendChild(hint);
    return;
  }

  docFootnotes.forEach((fn) => {
    const row = document.createElement("div");
    row.className = "footnote-row";

    const label = document.createElement("span");
    label.className = "footnote-label-tag";
    label.textContent = `[^${fn.id}]`;
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "footnote-input";
    input.dataset.footnoteId = fn.id;
    input.placeholder = `Enter footnote content for [^${fn.id}]...`;
    input.value = fn.text;

    input.addEventListener("input", () => {
      fn.text = input.value;
      debouncedStats();
    });

    row.appendChild(input);

    const jumpBtn = document.createElement("button");
    jumpBtn.className = "footnote-action-btn";
    jumpBtn.title = "Jump to reference in text";
    jumpBtn.innerHTML = `↟`;
    jumpBtn.addEventListener("click", () => jumpToFootnoteRef(fn.id));
    row.appendChild(jumpBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "footnote-action-btn danger-hover";
    delBtn.title = "Delete footnote";
    delBtn.innerHTML = `🗑`;
    delBtn.addEventListener("click", () => deleteFootnote(fn.id));
    row.appendChild(delBtn);

    list.appendChild(row);
  });
}

function jumpToFootnoteRef(id) {
  if (isMarkdownMode) {
    const ta = markdownInputEl;
    const pos = ta.value.indexOf(`[^${id}]`);
    if (pos !== -1) {
      ta.focus();
      ta.setSelectionRange(pos, pos + id.length + 3);
    }
  } else {
    const refs = Array.from(writerViewEl.querySelectorAll("sup.footnote-reference, sup.footnote-ref, [data-footnote-id]"));
    const match = refs.find(r => r.dataset.footnoteId === id || r.textContent.includes(id));
    if (match) {
      match.scrollIntoView({ behavior: "smooth", block: "center" });
      match.classList.add("just-formatted");
      setTimeout(() => match.classList.remove("just-formatted"), 1500);
      placeCaretAfter(match);
      writerViewEl.focus();
    }
  }
}

function deleteFootnote(id) {
  docFootnotes = docFootnotes.filter(f => f.id !== id);
  if (!isMarkdownMode) {
    const refs = Array.from(writerViewEl.querySelectorAll("sup.footnote-reference, sup.footnote-ref, [data-footnote-id]"));
    refs.forEach(r => {
      if (r.dataset.footnoteId === id || r.textContent.trim() === id || r.textContent.trim() === `[${id}]`) {
        r.remove();
      }
    });
  } else {
    const rxDef = new RegExp(`^\\[\\^${id}\\]:.*$\\n?`, "gm");
    markdownInputEl.value = markdownInputEl.value.replace(rxDef, "");
  }
  renderFootnoteDrawer();
  debouncedStats();
}

function applyFootnote() {
  const newId = getNextFootnoteId();
  docFootnotes.push({ id: newId, text: "" });

  if (isMarkdownMode) {
    const ta = markdownInputEl;
    const s = ta.selectionStart;
    const refText = `[^${newId}]`;
    ta.value = ta.value.slice(0, s) + refText + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = s + refText.length;
    if (!ta.value.includes(`[^${newId}]:`)) {
      ta.value = ta.value.trimEnd() + `\n\n[^${newId}]: `;
    }
    ta.focus();
    openFootnoteDrawer(newId);
  } else {
    restoreSelection();
    const sel = window.getSelection();
    const sup = document.createElement("sup");
    sup.className = "footnote-reference";
    sup.dataset.footnoteId = newId;
    sup.contentEditable = "false";
    sup.textContent = newId;
    sup.title = `Footnote [^${newId}]`;

    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(sup);
      placeCaretAfter(sup);
    } else {
      writerViewEl.appendChild(sup);
    }
    writerViewEl.focus();
    openFootnoteDrawer(newId);
  }
  debouncedStats();
}

// ─── Markdown Render & Syntax Highlighting ───────────────────────────────────
function applySyntaxHighlighting(container = writerViewEl) {
  if (typeof highlightCode !== "function") return;
  try {
    const blocks = container.querySelectorAll("pre code");
    blocks.forEach(codeEl => {
      const lang = codeEl.className.replace(/language-/, "").trim();
      if (!lang) return;
      const rawCode = codeEl.textContent;
      const highlighted = highlightCode(rawCode, lang);
      codeEl.innerHTML = highlighted;
    });
  } catch (err) {
    console.warn("Syntax highlight warning:", err);
  }
}

async function renderMarkdownToWriter(markdownText) {
  try {
    docFootnotes = parseFootnotesFromMarkdown(markdownText);
    const html = await invoke("parse_markdown", { text: markdownText });
    writerViewEl.innerHTML = html;
    await fixImageSrcs(writerViewEl);
    applySyntaxHighlighting(writerViewEl);
    enhanceWriterTaskLists(writerViewEl);
    enhanceWriterFootnotes();
    enhanceWriterExtendedSyntax(writerViewEl);
    enhanceWriterAdmonitions(writerViewEl);
  } catch (e) {
    writerViewEl.innerHTML = `<p style="color:var(--red)">Render error: ${e}</p>`;
  }
}

function ensureTaskTextSpan(li) {
  let span = li.querySelector(":scope > span.task-text");
  if (!span) {
    span = document.createElement("span");
    span.className = "task-text";
    const nodesToMove = [];
    let pastInput = false;
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "INPUT") {
        pastInput = true;
        continue;
      }
      if (pastInput) {
        if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === "UL" || child.tagName === "OL")) {
          break;
        }
        nodesToMove.push(child);
      }
    }
    if (nodesToMove.length > 0) {
      const refNode = nodesToMove[0];
      li.insertBefore(span, refNode);
      nodesToMove.forEach(n => span.appendChild(n));
    } else {
      const tn = document.createTextNode("\u200B ");
      span.appendChild(tn);
      li.appendChild(span);
    }
  }
}

function enhanceWriterTaskLists(container = writerViewEl) {
  const checkboxes = container.querySelectorAll("input[type='checkbox']");
  checkboxes.forEach(cb => {
    cb.removeAttribute("disabled");
    cb.contentEditable = "false";
    const li = cb.closest("li");
    if (li) {
      li.classList.add("task-list-item");
      const list = li.parentElement;
      if (list && (list.tagName === "UL" || list.tagName === "OL")) {
        list.classList.add("contains-task-list");
      }
      ensureTaskTextSpan(li);
    }
  });
}

function enhanceWriterFootnotes() {
  // First, extract any footnote text from footnote-definition before removing them
  const fnDefs = writerViewEl.querySelectorAll(".footnote-definition, section.footnotes li, div.footnotes li");
  fnDefs.forEach(def => {
    const rawId = def.id || def.querySelector("[id]")?.id || "";
    const cleanId = rawId.replace(/^fn-?|^#fn-?/gi, "").trim();
    const textEl = def.querySelector("p") || def;
    const clone = textEl.cloneNode(true);
    clone.querySelectorAll(".footnote-backref, .footnote-definition-label, a[href^='#']").forEach(el => el.remove());
    const text = clone.textContent.trim();
    if (cleanId && text && !docFootnotes.some(f => f.id === cleanId)) {
      docFootnotes.push({ id: cleanId, text });
    }
  });

  // Remove footnote definitions container from writerViewEl DOM
  writerViewEl.querySelectorAll(".footnote-definition, section.footnotes, div.footnotes, footer.footnotes").forEach(el => el.remove());

  // Format footnote references in body text as pill buttons
  const sups = writerViewEl.querySelectorAll("sup.footnote-reference, sup.footnote-ref, .footnote-ref, a[href^='#']");
  sups.forEach(target => {
    if (!target || !target.parentNode) return;
    let sup = target.tagName?.toLowerCase() === "sup" ? target : target.closest("sup");
    if (!sup) {
      if (!target.parentNode) return;
      sup = document.createElement("sup");
      target.parentNode.insertBefore(sup, target);
      sup.appendChild(target);
    }
    sup.className = "footnote-reference";
    sup.contentEditable = "false";

    const a = sup.querySelector("a");
    const rawId = sup.dataset.footnoteId || (a ? (a.getAttribute("href") || a.textContent) : sup.textContent);
    const cleanId = (rawId || "").replace(/^[#\[\^]*fn-?|^#/gi, "").replace(/[\]\$]*$/g, "").trim();
    sup.dataset.footnoteId = cleanId;
    sup.textContent = cleanId || "1";

    const fn = docFootnotes.find(f => f.id === cleanId);
    if (fn && fn.text) {
      sup.title = `[^${cleanId}]: ${fn.text}`;
    } else {
      sup.title = `Footnote [^${cleanId}]`;
    }
  });

  renderFootnoteDrawer();
}

function enhanceWriterExtendedSyntax(container = writerViewEl) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== container) {
        const t = p.tagName.toLowerCase();
        if (t === "code" || t === "pre" || t === "script" || t === "style" || t === "sup" || t === "sub" || t === "mark" || p.classList?.contains("footnote-reference") || p.classList?.contains("footnote-ref") || p.classList?.contains("footnote-definition") || p.classList?.contains("footnotes")) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const text = node.textContent;
    if (!text) continue;
    if (!text.includes("==") && !text.includes("~") && !text.includes("^")) continue;

    let html = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
      .replace(/(?<!~)~([^~\n]+)~(?!~)/g, '<sub>$1</sub>')
      .replace(/(?<!\^)\^([^\^\n]+)\^(?!\^)/g, '<sup>$1</sup>');

    if (html !== text) {
      const span = document.createElement("span");
      span.innerHTML = html;
      node.parentNode.replaceChild(span, node);
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      span.parentNode.removeChild(span);
    }
  }
}

function enhanceWriterAdmonitions(container = writerViewEl) {
  if (!container) return;

  // 1. Process paragraphs / divs containing MkDocs admonition syntax: `!!! type "title"`
  const children = Array.from(container.children);
  const mkdocsRegex = /^\s*!!!\s*([a-zA-Z0-9_-]+)(?:\s+(?:"([^"]+)"|'([^']+)'|(.*)))?\s*$/;

  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.tagName === "BLOCKQUOTE" || el.classList.contains("admonition")) continue;
    const text = (el.textContent || "").trim();
    const match = text.match(mkdocsRegex);

    if (match) {
      const type = match[1].toUpperCase();
      const defaultTitle = type.charAt(0) + type.slice(1).toLowerCase();
      const rawTitle = match[2] || match[3] || match[4] || "";
      const title = rawTitle.trim() || defaultTitle;
      const icon = getAdmonitionIcon(type);

      const adm = document.createElement("blockquote");
      adm.className = `admonition admonition-${type.toLowerCase()}`;
      adm.dataset.admonitionType = type;

      const headerDiv = document.createElement("div");
      headerDiv.className = "admonition-header";
      headerDiv.contentEditable = "false";

      const iconSpan = document.createElement("span");
      iconSpan.className = "admonition-icon";
      iconSpan.textContent = icon;
      headerDiv.appendChild(iconSpan);

      const titleSpan = document.createElement("span");
      titleSpan.className = "admonition-title";
      titleSpan.contentEditable = "true";
      titleSpan.textContent = title;
      headerDiv.appendChild(titleSpan);

      const contentDiv = document.createElement("div");
      contentDiv.className = "admonition-content";

      const p = document.createElement("p");
      p.appendChild(document.createTextNode("\u200B"));
      contentDiv.appendChild(p);

      adm.appendChild(headerDiv);
      adm.appendChild(contentDiv);

      container.insertBefore(adm, el);
      el.remove();
    }
  }

  // 2. Process blockquotes for GFM callouts `> [!TYPE]` or `> **Note:** text`
  const blockquotes = Array.from(container.querySelectorAll("blockquote"));
  const calloutRegex = /^\s*\[\!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|DANGER|BUG|QUOTE|HINT)\](?:\s+(.*))?$/i;
  const boldHeaderRegex = /^\s*\*\*?(Note|Tip|Important|Warning|Caution|Info|Success|Danger|Bug):\*\*?\s*(.*)$/i;

  for (const bq of blockquotes) {
    if (bq.classList.contains("admonition")) continue;

    const firstP = bq.querySelector("p") || bq;
    const text = firstP.textContent || "";
    const lines = text.split("\n");
    const match = lines[0].match(calloutRegex);
    const boldMatch = !match ? lines[0].match(boldHeaderRegex) : null;

    if (match || boldMatch) {
      const type = (match ? match[1] : boldMatch[1]).toUpperCase();
      const defaultTitle = type.charAt(0) + type.slice(1).toLowerCase();
      const icon = getAdmonitionIcon(type);

      let customTitle = defaultTitle;

      if (match) {
        const restLine1 = (match[2] || "").trim();
        const hasMoreLines = lines.length > 1 || bq.children.length > 1;

        if (restLine1.startsWith('"') && restLine1.endsWith('"') && restLine1.length > 2) {
          customTitle = restLine1.slice(1, -1);
          lines.shift();
        } else if (hasMoreLines && restLine1) {
          customTitle = restLine1;
          lines.shift();
        } else if (restLine1) {
          customTitle = defaultTitle;
          lines[0] = restLine1;
        } else {
          customTitle = defaultTitle;
          lines.shift();
        }
      } else if (boldMatch) {
        const restLine1 = boldMatch[2].trim();
        customTitle = defaultTitle;
        if (restLine1) {
          lines[0] = restLine1;
        } else {
          lines.shift();
        }
      }

      bq.className = `admonition admonition-${type.toLowerCase()}`;
      bq.dataset.admonitionType = type;

      const remText = lines.join("\n").trim();
      if (firstP.tagName === "P") {
        if (remText) {
          firstP.textContent = remText;
        } else {
          firstP.remove();
        }
      }

      const contentDiv = document.createElement("div");
      contentDiv.className = "admonition-content";
      while (bq.firstChild) {
        contentDiv.appendChild(bq.firstChild);
      }
      if (!contentDiv.firstElementChild && !contentDiv.textContent.trim()) {
        const p = document.createElement("p");
        p.appendChild(document.createTextNode("\u200B"));
        contentDiv.appendChild(p);
      }

      const headerDiv = document.createElement("div");
      headerDiv.className = "admonition-header";
      headerDiv.contentEditable = "false";

      const iconSpan = document.createElement("span");
      iconSpan.className = "admonition-icon";
      iconSpan.textContent = icon;
      headerDiv.appendChild(iconSpan);

      const titleSpan = document.createElement("span");
      titleSpan.className = "admonition-title";
      titleSpan.contentEditable = "true";
      titleSpan.textContent = customTitle;
      headerDiv.appendChild(titleSpan);

      bq.appendChild(headerDiv);
      bq.appendChild(contentDiv);
    }
  }

  // Ensure there is always a trailing paragraph after the last element if it's an admonition
  const lastChild = container.lastElementChild;
  if (lastChild && (lastChild.tagName === "BLOCKQUOTE" || lastChild.classList.contains("admonition"))) {
    const emptyP = document.createElement("p");
    emptyP.appendChild(document.createElement("br"));
    container.appendChild(emptyP);
  }
}

function getAdmonitionAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== writerViewEl) {
    if (el.tagName === "BLOCKQUOTE" && el.classList.contains("admonition")) return el;
    el = el.parentElement;
  }
  return null;
}

function insertAdmonition(type = "note", titleText = "", bodyText = "") {
  if (isMarkdownMode) {
    const rawType = (type || "note").toUpperCase();
    const defaultTitle = rawType.charAt(0) + rawType.slice(1).toLowerCase();
    const title = titleText || defaultTitle;
    const titlePart = title !== defaultTitle ? ` "${title}"` : "";
    const content = bodyText || "Admonition content here...";
    const mdSnippet = `> [!${rawType}]${titlePart}\n> ${content}\n\n`;
    insertAtCursor(mdSnippet);
  } else {
    restoreSelection();
    const rawType = (type || "note").toUpperCase();
    const icon = getAdmonitionIcon(rawType);
    const defaultTitle = rawType.charAt(0) + rawType.slice(1).toLowerCase();
    const title = titleText || defaultTitle;
    const content = bodyText || "Admonition content here...";

    const bq = document.createElement("blockquote");
    bq.className = `admonition admonition-${rawType.toLowerCase()}`;
    bq.dataset.admonitionType = rawType;

    const headerDiv = document.createElement("div");
    headerDiv.className = "admonition-header";
    headerDiv.contentEditable = "false";

    const iconSpan = document.createElement("span");
    iconSpan.className = "admonition-icon";
    iconSpan.textContent = icon;
    headerDiv.appendChild(iconSpan);

    const titleSpan = document.createElement("span");
    titleSpan.className = "admonition-title";
    titleSpan.contentEditable = "true";
    titleSpan.textContent = title;
    headerDiv.appendChild(titleSpan);

    const contentDiv = document.createElement("div");
    contentDiv.className = "admonition-content";
    const p = document.createElement("p");
    p.textContent = content;
    contentDiv.appendChild(p);

    bq.appendChild(headerDiv);
    bq.appendChild(contentDiv);

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(bq);

      const emptyP = document.createElement("p");
      emptyP.appendChild(document.createTextNode("\u200B"));
      if (bq.nextSibling) {
        bq.parentNode.insertBefore(emptyP, bq.nextSibling);
      } else {
        bq.parentNode.appendChild(emptyP);
      }

      const newRange = document.createRange();
      newRange.selectNodeContents(p);
      newRange.collapse(false);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } else {
      writerViewEl.appendChild(bq);
    }
    debouncedStats();
  }
}

// ─── View Modes (Writer, Markdown, Split) ───────────────────────────────────
let currentViewMode = "writer"; // "writer", "markdown", or "split"

async function setViewMode(mode) {
  currentViewMode = mode;
  const editorArea = document.getElementById("editor-area");
  const writerBtn = document.getElementById("mode-writer-btn");
  const mdBtn = document.getElementById("mode-markdown-btn");
  const splitBtn = document.getElementById("mode-split-btn");

  [writerBtn, mdBtn, splitBtn].forEach(b => b?.classList.remove("active"));
  if (editorArea) {
    editorArea.classList.remove("writer-active", "markdown-active", "split-active");
  }

  if (mode === "split") {
    isMarkdownMode = false;
    splitBtn?.classList.add("active");
    editorArea?.classList.add("split-active");
    if (modeIndicatorEl) modeIndicatorEl.textContent = "Split Mode (Antigravity)";

    const content = markdownInputEl.value || htmlToMarkdown(writerViewEl);
    markdownInputEl.value = content;
    await renderMarkdownToWriter(content);
  } else if (mode === "markdown") {
    isMarkdownMode = true;
    mdBtn?.classList.add("active");
    editorArea?.classList.add("markdown-active");
    if (modeIndicatorEl) modeIndicatorEl.textContent = "Markdown Mode";

    const md = htmlToMarkdown(writerViewEl) || markdownInputEl.value;
    markdownInputEl.value = md;
    markdownInputEl.focus();
  } else {
    currentViewMode = "writer";
    isMarkdownMode = false;
    writerBtn?.classList.add("active");
    editorArea?.classList.add("writer-active");
    if (modeIndicatorEl) modeIndicatorEl.textContent = "Writer Mode";

    await renderMarkdownToWriter(markdownInputEl.value);
    writerViewEl.focus();
  }
}

async function toggleMode() {
  if (currentViewMode === "writer") {
    await setViewMode("markdown");
  } else if (currentViewMode === "markdown") {
    await setViewMode("split");
  } else {
    await setViewMode("writer");
  }
}


// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const BLOCK_TAGS = new Set([
  "P","DIV","H1","H2","H3","H4","H5","H6",
  "LI","BLOCKQUOTE","PRE","SECTION","ARTICLE"
]);
function isBlockEl(el) { return el && BLOCK_TAGS.has(el.tagName); }
function getBlockAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== writerViewEl) {
    if (isBlockEl(el)) return el;
    el = el.parentElement;
  }
  return null;
}
/** Place caret immediately after an element (e.g. after a checkbox). */
function placeCaretAfter(el) {
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStartAfter(el);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  _savedRange = r.cloneRange();
}

/** Place caret at a specific offset within a text node. */
function placeCaret(node, offset) {
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  _savedRange = r.cloneRange();
}



// ─── Direct DOM List / Block Builders ────────────────────────────────────────
function buildUL(replaceTarget, remainingText) {
  const ul = document.createElement("ul");
  const li = document.createElement("li");
  const tn = document.createTextNode(remainingText);
  li.appendChild(tn); ul.appendChild(li);
  replaceTarget.parentNode.replaceChild(ul, replaceTarget);
  // place caret at start of text node
  const r = document.createRange();
  r.setStart(tn, 0); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  _savedRange = r.cloneRange();
}
function buildOL(replaceTarget, remainingText) {
  const ol = document.createElement("ol");
  const li = document.createElement("li");
  const tn = document.createTextNode(remainingText);
  li.appendChild(tn); ol.appendChild(li);
  replaceTarget.parentNode.replaceChild(ol, replaceTarget);
  const r = document.createRange();
  r.setStart(tn, 0); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  _savedRange = r.cloneRange();
}

function buildBlockquote(replaceTarget, remainingText) {
  const bq = document.createElement("blockquote");
  const tn = document.createTextNode(remainingText);
  bq.appendChild(tn);
  replaceTarget.parentNode.replaceChild(bq, replaceTarget);
  placeCaret(tn, 0);
}



function indentListItem(li) {
  const prevLi = li.previousElementSibling;
  if (!prevLi || prevLi.tagName !== "LI") return false;

  let nestedList = prevLi.querySelector(":scope > ul, :scope > ol");
  if (!nestedList) {
    const isOrdered = li.parentElement?.tagName === "OL";
    nestedList = document.createElement(isOrdered ? "ol" : "ul");
    if (li.classList.contains("task-list-item") || li.querySelector("input[type='checkbox']")) {
      nestedList.classList.add("contains-task-list");
    }
    prevLi.appendChild(nestedList);
  }

  nestedList.appendChild(li);

  const targetText = Array.from(li.childNodes).find(n => n.nodeType === Node.TEXT_NODE) || li;
  placeCaret(targetText, targetText.textContent ? targetText.textContent.length : 0);
  writerViewEl.focus();
  debouncedStats();
  return true;
}

function outdentListItem(li) {
  const parentList = li.parentElement;
  if (!parentList || (parentList.tagName !== "UL" && parentList.tagName !== "OL")) return false;

  const parentLi = parentList.closest("li");
  if (parentLi) {
    const grandParentList = parentLi.parentElement;
    if (parentLi.nextSibling) {
      grandParentList.insertBefore(li, parentLi.nextSibling);
    } else {
      grandParentList.appendChild(li);
    }
    if (parentList.children.length === 0) {
      parentList.remove();
    }
  } else {
    const p = document.createElement("p");
    const nodes = Array.from(li.childNodes).filter(n => n.nodeName !== "INPUT");
    if (nodes.length === 0) p.appendChild(document.createElement("br"));
    else nodes.forEach(n => p.appendChild(n));

    if (parentList.nextSibling) {
      parentList.parentNode.insertBefore(p, parentList.nextSibling);
    } else {
      parentList.parentNode.appendChild(p);
    }
    li.remove();
    if (parentList.children.length === 0) {
      parentList.remove();
    }
    placeCaret(p, 0);
  }

  writerViewEl.focus();
  debouncedStats();
  return true;
}

function buildTaskList(replaceTarget, remainingText, isChecked = false) {
  const isLi = replaceTarget.tagName === "LI";
  let ul, li;
  if (isLi) {
    li = replaceTarget;
    li.innerHTML = "";
    li.classList.add("task-list-item");
    if (li.parentElement) li.parentElement.classList.add("contains-task-list");
  } else {
    ul = document.createElement("ul");
    ul.className = "contains-task-list";
    li = document.createElement("li");
    li.className = "task-list-item";
    ul.appendChild(li);
    replaceTarget.parentNode.replaceChild(ul, replaceTarget);
  }

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.contentEditable = "false";
  if (isChecked) cb.checked = true;

  const span = document.createElement("span");
  span.className = "task-text";
  const textVal = remainingText ? " " + remainingText : "\u200B ";
  const tn = document.createTextNode(textVal);
  span.appendChild(tn);

  li.appendChild(cb);
  li.appendChild(span);

  placeCaret(tn, 1);
  debouncedStats();
}

// ─── Space Key: Block Syntax Trigger ─────────────────────────────────────────
function handleSpaceInWriter() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) return false;
  const textBefore = container.textContent.slice(0, range.startOffset);
  const textAfter  = container.textContent.slice(range.startOffset);
  const block = getBlockAncestor(container);
  if (block) {
    if (/^H[1-6]|BLOCKQUOTE|PRE/.test(block.tagName)) return false;
    if (block.tagName === "LI" && block.querySelector("input[type='checkbox']")) return false;
    if (block.textContent !== textBefore) return false;
  } else {
    if (container.parentNode !== writerViewEl) return false;
  }
  const target = block || container;

  const taskMatch = textBefore.match(/^([-*+]|\d+\.)\s*\[([ xX]?)\]$/) || textBefore.match(/^\[([ xX]?)\]$/);
  if (taskMatch) {
    const checkChar = taskMatch[2] || taskMatch[1];
    const isChecked = typeof checkChar === "string" && checkChar.toLowerCase() === "x";
    buildTaskList(target, textAfter, isChecked);
    return true;
  }

  switch (textBefore) {
    case "-":
    case "*": buildUL(target, textAfter); return true;
    case "1.": buildOL(target, textAfter); return true;
    case ">": buildBlockquote(target, textAfter); return true;
  }

  return false;
}

// ─── Formatting — Writer Mode ─────────────────────────────────────────────────
function writerExec(cmd) {
  restoreSelection();
  document.execCommand(cmd);
  writerViewEl.focus();
}

function applyRichFormat(execCmd, mdPrefix, mdSuffix = mdPrefix) {
  if (!isMarkdownMode) {
    writerExec(execCmd);
  } else {
    wrapMarkdownSelection(mdPrefix, mdSuffix);
  }
}

function applyHeading(level) {
  if (!isMarkdownMode) {
    restoreSelection();
    document.execCommand("formatBlock", false, `h${level}`);
    writerViewEl.focus();
  } else {
    setMarkdownHeading(level);
  }
}

function applyCode() {
  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const selected = range.toString();
    range.deleteContents();
    const code = document.createElement("code");
    code.textContent = selected || " ";
    range.insertNode(code);
    range.setStartAfter(code); range.setEndAfter(code);
    sel.removeAllRanges(); sel.addRange(range);
    writerViewEl.focus();
  } else { wrapMarkdownSelection("`", "`"); }
}

function applyHighlight() {
  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    let parentMark = null;
    let node = range.commonAncestorContainer;
    while (node && node !== writerViewEl) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "mark") {
        parentMark = node;
        break;
      }
      node = node.parentNode;
    }

    if (parentMark) {
      const parent = parentMark.parentNode;
      while (parentMark.firstChild) {
        parent.insertBefore(parentMark.firstChild, parentMark);
      }
      parent.removeChild(parentMark);
    } else {
      const selected = range.toString();
      if (!selected) return;
      range.deleteContents();
      const mark = document.createElement("mark");
      mark.textContent = selected;
      range.insertNode(mark);
      range.setStartAfter(mark);
      range.setEndAfter(mark);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    writerViewEl.focus();
    debouncedStats();
  } else {
    wrapMarkdownSelection("==", "==");
  }
}

function applySubscript() {
  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    let parentSub = null;
    let node = range.commonAncestorContainer;
    while (node && node !== writerViewEl) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "sub") {
        parentSub = node;
        break;
      }
      node = node.parentNode;
    }

    if (parentSub) {
      const parent = parentSub.parentNode;
      while (parentSub.firstChild) {
        parent.insertBefore(parentSub.firstChild, parentSub);
      }
      parent.removeChild(parentSub);
    } else {
      const selected = range.toString();
      if (!selected) return;
      range.deleteContents();
      const sub = document.createElement("sub");
      sub.textContent = selected;
      range.insertNode(sub);
      range.setStartAfter(sub);
      range.setEndAfter(sub);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    writerViewEl.focus();
    debouncedStats();
  } else {
    wrapMarkdownSelection("~", "~");
  }
}

function applySuperscript() {
  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    let parentSup = null;
    let node = range.commonAncestorContainer;
    while (node && node !== writerViewEl) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "sup" && !node.classList.contains("footnote-reference") && !node.classList.contains("footnote-ref") && !node.dataset.footnoteId) {
        parentSup = node;
        break;
      }
      node = node.parentNode;
    }

    if (parentSup) {
      const parent = parentSup.parentNode;
      while (parentSup.firstChild) {
        parent.insertBefore(parentSup.firstChild, parentSup);
      }
      parent.removeChild(parentSup);
    } else {
      const selected = range.toString();
      if (!selected) return;
      range.deleteContents();
      const sup = document.createElement("sup");
      sup.textContent = selected;
      range.insertNode(sup);
      range.setStartAfter(sup);
      range.setEndAfter(sup);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    writerViewEl.focus();
    debouncedStats();
  } else {
    wrapMarkdownSelection("^", "^");
  }
}

function applyLink() {
  const defaultUrl = "https://duckduckgo.com";
  const defaultPlaceholder = "link-placeholder";

  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    let selectedText = "";
    if (sel && sel.rangeCount) {
      selectedText = sel.getRangeAt(0).toString();
    }
    const url = prompt("Enter URL:", defaultUrl);
    if (!url) return;

    let linkText = selectedText.trim();
    if (!linkText) {
      const inputTitle = prompt("Enter link text / placeholder:", defaultPlaceholder);
      linkText = (inputTitle && inputTitle.trim()) ? inputTitle.trim() : defaultPlaceholder;
    }

    restoreSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const a = document.createElement("a");
      a.href = url;
      a.textContent = linkText;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      range.insertNode(a);
      range.setStartAfter(a);
      range.setEndAfter(a);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    writerViewEl.focus();
    debouncedStats();
  } else {
    const start = markdownInputEl.selectionStart;
    const end = markdownInputEl.selectionEnd;
    let selectedText = markdownInputEl.value.substring(start, end).trim();

    const url = prompt("Enter URL:", defaultUrl);
    if (!url) return;

    if (!selectedText) {
      const inputTitle = prompt("Enter link text / placeholder:", defaultPlaceholder);
      selectedText = (inputTitle && inputTitle.trim()) ? inputTitle.trim() : defaultPlaceholder;
    }

    const markdownLink = `[${selectedText}](${url})`;
    const before = markdownInputEl.value.substring(0, start);
    const after = markdownInputEl.value.substring(end);
    markdownInputEl.value = before + markdownLink + after;
    markdownInputEl.selectionStart = start + markdownLink.length;
    markdownInputEl.selectionEnd = start + markdownLink.length;
    markdownInputEl.focus();
    debouncedStats();
  }
}

function applyBlockquote() {
  if (!isMarkdownMode) {
    restoreSelection();
    document.execCommand("formatBlock", false, "blockquote");
    writerViewEl.focus();
  } else { wrapMarkdownLines("> "); }
}

function applyUnorderedList() {
  if (!isMarkdownMode) {
    restoreSelection();
    document.execCommand("insertUnorderedList");
    writerViewEl.focus();
  } else {
    const ta = markdownInputEl;
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    const line = ta.value.slice(start, ta.value.indexOf("\n", ta.selectionStart));
    if (!/^- /.test(line)) {
      const ins = "- ";
      ta.value = ta.value.slice(0, start) + ins + ta.value.slice(start);
      ta.selectionStart = ta.selectionEnd = ta.selectionStart + ins.length;
    }
    ta.focus();
  }
}

function applyOrderedList() {
  if (!isMarkdownMode) {
    restoreSelection();
    document.execCommand("insertOrderedList");
    writerViewEl.focus();
  } else {
    const ta = markdownInputEl;
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    const ins = "1. ";
    ta.value = ta.value.slice(0, start) + ins + ta.value.slice(start);
    ta.selectionStart = ta.selectionEnd = ta.selectionStart + ins.length;
    ta.focus();
  }
}

function applyTaskList() {
  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const block = getBlockAncestor(sel.getRangeAt(0).startContainer);
    if (!block) return;

    if (block.tagName === "LI") {
      const cb = block.querySelector("input[type='checkbox']");
      if (cb) {
        cb.remove();
        block.classList.remove("task-list-item");
      } else {
        block.classList.add("task-list-item");
        if (block.parentElement) block.parentElement.classList.add("contains-task-list");
        const newCb = document.createElement("input");
        newCb.type = "checkbox";
        newCb.contentEditable = "false";
        block.insertBefore(newCb, block.firstChild);
        block.insertBefore(document.createTextNode(" "), newCb.nextSibling);
      }
    } else {
      const text = block.textContent;
      buildTaskList(block, text, false);
    }
    writerViewEl.focus();
    debouncedStats();
  } else {
    const ta = markdownInputEl;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
    let lineEnd = ta.value.indexOf("\n", e);
    if (lineEnd === -1) lineEnd = ta.value.length;

    const lines = ta.value.slice(lineStart, lineEnd).split("\n");
    const toggled = lines.map(line => {
      if (/^(\s*[-*+]\s+)\[[ xX]\]\s*/.test(line)) {
        return line.replace(/^(\s*[-*+]\s+)\[[ xX]\]\s*/, "$1");
      } else if (/^(\s*[-*+]\s+)/.test(line)) {
        return line.replace(/^(\s*[-*+]\s+)/, "$1[ ] ");
      } else if (/^\s*$/.test(line)) {
        return line;
      } else {
        const indent = line.match(/^\s*/)[0];
        return `${indent}- [ ] ${line.trimStart()}`;
      }
    });

    const newText = toggled.join("\n");
    ta.value = ta.value.slice(0, lineStart) + newText + ta.value.slice(lineEnd);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + newText.length;
    ta.focus();
    debouncedStats();
  }
}



function applyHorizontalRule() {
  if (!isMarkdownMode) {
    restoreSelection();
    document.execCommand("insertHorizontalRule");
    writerViewEl.focus();
  } else {
    const ta = markdownInputEl;
    const s = ta.selectionStart;
    const ins = "\n---\n\n";
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(s);
    ta.selectionStart = ta.selectionEnd = s + ins.length;
    ta.focus();
  }
}

// ─── Formatting — Markdown Mode ───────────────────────────────────────────────
function wrapMarkdownSelection(prefix, suffix = prefix) {
  const ta = markdownInputEl;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const before = ta.value.slice(0, s), sel = ta.value.slice(s, e), after = ta.value.slice(e);
  if (sel.startsWith(prefix) && sel.endsWith(suffix)) {
    const inner = sel.slice(prefix.length, sel.length - suffix.length);
    ta.value = before + inner + after;
    ta.selectionStart = s; ta.selectionEnd = s + inner.length;
  } else {
    ta.value = before + prefix + sel + suffix + after;
    ta.selectionStart = s + prefix.length; ta.selectionEnd = s + prefix.length + sel.length;
  }
  ta.focus(); debouncedStats();
}
function wrapMarkdownLines(prefix) {
  const ta = markdownInputEl;
  const s = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
  ta.value = ta.value.slice(0, lineStart) + prefix + ta.value.slice(lineStart);
  ta.selectionStart = ta.selectionEnd = s + prefix.length;
  ta.focus();
}
function setMarkdownHeading(level) {
  const ta = markdownInputEl;
  const pos = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd   = ta.value.indexOf("\n", pos);
  const end = lineEnd === -1 ? ta.value.length : lineEnd;
  const line = ta.value.slice(lineStart, end);
  const stripped = line.replace(/^#{1,6}\s*/, "");
  const prefix = "#".repeat(level) + " ";
  ta.value = ta.value.slice(0, lineStart) + prefix + stripped + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = lineStart + prefix.length + stripped.length;
  ta.focus();
}

// ─── Insert at Cursor ─────────────────────────────────────────────────────────
function formatTime(d) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatDate(d) {
  return d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}
function insertAtCursor(text) {
  if (!isMarkdownMode) {
    restoreSelection();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const tn = document.createTextNode(text);
      range.insertNode(tn);
      range.setStartAfter(tn); range.setEndAfter(tn);
      sel.removeAllRanges(); sel.addRange(range);
    }
    writerViewEl.focus();
  } else {
    const ta = markdownInputEl;
    const s = ta.selectionStart;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus(); debouncedStats();
  }
}

// ─── Table Context & Writer Manipulation Helpers ──────────────────────────────
function getTableContext() {
  restoreSelection();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  let cell = null;
  while (node && node !== writerViewEl) {
    if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === "TD" || node.tagName === "TH")) {
      cell = node;
      break;
    }
    node = node.parentNode;
  }
  if (!cell) return null;

  const tr = cell.closest("tr");
  const table = cell.closest("table");
  if (!tr || !table) return null;

  const rowCells = Array.from(tr.children);
  const colIndex = rowCells.indexOf(cell);
  const rows = Array.from(table.querySelectorAll("tr"));
  const rowIndex = rows.indexOf(tr);

  return {
    table,
    tr,
    cell,
    isHeader: cell.tagName === "TH" || tr.parentElement?.tagName === "THEAD",
    colIndex,
    rowIndex,
    rowCount: rows.length,
    colCount: rowCells.length
  };
}

function createTableHTML(rows = 3, cols = 3) {
  let html = "<table>\n  <thead>\n    <tr>\n";
  for (let j = 1; j <= cols; j++) {
    html += `      <th>Header ${j}</th>\n`;
  }
  html += "    </tr>\n  </thead>\n  <tbody>\n";
  for (let i = 1; i <= Math.max(1, rows - 1); i++) {
    html += "    <tr>\n";
    for (let j = 1; j <= cols; j++) {
      html += `      <td>Cell ${i}.${j}</td>\n`;
    }
    html += "    </tr>\n";
  }
  html += "  </tbody>\n</table>\n<p><br></p>";
  return html;
}

function createTableMarkdown(rows = 3, cols = 3) {
  const headers = [];
  const delims = [];
  for (let j = 1; j <= cols; j++) {
    headers.push(`Header ${j}`);
    delims.push("---");
  }
  const lines = [
    "| " + headers.join(" | ") + " |",
    "| " + delims.join(" | ") + " |"
  ];
  for (let i = 1; i <= Math.max(1, rows - 1); i++) {
    const row = [];
    for (let j = 1; j <= cols; j++) {
      row.push(`Cell ${i}.${j}`);
    }
    lines.push("| " + row.join(" | ") + " |");
  }
  return "\n" + lines.join("\n") + "\n\n";
}

function insertTable(rows = 3, cols = 3) {
  if (isMarkdownMode) {
    const md = createTableMarkdown(rows, cols);
    insertAtCursor(md);
  } else {
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      writerViewEl.insertAdjacentHTML("beforeend", createTableHTML(rows, cols));
    } else {
      const range = sel.getRangeAt(0);
      const temp = document.createElement("div");
      temp.innerHTML = createTableHTML(rows, cols);
      const frag = document.createDocumentFragment();
      let firstCell = null;
      while (temp.firstChild) {
        const child = temp.firstChild;
        if (!firstCell && child.nodeType === Node.ELEMENT_NODE) {
          firstCell = child.querySelector("th, td");
        }
        frag.appendChild(child);
      }
      range.deleteContents();
      range.insertNode(frag);

      if (firstCell) {
        placeCaret(firstCell, 0);
      }
    }
    writerViewEl.focus();
    debouncedStats();
  }
}

function tableAddColumnBefore() {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { table, colIndex } = ctx;
  const rows = table.querySelectorAll("tr");
  rows.forEach(r => {
    const cells = Array.from(r.children);
    const target = cells[colIndex] || cells[cells.length - 1];
    const isHeader = r.parentElement?.tagName === "THEAD" || target?.tagName === "TH";
    const newCell = document.createElement(isHeader ? "th" : "td");
    newCell.textContent = isHeader ? "Header" : "Cell";
    if (target) {
      r.insertBefore(newCell, target);
    } else {
      r.appendChild(newCell);
    }
  });
  statusMessageEl.textContent = "Added column to front";
  debouncedStats();
}

function tableAddColumnAfter() {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { table, colIndex } = ctx;
  const rows = table.querySelectorAll("tr");
  rows.forEach(r => {
    const cells = Array.from(r.children);
    const target = cells[colIndex];
    const isHeader = r.parentElement?.tagName === "THEAD" || (target && target.tagName === "TH");
    const newCell = document.createElement(isHeader ? "th" : "td");
    newCell.textContent = isHeader ? "Header" : "Cell";
    if (target && target.nextSibling) {
      r.insertBefore(newCell, target.nextSibling);
    } else {
      r.appendChild(newCell);
    }
  });
  statusMessageEl.textContent = "Added column after";
  debouncedStats();
}

function tableRemoveColumn() {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { table, colIndex, colCount } = ctx;
  if (colCount <= 1) {
    table.remove();
    statusMessageEl.textContent = "Removed table";
    debouncedStats();
    return;
  }
  const rows = table.querySelectorAll("tr");
  rows.forEach(r => {
    const cells = Array.from(r.children);
    if (cells[colIndex]) {
      r.removeChild(cells[colIndex]);
    }
  });
  statusMessageEl.textContent = "Removed column";
  debouncedStats();
}

function tableAddRowBefore() {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { tr, colCount } = ctx;
  const newTr = document.createElement("tr");
  for (let j = 0; j < colCount; j++) {
    const td = document.createElement("td");
    td.textContent = "Cell";
    newTr.appendChild(td);
  }
  tr.parentNode.insertBefore(newTr, tr);
  statusMessageEl.textContent = "Added row before";
  debouncedStats();
}

function tableAddRowAfter() {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { tr, colCount } = ctx;
  const newTr = document.createElement("tr");
  for (let j = 0; j < colCount; j++) {
    const td = document.createElement("td");
    td.textContent = "Cell";
    newTr.appendChild(td);
  }
  if (tr.nextSibling) {
    tr.parentNode.insertBefore(newTr, tr.nextSibling);
  } else {
    tr.parentNode.appendChild(newTr);
  }
  statusMessageEl.textContent = "Added row after";
  debouncedStats();
}

function tableRemoveRow() {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { table, tr, rowCount } = ctx;
  if (rowCount <= 1) {
    table.remove();
    statusMessageEl.textContent = "Removed table";
    debouncedStats();
    return;
  }
  tr.remove();
  statusMessageEl.textContent = "Removed row";
  debouncedStats();
}

function tableSetColumnAlignment(align) {
  if (isMarkdownMode) return;
  const ctx = getTableContext();
  if (!ctx) {
    statusMessageEl.textContent = "Place cursor inside a table cell first";
    return;
  }
  const { table, colIndex } = ctx;
  const rows = table.querySelectorAll("tr");
  rows.forEach(r => {
    const cells = Array.from(r.children);
    if (cells[colIndex]) {
      cells[colIndex].setAttribute("align", align);
      cells[colIndex].style.textAlign = align;
    }
  });
  statusMessageEl.textContent = `Column aligned ${align}`;
  debouncedStats();
}

function initTableGridPicker() {
  const picker = document.getElementById("table-grid-picker");
  if (!picker) return;
  picker.innerHTML = "";
  const maxRows = 6;
  const maxCols = 6;

  for (let r = 1; r <= maxRows; r++) {
    for (let c = 1; c <= maxCols; c++) {
      const sq = document.createElement("div");
      sq.className = "grid-square";
      sq.dataset.row = r;
      sq.dataset.col = c;

      sq.addEventListener("mouseenter", () => {
        highlightTableGrid(r, c);
      });

      sq.addEventListener("click", (e) => {
        e.stopPropagation();
        insertTable(r, c);
        closeTableMenu();
      });

      picker.appendChild(sq);
    }
  }

  picker.addEventListener("mouseleave", () => {
    highlightTableGrid(3, 3);
  });
  highlightTableGrid(3, 3);
}

function highlightTableGrid(rows, cols) {
  const squares = document.querySelectorAll("#table-grid-picker .grid-square");
  squares.forEach(sq => {
    const r = parseInt(sq.dataset.row, 10);
    const c = parseInt(sq.dataset.col, 10);
    if (r <= rows && c <= cols) {
      sq.classList.add("active");
    } else {
      sq.classList.remove("active");
    }
  });
  const label = document.getElementById("table-grid-label");
  if (label) label.textContent = `${rows} × ${cols} Table`;
}

function toggleTableMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById("table-menu");
  if (!menu) return;
  menu.classList.toggle("hidden");
  if (!menu.classList.contains("hidden")) {
    initTableGridPicker();
    const btn = document.getElementById("table-btn");
    if (btn) {
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + 4) + "px";
      menu.style.left = Math.min(rect.left, window.innerWidth - 260) + "px";
    }
  }
}

function closeTableMenu() {
  const menu = document.getElementById("table-menu");
  if (menu) menu.classList.add("hidden");
}

function toggleAdmonitionMenu(e) {
  if (e) e.stopPropagation();
  saveSelection();
  const menu = document.getElementById("admonition-menu");
  if (!menu) return;
  const isHidden = menu.classList.contains("hidden");
  document.getElementById("main-menu")?.classList.add("hidden");
  document.getElementById("table-menu")?.classList.add("hidden");

  if (isHidden) {
    const btn = document.getElementById("admonition-btn");
    if (btn) {
      const rect = btn.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
    }
    menu.classList.remove("hidden");
  } else {
    menu.classList.add("hidden");
  }
}

function closeAdmonitionMenu() {
  const menu = document.getElementById("admonition-menu");
  if (menu) menu.classList.add("hidden");
}

// ─── Live Markdown Syntax ─────────────────────────────────────────────────────
function tryApplyHeading() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const block = getBlockAncestor(sel.getRangeAt(0).startContainer);
  if (!block || /^H[1-6]$/.test(block.tagName)) return;
  const text = block.textContent;
  const m = text.match(/^(#{1,6}) /);
  if (!m) return;
  const level = m[1].length;
  const content = text.slice(m[0].length);
  document.execCommand("formatBlock", false, `h${level}`);
  const newSel = window.getSelection();
  if (!newSel || !newSel.rangeCount) return;
  const newBlock = getBlockAncestor(newSel.getRangeAt(0).startContainer);
  if (!newBlock) return;
  if (newBlock.textContent.startsWith(m[0])) {
    const first = newBlock.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) {
      first.textContent = first.textContent.slice(m[0].length);
    } else {
      newBlock.textContent = content;
    }
    const r = document.createRange();
    const tn = newBlock.firstChild || newBlock;
    r.setStart(tn, 0); r.collapse(true);
    newSel.removeAllRanges(); newSel.addRange(r);
  }
}

function tryInlinePattern(textNode, cursorOffset, regex, createElement) {
  const text = textNode.textContent;
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const matchEnd = match.index + match[0].length;
    if (matchEnd > cursorOffset) continue;
    const before = text.slice(0, match.index);
    const after  = text.slice(matchEnd);
    const parent = textNode.parentNode;
    if (!parent) return false;
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const el = createElement(match[1]);
    el.classList.add("just-formatted");
    frag.appendChild(el);
    const afterNode = document.createTextNode(after);
    frag.appendChild(afterNode);
    parent.replaceChild(frag, textNode);
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(afterNode, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return true;
  }
  return false;
}

function tryApplyInlineFormats(range) {
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const offset = range.startOffset;
  if (tryInlinePattern(node, offset, /\*\*([^*\n]+)\*\*/g, c => {
    const el = document.createElement("strong"); el.textContent = c; return el;
  })) return;
  if (tryInlinePattern(node, offset, /(?<!\*)\*([^*\n]+)\*(?!\*)/g, c => {
    const el = document.createElement("em"); el.textContent = c; return el;
  })) return;
  if (tryInlinePattern(node, offset, /`([^`\n]+)`/g, c => {
    const el = document.createElement("code"); el.textContent = c; return el;
  })) return;
  if (tryInlinePattern(node, offset, /~~([^~\n]+)~~/g, c => {
    const el = document.createElement("del"); el.textContent = c; return el;
  })) return;
  if (tryInlinePattern(node, offset, /(?<!~)~([^~\n]+)~(?!~)/g, c => {
    const el = document.createElement("sub"); el.textContent = c; return el;
  })) return;
  if (tryInlinePattern(node, offset, /(?<!\^)\^([^\^\n]+)\^(?!\^)/g, c => {
    const el = document.createElement("sup"); el.textContent = c; return el;
  })) return;
  if (tryInlinePattern(node, offset, /==([^=\n]+)==/g, c => {
    const el = document.createElement("mark"); el.textContent = c; return el;
  })) return;
}

async function tryApplyImageSyntax(range) {
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent;
  const offset = range.startOffset;
  const imgRx = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = imgRx.exec(text)) !== null) {
    if (match.index + match[0].length > offset) continue;
    const alt = match[1], src = match[2];
    const before = text.slice(0, match.index);
    const after  = text.slice(match.index + match[0].length);
    const parent = node.parentNode;
    if (!parent) return;
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const img = document.createElement("img");
    img.setAttribute("alt", alt); img.dataset.originalSrc = src;
    img.className = "writer-image"; img.setAttribute("src", "");
    frag.appendChild(img);
    const afterNode = document.createTextNode(after);
    frag.appendChild(afterNode);
    parent.replaceChild(frag, node);
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(afterNode, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    loadLocalImage(img, src);
    return;
  }
}

function handleLiveMarkdown(e) {
  if (isMarkdownMode) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (e.inputType === "insertText" && e.data === " ") {
    tryApplyHeading();
    return;
  }
  const trigger = e.data;
  if (trigger === "*" || trigger === "`" || trigger === "~" || trigger === "=" || trigger === "^") {
    tryApplyInlineFormats(range);
  }
  if (trigger === ")") {
    tryApplyInlineFormats(range);
    tryApplyImageSyntax(range);
  }
}

// ─── Code Block helpers (Writer Mode) ────────────────────────────────────────

/**
 * Return the <pre> ancestor of `node` if we are inside a code block,
 * otherwise null.
 */
function getPreAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== writerViewEl) {
    if (el.tagName === "PRE") return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Insert a <pre><code> block in place of (or immediately after) the trigger paragraph.
 * `lang` is an optional language string (may be empty).
 * `textBefore` is optional preceding text from the same paragraph that should be preserved.
 */
function buildCodeBlock(replaceTarget, lang, textBefore = "") {
  const pre  = document.createElement("pre");
  const code = document.createElement("code");
  if (lang) code.className = `language-${lang}`;
  const placeholder = document.createTextNode("");
  code.appendChild(placeholder);
  pre.appendChild(code);

  if (textBefore) {
    replaceTarget.textContent = textBefore;
    if (replaceTarget.nextSibling) {
      replaceTarget.parentNode.insertBefore(pre, replaceTarget.nextSibling);
    } else {
      replaceTarget.parentNode.appendChild(pre);
    }
  } else {
    replaceTarget.parentNode.replaceChild(pre, replaceTarget);
  }

  writerViewEl.focus();
  const r = document.createRange();
  r.setStart(placeholder, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  _savedRange = r.cloneRange();
}

/**
 * Get the text content of the current visual line up to the caret position.
 */
function getLineTextBeforeCaret(range, block) {
  const container = range.startContainer;
  const offset    = range.startOffset;
  if (container.nodeType === Node.TEXT_NODE) {
    const textNodeBefore = container.textContent.slice(0, offset);
    const lastNL = textNodeBefore.lastIndexOf("\n");
    if (lastNL !== -1) {
      return textNodeBefore.slice(lastNL + 1);
    }
    let lineText = textNodeBefore;
    let sib = container.previousSibling;
    while (sib) {
      if (sib.nodeName === "BR") break;
      if (sib.nodeType === Node.TEXT_NODE) {
        const t = sib.textContent;
        const nl = t.lastIndexOf("\n");
        if (nl !== -1) {
          lineText = t.slice(nl + 1) + lineText;
          break;
        }
        lineText = t + lineText;
      } else if (sib.nodeType === Node.ELEMENT_NODE) {
        if (sib.tagName === "BR") break;
        lineText = sib.textContent + lineText;
      }
      sib = sib.previousSibling;
    }
    return lineText;
  } else if (container.nodeType === Node.ELEMENT_NODE) {
    const childBefore = container.childNodes[offset - 1];
    if (childBefore && childBefore.nodeType === Node.TEXT_NODE) {
      const t = childBefore.textContent;
      const nl = t.lastIndexOf("\n");
      return nl !== -1 ? t.slice(nl + 1) : t;
    }
  }
  return block.textContent;
}

/**
 * Close the current code block and move caret to a new <p> that follows it.
 * The caller must have already stripped the closing ``` from the DOM.
 */
function closeCodeBlock(pre) {
  hideCodeControls();
  applySyntaxHighlighting(pre);

  // <p><br></p> is the browser-standard structure for an empty editable paragraph.
  // An empty text node alone is not reliably focusable in WebKit.
  const p  = document.createElement("p");
  const br = document.createElement("br");
  p.appendChild(br);

  if (pre.nextSibling) {
    pre.parentNode.insertBefore(p, pre.nextSibling);
  } else {
    pre.parentNode.appendChild(p);
  }

  // Focus the editor BEFORE setting the selection — calling focus() after
  // would reset the caret back to wherever the browser defaults.
  writerViewEl.focus();

  const r = document.createRange();
  r.setStart(p, 0); // place caret at the start of <p>, before the <br>
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  _savedRange = r.cloneRange();
}

// ─── Floating Code Block Controls (Language Select + Done Button) ─────────────
const SUPPORTED_LANGUAGES = [
  { label: "Plain Text", value: "" },
  { label: "Bash / Shell", value: "bash" },
  { label: "C", value: "c" },
  { label: "C++", value: "cpp" },
  { label: "CMake", value: "cmake" },
  { label: "CSS", value: "css" },
  { label: "Go", value: "go" },
  { label: "HTML", value: "html" },
  { label: "Java", value: "java" },
  { label: "JavaScript", value: "js" },
  { label: "Make", value: "make" },
  { label: "Markdown", value: "markdown" },
  { label: "Python", value: "python" },
  { label: "SQL", value: "sql" },
  { label: "TeX / LaTeX", value: "tex" },
  { label: "XML", value: "xml" },
  { label: "YAML", value: "yaml" }
];

let _codeControlsBar = null;
let _codeLangSelect  = null;
let _codeCloseBtn    = null;
let _activePre       = null;

function ensureCodeControls() {
  if (_codeControlsBar) return _codeControlsBar;

  const bar = document.createElement("div");
  bar.id = "code-controls-bar";
  bar.classList.add("hidden");

  // Language Dropdown <select>
  const select = document.createElement("select");
  select.id = "code-lang-select";
  select.title = "Select Programming Language";

  SUPPORTED_LANGUAGES.forEach(lang => {
    const opt = document.createElement("option");
    opt.value = lang.value;
    opt.textContent = lang.label;
    select.appendChild(opt);
  });

  // Keep caret/selection active when clicking dropdown
  select.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });

  select.addEventListener("change", () => {
    if (!_activePre) return;
    const code = _activePre.querySelector("code") || _activePre;
    const selectedLang = select.value;
    if (selectedLang) {
      code.className = `language-${selectedLang}`;
    } else {
      code.className = "";
    }
    // Re-apply syntax highlighting with new language selection
    applySyntaxHighlighting(_activePre);
  });

  // Floating Done button
  const btn = document.createElement("button");
  btn.id = "code-close-btn";
  btn.title = "Close code block (or type ``` + Enter)";
  btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg> Done`;

  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (_activePre) closeCodeBlock(_activePre);
  });

  bar.appendChild(select);
  bar.appendChild(btn);
  document.body.appendChild(bar);

  _codeControlsBar = bar;
  _codeLangSelect  = select;
  _codeCloseBtn    = btn;
  return bar;
}

function showCodeControls(pre) {
  _activePre = pre;
  ensureCodeControls();

  // Sync language select value with current pre's class
  const code = pre.querySelector("code") || pre;
  const currentClass = code.className || "";
  const rawLang = currentClass.replace(/language-/, "").trim();
  const normalized = typeof normalizeLanguage === "function" ? normalizeLanguage(rawLang) : rawLang;
  _codeLangSelect.value = normalized || "";

  // Position floating bar ABOVE the pre block so it never obstructs code lines
  const rect = pre.getBoundingClientRect();
  const topAppHeaderHeight = 110;
  let topPos = rect.top - 32;

  // If pre is near the top edge of the editor viewport, place it inside top-right
  if (topPos < topAppHeaderHeight) {
    topPos = rect.top + 6;
  }

  _codeControlsBar.style.top   = topPos + "px";
  _codeControlsBar.style.right = Math.max(16, window.innerWidth - rect.right + 12) + "px";
  _codeControlsBar.classList.remove("hidden");
}

function hideCodeControls() {
  _activePre = null;
  if (_codeControlsBar) _codeControlsBar.classList.add("hidden");
}

/** Called from selectionchange — checks actual caret position via getSelection(). */
function updateCodeControls() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { hideCodeControls(); return; }
  const pre = getPreAncestor(sel.getRangeAt(0).startContainer);
  if (pre) showCodeControls(pre);
  else hideCodeControls();
}

/**
 * Detect whether the current visual line (before the cursor) inside a <pre>
 * is exactly ```. Handles both \n-based and <br>-based line breaks.
 * If the closing fence is detected, removes it from the DOM and returns true.
 */
function tryCloseCodeFence(range) {
  const container = range.startContainer;
  const offset    = range.startOffset;

  let targetNode = null;
  if (container.nodeType === Node.TEXT_NODE) {
    targetNode = container;
  } else if (container.nodeType === Node.ELEMENT_NODE) {
    targetNode = container.childNodes[offset - 1] || container.lastChild;
  }

  if (!targetNode) return false;

  const fullText = targetNode.textContent || "";
  const lastNL   = fullText.lastIndexOf("\n");
  const lineText = lastNL !== -1 ? fullText.slice(lastNL + 1) : fullText;

  if (lineText.trim() !== "```") return false;

  // Cleanup: remove ONLY the closing ``` fence
  if (targetNode.nodeType === Node.TEXT_NODE) {
    if (lastNL !== -1) {
      targetNode.textContent = fullText.slice(0, lastNL);
    } else {
      const parent  = targetNode.parentNode;
      const prevSib = targetNode.previousSibling;
      parent.removeChild(targetNode);
      if (prevSib && prevSib.nodeName === "BR") {
        parent.removeChild(prevSib);
      }
      if (parent && parent !== writerViewEl && parent.tagName !== "PRE" && parent.tagName !== "CODE" && parent.childNodes.length === 0) {
        parent.parentNode?.removeChild(parent);
      }
    }
  } else if (targetNode.nodeType === Node.ELEMENT_NODE) {
    targetNode.parentNode?.removeChild(targetNode);
  }

  return true;
}

// ─── Enter Key in Writer Mode ─────────────────────────────────────────────────
function handleWriterEnter(e) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);

  // ── Close code block when ``` is typed on its own line inside a <pre> ──
  const pre = getPreAncestor(range.startContainer);
  if (pre) {
    if (tryCloseCodeFence(range)) {
      e.preventDefault();
      closeCodeBlock(pre);
      return true;
    }
    // Still inside the code block — let the browser insert a newline normally.
    return false;
  }

  // ── Escape Admonition block on Enter when on empty paragraph ──
  const adm = getAdmonitionAncestor(range.startContainer);
  if (adm) {
    const p = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : range.startContainer;
    const text = p ? p.textContent.replace(/\u200B/g, "").trim() : "";

    if (p && p.tagName === "P" && text === "") {
      e.preventDefault();
      const contentDiv = adm.querySelector(".admonition-content");
      if (contentDiv && contentDiv.children.length > 1) {
        p.remove();
      }
      let nextP = adm.nextElementSibling;
      if (!nextP) {
        nextP = document.createElement("p");
        nextP.appendChild(document.createElement("br"));
        if (adm.nextSibling) {
          adm.parentNode.insertBefore(nextP, adm.nextSibling);
        } else {
          adm.parentNode.appendChild(nextP);
        }
      }
      placeCaret(nextP, 0);
      writerViewEl.focus();
      debouncedStats();
      return true;
    }
  }

  const block = getBlockAncestor(range.startContainer);
  if (!block) return false;

  if (/^H[1-6]$/.test(block.tagName)) return false;
  if (block.tagName === "BLOCKQUOTE") return false;

  // ── Task list item Enter trigger ──
  if (block.tagName === "LI" && (block.classList.contains("task-list-item") || block.querySelector("input[type='checkbox']"))) {
    const itemText = Array.from(block.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName !== "INPUT"))
      .map(n => n.textContent.replace(/\u200B/g, ""))
      .join("").trim();
    if (itemText === "") {
      e.preventDefault();
      const parentList = block.parentElement;
      block.remove();
      if (parentList && parentList.children.length === 0) {
        parentList.remove();
      }
      const p = document.createElement("p");
      p.appendChild(document.createElement("br"));
      writerViewEl.appendChild(p);
      placeCaret(p, 0);
      writerViewEl.focus();
      debouncedStats();
      return true;
    } else {
      e.preventDefault();
      const newLi = document.createElement("li");
      newLi.className = "task-list-item";
      const newCb = document.createElement("input");
      newCb.type = "checkbox";
      newCb.contentEditable = "false";
      const span = document.createElement("span");
      span.className = "task-text";
      const tn = document.createTextNode("\u200B ");
      span.appendChild(tn);
      newLi.appendChild(newCb);
      newLi.appendChild(span);
      if (block.nextSibling) {
        block.parentNode.insertBefore(newLi, block.nextSibling);
      } else {
        block.parentNode.appendChild(newLi);
      }
      placeCaret(tn, 1);
      writerViewEl.focus();
      debouncedStats();
      return true;
    }
  }

  const text = block.textContent;
  const lineText = getLineTextBeforeCaret(range, block);

  // ── Code block trigger: ``` or ```lang ──
  const cbm = lineText.trim().match(/^```([\w+-]*)$/);
  if (cbm) {
    e.preventDefault();
    const lang = cbm[1];
    const triggerIdx = text.lastIndexOf("```");
    const textBefore = triggerIdx > 0 ? text.slice(0, triggerIdx).trimEnd() : "";
    buildCodeBlock(block, lang, textBefore);
    return true;
  }

  // ── HR trigger: --- ──
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(text.trim())) {
    e.preventDefault();
    block.textContent = "";
    document.execCommand("insertHorizontalRule");
    return true;
  }

  // ── Heading trigger: "#{1,6} <content>" ──
  const hm = text.match(/^(#{1,6}) (.+)$/);
  if (hm) {
    e.preventDefault();
    const level = hm[1].length;
    const content = hm[2];
    document.execCommand("formatBlock", false, `h${level}`);
    const updSel = window.getSelection();
    if (updSel && updSel.rangeCount > 0) {
      const hBlock = getBlockAncestor(updSel.getRangeAt(0).startContainer);
      if (hBlock) {
        hBlock.textContent = content;
        const r = document.createRange();
        r.selectNodeContents(hBlock); r.collapse(false);
        updSel.removeAllRanges(); updSel.addRange(r);
      }
    }
    document.execCommand("insertParagraph");
    document.execCommand("formatBlock", false, "p");
    return true;
  }
  return false;
}

// ─── File Operations ──────────────────────────────────────────────────────────

function renderTabBar() {
  const tabBar = document.getElementById("tab-bar");
  if (!tabBar) return;
  tabBar.innerHTML = "";
  for (const f of openFiles) {
    const tab = document.createElement("div");
    tab.className = "tab" + (f.id === activeFileId ? " active" : "");
    tab.onclick = () => switchTab(f.id);
    
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = f.name;
    tab.appendChild(title);
    
    if (f.dirty) {
      const dirtyInd = document.createElement("div");
      dirtyInd.className = "tab-dirty-indicator";
      dirtyInd.textContent = "●";
      tab.appendChild(dirtyInd);
    }
    
    const closeBtn = document.createElement("div");
    closeBtn.className = "tab-close";
    closeBtn.innerHTML = "×";
    closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(f.id); };
    tab.appendChild(closeBtn);
    
    tabBar.appendChild(tab);
  }
}

function syncActiveFileContent() {
  const f = getActiveFile();
  if (f) f.content = getCurrentMarkdown();
}

function renderImageViewer(fileObj) {
  if (!fileObj || !fileObj.isImage) return;
  writerViewEl.classList.add("hidden");
  markdownInputEl.classList.add("hidden");

  let viewer = document.getElementById("image-viewer-container");
  if (!viewer) {
    viewer = document.createElement("div");
    viewer.id = "image-viewer-container";
    viewer.className = "image-viewer-container";
    document.getElementById("editor-area").appendChild(viewer);
  }
  viewer.classList.remove("hidden");
  viewer.replaceChildren();

  const wrapper = document.createElement("div");
  wrapper.className = "image-viewer-wrapper";

  const img = document.createElement("img");
  img.className = "image-viewer-img";
  img.src = fileObj.dataUrl;
  img.alt = fileObj.name;

  const meta = document.createElement("div");
  meta.className = "image-viewer-meta";
  meta.textContent = `🖼 ${fileObj.name} — Image Viewer`;

  wrapper.appendChild(img);
  wrapper.appendChild(meta);
  viewer.appendChild(wrapper);
}

async function switchTab(id) {
  if (activeFileId === id) return;
  syncActiveFileContent();
  activeFileId = id;
  const f = getActiveFile();
  const imgViewer = document.getElementById("image-viewer-container");

  if (f) {
    if (f.isImage) {
      renderImageViewer(f);
      statusMessageEl.textContent = `Viewing Image: ${f.name}`;
    } else {
      if (imgViewer) imgViewer.classList.add("hidden");
      if (isMarkdownMode) {
        writerViewEl.classList.add("hidden");
        markdownInputEl.classList.remove("hidden");
        markdownInputEl.value = f.content || "";
        updateStats(f.content || "");
      } else {
        markdownInputEl.classList.add("hidden");
        writerViewEl.classList.remove("hidden");
        await renderMarkdownToWriter(f.content || "");
        updateStats(f.content || "");
      }
    }
    const btn = document.getElementById("save-file-btn");
    if (btn) {
      if (f.dirty) {
        btn.classList.add("dirty"); btn.title = "Unsaved changes – Save (Ctrl+S)";
      } else {
        btn.classList.remove("dirty"); btn.title = "Save File (Ctrl+S)";
      }
    }
  }
  renderTabBar();
  renderFileList();
  if (typeof performFind === "function") performFind();
}

function promptUnsavedChanges(file) {
  return new Promise((resolve) => {
    const modal = document.getElementById("unsaved-modal");
    const msg = document.getElementById("unsaved-modal-msg");
    const saveBtn = document.getElementById("unsaved-save-btn");
    const discardBtn = document.getElementById("unsaved-discard-btn");
    const cancelBtn = document.getElementById("unsaved-cancel-btn");

    msg.textContent = `Do you want to save the changes to "${file.name}"?`;

    function cleanup() {
      saveBtn.removeEventListener("click", onSave);
      discardBtn.removeEventListener("click", onDiscard);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("cancel", onModalCancel);
      closeModal("unsaved-modal");
    }

    function onSave() {
      cleanup();
      resolve("save");
    }

    function onDiscard() {
      cleanup();
      resolve("discard");
    }

    function onCancel() {
      cleanup();
      resolve("cancel");
    }

    function onModalCancel(e) {
      e.preventDefault();
      cleanup();
      resolve("cancel");
    }

    saveBtn.addEventListener("click", onSave);
    discardBtn.addEventListener("click", onDiscard);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("cancel", onModalCancel);

    openModal("unsaved-modal");
    saveBtn.focus();
  });
}

function promptConfirm(title, message, confirmText = "Confirm", isDanger = true) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-modal-title");
    const msgEl = document.getElementById("confirm-modal-msg");
    const okBtn = document.getElementById("confirm-modal-ok-btn");
    const cancelBtn = document.getElementById("confirm-modal-cancel-btn");

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmText;
    okBtn.className = isDanger ? "btn danger-btn" : "btn primary-btn";

    function cleanup() {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("cancel", onModalCancel);
      closeModal("confirm-modal");
    }

    function onOk() {
      cleanup();
      resolve(true);
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onModalCancel(e) {
      e.preventDefault();
      cleanup();
      resolve(false);
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("cancel", onModalCancel);

    openModal("confirm-modal");
    okBtn.focus();
  });
}

async function saveSingleFile(f) {
  if (!f) return false;
  if (f.id === activeFileId) {
    syncActiveFileContent();
  }
  try {
    if (f.isNextcloud && f.remotePath) {
      statusMessageEl.textContent = `Saving ${f.remoteName || "file"} to Nextcloud…`;
      await invoke("write_nextcloud_file", { path: f.remotePath, content: f.content });
      f.dirty = false;
      recordNcRecentFile(f.remotePath, f.remoteName || f.name.replace(/^☁\s*/, ""));
      renderTabBar(); renderFileList();
      if (typeof renderNextcloudFileList === "function") renderNextcloudFileList();
      statusMessageEl.textContent = `Saved to Nextcloud: ${f.remoteName || f.name}`;
      return true;
    } else if (f.path) {
      await invoke("save_file", { path: f.path, content: f.content });
      f.dirty = false;
      renderTabBar(); renderFileList();
      return true;
    } else {
      const savedPath = await invoke("save_file_dialog", { content: f.content });
      if (savedPath) {
        const oldId = f.id;
        f.path = savedPath;
        f.id = savedPath;
        if (activeFileId === oldId) {
          activeFileId = savedPath;
        }
        f.name = savedPath.split(/[/\\]/).pop();
        addToRecentFiles(savedPath, f.name);
        f.dirty = false;
        renderTabBar(); renderFileList();
        return true;
      }
      return false;
    }
  } catch (e) {
    console.error("Error saving file:", e);
    return false;
  }
}

async function closeTab(id) {
  const f = openFiles.find(x => x.id === id);
  if (!f) return;

  if (f.id === activeFileId) {
    syncActiveFileContent();
  }

  if (f.dirty) {
    const action = await promptUnsavedChanges(f);
    if (action === "cancel") {
      return;
    } else if (action === "save") {
      const saved = await saveSingleFile(f);
      if (!saved) return;
    }
  }

  const idx = openFiles.findIndex(x => x.id === id);
  if (idx !== -1) {
    openFiles.splice(idx, 1);
    if (openFiles.length === 0) {
      activeFileId = null;
      markdownInputEl.value = "";
      writerViewEl.innerHTML = "";
      document.title = "ArtfulType Pro";
      statusMessageEl.textContent = "Ready";
      updateStats("");
      markdownInputEl.disabled = true;
      writerViewEl.contentEditable = "false";
      renderTabBar();
      renderFileList();
    } else if (activeFileId === id) {
      const nextId = openFiles[Math.min(idx, openFiles.length - 1)].id;
      await switchTab(nextId);
    } else {
      renderTabBar();
      renderFileList();
    }
  }
}

function getCurrentMarkdown() {
  if (!isMarkdownMode && writerViewEl) {
    const marks = Array.from(writerViewEl.querySelectorAll("mark.find-match"));
    for (const m of marks) {
      const parent = m.parentNode;
      if (parent) {
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
      }
    }
  }
  return isMarkdownMode ? markdownInputEl.value : htmlToMarkdown(writerViewEl);
}

async function applyOpenedFile(fileData) {
  if (!fileData || !fileData.path) return;
  const name = fileData.name || fileData.path.split(/[/\\]/).pop();

  if (!isTextFile(name) && !isImageFile(name)) {
    statusMessageEl.textContent = `Cannot open "${name}": Not a text file.`;
    alert(`Cannot open "${name}": ArtfulType Pro only opens text files.`);
    return;
  }

  const existing = openFiles.find(f => f.path === fileData.path);
  if (existing) {
    await switchTab(existing.id);
    return;
  }

  syncActiveFileContent();

  if (isImageFile(name)) {
    try {
      const dataUrl = await invoke("read_image_base64", { path: fileData.path });
      const imgFile = {
        id: fileData.path,
        path: fileData.path,
        name: name,
        isImage: true,
        dataUrl: dataUrl,
        content: "",
        dirty: false
      };
      openFiles.push(imgFile);
      activeFileId = imgFile.id;
      addToRecentFiles(fileData.path, name);
      renderTabBar();
      renderFileList();
      await switchTab(imgFile.id);
      return;
    } catch (e) {
      console.error(e);
      statusMessageEl.textContent = `Error reading image: ${name}`;
      return;
    }
  }

  const newFile = {
    id: fileData.path,
    path: fileData.path,
    name: name,
    content: fileData.content,
    dirty: false
  };
  openFiles.push(newFile);
  activeFileId = newFile.id;

  markdownInputEl.value = fileData.content;
  markdownInputEl.disabled = false;
  writerViewEl.contentEditable = "true";
  addToRecentFiles(fileData.path, name);
  if (isMarkdownMode) {
    updateStats(fileData.content);
  } else {
    await renderMarkdownToWriter(fileData.content);
    updateStats(fileData.content);
  }
  setDirty(false);
  renderTabBar();
  renderFileList();
}

async function openFile() {
  try {
    statusMessageEl.textContent = "Opening…";
    const fileData = await invoke("open_file_dialog");
    if (fileData) {
      await applyOpenedFile(fileData);
      statusMessageEl.textContent = `Opened: ${fileData.name}`;
    } else {
      statusMessageEl.textContent = "Ready";
    }
  } catch (e) {
    console.error(e);
    statusMessageEl.textContent = "Error opening file";
  }
}

async function saveNextcloudAs(f, content, silent = false) {
  if (!ncConfig) {
    openModal("prefs-modal");
    return false;
  }
  const defaultName = f.remoteName || f.name.replace(/^☁\s*/, "") || "untitled.md";
  const filename = prompt("Enter filename to save on Nextcloud:", defaultName);
  if (!filename || !filename.trim()) {
    if (!silent) statusMessageEl.textContent = "Save cancelled.";
    return false;
  }
  let cleanName = filename.trim();
  if (!cleanName.endsWith(".md") && !cleanName.endsWith(".txt") && !cleanName.endsWith(".markdown")) {
    cleanName += ".md";
  }
  const remotePath = ncCurrentPath ? `${ncCurrentPath}/${cleanName}` : cleanName;

  try {
    const existingContent = await invoke("read_nextcloud_file", { path: remotePath });
    if (existingContent !== null && existingContent !== undefined) {
      const confirmOverwrite = await promptConfirm(
        "Confirm Overwrite",
        `File "${cleanName}" already exists on Nextcloud. Do you want to overwrite it?`,
        "Overwrite",
        true
      );
      if (!confirmOverwrite) {
        if (!silent) statusMessageEl.textContent = "Save cancelled.";
        return false;
      }
    }
  } catch (_) {
    // File doesn't exist yet on Nextcloud
  }

  try {
    if (!silent) statusMessageEl.textContent = `Saving ${cleanName} to Nextcloud…`;
    await invoke("write_nextcloud_file", { path: remotePath, content });
    const oldId = f.id;
    f.isNextcloud = true;
    f.remotePath = remotePath;
    f.remoteName = cleanName;
    f.name = `☁ ${cleanName}`;
    f.path = null;
    f.id = "nc:" + remotePath;
    if (activeFileId === oldId) {
      activeFileId = f.id;
    }
    f.dirty = false;
    recordNcRecentFile(remotePath, cleanName);
    renderTabBar();
    renderFileList();
    if (typeof renderNextcloudFileList === "function") renderNextcloudFileList();
    if (!silent) statusMessageEl.textContent = `Saved to Nextcloud: ${cleanName}`;
    return true;
  } catch (err) {
    console.error(err);
    if (!silent) statusMessageEl.textContent = `Nextcloud save error: ${err}`;
    return false;
  }
}

async function saveFile(silent = false) {
  syncActiveFileContent();
  let f = getActiveFile();
  if (!f) {
    const currentContent = getCurrentMarkdown();
    const name = "untitled-" + untitledCounter++ + ".md";
    f = { id: "new-" + Date.now(), path: null, name, content: currentContent, dirty: true };
    openFiles.push(f);
    activeFileId = f.id;
    renderTabBar(); renderFileList();
  }
  const content = f.content;
  try {
    const isNcTabActive = document.getElementById("nextcloud-sidebar-container") && !document.getElementById("nextcloud-sidebar-container").classList.contains("hidden");
    if (f.isNextcloud && f.remotePath) {
      if (!silent) statusMessageEl.textContent = `Saving ${f.remoteName || "file"} to Nextcloud…`;
      await invoke("write_nextcloud_file", { path: f.remotePath, content });
      f.dirty = false;
      renderTabBar(); renderFileList();
      if (typeof renderNextcloudFileList === "function") renderNextcloudFileList();
      if (!silent) statusMessageEl.textContent = `Saved to Nextcloud: ${f.remoteName || f.name}`;
    } else if (f.path) {
      await invoke("save_file", { path: f.path, content });
      f.dirty = false;
      renderTabBar(); renderFileList();
      if (!silent) statusMessageEl.textContent = "Saved.";
    } else if (ncConfig && isNcTabActive) {
      await saveNextcloudAs(f, content, silent);
    } else {
      if (!silent) statusMessageEl.textContent = "Saving…";
      const savedPath = await invoke("save_file_dialog", { content });
      if (savedPath) {
        f.path = savedPath;
        f.id = savedPath;
        activeFileId = savedPath;
        f.name = savedPath.split(/[/\\]/).pop();
        addToRecentFiles(savedPath, f.name);
        f.dirty = false;
        renderTabBar(); renderFileList();
        if (!silent) statusMessageEl.textContent = `Saved: ${f.name}`;
      } else {
        if (!silent) statusMessageEl.textContent = "Save cancelled.";
      }
    }
    const active = getActiveFile();
    if (active && !active.dirty) {
      const btn = document.getElementById("save-file-btn");
      if (btn) { btn.classList.remove("dirty"); btn.title = "Save File (Ctrl+S)"; }
    }
  } catch (e) {
    console.error(e);
    if (!silent) statusMessageEl.textContent = "Error saving file";
  }
}

async function saveFileAs(silent = false) {
  syncActiveFileContent();
  let f = getActiveFile();
  if (!f) {
    const currentContent = getCurrentMarkdown();
    const name = "untitled-" + untitledCounter++ + ".md";
    f = { id: "new-" + Date.now(), path: null, name, content: currentContent, dirty: true };
    openFiles.push(f);
    activeFileId = f.id;
    renderTabBar(); renderFileList();
  }
  const content = f.content;
  try {
    const isNcTabActive = document.getElementById("nextcloud-sidebar-container") && !document.getElementById("nextcloud-sidebar-container").classList.contains("hidden");
    if (ncConfig && (f.isNextcloud || isNcTabActive)) {
      await saveNextcloudAs(f, content, silent);
      return;
    }
    if (!silent) statusMessageEl.textContent = "Saving As…";
    const savedPath = await invoke("save_file_dialog", { content });
    if (savedPath) {
      f.path = savedPath;
      f.id = savedPath;
      activeFileId = savedPath;
      f.name = savedPath.split(/[/\\]/).pop();
      addToRecentFiles(savedPath, f.name);
      f.dirty = false;
      renderTabBar(); renderFileList();
      if (!silent) statusMessageEl.textContent = `Saved: ${f.name}`;
      
      const btn = document.getElementById("save-file-btn");
      if (btn) { btn.classList.remove("dirty"); btn.title = "Save File (Ctrl+S)"; }
    } else {
      if (!silent) statusMessageEl.textContent = "Save cancelled.";
    }
  } catch (e) {
    console.error(e);
    if (!silent) statusMessageEl.textContent = "Error saving file";
  }
}

let isClosingWindow = false;

async function setupCloseHandler() {
  try {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow() || window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow();
    if (!appWindow) return;

    await appWindow.onCloseRequested(async (event) => {
      if (isClosingWindow) return;

      syncActiveFileContent();
      const unsaved = openFiles.filter(f => f.dirty);
      if (unsaved.length === 0) return;

      event.preventDefault();

      for (const f of unsaved) {
        if (f.id !== activeFileId) {
          await switchTab(f.id);
        }
        const action = await promptUnsavedChanges(f);
        if (action === "cancel") {
          return;
        } else if (action === "save") {
          const saved = await saveSingleFile(f);
          if (!saved) return;
        }
      }

      isClosingWindow = true;
      try {
        await appWindow.destroy();
      } catch (_) {
        await appWindow.close();
      }
    });
  } catch (err) {
    console.warn("Could not setup close handler:", err);
  }
}

function newFile() {
  syncActiveFileContent();
  const name = "untitled-" + untitledCounter++ + ".md";
  const nf = {
     id: "new-" + Date.now() + "-" + Math.random(),
     path: null,
     name: name,
     content: "",
     dirty: false
  };
  openFiles.push(nf);
  activeFileId = nf.id;
  
  markdownInputEl.value = "";
  writerViewEl.innerHTML = "";
  markdownInputEl.disabled = false;
  writerViewEl.contentEditable = "true";
  updateStats("");
  setDirty(false);
  renderTabBar();
  renderFileList();
  statusMessageEl.textContent = "New file";
  if (!isMarkdownMode) writerViewEl.focus();
  else markdownInputEl.focus();
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
function handleKeydown(e) {
  if (e.target && (e.target.id === "find-input" || e.target.id === "replace-input")) {
    return;
  }
  const mod = isPrimaryMod(e);

  if (!isMarkdownMode && e.key === "Enter" && !e.shiftKey && !mod) {
    if (handleWriterEnter(e)) return;
  }

  // ── ArrowDown at the last line of a code block → jump to next paragraph ──
  if (!isMarkdownMode && e.key === "ArrowDown" && !mod && !e.altKey && !e.shiftKey) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const adm = getAdmonitionAncestor(sel.getRangeAt(0).startContainer);
      if (adm) {
        let nextEl = adm.nextElementSibling;
        if (!nextEl) {
          nextEl = document.createElement("p");
          nextEl.appendChild(document.createElement("br"));
          if (adm.nextSibling) {
            adm.parentNode.insertBefore(nextEl, adm.nextSibling);
          } else {
            adm.parentNode.appendChild(nextEl);
          }
        }
        e.preventDefault();
        placeCaret(nextEl, 0);
        writerViewEl.focus();
        return;
      }

      const pre = getPreAncestor(sel.getRangeAt(0).startContainer);
      if (pre) {
        const range        = sel.getRangeAt(0);
        const container    = range.startContainer;
        const caretOffset  = range.startOffset;
        const containerText = (container.nodeType === Node.TEXT_NODE ? container.textContent : "") || "";
        const afterCaret   = containerText.slice(caretOffset);

        const noNewlineAfter = !afterCaret.includes("\n");
        let noFollowingSibling = true;
        if (container.nodeType === Node.TEXT_NODE) {
          let sib = container.nextSibling;
          while (sib) {
            if (sib.nodeType === Node.TEXT_NODE && sib.textContent.length > 0) {
              noFollowingSibling = false; break;
            }
            sib = sib.nextSibling;
          }
        }

        if (noNewlineAfter && noFollowingSibling) {
          let nextEl = pre.nextElementSibling;
          if (!nextEl) {
            const p = document.createElement("p");
            p.appendChild(document.createTextNode(""));
            pre.parentNode.appendChild(p);
            nextEl = p;
          }
          e.preventDefault();
          const firstChild = nextEl.firstChild || nextEl;
          const r = document.createRange();
          r.setStart(firstChild, 0);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          _savedRange = r.cloneRange();
          return;
        }
      }
    }
  }

  if (!isMarkdownMode && e.key === " " && !mod && !e.altKey && !e.shiftKey) {
    if (handleSpaceInWriter()) { e.preventDefault(); return; }
  }

  if (!isMarkdownMode && e.key === "Tab" && !mod) {
    const ctx = getTableContext();
    if (ctx) {
      e.preventDefault();
      const { table, cell } = ctx;
      const allCells = Array.from(table.querySelectorAll("th, td"));
      const currIdx = allCells.indexOf(cell);
      if (e.shiftKey) {
        if (currIdx > 0) {
          placeCaret(allCells[currIdx - 1], 0);
          allCells[currIdx - 1].focus();
        }
      } else {
        if (currIdx < allCells.length - 1) {
          placeCaret(allCells[currIdx + 1], 0);
          allCells[currIdx + 1].focus();
        } else {
          tableAddRowAfter();
          const updatedCells = Array.from(table.querySelectorAll("th, td"));
          if (updatedCells[currIdx + 1]) {
            placeCaret(updatedCells[currIdx + 1], 0);
            updatedCells[currIdx + 1].focus();
          }
        }
      }
      return;
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      let node = sel.getRangeAt(0).startContainer;
      let li = null;
      while (node && node !== writerViewEl) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "LI") { li = node; break; }
        node = node.parentNode;
      }
      if (li) {
        e.preventDefault();
        if (e.shiftKey) {
          outdentListItem(li);
        } else {
          indentListItem(li);
        }
        return;
      }
    }
  }

  // Undo / Redo
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (k === "y") {
      e.preventDefault();
      doRedo();
      return;
    }
  }

  if (mod && !e.altKey) {
    switch (e.key.toLowerCase()) {
      case "s": 
        e.preventDefault(); 
        if (e.shiftKey) { saveFileAs(); } else { saveFile(); }
        return;
      case "o": e.preventDefault(); openFile();          return;
      case "n": e.preventDefault(); newFile();           return;
      case "w": e.preventDefault(); if (activeFileId) closeTab(activeFileId); return;
      case "f": e.preventDefault(); toggleFindReplaceBar(false); return;
      case "h": e.preventDefault(); toggleFindReplaceBar(true);  return;
      case "r": e.preventDefault(); toggleFindReplaceBar(true);  return;
      case "b": e.preventDefault(); applyRichFormat("bold",   "**"); return;
      case "i": e.preventDefault(); applyRichFormat("italic", "*");  return;
      case "k": e.preventDefault(); applyCode();         return;
      case "l": e.preventDefault(); applyLink();         return;
      case "q": e.preventDefault(); applyBlockquote();   return;
      case "1": e.preventDefault(); applyHeading(1);     return;
      case "2": e.preventDefault(); applyHeading(2);     return;
      case "3": e.preventDefault(); applyHeading(3);     return;
      case "4": e.preventDefault(); applyHeading(4);     return;
      case "5": e.preventDefault(); applyHeading(5);     return;
      case "6": e.preventDefault(); applyHeading(6);     return;
    }
  }
  if (mod && e.altKey) {
    if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFindReplaceBar(false); return; }
    if (e.key === "h" || e.key === "H") { e.preventDefault(); applyHighlight(); return; }
    if (e.key === "t" || e.key === "T") { e.preventDefault(); insertAtCursor(formatTime(new Date())); return; }
    if (e.key === "d" || e.key === "D") { e.preventDefault(); insertAtCursor(formatDate(new Date())); return; }
  }
  if (mod && e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "f") {
      e.preventDefault();
      toggleFindReplaceBar(true);
      return;
    }
    if (k === "h") {
      e.preventDefault();
      replaceAll();
      return;
    }
    if (k === "b") {
      e.preventDefault();
      applySubscript();
      return;
    }
    if (k === "p") {
      e.preventDefault();
      applySuperscript();
      return;
    }
    if (k === "l") {
      e.preventDefault();
      applyTaskList();
      return;
    }
    if (k === "a") {
      e.preventDefault();
      insertAdmonition("note");
      return;
    }
  }
  if (e.key === "Escape") {
    closeFootnoteDrawer();
    closeFindReplaceBar();
  }
}

function pushHistory(file, content) {
  if (!file) file = getActiveFile();
  if (!file) return;

  if (content === undefined) {
    content = isMarkdownMode ? (markdownInputEl ? markdownInputEl.value : "") : (writerViewEl ? htmlToMarkdown(writerViewEl) : "");
  }

  if (!file.history) {
    file.history = [content];
    file.historyIndex = 0;
    return;
  }

  if (file.history[file.historyIndex] === content) return;

  file.history = file.history.slice(0, file.historyIndex + 1);
  file.history.push(content);

  if (file.history.length > 100) {
    file.history.shift();
  }
  file.historyIndex = file.history.length - 1;
}

// ─── Undo / Redo toolbar ──────────────────────────────────────────────────────
function doUndo() {
  if (!isMarkdownMode) {
    writerViewEl?.focus();
    document.execCommand("undo");
    return;
  }

  const f = getActiveFile();
  if (f && f.history && f.historyIndex > 0) {
    f.historyIndex--;
    const prevContent = f.history[f.historyIndex];
    f.content = prevContent;
    if (markdownInputEl) {
      markdownInputEl.value = prevContent;
      updateStats(prevContent);
    }
    setDirty(true);
    if (typeof performFind === "function") performFind();
    markdownInputEl?.focus();
    return;
  }

  if (markdownInputEl) {
    markdownInputEl.focus();
    document.execCommand("undo");
  }
}

function doRedo() {
  if (!isMarkdownMode) {
    writerViewEl?.focus();
    document.execCommand("redo");
    return;
  }

  const f = getActiveFile();
  if (f && f.history && f.historyIndex < f.history.length - 1) {
    f.historyIndex++;
    const nextContent = f.history[f.historyIndex];
    f.content = nextContent;
    if (markdownInputEl) {
      markdownInputEl.value = nextContent;
      updateStats(nextContent);
    }
    setDirty(true);
    if (typeof performFind === "function") performFind();
    markdownInputEl?.focus();
    return;
  }

  if (markdownInputEl) {
    markdownInputEl.focus();
    document.execCommand("redo");
  }
}

// ─── Main Menu & Modals ───────────────────────────────────────────────────────
function toggleMainMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById("main-menu");
  menu.classList.toggle("hidden");
}

function openModal(id) {
  document.getElementById("main-menu").classList.add("hidden");
  document.getElementById(id).showModal();
}

function closeModal(id) {
  document.getElementById(id).close();
}

// ─── Initialisation ───────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  markdownInputEl = document.getElementById("markdown-input");
  writerViewEl    = document.getElementById("writer-view");
  toggleModeBtn   = document.getElementById("toggle-mode-btn");
  modeIndicatorEl = document.getElementById("mode-indicator");
  statusMessageEl = document.getElementById("status-message");
  wordCountEl     = document.getElementById("word-count");
  charCountEl     = document.getElementById("char-count");

  try { platform = await invoke("get_platform"); } catch (_) { platform = "linux"; }

  // ── Save selection + update Code Controls whenever caret moves in writer view ──
  document.addEventListener("selectionchange", () => {
    if (!isMarkdownMode && document.activeElement === writerViewEl) {
      saveSelection();
      updateCodeControls();
    }
  });
  writerViewEl.addEventListener("blur", () => {
    saveSelection();
    setTimeout(() => {
      if (document.activeElement !== _codeCloseBtn &&
          document.activeElement !== _codeLangSelect &&
          !_codeControlsBar?.contains(document.activeElement)) {
        hideCodeControls();
      }
    }, 150);
  });

  // ── Input events ──
  writerViewEl.addEventListener("input", (e) => { handleLiveMarkdown(e); debouncedStats(); });
  markdownInputEl.addEventListener("input", debouncedStats);

  // ── File buttons ──
  document.getElementById("toggle-mode-btn")?.addEventListener("click", toggleMode);
  document.getElementById("open-file-btn")?.addEventListener("click",   openFile);
  document.getElementById("save-file-btn")?.addEventListener("click",   () => saveFile());
  document.getElementById("new-file-btn")?.addEventListener("click",    newFile);

  // ── Format toolbar ──
  document.getElementById("bold-btn")?.addEventListener("click",   () => applyRichFormat("bold",   "**"));
  document.getElementById("italic-btn")?.addEventListener("click", () => applyRichFormat("italic", "*"));
  document.getElementById("highlight-btn")?.addEventListener("click", () => applyHighlight());
  document.getElementById("sub-btn")?.addEventListener("click",       () => applySubscript());
  document.getElementById("sup-btn")?.addEventListener("click",       () => applySuperscript());
  document.getElementById("link-btn")?.addEventListener("click",      () => applyLink());
  document.getElementById("code-btn")?.addEventListener("click",   () => applyCode());
  document.getElementById("undo-btn")?.addEventListener("click",   doUndo);
  document.getElementById("redo-btn")?.addEventListener("click",   doRedo);
  for (let i = 1; i <= 6; i++) {
    document.getElementById(`h${i}-btn`)?.addEventListener("click", () => applyHeading(i));
  }
  document.getElementById("ul-btn")?.addEventListener("click",    () => applyUnorderedList());
  document.getElementById("ol-btn")?.addEventListener("click",    () => applyOrderedList());
  document.getElementById("tasklist-btn")?.addEventListener("click",() => applyTaskList());

  writerViewEl.addEventListener("change", (e) => {
    if (e.target && e.target.matches("input[type='checkbox']")) {
      debouncedStats();
    }
  });

  document.getElementById("quote-btn")?.addEventListener("click", () => applyBlockquote());
  document.getElementById("hr-btn")?.addEventListener("click",    () => applyHorizontalRule());
  document.getElementById("time-btn")?.addEventListener("click",  () => insertAtCursor(formatTime(new Date())));
  document.getElementById("date-btn")?.addEventListener("click",  () => insertAtCursor(formatDate(new Date())));
  document.getElementById("footnote-btn")?.addEventListener("click", applyFootnote);

  // ── Footnote Drawer Buttons ──
  document.getElementById("add-footnote-btn")?.addEventListener("click", applyFootnote);
  document.getElementById("close-footnote-drawer-btn")?.addEventListener("click", closeFootnoteDrawer);

  // Click on footnote reference in writer view opens drawer
  writerViewEl.addEventListener("click", (e) => {
    const fnRef = e.target.closest("sup.footnote-reference, sup.footnote-ref, [data-footnote-id]");
    if (fnRef) {
      e.preventDefault();
      const fnId = fnRef.dataset.footnoteId || fnRef.textContent.trim();
      openFootnoteDrawer(fnId);
    }
  });

  // ── Table Controls ──
  document.getElementById("table-btn")?.addEventListener("click", toggleTableMenu);
  document.getElementById("table-insert-custom-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const rows = parseInt(document.getElementById("table-rows-input")?.value || "3", 10);
    const cols = parseInt(document.getElementById("table-cols-input")?.value || "3", 10);
    insertTable(rows, cols);
    closeTableMenu();
  });

  // Toolbar Quick Table Actions
  document.getElementById("table-col-before-btn")?.addEventListener("click", tableAddColumnBefore);
  document.getElementById("table-col-after-btn")?.addEventListener("click", tableAddColumnAfter);
  document.getElementById("table-col-del-btn")?.addEventListener("click", tableRemoveColumn);
  document.getElementById("table-row-before-btn")?.addEventListener("click", tableAddRowBefore);
  document.getElementById("table-row-after-btn")?.addEventListener("click", tableAddRowAfter);
  document.getElementById("table-row-del-btn")?.addEventListener("click", tableRemoveRow);
  document.getElementById("table-align-left-btn")?.addEventListener("click", () => tableSetColumnAlignment("left"));
  document.getElementById("table-align-center-btn")?.addEventListener("click", () => tableSetColumnAlignment("center"));
  document.getElementById("table-align-right-btn")?.addEventListener("click", () => tableSetColumnAlignment("right"));

  // Popover Menu Items
  document.getElementById("menu-table-col-before")?.addEventListener("click", (e) => { e.stopPropagation(); tableAddColumnBefore(); closeTableMenu(); });
  document.getElementById("menu-table-col-after")?.addEventListener("click", (e) => { e.stopPropagation(); tableAddColumnAfter(); closeTableMenu(); });
  document.getElementById("menu-table-col-del")?.addEventListener("click", (e) => { e.stopPropagation(); tableRemoveColumn(); closeTableMenu(); });
  document.getElementById("menu-table-row-before")?.addEventListener("click", (e) => { e.stopPropagation(); tableAddRowBefore(); closeTableMenu(); });
  document.getElementById("menu-table-row-after")?.addEventListener("click", (e) => { e.stopPropagation(); tableAddRowAfter(); closeTableMenu(); });
  document.getElementById("menu-table-row-del")?.addEventListener("click", (e) => { e.stopPropagation(); tableRemoveRow(); closeTableMenu(); });
  document.getElementById("menu-table-align-left")?.addEventListener("click", (e) => { e.stopPropagation(); tableSetColumnAlignment("left"); closeTableMenu(); });
  document.getElementById("menu-table-align-center")?.addEventListener("click", (e) => { e.stopPropagation(); tableSetColumnAlignment("center"); closeTableMenu(); });
  document.getElementById("menu-table-align-right")?.addEventListener("click", (e) => { e.stopPropagation(); tableSetColumnAlignment("right"); closeTableMenu(); });

  // ── Main Menu ──
  const mainMenuBtn = document.getElementById("main-menu-btn");
  if (mainMenuBtn) {
    mainMenuBtn.addEventListener("click", toggleMainMenu);
  }
  document.getElementById("menu-about-btn")?.addEventListener("click", () => openModal("about-modal"));
  document.getElementById("menu-prefs-btn")?.addEventListener("click", () => openModal("prefs-modal"));

  document.getElementById("close-about-btn")?.addEventListener("click", () => closeModal("about-modal"));
  document.getElementById("close-prefs-btn")?.addEventListener("click", () => closeModal("prefs-modal"));

  // Rename modal buttons
  document.getElementById("cancel-rename-btn")?.addEventListener("click", () => closeModal("rename-modal"));
  document.getElementById("confirm-rename-btn")?.addEventListener("click", confirmRename);

  // ── Admonition Controls ──
  document.getElementById("admonition-btn")?.addEventListener("click", toggleAdmonitionMenu);
  document.querySelectorAll(".admonition-type-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const type = btn.dataset.type || "note";
      insertAdmonition(type);
      closeAdmonitionMenu();
    });
  });

  // Close menus when clicking outside
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("main-menu");
    const btn = document.getElementById("main-menu-btn");
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.add("hidden");
    }
    const tableMenu = document.getElementById("table-menu");
    const tableBtn = document.getElementById("table-btn");
    if (tableMenu && tableBtn && !tableMenu.contains(e.target) && !tableBtn.contains(e.target)) {
      tableMenu.classList.add("hidden");
    }
    const admMenu = document.getElementById("admonition-menu");
    const admBtn = document.getElementById("admonition-btn");
    if (admMenu && admBtn && !admMenu.contains(e.target) && !admBtn.contains(e.target)) {
      admMenu.classList.add("hidden");
    }
  });

  // ── Auto-save Preferences ──
  const autoSaveSelect = document.getElementById("autosave-select");
  if (autoSaveSelect) {
    autoSaveSelect.addEventListener("change", (e) => {
      applyAutoSaveSetting(parseInt(e.target.value));
    });
  }

  // ── Theme Preference ──
  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.addEventListener("change", (e) => {
      applyThemeSetting(e.target.value);
    });
  }

  // ── Mode Segmented Control ──
  document.getElementById("mode-writer-btn")?.addEventListener("click", () => setViewMode("writer"));
  document.getElementById("mode-markdown-btn")?.addEventListener("click", () => setViewMode("markdown"));
  document.getElementById("mode-split-btn")?.addEventListener("click", () => setViewMode("split"));

  // ── TUI Menu Bar Button Handlers ──
  document.getElementById("tui-menu-file-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleTuiMenu("tui-file-menu", "tui-menu-file-btn"); });
  document.getElementById("tui-menu-edit-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleTuiMenu("tui-edit-menu", "tui-menu-edit-btn"); });
  document.getElementById("tui-menu-format-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleTuiMenu("tui-format-menu", "tui-menu-format-btn"); });
  document.getElementById("tui-menu-view-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleTuiMenu("tui-view-menu", "tui-menu-view-btn"); });
  document.getElementById("tui-menu-theme-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleTuiMenu("tui-theme-menu", "tui-menu-theme-btn"); });
  document.getElementById("tui-menu-help-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleTuiMenu("tui-help-menu", "tui-menu-help-btn"); });

  // TUI File Items
  document.getElementById("tui-file-new-btn")?.addEventListener("click", () => { closeAllTuiMenus(); newFile(); });
  document.getElementById("tui-file-open-btn")?.addEventListener("click", () => { closeAllTuiMenus(); openFile(); });
  document.getElementById("tui-file-save-btn")?.addEventListener("click", () => { closeAllTuiMenus(); saveFile(); });
  document.getElementById("tui-file-save-as-btn")?.addEventListener("click", () => { closeAllTuiMenus(); saveFileAs(); });

  // TUI Edit Items
  document.getElementById("tui-edit-undo-btn")?.addEventListener("click", () => { closeAllTuiMenus(); doUndo(); });
  document.getElementById("tui-edit-redo-btn")?.addEventListener("click", () => { closeAllTuiMenus(); doRedo(); });

  // TUI Format Items
  document.getElementById("tui-fmt-h1")?.addEventListener("click", () => { closeAllTuiMenus(); applyHeading(1); });
  document.getElementById("tui-fmt-h2")?.addEventListener("click", () => { closeAllTuiMenus(); applyHeading(2); });
  document.getElementById("tui-fmt-h3")?.addEventListener("click", () => { closeAllTuiMenus(); applyHeading(3); });
  document.getElementById("tui-fmt-bold")?.addEventListener("click", () => { closeAllTuiMenus(); applyRichFormat("bold", "**"); });
  document.getElementById("tui-fmt-italic")?.addEventListener("click", () => { closeAllTuiMenus(); applyRichFormat("italic", "*"); });
  document.getElementById("tui-fmt-code")?.addEventListener("click", () => { closeAllTuiMenus(); applyCode(); });
  document.getElementById("tui-fmt-highlight")?.addEventListener("click", () => { closeAllTuiMenus(); applyHighlight(); });
  document.getElementById("tui-fmt-sub")?.addEventListener("click", () => { closeAllTuiMenus(); applySubscript(); });
  document.getElementById("tui-fmt-sup")?.addEventListener("click", () => { closeAllTuiMenus(); applySuperscript(); });
  document.getElementById("tui-fmt-link")?.addEventListener("click", () => { closeAllTuiMenus(); applyLink(); });
  document.getElementById("tui-fmt-ul")?.addEventListener("click", () => { closeAllTuiMenus(); applyUnorderedList(); });
  document.getElementById("tui-fmt-ol")?.addEventListener("click", () => { closeAllTuiMenus(); applyOrderedList(); });
  document.getElementById("tui-fmt-task")?.addEventListener("click", () => { closeAllTuiMenus(); applyTaskList(); });
  document.getElementById("tui-fmt-quote")?.addEventListener("click", () => { closeAllTuiMenus(); applyBlockquote(); });
  document.getElementById("tui-fmt-hr")?.addEventListener("click", () => { closeAllTuiMenus(); applyHorizontalRule(); });

  // TUI View Items
  document.getElementById("tui-view-writer")?.addEventListener("click", () => { closeAllTuiMenus(); setViewMode("writer"); });
  document.getElementById("tui-view-markdown")?.addEventListener("click", () => { closeAllTuiMenus(); setViewMode("markdown"); });
  document.getElementById("tui-view-split")?.addEventListener("click", () => { closeAllTuiMenus(); setViewMode("split"); });
  document.getElementById("tui-view-wordwrap")?.addEventListener("click", () => {
    closeAllTuiMenus();
    toggleWordWrap();
  });

  // TUI Theme Items
  document.querySelectorAll(".theme-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      closeAllTuiMenus();
      const theme = btn.dataset.theme;
      if (theme) applyThemeSetting(theme);
    });
  });

  // TUI Help Items
  document.getElementById("tui-help-about")?.addEventListener("click", () => { closeAllTuiMenus(); openModal("about-modal"); });

  // Close TUI menus on clicking anywhere outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".tui-menubar") && !e.target.closest(".tui-dropdown")) {
      closeAllTuiMenus();
    }
  });

  // Synced scroll in Split View mode
  let isSyncingScroll = false;
  markdownInputEl.addEventListener("scroll", () => {
    const backdrop = document.getElementById("markdown-backdrop");
    if (backdrop) {
      backdrop.scrollTop = markdownInputEl.scrollTop;
      backdrop.scrollLeft = markdownInputEl.scrollLeft;
    }
    if (currentViewMode === "split" && !isSyncingScroll) {
      isSyncingScroll = true;
      const ratio = markdownInputEl.scrollTop / (markdownInputEl.scrollHeight - markdownInputEl.clientHeight || 1);
      writerViewEl.scrollTop = ratio * (writerViewEl.scrollHeight - writerViewEl.clientHeight);
      setTimeout(() => { isSyncingScroll = false; }, 50);
    }
  });
  writerViewEl.addEventListener("scroll", () => {
    if (currentViewMode === "split" && !isSyncingScroll) {
      isSyncingScroll = true;
      const ratio = writerViewEl.scrollTop / (writerViewEl.scrollHeight - writerViewEl.clientHeight || 1);
      markdownInputEl.scrollTop = ratio * (markdownInputEl.scrollHeight - markdownInputEl.clientHeight);
      setTimeout(() => { isSyncingScroll = false; }, 50);
    }
  });

  // Live update writer view when typing in raw markdown in split mode
  const debouncedSplitUpdate = debounce(async () => {
    if (currentViewMode === "split") {
      await renderMarkdownToWriter(markdownInputEl.value);
    }
  }, 100);
  const debouncedPushHistory = debounce(() => {
    pushHistory(getActiveFile(), markdownInputEl.value);
  }, 300);
  markdownInputEl.addEventListener("input", debouncedPushHistory);
  markdownInputEl.addEventListener("input", debouncedSplitUpdate);

  // ── Global keyboard shortcuts ──
  window.addEventListener("keydown", handleKeydown);

  // ── Intercept Window Close to Save Unsaved Changes ──
  try { await setupCloseHandler(); } catch (err) { console.warn(err); }

  // ── Restore settings ──
  const settings = loadSettings();
  const autoSaveMinutes = settings.autoSaveMinutes ?? 5;
  updateAutoSaveUI(autoSaveMinutes);
  startAutoSave(autoSaveMinutes);

  const themeName = settings.theme || "dracula";
  applyThemeSetting(themeName);

  const wordWrap = settings.wordWrap ?? true;
  applyWordWrapSetting(wordWrap);

  // ── File list ──
  renderFileList();

  // ── Default content ──
  const defaultMd =
    "# Welcome to ArtfulType Pro\n\n" +
    "Start writing your next masterpiece.\n\n" +
    "## Features\n\n" +
    "- [x] **Writer mode** — live Markdown editing\n" +
    "- [x] **Dracula theme** — beautiful dark palette\n" +
    "- [x] Extended syntax: tables, footnotes & code blocks\n" +
    "- [ ] Task lists with interactive checkboxes\n" +
    "- [ ] Native file I/O with auto-save\n\n" +
    "### Keyboard Shortcuts\n\n" +
    "| Action | Key |\n" +
    "| --- | --- |\n" +
    "| Bold | Ctrl+B |\n" +
    "| Italic | Ctrl+I |\n" +
    "| Code | Ctrl+K |\n" +
    "| Task List | Ctrl+Shift+L |\n" +
    "| H1–H6 | Ctrl+1–6 |\n" +
    "| Blockquote | Ctrl+Q |\n" +
    "| Undo | Ctrl+Z |\n" +
    "| Redo | Ctrl+Y |\n" +
    "| Toggle Mode | Ctrl+M |\n\n" +
    "#### Live triggers in Writer Mode\n\n" +
    "> Type `- [ ] ` → task list item · `- ` → bullet list · `1. ` → numbered · `> ` → blockquote\n" +
    "> Type `# ` / `## ` / `### ` → headings\n\n" +
    "---\n\n";

  markdownInputEl.value = defaultMd;
  await renderMarkdownToWriter(defaultMd);
  updateStats(defaultMd);
  setDirty(false);

  // Clear default text when user clicks or focuses the editor area
  const clearDefaultText = () => {
    if (!(getActiveFile()?.dirty) && markdownInputEl.value === defaultMd) {
      markdownInputEl.value = "";
      renderMarkdownToWriter("");
      updateStats("");
      markdownInputEl.removeEventListener("focus", clearDefaultText);
      writerViewEl.removeEventListener("focus", clearDefaultText);
      markdownInputEl.removeEventListener("click", clearDefaultText);
      writerViewEl.removeEventListener("click", clearDefaultText);
    }
  };
  markdownInputEl.addEventListener("focus", clearDefaultText);
  writerViewEl.addEventListener("focus", clearDefaultText);
  markdownInputEl.addEventListener("click", clearDefaultText);
  writerViewEl.addEventListener("click", clearDefaultText);

  // ── CLI Launch Payload ──
  try {
    const cliArgs = await invoke("get_cli_args");
    if (cliArgs) {
      if (cliArgs.theme) {
        applyThemeSetting(cliArgs.theme);
      }
      if (cliArgs.file_path && cliArgs.file_content != null) {
        await applyOpenedFile({
          path: cliArgs.file_path,
          name: cliArgs.file_name || "file.md",
          content: cliArgs.file_content
        });
        statusMessageEl.textContent = `Opened from CLI: ${cliArgs.file_name}`;
      }
      if (cliArgs.mode) {
        const m = cliArgs.mode.toLowerCase();
        if (m === "split" || m === "markdown" || m === "writer") {
          await setViewMode(m);
        }
      } else {
        await setViewMode("writer");
      }
    } else {
      await setViewMode("writer");
    }
  } catch (err) {
    console.log("No CLI args or CLI invoke error:", err);
    await setViewMode("writer");
  }
});

// ─── TUI Dropdown Menu Helpers ──────────────────────────────────────────────
function toggleTuiMenu(menuId, btnId) {
  const menu = document.getElementById(menuId);
  const btn = document.getElementById(btnId);
  if (!menu || !btn) return;

  const isHidden = menu.classList.contains("hidden");
  closeAllTuiMenus();

  if (isHidden) {
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = rect.left + "px";
    menu.classList.remove("hidden");
    btn.classList.add("active");
  }
}

function closeAllTuiMenus() {
  document.querySelectorAll(".tui-dropdown").forEach(m => m.classList.add("hidden"));
  document.querySelectorAll(".tui-menu-btn").forEach(b => b.classList.remove("active"));
}

// ─── NEXTCLOUD INTEGRATION MODULE ────────────────────────────────────────────
function getNcRecentFiles() {
  try {
    const json = localStorage.getItem("artfultype_nc_recent");
    return json ? JSON.parse(json) : [];
  } catch (_) { return []; }
}

function recordNcRecentFile(remotePath, remoteName) {
  if (!remotePath || !remoteName) return;
  let list = getNcRecentFiles().filter(item => item.path !== remotePath);
  list.unshift({ path: remotePath, name: remoteName });
  if (list.length > 2) list = list.slice(0, 2);
  try {
    localStorage.setItem("artfultype_nc_recent", JSON.stringify(list));
  } catch (_) {}
}

let ncConfig = null;
let ncCurrentPath = "";
let ncEntries = [];
let ncStatus = "unlinked"; // "unlinked" | "linked" | "error" | "syncing"

async function initNextcloud() {
  try {
    const config = await invoke("get_nextcloud_config");
    if (config && config.server_url && config.username) {
      ncConfig = config;
      updateNextcloudUI("linked", `Linked to ${config.server_url}`);
      populateNextcloudPrefInputs(config);
      await fetchNextcloudFolder("");
    } else {
      ncConfig = null;
      updateNextcloudUI("unlinked", "Disconnected");
    }
  } catch (err) {
    console.warn("Failed to initialize Nextcloud:", err);
    updateNextcloudUI("unlinked", "Not configured");
  }
}

function populateNextcloudPrefInputs(config) {
  const urlEl = document.getElementById("nc-server-url");
  const userEl = document.getElementById("nc-username");
  const passEl = document.getElementById("nc-password");
  if (urlEl && config) urlEl.value = config.server_url || "";
  if (userEl && config) userEl.value = config.username || "";
  if (passEl && config) passEl.value = config.password || "";
}

function updateNextcloudUI(status, msg) {
  ncStatus = status;
  const indicator = document.getElementById("nextcloud-status-indicator");
  const syncBtn = document.getElementById("nextcloud-sync-btn");
  const badge = document.getElementById("nc-status-badge");
  const msgEl = document.getElementById("nc-msg");
  const unlinkBtn = document.getElementById("nc-unlink-btn");
  const linkBtn = document.getElementById("nc-save-btn");

  if (indicator) {
    indicator.className = `nextcloud-status ${status}`;
    indicator.title = `Nextcloud: ${msg}`;
  }

  if (syncBtn) {
    if (status === "linked" || status === "syncing") {
      syncBtn.classList.remove("hidden");
    } else {
      syncBtn.classList.add("hidden");
    }
  }

  if (badge) {
    badge.className = `nc-badge ${status}`;
    badge.textContent = status === "linked" ? "Linked" : (status === "syncing" ? "Syncing..." : (status === "error" ? "Error" : "Disconnected"));
  }

  if (unlinkBtn) {
    if (status === "linked" || status === "error") {
      unlinkBtn.classList.remove("hidden");
    } else {
      unlinkBtn.classList.add("hidden");
    }
  }

  if (linkBtn) {
    linkBtn.textContent = status === "linked" ? "Update Link" : "Link Account";
  }

  if (msgEl && msg) {
    msgEl.textContent = msg;
    msgEl.style.display = "block";
  }
}

async function testNextcloudConnection() {
  const url = document.getElementById("nc-server-url")?.value?.trim();
  const username = document.getElementById("nc-username")?.value?.trim();
  const password = document.getElementById("nc-password")?.value?.trim();

  if (!url || !username) {
    updateNextcloudUI("error", "Please provide Server URL and Username.");
    return;
  }

  updateNextcloudUI("syncing", "Testing connection...");
  try {
    const res = await invoke("test_nextcloud_connection", {
      config: { server_url: url, username, password, enabled: true }
    });
    updateNextcloudUI("linked", res || "Connection successful!");
  } catch (err) {
    updateNextcloudUI("error", `Connection failed: ${err}`);
  }
}

async function saveNextcloudCredentials() {
  const url = document.getElementById("nc-server-url")?.value?.trim();
  const username = document.getElementById("nc-username")?.value?.trim();
  const password = document.getElementById("nc-password")?.value?.trim();

  if (!url || !username) {
    updateNextcloudUI("error", "Server URL and Username are required.");
    return;
  }

  updateNextcloudUI("syncing", "Linking Nextcloud account...");
  const config = { server_url: url, username, password, enabled: true };
  try {
    await invoke("test_nextcloud_connection", { config });
    await invoke("save_nextcloud_config", { config });
    ncConfig = config;
    updateNextcloudUI("linked", `Successfully linked account: ${username}`);
    await fetchNextcloudFolder("");
  } catch (err) {
    updateNextcloudUI("error", `Linking failed: ${err}`);
  }
}

async function unlinkNextcloudAccount() {
  const confirmed = await promptConfirm("Unlink Nextcloud", "Are you sure you want to disconnect Nextcloud?", "Unlink", true);
  if (!confirmed) return;
  try {
    await invoke("unlink_nextcloud");
    ncConfig = null;
    ncEntries = [];
    ncCurrentPath = "";
    populateNextcloudPrefInputs({ server_url: "", username: "", password: "" });
    updateNextcloudUI("unlinked", "Disconnected Nextcloud account.");
    renderNextcloudFileList();
  } catch (err) {
    updateNextcloudUI("error", `Unlink error: ${err}`);
  }
}

async function fetchNextcloudFolder(remotePath) {
  if (!ncConfig) return;
  updateNextcloudUI("syncing", `Syncing /${remotePath || ""}...`);
  try {
    const entries = await invoke("list_nextcloud_folder", { path: remotePath });
    ncCurrentPath = remotePath;
    ncEntries = entries || [];
    updateNextcloudUI("linked", `Linked to ${ncConfig.server_url}`);
    renderNextcloudFileList();
  } catch (err) {
    console.error("Fetch Nextcloud folder error:", err);
    updateNextcloudUI("error", `Failed to load folder: ${err}`);
  }
}

function renderNextcloudFileList() {
  const breadcrumbsEl = document.getElementById("nc-path-breadcrumbs");
  const listEl = document.getElementById("nc-file-list");
  if (!breadcrumbsEl || !listEl) return;

  breadcrumbsEl.textContent = "/" + (ncCurrentPath ? ncCurrentPath : "");
  listEl.innerHTML = "";

  if (!ncConfig) {
    const emptyLi = document.createElement("li");
    emptyLi.style.padding = "10px"; emptyLi.style.color = "var(--comment)"; emptyLi.style.fontSize = "0.8rem";
    emptyLi.textContent = "Nextcloud is not linked. Open Preferences to link your account.";
    listEl.appendChild(emptyLi);
    return;
  }

  if (ncCurrentPath) {
    const parentPath = ncCurrentPath.includes("/") ? ncCurrentPath.replace(/\/[^/]+$/, "") : "";
    const upLi = document.createElement("li");
    upLi.className = "nc-file-item";
    upLi.innerHTML = `<span class="nc-file-label">📁 .. (Parent Directory)</span>`;
    upLi.onclick = () => fetchNextcloudFolder(parentPath);
    listEl.appendChild(upLi);
  }

  const recentList = getNcRecentFiles();
  if (recentList.length > 0) {
    const headerLi = document.createElement("li");
    headerLi.className = "nc-recent-header";
    headerLi.textContent = "🕒 Recent History";
    listEl.appendChild(headerLi);

    for (const item of recentList) {
      const recLi = document.createElement("li");
      const isActive = openFiles.some(f => f.isNextcloud && f.remotePath === item.path && f.id === activeFileId);
      recLi.className = "nc-file-item nc-recent-item" + (isActive ? " active" : "");
      recLi.innerHTML = `<span class="nc-file-label">🕒 ${item.name} <small class="nc-recent-path">(${item.path})</small></span>`;
      recLi.onclick = () => openNextcloudFile({ name: item.name, path: item.path, is_dir: false });
      listEl.appendChild(recLi);
    }

    const sepLi = document.createElement("li");
    sepLi.className = "nc-recent-sep";
    listEl.appendChild(sepLi);
  }

  if (ncEntries.length === 0) {
    const emptyLi = document.createElement("li");
    emptyLi.style.padding = "10px"; emptyLi.style.color = "var(--comment)"; emptyLi.style.fontSize = "0.8rem";
    emptyLi.textContent = "Directory is empty";
    listEl.appendChild(emptyLi);
    return;
  }

  for (const item of ncEntries) {
    const li = document.createElement("li");
    const isActive = openFiles.some(f => f.isNextcloud && f.remotePath === item.path && f.id === activeFileId);
    li.className = "nc-file-item" + (isActive ? " active" : "");

    const labelSpan = document.createElement("span");
    labelSpan.className = "nc-file-label";
    const icon = item.is_dir ? "📁" : (isImageFile(item.name) ? "🖼" : "📄");
    labelSpan.textContent = `${icon} ${item.name}`;

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "nc-file-actions";

    const delBtn = document.createElement("button");
    delBtn.className = "file-action-btn";
    delBtn.innerHTML = "✕";
    delBtn.title = "Delete Remote Item";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteNextcloudItem(item);
    };

    actionsDiv.appendChild(delBtn);
    li.appendChild(labelSpan);
    li.appendChild(actionsDiv);

    li.onclick = () => {
      if (item.is_dir) {
        fetchNextcloudFolder(item.path);
      } else {
        openNextcloudFile(item);
      }
    };

    listEl.appendChild(li);
  }
}

async function openNextcloudFile(item) {
  if (!isTextFile(item.name) && !isImageFile(item.name)) {
    statusMessageEl.textContent = `Cannot open "${item.name}": Nextcloud file is not a text file.`;
    updateNextcloudUI("linked", `Cannot open non-text file: ${item.name}`);
    alert(`Cannot open "${item.name}": ArtfulType Pro only opens text files.`);
    return;
  }

  const existing = openFiles.find(f => f.isNextcloud && f.remotePath === item.path);
  if (existing) {
    switchTab(existing.id);
    return;
  }

  statusMessageEl.textContent = `Downloading ${item.name} from Nextcloud…`;
  updateNextcloudUI("syncing", `Downloading ${item.name}...`);
  try {
    const tabId = "nc:" + item.path;

    if (isImageFile(item.name)) {
      const dataUrl = await invoke("read_nextcloud_image_base64", { path: item.path });
      const imgObj = {
        id: tabId,
        name: `☁ ${item.name}`,
        path: null,
        isNextcloud: true,
        remotePath: item.path,
        remoteName: item.name,
        isImage: true,
        dataUrl: dataUrl,
        content: "",
        dirty: false,
      };
      openFiles.push(imgObj);
      switchTab(tabId);
      recordNcRecentFile(item.path, item.name);
      statusMessageEl.textContent = `Opened Nextcloud image: ${item.name}`;
      updateNextcloudUI("linked", `Linked to ${ncConfig.server_url}`);
      renderNextcloudFileList();
      return;
    }

    const content = await invoke("read_nextcloud_file", { path: item.path });
    const fileObj = {
      id: tabId,
      name: `☁ ${item.name}`,
      path: null,
      isNextcloud: true,
      remotePath: item.path,
      remoteName: item.name,
      content: content,
      dirty: false,
      history: [content],
      historyIndex: 0,
    };
    openFiles.push(fileObj);
    switchTab(tabId);
    recordNcRecentFile(item.path, item.name);
    statusMessageEl.textContent = `Opened Nextcloud file: ${item.name}`;
    updateNextcloudUI("linked", `Linked to ${ncConfig.server_url}`);
    renderNextcloudFileList();
  } catch (err) {
    console.error("Open Nextcloud file error:", err);
    statusMessageEl.textContent = `Failed to open ${item.name}: ${err}`;
    updateNextcloudUI("error", `Failed to read file: ${err}`);
  }
}

async function createNextcloudFilePrompt() {
  if (!ncConfig) {
    openModal("prefs-modal");
    return;
  }
  const filename = prompt("Enter new Markdown filename for Nextcloud:", "notes.md");
  if (!filename || !filename.trim()) return;
  let cleanName = filename.trim();
  if (!cleanName.endsWith(".md") && !cleanName.endsWith(".txt") && !cleanName.endsWith(".markdown")) {
    cleanName += ".md";
  }
  const remotePath = ncCurrentPath ? `${ncCurrentPath}/${cleanName}` : cleanName;
  updateNextcloudUI("syncing", `Creating ${cleanName}...`);
  try {
    await invoke("write_nextcloud_file", { path: remotePath, content: `# ${cleanName.replace(/\.md$/i, "")}\n\n` });
    await fetchNextcloudFolder(ncCurrentPath);
    await openNextcloudFile({ name: cleanName, path: remotePath, is_dir: false });
  } catch (err) {
    updateNextcloudUI("error", `Failed to create file: ${err}`);
  }
}

async function createNextcloudFolderPrompt() {
  if (!ncConfig) {
    openModal("prefs-modal");
    return;
  }
  const folderName = prompt("Enter new directory name for Nextcloud:", "New Folder");
  if (!folderName || !folderName.trim()) return;
  const cleanName = folderName.trim();
  const remotePath = ncCurrentPath ? `${ncCurrentPath}/${cleanName}` : cleanName;
  updateNextcloudUI("syncing", `Creating folder ${cleanName}...`);
  try {
    await invoke("create_nextcloud_folder", { path: remotePath });
    await fetchNextcloudFolder(ncCurrentPath);
  } catch (err) {
    updateNextcloudUI("error", `Failed to create folder: ${err}`);
  }
}

async function deleteNextcloudItem(item) {
  const confirmed = await promptConfirm("Delete Nextcloud Item", `Are you sure you want to delete "${item.name}" from Nextcloud?`, "Delete", true);
  if (!confirmed) return;
  updateNextcloudUI("syncing", `Deleting ${item.name}...`);
  try {
    await invoke("delete_nextcloud_entry", { path: item.path });
    await fetchNextcloudFolder(ncCurrentPath);
    statusMessageEl.textContent = `Deleted from Nextcloud: ${item.name}`;
  } catch (err) {
    updateNextcloudUI("error", `Failed to delete ${item.name}: ${err}`);
  }
}

// ─── Setup Nextcloud Event Listeners ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initNextcloud();

  // Sidebar Tab Switching
  const tabLocal = document.getElementById("sidebar-tab-local");
  const tabNc = document.getElementById("sidebar-tab-nextcloud");
  const localContainer = document.getElementById("local-sidebar-container");
  const ncContainer = document.getElementById("nextcloud-sidebar-container");

  if (tabLocal && tabNc && localContainer && ncContainer) {
    tabLocal.addEventListener("click", () => {
      tabLocal.classList.add("active");
      tabNc.classList.remove("active");
      localContainer.classList.remove("hidden");
      ncContainer.classList.add("hidden");
    });
    tabNc.addEventListener("click", () => {
      tabNc.classList.add("active");
      tabLocal.classList.remove("active");
      ncContainer.classList.remove("hidden");
      localContainer.classList.add("hidden");
      if (ncConfig) {
        fetchNextcloudFolder(ncCurrentPath);
      } else {
        renderNextcloudFileList();
      }
    });
  }

  // Header status indicator & sync button
  const statusIndicator = document.getElementById("nextcloud-status-indicator");
  if (statusIndicator) {
    statusIndicator.addEventListener("click", () => openModal("prefs-modal"));
  }
  const syncBtn = document.getElementById("nextcloud-sync-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", () => fetchNextcloudFolder(ncCurrentPath));
  }

  // Preferences buttons
  const testBtn = document.getElementById("nc-test-btn");
  if (testBtn) testBtn.addEventListener("click", testNextcloudConnection);

  const saveBtn = document.getElementById("nc-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveNextcloudCredentials);

  const unlinkBtn = document.getElementById("nc-unlink-btn");
  if (unlinkBtn) unlinkBtn.addEventListener("click", unlinkNextcloudAccount);

  // Nextcloud Sidebar Action buttons
  const ncNewFileBtn = document.getElementById("nc-new-file-btn");
  if (ncNewFileBtn) ncNewFileBtn.addEventListener("click", createNextcloudFilePrompt);

  const ncNewFolderBtn = document.getElementById("nc-new-folder-btn");
  if (ncNewFolderBtn) ncNewFolderBtn.addEventListener("click", createNextcloudFolderPrompt);

  const ncRefreshBtn = document.getElementById("nc-refresh-btn");
  if (ncRefreshBtn) ncRefreshBtn.addEventListener("click", () => fetchNextcloudFolder(ncCurrentPath));
});

// ─── Find & Replace Engine ──────────────────────────────────────────────────
let findMatches = [];
let currentMatchIndex = -1;
let isReplaceVisible = false;
let findOptions = { matchCase: false, wholeWord: false, useRegex: false };

function toggleFindReplaceBar(showReplace) {
  const bar = document.getElementById("find-replace-bar");
  const subRow = document.getElementById("find-replace-row-sub");
  if (!bar) return;

  if (showReplace !== undefined) {
    bar.classList.remove("hidden");
    if (showReplace) {
      if (subRow) subRow.classList.remove("hidden");
      isReplaceVisible = true;
      document.getElementById("replace-input")?.focus();
    } else {
      if (subRow) subRow.classList.add("hidden");
      isReplaceVisible = false;
      document.getElementById("find-input")?.focus();
    }
  } else {
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) {
      document.getElementById("find-input")?.focus();
    }
  }
  performFind();
}

function closeFindReplaceBar() {
  const bar = document.getElementById("find-replace-bar");
  if (bar) bar.classList.add("hidden");
  clearFindHighlights();
  if (isMarkdownMode) {
    markdownInputEl?.focus();
  } else {
    writerViewEl?.focus();
  }
}

function clearFindHighlights() {
  findMatches = [];
  currentMatchIndex = -1;
  const counter = document.getElementById("find-counter");
  if (counter) counter.textContent = "0 of 0";

  updateMarkdownFindHighlights("");

  if (!isMarkdownMode && writerViewEl) {
    const marks = Array.from(writerViewEl.querySelectorAll("mark.find-match, mark"));
    for (const m of marks) {
      const parent = m.parentNode;
      if (parent) {
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
      }
    }
  }
}

function updateMarkdownFindHighlights(query) {
  const backdrop = document.getElementById("markdown-backdrop");
  if (!backdrop) return;

  if (!query || !isMarkdownMode || !markdownInputEl) {
    backdrop.replaceChildren();
    return;
  }

  const regex = buildFindRegex(query);
  if (!regex) {
    backdrop.replaceChildren();
    return;
  }

  const text = markdownInputEl.value;
  if (!text) {
    backdrop.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();
  regex.lastIndex = 0;
  let lastIdx = 0;
  let match;
  let matchIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    if (matchStart > lastIdx) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx, matchStart)));
    }

    const mark = document.createElement("mark");
    mark.className = "find-match" + (matchIdx === currentMatchIndex ? " current-match" : "");
    mark.textContent = match[0];
    frag.appendChild(mark);

    lastIdx = matchEnd;
    matchIdx++;

    if (regex.lastIndex === matchStart) {
      regex.lastIndex++;
    }
  }

  if (lastIdx < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  }

  if (text.endsWith("\n")) {
    frag.appendChild(document.createElement("br"));
  }

  backdrop.replaceChildren(frag);
  backdrop.scrollTop = markdownInputEl.scrollTop;
  backdrop.scrollLeft = markdownInputEl.scrollLeft;
}

function buildFindRegex(query) {
  if (!query) return null;
  let pattern = query;
  if (!findOptions.useRegex) {
    pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (findOptions.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }
  const flags = findOptions.matchCase ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch (_) {
    return null;
  }
}

function performFind() {
  const input = document.getElementById("find-input");
  const counter = document.getElementById("find-counter");
  if (!input || !counter) return;

  const query = input.value;
  clearFindHighlights();
  if (!query) return;

  const active = getActiveFile();
  if (!active || active.isImage) return;

  const regex = buildFindRegex(query);
  if (!regex) {
    counter.textContent = "Invalid regex";
    return;
  }

  if (isMarkdownMode) {
    const text = markdownInputEl ? markdownInputEl.value : "";
    let match;
    findMatches = [];
    while ((match = regex.exec(text)) !== null) {
      findMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex++;
      }
    }
  } else {
    findMatches = findMatchesInWriter(regex);
  }

  if (findMatches.length === 0) {
    counter.textContent = "0 of 0";
    currentMatchIndex = -1;
    return;
  }

  currentMatchIndex = 0;
  counter.textContent = `1 of ${findMatches.length}`;
  highlightCurrentMatch();
}

function findMatchesInWriter(regex) {
  if (!writerViewEl) return [];

  const textNodes = [];
  const walk = document.createTreeWalker(writerViewEl, NodeFilter.SHOW_TEXT, null);
  let n;
  while (n = walk.nextNode()) {
    if (n.parentNode && n.parentNode.nodeName === "MARK" && n.parentNode.classList.contains("find-match")) continue;
    textNodes.push(n);
  }

  const matches = [];

  for (const node of textNodes) {
    const text = node.nodeValue;
    if (!text) continue;

    regex.lastIndex = 0;
    const nodeMatches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      nodeMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex++;
      }
    }

    if (nodeMatches.length === 0) continue;

    let currentTextNode = node;
    for (let i = nodeMatches.length - 1; i >= 0; i--) {
      const m = nodeMatches[i];
      try {
        const afterStartNode = currentTextNode.splitText(m.start);
        const afterMatchNode = afterStartNode.splitText(m.end - m.start);

        const mark = document.createElement("mark");
        mark.className = "find-match";
        afterStartNode.parentNode.replaceChild(mark, afterStartNode);
        mark.appendChild(afterStartNode);

        matches.unshift({
          text: m.text,
          markEl: mark
        });
      } catch (_) {}
    }
  }

  matches.forEach((m, idx) => {
    if (m.markEl) m.markEl.dataset.matchIndex = String(idx);
  });

  return matches;
}

function findNext() {
  if (findMatches.length === 0) {
    performFind();
    return;
  }
  currentMatchIndex = (currentMatchIndex + 1) % findMatches.length;
  const counter = document.getElementById("find-counter");
  if (counter) counter.textContent = `${currentMatchIndex + 1} of ${findMatches.length}`;
  highlightCurrentMatch();
}

function findPrevious() {
  if (findMatches.length === 0) {
    performFind();
    return;
  }
  currentMatchIndex = (currentMatchIndex - 1 + findMatches.length) % findMatches.length;
  const counter = document.getElementById("find-counter");
  if (counter) counter.textContent = `${currentMatchIndex + 1} of ${findMatches.length}`;
  highlightCurrentMatch();
}

function highlightCurrentMatch() {
  if (currentMatchIndex < 0 || currentMatchIndex >= findMatches.length) return;
  const match = findMatches[currentMatchIndex];

  if (isMarkdownMode && markdownInputEl) {
    markdownInputEl.setSelectionRange(match.start, match.end);
    const fullText = markdownInputEl.value;
    const linesBefore = fullText.slice(0, match.start).split("\n").length;
    const lineHeight = 20;
    markdownInputEl.scrollTop = Math.max(0, (linesBefore - 3) * lineHeight);
    const query = document.getElementById("find-input")?.value;
    updateMarkdownFindHighlights(query);
  } else {
    highlightWriterMatches();
  }
}

function highlightWriterMatches() {
  if (!writerViewEl) return;
  const marks = Array.from(writerViewEl.querySelectorAll("mark.find-match"));
  marks.forEach(m => m.classList.remove("current-match"));

  if (findMatches.length === 0 || currentMatchIndex < 0) return;
  const targetMatch = findMatches[currentMatchIndex];
  if (targetMatch && targetMatch.markEl) {
    targetMatch.markEl.classList.add("current-match");
    targetMatch.markEl.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    const mark = writerViewEl.querySelector(`mark.find-match[data-match-index="${currentMatchIndex}"]`);
    if (mark) {
      mark.classList.add("current-match");
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

async function replaceCurrent() {
  if (findMatches.length === 0 || currentMatchIndex < 0) {
    performFind();
    if (findMatches.length === 0) return;
  }
  const replaceInput = document.getElementById("replace-input");
  const replaceText = replaceInput ? replaceInput.value : "";
  const match = findMatches[currentMatchIndex];

  clearFindHighlights();
  const fullText = getCurrentMarkdown();
  const updatedText = fullText.slice(0, match.start) + replaceText + fullText.slice(match.end);

  await applyDocumentText(updatedText);
  setDirty(true);
  performFind();
}

async function replaceAll() {
  const findInput = document.getElementById("find-input");
  const replaceInput = document.getElementById("replace-input");
  if (!findInput || !findInput.value) return;

  const query = findInput.value;
  const replaceText = replaceInput ? replaceInput.value : "";
  const regex = buildFindRegex(query);
  if (!regex) return;

  clearFindHighlights();
  const fullText = getCurrentMarkdown();
  let count = 0;
  const updatedText = fullText.replace(regex, () => {
    count++;
    return replaceText;
  });

  if (count > 0) {
    await applyDocumentText(updatedText);
    setDirty(true);
    statusMessageEl.textContent = `Replaced ${count} occurrence(s).`;
  } else {
    statusMessageEl.textContent = "No occurrences found to replace.";
  }
  clearFindHighlights();
}

async function applyDocumentText(text) {
  const f = getActiveFile();
  if (f) {
    f.content = text;
    pushHistory(f, text);
  }
  if (isMarkdownMode) {
    if (markdownInputEl) {
      markdownInputEl.value = text;
      updateStats(text);
    }
  } else {
    await renderMarkdownToWriter(text);
    updateStats(text);
  }
}

// ─── Bind Find & Replace Listeners ───────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const findInput = document.getElementById("find-input");
  if (findInput) {
    findInput.addEventListener("input", performFind);
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) findPrevious();
        else findNext();
      } else if (e.key === "Tab" || e.keyCode === 9 || e.code === "Tab") {
        if (!e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const subRow = document.getElementById("find-replace-row-sub");
          if (subRow) {
            subRow.classList.remove("hidden");
            isReplaceVisible = true;
          }
          const replaceInput = document.getElementById("replace-input");
          if (replaceInput) {
            setTimeout(() => {
              replaceInput.focus();
              replaceInput.select();
            }, 0);
          }
        }
      } else if (e.key === "Escape") {
        closeFindReplaceBar();
      }
    });
  }

  const replaceInput = document.getElementById("replace-input");
  if (replaceInput) {
    replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        replaceCurrent();
      } else if (e.key === "Tab" || e.keyCode === 9 || e.code === "Tab") {
        if (e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const findInput = document.getElementById("find-input");
          if (findInput) {
            setTimeout(() => {
              findInput.focus();
              findInput.select();
            }, 0);
          }
        }
      } else if (e.key === "Escape") {
        closeFindReplaceBar();
      }
    });
  }

  document.getElementById("find-prev-btn")?.addEventListener("click", findPrevious);
  document.getElementById("find-next-btn")?.addEventListener("click", findNext);

  document.getElementById("find-opt-case")?.addEventListener("click", (e) => {
    findOptions.matchCase = !findOptions.matchCase;
    e.currentTarget.classList.toggle("active", findOptions.matchCase);
    performFind();
  });

  document.getElementById("find-opt-word")?.addEventListener("click", (e) => {
    findOptions.wholeWord = !findOptions.wholeWord;
    e.currentTarget.classList.toggle("active", findOptions.wholeWord);
    performFind();
  });

  document.getElementById("find-opt-regex")?.addEventListener("click", (e) => {
    findOptions.useRegex = !findOptions.useRegex;
    e.currentTarget.classList.toggle("active", findOptions.useRegex);
    performFind();
  });

  document.getElementById("find-toggle-replace-btn")?.addEventListener("click", () => {
    const subRow = document.getElementById("find-replace-row-sub");
    if (subRow) {
      subRow.classList.toggle("hidden");
      isReplaceVisible = !subRow.classList.contains("hidden");
      if (isReplaceVisible) document.getElementById("replace-input")?.focus();
    }
  });

  document.getElementById("find-close-btn")?.addEventListener("click", closeFindReplaceBar);
  document.getElementById("replace-btn")?.addEventListener("click", replaceCurrent);
  document.getElementById("replace-all-btn")?.addEventListener("click", replaceAll);

  // TUI Edit Menu Items
  document.getElementById("tui-edit-find-btn")?.addEventListener("click", () => toggleFindReplaceBar(false));
  document.getElementById("tui-edit-replace-btn")?.addEventListener("click", () => toggleFindReplaceBar(true));
  document.getElementById("tui-edit-replace-all-btn")?.addEventListener("click", () => {
    toggleFindReplaceBar(true);
    replaceAll();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// MOBILE / ANDROID MODULE
// Handles: sidebar drawer, bottom tab bar, virtual keyboard, file I/O routing
// ═══════════════════════════════════════════════════════════════════════════════

// ── Platform detection ────────────────────────────────────────────────────────
// `platform` is set early in DOMContentLoaded via `get_platform` invoke.
// We also check pointer type for responsive layout decisions.
const isTouchDevice = () =>
  window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

function isAndroid() {
  return platform === "android";
}

// ── Sidebar drawer (mobile) ───────────────────────────────────────────────────
function openSidebarDrawer() {
  const sidebar  = document.getElementById("sidebar");
  const overlay  = document.getElementById("sidebar-overlay");
  const toggle   = document.getElementById("mobile-sidebar-toggle");
  sidebar?.classList.add("open");
  overlay?.classList.add("visible");
  toggle?.setAttribute("aria-expanded", "true");
}

function closeSidebarDrawer() {
  const sidebar  = document.getElementById("sidebar");
  const overlay  = document.getElementById("sidebar-overlay");
  const toggle   = document.getElementById("mobile-sidebar-toggle");
  sidebar?.classList.remove("open");
  overlay?.classList.remove("visible");
  toggle?.setAttribute("aria-expanded", "false");
}

// ── Bottom tab bar mode switching ─────────────────────────────────────────────
function updateMobileTabBar(mode) {
  document.getElementById("mobile-tab-writer")?.classList.toggle("active",   mode === "writer");
  document.getElementById("mobile-tab-markdown")?.classList.toggle("active", mode === "markdown");
  document.getElementById("mobile-tab-files")?.classList.toggle("active",    mode === "files");

  document.getElementById("mobile-tab-writer")?.setAttribute("aria-pressed",   String(mode === "writer"));
  document.getElementById("mobile-tab-markdown")?.setAttribute("aria-pressed", String(mode === "markdown"));
  document.getElementById("mobile-tab-files")?.setAttribute("aria-pressed",    String(mode === "files"));
}

// ── Touch swipe gesture for sidebar ──────────────────────────────────────────
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;

  document.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    if (!isTouchDevice()) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    // Only register horizontal swipes (more horizontal than vertical)
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (Math.abs(dx) < 50) return; // minimum swipe distance

    const sidebar = document.getElementById("sidebar");
    if (dx > 0 && touchStartX < 40) {
      // Swipe right from left edge → open drawer
      openSidebarDrawer();
    } else if (dx < 0 && sidebar?.classList.contains("open")) {
      // Swipe left with drawer open → close drawer
      closeSidebarDrawer();
    }
  }, { passive: true });
})();

// ── Virtual keyboard handling ─────────────────────────────────────────────────
// Android's soft keyboard reduces the visual viewport height. We use the
// VisualViewport API (where available) to track this and adjust editor height.
(function initVirtualKeyboardHandler() {
  if (!window.visualViewport) return;

  const editorArea = document.getElementById("editor-area");
  if (!editorArea) return;

  let lastViewportHeight = window.visualViewport.height;

  window.visualViewport.addEventListener("resize", () => {
    if (!isTouchDevice()) return;
    const newHeight = window.visualViewport.height;
    const delta = lastViewportHeight - newHeight;
    lastViewportHeight = newHeight;

    if (delta > 100) {
      // Keyboard appeared — shrink editor to keep it visible
      editorArea.style.maxHeight = `${newHeight - 110}px`;
    } else if (delta < -50) {
      // Keyboard dismissed — restore full height
      editorArea.style.maxHeight = "";
    }
  });
})();

// ── Android / Mobile file I/O routing ────────────────────────────────────────
// Override openFile and saveFile for Android to use the Storage Access Framework
// (via tauri-plugin-dialog) instead of the desktop rfd dialogs.

const _originalOpenFile = openFile;
const _originalSaveFileAs = saveFileAs;

openFile = async function() {
  if (!isAndroid()) {
    return _originalOpenFile.apply(this, arguments);
  }

  // Android: use tauri-plugin-dialog for SAF file picker
  try {
    statusMessageEl.textContent = "Opening…";
    const result = await invoke("plugin:dialog|open", {
      multiple: false,
      filters: [{ name: "Text & Markdown", extensions: ["md", "markdown", "txt", "json", "yaml", "yml", "rs", "py", "js", "ts", "html", "css"] }],
    });

    if (result) {
      const path = typeof result === "string" ? result : result[0];
      const fileData = await invoke("read_file", { path });
      await applyOpenedFile(fileData);
      statusMessageEl.textContent = `Opened: ${fileData.name}`;
    } else {
      statusMessageEl.textContent = "Ready";
    }
  } catch (e) {
    console.error("Android open error:", e);
    statusMessageEl.textContent = "Error opening file";
  }
};

saveFileAs = async function(silent = false) {
  if (!isAndroid()) {
    return _originalSaveFileAs.call(this, silent);
  }

  // Android: use tauri-plugin-dialog SAF save picker
  syncActiveFileContent();
  let f = getActiveFile();
  const content = f ? f.content : getCurrentMarkdown();

  try {
    const savedPath = await invoke("plugin:dialog|save", {
      defaultPath: f?.name || "untitled.md",
      filters: [{ name: "Markdown", extensions: ["md", "txt"] }],
    });

    if (savedPath) {
      await invoke("save_file", { path: savedPath, content });
      if (f) {
        f.path = savedPath;
        f.id = savedPath;
        activeFileId = savedPath;
        f.name = savedPath.split(/[/\\]/).pop();
        f.dirty = false;
        addToRecentFiles(savedPath, f.name);
        renderTabBar(); renderFileList();
      }
      if (!silent) statusMessageEl.textContent = `Saved: ${savedPath.split(/[/\\]/).pop()}`;
    } else {
      if (!silent) statusMessageEl.textContent = "Save cancelled.";
    }
  } catch (e) {
    console.error("Android save error:", e);
    if (!silent) statusMessageEl.textContent = "Error saving file";
  }
}

// ── Wire up mobile UI on DOMContentLoaded ────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Hamburger toggle
  document.getElementById("mobile-sidebar-toggle")?.addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    if (sidebar?.classList.contains("open")) {
      closeSidebarDrawer();
    } else {
      openSidebarDrawer();
    }
  });

  // Overlay tap closes drawer
  document.getElementById("sidebar-overlay")?.addEventListener("click", closeSidebarDrawer);

  // Close drawer when a file item is tapped on mobile
  document.getElementById("file-list")?.addEventListener("click", () => {
    if (isTouchDevice()) setTimeout(closeSidebarDrawer, 80);
  });
  document.getElementById("nc-file-list")?.addEventListener("click", () => {
    if (isTouchDevice()) setTimeout(closeSidebarDrawer, 80);
  });

  // Bottom tab bar — Writer
  document.getElementById("mobile-tab-writer")?.addEventListener("click", () => {
    if (!isMarkdownMode) return; // already in writer mode
    toggleMode(); // existing toggle function switches between writer/markdown
    updateMobileTabBar("writer");
  });

  // Bottom tab bar — Markdown
  document.getElementById("mobile-tab-markdown")?.addEventListener("click", () => {
    if (isMarkdownMode) return; // already in markdown mode
    toggleMode();
    updateMobileTabBar("markdown");
  });

  // Bottom tab bar — Files (opens sidebar drawer)
  document.getElementById("mobile-tab-files")?.addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    if (sidebar?.classList.contains("open")) {
      closeSidebarDrawer();
      updateMobileTabBar(isMarkdownMode ? "markdown" : "writer");
    } else {
      openSidebarDrawer();
      updateMobileTabBar("files");
    }
  });

  // Keep bottom tab bar in sync when mode changes via desktop mode buttons
  document.getElementById("mode-writer-btn")?.addEventListener("click", () => updateMobileTabBar("writer"));
  document.getElementById("mode-markdown-btn")?.addEventListener("click", () => updateMobileTabBar("markdown"));

  // Prevent toolbar from losing keyboard focus on mobile when tapping buttons
  // (touch-and-hold on Android can trigger contextmenu)
  document.getElementById("toolbar")?.addEventListener("contextmenu", (e) => {
    if (isTouchDevice()) e.preventDefault();
  });
});
