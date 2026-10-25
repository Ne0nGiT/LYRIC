const { app, BrowserWindow, Menu, ipcMain, dialog, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const AUDIO = /\.(mp3|flac|wav|m4a|ogg|opus|aac)$/i;
const IMG = /\.(jpe?g|png|webp)$/i;
const READABLE = /\.(mp3|flac|wav|m4a|ogg|opus|aac|lrc|srt|txt|jpe?g|png|webp)$/i;
const LYRIC_EXT = ['.lrc', '.srt', '.txt'];
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac'
};

let win = null;
let rendererReady = false;   // giao diện đã đăng ký xong và sẵn sàng nhận file
const pending = [];          // file nhận được trước khi giao diện sẵn sàng
const allowed = new Set();   // file do Windows đưa vào (Open with)

/* ===== Cấu hình (thư mục nhạc mặc định) ===== */
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
let cfg = {};
function loadCfg() { try { cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; } catch (e) { cfg = {}; } }
function saveCfg() { try { fs.mkdirSync(path.dirname(cfgPath()), { recursive: true }); fs.writeFileSync(cfgPath(), JSON.stringify(cfg)); } catch (e) {} }
const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };

// Ngôn ngữ đã chọn lúc cài đặt (file lang.txt do bộ cài ghi cạnh LYRIC.exe)
function installLang() {
  try {
    const f = path.join(path.dirname(process.execPath), 'lang.txt');
    const l = fs.readFileSync(f, 'utf8').trim().toLowerCase().slice(0, 2);
    if (l === 'vi' || l === 'en') return { lang: l, t: String(Math.floor(fs.statSync(f).mtimeMs)) };
  } catch (e) {}
  return null;
}

// Chọn thư mục nhạc mặc định lần đầu chạy (không chọn thì dùng thư mục Music của Windows)
async function initMusicDir() {
  loadCfg();
  if (cfg.musicDir) return;
  // bộ cài (nếu có hỏi) sẽ ghi musicdir.txt cạnh LYRIC.exe, giống lang.txt
  try {
    const d = fs.readFileSync(path.join(path.dirname(process.execPath), 'musicdir.txt'), 'utf8').trim();
    if (d && isDir(d)) { cfg.musicDir = d; saveCfg(); return; }
  } catch (e) {}
  const il = installLang();
  const vi = !il || il.lang === 'vi';
  let dir = app.getPath('music');
  try {
    const r = await dialog.showOpenDialog(win || undefined, {
      title: vi ? 'LYRIC - Chọn thư mục nhạc mặc định' : 'LYRIC - Choose your default music folder',
      buttonLabel: vi ? 'Chọn thư mục' : 'Choose folder',
      defaultPath: app.getPath('music'),
      properties: ['openDirectory']
    });
    if (!r.canceled && r.filePaths[0]) dir = r.filePaths[0];
  } catch (e) {}
  cfg.musicDir = dir;
  saveCfg();
}
let initP = null;

/* ===== Mở file nhạc từ Windows (Open with / Default apps) ===== */
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

/* ===== Quét thư mục nhạc ===== */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function pickCover(imgs) {
  const jpg = imgs.filter(n => /\.jpe?g$/i.test(n));
  const stem = n => n.replace(/\.[^.]+$/, '');
  return (
    jpg.find(n => /^arts?([^a-z]|$)/i.test(stem(n))) ||
    jpg.find(n => /cover|folder|front|album/i.test(n)) ||
    jpg[0] ||
    imgs.find(n => /cover|folder|front|album/i.test(n)) ||
    imgs[0] ||
    null
  );
}

async function scanMusic(root) {
  const out = [];
  let total = 0;
  async function walk(dir, depth) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    const files = [], subs = [];
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
      if (e.isDirectory()) subs.push(e.name);
      else files.push(e.name);
    }
    const audio = files.filter(n => AUDIO.test(n)).sort(collator.compare);
    if (audio.length && total < 100000) {
      const lyr = new Map();
      for (const n of files) {
        const x = path.extname(n).toLowerCase();
        if (LYRIC_EXT.includes(x)) {
          const k = path.basename(n, x).toLowerCase();
          if (!lyr.has(k)) lyr.set(k, n);
        }
      }
      const tracks = [];
      for (const n of audio) {
        const p = path.join(dir, n);
        let st;
        try { st = await fs.promises.stat(p); } catch (e) { continue; }
        const stem = path.basename(n, path.extname(n));
        const ln = lyr.get(stem.toLowerCase());
        let lrc = null;
        if (ln) {
          const lp = path.join(dir, ln);
          try { const ls = await fs.promises.stat(lp); lrc = { path: lp, name: ln, size: ls.size }; } catch (e) {}
        }
        tracks.push({ path: p, name: n, size: st.size, type: MIME[path.extname(n).toLowerCase()] || '', lrc });
        total++;
      }
      let cover = null;
      const cn = pickCover(files.filter(n => IMG.test(n)));
      if (cn) {
        const cp = path.join(dir, cn);
        try { const cs = await fs.promises.stat(cp); cover = { path: cp, size: cs.size, mtime: Math.floor(cs.mtimeMs) }; } catch (e) {}
      }
      if (tracks.length) out.push({ dir, name: path.basename(dir) || dir, cover, tracks });
    }
    if (depth < 10) for (const s of subs.sort(collator.compare)) await walk(path.join(dir, s), depth + 1);
  }
  await walk(root, 0);
  return out;
}

let watcher = null, watchTimer = null;
function stopWatch() {
  if (watcher) { try { watcher.close(); } catch (e) {} watcher = null; }
  clearTimeout(watchTimer);
}
function startWatch() {
  stopWatch();
  if (!cfg.musicDir || !isDir(cfg.musicDir)) return;
  try {
    watcher = fs.watch(cfg.musicDir, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { if (win) win.webContents.send('lib-changed'); }, 3000);
    });
    watcher.on('error', () => stopWatch());
  } catch (e) {}
}
let wantWatch = false;

function insideMusicDir(p) {
  if (!cfg.musicDir || typeof p !== 'string') return false;
  const rel = path.relative(cfg.musicDir, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* ===== Discord Rich Presence (tự nói chuyện với Discord qua IPC, không cần thư viện ngoài) ===== */
const DISCORD_ID = '1563860410476793946';
let dSock = null, dReady = false, dBuf = Buffer.alloc(0), dWant = null, dLast = '', dTimer = null, dN = 0;

const dFrame = (op, obj) => {
  const j = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(8);
  h.writeInt32LE(op, 0);
  h.writeInt32LE(j.length, 4);
  return Buffer.concat([h, j]);
};
const dPath = i => process.platform === 'win32'
  ? '\\\\?\\pipe\\discord-ipc-' + i
  : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', 'discord-ipc-' + i);

function dSchedule(ms) {
  clearTimeout(dTimer);
  dTimer = setTimeout(() => { dTimer = null; dConnect(0); }, ms);
}

function dConnect(i) {
  if (dSock || !dWant) return;
  if (i > 9) { dSchedule(15000); return; }   // Discord chưa mở: thử lại sau
  const s = net.createConnection(dPath(i));
  let opened = false;
  s.once('connect', () => {
    opened = true;
    dSock = s;
    s.write(dFrame(0, { v: 1, client_id: DISCORD_ID }));
  });
  s.on('data', d => dData(d));
  s.on('error', () => { if (!opened) { s.destroy(); dConnect(i + 1); } });
  s.on('close', () => {
    if (!opened) return;
    dSock = null; dReady = false; dLast = ''; dBuf = Buffer.alloc(0);
    if (dWant) dSchedule(5000);
  });
}

function dData(d) {
  dBuf = Buffer.concat([dBuf, d]);
  while (dBuf.length >= 8) {
    const op = dBuf.readInt32LE(0), n = dBuf.readInt32LE(4);
    if (dBuf.length < 8 + n) break;
    let msg = null;
    try { msg = JSON.parse(dBuf.slice(8, 8 + n).toString('utf8')); } catch (e) {}
    dBuf = dBuf.slice(8 + n);
    if (op === 3 && dSock) dSock.write(dFrame(4, msg || {}));            // PING -> PONG
    else if (op === 2 && dSock) dSock.destroy();                          // CLOSE
    else if (op === 1 && msg && msg.evt === 'READY') { dReady = true; dSend(); }
  }
}

function dSend() {
  if (!dSock || !dReady) return;
  const key = JSON.stringify(dWant);
  if (key === dLast) return;
  dLast = key;
  dSock.write(dFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: dWant }, nonce: String(++dN) }));
}

function buildActivity(p) {
  const il = installLang();
  const vi = !il || il.lang === 'vi';
  const clip = (x, n) => String(x || '').slice(0, n);
  const pad = x => (x.length >= 2 ? x : x + ' ♪');
  const title = pad(clip(p.title, 120) || 'LYRIC');
  const artist = clip(p.artist, 100);
  const a = {
    type: 2,   // Listening
    details: title,
    state: pad(p.playing ? (artist || 'LYRIC') : ((artist ? artist + ' · ' : '') + (vi ? 'Tạm dừng' : 'Paused'))),
    assets: { large_image: 'lyric', large_text: 'LYRIC' },
    instance: false
  };
  if (p.playing && p.dur > 0 && isFinite(p.dur)) {
    const start = Math.round(Date.now() - (p.pos || 0) * 1000);
    a.timestamps = { start, end: Math.round(start + p.dur * 1000) };
  }
  return a;
}

ipcMain.on('presence', (e, p) => {
  if (!win || e.sender !== win.webContents) return;
  dWant = p && typeof p.title === 'string' ? buildActivity(p) : null;
  if (dSock && dReady) dSend();
  else if (dWant && !dSock && !dTimer) dConnect(0);
});

function dClose() {
  dWant = null;
  try { if (dSock && dReady) { dLast = ''; dSend(); dSock.end(); } } catch (e) {}
  clearTimeout(dTimer);
}

/* ===== Khay hệ thống + phím media ===== */
const ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFFElEQVR42rWXW4xeVRXHf2vtfc755lJGim3FS69SO4yapo2hA0hFUdFHk+FJSHnBYjGGGH1kmHeixBL0iZKoibHxgcRERU0EejH0pQ12WmgnTaFNA4Q6dC7n+76zz1o+zHTo2M4w0/lcyXk4t7X//3X577WFa21oKHDwYH319s5dT66ejE231BZuwjTm3tvdkNG+Cx/O+f2fNT5yPDysjIzY5+/90RrgcUEedLct7ibzvlueuag6yLsgR9zT/rHDz5+c9ecfAZhdfMvg3m9ryA5oLG53S7jVdMREUY1YXSU3+9nZI/ufZegh5eDBWq6GZNM9+76Zhfxlt4RZnQQUEekMAnd3TEQ05j1aNSdGxo7+6undu4ejALLtG/tWp6aMiugat9oQAv8fc5CkIWae0n1njjz3mgKemvLDkDXWmqV6OYurCjEEVBWWFizBXUEw7CkYVtm587HswyIe1ZDvsLpaMnsRoWy2aDYr8ig0Ghkac0QEdwf3hQsTwfHpKqUvxkta3tJF70b3WhB0acyV6bLFV+8aYHDHHZx8Z5pX/zVKa/widVUR8oIQstns23XYHXPR2BMz3xY15A7iy+pvEcqyxX13DbD34Qf4+xlobjCqD97kwqnX+eDtN5kafx8wQlYgcmNeYm7xpjtLhOmyRaprJicMyFi7uZ81m/ppTjW5fOEtLpw8zH8ujpGqckEp0ZWU9LVF6GZUZaJd1sSswae2fpldDz3Ol761h7pqL9jRsTO9JWRdSt6lVC2oayNNJ2gEYl4sTmLFbQ2sap/nxJ9e4OLp45ST48RcKbpzYhFmOmIRi50AUFDy9ol/cPnsEfLuPm5Zu57b1vezbks/brboVtKhFChZVy9Zo0HVLnnv3Bu8O3actw530Vh1KyHLF4xE7JjGmuFuiASyohtk5lk5cRnV0JkIqCoqEIMSgi4QWJ9Vwtl/QlxMFZcG4GoLTU6VtKtE1MD4lSlqW4J+rbQIVYV2lUip5p6vbGPXjq0Uecah10/R1chXnLr4cZLbalV8oq+XZ0ce5WuDA3Pv9u15kLLVnnEStfMABKjdiDHw4i+eYPvARmqzuYiqCI08W3EEdLGCm5go+d53d7F9YCNVSgRVYpi5VAWbRfNxYnNTAESEuja2brqd2mxBLTdzsiyuGIDfYIojzyOHjp0mqOLOHOOrxV3Xhqpw7PhZUqqXP0KKulrdkBtNQbUZq3q7+NurJ/j9S4fIYkBFMHPMHBHIs8gbp86z/8Cf6elpYLa8VIh7FvrW30vU+vui8TbcfJ5wuxCj8pd/HsfM2bxhHat6uxARJqeavPTyMZ58+gBXJkqKPFtGLQju3jaTZwRgy937fh2zxg9SVSYRideLkDN+ZZpPr7uVO+/4HCEo5955jzPnLtHTVZBlYens3U1DJnVd/XuslXYKIBvv/vHWTP2kuzl4uNH2FYLSbiearTbuUOSRRiPHzJfVBe7ejnl3ntL0I2OHnv9NYGgojP/1hfdXf3bnRCx6vmOpMgcXYd6RzN0JQSmKnEaRoUGXk3OfPZxUWdGbp6r849gDn3wKCIHRUWd4WC//9pmjfZ/ZLiFm96tm6phcL+QzbGcY+5JyPfOdiGgmIWsES60/NOvpvVd+9/OS83tc5o3riG8efOLrIepPcR9EpK8je7V5E5FTiP3yzGvPvXgtuvm53j0ceWUkAfTf/5MNVWp/YSbJdnNnRFEnFESRS6df6R2FEZslOqc9/wXpVlktuq7a6wAAAABJRU5ErkJggg==';
let tray = null;
let quitting = false;

function showWin() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function sendMedia(a) { if (win && rendererReady) win.webContents.send('media', a); }

function buildTray() {
  try {
    const il = installLang();
    const vi = !il || il.lang === 'vi';
    tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,' + ICON_B64));
    tray.setToolTip('LYRIC');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: vi ? 'Mở LYRIC' : 'Open LYRIC', click: showWin },
      { type: 'separator' },
      { label: vi ? 'Phát / Dừng' : 'Play / Pause', click: () => sendMedia('toggle') },
      { label: vi ? 'Bài trước' : 'Previous', click: () => sendMedia('prev') },
      { label: vi ? 'Bài sau' : 'Next', click: () => sendMedia('next') },
      { type: 'separator' },
      {
        label: vi ? 'Chạy nền khi đóng cửa sổ' : 'Keep running in tray when closed',
        type: 'checkbox',
        checked: cfg.closeToTray !== false,
        click: i => { cfg.closeToTray = i.checked; saveCfg(); }
      },
      { label: vi ? 'Thoát' : 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWin);
  } catch (e) { tray = null; }
}

function registerMediaKeys() {
  const keys = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev' };
  for (const k in keys) {
    try { globalShortcut.register(k, () => sendMedia(keys[k])); } catch (e) {}
  }
}

/* ===== Cửa sổ ===== */
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
  win.on('close', e => {
    // đóng cửa sổ thì thu xuống khay (nhạc vẫn phát) trừ khi chọn Thoát
    if (!quitting && tray && cfg.closeToTray !== false) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; rendererReady = false; stopWatch(); });
  const il = installLang();
  win.loadFile(path.join(__dirname, 'index.html'), il ? { query: { lang: il.lang, t: il.t } } : undefined);
}

const fromWin = e => win && e.sender === win.webContents;

ipcMain.on('renderer-ready', e => {
  if (!fromWin(e)) return;
  rendererReady = true;
  pending.splice(0).forEach(info => win.webContents.send('open-file', info));
});

ipcMain.handle('read-file', async (e, p) => {
  if (!fromWin(e)) throw new Error('not allowed');
  if (typeof p !== 'string' || !(allowed.has(p) || (READABLE.test(p) && insideMusicDir(p)))) throw new Error('not allowed');
  return fs.promises.readFile(p);
});

// Lưu lời tìm được online thành file .lrc cạnh bài hát (không ghi đè nếu đã có file lời cùng tên)
ipcMain.handle('save-lyric', async (e, p, text) => {
  if (!fromWin(e) || typeof p !== 'string' || typeof text !== 'string' || text.length > 2000000) return false;
  if (!AUDIO.test(p) || !(allowed.has(p) || insideMusicDir(p))) return false;
  const dir = path.dirname(p), stem = path.basename(p, path.extname(p));
  for (const x of LYRIC_EXT) if (fs.existsSync(path.join(dir, stem + x))) return false;
  try { await fs.promises.writeFile(path.join(dir, stem + '.lrc'), text, 'utf8'); return true; } catch (err) { return false; }
});

ipcMain.handle('lib-get', async e => {
  if (!fromWin(e)) return null;
  await initP;
  return { dir: cfg.musicDir || '' };
});

ipcMain.handle('lib-pick', async e => {
  if (!fromWin(e)) return null;
  const il = installLang();
  const vi = !il || il.lang === 'vi';
  const r = await dialog.showOpenDialog(win, {
    title: vi ? 'Chọn thư mục nhạc' : 'Choose music folder',
    buttonLabel: vi ? 'Chọn thư mục' : 'Choose folder',
    defaultPath: cfg.musicDir || app.getPath('music'),
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  cfg.musicDir = r.filePaths[0];
  saveCfg();
  if (wantWatch) startWatch();
  return cfg.musicDir;
});

ipcMain.handle('lib-scan', async e => {
  if (!fromWin(e)) return null;
  await initP;
  if (!cfg.musicDir || !isDir(cfg.musicDir)) return null;
  return scanMusic(cfg.musicDir);
});

ipcMain.on('lib-watch', (e, on) => {
  if (!fromWin(e)) return;
  wantWatch = !!on;
  if (wantWatch) startWatch(); else stopWatch();
});

/* ===== Khởi động (chỉ chạy 1 cửa sổ) ===== */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, cwd) => {
    showWin();
    openFiles(audioArgs(argv, cwd));
  });

  app.whenReady().then(() => {
    loadCfg();
    createWindow();
    buildTray();
    registerMediaKeys();
    initP = initMusicDir();
    openFiles(audioArgs(process.argv, process.cwd()));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { quitting = true; dClose(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
