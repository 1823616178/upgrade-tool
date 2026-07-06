const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

// 强制使用 npm 官方源，避免用户本地镜像源导致包查询失败
const NPM_REGISTRY = 'https://registry.npmjs.org/';

// 工具配置：显示名称、可执行命令、npm 包名、版本参数
const TOOLS = [
  {
    id: 'kimi',
    name: 'Kimi Code',
    cmd: 'kimi',
    pkg: '@moonshot-ai/kimi-code',
    versionArg: '--version',
    updateCmd: `npm install -g @moonshot-ai/kimi-code@latest --registry=${NPM_REGISTRY}`
  },
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude',
    pkg: '@anthropic-ai/claude-code',
    versionArg: '--version',
    updateCmd: `npm install -g @anthropic-ai/claude-code@latest --registry=${NPM_REGISTRY}`
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    cmd: 'codex',
    pkg: '@openai/codex',
    versionArg: '--version',
    updateCmd: `npm install -g @openai/codex@latest --registry=${NPM_REGISTRY}`
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    cmd: 'opencode',
    pkg: 'opencode-ai',
    versionArg: '--version',
    updateCmd: `npm install -g opencode-ai@latest --registry=${NPM_REGISTRY}`
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    cmd: 'codebuddy',
    pkg: '@tencent-ai/codebuddy-code',
    versionArg: '--version',
    updateCmd: `npm install -g @tencent-ai/codebuddy-code@latest --registry=${NPM_REGISTRY}`
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    cmd: 'qwen',
    pkg: '@qwen-code/qwen-code',
    versionArg: '--version',
    updateCmd: `npm install -g @qwen-code/qwen-code@latest --registry=${NPM_REGISTRY}`
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    cmd: 'gemini',
    pkg: '@google/gemini-cli',
    versionArg: '--version',
    updateCmd: `npm install -g @google/gemini-cli@latest --registry=${NPM_REGISTRY}`
  }
];

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
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
  try {
    const output = await execCommand(tool.cmd, [tool.versionArg], { shell: true });
    const version = output.split(/\r?\n/)[0].trim();
    return { installed: true, version, normalizedVersion: extractVersionNumber(version) };
  } catch (err) {
    return { installed: false, version: null, normalizedVersion: null, notFound: isCommandNotFound(err), error: err.message };
  }
}

// 检测单个 npm 包的最新版本
async function checkLatestVersion(tool) {
  try {
    const output = await execCommand('npm', ['view', tool.pkg, 'version', `--registry=${NPM_REGISTRY}`], { shell: true });
    return { latest: output.trim() };
  } catch (err) {
    return { latest: null, error: err.message };
  }
}

// IPC: 获取工具配置
ipcMain.handle('get-tools', () => TOOLS);

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
    needsUpdate: !!(local.installed && local.normalizedVersion && remote.latest && local.normalizedVersion !== remote.latest)
  };
  sendLog('success', tool.id, `${tool.name}: ${local.installed ? local.version : '未安装'} -> ${remote.latest || '检测失败'}`);
  return result;
}

// IPC: 批量检测版本（所有工具并行）
ipcMain.handle('check-versions', async () => {
  return Promise.all(TOOLS.map(checkTool));
});

// IPC: 检测单个工具版本
ipcMain.handle('check-version', async (event, toolId) => {
  const tool = TOOLS.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');
  return checkTool(tool);
});

// 执行单个工具更新（返回 Promise）
async function doUpdateTool(toolId) {
  const tool = TOOLS.find(t => t.id === toolId);
  if (!tool) throw new Error('未知工具');

  sendLog('start', tool.id, `开始更新 ${tool.name} ...`);

  const isWin = os.platform() === 'win32';
  let shellCmd;
  let shellArgs;

  if (isWin) {
    shellCmd = 'cmd.exe';
    shellArgs = ['/c', tool.updateCmd];
  } else {
    shellCmd = 'sh';
    shellArgs = ['-c', tool.updateCmd];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(shellCmd, shellArgs, {
      env: { ...process.env, NPM_CONFIG_REGISTRY: NPM_REGISTRY }
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
      sendLog('error', tool.id, `更新失败: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        sendLog('success', tool.id, `${tool.name} 更新完成`);
        resolve({ success: true });
      } else {
        const msg = `更新退出码: ${code}（Windows 上可能需要以管理员身份运行）`;
        sendLog('error', tool.id, msg);
        resolve({ success: false, code, message: msg });
      }
    });
  });
}

// IPC: 更新单个工具
ipcMain.handle('update-tool', async (event, toolId) => {
  return doUpdateTool(toolId);
});

// IPC: 更新全部可更新工具
ipcMain.handle('update-all', async (event, toolIds) => {
  const results = [];
  for (const toolId of toolIds) {
    try {
      const result = await doUpdateTool(toolId);
      results.push({ toolId, ...result });
    } catch (err) {
      results.push({ toolId, success: false, message: err.message });
    }
  }
  return results;
});

// IPC: 打开管理员权限提示
ipcMain.handle('show-admin-tip', async () => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '需要管理员权限',
    message: '在 Windows 上全局安装 npm 包可能需要管理员权限。\n\n如果更新失败，请右键点击 updateTool.exe 选择「以管理员身份运行」。',
    buttons: ['知道了']
  });
});

// IPC: 打开外部链接（仅允许 http/https，避免任意协议被唤起）
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
