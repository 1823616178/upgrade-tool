// Lightweight security/reliability regression checks without Electron or external test frameworks.
// Run via `npm test`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const {
  isValidRegistryUrl,
  isValidNpmPackage,
  isValidCliCommand,
  isValidVersionArg,
  isPlainObject,
  hasOnlyFields,
  isValidToolName,
  createConcurrencyLimiter,
  isCurrentCheckRun
} = require('../lib/validators');
const {
  installAgyyoloToProfile,
  removeAgyyoloFromProfile,
  profileResultsSucceeded
} = require('../lib/ps-profile');
const {
  findCommandInPath,
  normalizePathDir,
  getNpmGlobalBinDir,
  isDirInPath,
  appendDirToPath,
  killProcessTree,
  spawnDetachedSafely
} = require('../lib/process-utils');
const {
  BUILTIN_TOOLS,
  resolveSpecialRemoteVersion
} = require('../lib/tools-catalog');

const rootDir = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(rootDir, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(rootDir, 'script.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const standaloneAgyyoloSource = fs.readFileSync(path.join(__dirname, 'setup-agyyolo.ps1'), 'utf8');
const standaloneCmdcyoloSource = fs.readFileSync(path.join(__dirname, 'setup-cmdcyolo.ps1'), 'utf8');

function extractMainFunction(name) {
  const pattern = new RegExp(`(?:async\\s+)?function ${name}\\([\\s\\S]*?^}`, 'm');
  const match = mainSource.match(pattern);
  assert(match, `missing function ${name} in main.js`);
  return match[0];
}

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

check('registry requires HTTPS and rejects credentials/query/fragment', () => {
  assert.strictEqual(isValidRegistryUrl('https://registry.npmjs.org/'), true);
  assert.strictEqual(isValidRegistryUrl('http://registry.npmjs.org/'), false);
  assert.strictEqual(isValidRegistryUrl('https://user:pass@example.com/'), false);
  assert.strictEqual(isValidRegistryUrl('https://example.com/?token=x'), false);
  assert.strictEqual(isValidRegistryUrl('https://example.com/#fragment'), false);
});

check('custom tool primitives reject invalid or oversized values', () => {
  assert.strictEqual(isPlainObject({ name: 'tool' }), true);
  assert.strictEqual(isPlainObject([]), false);
  assert.strictEqual(hasOnlyFields({ name: 'tool' }, ['name']), true);
  assert.strictEqual(hasOnlyFields({ name: 'tool', installScript: 'evil' }, ['name']), false);
  assert.strictEqual(isValidToolName('My CLI'), true);
  assert.strictEqual(isValidToolName('x'.repeat(81)), false);
  assert.strictEqual(isValidNpmPackage('@scope/pkg'), true);
  assert.strictEqual(isValidNpmPackage('bad;command'), false);
  assert.strictEqual(isValidCliCommand('my-cli'), true);
  assert.strictEqual(isValidVersionArg('--version'), true);
});

check('check generation accepts only the current run', () => {
  assert.strictEqual(isCurrentCheckRun(12, 12), true);
  assert.strictEqual(isCurrentCheckRun(11, 12), false);
});

checkAsync('Cursor uses official install sources and parses the published version', async () => {
  const cursor = BUILTIN_TOOLS.find(tool => tool.id === 'cursor');
  assert(cursor, 'missing Cursor CLI');
  assert.strictEqual(cursor.cmd, 'cursor-agent');
  assert.strictEqual(cursor.altCmds, undefined);
  assert.strictEqual(cursor.installScript.winUrl, 'https://cursor.com/install?win32=true');
  assert.strictEqual(cursor.installScript.unixUrl, 'https://cursor.com/install');

  let script = "$downloadUrl = 'https://downloads.cursor.com/lab/2026.11.05-86047df/'";
  const fetchMock = async url => {
    assert.strictEqual(url, cursor.installScript.winUrl);
    return { ok: true, text: async () => script };
  };
  assert.deepStrictEqual(
    await resolveSpecialRemoteVersion(cursor, { fetchWithTimeout: fetchMock, platform: 'win32' }),
    { latest: '2026.11.05-86047df' }
  );

  script = 'installer response without a version';
  const invalid = await resolveSpecialRemoteVersion(cursor, { fetchWithTimeout: fetchMock, platform: 'win32' });
  assert.strictEqual(invalid.latest, null);
  assert.match(invalid.error, /无有效版本号/);
});

check('CNB CLI uses the official npm package and version flag', () => {
  const cnb = BUILTIN_TOOLS.find(tool => tool.id === 'cnb');
  assert(cnb, 'missing CNB CLI');
  assert.strictEqual(cnb.name, 'CNB CLI');
  assert.strictEqual(cnb.cmd, 'cnb');
  assert.strictEqual(cnb.pkg, '@cnbcool/cnb-cli');
  assert.strictEqual(cnb.versionArg, '--version');
  assert.strictEqual(cnb.installScript, undefined);
});

check('Qoder native script tool does not carry dead npm pkg metadata', () => {
  const qoder = BUILTIN_TOOLS.find(tool => tool.id === 'qoder');
  assert(qoder, 'missing Qoder CLI');
  assert.strictEqual(qoder.pkg, undefined);
  assert(qoder.installScript, 'Qoder should use official installScript');
});

check('per-profile result aggregation rejects empty and partial success', () => {
  assert.strictEqual(profileResultsSucceeded([]), false);
  assert.strictEqual(profileResultsSucceeded([{ ok: true }, { ok: false }]), false);
  assert.strictEqual(profileResultsSucceeded([{ ok: true }, { ok: true }]), true);
});

check('Electron/IPC, packaging, and supply-chain protections are wired into runtime paths', () => {
  assert(pkgJson.build && Array.isArray(pkgJson.build.files) && pkgJson.build.files.includes('lib/**/*.js'),
    'package.json build.files must bundle lib/**/*.js');
  assert.strictEqual(pkgJson.scripts.postinstall, undefined, 'redundant postinstall should be removed');
  assert.match(mainSource, /sandbox:\s*true/);
  assert.match(mainSource, /function isTrustedIpcEvent\(/);
  assert.match(mainSource, /frame !== contents\.mainFrame/);
  assert.match(mainSource, /function registerTrustedIpcHandler\(/);
  assert.strictEqual((mainSource.match(/ipcMain\.handle\(/g) || []).length, 1, 'only the guarded registration wrapper may call ipcMain.handle');
  assert.ok((mainSource.match(/registerTrustedIpcHandler\('/g) || []).length >= 20, 'IPC channels use the guarded wrapper');
  assert.doesNotMatch(mainSource, /@latest/);
  assert.match(mainSource, /npm install -g \$\{tool\.pkg\}@\$\{exactVersion\}/);
  assert.match(mainSource, /MAX_VENDOR_SCRIPT_BYTES/);
  assert.doesNotMatch(mainSource, /(?:curl|irm|Invoke-RestMethod)[^\n]{0,300}\|\s*(?:bash|sh|iex)/i);
  assert.match(mainSource, /hasOnlyFields\(t, \['id', 'name', 'cmd', 'pkg', 'versionArg'\]\)/);
  assert.match(mainSource, /hasOnlyFields\(toolConfig, \['name', 'cmd', 'pkg', 'versionArg'\]\)/);
  assert.doesNotMatch(mainSource.slice(mainSource.indexOf('function loadCustomTools'), mainSource.indexOf('function saveCustomTools')), /\.\.\.t/);
  assert.match(preloadSource, /onCheckRunStarted/);
  assert.match(preloadSource, /onBackgroundResults/);
  assert.match(rendererSource, /payload\.runId === latestCheckRunId/);
  assert.match(rendererSource, /response\.runId !== latestCheckRunId/);
  assert.match(mainSource, /CHECK_BATCH_MIN_INTERVAL_MS = 1000/);
  assert.match(mainSource, /createConcurrencyLimiter\(4\)/);
  // cmd.exe AutoRun must be disabled with /d
  assert.match(mainSource, /\['\/d',\s*'\/c'/);
  // Custom registry UI hint must require https://
  assert.doesNotMatch(htmlSource, /仅支持 http:\/\/ 或 https:\/\//);
  assert.match(htmlSource, /仅支持 https:\/\//);
  // Single-tool check-version must not call beginCheckRun() and abort batch checks
  const singleCheckBlock = mainSource.slice(
    mainSource.indexOf("registerTrustedIpcHandler('check-version'"),
    mainSource.indexOf("registerTrustedIpcHandler('update-tool'")
  );
  assert.doesNotMatch(singleCheckBlock, /beginCheckRun\(/);
});

check('IPC trusts only the current local main frame', () => {
  const frame = { url: pathToFileURL(path.join(rootDir, 'index.html')).href };
  const contents = { mainFrame: frame };
  let destroyed = false;
  const window = { webContents: contents, isDestroyed: () => destroyed };
  const isTrusted = new Function('mainWindow', 'path', 'pathToFileURL', '__dirname',
    `${extractMainFunction('isTrustedIpcEvent')}\nreturn isTrustedIpcEvent;`
  )(window, path, pathToFileURL, rootDir);
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: frame }), true);
  assert.strictEqual(isTrusted({ sender: {}, senderFrame: frame }), false);
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: { url: frame.url } }), false);
  assert.strictEqual(isTrusted({ sender: contents }), false);
  frame.url = 'https://example.com/';
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: frame }), false);
  destroyed = true;
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: frame }), false);
});

check('findCommandInPath locates executables in memory without spawning child processes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-path-scan-'));
  try {
    const winCmd = path.join(temp, 'demo-cli.cmd');
    fs.writeFileSync(winCmd, '@echo off\r\necho 1.0.0\r\n', 'utf8');
    const foundWin = findCommandInPath('demo-cli', {
      platform: 'win32',
      env: { Path: `"${temp}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    });
    assert.strictEqual(foundWin.found, true);
    assert.strictEqual(foundWin.ext, '.cmd');
    assert.strictEqual(foundWin.fullPath, winCmd);

    const missingWin = findCommandInPath('nonexistent-cli-xyz', {
      platform: 'win32',
      env: { Path: temp, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    });
    assert.strictEqual(missingWin.found, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

check('npm global bin helpers handle Windows/POSIX paths, spaces, noise lines, and junction/symlink realpaths', () => {
  assert.strictEqual(
    normalizePathDir('"C:\\Users\\demo\\AppData\\Local\\Author Software\\nvm\\\\.nodejs\\"', 'win32'),
    'c:\\users\\demo\\appdata\\local\\author software\\nvm\\.nodejs'
  );
  assert.strictEqual(normalizePathDir('C:\\', 'win32'), 'c:\\');
  assert.strictEqual(normalizePathDir('/usr/local/bin/', 'linux'), '/usr/local/bin');
  assert.strictEqual(normalizePathDir('/', 'linux'), '/');

  assert.strictEqual(
    getNpmGlobalBinDir('npm warn config something\nC:\\Users\\demo\\AppData\\Local\\Author Software\\nvm\\installs\\v26.13.1\n', 'win32'),
    'C:\\Users\\demo\\AppData\\Local\\Author Software\\nvm\\installs\\v26.13.1'
  );
  assert.strictEqual(getNpmGlobalBinDir('/Users/demo/.npm-global\n', 'darwin'), '/Users/demo/.npm-global/bin');
  assert.strictEqual(getNpmGlobalBinDir('relative/path', 'linux'), null);

  const shimPath = 'C:\\Windows\\System32;C:\\Users\\demo\\AppData\\Local\\Author Software\\nvm\\\\.nodejs';
  const nvmInstallDir = 'C:\\Users\\demo\\AppData\\Local\\Author Software\\nvm\\installs\\v26.13.1';
  assert.strictEqual(isDirInPath(nvmInstallDir, shimPath, { platform: 'win32', resolveRealPath: false }), false);
  assert.strictEqual(
    isDirInPath('C:\\Users\\demo\\AppData\\Local\\Author Software\\nvm\\.nodejs', shimPath, { platform: 'win32', resolveRealPath: false }),
    true
  );

  const appended = appendDirToPath(shimPath, nvmInstallDir, { platform: 'win32', resolveRealPath: false });
  assert.strictEqual(appended, `${shimPath};${nvmInstallDir}`);
  assert.strictEqual(appendDirToPath(appended, nvmInstallDir, { platform: 'win32', resolveRealPath: false }), appended);

  // 真实文件系统符号链接 / Windows Junction 匹配验证（避免 NVM link 模式误报）
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-npm-bin-link-'));
  try {
    const realDir = path.join(temp, 'installs', 'v26');
    const linkDir = path.join(temp, '.nodejs');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(isDirInPath(realDir, linkDir), true);
    assert.strictEqual(isDirInPath(linkDir, realDir), true);
    assert.strictEqual(appendDirToPath(linkDir, realDir), linkDir);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  // 主进程已将 npm 全局目录探测接入 PATH 刷新与环境告警
  assert.match(mainSource, /async function syncNpmGlobalBinToPath\(/);
  assert.match(mainSource, /await syncNpmGlobalBinToPath\(/);
  assert.match(mainSource, /npmGlobalBinInPath/);
});

checkAsync('spawnDetachedSafely resolves error cleanly instead of crashing on ENOENT', async () => {
  const res = await spawnDetachedSafely('definitely-missing-binary-ai-updater-test-9999', []);
  assert.strictEqual(res.success, false);
  assert(res.error, 'expected error message on missing binary');
});

checkAsync('one failed tool check does not reject its batch and assigns monotonic seq', async () => {
  let latestToolSeq = 0;
  const safeCheck = new Function('checkTool', 'bumpSeq',
    `let latestToolSeq = 0;\n${extractMainFunction('checkToolSafely')}\nreturn checkToolSafely;`
  )(async tool => {
    if (tool.id === 'bad') throw new Error('isolated failure');
    return { ...tool, installed: true };
  });
  const results = await Promise.all([{ id: 'bad' }, { id: 'good' }].map(tool => safeCheck(tool)));
  assert.strictEqual(results[0].error, 'isolated failure');
  assert.strictEqual(results[0].needsUpdate, false);
  assert.strictEqual(results[1].installed, true);
  assert(results[0].seq >= 1 && results[1].seq >= 1 && results[0].seq !== results[1].seq);
  void latestToolSeq;
});

check('POSIX children are detached and process groups are signalled', () => {
  const procUtilsSource = fs.readFileSync(path.join(rootDir, 'lib', 'process-utils.js'), 'utf8');
  assert.match(mainSource, /detached:\s*!isWin/);
  assert.match(procUtilsSource, /process\.kill\(-child\.pid, 'SIGTERM'\)/);
  assert.match(procUtilsSource, /process\.kill\(-child\.pid, 'SIGKILL'\)/);
});

check('agyyolo and cmdcyolo confirmation and reversible management are wired in', () => {
  assert.match(mainSource, /我了解风险，继续/);
  assert.match(mainSource, /remove-agyyolo/);
  assert.match(mainSource, /profileResultsSucceeded\(results\)/);
  assert.match(rendererSource, /btn-remove-agyyolo/);
  for (const psSource of [standaloneAgyyoloSource, standaloneCmdcyoloSource]) {
    assert.match(psSource, /Read-Host '确认写入请输入 YES/);
    assert.match(psSource, /\[switch\]\$Remove/);
    assert.match(psSource, /Write-ProfileAtomically/);
    assert.doesNotMatch(psSource, /New-Item[^\n]*-LiteralPath/);
    assert.match(psSource, /Get-ManagedState/);
  }
});

check('agyyolo install/remove preserves user content and is idempotent', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agyyolo-'));
  try {
    const profile = path.join(temp, 'Microsoft.PowerShell_profile.ps1');
    fs.writeFileSync(profile, '# user content\n', 'utf8');
    const first = installAgyyoloToProfile(profile);
    assert.strictEqual(first.ok, true);
    const installed = fs.readFileSync(profile, 'utf8');
    assert.match(installed, /# user content/);
    assert.match(installed, /# >>> AI Code Tool Updater: agyyolo >>>/);
    assert.match(installed, /agy --dangerously-skip-permissions/);
    assert.strictEqual(installAgyyoloToProfile(profile).ok, true);
    assert.strictEqual(fs.readFileSync(profile, 'utf8'), installed);
    assert.strictEqual(removeAgyyoloFromProfile(profile).ok, true);
    const removed = fs.readFileSync(profile, 'utf8');
    assert.match(removed, /# user content/);
    assert.doesNotMatch(removed, /function agyyolo/);
    assert.doesNotMatch(removed, /AI Code Tool Updater: agyyolo/);

    const customProfile = path.join(temp, 'custom.ps1');
    fs.writeFileSync(customProfile, 'function agyyolo { Write-Host custom }\n', 'utf8');
    const before = fs.readFileSync(customProfile, 'utf8');
    assert.strictEqual(installAgyyoloToProfile(customProfile).ok, false);
    assert.strictEqual(removeAgyyoloFromProfile(customProfile).ok, false);
    assert.strictEqual(fs.readFileSync(customProfile, 'utf8'), before);

    const brokenProfile = path.join(temp, 'broken.ps1');
    const broken = '# >>> AI Code Tool Updater: agyyolo >>>\n# incomplete\n';
    fs.writeFileSync(brokenProfile, broken, 'utf8');
    assert.strictEqual(installAgyyoloToProfile(brokenProfile).ok, false);
    assert.strictEqual(removeAgyyoloFromProfile(brokenProfile).ok, false);
    assert.strictEqual(fs.readFileSync(brokenProfile, 'utf8'), broken);

    for (const [label, changed] of [
      ['modified', installed.replace('agy --dangerously-skip-permissions', 'Write-Host user-data')],
      ['extra-content', installed.replace('function agyyolo {', '# keep my settings\nfunction agyyolo {')],
      ['duplicate', installed + installed],
      ['nested', installed.replace('function agyyolo {', '# >>> AI Code Tool Updater: agyyolo >>>\nfunction agyyolo {')]
    ]) {
      const conflictProfile = path.join(temp, `${label}.ps1`);
      fs.writeFileSync(conflictProfile, changed, 'utf8');
      assert.strictEqual(installAgyyoloToProfile(conflictProfile).ok, false);
      assert.strictEqual(removeAgyyoloFromProfile(conflictProfile).ok, false);
      assert.strictEqual(fs.readFileSync(conflictProfile, 'utf8'), changed);
    }

    const legacyProfile = path.join(temp, 'legacy.ps1');
    const legacy = 'function agyyolo {\n    agy --dangerously-skip-permissions\n}\n';
    fs.writeFileSync(legacyProfile, '# keep\n' + legacy + legacy, 'utf8');
    assert.strictEqual(installAgyyoloToProfile(legacyProfile).ok, true);
    assert.strictEqual((fs.readFileSync(legacyProfile, 'utf8').match(/# >>>/g) || []).length, 1);
    assert.strictEqual(removeAgyyoloFromProfile(legacyProfile).ok, true);
    assert.strictEqual(fs.readFileSync(legacyProfile, 'utf8'), '# keep\n');

    const bomProfile = path.join(temp, 'bom.ps1');
    fs.writeFileSync(bomProfile, '\uFEFF# 用户设置\r\n', 'utf8');
    assert.strictEqual(installAgyyoloToProfile(bomProfile).ok, true);
    assert.strictEqual(removeAgyyoloFromProfile(bomProfile).ok, true);
    assert.strictEqual(fs.readFileSync(bomProfile, 'utf8'), '\uFEFF# 用户设置\r\n');

    const utf16Profile = path.join(temp, 'utf16.ps1');
    const utf16 = Buffer.from('\uFEFF# user settings\r\n', 'utf16le');
    fs.writeFileSync(utf16Profile, utf16);
    assert.throws(() => installAgyyoloToProfile(utf16Profile), /UTF-8/);
    assert.throws(() => removeAgyyoloFromProfile(utf16Profile), /UTF-8/);
    assert.deepStrictEqual(fs.readFileSync(utf16Profile), utf16);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

checkAsync('shared concurrency limiter never exceeds its configured bound', async () => {
  const limit = createConcurrencyLimiter(2);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 8 }, () => limit(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
  })));
  assert.strictEqual(maximum, 2);
});

checkAsync('POSIX cleanup escalates for descendants after their group leader exits', async () => {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) {
    console.log('SKIP process integration test (requires Linux /proc)');
    return;
  }
  const child = spawn('sh', ['-c', 'trap "" TERM; sleep 30 & echo $!'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  try {
    let output = '';
    const pidReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not report descendant PID')), 3000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once('error', err => { clearTimeout(timer); reject(err); });
    });
    const leaderExited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('group leader did not exit')), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', err => { clearTimeout(timer); reject(err); });
    });
    const [descendantPid] = await Promise.all([pidReady, leaderExited]);
    assert.notStrictEqual(child.exitCode, null);
    killProcessTree(child);
    const deadline = Date.now() + 3000;
    let running = true;
    while (Date.now() < deadline) {
      try {
        const stat = fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8');
        const processState = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        running = processState !== 'Z';
      } catch {
        running = false;
      }
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.strictEqual(running, false, `descendant ${descendantPid} remained alive`);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
    child.stdout.destroy();
  }
});
