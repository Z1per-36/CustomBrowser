const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
  const host = document.createElement('div');
  host.id = 'custom-browser-highlight-toolbar-host';
  host.style.position = 'absolute';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  const toolbar = document.createElement('div');
  toolbar.style.display = 'none';
  toolbar.style.position = 'absolute';
  toolbar.style.backgroundColor = '#1e1e2e';
  toolbar.style.border = '1px solid #333';
  toolbar.style.borderRadius = '8px';
  toolbar.style.padding = '5px 10px';
  toolbar.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
  toolbar.style.pointerEvents = 'auto';
  toolbar.style.display = 'flex';
  toolbar.style.gap = '8px';
  toolbar.style.alignItems = 'center';

  const btnStyle = `
    width: 26px;
    height: 26px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    transition: transform 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  let colors = [];
  try {
    colors = ipcRenderer.sendSync('get-pinned-colors') || ['#f9e2af', '#f38ba8', '#89b4fa'];
  } catch(e) {
    colors = ['#f9e2af', '#f38ba8', '#89b4fa'];
  }

  const colorsContainer = document.createElement('div');
  colorsContainer.style.display = 'flex';
  colorsContainer.style.gap = '8px';
  colorsContainer.style.alignItems = 'center';
  toolbar.appendChild(colorsContainer);

  function renderColorButtons() {
    colorsContainer.innerHTML = '';
    colors.forEach(hex => {
      const btn = document.createElement('button');
      btn.style.cssText = btnStyle + `background-color: ${hex};`;
      btn.title = '標記螢光筆';
      btn.onmouseover = () => btn.style.transform = 'scale(1.1)';
      btn.onmouseout = () => btn.style.transform = 'scale(1)';
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (text) {
          ipcRenderer.send('save-highlight-from-view', { url: window.location.href, text, color: hex });
          selection.removeAllRanges();
          hideToolbar();
        }
      };
      colorsContainer.appendChild(btn);
    });
  }
  
  renderColorButtons();

  // Custom Color Picker
  const colorPickerWrapper = document.createElement('div');
  colorPickerWrapper.style.cssText = `
    width: 26px;
    height: 26px;
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    cursor: pointer;
    background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red);
    transition: transform 0.1s;
  `;
  colorPickerWrapper.title = '自選顏色';
  colorPickerWrapper.onmouseover = () => colorPickerWrapper.style.transform = 'scale(1.1)';
  colorPickerWrapper.onmouseout = () => colorPickerWrapper.style.transform = 'scale(1)';
  
  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.style.cssText = `
    opacity: 0;
    position: absolute;
    top: 0; left: 0; width: 100%; height: 100%;
    cursor: pointer;
  `;
  colorPicker.oninput = (e) => {
    const hex = e.target.value;
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (text) {
      ipcRenderer.send('save-highlight-from-view', { url: window.location.href, text, color: hex });
      
      ipcRenderer.send('add-pinned-color', hex);
      if (!colors.includes(hex)) {
        colors.push(hex);
        if (colors.length > 6) colors.shift();
        renderColorButtons();
      }
      
      selection.removeAllRanges();
      hideToolbar();
    }
  };
  colorPickerWrapper.appendChild(colorPicker);
  toolbar.appendChild(colorPickerWrapper);

  const divider = document.createElement('div');
  divider.style.width = '1px';
  divider.style.height = '16px';
  divider.style.backgroundColor = '#555';
  toolbar.appendChild(divider);

  // Translate Button
  const translateBtn = document.createElement('button');
  translateBtn.style.cssText = btnStyle + `background-color: transparent; color: white;`;
  translateBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
  translateBtn.title = '翻譯此段落';
  translateBtn.onmouseover = () => translateBtn.style.transform = 'scale(1.1)';
  translateBtn.onmouseout = () => translateBtn.style.transform = 'scale(1)';
  translateBtn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (text) {
      ipcRenderer.send('translate-text-from-view', { text });
      hideToolbar();
    }
  };
  toolbar.appendChild(translateBtn);

  const divider2 = document.createElement('div');
  divider2.style.width = '1px';
  divider2.style.height = '16px';
  divider2.style.backgroundColor = '#555';
  toolbar.appendChild(divider2);

  const delBtn = document.createElement('button');
  delBtn.style.cssText = btnStyle + `background-color: transparent; color: #ff6b6b;`;
  delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
  delBtn.title = '刪除螢光筆';
  delBtn.onmouseover = () => delBtn.style.transform = 'scale(1.1)';
  delBtn.onmouseout = () => delBtn.style.transform = 'scale(1)';
  delBtn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (text) {
      ipcRenderer.send('delete-highlight-from-view', { url: window.location.href, text });
      selection.removeAllRanges();
      hideToolbar();
    }
  };
  toolbar.appendChild(delBtn);

  shadow.appendChild(toolbar);

  let isToolbarVisible = false;

  function hideToolbar() {
    toolbar.style.display = 'none';
    isToolbarVisible = false;
  }

  document.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      
      if (!text) {
        hideToolbar();
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      
      const top = rect.top + window.scrollY - 45;
      const left = rect.left + window.scrollX + (rect.width / 2) - 60;
      
      host.style.top = '0px';
      host.style.left = '0px';
      
      toolbar.style.top = `${top > 0 ? top : rect.bottom + window.scrollY + 10}px`;
      toolbar.style.left = `${left > 0 ? left : 10}px`;
      toolbar.style.display = 'flex';
      isToolbarVisible = true;
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (isToolbarVisible && window.getSelection().isCollapsed) {
       hideToolbar();
    }
  });
});
