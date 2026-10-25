const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const AUDIO = /\.(mp3|flac|wav|m4a|ogg|opus|aac)$/i;
const LYRIC_EXT = ['.lrc', '.srt', '.txt'];
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac'
};

let win = null;
let rendererReady = false;   // giao diện đã đăng ký xong và sẵn sàng nhận file
const pending = [];          // file nhận được trước khi giao diện sẵn sàng
const allowed = new Set();   // chỉ cho giao diện đọc những file do Windows đưa vào

// Ngôn ngữ đã chọn lúc cài đặt (file lang.txt do bộ cài ghi cạnh LYRIC.exe)
function installLang() {
  try {
    const f = path.join(path.dirname(process.execPath), 'lang.txt');
    const l = fs.readFileSync(f, 'utf8').trim().toLowerCase().slice(0, 2);
    if (l === 'vi' || l === 'en') return { lang: l, t: String(Math.floor(fs.statSync(f).mtimeMs)) };
  } catch (e) {}
  return null;
}

// Lấy các đường dẫn file nhạc trong tham số dòng lệnh (Open with / Default apps)
function audioArgs(argv, cwd) {
  return argv
    .slice(1)
    .filter(a => AUDIO.test(a))
    .map(a => path.resolve(cwd || process.cwd(), a))
    .filter(p => fs.existsSync(p));
}

function describe(p) {
  const ext = path.extname(p).toLowerCase();
  const dir = path.dirname(p);
  const stem = path.basename(p, path.extname(p));
  allowed.add(p);
  const info = { audio: { path: p, name: path.basename(p), type: MIME[ext] || '' }, lyric: null };
  // nếu có file lời cùng tên trong cùng thư mục thì đưa kèm
  for (const e of LYRIC_EXT) {
    const lp = path.join(dir, stem + e);
    if (fs.existsSync(lp)) {
      allowed.add(lp);
      info.lyric = { path: lp, name: path.basename(lp), type: '' };
      break;
    }
  }
  return info;
}

function openFiles(list) {
  list.forEach(p => {
    const info = describe(p);
    if (win && rendererReady) win.webContents.send('open-file', info);
    else pending.push(info);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#0c1018',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.on('closed', () => { win = null; rendererReady = false; });
  const il = installLang();
  win.loadFile(path.join(__dirname, 'index.html'), il ? { query: { lang: il.lang, t: il.t } } : undefined);
}

// Giao diện báo đã sẵn sàng -> gửi các file đang chờ
ipcMain.on('renderer-ready', e => {
  if (!win || e.sender !== win.webContents) return;
  rendererReady = true;
  pending.splice(0).forEach(info => win.webContents.send('open-file', info));
});

// Đọc nội dung file (chỉ file đã được Windows đưa vào)
ipcMain.handle('read-file', async (e, p) => {
  if (!win || e.sender !== win.webContents) throw new Error('not allowed');
  if (typeof p !== 'string' || !allowed.has(p)) throw new Error('not allowed');
  return fs.promises.readFile(p);
});

// Chỉ cho chạy 1 cửa sổ: mở thêm file nhạc thì đưa vào cửa sổ đang có
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, cwd) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    openFiles(audioArgs(argv, cwd));
  });

  app.whenReady().then(() => {
    createWindow();
    openFiles(audioArgs(process.argv, process.cwd()));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
