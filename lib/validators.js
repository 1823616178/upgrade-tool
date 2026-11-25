'use strict';

/**
 * 校验 npm 镜像源 URL（仅允许 HTTPS）
 * 镜像源会被拼进子进程命令参数，必须拒绝凭据、查询串、锚点与 shell 特殊字符防止命令注入
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
 * 校验版本参数（会被拼进命令参数，禁止空格与 shell 特殊字符）
 * 允许 --version、-V、version 等常见形式
 */
function isValidVersionArg(arg) {
  if (!arg || typeof arg !== 'string') return false;
  return /^[a-zA-Z0-9._-]+$/.test(arg.replace(/^-+/, ''));
}

/**
 * 跨 IPC 与后台检查共享并发上限，避免一次批量操作同时启动所有本地命令和网络请求
 * @param {number} limit
 */
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

function isCurrentCheckRun(runId, activeRunId) {
  return runId === activeRunId;
}

module.exports = {
  isValidRegistryUrl,
  isValidNpmPackage,
  isPlainObject,
  hasOnlyFields,
  isValidToolName,
  isValidCliCommand,
  isValidVersionArg,
  createConcurrencyLimiter,
  isCurrentCheckRun
};
