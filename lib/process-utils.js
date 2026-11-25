'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * 在 PATH 中快速定位可执行文件（纯文件系统扫描，零子进程开销）
 * - Windows：遍历 Path × PATHEXT（.COM / .EXE / .BAT / .CMD 等）
 * - POSIX：遍历 PATH 并校验 X_OK 可执行位
 * @param {string} cmd - 命令名（如 "claude"）
 * @param {object} [options] - { platform, env }
 * @returns {{ found: boolean, fullPath: string|null, ext: string }}
 */
function findCommandInPath(cmd, options = {}) {
  if (!cmd || typeof cmd !== 'string') {
    return { found: false, fullPath: null, ext: '' };
  }
  const platform = options.platform || os.platform();
  const env = options.env || process.env;

  if (platform === 'win32') {
    const rawPath = env.Path || env.PATH || '';
    const dirs = rawPath
      .split(';')
      .map(dir => dir.replace(/^"+|"+$/g, '').trim())
      .filter(Boolean);
    const rawExt = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    const exts = [];
    const seenExt = new Set();
    for (const item of rawExt.split(';')) {
      const cleaned = item.trim();
      if (!cleaned) continue;
      const normalized = (cleaned.startsWith('.') ? cleaned : `.${cleaned}`).toLowerCase();
      if (!seenExt.has(normalized)) {
        seenExt.add(normalized);
        exts.push(normalized);
      }
    }

    const cmdExt = path.extname(cmd).toLowerCase();
    const candidates = cmdExt && seenExt.has(cmdExt)
      ? [cmd, ...exts.map(ext => `${cmd}${ext}`)]
      : exts.map(ext => `${cmd}${ext}`);

    for (const dir of dirs) {
      for (const name of candidates) {
        const fullPath = path.join(dir, name);
        try {
          if (fs.statSync(fullPath).isFile()) {
            return { found: true, fullPath, ext: path.extname(fullPath).toLowerCase() };
          }
        } catch { /* 目录无权限或文件不存在时跳过 */ }
      }
    }
    return { found: false, fullPath: null, ext: '' };
  }

  const dirs = (env.PATH || '')
    .split(':')
    .map(dir => dir.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    const fullPath = path.join(dir, cmd);
    try {
      if (fs.statSync(fullPath).isFile()) {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return { found: true, fullPath, ext: '' };
      }
    } catch { /* 非可执行或不存在时跳过 */ }
  }
  return { found: false, fullPath: null, ext: '' };
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
 * 安全启动独立后台进程（如打开终端窗口），等待 spawn 成功或捕获异步 error（如 ENOENT），
 * 防止命令不存在时触发主进程未捕获异常
 * @param {string} command
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function spawnDetachedSafely(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        ...options
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
      return;
    }

    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ success: false, error: err.message });
    });

    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      // 保留空 error 监听器，防止进程运行期异步错误冒泡为未捕获异常
      child.on('error', () => {});
      child.unref();
      resolve({ success: true });
    });
  });
}

/**
 * 规范化单个 PATH 目录条目，便于跨平台比对与去重
 * @param {string} dir
 * @param {string} [platform]
 * @returns {string}
 */
function normalizePathDir(dir, platform = os.platform()) {
  if (!dir || typeof dir !== 'string') return '';
  const cleaned = dir.replace(/^"+|"+$/g, '').trim();
  if (!cleaned) return '';
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  let normalized = pathMod.normalize(cleaned);
  const root = pathMod.parse(normalized).root;
  while (normalized.length > root.length && (normalized.endsWith('/') || normalized.endsWith('\\'))) {
    normalized = normalized.slice(0, -1);
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 解析目录真实路径（用于识别符号链接与 Windows Junction，如 NVM link 模式下的 .nodejs）
 * @param {string} dir
 * @param {string} [platform]
 * @returns {string|null}
 */
function resolveRealPathDir(dir, platform = os.platform()) {
  if (!dir || typeof dir !== 'string' || platform !== os.platform()) return null;
  const cleaned = dir.replace(/^"+|"+$/g, '').trim();
  if (!cleaned) return null;
  try {
    return normalizePathDir(fs.realpathSync(cleaned), platform);
  } catch {
    return null;
  }
}

/**
 * 从 `npm prefix -g` 的原始输出解析全局可执行文件目录
 * - Windows：npm 全局 .cmd/.ps1 位于 <prefix> 根目录
 * - POSIX：npm 全局命令位于 <prefix>/bin
 * @param {string} prefixOutput
 * @param {string} [platform]
 * @returns {string|null}
 */
function getNpmGlobalBinDir(prefixOutput, platform = os.platform()) {
  if (!prefixOutput || typeof prefixOutput !== 'string') return null;
  const lines = prefixOutput
    .split(/\r?\n/)
    .map(line => line.replace(/^"+|"+$/g, '').trim())
    .filter(line => line && !/^npm\s+(warn|notice|err!)/i.test(line));
  if (lines.length === 0) return null;

  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i];
    if (!pathMod.isAbsolute(candidate)) continue;
    const normalized = pathMod.normalize(candidate);
    return platform === 'win32' ? normalized : pathMod.join(normalized, 'bin');
  }
  return null;
}

/**
 * 判断目标目录是否已包含在指定 PATH 字符串中（支持规范化路径与符号链接/Junction 真实路径比对）
 * @param {string} targetDir
 * @param {string} rawPath
 * @param {object} [options] - { platform, resolveRealPath }
 * @returns {boolean}
 */
function isDirInPath(targetDir, rawPath, options = {}) {
  const platform = options.platform || os.platform();
  const resolveReal = options.resolveRealPath !== undefined
    ? !!options.resolveRealPath
    : platform === os.platform();
  const targetNorm = normalizePathDir(targetDir, platform);
  if (!targetNorm || !rawPath || typeof rawPath !== 'string') return false;

  const targetReal = resolveReal ? resolveRealPathDir(targetDir, platform) : null;
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const entry of rawPath.split(delimiter)) {
    const entryNorm = normalizePathDir(entry, platform);
    if (!entryNorm) continue;
    if (entryNorm === targetNorm) return true;
    if (resolveReal) {
      const entryReal = resolveRealPathDir(entry, platform);
      if (entryReal && (entryReal === targetNorm || (targetReal && entryReal === targetReal))) {
        return true;
      }
      if (targetReal && entryNorm === targetReal) return true;
    }
  }
  return false;
}

/**
 * 若目录尚未出现在 PATH 中则追加到末尾（不覆盖用户系统 PATH 的优先级）
 * @param {string} rawPath
 * @param {string} dir
 * @param {object} [options] - { platform, resolveRealPath }
 * @returns {string}
 */
function appendDirToPath(rawPath, dir, options = {}) {
  const platform = options.platform || os.platform();
  const cleaned = typeof dir === 'string' ? dir.replace(/^"+|"+$/g, '').trim() : '';
  if (!cleaned) return rawPath || '';
  if (isDirInPath(cleaned, rawPath, options)) return rawPath || '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const existing = typeof rawPath === 'string' ? rawPath.trim() : '';
  return existing ? `${existing}${delimiter}${cleaned}` : cleaned;
}

module.exports = {
  findCommandInPath,
  normalizePathDir,
  getNpmGlobalBinDir,
  isDirInPath,
  appendDirToPath,
  killProcessTree,
  spawnDetachedSafely
};
