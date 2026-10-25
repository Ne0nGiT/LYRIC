const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricApp', {
  // nhận file nhạc do Windows mở bằng LYRIC (Open with / Default apps)
  onOpenFile: cb => ipcRenderer.on('open-file', (_e, info) => cb(info)),
  // đọc nội dung file (chỉ file do Windows đưa vào)
  readFile: p => ipcRenderer.invoke('read-file', p),
  // báo giao diện đã sẵn sàng nhận file
  ready: () => ipcRenderer.send('renderer-ready')
});
