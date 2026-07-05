const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, dialog, Menu, session, clipboard } = require('electron');
const unzip = require('unzip-crx-3');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow;
const views = new Map(); // id -> BrowserView
const tabData = new Map(); // id -> { url, title, lastActiveTime, suspended }
let activeViewId = null;

// Set a standard Chrome User-Agent to bypass Google/Cloudflare bot protection
app.userAgentFallback = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let appSettings = { idleTimeout: 5, adblockerEnabled: true, bookmarks: [] };
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
  }
} catch (e) {}

const PERMISSIONS_FILE = path.join(app.getPath('userData'), 'permissions.json');
let permissionsData = {};
try {
  if (fs.existsSync(PERMISSIONS_FILE)) {
    permissionsData = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'));
  }
} catch (e) {}

function savePermissions() {
  fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(permissionsData, null, 2));
}

function saveAppSettings(newSettings) {
  appSettings = { ...appSettings, ...newSettings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
  updateActiveViewBounds();
}

const HISTORY_FILE = path.join(app.getPath('userData'), 'history.json');
let historyData = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    historyData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  }
} catch (e) {}

function saveHistory(url, title, isIncognito) {
  if (isIncognito || url.startsWith('internal://') || url.startsWith('devtools://') || url.startsWith('chrome-extension://')) return;
  historyData.unshift({ url, title: title || url, timestamp: Date.now() });
  if (historyData.length > 1000) historyData = historyData.slice(0, 1000);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyData));
}

const HIGHLIGHTS_FILE = path.join(app.getPath('userData'), 'highlights.json');
let highlightsData = {};
try {
  if (fs.existsSync(HIGHLIGHTS_FILE)) {
    highlightsData = JSON.parse(fs.readFileSync(HIGHLIGHTS_FILE, 'utf-8'));
  }
} catch (e) {}

const PASSWORDS_FILE = path.join(app.getPath('userData'), 'passwords.json');
let passwordsData = [];
try {
  if (fs.existsSync(PASSWORDS_FILE)) {
    passwordsData = JSON.parse(fs.readFileSync(PASSWORDS_FILE, 'utf-8'));
  }
} catch (e) {}

function savePasswords() {
  fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(passwordsData));
}

ipcMain.handle('get-passwords', () => passwordsData);
ipcMain.on('delete-password', (e, index) => {
  passwordsData.splice(index, 1);
  savePasswords();
});

ipcMain.handle('import-passwords-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (canceled || filePaths.length === 0) return { success: false };
  try {
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const lines = content.split(/\r?\n/);
    let imported = 0;
    
    // Chrome format: name,url,username,password
    // Find column indexes from header
    const header = lines[0].toLowerCase().split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.replace(/(^"|"$)/g, ''));
    const urlIdx = header.findIndex(h => h.includes('url'));
    const userIdx = header.findIndex(h => h.includes('username') || h === 'user');
    const passIdx = header.findIndex(h => h.includes('password') || h === 'pass');
    
    if (urlIdx === -1 || userIdx === -1 || passIdx === -1) {
       return { success: false, error: 'CSV 格式不正確，找不到 url/username/password 欄位' };
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const matches = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.replace(/(^"|"$)/g, ''));
      if (matches.length > Math.max(urlIdx, userIdx, passIdx)) {
        passwordsData.push({
          url: matches[urlIdx],
          username: matches[userIdx],
          password: matches[passIdx]
        });
        imported++;
      }
    }
    savePasswords();
    return { success: true, count: imported };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

function migrateHighlightsData() {
  let changed = false;
  for (let key in highlightsData) {
    highlightsData[key] = highlightsData[key].map(item => {
      if (typeof item === 'string') {
        changed = true;
        return { text: item, color: 'yellow' };
      }
      return item;
    });
  }
  if (changed) fs.writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(highlightsData));
}
migrateHighlightsData();

function saveHighlightData(url, text, color = 'yellow') {
  try {
    const parsed = new URL(url);
    const key = parsed.hostname + parsed.pathname;
    if (!highlightsData[key]) highlightsData[key] = [];
    const existing = highlightsData[key].find(h => h.text === text);
    if (!existing) {
      highlightsData[key].push({ text, color });
      fs.writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(highlightsData));
    } else if (existing.color !== color) {
      existing.color = color;
      fs.writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(highlightsData));
    }
  } catch (e) {}
}

ipcMain.on('delete-highlight', (e, { url, text }) => {
  try {
    if (highlightsData[url]) {
      highlightsData[url] = highlightsData[url].filter(t => t.text !== text);
      if (highlightsData[url].length === 0) delete highlightsData[url];
      fs.writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(highlightsData));
    }
  } catch (e) {}
});

ipcMain.on('save-highlight-from-view', (e, { url, text, color }) => {
  saveHighlightData(url, text, color);
  if (activeViewId && views.has(activeViewId)) {
    views.get(activeViewId).webContents.executeJavaScript(getApplyHighlightScript(text, color)).catch(() => {});
  }
});

ipcMain.on('delete-highlight-from-view', (e, { url, text }) => {
  try {
    const parsed = new URL(url);
    const key = parsed.hostname + parsed.pathname;
    let hasChanges = false;

    if (highlightsData[key]) {
      let newHighlights = [];
      highlightsData[key].forEach(t => {
        if (t.text === text) {
          hasChanges = true;
        } else if (t.text.includes(text)) {
          hasChanges = true;
          const parts = t.text.split(text);
          parts.forEach(p => {
             const trimmed = p.trim();
             if (trimmed.length > 0) newHighlights.push({ text: trimmed, color: t.color });
          });
        } else if (text.includes(t.text)) {
          hasChanges = true;
        } else {
          newHighlights.push(t);
        }
      });
      highlightsData[key] = newHighlights;
      if (highlightsData[key].length === 0) delete highlightsData[key];
      if (hasChanges) fs.writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(highlightsData));
    }

    if (activeViewId && views.has(activeViewId) && hasChanges) {
      views.get(activeViewId).webContents.executeJavaScript(`
        if (window.customHighlights) {
           for (const color in window.customHighlights) {
             window.customHighlights[color].clear();
             CSS.highlights.delete('my-highlight-' + color.replace('#', ''));
           }
        }
      `).then(() => {
         const remaining = highlightsData[key] || [];
         if (remaining.length > 0) {
            views.get(activeViewId).webContents.executeJavaScript(getRestoreHighlightsScript(remaining)).catch(()=>{});
         }
      }).catch(() => {});
    }
  } catch (e) {}
});

ipcMain.on('translate-text-from-view', (e, { text }) => {
  const translateUrl = `https://translate.google.com/?sl=auto&tl=zh-TW&text=${encodeURIComponent(text)}&op=translate`;
  mainWindow.webContents.send('open-new-tab', translateUrl);
});

ipcMain.on('get-pinned-colors', (e) => {
  e.returnValue = appSettings.pinnedColors || ['#f9e2af', '#f38ba8', '#89b4fa'];
});

ipcMain.on('add-pinned-color', (e, hex) => {
  let colors = appSettings.pinnedColors || ['#f9e2af', '#f38ba8', '#89b4fa'];
  if (!colors.includes(hex)) {
    colors.push(hex);
    if (colors.length > 6) colors.shift(); // Keep only last 6 colors
    saveAppSettings({ pinnedColors: colors });
  }
});

function getHighlights(url) {
  try {
    const parsed = new URL(url);
    const key = parsed.hostname + parsed.pathname;
    return highlightsData[key] || [];
  } catch (e) {
    return [];
  }
}

const injectHighlightCSS = `
  if (!document.getElementById('custom-highlight-style')) {
    const style = document.createElement('style');
    style.id = 'custom-highlight-style';
    style.textContent = \`
      ::highlight(my-highlight-yellow) { background-color: rgba(249, 226, 175, 0.5); border-bottom: 2px solid #f9e2af; color: black; }
      ::highlight(my-highlight-red) { background-color: rgba(243, 139, 168, 0.5); border-bottom: 2px solid #f38ba8; color: black; }
      ::highlight(my-highlight-blue) { background-color: rgba(137, 180, 250, 0.5); border-bottom: 2px solid #89b4fa; color: black; }
    \`;
    document.head.appendChild(style);
  }
`;

function getApplyHighlightScript(text, color = 'yellow') {
  return `(function() {
    ${injectHighlightCSS}
    const color = '${color}';
    let safeColorName = color.replace('#', '');
    const highlightName = 'my-highlight-' + safeColorName;
    
    // Inject dynamic CSS if it's a hex code and doesn't exist
    if (color.startsWith('#')) {
      const dynamicStyleId = 'custom-highlight-style-' + safeColorName;
      if (!document.getElementById(dynamicStyleId)) {
        const style = document.createElement('style');
        style.id = dynamicStyleId;
        style.textContent = \`::highlight(\${highlightName}) { background-color: \${color}80; border-bottom: 2px solid \${color}; color: black; }\`;
        document.head.appendChild(style);
      }
    }

    if (!window.customHighlights) window.customHighlights = {};
    if (!window.customHighlights[color]) window.customHighlights[color] = new Set();
    window.customHighlights[color].add(${JSON.stringify(text)});
    const ranges = [];
    window.customHighlights[color].forEach(t => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        let startIndex = 0, index;
        while ((index = node.textContent.indexOf(t, startIndex)) >= 0) {
          const range = new Range();
          range.setStart(node, index);
          range.setEnd(node, index + t.length);
          ranges.push(range);
          startIndex = index + t.length;
        }
      }
    });
    CSS.highlights.set(highlightName, new Highlight(...ranges));
  })();`;
}

function getRestoreHighlightsScript(highlights) {
  return `(function() {
    ${injectHighlightCSS}
    if (!window.customHighlights) window.customHighlights = {};
    const items = ${JSON.stringify(highlights)};
    items.forEach(item => {
      if (!window.customHighlights[item.color]) window.customHighlights[item.color] = new Set();
      window.customHighlights[item.color].add(item.text);
      
      // Inject dynamic CSS for hex colors
      if (item.color.startsWith('#')) {
        let safeColorName = item.color.replace('#', '');
        const dynamicStyleId = 'custom-highlight-style-' + safeColorName;
        if (!document.getElementById(dynamicStyleId)) {
          const style = document.createElement('style');
          style.id = dynamicStyleId;
          const highlightName = 'my-highlight-' + safeColorName;
          style.textContent = \`::highlight(\${highlightName}) { background-color: \${item.color}80; border-bottom: 2px solid \${item.color}; color: black; }\`;
          document.head.appendChild(style);
        }
      }
    });
    
    for (const color in window.customHighlights) {
      const ranges = [];
      let safeColorName = color.replace('#', '');
      const highlightName = 'my-highlight-' + safeColorName;
      window.customHighlights[color].forEach(t => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          let startIndex = 0, index;
          while ((index = node.textContent.indexOf(t, startIndex)) >= 0) {
            const range = new Range();
            range.setStart(node, index);
            range.setEnd(node, index + t.length);
            ranges.push(range);
            startIndex = index + t.length;
          }
        }
      });
      if (ranges.length > 0) CSS.highlights.set(highlightName, new Highlight(...ranges));
    }
  })();`;
}

const toggleFocusModeScript = `(function() {
  if (document.body.classList.contains('focus-mode')) {
    document.body.classList.remove('focus-mode');
    const style = document.getElementById('focus-mode-style');
    if (style) style.remove();
  } else {
    document.body.classList.add('focus-mode');
    const style = document.createElement('style');
    style.id = 'focus-mode-style';
    style.textContent = \`
      body.focus-mode aside, body.focus-mode nav, body.focus-mode header, 
      body.focus-mode footer, body.focus-mode .sidebar, body.focus-mode .ad, body.focus-mode iframe { display: none !important; }
      body.focus-mode { max-width: 800px !important; margin: 0 auto !important; font-size: 110% !important; }
    \`;
    document.head.appendChild(style);
  }
})();`;

// Memory Optimization Check
setInterval(() => {
  const now = Date.now();
  const timeoutMs = (appSettings.idleTimeout || 5) * 60 * 1000;
  for (const [id, view] of views.entries()) {
    const data = tabData.get(id);
    if (id !== activeViewId && data && !data.focused && !view.webContents.isCurrentlyAudible()) {
      if (now - data.lastActiveTime > timeoutMs) {
        console.log(`Suspending tab ${id} to save memory`);
        mainWindow.removeBrowserView(view);
        view.webContents.destroy();
        views.delete(id);
        data.suspended = true;
        if (mainWindow) {
          mainWindow.webContents.send('tab-updated', { id, suspended: true });
        }
      }
    }
  }
}, 30000); // Check every 30s

function updateActiveViewBounds() {
  if (activeViewId && views.has(activeViewId) && mainWindow) {
    const view = views.get(activeViewId);
    const bounds = mainWindow.getContentBounds();
    const TOP_OFFSET = 78 + ((appSettings.bookmarks && appSettings.bookmarks.length > 0) ? 33 : 0);
    // In Windows, if maximized, bounds might include borders. Electron handles this, but usually getBounds is fine.
    view.setBounds({ x: 0, y: TOP_OFFSET, width: bounds.width, height: Math.max(0, bounds.height - TOP_OFFSET) });
  }
}

function setVisibleBrowserView(view) {
  if (!mainWindow) return;
  const currentViews = mainWindow.getBrowserViews();
  for (const v of currentViews) {
    if (v !== view) mainWindow.removeBrowserView(v);
  }
  if (view) {
    if (!currentViews.includes(view)) {
      mainWindow.addBrowserView(view);
    }
    mainWindow.setTopBrowserView(view);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false, // Frameless window
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  const isDev = !app.isPackaged;

  function loadDevServer() {
    mainWindow.loadURL('http://localhost:3000').catch(err => {
      console.log('Vite not ready, retrying in 1s...');
      setTimeout(loadDevServer, 1000);
    });
  }

  if (isDev) {
    loadDevServer();
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message} (${sourceId}:${line})`);
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.on('resize', updateActiveViewBounds);
  mainWindow.on('maximize', updateActiveViewBounds);
  mainWindow.on('unmaximize', updateActiveViewBounds);

  // Window controls IPC
  ipcMain.on('window-minimize', () => mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on('window-close', () => mainWindow.close());
  
  ipcMain.on('create-tab', (event, { id, url, isIncognito }) => {
    tabData.set(id, { url, title: url === 'internal://settings' ? '設定' : 'Loading...', lastActiveTime: Date.now(), suspended: false, focused: false, isIncognito });
    
    if (url === 'internal://settings') {
      activeViewId = id;
      setVisibleBrowserView(null);
      mainWindow.webContents.send('tab-updated', { id, title: '設定', url });
    } else {
      createBrowserViewForTab(id, url, isIncognito);
    }
  });

  function createBrowserViewForTab(id, initialUrl, isIncognito = false) {
    const webPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'browserview-preload.js'),
    };
    if (isIncognito) {
      webPreferences.session = session.fromPartition('in-memory', { cache: false });
    }
    const view = new BrowserView({ webPreferences });

    views.set(id, view);
    setVisibleBrowserView(view);
    activeViewId = id;
    updateActiveViewBounds();

    view.webContents.loadURL(initialUrl);

    view.webContents.on('page-title-updated', (e, title) => {
      if (tabData.has(id)) tabData.get(id).title = title;
      mainWindow.webContents.send('tab-updated', { id, title, url: view.webContents.getURL() });
    });

    view.webContents.on('did-navigate', (e, url) => {
      if (tabData.has(id)) {
         tabData.get(id).url = url;
         saveHistory(url, view.webContents.getTitle(), tabData.get(id).isIncognito);
      }
      mainWindow.webContents.send('tab-updated', { id, title: view.webContents.getTitle(), url });
    });

    view.webContents.on('did-navigate-in-page', (e, url) => {
      if (tabData.has(id)) {
         tabData.get(id).url = url;
         saveHistory(url, view.webContents.getTitle(), tabData.get(id).isIncognito);
      }
      mainWindow.webContents.send('tab-updated', { id, title: view.webContents.getTitle(), url });
    });

    view.webContents.on('page-favicon-updated', (e, favicons) => {
      if (favicons && favicons.length > 0) {
        if (tabData.has(id)) tabData.get(id).favicon = favicons[0];
        mainWindow.webContents.send('tab-favicon-updated', { id, favicon: favicons[0] });
      }
    });

    view.webContents.on('did-finish-load', () => {
      const url = view.webContents.getURL();
      const savedTexts = getHighlights(url);
      if (savedTexts.length > 0) {
        view.webContents.executeJavaScript(getRestoreHighlightsScript(savedTexts)).catch(() => {});
      }

      try {
        const parsedUrl = new URL(url);
        const domain = parsedUrl.hostname;
        const matchingPasswords = passwordsData.filter(p => {
          try { return new URL(p.url).hostname === domain; } 
          catch(e) { return p.url.includes(domain); }
        });
        
        if (matchingPasswords.length > 0) {
          const p = matchingPasswords[0];
          view.webContents.executeJavaScript(`
            (function() {
              if (document.getElementById('custom-browser-autofill-prompt')) return;
              
              const passInputs = document.querySelectorAll('input[type="password"]');
              if (passInputs.length === 0) return;

              const host = document.createElement('div');
              host.id = 'custom-browser-autofill-prompt';
              host.style.position = 'fixed';
              host.style.top = '20px';
              host.style.right = '20px';
              host.style.zIndex = '2147483647';
              document.body.appendChild(host);

              const shadow = host.attachShadow({ mode: 'closed' });

              const banner = document.createElement('div');
              banner.style.cssText = 'background: #1e1e2e; color: white; padding: 10px 15px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 10px; font-family: sans-serif; border: 1px solid #444;';
              
              const text = document.createElement('span');
              text.style.display = 'flex';
              text.style.alignItems = 'center';
              text.style.gap = '6px';
              text.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 發現可用密碼 (' + p.username.replace(/'/g, "\\'") + ')';
              banner.appendChild(text);

              const btn = document.createElement('button');
              btn.textContent = '自動填入';
              btn.style.cssText = 'background: #89b4fa; color: #111; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-weight: bold;';
              btn.onclick = () => {
                 const passInputs = document.querySelectorAll('input[type="password"]');
                 if (passInputs.length > 0) {
                   const passInput = passInputs[0];
                   passInput.value = ${JSON.stringify(p.password)};
                   passInput.dispatchEvent(new Event('input', { bubbles: true }));
                   
                   const textInputs = Array.from(document.querySelectorAll('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'));
                   const userInput = textInputs.reverse().find(el => el.compareDocumentPosition(passInput) & Node.DOCUMENT_POSITION_FOLLOWING);
                   if (userInput) {
                      userInput.value = ${JSON.stringify(p.username)};
                      userInput.dispatchEvent(new Event('input', { bubbles: true }));
                   }
                 }
                 host.remove();
              };
              banner.appendChild(btn);

              const closeBtn = document.createElement('button');
              closeBtn.textContent = '✕';
              closeBtn.style.cssText = 'background: transparent; color: #aaa; border: none; cursor: pointer; font-size: 16px; padding: 0 5px;';
              closeBtn.onclick = () => host.remove();
              banner.appendChild(closeBtn);

              shadow.appendChild(banner);
              setTimeout(() => { if (host.parentNode) host.remove(); }, 10000);
            })();
          `).catch(() => {});
        }
      } catch (e) {}
    });

    view.webContents.on('context-menu', (event, params) => {
      const { selectionText, x, y, mediaType, srcURL } = params;
      const url = view.webContents.getURL();
      const isMuted = view.webContents.isAudioMuted();
      const isFocused = tabData.has(id) ? tabData.get(id).focused : false;

      const template = [];
      
      // Image options
      if (mediaType === 'image') {
        template.push({ label: '在新分頁開啟圖片', click: () => mainWindow.webContents.send('open-new-tab', srcURL) });
        template.push({ label: '另存圖片...', click: () => view.webContents.downloadURL(srcURL) });
        template.push({ label: '複製圖片', click: () => view.webContents.copyImageAt(x, y) });
        template.push({ label: '複製圖片位址', click: () => clipboard.writeText(srcURL) });
        template.push({ type: 'separator' });
      }

      // Autofill Password option
      try {
        const parsedUrl = new URL(url);
        const domain = parsedUrl.hostname;
        const matchingPasswords = passwordsData.filter(p => {
          try { return new URL(p.url).hostname === domain; } 
          catch(e) { return p.url.includes(domain); }
        });
        
        if (matchingPasswords.length > 0) {
          template.push({
            label: `填入帳號密碼 (${matchingPasswords[0].username})`,
            click: () => {
              const p = matchingPasswords[0];
              view.webContents.executeJavaScript(`
                (function() {
                   const passInputs = document.querySelectorAll('input[type="password"]');
                   if (passInputs.length > 0) {
                     const passInput = passInputs[0];
                     passInput.value = ${JSON.stringify(p.password)};
                     passInput.dispatchEvent(new Event('input', { bubbles: true }));
                     
                     // Try to find username input
                     const textInputs = Array.from(document.querySelectorAll('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'));
                     // Find the closest preceding input
                     const userInput = textInputs.reverse().find(el => {
                        return el.compareDocumentPosition(passInput) & Node.DOCUMENT_POSITION_FOLLOWING;
                     });
                     if (userInput) {
                        userInput.value = ${JSON.stringify(p.username)};
                        userInput.dispatchEvent(new Event('input', { bubbles: true }));
                     }
                   }
                })();
              `).catch(() => {});
            }
          });
          template.push({ type: 'separator' });
        }
      } catch (e) {}

      // Navigation options
      template.push({ label: '上一頁', click: () => view.webContents.goBack(), enabled: view.webContents.navigationHistory ? view.webContents.navigationHistory.canGoBack() : view.webContents.canGoBack() });
      template.push({ label: '下一頁', click: () => view.webContents.goForward(), enabled: view.webContents.navigationHistory ? view.webContents.navigationHistory.canGoForward() : view.webContents.canGoForward() });
      template.push({ label: '重新整理', click: () => view.webContents.reload() });
      template.push({ type: 'separator' });
      
      // Page options
      template.push({ label: '另存新檔...', click: () => view.webContents.downloadURL(url) });
      template.push({ label: '列印...', click: () => view.webContents.print() });
      template.push({ label: '翻譯成繁體中文', click: () => {
         view.webContents.executeJavaScript(`
           (function() {
             document.cookie = 'googtrans=/auto/zh-TW; path=/';
             document.cookie = 'googtrans=/auto/zh-TW; domain=' + location.hostname + '; path=/';
             
             if (document.getElementById('custom-google-translate-script')) {
               window.location.reload();
               return;
             }
             
             const style = document.createElement('style');
             style.textContent = 'body { top: 0 !important; } .goog-te-banner-frame { display: none !important; } #google_translate_element { display: none !important; } .goog-tooltip { display: none !important; } .goog-tooltip:hover { display: none !important; } .goog-text-highlight { background-color: transparent !important; border: none !important; box-shadow: none !important; } iframe.skiptranslate { display: none !important; }';
             document.head.appendChild(style);

             const observer = new MutationObserver(() => {
               document.body.style.top = '0px';
               document.documentElement.style.top = '0px';
               const iframes = document.querySelectorAll('iframe');
               iframes.forEach(f => {
                 if (f.className.includes('goog-te-banner-frame') || f.className.includes('skiptranslate') || (f.src && (f.src.includes('translate.google') || f.src.includes('translate.googleapis')))) {
                   f.style.display = 'none';
                 }
               });
             });
             observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

             const div = document.createElement('div');
             div.id = 'google_translate_element';
             div.style.display = 'none';
             document.body.appendChild(div);
             
             window.googleTranslateElementInit = function() {
               new google.translate.TranslateElement({pageLanguage: 'auto', layout: google.translate.TranslateElement.InlineLayout.SIMPLE, autoDisplay: false}, 'google_translate_element');
             };
             
             const script = document.createElement('script');
             script.id = 'custom-google-translate-script';
             script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
             document.head.appendChild(script);
           })();
         `).catch(() => {});
      }});
      template.push({ label: '顯示原文', click: () => {
         view.webContents.executeJavaScript(`
           (function() {
             document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
             document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; domain=' + location.hostname + '; path=/;';
             window.location.reload();
           })();
         `).catch(() => {});
      }});
      template.push({ type: 'separator' });
      
      // Utilities
      template.push({ label: '為這個頁面建立 QR 圖碼', click: () => {
           view.webContents.executeJavaScript(`
             (function() {
               const overlay = document.createElement('div');
               overlay.style.position = 'fixed';
               overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.width = '100vw'; overlay.style.height = '100vh';
               overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
               overlay.style.display = 'flex'; overlay.style.justifyContent = 'center'; overlay.style.alignItems = 'center';
               overlay.style.zIndex = '999999';
               const img = document.createElement('img');
               img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(window.location.href);
               img.style.padding = '20px'; img.style.backgroundColor = 'white'; img.style.borderRadius = '10px';
               overlay.appendChild(img);
               overlay.onclick = () => overlay.remove();
               document.body.appendChild(overlay);
             })();
           `).catch(() => {});
      }});
      template.push({ type: 'separator' });
      
      // Tab options
      template.push({ 
        label: isFocused ? '取消維持活躍' : '維持活躍', 
        click: () => {
          if (tabData.has(id)) {
            tabData.get(id).focused = !isFocused;
            if (!isFocused) tabData.get(id).lastActiveTime = Date.now();
            mainWindow.webContents.send('tab-updated', { id, focused: !isFocused });
          }
        } 
      });
      template.push({ label: isMuted ? '取消靜音' : '分頁靜音', click: () => view.webContents.setAudioMuted(!isMuted) });
      template.push({ type: 'separator' });
      
      // Dev options
      template.push({ label: '檢視網頁原始碼', click: () => mainWindow.webContents.send('open-new-tab', 'view-source:' + url) });
      template.push({ label: '檢查', click: () => view.webContents.inspectElement(x, y) });

      const menu = Menu.buildFromTemplate(template);
      menu.popup();
    });
  }

  ipcMain.on('switch-tab', (event, id) => {
    activeViewId = id;
    const data = tabData.get(id);
    if (!data) return;

    if (data.url === 'internal://settings') {
      setVisibleBrowserView(null);
      return;
    }

    if (!views.has(id) && data.suspended) {
      data.suspended = false;
      createBrowserViewForTab(id, data.url);
      return;
    }

    if (views.has(id)) {
      const view = views.get(id);
      setVisibleBrowserView(view);
      updateActiveViewBounds();
    }
  });

  ipcMain.on('close-tab', (event, id) => {
    if (views.has(id)) {
      const view = views.get(id);
      // Fallback: electron sometimes doesn't like direct destroy if it's attached
      try { mainWindow.removeBrowserView(view); } catch(e){}
      view.webContents.destroy();
      views.delete(id);
    }
    tabData.delete(id);
  });

  ipcMain.on('navigate', (event, { id, url }) => {
    const data = tabData.get(id);
    if (!data) return;

    let finalUrl = url.trim();
    if (finalUrl.startsWith('internal://')) {
      finalUrl = 'internal://settings'; // force all internal to settings for now
    } else if (finalUrl.startsWith('!yt ')) {
      const query = finalUrl.replace('!yt ', '');
      finalUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    } else if (finalUrl.startsWith('!w ')) {
      const query = finalUrl.replace('!w ', '');
      finalUrl = `https://zh.wikipedia.org/wiki/${encodeURIComponent(query)}`;
    } else if (finalUrl.startsWith('!gh ')) {
      const query = finalUrl.replace('!gh ', '');
      finalUrl = `https://github.com/search?q=${encodeURIComponent(query)}`;
    } else if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = 'https://' + finalUrl;
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    } data.url = finalUrl;

    if (finalUrl === 'internal://settings') {
      if (views.has(id)) {
        try { mainWindow.removeBrowserView(views.get(id)); } catch(e){}
      }
      mainWindow.webContents.send('tab-updated', { id, title: '設定', url: finalUrl });
      if (activeViewId === id) {
        setVisibleBrowserView(null);
      }
    } else {
      if (!views.has(id)) {
        createBrowserViewForTab(id, finalUrl);
      } else {
        const view = views.get(id);
        view.webContents.loadURL(finalUrl);
        if (activeViewId === id) {
          setVisibleBrowserView(view);
          updateActiveViewBounds();
        }
      }
    }
  });

  ipcMain.on('go-back', (event, id) => {
    const view = views.get(id);
    if (view && view.webContents.canGoBack()) view.webContents.goBack();
  });

  ipcMain.on('go-forward', (event, id) => {
    const view = views.get(id);
    if (view && view.webContents.canGoForward()) view.webContents.goForward();
  });

  ipcMain.on('reload', (event, id) => {
    const view = views.get(id);
    if (view) view.webContents.reload();
  });

  ipcMain.on('hide-active-view', () => {
    if (activeViewId && views.has(activeViewId)) {
      mainWindow.removeBrowserView(views.get(activeViewId));
    }
  });

  ipcMain.on('show-active-view', () => {
    if (activeViewId && views.has(activeViewId)) {
      mainWindow.addBrowserView(views.get(activeViewId));
      mainWindow.setTopBrowserView(views.get(activeViewId));
      updateActiveViewBounds();
    }
  });
}

const SHORTCUTS_FILE = path.join(app.getPath('userData'), 'shortcuts.json');
let shortcuts = {
  gitClone: 'CommandOrControl+Shift+C',
  gitPush: 'CommandOrControl+Shift+P',
  playPause: 'MediaPlayPause',
  nextTrack: 'MediaNextTrack',
  prevTrack: 'MediaPreviousTrack'
};

function loadShortcuts() {
  try {
    if (fs.existsSync(SHORTCUTS_FILE)) {
      shortcuts = { ...shortcuts, ...JSON.parse(fs.readFileSync(SHORTCUTS_FILE)) };
    }
  } catch(e) {}
}

function saveShortcuts(newShortcuts) {
  shortcuts = { ...shortcuts, ...newShortcuts };
  fs.writeFileSync(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2));
  registerShortcuts();
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  
  if (shortcuts.gitPush) {
    globalShortcut.register(shortcuts.gitPush, async () => {
      if (!activeViewId || !views.has(activeViewId)) return;
      const view = views.get(activeViewId);
      const url = view.webContents.getURL();
      
      if (!url.includes('github.com')) {
        return;
      }

      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: '選擇要 Git Push 的本地端資料夾',
        properties: ['openDirectory']
      });

      if (!canceled && filePaths.length > 0) {
        const localPath = filePaths[0];
        console.log(`Pushing from ${localPath} to ${url}`);
        exec(`git push ${url}.git HEAD`, { cwd: localPath }, (error, stdout, stderr) => {
          if (error) {
             mainWindow.webContents.send('git-action-result', { action: 'push', success: false, error: error.message });
             return;
          }
          mainWindow.webContents.send('git-action-result', { action: 'push', success: true, output: stdout || stderr });
        });
      }
    });
  }

  // Media Controls
  const triggerMedia = (command) => {
    for (const [id, view] of views.entries()) {
      if (view.webContents.isCurrentlyAudible() || id === activeViewId) {
        view.webContents.executeJavaScript(`
          (function() {
            var video = document.querySelector('video');
            var audio = document.querySelector('audio');
            var media = video || audio;
            if(media) {
              if('${command}' === 'playPause') media.paused ? media.play() : media.pause();
              // YT specific next/prev could be added here
            }
          })();
        `).catch(() => {});
        break;
      }
    }
  };

  if (shortcuts.playPause) globalShortcut.register(shortcuts.playPause, () => triggerMedia('playPause'));
  if (shortcuts.nextTrack) globalShortcut.register(shortcuts.nextTrack, () => triggerMedia('nextTrack'));
  if (shortcuts.prevTrack) globalShortcut.register(shortcuts.prevTrack, () => triggerMedia('prevTrack'));

  // Register custom URL jump shortcuts
  Object.keys(shortcuts).forEach(key => {
    if ((key.startsWith('http://') || key.startsWith('https://')) && shortcuts[key]) {
      globalShortcut.register(shortcuts[key], () => {
        if (activeViewId && views.has(activeViewId)) {
          views.get(activeViewId).webContents.loadURL(key);
        } else if (mainWindow) {
           // Fallback to sending navigation event to current tab
           mainWindow.webContents.send('navigate-to', key);
        }
      });
    }
  });
}

// IPC for Settings UI
ipcMain.handle('get-shortcuts', () => shortcuts);
ipcMain.on('save-shortcuts', (e, newShortcuts) => saveShortcuts(newShortcuts));

ipcMain.handle('get-history', () => historyData);
ipcMain.on('clear-history', () => { historyData = []; fs.writeFileSync(HISTORY_FILE, '[]'); });

ipcMain.handle('get-app-settings', () => appSettings);
ipcMain.handle('get-all-highlights', () => highlightsData);
ipcMain.on('save-app-settings', (e, newSettings) => {
  saveAppSettings(newSettings);
  if (global.blocker) {
    if (newSettings.adblockerEnabled) global.blocker.enableBlockingInSession(session.defaultSession);
    else global.blocker.disableBlockingInSession(session.defaultSession);
  }
  mainWindow.webContents.send('settings-updated', appSettings);
});

ipcMain.handle('download-crx', async (e, urlStr) => {
  try {
    const match = urlStr.match(/([a-z]{32})/);
    if (!match) return false;
    const extId = match[1];
    const downloadUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=99.0.0.0&acceptformat=crx2,crx3&x=id%3D${extId}%26uc`;
    
    const extDir = path.join(app.getPath('userData'), 'extensions_unpacked');
    if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
    
    const crxPath = path.join(extDir, `${extId}.crx`);
    const extractPath = path.join(extDir, extId);
    
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(crxPath, Buffer.from(arrayBuffer));
    
    await unzip(crxPath, extractPath);
    
    const extAPI = session.defaultSession.extensions ? session.defaultSession.extensions : session.defaultSession;
    await extAPI.loadExtension(extractPath);
    fs.unlinkSync(crxPath); // Cleanup
    return true;
  } catch (err) {
    console.error('CRX download error:', err);
    return false;
  }
});

ipcMain.handle('load-extension', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '選擇 Chrome 擴充功能資料夾',
    properties: ['openDirectory']
  });
  if (!canceled && filePaths.length > 0) {
    try {
      await session.defaultSession.loadExtension(filePaths[0]);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  return false;
});

ipcMain.handle('get-extensions', () => {
  try {
    const extAPI = session.defaultSession.extensions ? session.defaultSession.extensions : session.defaultSession;
    return extAPI.getAllExtensions().map(e => ({
      id: e.id,
      name: e.name,
      version: e.version,
      url: e.url,
      manifest: e.manifest
    }));
  } catch (e) { return []; }
});

ipcMain.on('open-extension-popup', (e, { id, popupPath }) => {
  const mainBounds = mainWindow.getBounds();
  const win = new BrowserWindow({
    width: 400, height: 600,
    x: mainBounds.x + mainBounds.width - 420,
    y: mainBounds.y + 80,
    parent: mainWindow,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  
  win.on('blur', () => {
    if (!win.isDestroyed()) win.close();
  });

  win.loadURL(`chrome-extension://${id}/${popupPath}`);
});

ipcMain.on('show-extensions-menu', (e) => {
  const extAPI = session.defaultSession.extensions ? session.defaultSession.extensions : session.defaultSession;
  const exts = extAPI.getAllExtensions();
  const template = exts.length === 0 
    ? [{ label: '無擴充功能', enabled: false }]
    : exts.map(ext => ({
        label: ext.name,
        click: () => {
           let popup = ext.manifest?.browser_action?.default_popup || ext.manifest?.action?.default_popup;
           if (popup) {
             const mainBounds = mainWindow.getBounds();
             const win = new BrowserWindow({
               width: 400, height: 600,
               x: mainBounds.x + mainBounds.width - 420, y: mainBounds.y + 80,
               parent: mainWindow, frame: false, alwaysOnTop: true, resizable: false,
               webPreferences: { nodeIntegration: false, contextIsolation: true }
             });
             win.on('blur', () => { if (!win.isDestroyed()) win.close(); });
             win.loadURL(`chrome-extension://${ext.id}/${popup}`);
           } else {
             dialog.showMessageBox(mainWindow, { message: '此擴充功能沒有介面 (Popup UI)' });
           }
        }
      }));
  Menu.buildFromTemplate(template).popup();
});

const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');

let pendingPermissions = {}; // requestId -> callback

function setupSession(sess) {
  sess.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    const headersToRemove = ['content-security-policy', 'Content-Security-Policy', 'x-frame-options', 'X-Frame-Options'];
    headersToRemove.forEach(h => { if (responseHeaders[h]) delete responseHeaders[h]; });
    callback({ cancel: false, responseHeaders: responseHeaders });
  });

  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!mainWindow) { callback(false); return; }
    const url = details.requestingUrl || webContents.getURL();
    let origin = '';
    try { origin = new URL(url).origin; } catch(e) { origin = url; }
    
    // Check cache
    if (permissionsData[origin] && permissionsData[origin][permission] !== undefined) {
      callback(permissionsData[origin][permission]);
      return;
    }

    // Find which tab this belongs to
    let targetTabId = null;
    views.forEach((v, id) => {
       if (v.webContents.id === webContents.id) targetTabId = id;
    });

    if (targetTabId) {
      const reqId = Date.now().toString() + Math.random().toString();
      pendingPermissions[reqId] = callback;
      mainWindow.webContents.send('permission-requested', { id: targetTabId, origin, permission, reqId });
    } else {
      callback(false); // Unknown tab
    }
  });
}

ipcMain.on('permission-response', (e, { reqId, origin, permission, granted, remember }) => {
  if (pendingPermissions[reqId]) {
    pendingPermissions[reqId](granted);
    delete pendingPermissions[reqId];
    if (remember) {
      if (!permissionsData[origin]) permissionsData[origin] = {};
      permissionsData[origin][permission] = granted;
      savePermissions();
    }
  }
});

ipcMain.on('show-permissions-menu', (e, reqs) => {
  const template = [];
  template.push({ label: '網頁要求權限', enabled: false });
  template.push({ type: 'separator' });
  reqs.forEach(req => {
    template.push({ label: `要求存取: ${req.permission}`, enabled: false });
    template.push({ label: '  ✅ 允許並記住', click: () => handlePerm(req, true) });
    template.push({ label: '  ❌ 拒絕並記住', click: () => handlePerm(req, false) });
    template.push({ type: 'separator' });
  });
  Menu.buildFromTemplate(template).popup();
  
  function handlePerm(req, granted) {
    if (pendingPermissions[req.reqId]) {
      pendingPermissions[req.reqId](granted);
      delete pendingPermissions[req.reqId];
      if (!permissionsData[req.origin]) permissionsData[req.origin] = {};
      permissionsData[req.origin][req.permission] = granted;
      savePermissions();
      mainWindow.webContents.send('remove-pending-permission', req.reqId);
    }
  }
});

ipcMain.handle('select-bookmark-folder', async (e, folders) => {
  return new Promise(resolve => {
    const template = [];
    template.push({ label: '儲存到:', enabled: false });
    template.push({ label: '  🗂️ 書籤列 (根目錄)', click: () => resolve('root') });
    folders.forEach(f => {
      template.push({ label: `  📁 ${f.title}`, click: () => resolve(f.id) });
    });
    template.push({ type: 'separator' });
    template.push({ label: '取消', click: () => resolve(null) });
    
    let resolved = false;
    const menu = Menu.buildFromTemplate(template.map(item => {
      if (item.click) {
        const originalClick = item.click;
        item.click = () => { resolved = true; originalClick(); };
      }
      return item;
    }));
    menu.on('menu-will-close', () => {
      setTimeout(() => { if (!resolved) resolve(null); }, 10);
    });
    menu.popup();
  });
});

ipcMain.handle('show-folder-menu', async (e, folder) => {
  return new Promise(resolve => {
    if (!folder.children || folder.children.length === 0) {
      dialog.showMessageBox({ message: '此資料夾是空的' });
      resolve(null);
      return;
    }
    const template = folder.children.map(b => {
      if (b.type === 'folder') return { label: `📁 ${b.title}`, enabled: false }; // nested folders not fully supported in this simple menu
      return { label: b.title, click: () => { resolved = true; resolve(b.url); } };
    });
    let resolved = false;
    const menu = Menu.buildFromTemplate(template);
    menu.on('menu-will-close', () => {
      setTimeout(() => { if (!resolved) resolve(null); }, 10);
    });
    menu.popup();
  });
});

ipcMain.handle('get-permissions', () => permissionsData);
ipcMain.on('delete-permission', (e, origin) => {
  delete permissionsData[origin];
  savePermissions();
});

app.whenReady().then(() => {
  setupSession(session.defaultSession);
  setupSession(session.fromPartition('in-memory', { cache: false }));

  ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then((b) => {
    global.blocker = b;
    if (appSettings.adblockerEnabled) {
      b.enableBlockingInSession(session.defaultSession);
    }
  });

  loadShortcuts();
  createWindow();
  registerShortcuts();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
