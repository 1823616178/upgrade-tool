// ===== Electron 主进程入口 =====
// 依赖：electron（应用框架）、path/fs（文件操作）、child_process（执行系统命令）、os（系统信息）
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, clipboard, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const { pathToFileURL } = require('url');

const {
  extractVersionNumber,
  extractVersionLine,
  parseSemver,
  compareSemver,
  isRemoteNewer
} = require('./lib/semver');
const {
  isValidRegistryUrl,
  isValidNpmPackage,
  hasOnlyFields,
  isValidToolName,
  isValidCliCommand,
  isValidVersionArg,
  createConcurrencyLimiter,
  isCurrentCheckRun
} = require('./lib/validators');
const {
  installAgyyoloToProfile,
  removeAgyyoloFromProfile,
  profileResultsSucceeded,
  uniqueProfilePaths
} = require('./lib/ps-profile');
const {
  findCommandInPath,
  killProcessTree,
  spawnDetachedSafely
} = require('./lib/process-utils');
const {
  REGISTRIES,
  BUILTIN_TOOLS,
  SCRIPT_INSTALLED_TOOLS,
  resolveSpecialRemoteVersion
} = require('./lib/tools-catalog');

// 全局只允许一个应用实例。后续启动的实例会立即退出，并通知首个实例唤醒主窗口。
// 必须在 app ready 之前申请锁，避免两个进程同时创建窗口、托盘和后台任务。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

// ===== 设置持久化 =====
// 用户设置（镜像源、后台检测间隔等）保存在 userData/settings.json
// 使用内存缓存避免高频磁盘读取，并通过串行队列 + 临时文件原子替换防止并发写损坏

let _settingsCache = null; // 内存缓存，null 表示尚未加载
let _settingsWriteChain = Promise.resolve();

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
 * 将新设置合并到缓存并串行原子写入磁盘
 * @param {object} settings - 需要保存的部分设置
 * @returns {Promise<void>}
 */
function saveSettings(settings) {
  if (_settingsCache === null) loadSettings(); // 确保缓存已初始化
  _settingsCache = { ..._settingsCache, ...settings };
  const snapshot = JSON.stringify(_settingsCache, null, 2);
  const targetPath = getSettingsPath();
  _settingsWriteChain = _settingsWriteChain.then(async () => {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, snapshot, 'utf-8');
    await fs.promises.rename(tempPath, targetPath);
  }).catch((err) => {
    console.error('[settings] 写入失败:', err.message);
  });
  return _settingsWriteChain;
}

// 当前活跃的镜像源 URL，默认使用第一个（npm 官方源）
let currentRegistry = REGISTRIES[0].url;

// 从持久化配置中恢复用户上次选择的镜像源
try {
  const saved = loadSettings();
  if (saved.registry && isValidRegistryUrl(saved.registry)) {
    currentRegistry = saved.registry;
  }
} catch { /* 首次启动，无配置文件，使用默认值 */ }

// ===== 自定义工具持久化 =====
// 用户自定义的工具列表保存在 userData/custom-tools.json

function getCustomToolsPath() {
  return path.join(app.getPath('userData'), 'custom-tools.json');
}

/**
 * 从磁盘加载自定义工具列表
 * @returns {object[]} 自定义工具数组，文件不存在时返回空数组
 */
function loadCustomTools() {
  try {
    const data = JSON.parse(fs.readFileSync(getCustomToolsPath(), 'utf-8'));
    if (!Array.isArray(data)) return [];
    // 文件可被手工编辑，只允许保留显式描述字段；未知或执行字段会使记录被拒绝。
    return data
      .filter(t => hasOnlyFields(t, ['id', 'name', 'cmd', 'pkg', 'versionArg'])
        && /^custom_\d+$/.test(t.id)
        && isValidToolName(t.name)
        && isValidNpmPackage(t.pkg)
        && isValidCliCommand(t.cmd)
        && isValidVersionArg(t.versionArg || '--version'))
      .map(t => ({
        id: t.id,
        name: t.name.trim(),
        cmd: t.cmd.trim(),
        pkg: t.pkg.trim(),
        versionArg: (t.versionArg || '--version').trim()
      }));
  } catch {
    return [];
  }
}

/**
 * 将自定义工具列表原子写入磁盘
 * @param {object[]} tools - 要保存的工具数组
 */
function saveCustomTools(tools) {
  const targetPath = getCustomToolsPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(tools, null, 2), 'utf-8');
  fs.renameSync(tempPath, targetPath);
}

/**
 * 获取所有工具（内置 + 自定义）；npm 安装命令仅在取得精确版本后构造
 * @returns {object[]} 合并后的工具列表，每个工具附带 isCustom 字段
 */
function getAllTools() {
  const custom = loadCustomTools();
  const all = [
    ...BUILTIN_TOOLS.map(t => ({ ...t, isCustom: false })),
    ...custom.map(t => ({ ...t, isCustom: true }))
  ];
  return all.map(t => ({
    ...t,
    // 是否支持当前平台（未声明 platforms 的工具视为全平台支持）
    supported: !t.platforms || t.platforms.includes(os.platform()),
    // 脚本安装工具附带官网链接（渲染层 changelog 入口）；npm 工具由渲染层用 pkg 拼 npmjs 链接
    docsUrl: SCRIPT_INSTALLED_TOOLS[t.id] ? SCRIPT_INSTALLED_TOOLS[t.id].docsUrl : null
  }));
}

// ===== 全局状态变量 =====
let mainWindow = null;        // 主窗口实例
let tray = null;              // 系统托盘实例
let backgroundTimer = null;   // 后台版本检测定时器引用
let isQuitting = false;       // 应用正在退出（Cmd+Q / 系统关机等），此时关窗不再拦截为最小化到托盘
let activeCheckRunId = 0;     // 仅批量检测递增，避免单工具刷新冲掉全量批次
let latestToolSeq = 0;        // 单项工具检测单调序号，保证新结果不被迟到的旧批次覆盖
let checkBatchInFlight = false;
let lastCheckBatchAt = 0;
const CHECK_BATCH_MIN_INTERVAL_MS = 1000;

// 应用图标：Windows 用 ICO，macOS/Linux 用 PNG（macOS 的 Tray 不支持 ICO）
const APP_ICON_PATH = process.platform === 'win32'
  ? path.join(__dirname, 'build', 'icon.ico')
  : path.join(__dirname, 'build', 'icon.png');

/**
 * 配置原生菜单
 * - Windows/Linux：完全隐藏菜单栏
 * - macOS：保留最简应用菜单（否则 Cmd+C/V/Q 等标准快捷键会失效）
 */
function configureApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]));
}

/**
 * 创建主应用窗口
 * @param {object} [options] - { show } true 时忽略「启动时最小化」，用于托盘/通知主动唤起
 */
function createWindow(options = {}) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON_PATH,
    backgroundColor: '#080c14',
    webPreferences: {
      nodeIntegration: false,    // 禁止渲染进程直接访问 Node.js
      contextIsolation: true,    // 隔离 preload 和渲染进程上下文
      sandbox: true,             // preload/renderer 使用 Electron sandbox
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    show: false // 先隐藏，等 ready-to-show 再显示，避免白屏闪烁
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 安全加固：本应用是纯本地页面，不应发生任何页内导航或新开窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // 页面加载完成后显示窗口
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const settings = loadSettings();
    if (options.show === true || !settings.startMinimized) mainWindow.show();
  });

  // 关闭窗口时最小化到托盘（如果用户开启了该选项且托盘已创建）
  mainWindow.on('close', (event) => {
    const settings = loadSettings();
    if (!isQuitting && settings.minimizeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    if (process.platform !== 'darwin' && tray) {
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
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  createWindow({ show: true });
  return mainWindow;
}

/**
 * 向渲染进程发送"立即检测"指令
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

function createTray() {
  try {
    let icon = APP_ICON_PATH;
    if (process.platform === 'darwin') {
      const image = nativeImage.createFromPath(APP_ICON_PATH);
      if (!image.isEmpty()) {
        icon = image.resize({ width: 18, height: 18 });
      }
    }
    tray = new Tray(icon);
  } catch {
    return;
  }

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
        tray.destroy();
        tray = null;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('AI Code Tool Updater');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    showOrCreateWindow();
  });
}

// ===== 后台静默版本检测 =====

/**
 * 启动后台定时检测任务
 * - 读取用户设置的检测间隔（默认 4 小时，设为 0 则禁用）
 * - 定时检测所有工具版本，结果同步给渲染进程，有新版本时弹出系统通知
 */
function startBackgroundCheck() {
  stopBackgroundCheck();
  const settings = loadSettings();
  const saved = settings.backgroundCheckHours ?? 4;
  const hours = Number.isFinite(saved) ? saved : 4;
  if (hours <= 0) return;

  const intervalMs = hours * 60 * 60 * 1000;
  backgroundTimer = setInterval(async () => {
    // 若前台正在执行批量检测，跳过本次后台轮询，避免互相抢占与打断用户视图
    if (checkBatchInFlight) return;
    try {
      const runId = beginCheckRun();
      await refreshProcessPath();
      const tools = getAllTools();
      const rawResults = await Promise.all(tools.map(t => runLimitedCheck(() => (
        isCurrentCheckRun(runId, activeCheckRunId) ? checkToolSafely(t, { silent: true }) : null
      ))));
      if (!isCurrentCheckRun(runId, activeCheckRunId)) return;
      const results = rawResults.filter(Boolean);

      // 同步最新检测结果到已驻留的主窗口，确保用户打开窗口或点击通知时看到最新状态
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('background-results', { runId, results });
      }

      const updatable = results.filter(r => r.needsUpdate);
      if (updatable.length > 0) {
        const names = updatable.map(t => t.name).join('、');
        const firstUpdatableId = updatable[0].id;
        const notification = new Notification({
          title: 'AI 工具有新版本可用',
          body: `${names} 有新版本，点击查看详情`,
          icon: path.join(__dirname, 'build', 'icon.png')
        });
        notification.on('click', () => {
          const win = showOrCreateWindow();
          if (win) {
            const sendHighlight = () => {
              if (!win.isDestroyed()) {
                win.webContents.send('background-results', { runId, results });
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

function stopBackgroundCheck() {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// ===== 应用生命周期 =====

function applyLoginItem(openAtLogin) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!openAtLogin });
  } catch { /* 平台不支持时静默忽略 */ }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    showOrCreateWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopBackgroundCheck();
  });

  app.whenReady().then(() => {
    configureApplicationMenu();
    createWindow();
    createTray();
    startBackgroundCheck();
    const settings = loadSettings();
    if (settings.openAtLogin) {
      applyLoginItem(true);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (!tray) {
        app.quit();
      }
    }
  });

  app.on('activate', () => {
    showOrCreateWindow();
  });
}

// ===== 日志发送工具 =====

function sendLog(type, toolId, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-log', { type, toolId, message, time: new Date().toLocaleTimeString() });
  }
}

// ===== 命令执行工具 =====

const CHECK_TIMEOUT = 30000;
const HTTP_TIMEOUT = 10000;

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 执行系统命令并返回输出
 * - Windows 下 shell 模式使用 cmd.exe /d /c（禁用注册表 AutoRun 钩子，防止拖慢或污染输出）
 * - 内置超时保护，超时后自动终止整个进程树
 * @param {string} command - 要执行的命令
 * @param {string[]} args - 命令参数
 * @param {object} options - { shell, timeout, ignoreError, combineOutput, onData, env }
 * @returns {Promise<string>} 命令输出
 */
function execCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const isWin = os.platform() === 'win32';
    const env = options.env || process.env;
    let child;
    if (isWin && options.shell) {
      // /d 禁用 AutoRun 注册表脚本，避免 Conda/Clink 等横幅污染版本输出或增加耗时
      child = spawn('cmd.exe', ['/d', '/c', command, ...args], { env, windowsHide: true });
    } else {
      child = spawn(command, args, {
        env,
        shell: options.shell || false,
        windowsHide: true,
        detached: !isWin
      });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutMs = options.timeout || CHECK_TIMEOUT;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
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
      } else if (options.combineOutput) {
        resolve(`${stdout}\n${stderr}`);
      } else {
        resolve(stdout.trim() ? stdout : stderr);
      }
    });
  });
}

// ===== PATH 刷新与缓存 =====

const PATH_CACHE_TTL = 30 * 1000;
let _pathRefreshedAt = 0;
let _pathRefreshInflight = null;

const PATH_SPLIT_MARKER = '<<<PATHSPLIT>>>';
const READ_PATH_PS = [
  "[Environment]::GetEnvironmentVariable('Path','Machine')",
  `'${PATH_SPLIT_MARKER}'`,
  "[Environment]::GetEnvironmentVariable('Path','User')"
].join('; ');

/**
 * 从系统重新读取 PATH 并写入当前进程（安装后可立即检测到新命令）
 * @param {object} [options] - { force } 强制忽略缓存（安装/卸载后应传 true）
 * @returns {Promise<void>}
 */
function refreshProcessPath(options = {}) {
  if (!options.force && Date.now() - _pathRefreshedAt < PATH_CACHE_TTL) {
    return Promise.resolve();
  }
  if (_pathRefreshInflight) return _pathRefreshInflight;

  _pathRefreshInflight = (async () => {
    try {
      if (os.platform() === 'win32') {
        const output = await execCommand(
          getWindowsPowerShellPath(),
          ['-NoProfile', '-NonInteractive', '-Command', READ_PATH_PS],
          { shell: false, timeout: 8000 }
        );
        const [machinePath = '', userPath = ''] = output.split(PATH_SPLIT_MARKER);
        const stripBreaks = (v) => v.replace(/[\r\n]+/g, '').trim();
        const registryParts = [stripBreaks(machinePath), stripBreaks(userPath)]
          .filter(Boolean)
          .join(';')
          .split(';')
          .map(p => p.trim())
          .filter(Boolean);
        if (registryParts.length) {
          const currentParts = (process.env.Path || process.env.PATH || '').split(';').filter(Boolean);
          const seen = new Set(registryParts.map(p => p.toLowerCase()));
          const extras = currentParts.filter(p => !seen.has(p.toLowerCase()));
          const merged = [...registryParts, ...extras].join(';');
          process.env.Path = merged;
          process.env.PATH = merged;
        }
      } else {
        const home = os.homedir();
        const extras = [
          path.join(home, '.local', 'bin'),
          path.join(home, '.npm-global', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin'
        ];
        let shellPath = '';
        if (os.platform() === 'darwin') {
          try {
            const userShell = process.env.SHELL || '/bin/zsh';
            const startMarker = '__CB_PATH_START__';
            const endMarker = '__CB_PATH_END__';
            const output = await execCommand(
              userShell,
              ['-ilc', `printf '${startMarker}%s${endMarker}' "$PATH"`],
              { shell: false, timeout: 5000, ignoreError: true }
            );
            const match = output.match(new RegExp(`${startMarker}([\\s\\S]*?)${endMarker}`));
            if (match && match[1].trim()) shellPath = match[1].trim();
          } catch { /* 登录 shell 读取失败时退回常见路径 */ }
        }
        const current = process.env.PATH || '';
        const parts = [
          ...(shellPath ? shellPath.split(path.delimiter) : []),
          ...extras.filter(p => fs.existsSync(p)),
          ...current.split(path.delimiter)
        ];
        const seen = new Set();
        process.env.PATH = parts
          .filter(p => {
            if (!p || seen.has(p)) return false;
            seen.add(p);
            return true;
          })
          .join(path.delimiter);
      }
      _pathRefreshedAt = Date.now();
    } catch {
      // PATH 刷新失败不阻断主流程（也不更新时间戳，下次仍会重试）
    } finally {
      _pathRefreshInflight = null;
    }
  })();

  return _pathRefreshInflight;
}

function isCommandNotFound(err) {
  if (!err) return false;
  if (err.exitCode === 127 || err.exitCode === 9009) return true;
  const msg = err.message || '';
  if (os.platform() === 'win32') {
    return /不是内部或外部命令|不是可运行的程序|is not recognized as an internal or external command/i.test(msg);
  }
  return /command not found|不存在该命令/i.test(msg);
}

// ===== 版本检测核心逻辑 =====

/**
 * 检测单个工具的本地安装版本
 * - 先通过纯文件系统在 PATH 中定位可执行文件（<1ms，零子进程），未安装时直接返回 notFound: true
 * - Windows 下 .exe/.com 与 macOS/Linux 可执行文件均以 shell: false 直连执行，仅 .cmd/.bat 走 cmd.exe /d /c
 * - 从多行输出中智能提取包含 semver 的版本行，避免首行 Warning 干扰
 */
async function checkLocalVersion(tool, options = {}) {
  const log = options.silent ? () => {} : sendLog;
  const isWin = os.platform() === 'win32';

  // AtomCode 在 Windows 上安装到用户目录，可能不在 PATH，优先尝试全路径
  if (tool.id === 'atomcode' && isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const fullPath = path.join(localAppData, 'AtomCode', 'atomcode.exe');
    if (fs.existsSync(fullPath)) {
      try {
        const output = await execCommand(fullPath, [tool.versionArg], { shell: false, combineOutput: true });
        const version = extractVersionLine(output);
        log('info', 'atomcode', `检测到本地版本: ${version}`);
        return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
      } catch (err) {
        log('error', 'atomcode', `执行全路径检测失败: ${err.message}`);
      }
    }
  }

  const cmds = [tool.cmd, ...(tool.altCmds || [])];
  const checkEnv = tool.checkEnv ? { ...process.env, ...tool.checkEnv } : process.env;

  // 先在内存中扫描 PATH，过滤出真实存在的可执行项，彻底省去对未安装工具拉起 cmd.exe + where.exe 的子进程风暴
  const located = cmds
    .map(cmd => ({ cmd, ...findCommandInPath(cmd, { platform: os.platform(), env: checkEnv }) }))
    .filter(item => item.found);

  if (located.length === 0) {
    return { installed: false, version: null, normalizedVersion: null, notFound: true, error: null };
  }

  let lastErr = null;
  for (const { cmd, fullPath, ext } of located) {
    try {
      // Windows .exe/.com 及所有 POSIX 命令均无需经过 shell，直接 exec 可执行路径
      const directExec = !isWin || ext === '.exe' || ext === '.com';
      const target = directExec ? fullPath : cmd;
      const output = await execCommand(target, [tool.versionArg], {
        shell: !directExec,
        env: checkEnv,
        combineOutput: true
      });
      const version = extractVersionLine(output);
      return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
    } catch (err) {
      lastErr = err;
    }
  }

  const notFound = isCommandNotFound(lastErr);
  return {
    installed: false,
    version: null,
    normalizedVersion: null,
    notFound,
    error: lastErr ? lastErr.message : '版本检测失败'
  };
}

// registry HTTP 查询超时（毫秒）
const REGISTRY_HTTP_TIMEOUT = 6000;

/**
 * 直接向 npm registry 查询包的最新版本（毫秒级，不占用子进程）
 */
async function fetchLatestFromRegistry(pkg) {
  if (!pkg) return { latest: null, error: '缺少包名' };
  const base = currentRegistry.endsWith('/') ? currentRegistry : `${currentRegistry}/`;
  const url = `${base}${pkg}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_HTTP_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.npm.install-v1+json, application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.version) throw new Error('响应中无 version 字段');
    return { latest: String(data.version).trim() };
  } catch (err) {
    return { latest: null, error: err.name === 'AbortError' ? 'registry 查询超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 npm 包的最新精确版本（检测与安装共用）
 * 优先走 HTTPS registry 接口；若私有源不支持 /latest 或需要本地 .npmrc 认证，则回退到 npm view（含 1 次重试）
 * @param {string} pkg
 * @returns {Promise<{ latest: string|null, error?: string }>}
 */
async function resolveNpmLatestVersion(pkg) {
  if (!pkg) return { latest: null, error: '缺少包名' };
  const viaHttp = await fetchLatestFromRegistry(pkg);
  if (viaHttp.latest && parseSemver(viaHttp.latest)) return viaHttp;

  const isWin = os.platform() === 'win32';
  let lastErr = viaHttp.error;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const output = await execCommand('npm', ['view', pkg, 'version', `--registry=${currentRegistry}`], { shell: isWin });
      const version = extractVersionLine(output);
      if (version && parseSemver(version)) {
        return { latest: version };
      }
      lastErr = '响应中无有效 semver 版本号';
    } catch (err) {
      lastErr = err.message;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return { latest: null, error: lastErr };
}

/**
 * 检测单个工具的最新可用版本（表驱动解析专用源 + 通用 npm 源）
 */
async function checkLatestVersion(tool) {
  const special = await resolveSpecialRemoteVersion(tool, {
    fetchWithTimeout,
    platform: os.platform(),
    arch: os.arch(),
    env: process.env
  });
  if (special) return special;

  if (!tool.pkg) return { latest: null, error: '无远端版本来源' };
  return resolveNpmLatestVersion(tool.pkg);
}

/**
 * 检测单个工具的完整版本信息（本地 + 远端并行查询）
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
    isAhead: !!(local.installed && localNorm && remoteNorm && compareSemver(localNorm, remoteNorm) === 1)
  };
  const remoteDesc = remote.latest
    ? remote.latest
    : (remote.error ? `无远端信息 (${remote.error.slice(0, 30)})` : '检测失败');
  log('success', tool.id, `${tool.name}: ${local.installed ? local.version : (local.notFound ? '未安装' : '本地检测异常')} -> ${remoteDesc}`);
  return result;
}

const runLimitedCheck = createConcurrencyLimiter(4);

async function checkToolSafely(tool, options = {}) {
  try {
    const res = await checkTool(tool, options);
    return { ...res, seq: ++latestToolSeq };
  } catch (err) {
    return {
      ...tool,
      installed: false,
      currentVersion: null,
      latestVersion: null,
      notFound: false,
      error: err && err.message ? err.message : String(err),
      needsUpdate: false,
      isAhead: false,
      seq: ++latestToolSeq
    };
  }
}

function beginCheckRun() {
  const runId = ++activeCheckRunId;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('check-run-started', runId);
  }
  return runId;
}

// ===== 安装/更新执行 =====

function buildWindowsChildEnv(baseEnv) {
  const env = { ...baseEnv };
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const modulePaths = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'Modules')
  ];
  env.PSModulePath = [...(env.PSModulePath || '').split(';').filter(Boolean), ...modulePaths]
    .filter((value, index, all) => all.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index)
    .join(';');
  return env;
}

/**
 * 执行单个工具的安装或更新
 * @param {string} toolId - 工具 ID
 * @param {'安装'|'更新'} [actionLabel] - 操作展示文案
 * @returns {Promise<object>} { success, code?, message? }
 */
async function doInstallOrUpdate(toolId, actionLabel = '安装') {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  if (tool.supported === false) {
    const msg = `${tool.name} 不支持当前平台（${os.platform()}），无法${actionLabel}`;
    sendLog('error', toolId, msg);
    return { success: false, message: msg };
  }

  if (!tool.installScript && !tool.pkg) {
    sendLog('error', toolId, `${tool.name} 缺少安装命令（未配置 npm 包名或安装脚本）`);
    return { success: false, message: '缺少安装命令' };
  }

  sendLog('start', tool.id, `开始${actionLabel} ${tool.name} ...`);

  const isWin = os.platform() === 'win32';

  // ===== HTTPS 厂商脚本：先完整下载到受限临时文件，再由本地解释器执行 =====
  if (tool.installScript) {
    if (tool.id === 'antigravity') {
      const localStatus = await checkLocalVersion(tool, { silent: true });
      if (localStatus.installed) {
        const shellCmd = isWin ? 'cmd.exe' : 'sh';
        const shellArgs = isWin ? ['/d', '/c', 'agy update'] : ['-c', 'agy update'];
        return runStreamingCommand(tool, shellCmd, shellArgs, { ...process.env }, {
          action: '更新', successMsg: `${tool.name} 更新完成`
        });
      }
    }

    if (tool.id === 'atomcode' && isWin) {
      await execCommand('taskkill', ['/f', '/im', 'atomcode.exe'], { ignoreError: true, timeout: 5000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    const url = tool.installScript[isWin ? 'winUrl' : 'unixUrl'];
    if (!url) {
      const message = `${tool.name} 未提供当前平台的 HTTPS 安装脚本`;
      sendLog('error', tool.id, message);
      return { success: false, message };
    }
    return runDownloadedScript(tool, url, {
      action: actionLabel, successMsg: `${tool.name} ${actionLabel}完成`
    });
  }

  // ===== npm 安装类工具：先查询当前 registry（含 npm view 回退），再安装不可变的精确版本 =====
  const versionInfo = await resolveNpmLatestVersion(tool.pkg);
  const exactVersion = versionInfo.latest && parseSemver(versionInfo.latest)
    ? String(versionInfo.latest).trim().replace(/^v/i, '')
    : null;
  if (!exactVersion) {
    const message = `无法从 HTTPS registry 获取有效版本，未执行${actionLabel}：${versionInfo.error || '版本格式无效'}`;
    sendLog('error', tool.id, message);
    return { success: false, message };
  }
  const installCmd = `npm install -g ${tool.pkg}@${exactVersion} --registry=${currentRegistry}`;
  const shellCmd = isWin ? 'cmd.exe' : 'sh';
  const shellArgs = isWin ? ['/d', '/c', installCmd] : ['-c', installCmd];
  const childEnv = isWin
    ? buildWindowsChildEnv({ ...process.env, NPM_CONFIG_REGISTRY: currentRegistry })
    : { ...process.env, NPM_CONFIG_REGISTRY: currentRegistry };

  return runStreamingCommand(tool, shellCmd, shellArgs, childEnv, {
    action: actionLabel,
    successMsg: `${tool.name} ${actionLabel}完成`
  });
}

// 厂商安装脚本只允许 HTTPS；完整下载后再执行，避免 HTTP 错误/截断响应直接进入 shell 管道。
const MAX_VENDOR_SCRIPT_BYTES = 4 * 1024 * 1024;
async function downloadVendorScript(url) {
  const source = new URL(url);
  if (source.protocol !== 'https:' || source.username || source.password) {
    throw new Error('厂商安装脚本 URL 必须为无凭据的 HTTPS 地址');
  }
  const response = await fetchWithTimeout(source.href, {}, 30000);
  const finalUrl = new URL(response.url || source.href);
  if (!response.ok) throw new Error(`脚本下载失败（HTTP ${response.status}）`);
  if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password) {
    throw new Error('厂商脚本重定向必须保持无凭据的 HTTPS 地址');
  }
  const announcedSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(announcedSize) && announcedSize > MAX_VENDOR_SCRIPT_BYTES) {
    throw new Error('厂商脚本超过 4 MiB 安全上限');
  }
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) throw new Error('当前运行时不支持安全读取脚本响应');
  const chunks = [];
  let total = 0;
  let bodyTimer;
  try {
    const bodyRead = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_VENDOR_SCRIPT_BYTES) throw new Error('厂商脚本超过 4 MiB 安全上限');
        chunks.push(Buffer.from(value));
      }
    })();
    await Promise.race([bodyRead, new Promise((_, reject) => {
      bodyTimer = setTimeout(() => reject(new Error('厂商脚本响应体读取超时')), 30000);
    })]);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(bodyTimer);
  }
  if (total === 0) throw new Error('厂商脚本响应为空');
  return Buffer.concat(chunks, total);
}

function getWindowsPowerShellPath() {
  const root = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(root, 'sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ];
  return candidates.find(fs.existsSync) || 'powershell.exe';
}

async function runDownloadedScript(tool, url, { action, successMsg, args = [] }) {
  let directory;
  try {
    const script = await downloadVendorScript(url);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tool-updater-'));
    const isWin = os.platform() === 'win32';
    const scriptPath = path.join(directory, isWin ? 'vendor-script.ps1' : 'vendor-script.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o600 });
    const unixShell = tool.installScript && tool.installScript.unixShell;
    const command = isWin ? getWindowsPowerShellPath() : (unixShell === 'bash' ? 'bash' : 'sh');
    const commandArgs = isWin
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]
      : [scriptPath, ...args];
    const env = isWin ? buildWindowsChildEnv(process.env) : { ...process.env };
    const result = await runStreamingCommand(tool, command, commandArgs, env, { action, successMsg });
    const cleanup = setTimeout(() => {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 下次系统清理临时目录 */ }
    }, 60000);
    if (cleanup.unref) cleanup.unref();
    directory = null;
    return result;
  } catch (err) {
    const message = `${action}脚本下载或准备失败：${err.message}`;
    sendLog('error', tool.id, message);
    return { success: false, message };
  } finally {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 忽略临时文件清理错误 */ }
    }
  }
}

const INSTALL_TIMEOUT = 5 * 60 * 1000;

function runStreamingCommand(tool, shellCmd, shellArgs, env, { action, successMsg }) {
  const isWin = os.platform() === 'win32';
  const adminTip = isWin ? '请尝试右键以管理员身份运行本应用，或检查杀毒软件是否拦截了子进程。' : '请检查执行权限。';

  return new Promise((resolve) => {
    const fail = (msg, extra = {}) => {
      sendLog('error', tool.id, msg);
      resolve({ success: false, message: msg, ...extra });
    };

    let child;
    try {
      child = spawn(shellCmd, shellArgs, { env, windowsHide: true, detached: !isWin });
    } catch (spawnErr) {
      const isPermError = spawnErr.code === 'EPERM' || spawnErr.code === 'EACCES';
      fail(isPermError ? `权限不足，无法启动${action}进程。${adminTip}` : `启动${action}进程失败: ${spawnErr.message}`);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      fail(`${action}超时（${INSTALL_TIMEOUT / 1000}s），已终止子进程`);
    }, INSTALL_TIMEOUT);

    child.stdout.on('data', (data) => sendLog('data', tool.id, data.toString()));
    child.stderr.on('data', (data) => sendLog('data', tool.id, data.toString()));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const isPermError = err.code === 'EPERM' || err.code === 'EACCES';
      fail(isPermError ? `权限被拒绝: ${err.message}。${adminTip}` : `${action}失败: ${err.message}`);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        sendLog('success', tool.id, successMsg);
        resolve({ success: true });
      } else {
        fail(`${action}退出码: ${code}${isWin ? '（Windows 上可能需要以管理员身份运行）' : '（请检查网络连接或执行权限）'}`, { code });
      }
    });
  });
}

// ===== 卸载执行 =====

async function findAtomcodeBinary(knownPaths = []) {
  const isWin = os.platform() === 'win32';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    ...knownPaths,
    ...(isWin
      ? [
          path.join(localAppData, 'AtomCode', 'atomcode.exe'),
          path.join(process.env.USERPROFILE || os.homedir(), '.local', 'bin', 'atomcode.exe')
        ]
      : [
          '/usr/local/bin/atomcode',
          path.join(os.homedir(), '.local', 'bin', 'atomcode')
        ])
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* 无权限的路径直接跳过 */ }
  }
  const found = findCommandInPath('atomcode', { platform: os.platform(), env: process.env });
  return found.found ? found.fullPath : null;
}

async function doUninstall(toolId) {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  if (tool.id === 'atomcode') {
    sendLog('start', tool.id, `开始卸载 ${tool.name} ...`);
    const isWin = os.platform() === 'win32';
    if (isWin) {
      await execCommand('taskkill', ['/f', '/im', 'atomcode.exe'], { ignoreError: true, timeout: 5000 })
        .catch(() => {});
    }
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const fullPath = path.join(localAppData, 'AtomCode', 'atomcode.exe');
    const exe = (isWin && fs.existsSync(fullPath)) ? fullPath : tool.cmd;
    const binPath = await findAtomcodeBinary();
    const binResult = await runStreamingCommand(tool, exe, ['uninstall', '--yes', '--keep-data'], { ...process.env }, {
      action: '卸载',
      successMsg: `${tool.name} 已卸载（保留 ~/.atomcode 用户数据）`
    });
    if (binResult.success) {
      const left = await findAtomcodeBinary([binPath]);
      if (!left) return binResult;
      const leftMsg = `${tool.name} 卸载后二进制仍存在（${left}），请手动删除该文件，并从 PATH 中移除对应目录。`;
      sendLog('error', tool.id, leftMsg);
      return { success: false, message: leftMsg, docsUrl: SCRIPT_INSTALLED_TOOLS[tool.id].docsUrl, manualUninstall: true };
    }

    sendLog('info', tool.id, 'atomcode uninstall 不可用，改用已下载的官方卸载脚本 ...');
    const scriptUrl = isWin
      ? 'https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/uninstall.ps1'
      : 'https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/uninstall.sh';
    const scriptArgs = isWin ? ['-Yes', '-KeepData'] : ['--yes', '--keep-data'];
    const scriptResult = await runDownloadedScript(tool, scriptUrl, {
      action: '卸载',
      successMsg: `${tool.name} 已卸载（保留 ~/.atomcode 用户数据）`,
      args: scriptArgs
    });
    if (scriptResult.success) {
      const stillThere = await findAtomcodeBinary([binPath]);
      if (!stillThere) return scriptResult;
      const leftMsg = `${tool.name} 卸载脚本执行完毕，但二进制仍存在（${stillThere}），可能装在脚本未覆盖的位置。`
        + '请手动删除该文件，并从 PATH 中移除对应目录。';
      sendLog('error', tool.id, leftMsg);
      return { success: false, message: leftMsg, docsUrl: SCRIPT_INSTALLED_TOOLS[tool.id].docsUrl, manualUninstall: true };
    }

    const docsUrl = SCRIPT_INSTALLED_TOOLS[tool.id].docsUrl;
    const msg = `${tool.name} 自动卸载失败（${scriptResult.message}）。官方脚本地址：${scriptUrl}`;
    sendLog('error', tool.id, msg);
    return { success: false, message: msg, docsUrl, manualUninstall: true };
  }

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
  const shellArgs = isWin ? ['/d', '/c', uninstallCmd] : ['-c', uninstallCmd];

  return runStreamingCommand(tool, shellCmd, shellArgs, { ...process.env, NPM_CONFIG_REGISTRY: currentRegistry }, {
    action: '卸载',
    successMsg: `${tool.name} 已卸载`
  });
}

// 所有 renderer IPC 都必须来自当前窗口加载的本地 index.html 主 frame。
function isTrustedIpcEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = mainWindow.webContents;
  const frame = event && event.senderFrame;
  if (!event || event.sender !== contents || !frame || frame !== contents.mainFrame) return false;
  try {
    return frame.url === pathToFileURL(path.join(__dirname, 'index.html')).href;
  } catch {
    return false;
  }
}

function registerTrustedIpcHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error(`拒绝来自非受信任页面的 IPC 调用：${channel}`);
    }
    return handler(event, ...args);
  });
}

// ===== IPC 处理程序（主进程 ↔ 渲染进程通信） =====

registerTrustedIpcHandler('get-tools', () => getAllTools());

// 批量检测所有工具版本（受并发限流保护，流式推送）
registerTrustedIpcHandler('check-versions', async () => {
  const now = Date.now();
  if (now - lastCheckBatchAt < CHECK_BATCH_MIN_INTERVAL_MS) {
    throw new Error('版本检测请求过于频繁，请稍后再试');
  }
  lastCheckBatchAt = now;
  const runId = beginCheckRun();
  checkBatchInFlight = true;
  try {
    await refreshProcessPath();
    const tools = getAllTools();
    const results = await Promise.all(tools.map(async (tool) => {
      if (!isCurrentCheckRun(runId, activeCheckRunId)) return null;
      const result = await runLimitedCheck(() => isCurrentCheckRun(runId, activeCheckRunId)
        ? checkToolSafely(tool)
        : null);
      if (!result) return null;
      if (isCurrentCheckRun(runId, activeCheckRunId) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tool-checked', { runId, result });
      }
      return result;
    }));
    return { runId, results: results.filter(Boolean) };
  } finally {
    checkBatchInFlight = false;
  }
});

// 检测单个工具版本：不递增 activeCheckRunId（避免打断正在进行的全量检测或并发单工具刷新），由结果中的 seq 保证新旧顺序
registerTrustedIpcHandler('check-version', async (event, toolId) => {
  await refreshProcessPath();
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');
  return runLimitedCheck(() => checkToolSafely(tool));
});

registerTrustedIpcHandler('update-tool', async (event, toolId) => {
  const result = await doInstallOrUpdate(toolId, '更新');
  await refreshProcessPath({ force: true });
  return result;
});

registerTrustedIpcHandler('install-tool', async (event, toolId) => {
  const result = await doInstallOrUpdate(toolId, '安装');
  await refreshProcessPath({ force: true });
  return result;
});

registerTrustedIpcHandler('uninstall-tool', async (event, toolId) => {
  const result = await doUninstall(toolId);
  await refreshProcessPath({ force: true });
  return result;
});

// ===== 镜像源相关 IPC =====

registerTrustedIpcHandler('get-registries', () => REGISTRIES);

registerTrustedIpcHandler('get-current-registry', () => currentRegistry);

registerTrustedIpcHandler('set-registry', (event, url) => {
  if (!isValidRegistryUrl(url)) {
    const message = '无效的镜像源 URL，请使用无凭据/查询参数的 HTTPS 地址';
    return { success: false, message };
  }
  const normalized = url.trim().endsWith('/') ? url.trim() : `${url.trim()}/`;
  currentRegistry = normalized;
  saveSettings({ registry: normalized });
  return { success: true, registry: normalized };
});

// ===== 自定义工具 IPC =====

registerTrustedIpcHandler('add-custom-tool', (event, toolConfig) => {
  if (!hasOnlyFields(toolConfig, ['name', 'cmd', 'pkg', 'versionArg'])) {
    return { success: false, message: '自定义工具配置包含不支持的字段' };
  }
  if (!isValidToolName(toolConfig.name) || typeof toolConfig.cmd !== 'string' || typeof toolConfig.pkg !== 'string') {
    return { success: false, message: '工具名称、命令名和包名必须是有效文本' };
  }
  if (toolConfig.versionArg !== undefined && typeof toolConfig.versionArg !== 'string') {
    return { success: false, message: '版本参数必须是文本' };
  }
  const name = toolConfig.name.trim();
  const cmd = toolConfig.cmd.trim();
  const pkg = toolConfig.pkg.trim();
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
  if (!isValidVersionArg(versionArg)) {
    return { success: false, message: '版本参数不合法' };
  }

  // 同时对内置工具（含 altCmds）与已有自定义工具做大小写不敏感查重
  const cmdLower = cmd.toLowerCase();
  const pkgLower = pkg.toLowerCase();
  const allExisting = getAllTools();
  const conflict = allExisting.find(t => {
    const allCmds = [t.cmd, ...(t.altCmds || [])].filter(Boolean).map(c => c.toLowerCase());
    return allCmds.includes(cmdLower) || (t.pkg && t.pkg.toLowerCase() === pkgLower);
  });
  if (conflict) {
    return { success: false, message: `已存在相同命令名或包名的工具（与 "${conflict.name}" 冲突）` };
  }

  const custom = loadCustomTools();
  const id = 'custom_' + Date.now();
  const newTool = { id, name, cmd, pkg, versionArg };
  custom.push(newTool);
  saveCustomTools(custom);
  return { success: true, tool: newTool };
});

registerTrustedIpcHandler('remove-custom-tool', (event, toolId) => {
  let custom = loadCustomTools();
  custom = custom.filter(t => t.id !== toolId);
  saveCustomTools(custom);
  return { success: true };
});

// ===== 环境健康检测 IPC =====

registerTrustedIpcHandler('check-environment', async () => {
  const result = { node: null, npm: null, os: null, errors: [] };

  try { await refreshProcessPath(); } catch { /* 刷新失败不阻断检测 */ }

  const isWin = os.platform() === 'win32';
  const [nodeResult, npmResult] = await Promise.allSettled([
    execCommand('node', ['-v'], { shell: isWin, timeout: 10000 }),
    execCommand('npm', ['-v'], { shell: isWin, timeout: 10000 })
  ]);

  if (nodeResult.status === 'fulfilled') {
    result.node = extractVersionLine(nodeResult.value);
  } else {
    result.errors.push('未检测到 Node.js，请先安装 Node.js (https://nodejs.org)');
  }

  if (npmResult.status === 'fulfilled') {
    result.npm = extractVersionLine(npmResult.value);
  } else {
    result.errors.push('未检测到 npm，请检查 Node.js 安装是否完整');
  }

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

  if (result.node) {
    const match = result.node.match(/v?(\d+)/);
    if (match && parseInt(match[1], 10) < 18) {
      result.errors.push(`Node.js 版本过低 (${result.node})，建议升级到 v18 或更高版本`);
    }
  }

  return result;
});

// ===== 日志与报告导出 IPC =====

registerTrustedIpcHandler('export-log', async (event, logText) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出日志',
    defaultPath: `ai-tool-updater-log-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  });
  if (!filePath) return { success: false, cancelled: true };
  try {
    await fs.promises.writeFile(filePath, String(logText || ''), 'utf-8');
    sendLog('success', 'system', `日志已导出到: ${filePath}`);
    return { success: true, filePath };
  } catch (err) {
    sendLog('error', 'system', `导出日志失败: ${err.message}`);
    return { success: false, message: err.message };
  }
});

registerTrustedIpcHandler('copy-to-clipboard', (event, text) => {
  clipboard.writeText(String(text || ''));
  return { success: true };
});

registerTrustedIpcHandler('export-report', async (event, { text, defaultName } = {}) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出版本报告',
    defaultPath: defaultName || `ai-tools-version-report-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [{ name: '文档 / 文本', extensions: ['md', 'json', 'txt'] }]
  });
  if (!filePath) return { success: false, cancelled: true };
  try {
    await fs.promises.writeFile(filePath, String(text || ''), 'utf-8');
    sendLog('success', 'system', `版本报告已导出到: ${filePath}`);
    return { success: true, filePath };
  } catch (err) {
    sendLog('error', 'system', `导出版本报告失败: ${err.message}`);
    return { success: false, message: err.message };
  }
});

// ===== 管理员权限提示 IPC =====

registerTrustedIpcHandler('show-admin-tip', async () => {
  const isWin = os.platform() === 'win32';
  const message = isWin
    ? '在 Windows 上全局安装 npm 包可能需要管理员权限。\n\n如果安装/更新失败，请右键点击「AI Code Tool Updater.exe」选择「以管理员身份运行」，或将 npm 全局目录配置到用户目录后重试。'
    : '在 macOS/Linux 上全局安装 npm 包时，如果遇到 EACCES 权限错误，请不要使用 sudo 运行本应用。\n\n建议把 npm 全局目录改到用户目录（npm config set prefix ~/.npm-global），或修复全局目录权限后重试。';
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: isWin ? '需要管理员权限' : 'npm 权限提示',
    message,
    buttons: ['知道了']
  });
});

// ===== 打开外部链接 IPC =====

registerTrustedIpcHandler('open-external', async (event, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不允许的协议: ${parsed.protocol}`);
    }
  } catch (err) {
    sendLog('error', 'system', `拒绝打开链接: ${err.message}`);
    return { success: false, message: err.message };
  }
  await shell.openExternal(url);
  return { success: true };
});

// ===== 设置 IPC =====

registerTrustedIpcHandler('get-settings', () => loadSettings());

const SETTINGS_SCHEMA = {
  backgroundCheckHours: (v) => Number.isFinite(v) && v >= 0 && v <= 24 * 30,
  minimizeToTray: (v) => typeof v === 'boolean',
  openAtLogin: (v) => typeof v === 'boolean',
  startMinimized: (v) => typeof v === 'boolean',
};

registerTrustedIpcHandler('save-settings', (event, input) => {
  const newSettings = {};
  for (const [key, isValid] of Object.entries(SETTINGS_SCHEMA)) {
    if (input && key in input && isValid(input[key])) newSettings[key] = input[key];
  }
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

const PROFILE_QUERY_PS = `
$ErrorActionPreference='SilentlyContinue'
$paths = New-Object System.Collections.Generic.List[string]
if ($PROFILE) { $paths.Add([string]$PROFILE) }
if ($PROFILE.CurrentUserCurrentHost) { $paths.Add([string]$PROFILE.CurrentUserCurrentHost) }
$docs = [Environment]::GetFolderPath('MyDocuments')
if ($docs) {
  $paths.Add([IO.Path]::Combine($docs,'WindowsPowerShell','Microsoft.PowerShell_profile.ps1'))
  $paths.Add([IO.Path]::Combine($docs,'PowerShell','Microsoft.PowerShell_profile.ps1'))
}
[pscustomobject]@{ paths = @($paths) } | ConvertTo-Json -Compress
`;

async function getPowerShellProfiles() {
  const home = os.homedir();
  const fallback = [
    path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
  ];
  if (os.platform() !== 'win32') return fallback;
  try {
    const output = await execCommand(
      getWindowsPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', PROFILE_QUERY_PS],
      { shell: false, timeout: 8000 }
    );
    const parsed = JSON.parse(output.trim());
    if (parsed && Array.isArray(parsed.paths)) {
      const discovered = parsed.paths.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
      if (discovered.length) return [...new Set(discovered)];
    }
  } catch { /* 查询失败时退回默认路径 */ }
  return fallback;
}

async function confirmAgyyoloProfileChange({ remove, profiles }) {
  const operation = remove ? '撤销' : '写入';
  const fileList = profiles.length ? profiles.map(p => `• ${p}`).join('\n') : '（未能发现 Profile 路径）';
  const message = remove
    ? '将从以下 PowerShell Profile 中移除本工具管理的 agyyolo 函数；其它内容不会改动。'
    : '这会持久写入一个 agyyolo 函数，执行 agy --dangerously-skip-permissions。该命令会跳过 agy 的逐项权限确认，可能允许它直接修改文件或运行命令。';
  const detail = `${operation}目标：\n${fileList}\n\n可以随时使用“撤销 agyyolo”移除本工具管理的配置。`;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: remove ? '确认撤销 agyyolo 配置' : '确认写入跳过权限确认的命令',
    message,
    detail,
    buttons: ['取消', remove ? '确认撤销' : '我了解风险，继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return response === 1;
}

registerTrustedIpcHandler('install-agyyolo', async () => {
  if (os.platform() !== 'win32') {
    const message = 'agyyolo 仅支持 Windows PowerShell，当前系统无需配置。';
    sendLog('error', 'system', message);
    return { success: false, agyFound: false, results: [], message };
  }

  await refreshProcessPath();
  const agyLoc = findCommandInPath('agy', { platform: 'win32', env: process.env });
  let agyFound = agyLoc.found;
  if (!agyFound) {
    try {
      await execCommand('agy', ['--version'], { shell: true, timeout: 10000 });
      agyFound = true;
    } catch { agyFound = false; }
  }
  if (!agyFound) {
    const message = '未检测到 agy 命令，请先安装 agy 并将其所在目录加入系统 PATH，再执行配置。';
    sendLog('error', 'system', message);
    return { success: false, agyFound: false, results: [], message };
  }

  const profiles = uniqueProfilePaths(await getPowerShellProfiles());
  if (!(await confirmAgyyoloProfileChange({ remove: false, profiles }))) {
    return { success: false, cancelled: true, agyFound: true, results: [], message: '已取消，未修改任何 Profile。' };
  }

  const results = [];
  for (const profilePath of profiles) {
    try {
      const result = installAgyyoloToProfile(profilePath);
      results.push({ profile: profilePath, ...result });
      sendLog(result.ok ? 'success' : 'error', 'system', `[${result.ok ? 'OK' : 'FAIL'}] ${profilePath} - ${result.reason}`);
    } catch (err) {
      results.push({ profile: profilePath, ok: false, reason: err.message });
      sendLog('error', 'system', `[FAIL] ${profilePath} - ${err.message}`);
    }
  }
  const success = profileResultsSucceeded(results);
  const message = success
    ? 'agyyolo 配置完成。请重新打开 PowerShell 窗口使用。'
    : `配置未能全部完成：成功 ${results.filter(r => r.ok).length} 个，失败 ${results.filter(r => !r.ok).length} 个。`;
  sendLog(success ? 'success' : 'error', 'system', message);
  return { success, results, agyFound: true, message };
});

registerTrustedIpcHandler('remove-agyyolo', async () => {
  if (os.platform() !== 'win32') {
    return { success: false, results: [], message: 'agyyolo 仅支持 Windows PowerShell。' };
  }
  const profiles = uniqueProfilePaths(await getPowerShellProfiles());
  if (!(await confirmAgyyoloProfileChange({ remove: true, profiles }))) {
    return { success: false, cancelled: true, results: [], message: '已取消，未修改任何 Profile。' };
  }
  const results = [];
  for (const profilePath of profiles) {
    try {
      const result = removeAgyyoloFromProfile(profilePath);
      results.push({ profile: profilePath, ...result });
      sendLog(result.ok ? 'success' : 'error', 'system', `[${result.ok ? 'OK' : 'FAIL'}] ${profilePath} - ${result.reason}`);
    } catch (err) {
      results.push({ profile: profilePath, ok: false, reason: err.message });
      sendLog('error', 'system', `[FAIL] ${profilePath} - ${err.message}`);
    }
  }
  const success = profileResultsSucceeded(results);
  const message = success
    ? 'agyyolo 配置已撤销。'
    : `撤销未能全部完成：成功 ${results.filter(r => r.ok).length} 个，失败 ${results.filter(r => !r.ok).length} 个。`;
  sendLog(success ? 'success' : 'error', 'system', message);
  return { success, results, message };
});

// ===== 一键打开终端 / PowerShell IPC =====

registerTrustedIpcHandler('open-powershell', async () => {
  const platform = os.platform();

  if (platform === 'win32') {
    const hasPwsh = findCommandInPath('pwsh', { platform: 'win32', env: process.env }).found;
    const shellExe = hasPwsh ? 'pwsh' : 'powershell';
    return spawnDetachedSafely('cmd.exe', ['/d', '/c', 'start', '""', shellExe]);
  }

  if (platform === 'darwin') {
    return spawnDetachedSafely('osascript', [
      '-e', 'tell application "Terminal" to do script ""',
      '-e', 'tell application "Terminal" to activate'
    ]);
  }

  // Linux：依次尝试常见桌面终端模拟器，通过 spawnDetachedSafely 捕获 ENOENT 防止未捕获异常
  const candidates = [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'kitty',
    'alacritty',
    'xterm'
  ];
  let lastError = '未找到可用的终端模拟器';
  for (const term of candidates) {
    const res = await spawnDetachedSafely(term, []);
    if (res.success) return res;
    lastError = res.error || lastError;
  }
  return { success: false, error: lastError };
});

// ===== 镜像源测速 IPC =====
// 向指定镜像源发送请求并校验 HTTP 状态码，防止将返回 4xx/5xx 的故障节点误判为最快可用源
registerTrustedIpcHandler('ping-registry', async (event, url) => {
  if (!isValidRegistryUrl(url)) {
    return { success: false, message: '无效的镜像源 URL' };
  }
  const pingUrl = url.trim().replace(/\/$/, '') + '/';
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let res = await fetch(pingUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'npm-registry-ping' }
    });
    // 部分私有源（Nexus / Verdaccio）不支持根路径 HEAD，回退标准 /-/ping GET 探针
    if (res.status === 405) {
      res = await fetch(`${pingUrl}-/ping`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'npm-registry-ping' }
      });
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
    }
    const ms = Date.now() - start;
    if (!res.ok) {
      return { success: false, ms, status: res.status, message: `HTTP ${res.status}` };
    }
    return { success: true, ms, status: res.status };
  } catch (err) {
    const ms = Date.now() - start;
    return { success: false, ms, message: err.name === 'AbortError' ? '请求超时（>8s）' : err.message };
  } finally {
    clearTimeout(timeout);
  }
});
