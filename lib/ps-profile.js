'use strict';

const fs = require('fs');
const path = require('path');

// 通过成对标记精确识别可撤销内容；旧版写入内容仅在完全匹配时迁移/移除。
const AGYYOLO_BEGIN_MARKER = '# >>> AI Code Tool Updater: agyyolo >>>';
const AGYYOLO_END_MARKER = '# <<< AI Code Tool Updater: agyyolo <<<';
const AGYYOLO_FUNCTION_BODY = `${AGYYOLO_BEGIN_MARKER}\nfunction agyyolo {\n    agy --dangerously-skip-permissions\n}\n${AGYYOLO_END_MARKER}\n`;
const AGYYOLO_LEGACY_PATTERN = /^function agyyolo[ \t]*\{\r?\n[ \t]+agy --dangerously-skip-permissions\r?\n[ \t]*\}\r?\n?/gm;
const AGYYOLO_MANAGED_PATTERN = /^# >>> AI Code Tool Updater: agyyolo >>>\r?\nfunction agyyolo \{\r?\n    agy --dangerously-skip-permissions\r?\n\}\r?\n# <<< AI Code Tool Updater: agyyolo <<<(?:\r?\n|$)/m;

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

module.exports = {
  AGYYOLO_BEGIN_MARKER,
  AGYYOLO_END_MARKER,
  AGYYOLO_FUNCTION_BODY,
  AGYYOLO_LEGACY_PATTERN,
  AGYYOLO_MANAGED_PATTERN,
  ensureProfile,
  readProfileContent,
  writeProfileAtomically,
  getAgyyoloManagedState,
  installAgyyoloToProfile,
  removeAgyyoloFromProfile,
  profileResultsSucceeded,
  uniqueProfilePaths
};
