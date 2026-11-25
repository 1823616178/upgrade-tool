'use strict';

/**
 * 从版本输出中提取纯语义化版本号
 * 部分 CLI 会在版本号前后附带工具名等文字，如 "2.1.201 (Claude Code)" 或 "codex-cli 0.142.5"
 * @param {string} text - 原始版本输出文本
 * @returns {string|null} 提取到的版本号（如 "1.2.3"），未匹配则返回 null
 */
function extractVersionNumber(text) {
  if (!text) return null;
  const match = String(text).match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)/i);
  return match ? match[1] : null;
}

/**
 * 从命令标准输出/标准错误的多行文本中提取版本所在行
 * 优先返回首个包含有效语义化版本号的非空行（避免被首行 Warning / AutoRun 横幅干扰），
 * 若所有行都不含标准 semver，则回退到首个非空行
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {string}
 */
function extractVersionLine(stdout, stderr = '') {
  const combined = `${stdout || ''}\n${stderr || ''}`;
  const lines = combined
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const semverLine = lines.find(line => extractVersionNumber(line) !== null);
  return semverLine || lines[0];
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

module.exports = {
  extractVersionNumber,
  extractVersionLine,
  parseSemver,
  comparePrerelease,
  compareSemver,
  isRemoteNewer
};
