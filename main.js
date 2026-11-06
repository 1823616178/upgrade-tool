// ===== Electron 主进程入口 =====
// 依赖：electron（应用框架）、path/fs（文件操作）、child_process（执行系统命令）、os（系统信息）
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, clipboard, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const { pathToFileURL } = require('url');

// 全局只允许一个应用实例。后续启动的实例会立即退出，并通知首个实例唤醒主窗口。
// 必须在 app ready 之前申请锁，避免两个进程同时创建窗口、托盘和后台任务。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

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
  // settings.json 可能被手工改过，恢复前同样做一次校验（isValidRegistryUrl 为函数声明，已提升）
  if (saved.registry && isValidRegistryUrl(saved.registry)) {
    currentRegistry = saved.registry;
  }
} catch { /* 首次启动，无配置文件，使用默认值 */ }

// ===== 内置工具配置 =====
// 预定义的 AI 编码工具列表，包含 CLI 命令名和对应的 npm 包名
// npm 更新只在解析出精确版本后即时构造，避免使用可变的 latest 标签
// installScript: { winUrl, unixUrl } — 只存 HTTPS 脚本地址，不在这里保存管道执行命令

const BUILTIN_TOOLS = [
  { id: 'kimi',       name: 'Kimi Code',              cmd: 'kimi',       pkg: '@moonshot-ai/kimi-code',        versionArg: '--version', icon: '🌙' },
  { id: 'claude',     name: 'Claude Code',             cmd: 'claude',     pkg: '@anthropic-ai/claude-code',     versionArg: '--version', icon: '✳️' },
  { id: 'cline',      name: 'Cline',                   cmd: 'cline',      pkg: 'cline',                        versionArg: '--version', icon: '🧩' },
  {
    // 官方保留 cursor-agent 别名；不用通用的 agent，避免与 Grok 等工具的同名命令冲突
    id: 'cursor', name: 'Cursor CLI', cmd: 'cursor-agent', versionArg: '--version', icon: '🔹',
    installScript: {
      winUrl: 'https://cursor.com/install?win32=true',
      unixUrl: 'https://cursor.com/install',
      unixShell: 'bash'
    },
    docsUrl: 'https://cursor.com/docs/cli'
  },
  { id: 'codex',      name: 'OpenAI Codex',            cmd: 'codex',      pkg: '@openai/codex',                 versionArg: '--version', icon: '🔷' },
  { id: 'opencode',   name: 'OpenCode',                cmd: 'opencode',   pkg: 'opencode-ai',                   versionArg: '--version', icon: '🖥️' },
  { id: 'codebuddy',  name: 'CodeBuddy',               cmd: 'codebuddy',  pkg: '@tencent-ai/codebuddy-code',    versionArg: '--version', icon: '🤖' },
  { id: 'qwen',       name: 'Qwen Code',               cmd: 'qwen',       pkg: '@qwen-code/qwen-code',          versionArg: '--version', icon: '💡' },
  { id: 'commandcode', name: 'Command Code',            cmd: 'command-code', pkg: 'command-code',                versionArg: '--version', icon: '⚡' },
  // 小米 MiMo Code（https://github.com/XiaomiMiMo/MiMo-Code），npm 包 @mimo-ai/cli 提供 mimo 命令
  { id: 'mimo',       name: 'MiMo Code',               cmd: 'mimo',       pkg: '@mimo-ai/cli',                  versionArg: '--version', icon: '🍊' },
  {
    // antigravity 使用独立的安装脚本；已安装时改用 agy update（在 doInstallOrUpdate 中特判）
    id: 'antigravity', name: 'Antigravity CLI', cmd: 'agy', versionArg: '--version', icon: '🪐',
    installScript: {
      winUrl: 'https://antigravity.google/cli/install.ps1',
      unixUrl: 'https://antigravity.google/cli/install.sh',
      unixShell: 'bash'
    },
    docsUrl: 'https://antigravity.google/'
  },
  {
    id: 'atomcode', name: 'AtomCode', cmd: 'atomcode', versionArg: '--version', icon: '⚛️',
    // 卸载时保留 ~/.atomcode 用户数据（与 npm 卸载不删用户数据的语义一致），渲染层据此提示
    uninstallKeepsData: true,
    installScript: {
      winUrl: 'https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.ps1',
      unixUrl: 'https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh',
      unixShell: 'sh'
    },
    docsUrl: 'https://atomgit.com/atomgit_atomcode/atomcode/releases'
  },
  {
    // altCmds：主命令检测失败时依次尝试的备用命令名（旧版安装的是 qoder）
    id: 'qoder', name: 'Qoder CLI', cmd: 'qodercli', altCmds: ['qoder'], pkg: '@qoder-ai/qodercli', versionArg: '--version', icon: '🚀',
    installScript: {
      winUrl: 'https://qoder.com/install.ps1',
      unixUrl: 'https://qoder.com/install',
      unixShell: 'bash'
    },
    docsUrl: 'https://qoder.com/'
  },
  {
    // qoder_cn 安装的是 qoderclicn 命令，与国际版 qodercli 不同
    id: 'qoder_cn', name: 'Qoder CLI (国内镜像)', cmd: 'qoderclicn', versionArg: '--version', icon: '🐉',
    installScript: {
      winUrl: 'https://qoder.com.cn/install.ps1',
      unixUrl: 'https://qoder.com.cn/install',
      unixShell: 'bash'
    },
    docsUrl: 'https://qoder.com.cn/'
  },
  {
    // grok 使用 xAI 官方安装脚本，不通过 npm 安装
    id: 'grok', name: 'Grok CLI', cmd: 'grok', versionArg: '--version', icon: '🛸',
    installScript: {
      winUrl: 'https://x.ai/cli/install.ps1',
      unixUrl: 'https://x.ai/cli/install',
      unixShell: 'bash'
    },
    docsUrl: 'https://x.ai/'
  },
  {
    // Muse CLI 官方已提供 Windows 原生安装脚本（x64 / ARM64），装到 %LOCALAPPDATA%\Programs\muse\muse.cmd 并写入用户 PATH
    // 重新执行安装脚本即会拉取 channel 最新版本，因此更新与安装共用同一脚本
    // checkEnv：版本检测时附加的环境变量。muse launcher 每次运行都会触发后台自更新（二进制缺失时甚至前台下载 ~400MB），
    // 检测版本不应产生副作用，故禁用自动更新
    id: 'muse', name: 'Muse CLI', cmd: 'muse', versionArg: '--version', icon: '🎭',
    checkEnv: { MUSE_NO_AUTO_UPDATE: '1' },
    installScript: {
      winUrl: 'https://dev.meta.ai/install.ps1',
      unixUrl: 'https://dev.meta.ai/install.sh',
      unixShell: 'bash'
    },
    docsUrl: 'https://dev.meta.ai/'
  },
];

// 通过官方安装脚本安装的工具（antigravity/cursor/qoder/qoder_cn/grok/muse 无统一卸载命令；atomcode 由 doUninstall 特判自动卸载）
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
 * 将自定义工具列表写入磁盘
 * @param {object[]} tools - 要保存的工具数组
 */
function saveCustomTools(tools) {
  fs.writeFileSync(getCustomToolsPath(), JSON.stringify(tools, null, 2), 'utf-8');
}

/**
 * 获取所有工具（内置 + 自定义）；npm 安装命令仅在取得精确版本后构造
 * 脚本安装类工具（有 installScript 的）由 doInstallOrUpdate 直接读 installScript 执行，
 * 安装脚本只有 URL 元数据，不需要派生 updateCmd —— 避免脚本与 npm 命令混淆
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
let mainWindow = null;    // 主窗口实例
let tray = null;          // 系统托盘实例
let backgroundTimer = null; // 后台版本检测定时器引用
let isQuitting = false;   // 应用正在退出（Cmd+Q / 系统关机等），此时关窗不再拦截为最小化到托盘
let activeCheckRunId = 0;
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
 * - 设置窗口尺寸、最小尺寸、图标
 * - 启用 contextIsolation 安全策略，通过 preload.js 暴露 API
 * - 加载 index.html 作为 UI
 * - 关闭窗口时根据设置决定是否最小化到托盘
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
  // 外链一律交给系统浏览器（且只放行 http/https），防止渲染进程被导航到外部页面。
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
    if (mainWindow.isDestroyed()) return;
    // 开启「启动时最小化到托盘」时，窗口创建后不显示，等用户从托盘打开；
    // 由托盘/通知/二次启动主动唤起时（options.show），忽略该设置
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
    // 用户未开启"最小化到托盘"：Windows/Linux 关窗即退出，先销毁托盘避免应用变僵尸进程；
    // macOS 关窗不退出应用，保留托盘以便随时恢复窗口
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
  try {
    let icon = APP_ICON_PATH;
    if (process.platform === 'darwin') {
      // macOS 菜单栏图标使用 PNG 并缩放到 18pt，ICO 无法在 Tray 中正常显示
      const image = nativeImage.createFromPath(APP_ICON_PATH);
      if (!image.isEmpty()) {
        icon = image.resize({ width: 18, height: 18 });
      }
    }
    tray = new Tray(icon);
  } catch {
    // 图标文件不存在或平台不支持时跳过托盘创建
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
        // 真正退出应用：走 app.quit() 正常退出流程（before-quit 会放行窗口关闭），
        // 不用 app.exit()，避免跳过清理、打断尚未写完的设置文件
        tray.destroy();
        tray = null;
        app.quit();
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
  // 旧版本可能存下了非法值（如 NaN），此时回退默认 4 小时，避免 setInterval(NaN) 近乎无间隔触发
  const saved = settings.backgroundCheckHours ?? 4;
  const hours = Number.isFinite(saved) ? saved : 4;
  if (hours <= 0) return; // 用户禁用了后台检测

  const intervalMs = hours * 60 * 60 * 1000;
  backgroundTimer = setInterval(async () => {
    try {
      // 用户可能在应用外安装/卸载了工具，先刷新 PATH（命中 TTL 缓存时不拉起子进程）
      await refreshProcessPath();
      const tools = getAllTools();
      // 后台定时检测静默执行（不刷日志窗口），仅在有更新时弹系统通知
      const results = await Promise.all(tools.map(t => runLimitedCheck(() => checkToolSafely(t, { silent: true }))));
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

if (hasSingleInstanceLock) {
  // 再次启动应用时不创建新实例，只恢复并聚焦已有的主窗口。
  app.on('second-instance', () => {
    showOrCreateWindow();
  });

  // 标记正在退出，让窗口 close 事件放行（否则托盘存在时 app.quit 会被拦截为隐藏窗口）
  app.on('before-quit', () => {
    isQuitting = true;
    stopBackgroundCheck();
  });

  // Electron 就绪后创建窗口、托盘并启动后台检测
  app.whenReady().then(() => {
    configureApplicationMenu();
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
    showOrCreateWindow();
  });
}

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

// 远端版本查询（manifest / API）的 HTTP 超时（毫秒），防止网络挂起导致整轮检测卡在“检测中”
const HTTP_TIMEOUT = 10000;

/**
 * 带超时的 fetch
 * @param {string} url
 * @param {object} [options] - 透传给 fetch
 * @param {number} [timeoutMs]
 */
function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 终止子进程及其所有后代进程
 * Windows 上 child.kill() 只会结束 cmd.exe / powershell.exe 本身，真正干活的 npm、下载进程会成为孤儿继续运行，
 * 需用 taskkill /T 连同进程树一起结束
 * @param {import('child_process').ChildProcess} child
 */
function killProcessTree(child) {
  // 组长可能已退出但留下后代，因此不能以 exitCode 判断整个进程组是否已结束。
  if (!child || !child.pid) return;
  if (os.platform() === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { child.kill(); } catch { /* ignore */ } });
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
  } else {
    try {
      // POSIX 子进程以 detached 模式创建，PID 同时是独立进程组 ID。
      process.kill(-child.pid, 'SIGTERM');
      const forceKill = setTimeout(() => {
        try {
          process.kill(-child.pid, 0);
          process.kill(-child.pid, 'SIGKILL');
        } catch { /* 进程组已退出 */ }
      }, 1000);
      if (forceKill.unref) forceKill.unref();
    } catch {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

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
    const env = options.env || process.env;
    let child;
    if (isWin && options.shell) {
      // Windows 下通过 cmd.exe 执行，支持 .bat/.cmd 等
      child = spawn('cmd.exe', ['/c', command, ...args], { env, windowsHide: true });
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
    let settled = false; // 防止超时和 close 事件竞争

    // 超时保护：避免子进程卡住导致 Promise 永远不结束
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
    // 同前缀的「字母+数字」段（如 Muse 的 R999 vs R3401）按数字比较，
    // 否则按 ASCII 字典序会得出 R999 > R3401 的错误结论
    const ma = xa.match(/^([A-Za-z]+)(\d+)$/);
    const mb = xb.match(/^([A-Za-z]+)(\d+)$/);
    if (ma && mb && ma[1] === mb[1]) {
      const da = parseInt(ma[2], 10);
      const db = parseInt(mb[2], 10);
      if (da !== db) return da < db ? -1 : 1;
    } else if (na !== null && nb !== null) {
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
 * 校验 npm 镜像源 URL（仅允许 HTTPS）
 * 镜像源会被拼进 cmd.exe / sh -c 执行的命令串，必须拒绝 shell 特殊字符防止命令注入
 */
function isValidRegistryUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (/[\s;&|`$<>(){}\\'"!^%*]/.test(url.trim())) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyFields(value, allowedFields) {
  return isPlainObject(value) && Object.keys(value).every(key => allowedFields.includes(key));
}

function isValidToolName(name) {
  return typeof name === 'string'
    && name.trim().length > 0
    && name.trim().length <= 80
    && !/[\u0000-\u001f\u007f]/.test(name);
}

/**
 * 校验 CLI 命令名
 */
function isValidCliCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cmd);
}

/**
 * 校验版本参数（会被拼进 shell 命令，禁止空格与 shell 特殊字符）
 * 允许 --version、-V、version 等常见形式
 */
function isValidVersionArg(arg) {
  if (!arg || typeof arg !== 'string') return false;
  return /^[a-zA-Z0-9._-]+$/.test(arg.replace(/^-+/, ''));
}

// PATH 刷新结果缓存有效期：注册表 PATH 只会在安装/卸载后变化，
// 短时间内的重复刷新（如「一键更新全部」逐个工具触发）直接复用缓存
const PATH_CACHE_TTL = 30 * 1000;
let _pathRefreshedAt = 0;      // 上次成功刷新的时间戳
let _pathRefreshInflight = null; // 正在进行中的刷新 Promise（并发去重）

// Windows 下一次性读出 Machine + User 两段 PATH，用不会出现在路径中的标记分隔
const PATH_SPLIT_MARKER = '<<<PATHSPLIT>>>';
const READ_PATH_PS = [
  "[Environment]::GetEnvironmentVariable('Path','Machine')",
  `'${PATH_SPLIT_MARKER}'`,
  "[Environment]::GetEnvironmentVariable('Path','User')"
].join('; ');

/**
 * 从系统重新读取 PATH 并写入当前进程（安装后可立即检测到新命令）
 *
 * 相比早期实现的改动：
 * - Windows 上由两次 execSync 合并为一次异步 PowerShell 调用，不再阻塞主进程事件循环
 * - 加入 TTL 缓存与并发去重，避免「一键更新全部」时每个工具重复拉起 PowerShell
 *
 * @param {object} [options] - { force } 强制忽略缓存（安装/卸载后应传 true）
 * @returns {Promise<void>} 刷新失败不抛出，静默忽略
 */
function refreshProcessPath(options = {}) {
  // 命中缓存：直接返回，不启动子进程
  if (!options.force && Date.now() - _pathRefreshedAt < PATH_CACHE_TTL) {
    return Promise.resolve();
  }
  // 已有刷新在途：复用同一个 Promise，避免并发重复拉起 PowerShell
  if (_pathRefreshInflight) return _pathRefreshInflight;

  _pathRefreshInflight = (async () => {
    try {
      if (os.platform() === 'win32') {
        const output = await execCommand(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', READ_PATH_PS],
          { shell: false, timeout: 8000 }
        );
        const [machinePath = '', userPath = ''] = output.split(PATH_SPLIT_MARKER);
        // 去掉段内换行：PATH 里不会有换行，而 PowerShell 在窄输出宽度下可能把超长字符串折行，
        // 直接剔除换行即可还原原串（比 trim 更稳）
        const stripBreaks = (v) => v.replace(/[\r\n]+/g, '').trim();
        const registryParts = [stripBreaks(machinePath), stripBreaks(userPath)]
          .filter(Boolean)
          .join(';')
          .split(';')
          .map(p => p.trim())
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
        // macOS/Linux：从 Finder/Dock/开机自启启动时不会加载 shell 配置，
        // PATH 往往只有 /usr/bin:/bin:/usr/sbin:/sbin，导致 Homebrew/nvm 安装的 node/npm 找不到。
        // macOS 额外读取登录 shell 的 PATH，并合并常见安装目录。
        const home = os.homedir();
        const extras = [
          path.join(home, '.local', 'bin'),
          path.join(home, '.npm-global', 'bin'),
          '/opt/homebrew/bin',   // Apple Silicon Homebrew
          '/usr/local/bin'       // Intel Homebrew / 官方安装包
        ];
        let shellPath = '';
        if (os.platform() === 'darwin') {
          try {
            const shell = process.env.SHELL || '/bin/zsh';
            const startMarker = '__CB_PATH_START__';
            const endMarker = '__CB_PATH_END__';
            const output = await execCommand(
              shell,
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
  // 依次尝试主命令与备用命令（altCmds），任一成功即视为已安装
  const cmds = [tool.cmd, ...(tool.altCmds || [])];
  let lastErr = null;
  for (const cmd of cmds) {
    try {
      const env = tool.checkEnv ? { ...process.env, ...tool.checkEnv } : undefined;
      const output = await execCommand(cmd, [tool.versionArg], { shell: true, env });
      const version = output.split(/\r?\n/)[0].trim();
      return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
    } catch (err) {
      lastErr = err;
    }
  }
  let notFound = isCommandNotFound(lastErr);
  // Windows 下 cmd.exe 的「不是内部或外部命令」按系统代码页（中文系统为 GBK）输出，按 UTF-8 解码后是乱码，
  // 且 cmd /c 带参数时退出码为 1 而非 9009，上面的判断会漏掉 → 未安装的工具被误显示为「检测失败」。
  // 这里用 where 的退出码兜底确认（与系统语言无关）
  if (!notFound && os.platform() === 'win32') {
    notFound = !(await anyCommandExists(cmds));
  }
  return { installed: false, version: null, normalizedVersion: null, notFound, error: lastErr.message };
}

/**
 * Windows：通过 where.exe 判断命令是否存在于 PATH（任一存在即返回 true）
 * where 找不到时退出码为 1，与系统语言无关
 * @param {string[]} cmds - 命令名（均已通过 isValidCliCommand 或为内置常量）
 * @returns {Promise<boolean>}
 */
async function anyCommandExists(cmds) {
  for (const cmd of cmds) {
    try {
      await execCommand('where', [cmd], { shell: false, timeout: 5000 });
      return true;
    } catch { /* 继续尝试下一个 */ }
  }
  return false;
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
 * - cursor：从官方安装脚本中提取当前发布版本
 * - 其他工具：通过 npm view 查询 registry 中的最新版本
 * @param {object} tool - 工具配置对象
 * @returns {Promise<object>} { latest, error? }
 */
async function checkLatestVersion(tool) {
  if (tool.id === 'antigravity') {
    try {
      const platform = getAntigravityPlatform();
      const res = await fetchWithTimeout(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`);
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

  // Cursor 没有独立的 npm 版本线；官方安装脚本中的下载 URL 固定了当前发布版本。
  if (tool.id === 'cursor') {
    try {
      const url = os.platform() === 'win32' ? tool.installScript.winUrl : tool.installScript.unixUrl;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const script = await res.text();
      const match = script.match(/https:\/\/downloads\.cursor\.com\/lab\/([^/'"\s]+)\//);
      if (!match || !parseSemver(match[1])) throw new Error('官方安装脚本中无有效版本号');
      return { latest: match[1] };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  }

  // AtomCode 通过 AtomGit API 获取线上最新 release 版本。
  // 失败时回退官方 release manifest —— 与官方安装脚本（install.sh / install.ps1）的两级取版逻辑一致
  if (tool.id === 'atomcode') {
    const sources = [
      {
        url: 'https://api.atomgit.com/api/v5/repos/atomgit_atomcode/atomcode/releases/latest',
        pick: (data) => data.tag_name,
        init: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
      },
      {
        url: 'https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/latest.json',
        pick: (data) => data.version
      }
    ];
    const errors = [];
    for (const { url, pick, init } of sources) {
      try {
        const res = await fetchWithTimeout(url, init);
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        const version = pick(await res.json());
        // 版本号需可解析，避免拿到错误体/字段后误报版本
        if (!extractVersionNumber(version)) throw new Error('响应中无有效版本号');
        return { latest: version };
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { latest: null, error: errors.join('; ') };
  }

  // qoder_cn 国内版：从官方 manifest 获取最新版本（binary 为 qoderclicn）
  if (tool.id === 'qoder_cn') {
    try {
      const res = await fetchWithTimeout('https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json');
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
        const res = await fetchWithTimeout(url);
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
        const res = await fetchWithTimeout(url, {
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

  // muse：与官方 launcher 一致，读取 channel 指针（默认 muse-stable），版本形如 1.3.0-R3401.1
  if (tool.id === 'muse') {
    const channel = process.env.MUSE_CHANNEL || 'muse-stable';
    try {
      const res = await fetchWithTimeout(`https://api.meta.ai/muse-code/channels/${encodeURIComponent(channel)}`);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const manifest = await res.json();
      if (!manifest || !manifest.version) throw new Error('channel 响应中无 version 字段');
      return { latest: String(manifest.version).trim() };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  }

  // 其余无 npm 包名的工具（脚本安装类）没有远端版本来源，不要再去跑 npm view undefined
  if (!tool.pkg) return { latest: null, error: '无远端版本来源' };

  // 普通 npm 工具：优先走 registry HTTP 接口（毫秒级），失败再回退到 npm view 子进程
  const viaHttp = await fetchLatestFromRegistry(tool.pkg);
  if (viaHttp.latest) return viaHttp;

  // HTTP 失败（私有源不支持 /latest、需要认证、网络异常等）：回退到 npm CLI，仍保留 1 次重试
  let lastErr = viaHttp.error;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const output = await execCommand('npm', ['view', tool.pkg, 'version', `--registry=${currentRegistry}`], { shell: true });
      return { latest: output.trim() };
    } catch (err) {
      lastErr = err.message;
      if (attempt < 2) {
        // 等待 2 秒后重试（网络抖动场景）
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return { latest: null, error: lastErr };
}

// registry HTTP 查询超时（毫秒）——远快于 npm view 子进程冷启动，超时也就回退
const REGISTRY_HTTP_TIMEOUT = 6000;

/**
 * 直接向 npm registry 查询包的最新版本
 * 相比 `npm view` 省掉一次 Node 进程冷启动（约 1-3s → 几十 ms），且不占用子进程
 * @param {string} pkg - npm 包名（调用前已由 isValidNpmPackage 校验）
 * @returns {Promise<{latest: string|null, error?: string}>}
 */
async function fetchLatestFromRegistry(pkg) {
  if (!pkg) return { latest: null, error: '缺少包名' };
  const base = currentRegistry.endsWith('/') ? currentRegistry : `${currentRegistry}/`;
  // scope 中的 / 需要保留原样，npmjs / npmmirror 均支持 /@scope/name/latest
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

// 跨 IPC 与后台检查共享并发上限，避免一次批量操作同时启动所有本地命令和网络请求。
function createConcurrencyLimiter(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        active--;
        drain();
      });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

const runLimitedCheck = createConcurrencyLimiter(4);

async function checkToolSafely(tool, options = {}) {
  try {
    return await checkTool(tool, options);
  } catch (err) {
    return {
      ...tool,
      installed: false,
      currentVersion: null,
      latestVersion: null,
      notFound: false,
      error: err && err.message ? err.message : String(err),
      needsUpdate: false,
      isAhead: false
    };
  }
}

function isCurrentCheckRun(runId, activeRunId) {
  return runId === activeRunId;
}

function beginCheckRun() {
  const runId = ++activeCheckRunId;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('check-run-started', runId);
  }
  return runId;
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

  // 当前平台不支持的工具（BUILTIN_TOOLS 中声明了 platforms 且不含当前平台）：拒绝安装/更新
  if (tool.supported === false) {
    const msg = `${tool.name} 不支持当前平台（${os.platform()}），无法安装/更新`;
    sendLog('error', toolId, msg);
    return { success: false, message: msg };
  }

  // 无安装脚本且无 npm 包名：无法安装
  if (!tool.installScript && !tool.pkg) {
    sendLog('error', toolId, `${tool.name} 缺少安装命令（未配置 npm 包名或安装脚本）`);
    return { success: false, message: '缺少安装命令' };
  }

  sendLog('start', tool.id, `开始安装/更新 ${tool.name} ...`);

  const isWin = os.platform() === 'win32';
  let shellCmd;
  let shellArgs;

  // ===== HTTPS 厂商脚本：先完整下载到受限临时文件，再由本地解释器执行 =====
  if (tool.installScript) {
    if (tool.id === 'antigravity') {
      // antigravity 已安装时使用内置 update 子命令，避免重新执行安装脚本。
      const localStatus = await checkLocalVersion(tool);
      if (localStatus.installed) {
        const shellCmd = isWin ? 'cmd.exe' : 'sh';
        const shellArgs = isWin ? ['/c', 'agy update'] : ['-c', 'agy update'];
        return runStreamingCommand(tool, shellCmd, shellArgs, { ...process.env }, {
          action: '更新', successMsg: `${tool.name} 操作完成`
        });
      }
    }

    // AtomCode 安装前先结束占用中的二进制，避免 Windows 无法替换文件。
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
      action: '安装', successMsg: `${tool.name} 操作完成`
    });
  }

  // ===== npm 安装类工具：先查询当前 registry 的版本，再安装不可变的精确版本 =====
  const versionInfo = await fetchLatestFromRegistry(tool.pkg);
  const exactVersion = versionInfo.latest && parseSemver(versionInfo.latest)
    ? String(versionInfo.latest).trim().replace(/^v/i, '')
    : null;
  if (!exactVersion) {
    const message = `无法从 HTTPS registry 获取有效版本，未执行安装：${versionInfo.error || '版本格式无效'}`;
    sendLog('error', tool.id, message);
    return { success: false, message };
  }
  const installCmd = `npm install -g ${tool.pkg}@${exactVersion} --registry=${currentRegistry}`;
  if (isWin) {
    shellCmd = 'cmd.exe';
    shellArgs = ['/c', installCmd];
  } else {
    shellCmd = 'sh';
    shellArgs = ['-c', installCmd];
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

  return runStreamingCommand(tool, shellCmd, shellArgs, childEnv, {
    action: '安装',
    successMsg: `${tool.name} 操作完成`
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
    const env = { ...process.env };
    if (isWin) {
      const systemRoot = env.SystemRoot || 'C:\\Windows';
      const modulePaths = [
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'Modules')
      ];
      env.PSModulePath = [...(env.PSModulePath || '').split(';').filter(Boolean), ...modulePaths]
        .filter((value, index, all) => all.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index)
        .join(';');
    }
    const result = await runStreamingCommand(tool, command, commandArgs, env, { action, successMsg });
    // 超时后进程组会被终止；延迟清理避免解释器尚未完全退出时文件被锁定。
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

// 安装/卸载子进程超时（5 分钟），防止子进程挂起导致 UI 锁死
const INSTALL_TIMEOUT = 5 * 60 * 1000;

/**
 * 启动安装/卸载子进程，实时把输出转发到渲染进程日志，并统一处理权限错误与超时
 * @param {object} tool - 工具配置（用于日志归属）
 * @param {string} shellCmd - 可执行文件
 * @param {string[]} shellArgs - 参数
 * @param {object} env - 子进程环境变量
 * @param {object} labels - { action: '安装'|'卸载', successMsg }
 * @returns {Promise<object>} { success, code?, message? }（不会 reject）
 */
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
      // windowsHide 隐藏控制台窗口；不 detached，避免某些安全软件拦截新进程组
      child = spawn(shellCmd, shellArgs, { env, windowsHide: true, detached: !isWin });
    } catch (spawnErr) {
      // spawn 同步抛出的错误（如 EPERM）
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

    // 实时转发 stdout / stderr 到渲染进程日志
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

/**
 * 查找本机仍存在的 AtomCode 二进制
 * 官方卸载脚本在找不到二进制时依然打印 "uninstall complete." 并以 0 退出，
 * 卸载后需要回查一遍才能判断是否真的卸干净。
 * 查找范围与官方卸载脚本保持一致（PATH + 官方默认安装目录），
 * 外加卸载前已定位到的路径 —— 比脚本更准，能覆盖脚本漏掉的 Windows 用户目录。
 * @param {string[]} [knownPaths] - 卸载前已知的二进制路径（最准确，优先检查）
 * @returns {Promise<string|null>} 仍存在的二进制路径；没有则返回 null
 */
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
  // 再扫一遍 PATH 里的各个目录（不 spawn 子进程，避免 shell 拼接带来的告警）
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, isWin ? 'atomcode.exe' : 'atomcode');
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* 无权限的目录直接跳过 */ }
  }
  return null;
}

/**
 * 执行单个工具的卸载
 * - npm 安装的工具：npm uninstall -g <pkg>
 * - AtomCode：先跑内置 `atomcode uninstall`，失败回退官方卸载脚本，再失败才给手动指引
 * - 其他通过官方脚本安装的工具（antigravity/cursor/qoder/qoder_cn/grok/muse）：没有统一卸载命令，提示手动卸载
 * @param {string} toolId - 工具 ID
 * @returns {Promise<object>} { success, code?, message?, docsUrl? }
 */
async function doUninstall(toolId) {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  // AtomCode：优先用二进制内置的 `atomcode uninstall`，失败（老版本没有该子命令 / 二进制已损坏）再跑官方卸载脚本。
  // --keep-data 只删二进制与 PATH 注入，保留 ~/.atomcode 用户数据，与 npm 卸载不删用户数据的语义一致
  if (tool.id === 'atomcode') {
    sendLog('start', tool.id, `开始卸载 ${tool.name} ...`);
    const isWin = os.platform() === 'win32';
    // Windows：先终止正在运行的进程，避免运行中的 exe 删不掉
    if (isWin) {
      await execCommand('taskkill', ['/f', '/im', 'atomcode.exe'], { ignoreError: true, timeout: 5000 })
        .catch(() => {});
    }
    // 与 checkLocalVersion 同款兜底：Windows 下二进制可能不在 PATH，优先全路径执行
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const fullPath = path.join(localAppData, 'AtomCode', 'atomcode.exe');
    const exe = (isWin && fs.existsSync(fullPath)) ? fullPath : tool.cmd;
    // 卸载前先定位二进制在哪：官方卸载脚本只认 PATH 和几个默认目录，
    // 它找不到时会打印 "uninstall complete." 并以 0 退出（实测复现），不能当成功
    const binPath = await findAtomcodeBinary();
    const binResult = await runStreamingCommand(tool, exe, ['uninstall', '--yes', '--keep-data'], { ...process.env }, {
      action: '卸载',
      successMsg: `${tool.name} 已卸载（保留 ~/.atomcode 用户数据）`
    });
    if (binResult.success) {
      // 二进制内置卸载会自己删掉自己，回查确认它确实没了
      const left = await findAtomcodeBinary([binPath]);
      if (!left) return binResult;
      const leftMsg = `${tool.name} 卸载后二进制仍存在（${left}），请手动删除该文件，并从 PATH 中移除对应目录。`;
      sendLog('error', tool.id, leftMsg);
      return { success: false, message: leftMsg, docsUrl: SCRIPT_INSTALLED_TOOLS[tool.id].docsUrl, manualUninstall: true };
    }

    // 兜底脚本先通过 HTTPS 下载到临时文件，再执行；保留用户数据参数与原行为一致。
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
      // 官方脚本找不到二进制时依然打印 "uninstall complete." 并以 0 退出，
      // 直接当成功会误报「已卸载」。这里回查二进制是否真的消失了。
      const stillThere = await findAtomcodeBinary([binPath]);
      if (!stillThere) return scriptResult;
      const leftMsg = `${tool.name} 卸载脚本执行完毕，但二进制仍存在（${stillThere}），可能装在脚本未覆盖的位置。`
        + '请手动删除该文件，并从 PATH 中移除对应目录。';
      sendLog('error', tool.id, leftMsg);
      return { success: false, message: leftMsg, docsUrl: SCRIPT_INSTALLED_TOOLS[tool.id].docsUrl, manualUninstall: true };
    }

    // 告知用户官方脚本位置，避免在错误提示里再生成可直接复制执行的管道命令。
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
  const shellArgs = isWin ? ['/c', uninstallCmd] : ['-c', uninstallCmd];

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

// 获取工具配置（内置 + 白名单投影的自定义工具）
registerTrustedIpcHandler('get-tools', () => getAllTools());

// 批量检测所有工具版本（并行执行，流式推送）
// 每检测完一个工具立即通过 'tool-checked' 事件推送到渲染进程，
// 实现卡片逐张亮起的流式效果，而非全部完成后一次性刷新
registerTrustedIpcHandler('check-versions', async () => {
  const now = Date.now();
  if (now - lastCheckBatchAt < CHECK_BATCH_MIN_INTERVAL_MS) {
    throw new Error('版本检测请求过于频繁，请稍后再试');
  }
  lastCheckBatchAt = now;
  const runId = beginCheckRun();
  // 检测前刷新 PATH（命中 TTL 缓存时不会拉起子进程）
  await refreshProcessPath();
  const tools = getAllTools();
  const results = await Promise.all(tools.map(async (tool) => {
    if (!isCurrentCheckRun(runId, activeCheckRunId)) return null;
    const result = await runLimitedCheck(() => isCurrentCheckRun(runId, activeCheckRunId)
      ? checkToolSafely(tool)
      : null);
    if (!result) return null;
    // 无论单项检测是否异常都返回结果；只允许最新轮次推送流式状态。
    if (isCurrentCheckRun(runId, activeCheckRunId) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tool-checked', { runId, result });
    }
    return result;
  }));
  return { runId, results: results.filter(Boolean) };
});

// 检测单个工具版本；新请求会使未完成的旧批次失效。
registerTrustedIpcHandler('check-version', async (event, toolId) => {
  const runId = beginCheckRun();
  await refreshProcessPath();
  const tools = getAllTools();
  const tool = tools.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');
  const result = await runLimitedCheck(() => checkToolSafely(tool));
  return { ...result, runId };
});

// 更新单个工具
registerTrustedIpcHandler('update-tool', async (event, toolId) => {
  const result = await doInstallOrUpdate(toolId);
  // 安装/更新可能写入了新的 PATH 条目，强制刷新（绕过 TTL 缓存）
  await refreshProcessPath({ force: true });
  return result;
});

// 安装单个工具（逻辑与更新相同，npm install -g 同时适用于首次安装和升级）
registerTrustedIpcHandler('install-tool', async (event, toolId) => {
  const result = await doInstallOrUpdate(toolId);
  // 安装/更新可能写入了新的 PATH 条目，强制刷新（绕过 TTL 缓存）
  await refreshProcessPath({ force: true });
  return result;
});

// 卸载单个工具
registerTrustedIpcHandler('uninstall-tool', async (event, toolId) => {
  const result = await doUninstall(toolId);
  await refreshProcessPath({ force: true });
  return result;
});

// ===== 镜像源相关 IPC =====

// 获取可用镜像源列表
registerTrustedIpcHandler('get-registries', () => REGISTRIES);

// 获取当前使用的镜像源 URL
registerTrustedIpcHandler('get-current-registry', () => currentRegistry);

// 切换镜像源并持久化保存
registerTrustedIpcHandler('set-registry', (event, url) => {
  if (!isValidRegistryUrl(url)) {
    const message = '无效的镜像源 URL，请使用 HTTPS 地址';
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
registerTrustedIpcHandler('remove-custom-tool', (event, toolId) => {
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
registerTrustedIpcHandler('check-environment', async () => {
  const result = { node: null, npm: null, os: null, errors: [] };

  // GUI 启动时继承的 PATH 可能不含 Homebrew/nvm（macOS）或注册表最新 PATH（Windows），
  // 先刷新再检测，避免误报 Node.js / npm 未安装
  try { await refreshProcessPath(); } catch { /* 刷新失败不阻断检测 */ }

  // node / npm 并行检测：Windows 上 npm.cmd 冷启动较慢，串行会明显拖慢首屏
  const [nodeResult, npmResult] = await Promise.allSettled([
    execCommand('node', ['-v'], { shell: true, timeout: 10000 }),
    execCommand('npm', ['-v'], { shell: true, timeout: 10000 })
  ]);

  if (nodeResult.status === 'fulfilled') {
    result.node = nodeResult.value.trim();
  } else {
    result.errors.push('未检测到 Node.js，请先安装 Node.js (https://nodejs.org)');
  }

  if (npmResult.status === 'fulfilled') {
    result.npm = npmResult.value.trim();
  } else {
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
registerTrustedIpcHandler('export-log', async (event, logText) => {
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
registerTrustedIpcHandler('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

// 弹出保存对话框，将版本报告文本写入用户选择的文件
registerTrustedIpcHandler('export-report', async (event, { text, defaultName } = {}) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出版本报告',
    defaultPath: defaultName || `ai-tools-version-report-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [{ name: '文档 / 文本', extensions: ['md', 'json', 'txt'] }]
  });
  if (filePath) {
    fs.writeFileSync(filePath, text, 'utf-8');
    sendLog('success', 'system', `版本报告已导出到: ${filePath}`);
    return { success: true, filePath };
  }
  return { success: false };
});

// ===== 管理员权限提示 IPC =====

// 弹出对话框提示用户需要管理员权限（Windows 全局安装 npm 包时可能需要）
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

/**
 * 使用系统默认浏览器打开外部链接
 * - 仅允许 http/https 协议，防止恶意 URI 注入
 */
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

// 获取当前所有设置
registerTrustedIpcHandler('get-settings', () => {
  return loadSettings();
});

// 渲染进程允许修改的设置项及校验规则（registry 只能走 set-registry，那里有注入校验）
const SETTINGS_SCHEMA = {
  backgroundCheckHours: (v) => Number.isFinite(v) && v >= 0 && v <= 24 * 30,
  minimizeToTray: (v) => typeof v === 'boolean',
  openAtLogin: (v) => typeof v === 'boolean',
  startMinimized: (v) => typeof v === 'boolean',
};

// 保存设置，如果后台检测间隔有变化则重启定时器，开机自启变化则应用登录项
registerTrustedIpcHandler('save-settings', (event, input) => {
  // 只接受白名单内且类型合法的字段：例如 backgroundCheckHours 为 NaN 会让 setInterval 近乎无间隔地狂跑
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
// agyyolo 是一个 PowerShell 函数，调用 agy --dangerously-skip-permissions

// 通过成对标记精确识别可撤销内容；旧版写入内容仅在完全匹配时迁移/移除。
const AGYYOLO_BEGIN_MARKER = '# >>> AI Code Tool Updater: agyyolo >>>';
const AGYYOLO_END_MARKER = '# <<< AI Code Tool Updater: agyyolo <<<';
const AGYYOLO_FUNCTION_BODY = `${AGYYOLO_BEGIN_MARKER}\nfunction agyyolo {\n    agy --dangerously-skip-permissions\n}\n${AGYYOLO_END_MARKER}\n`;
const AGYYOLO_LEGACY_PATTERN = /^function agyyolo[ \t]*\{\r?\n[ \t]+agy --dangerously-skip-permissions\r?\n[ \t]*\}\r?\n?/gm;
const AGYYOLO_MANAGED_PATTERN = /^# >>> AI Code Tool Updater: agyyolo >>>\r?\nfunction agyyolo \{\r?\n    agy --dangerously-skip-permissions\r?\n\}\r?\n# <<< AI Code Tool Updater: agyyolo <<<(?:\r?\n|$)/m;

/**
 * PowerShell 查询脚本：输出 $PROFILE 与「文档」已知文件夹下的 Profile 路径
 * （已知文件夹可正确处理 OneDrive 重定向）
 */
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

/**
 * 获取所有可能的 PowerShell Profile 路径
 * - 通过 powershell.exe 读取 $PROFILE 和「文档」已知文件夹，兼容 OneDrive 重定向
 * - 同时覆盖 Windows PowerShell 5.1 与 PowerShell 7+
 */
async function getPowerShellProfiles() {
  const home = os.homedir();
  const fallback = [
    path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
  ];
  if (os.platform() !== 'win32') return fallback;
  try {
    const output = await execCommand(
      'powershell.exe',
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

function ensureProfile(profilePath) {
  const dir = path.dirname(profilePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(profilePath)) {
    try { fs.writeFileSync(profilePath, '', { encoding: 'utf-8', flag: 'wx' }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  return profilePath;
}

function readProfileContent(profilePath) {
  const bytes = fs.readFileSync(profilePath);
  try {
    // fatal 解码避免把 UTF-16/本地代码页内容替换成乱码后覆盖原文件；默认移除 UTF-8 BOM。
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Profile 不是有效 UTF-8 编码，原文件未修改；请先备份并转换编码。');
  }
}

function writeProfileAtomically(profilePath, content) {
  const mode = fs.existsSync(profilePath) ? fs.statSync(profilePath).mode : 0o600;
  const original = fs.existsSync(profilePath) ? fs.readFileSync(profilePath) : Buffer.alloc(0);
  const hasBom = original.length >= 3 && original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf;
  if (hasBom && !content.startsWith('\uFEFF')) content = '\uFEFF' + content;
  const tempDirectory = fs.mkdtempSync(path.join(path.dirname(profilePath), '.agyyolo-'));
  const tempPath = path.join(tempDirectory, 'profile.ps1');
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode, flag: 'wx' });
    fs.renameSync(tempPath, profilePath);
  } finally {
    try { fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* 忽略临时文件清理错误 */ }
  }
}

function getAgyyoloManagedState(content) {
  const beginCount = content.split(AGYYOLO_BEGIN_MARKER).length - 1;
  const endCount = content.split(AGYYOLO_END_MARKER).length - 1;
  if (!beginCount && !endCount) return 'none';
  return beginCount === 1 && endCount === 1 && AGYYOLO_MANAGED_PATTERN.test(content)
    ? 'valid' : 'conflict';
}

function installAgyyoloToProfile(profilePath) {
  if (!profilePath) return { ok: false, reason: 'Profile 路径为空' };
  ensureProfile(profilePath);
  let content = readProfileContent(profilePath);
  const managedState = getAgyyoloManagedState(content);
  if (managedState === 'valid') return { ok: true, reason: '已由本工具配置' };
  if (managedState === 'conflict') {
    return { ok: false, reason: '配置标记重复、损坏或内容已修改，未覆盖' };
  }

  // 只迁移完全匹配的旧版定义；多个旧定义合并为一个管理块。
  AGYYOLO_LEGACY_PATTERN.lastIndex = 0;
  const withoutLegacy = content.replace(AGYYOLO_LEGACY_PATTERN, '');
  AGYYOLO_LEGACY_PATTERN.lastIndex = 0;
  if (/function\s+agyyolo\b/i.test(withoutLegacy)) {
    return { ok: false, reason: '检测到同名自定义函数，未覆盖' };
  }
  const migrated = withoutLegacy !== content;
  content = withoutLegacy;
  const ending = content && !content.endsWith('\n') ? '\n\n' : '';
  writeProfileAtomically(profilePath, content + ending + AGYYOLO_FUNCTION_BODY);
  return { ok: true, reason: migrated ? '已将旧配置升级为可撤销标记' : '已写入' };
}

function removeAgyyoloFromProfile(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) return { ok: true, reason: '配置文件不存在' };
  let content = readProfileContent(profilePath);
  const before = content;
  const managedState = getAgyyoloManagedState(content);
  if (managedState === 'conflict') {
    return { ok: false, reason: '配置标记重复、损坏或内容已修改，未删除' };
  }
  if (managedState === 'valid') content = content.replace(AGYYOLO_MANAGED_PATTERN, '');
  AGYYOLO_LEGACY_PATTERN.lastIndex = 0;
  content = content.replace(AGYYOLO_LEGACY_PATTERN, '');
  AGYYOLO_LEGACY_PATTERN.lastIndex = 0;
  if (content === before) {
    if (/function\s+agyyolo\b/i.test(content)) {
      return { ok: false, reason: '存在未由本工具管理的同名函数，未删除' };
    }
    return { ok: true, reason: '没有需要撤销的配置' };
  }
  writeProfileAtomically(profilePath, content);
  return { ok: true, reason: '已撤销本工具管理的配置' };
}

function profileResultsSucceeded(results) {
  return results.length > 0 && results.every(item => item.ok);
}

function uniqueProfilePaths(profiles) {
  const seen = new Set();
  return profiles.filter(profilePath => {
    const key = String(profilePath).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  let agyFound = false;
  try {
    await execCommand('agy', ['--version'], { shell: true, timeout: 10000 });
    agyFound = true;
  } catch { agyFound = false; }
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

// ===== 一键打开 PowerShell IPC =====

/**
 * 根据操作系统打开默认终端
 * - Windows：打开 PowerShell
 * - macOS：打开 Terminal（通过 osascript）
 * - Linux：打开 x-terminal-emulator
 */
registerTrustedIpcHandler('open-powershell', async () => {
  const isWin = os.platform() === 'win32';

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
registerTrustedIpcHandler('ping-registry', async (event, url) => {
  if (!isValidRegistryUrl(url)) {
    return { success: false, message: '无效的镜像源 URL' };
  }
  const pingUrl = url.trim().replace(/\/$/, '') + '/';
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(pingUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'npm-registry-ping' }
    });
    const ms = Date.now() - start;
    return { success: true, ms, status: res.status };
  } catch (err) {
    const ms = Date.now() - start;
    return { success: false, ms, message: err.name === 'AbortError' ? '请求超时（>8s）' : err.message };
  } finally {
    // 请求失败时也要清理定时器
    clearTimeout(timeout);
  }
});
