const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

// ===== 镜像源配置 =====
const REGISTRIES = [
  { id: 'npm', name: 'npm 官方源', url: 'https://registry.npmjs.org/' },
  { id: 'npmmirror', name: '淘宝镜像源 (npmmirror)', url: 'https://registry.npmmirror.com/' },
];

// ===== 设置持久化 =====
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  const current = loadSettings();
  const merged = { ...current, ...settings };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), 'utf-8');
}

// 当前活跃的镜像源 URL
let currentRegistry = REGISTRIES[0].url;

// 从持久化配置中恢复用户上次选择的镜像源
try {
  const saved = loadSettings();
  if (saved.registry) {
    currentRegistry = saved.registry;
  }
} catch { /* 首次启动，无配置文件 */ }

// ===== 内置工具配置（不再硬编码 updateCmd，而是动态拼接当前镜像源） =====
const BUILTIN_TOOLS = [
  { id: 'kimi', name: 'Kimi Code', cmd: 'kimi', pkg: '@moonshot-ai/kimi-code', versionArg: '--version' },
  { id: 'claude', name: 'Claude Code', cmd: 'claude', pkg: '@anthropic-ai/claude-code', versionArg: '--version' },
  { id: 'codex', name: 'OpenAI Codex', cmd: 'codex', pkg: '@openai/codex', versionArg: '--version' },
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', pkg: 'opencode-ai', versionArg: '--version' },
  { id: 'codebuddy', name: 'CodeBuddy', cmd: 'codebuddy', pkg: '@tencent-ai/codebuddy-code', versionArg: '--version' },
  { id: 'qwen', name: 'Qwen Code', cmd: 'qwen', pkg: '@qwen-code/qwen-code', versionArg: '--version' },
  { id: 'antigravity', name: 'Antigravity CLI', cmd: 'agy', versionArg: '--version' },
  { id: 'atomcode', name: 'AtomCode', cmd: 'atomcode', versionArg: '--version' },
];

// ===== 自定义工具持久化 =====
function getCustomToolsPath() {
  return path.join(app.getPath('userData'), 'custom-tools.json');
}

function loadCustomTools() {
  try {
    const data = fs.readFileSync(getCustomToolsPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveCustomTools(tools) {
  fs.writeFileSync(getCustomToolsPath(), JSON.stringify(tools, null, 2), 'utf-8');
}

// 获取所有工具（内置 + 自定义），动态拼接当前镜像源生成 updateCmd
function getAllTools() {
  const custom = loadCustomTools();
  const all = [
    ...BUILTIN_TOOLS.map(t => ({ ...t, isCustom: false })),
    ...custom.map(t => ({ ...t, isCustom: true }))
  ];
  return all.map(t => {
    let updateCmd = '';
    if (t.id === 'antigravity') {
      if (os.platform() === 'win32') {
        updateCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"';
      } else {
        updateCmd = 'curl -sSL https://antigravity.google/cli/install.sh | bash';
      }
    } else if (t.id === 'atomcode') {
      if (os.platform() === 'win32') {
        updateCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.ps1 | iex"';
      } else {
        updateCmd = 'curl -fsSL https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh | sh';
      }
    } else if (t.pkg) {
      updateCmd = `npm install -g ${t.pkg}@latest --registry=${currentRegistry}`;
    }
    return {
      ...t,
      updateCmd
    };
  });
}

let mainWindow = null;
let tray = null;
let backgroundTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    show: false
  });

  // 彻底隐藏原生菜单栏
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 关闭窗口时最小化到托盘，而非真正退出
  mainWindow.on('close', (event) => {
    const settings = loadSettings();
    if (settings.minimizeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== 系统托盘 =====
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  try {
    tray = new Tray(iconPath);
  } catch {
    // 如果 ico 文件不存在，跳过托盘创建
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '立即检测更新',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        // 通知渲染进程执行检测
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('trigger-check');
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 真正退出应用
        tray.destroy();
        tray = null;
        app.exit(0);
      }
    }
  ]);

  tray.setToolTip('AI Code Tool Updater');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ===== 后台静默版本检测 =====
function startBackgroundCheck() {
  stopBackgroundCheck();
  const settings = loadSettings();
  const hours = settings.backgroundCheckHours || 4;
  if (hours <= 0) return;

  const intervalMs = hours * 60 * 60 * 1000;
  backgroundTimer = setInterval(async () => {
    try {
      const tools = getAllTools();
      const results = await Promise.all(tools.map(checkTool));
      const updatable = results.filter(r => r.needsUpdate);
      if (updatable.length > 0) {
        const names = updatable.map(t => t.name).join('、');
        const notification = new Notification({
          title: 'AI 工具有新版本可用',
          body: `${names} 有新版本，点击查看详情`,
          icon: path.join(__dirname, 'build', 'icon.png')
        });
        notification.on('click', () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        });
        notification.show();
      }
    } catch { /* 静默检测异常不做处理 */ }
  }, intervalMs);
}

function stopBackgroundCheck() {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  createWindow();
  createTray();
  startBackgroundCheck();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 如果托盘存在则不退出
    if (!tray) {
      app.quit();
    }
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 向渲染进程发送日志
function sendLog(type, toolId, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-log', { type, toolId, message, time: new Date().toLocaleTimeString() });
  }
}

// 版本检测子进程超时时间（毫秒）
const CHECK_TIMEOUT = 30000;

// 执行命令并返回输出字符串
function execCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const isWin = os.platform() === 'win32';
    let child;
    if (isWin && options.shell) {
      child = spawn('cmd.exe', ['/c', command, ...args], { env: process.env });
    } else {
      child = spawn(command, args, { env: process.env, shell: options.shell || false });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    // 超时保护：避免子进程卡住导致 Promise 永远不结束
    const timeoutMs = options.timeout || CHECK_TIMEOUT;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`命令执行超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (options.onData) options.onData(data.toString());
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (options.onData) options.onData(data.toString());
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') err.exitCode = 127;
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !options.ignoreError) {
        const err = new Error(stderr || stdout || `exit code ${code}`);
        err.exitCode = code;
        reject(err);
      } else {
        resolve(stdout || stderr);
      }
    });
  });
}

// 从版本输出中提取纯语义化版本号（部分 CLI 会在版本号前后附带工具名等文字，如
// "2.1.201 (Claude Code)" 或 "codex-cli 0.142.5"，需要先提纯再比较，否则永远判定为不相等）
function extractVersionNumber(text) {
  if (!text) return null;
  const match = text.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/);
  return match ? match[0] : text.trim();
}

// 判断命令执行失败是否是"命令不存在"（未安装），而非真正的异常（超时、权限等）
function isCommandNotFound(err) {
  if (!err) return false;
  if (err.exitCode === 127) return true; // ENOENT 或 shell 的标准"命令未找到"退出码
  const msg = err.message || '';
  if (os.platform() === 'win32') {
    return /不是内部或外部命令|不是可运行的程序|is not recognized as an internal or external command/i.test(msg);
  }
  return /command not found|不存在该命令/i.test(msg);
}

// 检测单个工具的本地版本
async function checkLocalVersion(tool) {
  // AtomCode 在 Windows 上安装到用户目录，可能不在 PATH，需要先尝试全路径
  if (tool.id === 'atomcode' && os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const fullPath = path.join(localAppData, 'AtomCode', 'atomcode.exe');
    const exists = fs.existsSync(fullPath);
    sendLog('info', 'atomcode', `检测本地路径: ${fullPath} (是否存在: ${exists})`);
    if (exists) {
      try {
        const output = await execCommand(fullPath, [tool.versionArg], { shell: false });
        const version = output.split(/\r?\n/)[0].trim();
        sendLog('info', 'atomcode', `检测到本地版本: ${version}`);
        return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
      } catch (err) {
        sendLog('error', 'atomcode', `执行全路径检测失败: ${err.message}`);
      }
    }
  }
  try {
    const output = await execCommand(tool.cmd, [tool.versionArg], { shell: true });
    const version = output.split(/\r?\n/)[0].trim();
    return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
  } catch (err) {
    return { installed: false, version: null, normalizedVersion: null, notFound: isCommandNotFound(err), error: err.message };
  }
}
function getAntigravityPlatform() {
  const platform = os.platform();
  const arch = os.arch();
  let osStr = '';
  let archStr = '';

  if (platform === 'win32') {
    osStr = 'windows';
  } else if (platform === 'darwin') {
    osStr = 'darwin';
  } else if (platform === 'linux') {
    osStr = 'linux';
  } else {
    osStr = 'linux'; // fallback
  }

  if (arch === 'arm64') {
    archStr = 'arm64';
  } else {
    archStr = 'amd64'; // fallback
  }

  return `${osStr}_${archStr}`;
}

// 检测单个 npm 包的最新版本
async function checkLatestVersion(tool) {
  if (tool.id === 'antigravity') {
    try {
      const platform = getAntigravityPlatform();
      const res = await fetch(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`);
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const manifest = await res.json();
      return { latest: manifest.version };
    } catch (err) {
      try {
        const res = await fetch('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json');
        const manifest = await res.json();
        return { latest: manifest.version };
      } catch (innerErr) {
        return { latest: null, error: innerErr.message };
      }
    }
  }

  // AtomCode 通过 AtomGit API 获取线上最新 release 版本
  if (tool.id === 'atomcode') {
    try {
      const res = await fetch('https://api.atomgit.com/api/v5/repos/atomgit_atomcode/atomcode/releases/latest', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      return { latest: data.tag_name || 'v4.25.9' };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  }

  try {
    const output = await execCommand('npm', ['view', tool.pkg, 'version', `--registry=${currentRegistry}`], { shell: true });
    return { latest: output.trim() };
  } catch (err) {
    return { latest: null, error: err.message };
  }
}

// 检测单个工具（本地版本与远端版本并行）
async function checkTool(tool) {
  sendLog('info', tool.id, `正在检测 ${tool.name} ...`);
  const [local, remote] = await Promise.all([
    checkLocalVersion(tool),
    checkLatestVersion(tool)
  ]);
  const result = {
    ...tool,
    installed: local.installed,
    currentVersion: local.version,
    latestVersion: remote.latest,
    notFound: local.notFound,
    error: local.error || remote.error,
    needsUpdate: !!(local.installed && local.normalizedVersion && remote.latest && local.normalizedVersion !== extractVersionNumber(remote.latest))
  };
  sendLog('success', tool.id, `${tool.name}: ${local.installed ? local.version : '未安装'} -> ${remote.latest || '检测失败'}`);
  return result;
}

// 执行单个工具的安装或更新（共用逻辑）
async function doInstallOrUpdate(toolId) {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  sendLog('start', tool.id, `开始安装/更新 ${tool.name} ...`);

  const isWin = os.platform() === 'win32';
  let shellCmd;
  let shellArgs;

  if (isWin) {
    if (tool.id === 'antigravity') {
      const localStatus = await checkLocalVersion(tool);
      if (localStatus.installed) {
        shellCmd = 'cmd.exe';
        shellArgs = ['/c', 'agy update'];
      } else {
        shellCmd = 'powershell.exe';
        shellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'];
      }
    } else if (tool.id === 'atomcode') {
      shellCmd = 'powershell.exe';
      // 先强制结束正在运行的 atomcode.exe（否则安装脚本无法覆盖文件），再安装，最后写 PATH
      shellArgs = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Write-Host '[AtomCode] Stopping running atomcode process...'; ` +
        `taskkill /f /im atomcode.exe 2>$null | Out-Null; ` +
        `Start-Sleep -Milliseconds 800; ` +
        `irm https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.ps1 | iex; ` +
        `$atomDir = Join-Path $env:LOCALAPPDATA 'AtomCode'; ` +
        `$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User'); ` +
        `if ($userPath -notlike "*$atomDir*") { ` +
        `  [Environment]::SetEnvironmentVariable('PATH', "$userPath;$atomDir", 'User'); ` +
        `  Write-Host '[AtomCode] Added atomcode dir to user PATH' ` +
        `}`
      ];
    } else {
      shellCmd = 'cmd.exe';
      shellArgs = ['/c', tool.updateCmd];
    }
  } else {
    if (tool.id === 'antigravity') {
      const localStatus = await checkLocalVersion(tool);
      if (localStatus.installed) {
        shellCmd = 'sh';
        shellArgs = ['-c', 'agy update'];
      } else {
        shellCmd = 'sh';
        shellArgs = ['-c', 'curl -sSL https://antigravity.google/cli/install.sh | bash'];
      }
    } else if (tool.id === 'atomcode') {
      shellCmd = 'sh';
      shellArgs = ['-c', 'curl -fsSL https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh | sh'];
    } else {
      shellCmd = 'sh';
      shellArgs = ['-c', tool.updateCmd];
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(shellCmd, shellArgs, {
      env: { ...process.env, NPM_CONFIG_REGISTRY: currentRegistry }
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      sendLog('data', tool.id, text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      sendLog('data', tool.id, text);
    });

    child.on('error', (err) => {
      sendLog('error', tool.id, `操作失败: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        sendLog('success', tool.id, `${tool.name} 操作完成`);
        resolve({ success: true });
      } else {
        const msg = `退出码: ${code}（Windows 上可能需要以管理员身份运行）`;
        sendLog('error', tool.id, msg);
        resolve({ success: false, code, message: msg });
      }
    });
  });
}

// ===== IPC 处理程序 =====

// 获取工具配置（内置 + 自定义，带当前镜像源）
ipcMain.handle('get-tools', () => getAllTools());

// 批量检测版本（所有工具并行）
ipcMain.handle('check-versions', async () => {
  const tools = getAllTools();
  return Promise.all(tools.map(checkTool));
});

// 检测单个工具版本
ipcMain.handle('check-version', async (event, toolId) => {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');
  return checkTool(tool);
});

// 更新单个工具
ipcMain.handle('update-tool', async (event, toolId) => {
  return doInstallOrUpdate(toolId);
});

// 安装单个工具（逻辑与更新相同，npm install -g 同时适用于首次安装和升级）
ipcMain.handle('install-tool', async (event, toolId) => {
  return doInstallOrUpdate(toolId);
});

// 更新全部可更新工具
ipcMain.handle('update-all', async (event, toolIds) => {
  const results = [];
  for (const toolId of toolIds) {
    try {
      const result = await doInstallOrUpdate(toolId);
      results.push({ toolId, ...result });
    } catch (err) {
      results.push({ toolId, success: false, message: err.message });
    }
  }
  return results;
});

// ===== 镜像源相关 IPC =====

ipcMain.handle('get-registries', () => REGISTRIES);

ipcMain.handle('get-current-registry', () => currentRegistry);

ipcMain.handle('set-registry', (event, url) => {
  currentRegistry = url;
  saveSettings({ registry: url });
  sendLog('info', 'system', `镜像源已切换为: ${url}`);
  return { success: true };
});

// ===== 自定义工具 IPC =====

ipcMain.handle('add-custom-tool', (event, toolConfig) => {
  const custom = loadCustomTools();
  // 生成唯一 id
  const id = 'custom_' + Date.now();
  const newTool = {
    id,
    name: toolConfig.name,
    cmd: toolConfig.cmd,
    pkg: toolConfig.pkg,
    versionArg: toolConfig.versionArg || '--version'
  };
  custom.push(newTool);
  saveCustomTools(custom);
  sendLog('info', 'system', `已添加自定义工具: ${newTool.name}`);
  return { success: true, tool: newTool };
});

ipcMain.handle('remove-custom-tool', (event, toolId) => {
  let custom = loadCustomTools();
  const removed = custom.find(t => t.id === toolId);
  custom = custom.filter(t => t.id !== toolId);
  saveCustomTools(custom);
  if (removed) {
    sendLog('info', 'system', `已移除自定义工具: ${removed.name}`);
  }
  return { success: true };
});

// ===== 环境健康检测 IPC =====

ipcMain.handle('check-environment', async () => {
  const result = { node: null, npm: null, os: null, errors: [] };

  try {
    const nodeOutput = await execCommand('node', ['-v'], { shell: true, timeout: 10000 });
    result.node = nodeOutput.trim();
  } catch {
    result.errors.push('未检测到 Node.js，请先安装 Node.js (https://nodejs.org)');
  }

  try {
    const npmOutput = await execCommand('npm', ['-v'], { shell: true, timeout: 10000 });
    result.npm = npmOutput.trim();
  } catch {
    result.errors.push('未检测到 npm，请检查 Node.js 安装是否完整');
  }

  // 获取 Windows 版本
  try {
    result.os = `Windows ${os.release()}`;
  } catch {
    result.os = os.platform();
  }

  // 检查 Node 版本是否过低（要求 >= 18）
  if (result.node) {
    const match = result.node.match(/v?(\d+)/);
    if (match && parseInt(match[1]) < 18) {
      result.errors.push(`Node.js 版本过低 (${result.node})，建议升级到 v18 或更高版本`);
    }
  }

  return result;
});

// ===== 日志导出 IPC =====

ipcMain.handle('export-log', async (event, logText) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出日志',
    defaultPath: `ai-tool-updater-log-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  });
  if (filePath) {
    fs.writeFileSync(filePath, logText, 'utf-8');
    sendLog('success', 'system', `日志已导出到: ${filePath}`);
    return { success: true, filePath };
  }
  return { success: false };
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

// ===== 管理员权限提示 IPC =====

ipcMain.handle('show-admin-tip', async () => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '需要管理员权限',
    message: '在 Windows 上全局安装 npm 包可能需要管理员权限。\n\n如果更新失败，请右键点击 updateTool.exe 选择「以管理员身份运行」。',
    buttons: ['知道了']
  });
});

// ===== 打开外部链接 IPC =====

ipcMain.handle('open-external', async (event, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不允许的协议: ${parsed.protocol}`);
    }
  } catch (err) {
    sendLog('error', 'system', `拒绝打开链接: ${err.message}`);
    return { success: false, message: err.message };
  }
  const { shell } = require('electron');
  await shell.openExternal(url);
  return { success: true };
});

// ===== 设置 IPC =====

ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('save-settings', (event, newSettings) => {
  saveSettings(newSettings);
  // 如果后台检测间隔有变化，重新启动定时器
  if ('backgroundCheckHours' in newSettings) {
    startBackgroundCheck();
  }
  return { success: true };
});

// ===== 一键配置 agyyolo 到 PowerShell Profile =====

const AGYYOLO_FUNCTION_BODY = `function agyyolo {\n    agy --dangerously-skip-permissions\n}\n`;

function getPowerShellProfiles() {
  const home = os.homedir();
  return [
    path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
  ];
}

function ensureProfile(profilePath) {
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, '', 'utf-8');
  }
  return profilePath;
}

function installAgyyoloToProfile(profilePath) {
  if (!profilePath) {
    return { ok: false, reason: 'Profile 路径为空' };
  }

  ensureProfile(profilePath);

  const content = fs.readFileSync(profilePath, 'utf-8');
  if (/function\s+agyyolo\b/.test(content)) {
    return { ok: true, reason: '已存在，跳过' };
  }

  const ending = content && !content.endsWith('\n') ? '\n\n' : '';
  fs.writeFileSync(profilePath, content + ending + AGYYOLO_FUNCTION_BODY, 'utf-8');
  return { ok: true, reason: '已写入' };
}

ipcMain.handle('install-agyyolo', async () => {
  // 先检测 agy 是否安装
  let agyFound = false;
  try {
    await execCommand('agy', ['--version'], { shell: true, timeout: 10000 });
    agyFound = true;
  } catch {
    agyFound = false;
  }

  if (!agyFound) {
    const message = '未检测到 agy 命令，请先安装 agy 并将其所在目录加入系统 PATH，再执行配置。';
    sendLog('error', 'system', message);
    return { success: false, agyFound: false, results: [], message };
  }

  sendLog('info', 'system', 'agy 命令已找到，开始将 agyyolo 配置到 PowerShell Profile ...');

  const results = [];
  const seen = new Set();

  for (const profilePath of getPowerShellProfiles()) {
    const key = profilePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const result = installAgyyoloToProfile(profilePath);
      results.push({ profile: profilePath, ...result });
      sendLog(result.ok ? 'success' : 'error', 'system', `[${result.ok ? 'OK' : 'FAIL'}] ${profilePath} - ${result.reason}`);
    } catch (err) {
      results.push({ profile: profilePath, ok: false, reason: err.message });
      sendLog('error', 'system', `[FAIL] ${profilePath} - ${err.message}`);
    }
  }

  sendLog('success', 'system', 'agyyolo 配置完成。请重新打开 PowerShell 窗口使用 agyyolo。');

  return { success: true, results, agyFound: true };
});

// ===== 一键打开 PowerShell IPC =====

ipcMain.handle('open-powershell', async () => {
  const isWin = os.platform() === 'win32';
  const { spawn } = require('child_process');

  if (isWin) {
    try {
      const child = spawn('cmd.exe', ['/c', 'start powershell'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  } else {
    // macOS or Linux
    if (os.platform() === 'darwin') {
      try {
        const child = spawn('osascript', ['-e', 'tell application "Terminal" to do script ""', '-e', 'tell application "Terminal" to activate'], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    } else {
      // Linux
      try {
        const child = spawn('x-terminal-emulator', [], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }
});

