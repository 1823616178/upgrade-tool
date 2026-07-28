// ===== Electron 主进程入口 =====
// 依赖：electron（应用框架）、path/fs（文件操作）、child_process（执行系统命令）、os（系统信息）
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

// ===== 镜像源配置 =====
// 支持 npm 官方源和淘宝镜像源，用户可在设置中切换
const REGISTRIES = [
  { id: 'npm', name: 'npm 官方源', url: 'https://registry.npmjs.org/' },
  { id: 'npmmirror', name: '淘宝镜像源 (npmmirror)', url: 'https://registry.npmmirror.com/' },
];

// ===== 设置持久化 =====
// 用户设置（镜像源、后台检测间隔等）保存在 userData/settings.json
// 使用内存缓存避免高频磁盘读取

let _settingsCache = null; // 内存缓存，null 表示尚未加载

/**
 * 获取设置文件的完整路径
 * @returns {string} settings.json 的绝对路径
 */
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 从内存缓存（或磁盘）加载用户设置
 * 首次调用从磁盘读取并缓存，之后直接返回缓存副本
 * @returns {object} 解析后的设置对象
 */
function loadSettings() {
  if (_settingsCache !== null) {
    return { ..._settingsCache }; // 返回副本，防止外部修改污染缓存
  }
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf-8');
    _settingsCache = JSON.parse(data);
  } catch {
    _settingsCache = {};
  }
  return { ..._settingsCache };
}

/**
 * 将新设置合并到缓存并异步写入磁盘
 * @param {object} settings - 需要保存的部分设置
 */
function saveSettings(settings) {
  if (_settingsCache === null) loadSettings(); // 确保缓存已初始化
  _settingsCache = { ..._settingsCache, ...settings };
  // 异步写入磁盘，避免阻塞主线程
  fs.writeFile(getSettingsPath(), JSON.stringify(_settingsCache, null, 2), 'utf-8', (err) => {
    if (err) console.error('[settings] 写入失败:', err.message);
  });
}

// 当前活跃的镜像源 URL，默认使用第一个（npm 官方源）
let currentRegistry = REGISTRIES[0].url;

// 从持久化配置中恢复用户上次选择的镜像源
try {
  const saved = loadSettings();
  if (saved.registry) {
    currentRegistry = saved.registry;
  }
} catch { /* 首次启动，无配置文件，使用默认值 */ }

// ===== 内置工具配置 =====
// 预定义的 AI 编码工具列表，包含 CLI 命令名和对应的 npm 包名
// updateCmd 不再硬编码，而是根据当前镜像源动态生成（见 getAllTools）
// installScript: { win, unix } — 脚本安装类工具的安装命令（数据驱动，消除 doInstallOrUpdate 中的 if/else 链）
const BUILTIN_TOOLS = [
  { id: 'kimi',       name: 'Kimi Code',              cmd: 'kimi',       pkg: '@moonshot-ai/kimi-code',        versionArg: '--version' },
  { id: 'claude',     name: 'Claude Code',             cmd: 'claude',     pkg: '@anthropic-ai/claude-code',     versionArg: '--version' },
  { id: 'codex',      name: 'OpenAI Codex',            cmd: 'codex',      pkg: '@openai/codex',                 versionArg: '--version' },
  { id: 'opencode',   name: 'OpenCode',                cmd: 'opencode',   pkg: 'opencode-ai',                   versionArg: '--version' },
  { id: 'codebuddy',  name: 'CodeBuddy',               cmd: 'codebuddy',  pkg: '@tencent-ai/codebuddy-code',    versionArg: '--version' },
  { id: 'qwen',       name: 'Qwen Code',               cmd: 'qwen',       pkg: '@qwen-code/qwen-code',          versionArg: '--version' },
  {
    // antigravity 使用独立的安装脚本；已安装时改用 agy update（在 doInstallOrUpdate 中特判）
    id: 'antigravity', name: 'Antigravity CLI', cmd: 'agy', versionArg: '--version',
    installScript: {
      win:  'Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue; irm https://antigravity.google/cli/install.ps1 | iex',
      unix: 'curl -sSL https://antigravity.google/cli/install.sh | bash'
    },
    docsUrl: 'https://antigravity.google/'
  },
  {
    id: 'atomcode', name: 'AtomCode', cmd: 'atomcode', versionArg: '--version',
    installScript: {
      // 先终止正在运行的进程再安装，最后写 PATH
      win:  'Write-Host \'[AtomCode] Stopping running atomcode process...\'; taskkill /f /im atomcode.exe 2>$null | Out-Null; Start-Sleep -Milliseconds 800; Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue; irm https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.ps1 | iex; $atomDir = Join-Path $env:LOCALAPPDATA \'AtomCode\'; $userPath = [Environment]::GetEnvironmentVariable(\'PATH\', \'User\'); if ($userPath -notlike "*$atomDir*") { [Environment]::SetEnvironmentVariable(\'PATH\', "$userPath;$atomDir", \'User\'); Write-Host \'[AtomCode] Added atomcode dir to user PATH\' }',
      unix: 'curl -fsSL https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh | sh'
    },
    docsUrl: 'https://atomgit.com/'
  },
  {
    id: 'qoder', name: 'Qoder CLI', cmd: 'qodercli', pkg: '@qoder-ai/qodercli', versionArg: '--version',
    installScript: {
      win:  'Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue; irm https://qoder.com/install.ps1 | iex',
      unix: 'curl -fsSL https://qoder.com/install | bash'
    },
    docsUrl: 'https://qoder.com/'
  },
  {
    // qoder_cn 安装的是 qoderclicn 命令，与国际版 qodercli 不同
    id: 'qoder_cn', name: 'Qoder CLI (国内镜像)', cmd: 'qoderclicn', versionArg: '--version',
    installScript: {
      win:  'Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue; irm https://qoder.com.cn/install.ps1 | iex',
      unix: 'curl -fsSL https://qoder.com.cn/install | bash'
    },
    docsUrl: 'https://qoder.com.cn/'
  },
  {
    // grok 使用 xAI 官方安装脚本，不通过 npm 安装
    id: 'grok', name: 'Grok CLI', cmd: 'grok', versionArg: '--version',
    installScript: {
      win:  'Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue; irm https://x.ai/cli/install.ps1 | iex',
      unix: 'curl -fsSL https://x.ai/cli/install | bash'
    },
    docsUrl: 'https://x.ai/'
  },
];

// 通过官方安装脚本安装的工具（用于判断是否支持自动卸载）
// 直接从 BUILTIN_TOOLS 中提取有 installScript 的工具 ID
const SCRIPT_INSTALLED_TOOLS = Object.fromEntries(
  BUILTIN_TOOLS
    .filter(t => t.installScript)
    .map(t => [t.id, { docsUrl: t.docsUrl || '' }])
);

// ===== 自定义工具持久化 =====
// 用户自定义的工具列表保存在 userData/custom-tools.json

/**
 * 获取自定义工具文件的完整路径
 * @returns {string} custom-tools.json 的绝对路径
 */
function getCustomToolsPath() {
  return path.join(app.getPath('userData'), 'custom-tools.json');
}

/**
 * 从磁盘加载自定义工具列表
 * @returns {object[]} 自定义工具数组，文件不存在时返回空数组
 */
function loadCustomTools() {
  try {
    const data = fs.readFileSync(getCustomToolsPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * 将自定义工具列表写入磁盘
 * @param {object[]} tools - 要保存的工具数组
 */
function saveCustomTools(tools) {
  fs.writeFileSync(getCustomToolsPath(), JSON.stringify(tools, null, 2), 'utf-8');
}

/**
 * 获取所有工具（内置 + 自定义），并根据当前镜像源动态生成 updateCmd
 * - 普通 npm 工具：npm install -g <pkg>@latest --registry=<当前镜像源>
 * - antigravity：使用官方安装脚本（Windows 用 PowerShell，其他用 curl|bash）
 * @returns {object[]} 合并后的工具列表，每个工具附带 isCustom 和 updateCmd 字段
 */
function getAllTools() {
  const custom = loadCustomTools();
  const all = [
    ...BUILTIN_TOOLS.map(t => ({ ...t, isCustom: false })),
    ...custom.map(t => ({ ...t, isCustom: true }))
  ];
  return all.map(t => {
    let updateCmd = '';
    if (t.id === 'antigravity') {
      // antigravity 使用独立安装脚本，不走 npm
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
    } else if (t.id === 'qoder') {
      if (os.platform() === 'win32') {
        updateCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://qoder.com/install.ps1 | iex"';
      } else {
        updateCmd = 'curl -fsSL https://qoder.com/install | bash';
      }
    } else if (t.id === 'qoder_cn') {
      if (os.platform() === 'win32') {
        updateCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://qoder.com.cn/install.ps1 | iex"';
      } else {
        updateCmd = 'curl -fsSL https://qoder.com.cn/install | bash';
      }
    } else if (t.id === 'grok') {
      if (os.platform() === 'win32') {
        updateCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"';
      } else {
        updateCmd = 'curl -fsSL https://x.ai/cli/install | bash';
      }
    } else if (t.pkg) {
      // 普通 npm 全局安装命令，镜像源从当前配置动态拼接
      updateCmd = `npm install -g ${t.pkg}@latest --registry=${currentRegistry}`;
    }
    return {
      ...t,
      updateCmd,
      // 脚本安装工具附带官网链接（渲染层 changelog 入口）；npm 工具由渲染层用 pkg 拼 npmjs 链接
      docsUrl: SCRIPT_INSTALLED_TOOLS[t.id] ? SCRIPT_INSTALLED_TOOLS[t.id].docsUrl : null
    };
  });
}

// ===== 全局状态变量 =====
let mainWindow = null;    // 主窗口实例
let tray = null;          // 系统托盘实例
let backgroundTimer = null; // 后台版本检测定时器引用

/**
 * 创建主应用窗口
 * - 设置窗口尺寸、最小尺寸、图标
 * - 启用 contextIsolation 安全策略，通过 preload.js 暴露 API
 * - 加载 index.html 作为 UI
 * - 关闭窗口时根据设置决定是否最小化到托盘
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,    // 禁止渲染进程直接访问 Node.js
      contextIsolation: true,    // 隔离 preload 和渲染进程上下文
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    show: false // 先隐藏，等 ready-to-show 再显示，避免白屏闪烁
  });

  // 彻底隐藏原生菜单栏（不使用默认菜单）
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 页面加载完成后显示窗口
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 关闭窗口时最小化到托盘（如果用户开启了该选项且托盘已创建）
  mainWindow.on('close', (event) => {
    const settings = loadSettings();
    if (settings.minimizeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // 用户未开启"最小化到托盘"：关窗即退出，先销毁托盘避免应用变僵尸进程
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  // 窗口被销毁后清理引用
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 显示已有窗口或重建新窗口（窗口被销毁后，托盘动作仍可恢复界面）
 * @returns {BrowserWindow|null}
 */
function showOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  createWindow();
  return mainWindow;
}

/**
 * 向渲染进程发送"立即检测"指令
 * 窗口刚重建时页面尚未加载完成，等 did-finish-load 再发，避免渲染进程未绑定监听而丢消息
 */
function sendTriggerCheck() {
  const win = showOrCreateWindow();
  if (!win) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('trigger-check');
      }
    });
  } else {
    win.webContents.send('trigger-check');
  }
}

// ===== 系统托盘 =====

/**
 * 创建系统托盘图标及右键菜单
 * - 左键双击：显示并聚焦主窗口
 * - 右键菜单：显示主窗口 / 立即检测更新 / 退出应用
 * - 如果图标文件不存在则静默跳过
 */
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  try {
    tray = new Tray(iconPath);
  } catch {
    // 如果 ico 文件不存在，跳过托盘创建
    return;
  }

  // 构建右键上下文菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        showOrCreateWindow();
      }
    },
    {
      label: '立即检测更新',
      click: () => {
        sendTriggerCheck();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 真正退出应用（销毁托盘后调用 app.exit）
        tray.destroy();
        tray = null;
        app.exit(0);
      }
    }
  ]);

  tray.setToolTip('AI Code Tool Updater');
  tray.setContextMenu(contextMenu);

  // 双击托盘图标恢复窗口（窗口已销毁时重建）
  tray.on('double-click', () => {
    showOrCreateWindow();
  });
}

// ===== 后台静默版本检测 =====

/**
 * 启动后台定时检测任务
 * - 读取用户设置的检测间隔（默认 4 小时，设为 0 则禁用）
 * - 定时检测所有工具版本，有新版本时弹出系统通知
 */
function startBackgroundCheck() {
  stopBackgroundCheck(); // 先清除已有定时器，避免重复
  const settings = loadSettings();
  // 注意：0 表示禁用，不能用 || 否则 0 会被当成 falsy 回退到 4
  const hours = settings.backgroundCheckHours ?? 4;
  if (hours <= 0) return; // 用户禁用了后台检测

  const intervalMs = hours * 60 * 60 * 1000;
  backgroundTimer = setInterval(async () => {
    try {
      const tools = getAllTools();
      // 后台定时检测静默执行（不刷日志窗口），仅在有更新时弹系统通知
      const results = await Promise.all(tools.map(t => checkTool(t, { silent: true })));
      const updatable = results.filter(r => r.needsUpdate);
      if (updatable.length > 0) {
        const names = updatable.map(t => t.name).join('、');
        const firstUpdatableId = updatable[0].id; // 通知点击后高亮第一个可更新的工具
        const notification = new Notification({
          title: 'AI 工具有新版本可用',
          body: `${names} 有新版本，点击查看详情`,
          icon: path.join(__dirname, 'build', 'icon.png')
        });
        notification.on('click', () => {
          // 显示主窗口并送送高亮指令到渲染进程
          const win = showOrCreateWindow();
          if (win) {
            const sendHighlight = () => {
              if (!win.isDestroyed()) {
                win.webContents.send('highlight-tool', firstUpdatableId);
              }
            };
            if (win.webContents.isLoading()) {
              win.webContents.once('did-finish-load', sendHighlight);
            } else {
              sendHighlight();
            }
          }
        });
        notification.show();
      }
    } catch { /* 静默检测异常不做处理，等待下次定时 */ }
  }, intervalMs);
}

/**
 * 停止后台版本检测定时器
 */
function stopBackgroundCheck() {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// ===== 应用生命周期 =====

/**
 * 应用/取消开机自启动
 * 仅打包版生效：dev 模式下 setLoginItemSettings 会指向 electron.exe，直接跳过
 * @param {boolean} openAtLogin
 */
function applyLoginItem(openAtLogin) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!openAtLogin });
  } catch { /* 平台不支持时静默忽略 */ }
}

// Electron 就绪后创建窗口、托盘并启动后台检测
app.whenReady().then(() => {
  createWindow();
  createTray();
  startBackgroundCheck();
  // 恢复用户的开机自启动设置（仅打包版实际生效）
  const settings = loadSettings();
  if (settings.openAtLogin) {
    applyLoginItem(true);
  }
});

// 所有窗口关闭时：如果托盘存在则保持运行（最小化到托盘），否则退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!tray) {
      app.quit();
    }
  }
});

// macOS 上点击 Dock 图标时重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ===== 日志发送工具 =====

/**
 * 向渲染进程发送日志消息（通过 update-log 通道）
 * @param {string} type - 日志类型：info / success / error / start / data
 * @param {string} toolId - 关联的工具 ID（系统日志用 'system'）
 * @param {string} message - 日志内容
 */
function sendLog(type, toolId, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-log', { type, toolId, message, time: new Date().toLocaleTimeString() });
  }
}

// ===== 命令执行工具 =====

// 版本检测子进程超时时间（毫秒），防止命令卡住
const CHECK_TIMEOUT = 30000;

/**
 * 执行系统命令并返回 stdout 输出
 * - Windows 下支持通过 cmd.exe 执行 shell 命令
 * - 内置超时保护，超时后自动终止子进程
 * - 支持 onData 回调实时获取输出（用于安装进度显示）
 * @param {string} command - 要执行的命令
 * @param {string[]} args - 命令参数
 * @param {object} options - { shell, timeout, ignoreError, onData }
 * @returns {Promise<string>} 命令的标准输出
 */
function execCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const isWin = os.platform() === 'win32';
    let child;
    if (isWin && options.shell) {
      // Windows 下通过 cmd.exe 执行，支持 .bat/.cmd 等
      child = spawn('cmd.exe', ['/c', command, ...args], { env: process.env });
    } else {
      child = spawn(command, args, { env: process.env, shell: options.shell || false });
    }

    let stdout = '';
    let stderr = '';
    let settled = false; // 防止超时和 close 事件竞争

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
      // ENOENT 表示命令不存在，统一用 127 退出码标识
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

// ===== 版本号处理工具 =====

/**
 * 从版本输出中提取纯语义化版本号
 * 部分 CLI 会在版本号前后附带工具名等文字，如 "2.1.201 (Claude Code)" 或 "codex-cli 0.142.5"
 * 需要先提纯再比较，否则永远判定为不相等
 * @param {string} text - 原始版本输出文本
 * @returns {string|null} 提取到的版本号（如 "1.2.3"），未匹配则返回 null
 */
function extractVersionNumber(text) {
  if (!text) return null;
  const match = String(text).match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)/i);
  return match ? match[1] : null;
}

/**
 * 解析 semver：major.minor.patch + 预发布标识（构建元数据 +xxx 按 semver 规则忽略）
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, prerelease: string|null }|null}
 */
function parseSemver(version) {
  if (!version) return null;
  const cleaned = String(version).trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null
  };
}

/**
 * 按 semver 规则比较预发布标识
 * 无预发布 > 有预发布；逐段比较：数字段数值比（数字 < 字母），字母段 ASCII 字典序；段数少者更小
 * @param {string|null} a
 * @param {string|null} b
 * @returns {number} -1 / 0 / 1
 */
function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const xa = pa[i];
    const xb = pb[i];
    const na = /^\d+$/.test(xa) ? parseInt(xa, 10) : null;
    const nb = /^\d+$/.test(xb) ? parseInt(xb, 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个版本号（含预发布规则）
 * @returns {number|null} -1: a<b, 0: a==b, 1: a>b, null: 无法比较
 */
function compareSemver(a, b) {
  const pa = parseSemver(extractVersionNumber(a) || a);
  const pb = parseSemver(extractVersionNumber(b) || b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * 远端版本是否比本地更新（仅当明确更新时返回 true）
 */
function isRemoteNewer(localVersion, remoteVersion) {
  const cmp = compareSemver(localVersion, remoteVersion);
  return cmp === -1;
}

/**
 * 校验 npm 镜像源 URL（仅允许 http/https）
 */
function isValidRegistryUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 校验 npm 包名（防止命令注入）
 */
function isValidNpmPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  if (/[\s;&|`$<>(){}[\]\\'"!]/.test(pkg)) return false;
  // 支持 @scope/name 或 name
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pkg);
}

/**
 * 校验 CLI 命令名
 */
function isValidCliCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cmd);
}

/**
 * 从系统重新读取 PATH 并写入当前进程（安装后可立即检测到新命令）
 */
function refreshProcessPath() {
  try {
    if (os.platform() === 'win32') {
      const { execSync } = require('child_process');
      const ps = 'powershell.exe';
      const userPath = execSync(
        `${ps} -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','User')"`,
        { encoding: 'utf-8', timeout: 8000, windowsHide: true }
      ).trim();
      const machinePath = execSync(
        `${ps} -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')"`,
        { encoding: 'utf-8', timeout: 8000, windowsHide: true }
      ).trim();
      const registryParts = [machinePath, userPath]
        .filter(Boolean)
        .join(';')
        .split(';')
        .filter(Boolean);
      if (registryParts.length) {
        // 合并而非覆盖：注册表 PATH 在前，保留当前进程继承的额外条目（如便携运行时注入的路径）
        const currentParts = (process.env.Path || process.env.PATH || '').split(';').filter(Boolean);
        const seen = new Set(registryParts.map(p => p.toLowerCase()));
        const extras = currentParts.filter(p => !seen.has(p.toLowerCase()));
        const merged = [...registryParts, ...extras].join(';');
        process.env.Path = merged;
        process.env.PATH = merged;
      }
    } else {
      // Unix: 合并常见用户路径
      const home = os.homedir();
      const extras = [
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        '/usr/local/bin'
      ];
      const current = process.env.PATH || '';
      const merged = [...extras.filter(p => fs.existsSync(p) && !current.includes(p)), current]
        .filter(Boolean)
        .join(path.delimiter);
      process.env.PATH = merged;
    }
  } catch {
    // PATH 刷新失败不阻断主流程
  }
}

/**
 * 判断命令执行失败是否是"命令不存在"（即工具未安装），而非真正的异常（超时、权限等）
 * @param {Error} err - execCommand 抛出的错误对象
 * @returns {boolean} 是否为命令未找到
 */
function isCommandNotFound(err) {
  if (!err) return false;
  // 127: POSIX 标准"命令未找到"退出码；9009 (0x2331): Windows cmd.exe 找不到命令时的退出码
  if (err.exitCode === 127 || err.exitCode === 9009) return true;
  const msg = err.message || '';
  if (os.platform() === 'win32') {
    // Windows 中文系统返回"不是内部或外部命令"
    return /不是内部或外部命令|不是可运行的程序|is not recognized as an internal or external command/i.test(msg);
  }
  return /command not found|不存在该命令/i.test(msg);
}

// ===== 版本检测核心逻辑 =====

/**
 * 检测单个工具的本地安装版本
 * @param {object} tool - 工具配置对象
 * @param {object} [options] - { silent } 静默模式不发送日志（后台定时检测使用）
 * @returns {Promise<object>} { installed, version, normalizedVersion, notFound, error }
 */
async function checkLocalVersion(tool, options = {}) {
  // 静默模式（后台定时检测）不输出日志，避免刷屏
  const log = options.silent ? () => {} : sendLog;
  // AtomCode 在 Windows 上安装到用户目录，可能不在 PATH，需要先尝试全路径
  if (tool.id === 'atomcode' && os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const fullPath = path.join(localAppData, 'AtomCode', 'atomcode.exe');
    const exists = fs.existsSync(fullPath);
    log('info', 'atomcode', `检测本地路径: ${fullPath} (是否存在: ${exists})`);
    if (exists) {
      try {
        const output = await execCommand(fullPath, [tool.versionArg], { shell: false });
        const version = output.split(/\r?\n/)[0].trim();
        log('info', 'atomcode', `检测到本地版本: ${version}`);
        return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
      } catch (err) {
        log('error', 'atomcode', `执行全路径检测失败: ${err.message}`);
      }
    }
  }
  if (tool.id === 'qoder') {
    // 国际版：先试 qodercli，再试 qoder
    try {
      const output = await execCommand('qodercli', [tool.versionArg], { shell: true });
      const version = output.split(/\r?\n/)[0].trim();
      return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
    } catch (err) {
      try {
        const output = await execCommand('qoder', [tool.versionArg], { shell: true });
        const version = output.split(/\r?\n/)[0].trim();
        return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
      } catch (innerErr) {
        return { installed: false, version: null, normalizedVersion: null, notFound: isCommandNotFound(innerErr), error: innerErr.message };
      }
    }
  }
  if (tool.id === 'qoder_cn') {
    // 国内镜像版：安装的是 qoderclicn 命令
    try {
      const output = await execCommand('qoderclicn', [tool.versionArg], { shell: true });
      const version = output.split(/\r?\n/)[0].trim();
      return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
    } catch (innerErr) {
      return { installed: false, version: null, normalizedVersion: null, notFound: isCommandNotFound(innerErr), error: innerErr.message };
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

/**
 * 根据当前操作系统和架构返回 antigravity 的平台标识
 * @returns {string} 如 "windows_amd64"、"darwin_arm64"
 */
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
    osStr = 'linux'; // 未知系统默认按 Linux 处理
  }

  if (arch === 'arm64') {
    archStr = 'arm64';
  } else {
    archStr = 'amd64'; // 非 arm64 一律视为 amd64（含 x64、x86）
  }

  return `${osStr}_${archStr}`;
}

/**
 * 检测单个工具的最新可用版本
 * - antigravity：从官方 API 获取平台对应的 manifest
 * - 其他工具：通过 npm view 查询 registry 中的最新版本
 * @param {object} tool - 工具配置对象
 * @returns {Promise<object>} { latest, error? }
 */
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
      // 不再回退到 windows_amd64：其它平台会拿到错误版本号
      return { latest: null, error: err.message };
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
      // Bug fix: 不再使用硬编码回退版本，API 失败时返回 null
      if (!data.tag_name) throw new Error('API 响应中无 tag_name 字段');
      return { latest: data.tag_name };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  }

  // qoder_cn 国内版：从官方 manifest 获取最新版本（binary 为 qoderclicn）
  if (tool.id === 'qoder_cn') {
    try {
      const res = await fetch('https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json');
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const manifest = await res.json();
      return { latest: manifest.latest };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  }

  // qoder 国际版：从官方 manifest 获取最新版本（binary 为 qodercli）
  // 注意：不回退到 npm registry —— npm 包 @qoder-ai/qodercli 与原生安装包是两条独立的版本线，
  // 版本号不可比较，回退会导致把不相关的旧版本号误判为"有更新"
  // 官方 install.ps1 的 BASE_URL 为阿里云 OSS 加速域名，manifest 路径为 ${BASE_URL}/channels/manifest.json
  if (tool.id === 'qoder') {
    const manifestUrls = [
      'https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/channels/manifest.json',
      'https://static.qoder.com/qodercli/channels/manifest.json',
    ];
    let lastErr = null;
    for (const url of manifestUrls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const manifest = await res.json();
        if (manifest && manifest.latest) return { latest: manifest.latest };
      } catch (err) {
        lastErr = err;
      }
    }
    return { latest: null, error: (lastErr && lastErr.message) || 'qoder 国际版 manifest 获取失败' };
  }

  // grok：与官方 install.ps1 一致，读取 channel 指针（默认 stable）得到最新版本号
  // 主源 Cloudflare 前的 x.ai，回退直连 GCS 公共制品桶
  if (tool.id === 'grok') {
    const channel = process.env.GROK_CHANNEL || 'stable';
    const channelUrls = [
      `https://x.ai/cli/${channel}`,
      `https://storage.googleapis.com/grok-build-public-artifacts/cli/${channel}`,
    ];
    let lastErr = null;
    for (const url of channelUrls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const latest = (await res.text()).trim();
        // 安装脚本期望 X.Y.Z 或 X.Y.Z-suffix
        if (latest && /^\d+\.\d+\.\d+(-\S+)?$/.test(latest)) {
          return { latest };
        }
        throw new Error(`无效的版本号响应: ${latest.slice(0, 40)}`);
      } catch (err) {
        lastErr = err;
      }
    }
    return { latest: null, error: (lastErr && lastErr.message) || 'grok channel 版本获取失败' };
  }

  // 普通 npm 工具：查询 registry 最新版本（失败时自动重试 1 次）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const output = await execCommand('npm', ['view', tool.pkg, 'version', `--registry=${currentRegistry}`], { shell: true });
      return { latest: output.trim() };
    } catch (err) {
      if (attempt < 2) {
        // 等待 2 秒后重试（网络抖动场景）
        await new Promise(r => setTimeout(r, 2000));
      } else {
        return { latest: null, error: err.message };
      }
    }
  }
}

/**
 * 检测单个工具的完整版本信息（本地 + 远端并行查询）
 * @param {object} tool - 工具配置对象
 * @param {object} [options] - { silent } 静默模式不发送日志（后台定时检测使用）
 * @returns {Promise<object>} 合并后的检测结果，包含 needsUpdate 标志
 */
async function checkTool(tool, options = {}) {
  const log = options.silent ? () => {} : sendLog;
  log('info', tool.id, `正在检测 ${tool.name} ...`);
  const [local, remote] = await Promise.all([
    checkLocalVersion(tool, options),
    checkLatestVersion(tool)
  ]);
  const localNorm = local.normalizedVersion || extractVersionNumber(local.version);
  const remoteNorm = extractVersionNumber(remote.latest) || remote.latest;
  // 仅当远端版本明确比本地新时标记可更新（本地已是更新版本则不提示降级）
  const needsUpdate = !!(
    local.installed &&
    localNorm &&
    remoteNorm &&
    isRemoteNewer(localNorm, remoteNorm)
  );
  const result = {
    ...tool,
    installed: local.installed,
    currentVersion: local.version,
    latestVersion: remote.latest,
    notFound: local.notFound,
    error: local.error || remote.error,
    needsUpdate,
    // 本地比远端新时给出提示状态，便于 UI 展示
    isAhead: !!(local.installed && localNorm && remoteNorm && compareSemver(localNorm, remoteNorm) === 1)
  };
  const remoteDesc = remote.latest
    ? remote.latest
    : (remote.error ? `无远端信息 (${remote.error.slice(0, 30)})` : '检测失败');
  log('success', tool.id, `${tool.name}: ${local.installed ? local.version : '未安装'} -> ${remoteDesc}`);
  return result;
}

// ===== 安装/更新执行 =====

/**
 * 执行单个工具的安装或更新（共用逻辑，npm install -g 同时适用于首次安装和升级）
 * - Windows：通过 cmd.exe 执行
 * - macOS/Linux：通过 sh -c 执行
 * - antigravity：已安装时用 agy update，未安装时用官方脚本
 * @param {string} toolId - 工具 ID
 * @returns {Promise<object>} { success, code?, message? }
 */
async function doInstallOrUpdate(toolId) {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  // 无安装脚本且无 npm 包名：无法安装
  if (!tool.installScript && !tool.pkg && !tool.updateCmd) {
    sendLog('error', toolId, `${tool.name} 缺少安装命令（未配置 npm 包名或安装脚本）`);
    return { success: false, message: '缺少安装命令' };
  }

  sendLog('start', tool.id, `开始安装/更新 ${tool.name} ...`);

  const isWin = os.platform() === 'win32';
  let shellCmd;
  let shellArgs;

  // ===== 数据驱动：脚本安装类工具 =====
  if (tool.installScript) {
    let powershellCmd = 'powershell.exe';
    if (isWin) {
      const sysnative = path.join(process.env.WINDIR || 'C:\\Windows', 'sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const system32  = path.join(process.env.WINDIR || 'C:\\Windows', 'System32',  'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (fs.existsSync(sysnative))      powershellCmd = sysnative;
      else if (fs.existsSync(system32))  powershellCmd = system32;
    }

    if (tool.id === 'antigravity') {
      // antigravity 已安装时使用内置 update 子命令，未安装时走官方脚本
      const localStatus = await checkLocalVersion(tool);
      if (localStatus.installed) {
        shellCmd = isWin ? 'cmd.exe' : 'sh';
        shellArgs = isWin ? ['/c', 'agy update'] : ['-c', 'agy update'];
      } else if (isWin) {
        shellCmd = powershellCmd;
        shellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', tool.installScript.win];
      } else {
        shellCmd = 'sh';
        shellArgs = ['-c', tool.installScript.unix];
      }
    } else if (isWin) {
      shellCmd = powershellCmd;
      shellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', tool.installScript.win];
    } else {
      shellCmd = 'sh';
      shellArgs = ['-c', tool.installScript.unix];
    }
  } else {
    // ===== npm 安装类工具 =====
    if (isWin) {
      shellCmd = 'cmd.exe';
      shellArgs = ['/c', tool.updateCmd];
    } else {
      shellCmd = 'sh';
      shellArgs = ['-c', tool.updateCmd];
    }
  }

  const childEnv = { ...process.env, NPM_CONFIG_REGISTRY: currentRegistry };
  if (isWin) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const defaultModulesPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const wow64ModulesPath = path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'Modules');
    const extraPaths = [defaultModulesPath, wow64ModulesPath];
    
    if (childEnv.PSModulePath) {
      for (const p of extraPaths) {
        if (!childEnv.PSModulePath.toLowerCase().includes(p.toLowerCase())) {
          childEnv.PSModulePath = `${childEnv.PSModulePath};${p}`;
        }
      }
    } else {
      childEnv.PSModulePath = extraPaths.join(';');
    }
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(shellCmd, shellArgs, {
        env: childEnv,
        // Windows 上避免继承父进程的安全描述符，减少 EPERM 概率
        windowsHide: true,
        // 不创建新进程组，避免某些安全软件拦截
        detached: false
      });
    } catch (spawnErr) {
      // spawn 同步抛出的错误（如 EPERM）
      const isPermError = spawnErr.code === 'EPERM' || spawnErr.code === 'EACCES';
      const msg = isPermError
        ? `权限不足，无法启动安装进程。${isWin ? '请尝试以管理员身份运行本应用，或检查杀毒软件是否拦截了子进程创建。' : '请检查执行权限。'}`
        : `启动安装进程失败: ${spawnErr.message}`;
      sendLog('error', tool.id, msg);
      resolve({ success: false, message: msg });
      return;
    }

    // 安装/更新超时保护（5 分钟），防止子进程挂起导致 UI 锁死
    let settled = false;
    const INSTALL_TIMEOUT = 5 * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      sendLog('error', tool.id, `操作超时（${INSTALL_TIMEOUT / 1000}s），已终止子进程`);
      resolve({ success: false, message: '操作超时' });
    }, INSTALL_TIMEOUT);

    // 实时转发 stdout 到渲染进程日志
    child.stdout.on('data', (data) => {
      const text = data.toString();
      sendLog('data', tool.id, text);
    });

    // 实时转发 stderr 到渲染进程日志
    child.stderr.on('data', (data) => {
      const text = data.toString();
      sendLog('data', tool.id, text);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const isPermError = err.code === 'EPERM' || err.code === 'EACCES';
      const msg = isPermError
        ? `权限被拒绝: ${err.message}。${isWin ? 'Windows 上全局安装 npm 包可能需要管理员权限，请尝试右键以管理员身份运行本应用。' : ''}`
        : `操作失败: ${err.message}`;
      sendLog('error', tool.id, msg);
      resolve({ success: false, message: msg });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

// ===== 卸载执行 =====

/**
 * 执行单个工具的卸载
 * - npm 安装的工具：npm uninstall -g <pkg>
 * - 通过官方脚本安装的工具（antigravity/atomcode/qoder/qoder_cn/grok）：没有统一卸载命令，提示手动卸载
 * @param {string} toolId - 工具 ID
 * @returns {Promise<object>} { success, code?, message?, docsUrl? }
 */
async function doUninstall(toolId) {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  if (SCRIPT_INSTALLED_TOOLS[tool.id]) {
    const docsUrl = SCRIPT_INSTALLED_TOOLS[tool.id].docsUrl;
    const msg = `${tool.name} 通过官方安装脚本安装，没有统一的自动卸载命令。请参考官方文档手动卸载：${docsUrl}`;
    sendLog('error', tool.id, msg);
    return { success: false, message: msg, docsUrl, manualUninstall: true };
  }

  if (!tool.pkg) {
    const msg = `${tool.name} 缺少卸载命令（未配置 npm 包名）`;
    sendLog('error', tool.id, msg);
    return { success: false, message: msg };
  }

  sendLog('start', tool.id, `开始卸载 ${tool.name} ...`);

  const isWin = os.platform() === 'win32';
  const uninstallCmd = `npm uninstall -g ${tool.pkg} --registry=${currentRegistry}`;
  const shellCmd = isWin ? 'cmd.exe' : 'sh';
  const shellArgs = isWin ? ['/c', uninstallCmd] : ['-c', uninstallCmd];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(shellCmd, shellArgs, {
        env: { ...process.env, NPM_CONFIG_REGISTRY: currentRegistry },
        windowsHide: true,
        detached: false
      });
    } catch (spawnErr) {
      const isPermError = spawnErr.code === 'EPERM' || spawnErr.code === 'EACCES';
      const msg = isPermError
        ? `权限不足，无法启动卸载进程。${isWin ? '请尝试以管理员身份运行本应用。' : '请检查执行权限。'}`
        : `启动卸载进程失败: ${spawnErr.message}`;
      sendLog('error', tool.id, msg);
      resolve({ success: false, message: msg });
      return;
    }

    let settled = false;
    const UNINSTALL_TIMEOUT = 5 * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      sendLog('error', tool.id, `卸载超时（${UNINSTALL_TIMEOUT / 1000}s），已终止子进程`);
      resolve({ success: false, message: '卸载超时' });
    }, UNINSTALL_TIMEOUT);

    child.stdout.on('data', (data) => sendLog('data', tool.id, data.toString()));
    child.stderr.on('data', (data) => sendLog('data', tool.id, data.toString()));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const isPermError = err.code === 'EPERM' || err.code === 'EACCES';
      const msg = isPermError
        ? `权限被拒绝: ${err.message}。${isWin ? '请尝试以管理员身份运行本应用。' : ''}`
        : `卸载失败: ${err.message}`;
      sendLog('error', tool.id, msg);
      resolve({ success: false, message: msg });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        sendLog('success', tool.id, `${tool.name} 已卸载`);
        resolve({ success: true });
      } else {
        const msg = `卸载退出码: ${code}（Windows 上可能需要以管理员身份运行）`;
        sendLog('error', tool.id, msg);
        resolve({ success: false, code, message: msg });
      }
    });
  });
}

// ===== IPC 处理程序（主进程 ↔ 渲染进程通信） =====

// 获取工具配置（内置 + 自定义，带当前镜像源生成的 updateCmd）
ipcMain.handle('get-tools', () => getAllTools());

// 批量检测所有工具版本（并行执行，流式推送）
// 每检测完一个工具立即通过 'tool-checked' 事件推送到渲染进程，
// 实现卡片逐张亮起的流式效果，而非全部完成后一次性刷新
ipcMain.handle('check-versions', async () => {
  refreshProcessPath();
  const tools = getAllTools();
  const results = await Promise.all(
    tools.map(async (t) => {
      const result = await checkTool(t);
      // 每完成一个立即推送（流式）
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tool-checked', result);
      }
      return result;
    })
  );
  return results;
});

// 检测单个工具版本
ipcMain.handle('check-version', async (event, toolId) => {
  refreshProcessPath();
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');
  return checkTool(tool);
});

// 更新单个工具
ipcMain.handle('update-tool', async (event, toolId) => {
  const result = await doInstallOrUpdate(toolId);
  refreshProcessPath();
  return result;
});

// 安装单个工具（逻辑与更新相同，npm install -g 同时适用于首次安装和升级）
ipcMain.handle('install-tool', async (event, toolId) => {
  const result = await doInstallOrUpdate(toolId);
  refreshProcessPath();
  return result;
});

// 卸载单个工具
ipcMain.handle('uninstall-tool', async (event, toolId) => {
  const result = await doUninstall(toolId);
  refreshProcessPath();
  return result;
});

// ===== 镜像源相关 IPC =====

// 获取可用镜像源列表
ipcMain.handle('get-registries', () => REGISTRIES);

// 获取当前使用的镜像源 URL
ipcMain.handle('get-current-registry', () => currentRegistry);

// 切换镜像源并持久化保存
ipcMain.handle('set-registry', (event, url) => {
  if (!isValidRegistryUrl(url)) {
    const message = '无效的镜像源 URL，请使用 http:// 或 https:// 开头的地址';
    sendLog('error', 'system', message);
    return { success: false, message };
  }
  const normalized = url.trim().endsWith('/') ? url.trim() : `${url.trim()}/`;
  currentRegistry = normalized;
  saveSettings({ registry: normalized });
  sendLog('info', 'system', `镜像源已切换为: ${normalized}`);
  return { success: true, registry: normalized };
});

// ===== 自定义工具 IPC =====

/**
 * 添加自定义工具并分配唯一 ID（custom_ + 时间戳）
 * @param {object} toolConfig - { name, cmd, pkg, versionArg? }
 */
ipcMain.handle('add-custom-tool', (event, toolConfig) => {
  const name = (toolConfig.name || '').trim();
  const cmd = (toolConfig.cmd || '').trim();
  const pkg = (toolConfig.pkg || '').trim();
  const versionArg = (toolConfig.versionArg || '--version').trim() || '--version';

  if (!name) {
    return { success: false, message: '工具名称不能为空' };
  }
  if (!isValidNpmPackage(pkg)) {
    return { success: false, message: 'npm 包名不合法（仅允许字母、数字、@scope/、.-_~，禁止空格与 shell 特殊字符）' };
  }
  if (!isValidCliCommand(cmd)) {
    return { success: false, message: 'CLI 命令名不合法（仅允许字母、数字、. _ -）' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(versionArg.replace(/^-+/, ''))) {
    return { success: false, message: '版本参数不合法' };
  }

  const custom = loadCustomTools();
  if (custom.some(t => t.cmd === cmd || t.pkg === pkg)) {
    return { success: false, message: '已存在相同命令名或包名的自定义工具' };
  }

  const id = 'custom_' + Date.now();
  const newTool = { id, name, cmd, pkg, versionArg };
  custom.push(newTool);
  saveCustomTools(custom);
  sendLog('info', 'system', `已添加自定义工具: ${newTool.name}`);
  return { success: true, tool: newTool };
});

// 移除指定 ID 的自定义工具
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

/**
 * 检测系统环境是否满足运行要求
 * - 检查 Node.js 是否安装且版本 >= 18
 * - 检查 npm 是否可用
 * - 返回操作系统版本信息
 */
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

  // 操作系统信息（按平台正确显示，不再写死 Windows）
  try {
    const platform = os.platform();
    const release = os.release();
    if (platform === 'win32') {
      result.os = `Windows ${release}`;
    } else if (platform === 'darwin') {
      result.os = `macOS ${release}`;
    } else if (platform === 'linux') {
      result.os = `Linux ${release}`;
    } else {
      result.os = `${platform} ${release}`;
    }
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

// 弹出保存对话框，将日志文本写入用户选择的文件
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

// 复制文本到剪贴板
ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

// ===== 管理员权限提示 IPC =====

// 弹出对话框提示用户需要管理员权限（Windows 全局安装 npm 包时可能需要）
ipcMain.handle('show-admin-tip', async () => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '需要管理员权限',
    message: '在 Windows 上全局安装 npm 包可能需要管理员权限。\n\n如果安装/更新失败，请右键点击「AI Code Tool Updater.exe」选择「以管理员身份运行」，或将 npm 全局目录配置到用户目录后重试。',
    buttons: ['知道了']
  });
});

// ===== 打开外部链接 IPC =====

/**
 * 使用系统默认浏览器打开外部链接
 * - 仅允许 http/https 协议，防止恶意 URI 注入
 */
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

// 获取当前所有设置
ipcMain.handle('get-settings', () => {
  return loadSettings();
});

// 保存设置，如果后台检测间隔有变化则重启定时器，开机自启变化则应用登录项
ipcMain.handle('save-settings', (event, newSettings) => {
  saveSettings(newSettings);
  if ('backgroundCheckHours' in newSettings) {
    startBackgroundCheck();
  }
  if ('openAtLogin' in newSettings) {
    applyLoginItem(newSettings.openAtLogin);
  }
  return { success: true };
});

// ===== 一键配置 agyyolo 到 PowerShell Profile =====
// agyyolo 是一个 PowerShell 函数，调用 agy --dangerously-skip-permissions

// 要写入 PowerShell Profile 的函数体
const AGYYOLO_FUNCTION_BODY = `function agyyolo {\n    agy --dangerously-skip-permissions\n}\n`;

/**
 * 获取所有可能的 PowerShell Profile 路径（兼容 Windows PowerShell 5.1 和 PowerShell 7+）
 * @returns {string[]} Profile 文件路径数组
 */
function getPowerShellProfiles() {
  const home = os.homedir();
  return [
    path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
  ];
}

/**
 * 确保 Profile 文件所在的目录和文件本身存在，不存在则创建
 * @param {string} profilePath - Profile 文件路径
 * @returns {string} 原样返回 profilePath（方便链式调用）
 */
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

/**
 * 将 agyyolo 函数写入指定的 PowerShell Profile（幂等，已存在则跳过）
 * @param {string} profilePath - Profile 文件路径
 * @returns {object} { ok: boolean, reason: string }
 */
function installAgyyoloToProfile(profilePath) {
  if (!profilePath) {
    return { ok: false, reason: 'Profile 路径为空' };
  }

  ensureProfile(profilePath);

  const content = fs.readFileSync(profilePath, 'utf-8');
  if (/function\s+agyyolo\b/.test(content)) {
    return { ok: true, reason: '已存在，跳过' };
  }

  // 如果文件末尾没有换行，先补两个换行再追加函数
  const ending = content && !content.endsWith('\n') ? '\n\n' : '';
  fs.writeFileSync(profilePath, content + ending + AGYYOLO_FUNCTION_BODY, 'utf-8');
  return { ok: true, reason: '已写入' };
}

/**
 * IPC：一键将 agyyolo 配置到所有 PowerShell Profile
 * - 先检测 agy 命令是否可用
 * - 遍历所有 Profile 路径，逐个写入
 * - 返回每个 Profile 的处理结果
 */
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
  const seen = new Set(); // 去重（不同路径可能指向同一文件）

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

/**
 * 根据操作系统打开默认终端
 * - Windows：打开 PowerShell
 * - macOS：打开 Terminal（通过 osascript）
 * - Linux：打开 x-terminal-emulator
 */
// ===== 高亮指定工具卡片 IPC =====
// 渲染进程可以通过此通道请求高亮某个工具（如系统通知点击后）
ipcMain.handle('highlight-tool', (event, toolId) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('highlight-tool', toolId);
  }
  return { success: true };
});

ipcMain.handle('open-powershell', async () => {
  const isWin = os.platform() === 'win32';
  const { spawn } = require('child_process');

  if (isWin) {
    try {
      const child = spawn('cmd.exe', ['/c', 'start powershell'], {
        detached: true,  // 分离子进程，不随主进程退出
        stdio: 'ignore'  // 不继承 stdio，避免阻塞主进程
      });
      child.unref(); // 让子进程独立运行
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  } else {
    if (os.platform() === 'darwin') {
      // macOS：通过 AppleScript 打开 Terminal
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
      // Linux：尝试打开默认终端模拟器
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

// ===== 镜像源测速 IPC =====
// 向指定镜像源发送 HTTP HEAD 请求并测量响应时间（毫秒）
ipcMain.handle('ping-registry', async (event, url) => {
  if (!isValidRegistryUrl(url)) {
    return { success: false, message: '无效的镜像源 URL' };
  }
  const pingUrl = url.trim().replace(/\/$/, '') + '/';
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(pingUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'npm-registry-ping' }
    });
    clearTimeout(timeout);
    const ms = Date.now() - start;
    return { success: true, ms, status: res.status };
  } catch (err) {
    const ms = Date.now() - start;
    return { success: false, ms, message: err.name === 'AbortError' ? '请求超时（>8s）' : err.message };
  }
});
