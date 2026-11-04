// Lightweight security/reliability regression checks without Electron or a test framework.
// Run via `npm test`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const mainPath = path.join(__dirname, '..', 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const standaloneAgyyoloSource = fs.readFileSync(path.join(__dirname, 'setup-agyyolo.ps1'), 'utf8');

function extractFunction(name) {
  const pattern = new RegExp(`(?:async\\s+)?function ${name}\\([\\s\\S]*?^}`, 'm');
  const match = mainSource.match(pattern);
  assert(match, `missing function ${name}`);
  return match[0];
}

const helperNames = [
  'isValidRegistryUrl', 'isValidNpmPackage', 'isValidCliCommand', 'isValidVersionArg',
  'isPlainObject', 'hasOnlyFields', 'isValidToolName', 'parseSemver', 'createConcurrencyLimiter',
  'isCurrentCheckRun', 'profileResultsSucceeded', 'killProcessTree', 'ensureProfile',
  'readProfileContent', 'writeProfileAtomically', 'getAgyyoloManagedState', 'installAgyyoloToProfile', 'removeAgyyoloFromProfile'
];
const constants = [
  'AGYYOLO_BEGIN_MARKER', 'AGYYOLO_END_MARKER', 'AGYYOLO_FUNCTION_BODY',
  'AGYYOLO_LEGACY_PATTERN', 'AGYYOLO_MANAGED_PATTERN'
].map(name => {
  const match = mainSource.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  assert(match, `missing constant ${name}`);
  return match[0];
}).join('\n');
const helpers = new Function(
  'fs', 'path', 'os', 'spawn', 'process', 'setTimeout',
  `${constants}\n${helperNames.map(extractFunction).join('\n')}\nreturn { ${helperNames.join(', ')} };`
)(fs, path, os, spawn, process, setTimeout);

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
  assert.strictEqual(helpers.isValidRegistryUrl('https://registry.npmjs.org/'), true);
  assert.strictEqual(helpers.isValidRegistryUrl('http://registry.npmjs.org/'), false);
  assert.strictEqual(helpers.isValidRegistryUrl('https://user:pass@example.com/'), false);
  assert.strictEqual(helpers.isValidRegistryUrl('https://example.com/?token=x'), false);
  assert.strictEqual(helpers.isValidRegistryUrl('https://example.com/#fragment'), false);
});

check('custom tool primitives reject invalid or oversized values', () => {
  assert.strictEqual(helpers.isPlainObject({ name: 'tool' }), true);
  assert.strictEqual(helpers.isPlainObject([]), false);
  assert.strictEqual(helpers.hasOnlyFields({ name: 'tool' }, ['name']), true);
  assert.strictEqual(helpers.hasOnlyFields({ name: 'tool', installScript: 'evil' }, ['name']), false);
  assert.strictEqual(helpers.isValidToolName('My CLI'), true);
  assert.strictEqual(helpers.isValidToolName('x'.repeat(81)), false);
  assert.strictEqual(helpers.isValidNpmPackage('@scope/pkg'), true);
  assert.strictEqual(helpers.isValidNpmPackage('bad;command'), false);
  assert.strictEqual(helpers.isValidCliCommand('my-cli'), true);
  assert.strictEqual(helpers.isValidVersionArg('--version'), true);
});

check('check generation accepts only the current run', () => {
  assert.strictEqual(helpers.isCurrentCheckRun(12, 12), true);
  assert.strictEqual(helpers.isCurrentCheckRun(11, 12), false);
});

check('per-profile result aggregation rejects empty and partial success', () => {
  assert.strictEqual(helpers.profileResultsSucceeded([]), false);
  assert.strictEqual(helpers.profileResultsSucceeded([{ ok: true }, { ok: false }]), false);
  assert.strictEqual(helpers.profileResultsSucceeded([{ ok: true }, { ok: true }]), true);
});

check('Electron/IPC and supply-chain protections are wired into runtime paths', () => {
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
  assert.match(mainSource, /id: t\.id,[\s\S]*?versionArg: \(t\.versionArg/);
  assert.doesNotMatch(mainSource.slice(mainSource.indexOf('function loadCustomTools'), mainSource.indexOf('function saveCustomTools')), /\.\.\.t/);
  assert.match(preloadSource, /onCheckRunStarted/);
  assert.match(rendererSource, /payload\.runId === latestCheckRunId/);
  assert.match(rendererSource, /response\.runId !== latestCheckRunId/);
  assert.match(mainSource, /CHECK_BATCH_MIN_INTERVAL_MS = 1000/);
  assert.match(mainSource, /createConcurrencyLimiter\(4\)/);
});

check('IPC trusts only the current local main frame', () => {
  const appDirectory = path.join(__dirname, '..');
  const frame = { url: pathToFileURL(path.join(appDirectory, 'index.html')).href };
  const contents = { mainFrame: frame };
  let destroyed = false;
  const window = { webContents: contents, isDestroyed: () => destroyed };
  const isTrusted = new Function('mainWindow', 'path', 'pathToFileURL', '__dirname',
    `${extractFunction('isTrustedIpcEvent')}\nreturn isTrustedIpcEvent;`
  )(window, path, pathToFileURL, appDirectory);
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: frame }), true);
  assert.strictEqual(isTrusted({ sender: {}, senderFrame: frame }), false);
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: { url: frame.url } }), false);
  assert.strictEqual(isTrusted({ sender: contents }), false);
  frame.url = 'https://example.com/';
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: frame }), false);
  destroyed = true;
  assert.strictEqual(isTrusted({ sender: contents, senderFrame: frame }), false);
});

checkAsync('one failed tool check does not reject its batch', async () => {
  const safeCheck = new Function('checkTool',
    `${extractFunction('checkToolSafely')}\nreturn checkToolSafely;`
  )(async tool => {
    if (tool.id === 'bad') throw new Error('isolated failure');
    return { ...tool, installed: true };
  });
  const results = await Promise.all([{ id: 'bad' }, { id: 'good' }].map(tool => safeCheck(tool)));
  assert.strictEqual(results[0].error, 'isolated failure');
  assert.strictEqual(results[0].needsUpdate, false);
  assert.strictEqual(results[1].installed, true);
});

check('POSIX children are detached and process groups are signalled', () => {
  assert.match(mainSource, /detached:\s*!isWin/);
  assert.match(mainSource, /process\.kill\(-child\.pid, 'SIGTERM'\)/);
  assert.match(mainSource, /process\.kill\(-child\.pid, 'SIGKILL'\)/);
});

check('agyyolo confirmation and reversible management are wired in', () => {
  assert.match(mainSource, /我了解风险，继续/);
  assert.match(mainSource, /remove-agyyolo/);
  assert.match(mainSource, /profileResultsSucceeded\(results\)/);
  assert.match(mainSource, /function removeAgyyoloFromProfile\(/);
  assert.match(rendererSource, /btn-remove-agyyolo/);
  assert.match(standaloneAgyyoloSource, /Read-Host '确认写入请输入 YES/);
  assert.match(standaloneAgyyoloSource, /\[switch\]\$Remove/);
  assert.match(standaloneAgyyoloSource, /Write-ProfileAtomically/);
  assert.doesNotMatch(standaloneAgyyoloSource, /New-Item[^\n]*-LiteralPath/);
  assert.match(standaloneAgyyoloSource, /Get-ManagedState/);
});

check('agyyolo install/remove preserves user content and is idempotent', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agyyolo-'));
  try {
    const profile = path.join(temp, 'Microsoft.PowerShell_profile.ps1');
    fs.writeFileSync(profile, '# user content\n', 'utf8');
    const first = helpers.installAgyyoloToProfile(profile);
    assert.strictEqual(first.ok, true);
    const installed = fs.readFileSync(profile, 'utf8');
    assert.match(installed, /# user content/);
    assert.match(installed, /# >>> AI Code Tool Updater: agyyolo >>>/);
    assert.match(installed, /agy --dangerously-skip-permissions/);
    assert.strictEqual(helpers.installAgyyoloToProfile(profile).ok, true);
    assert.strictEqual(fs.readFileSync(profile, 'utf8'), installed);
    assert.strictEqual(helpers.removeAgyyoloFromProfile(profile).ok, true);
    const removed = fs.readFileSync(profile, 'utf8');
    assert.match(removed, /# user content/);
    assert.doesNotMatch(removed, /function agyyolo/);
    assert.doesNotMatch(removed, /AI Code Tool Updater: agyyolo/);

    const customProfile = path.join(temp, 'custom.ps1');
    fs.writeFileSync(customProfile, 'function agyyolo { Write-Host custom }\n', 'utf8');
    const before = fs.readFileSync(customProfile, 'utf8');
    assert.strictEqual(helpers.installAgyyoloToProfile(customProfile).ok, false);
    assert.strictEqual(helpers.removeAgyyoloFromProfile(customProfile).ok, false);
    assert.strictEqual(fs.readFileSync(customProfile, 'utf8'), before);

    const brokenProfile = path.join(temp, 'broken.ps1');
    const broken = '# >>> AI Code Tool Updater: agyyolo >>>\n# incomplete\n';
    fs.writeFileSync(brokenProfile, broken, 'utf8');
    assert.strictEqual(helpers.installAgyyoloToProfile(brokenProfile).ok, false);
    assert.strictEqual(helpers.removeAgyyoloFromProfile(brokenProfile).ok, false);
    assert.strictEqual(fs.readFileSync(brokenProfile, 'utf8'), broken);

    for (const [label, changed] of [
      ['modified', installed.replace('agy --dangerously-skip-permissions', 'Write-Host user-data')],
      ['extra-content', installed.replace('function agyyolo {', '# keep my settings\nfunction agyyolo {')],
      ['duplicate', installed + installed],
      ['nested', installed.replace('function agyyolo {', '# >>> AI Code Tool Updater: agyyolo >>>\nfunction agyyolo {')]
    ]) {
      const conflictProfile = path.join(temp, `${label}.ps1`);
      fs.writeFileSync(conflictProfile, changed, 'utf8');
      assert.strictEqual(helpers.installAgyyoloToProfile(conflictProfile).ok, false);
      assert.strictEqual(helpers.removeAgyyoloFromProfile(conflictProfile).ok, false);
      assert.strictEqual(fs.readFileSync(conflictProfile, 'utf8'), changed);
    }
    const legacyProfile = path.join(temp, 'legacy.ps1');
    const legacy = 'function agyyolo {\n    agy --dangerously-skip-permissions\n}\n';
    fs.writeFileSync(legacyProfile, '# keep\n' + legacy + legacy, 'utf8');
    assert.strictEqual(helpers.installAgyyoloToProfile(legacyProfile).ok, true);
    assert.strictEqual((fs.readFileSync(legacyProfile, 'utf8').match(/# >>>/g) || []).length, 1);
    assert.strictEqual(helpers.removeAgyyoloFromProfile(legacyProfile).ok, true);
    assert.strictEqual(fs.readFileSync(legacyProfile, 'utf8'), '# keep\n');

    const bomProfile = path.join(temp, 'bom.ps1');
    fs.writeFileSync(bomProfile, '\uFEFF# 用户设置\r\n', 'utf8');
    assert.strictEqual(helpers.installAgyyoloToProfile(bomProfile).ok, true);
    assert.strictEqual(helpers.removeAgyyoloFromProfile(bomProfile).ok, true);
    assert.strictEqual(fs.readFileSync(bomProfile, 'utf8'), '\uFEFF# 用户设置\r\n');
    const utf16Profile = path.join(temp, 'utf16.ps1');
    const utf16 = Buffer.from('\uFEFF# user settings\r\n', 'utf16le');
    fs.writeFileSync(utf16Profile, utf16);
    assert.throws(() => helpers.installAgyyoloToProfile(utf16Profile), /UTF-8/);
    assert.throws(() => helpers.removeAgyyoloFromProfile(utf16Profile), /UTF-8/);
    assert.deepStrictEqual(fs.readFileSync(utf16Profile), utf16);


  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

checkAsync('shared concurrency limiter never exceeds its configured bound', async () => {
  const limit = helpers.createConcurrencyLimiter(2);
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
  // The shell exits immediately; sleep inherits ignored SIGTERM and keeps the pipe open.
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
    helpers.killProcessTree(child);
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
