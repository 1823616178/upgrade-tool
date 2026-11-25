'use strict';

const os = require('os');
const { extractVersionNumber, parseSemver } = require('./semver');

// 支持 npm 官方源和淘宝镜像源，用户可在设置中切换
const REGISTRIES = [
  { id: 'npm', name: 'npm 官方源', url: 'https://registry.npmjs.org/' },
  { id: 'npmmirror', name: '淘宝镜像源 (npmmirror)', url: 'https://registry.npmmirror.com/' },
];

// 预定义的 AI 编码工具列表，包含 CLI 命令名和对应的 npm 包名或官方 HTTPS 安装脚本
// npm 更新只在解析出精确版本后即时构造，避免使用可变的 latest 标签
// installScript: { winUrl, unixUrl, unixShell } — 只存 HTTPS 脚本地址，不保存管道执行命令
const BUILTIN_TOOLS = [
  { id: 'kimi',        name: 'Kimi Code',            cmd: 'kimi',         pkg: '@moonshot-ai/kimi-code',     versionArg: '--version', icon: '🌙' },
  { id: 'claude',      name: 'Claude Code',          cmd: 'claude',       pkg: '@anthropic-ai/claude-code',  versionArg: '--version', icon: '✳️' },
  { id: 'cline',       name: 'Cline',                cmd: 'cline',        pkg: 'cline',                     versionArg: '--version', icon: '🧩' },
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
  { id: 'codex',       name: 'OpenAI Codex',         cmd: 'codex',        pkg: '@openai/codex',              versionArg: '--version', icon: '🔷' },
  { id: 'opencode',    name: 'OpenCode',             cmd: 'opencode',     pkg: 'opencode-ai',                versionArg: '--version', icon: '🖥️' },
  { id: 'codebuddy',   name: 'CodeBuddy',            cmd: 'codebuddy',    pkg: '@tencent-ai/codebuddy-code', versionArg: '--version', icon: '🤖' },
  { id: 'qwen',        name: 'Qwen Code',            cmd: 'qwen',         pkg: '@qwen-code/qwen-code',       versionArg: '--version', icon: '💡' },
  { id: 'commandcode', name: 'Command Code',         cmd: 'command-code', pkg: 'command-code',               versionArg: '--version', icon: '⚡' },
  // 小米 MiMo Code（https://github.com/XiaomiMiMo/MiMo-Code），npm 包 @mimo-ai/cli 提供 mimo 命令
  { id: 'mimo',        name: 'MiMo Code',            cmd: 'mimo',         pkg: '@mimo-ai/cli',               versionArg: '--version', icon: '🍊' },
  // CNB CLI（https://docs.cnb.cool/zh/develops/cnb-cli.html），官方 npm 包 @cnbcool/cnb-cli 提供 cnb 命令
  // 版本参数只有 --version（commander 自定义），输出为纯 semver，如 1.19.2
  { id: 'cnb',         name: 'CNB CLI',              cmd: 'cnb',          pkg: '@cnbcool/cnb-cli',           versionArg: '--version', icon: '☁️' },
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
    // 注意：不声明 npm pkg —— 原生安装包与旧 npm 包是两条独立版本线，不能混用
    id: 'qoder', name: 'Qoder CLI', cmd: 'qodercli', altCmds: ['qoder'], versionArg: '--version', icon: '🚀',
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
    // checkEnv：版本检测时禁用 launcher 后台自更新，避免检测产生副作用
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

// 通过官方安装脚本安装的工具映射（直接从 BUILTIN_TOOLS 提取）
const SCRIPT_INSTALLED_TOOLS = Object.fromEntries(
  BUILTIN_TOOLS
    .filter(t => t.installScript)
    .map(t => [t.id, { docsUrl: t.docsUrl || '' }])
);

/**
 * 根据操作系统和架构返回 antigravity 的平台标识
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string} 如 "windows_amd64"、"darwin_arm64"
 */
function getAntigravityPlatform(platform = os.platform(), arch = os.arch()) {
  const osStr = platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'darwin'
      : 'linux';
  const archStr = arch === 'arm64' ? 'arm64' : 'amd64';
  return `${osStr}_${archStr}`;
}

// ===== 表驱动的脚本安装类工具远端版本解析器 =====
const REMOTE_VERSION_RESOLVERS = {
  async antigravity(tool, { fetchWithTimeout, platform, arch }) {
    try {
      const target = getAntigravityPlatform(platform, arch);
      const res = await fetchWithTimeout(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${target}.json`);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const manifest = await res.json();
      return { latest: manifest.version };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  },

  async cursor(tool, { fetchWithTimeout, platform }) {
    try {
      const url = platform === 'win32' ? tool.installScript.winUrl : tool.installScript.unixUrl;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const script = await res.text();
      const match = script.match(/https:\/\/downloads\.cursor\.com\/lab\/([^/'"\s]+)\//);
      if (!match || !parseSemver(match[1])) throw new Error('官方安装脚本中无有效版本号');
      return { latest: match[1] };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  },

  async atomcode(tool, { fetchWithTimeout }) {
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
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const version = pick(await res.json());
        if (!extractVersionNumber(version)) throw new Error('响应中无有效版本号');
        return { latest: version };
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { latest: null, error: errors.join('; ') };
  },

  async qoder_cn(tool, { fetchWithTimeout }) {
    try {
      const res = await fetchWithTimeout('https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json');
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const manifest = await res.json();
      return { latest: manifest.latest };
    } catch (err) {
      return { latest: null, error: err.message };
    }
  },

  async qoder(tool, { fetchWithTimeout }) {
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
  },

  async grok(tool, { fetchWithTimeout, env }) {
    const channel = (env && env.GROK_CHANNEL) || 'stable';
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
        if (latest && /^\d+\.\d+\.\d+(-\S+)?$/.test(latest)) {
          return { latest };
        }
        throw new Error(`无效的版本号响应: ${latest.slice(0, 40)}`);
      } catch (err) {
        lastErr = err;
      }
    }
    return { latest: null, error: (lastErr && lastErr.message) || 'grok channel 版本获取失败' };
  },

  async muse(tool, { fetchWithTimeout, env }) {
    const channel = (env && env.MUSE_CHANNEL) || 'muse-stable';
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
};

/**
 * 若工具配有专用远端版本解析器则执行并返回结果，否则返回 null（交由通用 npm registry 解析）
 * @param {object} tool
 * @param {object} deps - { fetchWithTimeout, platform, arch, env }
 * @returns {Promise<{ latest: string|null, error?: string } | null>}
 */
async function resolveSpecialRemoteVersion(tool, deps) {
  const resolver = tool && REMOTE_VERSION_RESOLVERS[tool.id];
  if (!resolver) return null;
  return resolver(tool, {
    platform: os.platform(),
    arch: os.arch(),
    env: process.env,
    ...deps
  });
}

module.exports = {
  REGISTRIES,
  BUILTIN_TOOLS,
  SCRIPT_INSTALLED_TOOLS,
  getAntigravityPlatform,
  REMOTE_VERSION_RESOLVERS,
  resolveSpecialRemoteVersion
};
