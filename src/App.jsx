import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Search, Maximize, Minus, X, Plus, Settings, Star, EyeOff, Puzzle, Trash, History, AlertTriangle, ShieldCheck, Folder } from 'lucide-react';
import './index.css';

function App() {
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [shortcuts, setShortcuts] = useState({});
  const [appSettings, setAppSettings] = useState({ idleTimeout: 5, adblockerEnabled: true, bookmarks: [] });
  const [highlights, setHighlights] = useState({});
  const [historyData, setHistoryData] = useState([]);
  const [permissionsData, setPermissionsData] = useState({});
  const [passwordsData, setPasswordsData] = useState([]);
  const [pendingPermissions, setPendingPermissions] = useState({}); // tabId -> array of requests
  const [activeSettingsTab, setActiveSettingsTab] = useState('general');
  const [notification, setNotification] = useState('');
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const isSettingsTab = activeTab && activeTab.url === 'internal://settings';

  useEffect(() => {
    // Initial tab logic moved to getAppSettings

    // Listen for tab updates (title, url)
    if (window.electronAPI) {
      window.electronAPI.onTabUpdated((data) => {
        setTabs(prev => prev.map(t => t.id === data.id ? { ...t, title: data.title || t.title, url: data.url || t.url, focused: data.focused !== undefined ? data.focused : t.focused } : t));
      });
      window.electronAPI.onTabFaviconUpdated((data) => {
        setTabs(prev => prev.map(t => t.id === data.id ? { ...t, favicon: data.favicon } : t));
      });
      window.electronAPI.onPermissionRequested((data) => {
        setPendingPermissions(prev => {
           const requests = prev[data.id] || [];
           return { ...prev, [data.id]: [...requests, data] };
        });
      });
      window.electronAPI.onRemovePendingPermission((reqId) => {
        setPendingPermissions(prev => {
          const newState = { ...prev };
          Object.keys(newState).forEach(tabId => {
            newState[tabId] = newState[tabId].filter(r => r.reqId !== reqId);
          });
          return newState;
        });
      });
      window.electronAPI.onGitActionResult((data) => {
        setNotification(`Git ${data.action}: ${data.success ? 'Success' : 'Failed - ' + data.error}`);
        setTimeout(() => setNotification(''), 5000);
      });
      window.electronAPI.onSettingsUpdated((data) => {
        setAppSettings(data);
      });
      window.electronAPI.onOpenNewTab((url) => {
        handleNewTab(url);
      });
      // Initial load
      window.electronAPI.getAppSettings().then(settings => {
        setAppSettings(settings);
        if (settings.startupBehavior === 'continue' && settings.lastSessionUrls && settings.lastSessionUrls.length > 0) {
           settings.lastSessionUrls.forEach((url, idx) => {
             setTimeout(() => handleNewTab(url), idx * 10);
           });
        } else {
           handleNewTab('https://www.google.com');
        }
      });
    }
  }, []);

  useEffect(() => {
    if (isSettingsTab && window.electronAPI) {
      window.electronAPI.getShortcuts().then(setShortcuts);
      window.electronAPI.getAppSettings().then(setAppSettings);
      window.electronAPI.getAllHighlights().then(setHighlights);
      window.electronAPI.getHistory().then(setHistoryData);
      window.electronAPI.getPermissions().then(setPermissionsData);
      if (window.electronAPI.getPasswords) window.electronAPI.getPasswords().then(setPasswordsData);
    }
  }, [isSettingsTab]);
  useEffect(() => {
    if (tabs.length > 0 && window.electronAPI) {
      const urls = tabs.map(t => t.url).filter(u => u && !u.startsWith('internal://'));
      if (urls.length > 0) {
         window.electronAPI.saveAppSettings({ lastSessionUrls: urls });
      }
    }
  }, [tabs]);


  useEffect(() => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      setUrlInput(activeTab.url || '');
    } else {
      setUrlInput('');
    }
  }, [activeTabId, tabs]);

  const handleNewTab = (url = 'https://www.google.com', isIncognito = false) => {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const newTab = { id, title: isIncognito ? '[無痕] New Tab' : 'New Tab', url, isIncognito };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    if (window.electronAPI) {
      window.electronAPI.createTab({ id, url, isIncognito });
    }
  };

  const handleSwitchTab = (id) => {
    setActiveTabId(id);
    if (window.electronAPI) {
      window.electronAPI.switchTab(id);
    }
  };

  const handleCloseTab = (e, id) => {
    e.stopPropagation();
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id && newTabs.length > 0) {
      handleSwitchTab(newTabs[newTabs.length - 1].id);
    } else if (newTabs.length === 0) {
      window.electronAPI?.closeWindow();
    }
    if (window.electronAPI) {
      window.electronAPI.closeTab(id);
    }
  };

  const handleNavigate = (e) => {
    if (e.key === 'Enter' && activeTabId) {
      if (window.electronAPI) {
        window.electronAPI.navigate({ id: activeTabId, url: urlInput });
      }
    }
  };

  const handleGoBack = () => window.electronAPI?.goBack(activeTabId);
  const handleGoForward = () => window.electronAPI?.goForward(activeTabId);
  const handleReload = () => window.electronAPI?.reload(activeTabId);

  const closeWindow = () => window.electronAPI?.closeWindow();
  const minimizeWindow = () => window.electronAPI?.minimizeWindow();
  const toggleMaximize = () => window.electronAPI?.toggleMaximize();

  const handleShortcutInput = (keyName, e) => {
    e.preventDefault();
    const key = e.key;
    if (key === 'Backspace' || key === 'Delete') {
      setShortcuts({ ...shortcuts, [keyName]: '' });
      return;
    }
    if (['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Process'].includes(key)) return;

    let accelerator = [];
    if (e.ctrlKey || (e.metaKey && navigator.userAgent.includes('Mac'))) accelerator.push('CommandOrControl');
    else if (e.metaKey) accelerator.push('Super');
    if (e.shiftKey) accelerator.push('Shift');
    if (e.altKey) accelerator.push('Alt');

    let keyStr = key;
    if (key === ' ') keyStr = 'Space';
    else if (key === 'ArrowUp') keyStr = 'Up';
    else if (key === 'ArrowDown') keyStr = 'Down';
    else if (key === 'ArrowLeft') keyStr = 'Left';
    else if (key === 'ArrowRight') keyStr = 'Right';
    else if (key === 'Escape') keyStr = 'Esc';
    else if (key === 'Enter') keyStr = 'Return';
    else if (key.length === 1) keyStr = key.toUpperCase();

    // Mapping media keys to Electron format
    if (keyStr === 'MediaTrackPrevious') keyStr = 'MediaPreviousTrack';
    if (keyStr === 'MediaTrackNext') keyStr = 'MediaNextTrack';

    accelerator.push(keyStr);
    setShortcuts({ ...shortcuts, [keyName]: accelerator.join('+') });
  };

  const saveSettings = () => {
    if (window.electronAPI) {
      window.electronAPI.saveShortcuts(shortcuts);
      window.electronAPI.saveAppSettings(appSettings);
      setNotification('設定已儲存');
      setTimeout(() => setNotification(''), 3000);
    }
  };

  const isCurrentlyBookmarked = React.useMemo(() => {
    let found = false;
    const check = (list) => {
      for (let b of list || []) {
        if (b.type === 'folder') check(b.children);
        else if (b.url === urlInput) found = true;
      }
    };
    check(appSettings.bookmarks);
    return found;
  }, [appSettings.bookmarks, urlInput]);

  const toggleBookmark = async () => {
    if (!urlInput || urlInput === 'internal://settings') return;
    const currentBookmarks = appSettings.bookmarks || [];
    
    if (isCurrentlyBookmarked) {
      const removeBookmark = (list) => {
        return list.filter(b => {
          if (b.type === 'folder') {
            b.children = removeBookmark(b.children || []);
            return true;
          }
          return b.url !== urlInput;
        });
      };
      const newSettings = { ...appSettings, bookmarks: removeBookmark(currentBookmarks) };
      setAppSettings(newSettings);
      if (window.electronAPI) window.electronAPI.saveAppSettings(newSettings);
    } else {
      if (window.electronAPI) {
        const getFolders = (list) => {
           let folders = [];
           list.forEach(b => {
             if (b.type === 'folder') folders.push({ id: b.id, title: b.title });
           });
           return folders;
        };
        const target = await window.electronAPI.selectBookmarkFolder(getFolders(currentBookmarks));
        if (!target) return;
        
        const newBookmark = { type: 'url', title: activeTab?.title || urlInput, url: urlInput, favicon: activeTab?.favicon };
        let newBookmarks = [...currentBookmarks];
        if (target === 'root') {
          newBookmarks.push(newBookmark);
        } else {
          const addToFolder = (list) => {
            for (let b of list) {
              if (b.type === 'folder' && b.id === target) {
                b.children = b.children || [];
                b.children.push(newBookmark);
                return true;
              }
            }
            return false;
          };
          addToFolder(newBookmarks);
        }
        const newSettings = { ...appSettings, bookmarks: newBookmarks };
        setAppSettings(newSettings);
        window.electronAPI.saveAppSettings(newSettings);
      }
    }
  };

  const handleLoadExtension = async () => {
    if (window.electronAPI) {
      const success = await window.electronAPI.loadExtension();
      setNotification(success ? '擴充功能載入成功！' : '載入取消或失敗');
      setTimeout(() => setNotification(''), 3000);
    }
  };



  const openSettingsTab = () => {
    const id = Date.now().toString() + Math.random().toString();
    const newTab = { id, title: '設定', url: 'internal://settings' };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    if (window.electronAPI) {
      window.electronAPI.createTab({ id, url: 'internal://settings' });
    }
  };

  return (
    <div className="browser-container">
      {notification && <div className="notification">{notification}</div>}
      <div className="titlebar">
        <div className="tabs-container">
          {tabs.map(tab => (
            <div 
              key={tab.id} 
              className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
              onClick={() => handleSwitchTab(tab.id)}
            >
              <span className="tab-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {tab.favicon && <img src={tab.favicon} width={14} height={14} style={{ borderRadius: 2 }} />}
                {tab.focused && <span title="維持活躍 (不會被休眠)" style={{fontSize: 12}}>📌</span>} {tab.title}
              </span>
              <button className="tab-close" onClick={(e) => handleCloseTab(e, tab.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button className="new-tab-btn" onClick={() => handleNewTab()} title="新增分頁">
          <Plus size={16} />
        </button>
        <button className="new-tab-btn incognito-btn" onClick={() => handleNewTab('https://www.google.com', true)} title="新增無痕分頁">
          <EyeOff size={16} />
        </button>
        <div className="titlebar-drag-region"></div>
        <div className="window-controls">
          <button className="control-btn minimize" onClick={minimizeWindow}><Minus size={16} /></button>
          <button className="control-btn maximize" onClick={toggleMaximize}><Maximize size={16} /></button>
          <button className="control-btn close" onClick={closeWindow}><X size={16} /></button>
        </div>
      </div>
      <div className="toolbar">
        <button className="nav-btn" onClick={handleGoBack}><ChevronLeft size={20} /></button>
        <button className="nav-btn" onClick={handleGoForward}><ChevronRight size={20} /></button>
        <button className="nav-btn" onClick={handleReload}><RotateCw size={18} /></button>
        <div className="address-bar">
          <Search size={16} className="search-icon" />
          <input 
            type="text" 
            placeholder="Search or enter URL (e.g. !yt, !gh...)" 
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleNavigate}
          />
          {pendingPermissions[activeTabId] && pendingPermissions[activeTabId].length > 0 && (
             <div style={{ position: 'relative' }}>
               <button className="nav-btn" style={{ color: 'orange' }} onClick={() => window.electronAPI.showPermissionsMenu(pendingPermissions[activeTabId])} title="網頁要求權限">
                 <AlertTriangle size={16} />
               </button>
             </div>
          )}
          <button className={`bookmark-btn ${isCurrentlyBookmarked ? 'active' : ''}`} onClick={toggleBookmark} title="加入書籤">
            <Star size={16} fill={isCurrentlyBookmarked ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="nav-btn" onClick={() => window.electronAPI.showExtensionsMenu()} title="擴充功能"><Puzzle size={18} /></button>
        </div>
        <button className="nav-btn" onClick={openSettingsTab} title="設定"><Settings size={18} /></button>
      </div>
      {(appSettings.bookmarks && appSettings.bookmarks.length > 0) && (
        <div className="bookmarks-bar">
          {appSettings.bookmarks.map((b, i) => {
            if (b.type === 'folder') {
              return (
                <button key={i} className="bookmark-item" onClick={() => {
                   window.electronAPI.showFolderMenu(b).then(url => {
                     if (url) {
                       setUrlInput(url);
                       if (activeTabId && window.electronAPI) window.electronAPI.navigate({ id: activeTabId, url: url });
                     }
                   });
                }} title={b.title}>
                  <Folder size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} /> <span style={{ verticalAlign: 'middle' }}>{b.title}</span>
                </button>
              );
            }
            return (
              <button key={i} className="bookmark-item" onClick={() => {
                setUrlInput(b.url);
                if (activeTabId && window.electronAPI) window.electronAPI.navigate({ id: activeTabId, url: b.url });
              }} title={b.url}>
                {b.favicon && <img src={b.favicon} alt="" style={{ width: 14, height: 14, marginRight: 5, verticalAlign: 'middle' }} />}
                <span style={{ verticalAlign: 'middle' }}>{b.title}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="content-area">
        {/* BrowserView overlays here natively, except when settings is active */}
        {isSettingsTab && (
          <div className="settings-page">
            <h2>瀏覽器設定</h2>
            
            <div className="settings-tabs">
              <button className={activeSettingsTab === 'general' ? 'active' : ''} onClick={() => setActiveSettingsTab('general')}>一般設定</button>
              <button className={activeSettingsTab === 'bookmarks' ? 'active' : ''} onClick={() => setActiveSettingsTab('bookmarks')}>書籤管理</button>
              <button className={activeSettingsTab === 'shortcuts' ? 'active' : ''} onClick={() => setActiveSettingsTab('shortcuts')}>快捷鍵</button>
              <button className={activeSettingsTab === 'highlights' ? 'active' : ''} onClick={() => setActiveSettingsTab('highlights')}>螢光筆記</button>
              <button className={activeSettingsTab === 'history' ? 'active' : ''} onClick={() => setActiveSettingsTab('history')}>歷史紀錄</button>
              <button className={activeSettingsTab === 'passwords' ? 'active' : ''} onClick={() => setActiveSettingsTab('passwords')}>密碼管理</button>
              <button className={activeSettingsTab === 'permissions' ? 'active' : ''} onClick={() => setActiveSettingsTab('permissions')}>網頁權限</button>
            </div>

            {activeSettingsTab === 'general' && (
              <div className="settings-form">
                <h3 style={{ marginTop: 0 }}>起始畫面</h3>
                <div className="setting-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input 
                      type="radio" 
                      name="startupBehavior" 
                      value="new-tab" 
                      checked={appSettings.startupBehavior !== 'continue'} 
                      onChange={() => setAppSettings({...appSettings, startupBehavior: 'new-tab'})}
                    /> 
                    開啟新分頁
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input 
                      type="radio" 
                      name="startupBehavior" 
                      value="continue" 
                      checked={appSettings.startupBehavior === 'continue'} 
                      onChange={() => setAppSettings({...appSettings, startupBehavior: 'continue'})}
                    /> 
                    繼續先前進度
                  </label>
                </div>
                
                <hr style={{ borderColor: 'var(--border-color)', margin: '20px 0' }} />

                <div className="setting-item">
                  <label>背景分頁閒置時間 (分鐘)</label>
                  <input 
                    type="number" 
                    value={appSettings.idleTimeout || 5} 
                    onChange={e => setAppSettings({...appSettings, idleTimeout: parseInt(e.target.value) || 5})}
                  />
                </div>
                <div className="setting-item" style={{ alignItems: 'center' }}>
                  <label>啟用廣告阻擋 (AdBlocker)</label>
                  <button className="btn-secondary" onClick={() => {
                    setAppSettings({ ...appSettings, adblockerEnabled: !appSettings.adblockerEnabled });
                  }}>
                    {appSettings.adblockerEnabled ? '關閉防廣告功能' : '開啟防廣告功能'}
                  </button>
                </div>
                
                <hr style={{ borderColor: 'var(--border-color)', margin: '20px 0' }} />
                
                <h3 style={{ marginTop: 0 }}>擴充功能 (Chrome Extensions)</h3>
                <div className="setting-item" style={{ alignItems: 'center', marginBottom: '20px' }}>
                  <label style={{ flex: 1 }}>直接輸入 Chrome 商店網址安裝：</label>
                  <div style={{ display: 'flex', gap: '10px', flex: 2 }}>
                    <input type="text" id="crx-url-input" placeholder="https://chromewebstore.google.com/detail/..." style={{ flex: 1 }} />
                    <button className="btn-secondary" onClick={async () => {
                      const url = document.getElementById('crx-url-input').value;
                      if (!url) return;
                      setNotification('開始下載擴充功能，請稍候...');
                      const success = await window.electronAPI.downloadCrx(url);
                      setNotification(success ? '安裝成功！' : '下載或安裝失敗，請確認網址格式');
                      if (success) document.getElementById('crx-url-input').value = '';
                      setTimeout(() => setNotification(''), 3000);
                    }}>一鍵安裝</button>
                  </div>
                </div>

                <div className="setting-item" style={{ alignItems: 'center' }}>
                  <label style={{ flex: 1 }}>進階操作：</label>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn-secondary" onClick={() => {
                       window.electronAPI.navigate({ id: activeTabId, url: 'https://chromewebstore.google.com/' });
                       setActiveTabId(activeTabId);
                    }}>前往擴充功能商店</button>
                    <button onClick={handleLoadExtension} className="btn-secondary">載入已解壓縮資料夾</button>
                  </div>
                </div>
              </div>
            )}

            {activeSettingsTab === 'bookmarks' && (
              <div className="settings-form">
                <div className="setting-item">
                  <button className="btn-secondary" onClick={() => {
                    const id = Date.now().toString();
                    const newSettings = { ...appSettings, bookmarks: [...(appSettings.bookmarks || []), { id, type: 'folder', title: '新資料夾', children: [] }] };
                    setAppSettings(newSettings);
                    if (window.electronAPI) window.electronAPI.saveAppSettings(newSettings);
                  }}>+ 新增書籤資料夾</button>
                </div>
                {appSettings.bookmarks && appSettings.bookmarks.map((b, i) => (
                  <div key={i} className="setting-item" style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                         {b.type === 'folder' ? <Folder size={14} style={{ verticalAlign: 'middle' }} /> : (b.favicon && <img src={b.favicon} style={{ width: 16, height: 16 }} />)}
                         {b.title} 
                         {b.type !== 'folder' && <span style={{ color: '#888', fontSize: '12px', marginLeft: '10px' }}>{b.url}</span>}
                      </strong>
                      <button className="btn-secondary" style={{ background: '#dc3545' }} onClick={() => {
                        const newSettings = { ...appSettings, bookmarks: appSettings.bookmarks.filter((_, idx) => idx !== i) };
                        setAppSettings(newSettings);
                        if (window.electronAPI) window.electronAPI.saveAppSettings(newSettings);
                      }}>刪除</button>
                    </div>
                    {b.type === 'folder' && b.children && b.children.length > 0 && (
                      <div style={{ paddingLeft: '30px', borderLeft: '2px solid #555' }}>
                        {b.children.map((child, j) => (
                          <div key={j} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                              {child.favicon && <img src={child.favicon} style={{ width: 14, height: 14 }} />}
                              {child.title}
                            </div>
                            <button className="btn-secondary" style={{ background: '#dc3545', padding: '2px 6px', fontSize: '12px' }} onClick={() => {
                              const newBookmarks = [...appSettings.bookmarks];
                              newBookmarks[i].children = newBookmarks[i].children.filter((_, cIdx) => cIdx !== j);
                              const newSettings = { ...appSettings, bookmarks: newBookmarks };
                              setAppSettings(newSettings);
                              if (window.electronAPI) window.electronAPI.saveAppSettings(newSettings);
                            }}>刪除</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {activeSettingsTab === 'shortcuts' && (
              <div className="settings-form">
                {Object.keys(shortcuts).map(key => (
                  <div key={key} className="setting-item">
                    <label>{key}</label>
                    <input 
                      type="text" 
                      value={shortcuts[key]} 
                      readOnly={true}
                      placeholder="點擊此處並按下快捷鍵..."
                      onKeyDown={e => handleShortcutInput(key, e)}
                      style={{ cursor: 'pointer' }}
                    />
                  </div>
                ))}
                <div className="setting-item">
                   <button onClick={() => {
                     const url = prompt("輸入要透過快捷鍵一鍵跳轉的網址 (例如 https://github.com):");
                     if (url && !shortcuts[url]) setShortcuts({...shortcuts, [url]: ''});
                   }} className="btn-secondary">+ 新增自訂網址快捷鍵</button>
                </div>
              </div>
            )}

            {activeSettingsTab === 'highlights' && (
              <div className="highlights-list">
                {Object.keys(highlights).length === 0 ? <p>目前沒有任何螢光筆記。</p> : null}
                {Object.keys(highlights).map(url => (
                  <div key={url} className="highlight-url-group">
                    <h3 onClick={() => {
                       if (activeTabId && window.electronAPI) window.electronAPI.navigate({ id: activeTabId, url: 'https://' + url });
                    }} style={{ cursor: 'pointer', color: 'lightblue' }}>{url}</h3>
                    <ul>
                      {highlights[url].map((item, i) => {
                        const hexColors = { yellow: '#f9e2af', red: '#f38ba8', blue: '#89b4fa' };
                        const bgColor = hexColors[item.color] || 'yellow';
                        return (
                          <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px' }}>
                            <mark style={{backgroundColor: bgColor, color: 'black'}}>{item.text}</mark>
                            <button className="btn-secondary" style={{ background: '#dc3545', padding: '2px 6px', fontSize: '12px' }} onClick={() => {
                              if (window.electronAPI) {
                                window.electronAPI.deleteHighlight({ url, text: item.text });
                                const newHighlights = { ...highlights };
                                newHighlights[url] = newHighlights[url].filter(t => t.text !== item.text);
                                if (newHighlights[url].length === 0) delete newHighlights[url];
                                setHighlights(newHighlights);
                              }
                            }}>刪除</button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {activeSettingsTab === 'history' && (
              <div className="history-list">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                   <h3>歷史紀錄</h3>
                   {confirmClearHistory ? (
                     <div style={{ display: 'flex', gap: '10px' }}>
                       <span style={{ color: '#ff6b6b', fontSize: '12px', alignSelf: 'center' }}>確定清除？</span>
                       <button onClick={() => {
                         window.electronAPI.clearHistory();
                         setHistoryData([]);
                         setConfirmClearHistory(false);
                       }} className="btn-secondary" style={{ background: '#e81123', padding: '4px 8px', fontSize: '12px' }}>是</button>
                       <button onClick={() => setConfirmClearHistory(false)} className="btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>否</button>
                     </div>
                   ) : (
                     <button onClick={() => setConfirmClearHistory(true)} className="btn-secondary" style={{ background: 'transparent', color: '#ff6b6b', border: '1px solid #ff6b6b', padding: '4px 8px', fontSize: '12px' }}><Trash size={12} style={{ marginRight: 4, verticalAlign: 'middle' }}/> 清除所有紀錄</button>
                   )}
                </div>
                {historyData.length === 0 ? <p>無歷史紀錄。</p> : null}
                {historyData.map((h, i) => (
                  <div key={i} className="history-item">
                    <span className="history-time">{new Date(h.timestamp).toLocaleString()}</span>
                    <span className="history-title" onClick={() => {
                       if (activeTabId && window.electronAPI) window.electronAPI.navigate({ id: activeTabId, url: h.url });
                    }} title={h.url}>{h.title}</span>
                  </div>
                ))}
              </div>
            )}

            {activeSettingsTab === 'passwords' && (
              <div className="passwords-list">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                   <h3 style={{ margin: 0 }}>已儲存的密碼</h3>
                   <button onClick={async () => {
                     if (window.electronAPI && window.electronAPI.importPasswordsCsv) {
                       setNotification('正在開啟檔案選擇器...');
                       const result = await window.electronAPI.importPasswordsCsv();
                       if (result && result.success) {
                         setNotification(`成功匯入 ${result.count} 筆密碼！`);
                         const newPasswords = await window.electronAPI.getPasswords();
                         setPasswordsData(newPasswords);
                       } else if (result && result.error) {
                         setNotification(`匯入失敗：${result.error}`);
                       } else {
                         setNotification('已取消匯入');
                       }
                       setTimeout(() => setNotification(''), 3000);
                     }
                   }} style={{ background: 'transparent', color: '#ccc', border: '1px solid #555', padding: '4px 12px', borderRadius: '15px', fontSize: '12px', cursor: 'pointer' }} 
                   onMouseOver={(e) => { e.target.style.background = '#333'; e.target.style.color = 'white'; }}
                   onMouseOut={(e) => { e.target.style.background = 'transparent'; e.target.style.color = '#ccc'; }}>
                     匯入 CSV 密碼檔
                   </button>
                </div>
                {passwordsData.length === 0 ? <p>目前沒有任何儲存的密碼。</p> : null}
                {passwordsData.map((p, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #333', fontSize: '13px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flex: 1, minWidth: 0 }}>
                      <div style={{ width: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 'bold' }} title={p.url}>{p.url}</div>
                      <div style={{ color: '#aaa', display: 'flex', gap: '15px', alignItems: 'center' }}>
                         <span>帳號: <span style={{color:'white'}}>{p.username}</span></span>
                         <span>密碼: <span style={{color:'white'}}>••••••••</span></span>
                         <button style={{ background: 'none', border: 'none', color: '#89b4fa', cursor: 'pointer', fontSize: '12px', padding: 0 }} onClick={() => navigator.clipboard.writeText(p.password)}>複製</button>
                      </div>
                    </div>
                    <button className="btn-secondary" style={{ background: 'transparent', color: '#ff6b6b', padding: '2px 6px', fontSize: '12px' }} onClick={() => {
                      if (window.electronAPI) {
                        window.electronAPI.deletePassword(i);
                        setPasswordsData(passwordsData.filter((_, idx) => idx !== i));
                      }
                    }}>刪除</button>
                  </div>
                ))}
              </div>
            )}

            {activeSettingsTab === 'permissions' && (
              <div className="permissions-list">
                <h3>已記憶的網頁權限</h3>
                {Object.keys(permissionsData).length === 0 ? <p>目前沒有記憶任何權限。</p> : null}
                {Object.keys(permissionsData).map(origin => (
                  <div key={origin} className="highlight-url-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ margin: '0 0 5px 0' }}>{origin}</h4>
                      <div style={{ fontSize: 12, color: '#aaa' }}>
                        {Object.entries(permissionsData[origin]).map(([perm, granted]) => (
                          <span key={perm} style={{ marginRight: 10, color: granted ? 'lightgreen' : '#ff6b6b' }}>
                             {perm}: {granted ? '允許' : '拒絕'}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button onClick={() => {
                       if (window.confirm('確定要刪除該網域的權限記憶嗎？下次將重新詢問。')) {
                         window.electronAPI.deletePermission(origin);
                         setPermissionsData(prev => { const d = {...prev}; delete d[origin]; return d; });
                       }
                    }} className="btn-secondary" style={{ background: '#e81123' }}><Trash size={14}/></button>
                  </div>
                ))}
              </div>
            )}

            <div className="settings-actions">
              <button onClick={saveSettings}>儲存設定</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
