import re

with open("src/main.js", "r") as f:
    content = f.read()

# 1. State changes
content = content.replace(
"""let currentFilePath = null;
let currentFileDir  = null;
let platform = "linux";
let isDirty = false;
let autoSaveTimer = null;""",
"""let openFiles = [];
let activeFileId = null;
let untitledCounter = 1;

function getActiveFile() { return openFiles.find(f => f.id === activeFileId); }
function getActiveFilePath() { const f = getActiveFile(); return f ? f.path : null; }
function getCurrentFileDir() { const p = getActiveFilePath(); return p ? p.replace(/[\\/\\\\][^\\/\\\\]+$/, "") : null; }

let platform = "linux";
let autoSaveTimer = null;"""
)

content = content.replace("currentFileDir", "getCurrentFileDir()")

# 2. setDirty
content = content.replace(
"""function setDirty(dirty) {
  isDirty = dirty;
  const btn = document.getElementById("save-file-btn");
  if (!btn) return;
  if (dirty) {
    btn.classList.add("dirty");
    btn.title = "Unsaved changes – Save (Ctrl+S)";
  } else {
    btn.classList.remove("dirty");
    btn.title = "Save File (Ctrl+S)";
  }
}""",
"""function setDirty(dirty) {
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
}"""
)

# 3. autoSave
content = content.replace(
"""function startAutoSave(intervalMinutes) {
  clearInterval(autoSaveTimer);
  if (intervalMinutes > 0) {
    autoSaveTimer = setInterval(() => {
      if (isDirty && currentFilePath) {
        saveFile(true);
      }
    }, intervalMinutes * 60 * 1000);
  }
}""",
"""function startAutoSave(intervalMinutes) {
  clearInterval(autoSaveTimer);
  if (intervalMinutes > 0) {
    autoSaveTimer = setInterval(async () => {
      for (const f of openFiles) {
        if (f.dirty) {
          if (f.path) {
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
}"""
)

# 4. loadSettings default value
content = content.replace(
"""const autoSaveMinutes = settings.autoSaveMinutes ?? 0;""",
"""const autoSaveMinutes = settings.autoSaveMinutes ?? 5;"""
)

# 5. renderFileList & openRecentFile
content = re.sub(
r"function renderFileList\(\) \{.*?(?=function openRecentFile)",
"""
async function renameSidebarFile(e, path) {
  e.stopPropagation();
  const newName = prompt("Enter new filename (including extension):");
  if (!newName) return;
  const newPath = path.replace(/[\\/\\\\][^\\/\\\\]+$/, "/" + newName);
  try {
    await invoke("rename_file", { old_path: path, new_path: newPath });
    let recent = loadRecentFiles();
    const idx = recent.findIndex(f => f.path === path);
    if (idx !== -1) {
       recent[idx].path = newPath;
       recent[idx].name = newName;
       saveRecentFiles(recent);
    }
    renderFileList();
  } catch(err) { alert("Rename failed: " + err); }
}

async function deleteSidebarFile(e, path) {
  e.stopPropagation();
  if (!confirm("Are you sure you want to delete this file?")) return;
  try {
    await invoke("delete_file", { path: path });
    removeFromRecentFiles(path);
  } catch(err) { alert("Delete failed: " + err); }
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

""", content, flags=re.DOTALL)

# 6. Tab functions
tab_functions = """
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

async function switchTab(id) {
  if (activeFileId === id) return;
  syncActiveFileContent();
  activeFileId = id;
  const f = getActiveFile();
  if (f) {
    if (isMarkdownMode) {
       markdownInputEl.value = f.content;
       updateStats(f.content);
    } else {
       await renderMarkdownToWriter(f.content);
       updateStats(f.content);
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
}

async function closeTab(id) {
  const f = openFiles.find(x => x.id === id);
  if (f && f.dirty) {
    if (!confirm(`Discard unsaved changes to ${f.name}?`)) {
       return;
    }
  }
  const idx = openFiles.findIndex(x => x.id === id);
  if (idx !== -1) {
    openFiles.splice(idx, 1);
    if (openFiles.length === 0) {
      newFile();
    } else if (activeFileId === id) {
      const nextId = openFiles[Math.min(idx, openFiles.length - 1)].id;
      await switchTab(nextId);
    } else {
      renderTabBar();
      renderFileList();
    }
  }
}

"""
content = content.replace("function getCurrentMarkdown() {", tab_functions + "\nfunction getCurrentMarkdown() {")

# 7. applyOpenedFile, openFile, saveFile, newFile, setupCloseHandler
file_ops = """
async function applyOpenedFile(fileData) {
  const existing = openFiles.find(f => f.path === fileData.path);
  if (existing) {
     await switchTab(existing.id);
     return;
  }
  syncActiveFileContent();
  const newFile = {
     id: fileData.path,
     path: fileData.path,
     name: fileData.name,
     content: fileData.content,
     dirty: false
  };
  openFiles.push(newFile);
  activeFileId = newFile.id;
  
  markdownInputEl.value = fileData.content;
  addToRecentFiles(fileData.path, fileData.name);
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

async function saveFile(silent = false) {
  syncActiveFileContent();
  const f = getActiveFile();
  if (!f) return;
  const content = f.content;
  try {
    if (f.path) {
      await invoke("save_file", { path: f.path, content });
      f.dirty = false;
      renderTabBar(); renderFileList();
      if (!silent) statusMessageEl.textContent = "Saved.";
    } else {
      if (!silent) statusMessageEl.textContent = "Saving…";
      const savedPath = await invoke("save_file_dialog", { content });
      if (savedPath) {
        f.path = savedPath;
        f.id = savedPath;
        activeFileId = savedPath;
        f.name = savedPath.split(/[\\/\\\\]/).pop();
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

async function setupCloseHandler() {
  try {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow();
    if (!appWindow) return;

    await appWindow.onCloseRequested(async (event) => {
      syncActiveFileContent();
      const unsaved = openFiles.filter(f => f.dirty);
      if (unsaved.length === 0) return;
      
      event.preventDefault();
      
      for (const f of unsaved) {
         if (f.path) {
            await invoke("save_file", { path: f.path, content: f.content });
         } else {
            statusMessageEl.textContent = "Saving " + f.name + " before exit…";
            const savedPath = await invoke("save_file_dialog", { content: f.content });
            if (savedPath) {
               f.path = savedPath;
            }
         }
      }
      await appWindow.close();
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
  updateStats("");
  setDirty(false);
  renderTabBar();
  renderFileList();
  statusMessageEl.textContent = "New file";
  if (!isMarkdownMode) writerViewEl.focus();
  else markdownInputEl.focus();
}
"""
content = re.sub(r"async function applyOpenedFile\(fileData\).*?function handleKeydown\(e\)", file_ops + "\n// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────\nfunction handleKeydown(e)", content, flags=re.DOTALL)

with open("src/main.js", "w") as f:
    f.write(content)

