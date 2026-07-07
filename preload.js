const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ===== 工具管理 =====

  // 获取工具配置（内置 + 自定义）
  getTools: () => ipcRenderer.invoke('get-tools'),

  // 检测所有工具版本
  checkVersions: () => ipcRenderer.invoke('check-versions'),

  // 检测单个工具版本
  checkVersion: (toolId) => ipcRenderer.invoke('check-version', toolId),

  // 更新单个工具
  updateTool: (toolId) => ipcRenderer.invoke('update-tool', toolId),

  // 安装单个工具（首次安装）
  installTool: (toolId) => ipcRenderer.invoke('install-tool', toolId),

  // 更新多个工具
  updateAll: (toolIds) => ipcRenderer.invoke('update-all', toolIds),

  // ===== 镜像源管理 =====

  // 获取可用镜像源列表
  getRegistries: () => ipcRenderer.invoke('get-registries'),

  // 获取当前镜像源
  getCurrentRegistry: () => ipcRenderer.invoke('get-current-registry'),

  // 切换镜像源
  setRegistry: (url) => ipcRenderer.invoke('set-registry', url),

  // ===== 自定义工具管理 =====

  // 添加自定义工具
  addCustomTool: (config) => ipcRenderer.invoke('add-custom-tool', config),

  // 移除自定义工具
  removeCustomTool: (toolId) => ipcRenderer.invoke('remove-custom-tool', toolId),

  // ===== 环境检测 =====

  // 检测 Node.js / npm 环境
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),

  // ===== 日志 =====

  // 导出日志到文件
  exportLog: (logText) => ipcRenderer.invoke('export-log', logText),

  // 复制文本到剪贴板
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // ===== 设置 =====

  // 获取设置
  getSettings: () => ipcRenderer.invoke('get-settings'),

  // 保存设置
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ===== 其它 =====

  // 显示管理员权限提示
  showAdminTip: () => ipcRenderer.invoke('show-admin-tip'),

  // 一键配置 agyyolo 到 PowerShell Profile
  installAgyyolo: () => ipcRenderer.invoke('install-agyyolo'),

  // 一键打开 PowerShell
  openPowerShell: () => ipcRenderer.invoke('open-powershell'),

  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 监听更新日志
  onUpdateLog: (callback) => {
    const wrapped = (event, data) => callback(data);
    ipcRenderer.on('update-log', wrapped);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('update-log', wrapped);
  },

  // 监听主进程触发的检测命令（从托盘菜单触发）
  onTriggerCheck: (callback) => {
    ipcRenderer.on('trigger-check', () => callback());
  },

  // 移除所有日志监听（方便重新绑定）
  removeAllLogListeners: () => {
    ipcRenderer.removeAllListeners('update-log');
    ipcRenderer.removeAllListeners('trigger-check');
  }
});
