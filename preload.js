const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 获取工具配置
  getTools: () => ipcRenderer.invoke('get-tools'),

  // 检测所有工具版本
  checkVersions: () => ipcRenderer.invoke('check-versions'),

  // 检测单个工具版本
  checkVersion: (toolId) => ipcRenderer.invoke('check-version', toolId),

  // 更新单个工具
  updateTool: (toolId) => ipcRenderer.invoke('update-tool', toolId),

  // 更新多个工具
  updateAll: (toolIds) => ipcRenderer.invoke('update-all', toolIds),

  // 显示管理员权限提示
  showAdminTip: () => ipcRenderer.invoke('show-admin-tip'),

  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 监听更新日志
  onUpdateLog: (callback) => {
    const wrapped = (event, data) => callback(data);
    ipcRenderer.on('update-log', wrapped);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('update-log', wrapped);
  },

  // 移除所有日志监听（方便重新绑定）
  removeAllLogListeners: () => ipcRenderer.removeAllListeners('update-log')
});
