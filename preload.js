const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricApp', {
  // nhận file nhạc do Windows mở bằng LYRIC (Open with / Default apps)
  onOpenFile: cb => ipcRenderer.on('open-file', (_e, info) => cb(info)),
  // đọc nội dung file (file do Windows đưa vào hoặc nằm trong thư mục nhạc)
  readFile: p => ipcRenderer.invoke('read-file', p),
  // báo giao diện đã sẵn sàng nhận file
  ready: () => ipcRenderer.send('renderer-ready'),
  // thư mục nhạc mặc định
  libGet: () => ipcRenderer.invoke('lib-get'),
  libPick: () => ipcRenderer.invoke('lib-pick'),
  libScan: () => ipcRenderer.invoke('lib-scan'),
  libWatch: on => ipcRenderer.send('lib-watch', !!on),
  onLibChanged: cb => ipcRenderer.on('lib-changed', () => cb()),
  // lưu lời online thành file .lrc cạnh bài hát
  saveLyric: (p, text) => ipcRenderer.invoke('save-lyric', p, text),
  // trạng thái Discord Rich Presence (null = xóa)
  setPresence: p => ipcRenderer.send('presence', p),
  // phím media / menu khay: 'toggle' | 'next' | 'prev'
  onMedia: cb => ipcRenderer.on('media', (_e, a) => cb(a))
});
