const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Ngôn ngữ đã chọn lúc cài đặt (file lang.txt do bộ cài ghi cạnh LYRIC.exe)
function installLang() {
  try {
    const f = path.join(path.dirname(process.execPath), 'lang.txt');
    const l = fs.readFileSync(f, 'utf8').trim().toLowerCase().slice(0, 2);
    if (l === 'vi' || l === 'en') return { lang: l, t: String(Math.floor(fs.statSync(f).mtimeMs)) };
  } catch (e) {}
  return null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#0c1018',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  const il = installLang();
  win.loadFile(path.join(__dirname, 'index.html'), il ? { query: { lang: il.lang, t: il.t } } : undefined);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
