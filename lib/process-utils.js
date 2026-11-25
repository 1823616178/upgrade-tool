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

module.exports = {
  findCommandInPath,
  killProcessTree,
  spawnDetachedSafely
};
