// scripts/verify-renderer.js
// 在轻量级 VM + Mock DOM 环境中加载 script.js，回归验证渲染层状态分类、卸载确认、批量安装过滤、序号合并与内联报错逻辑
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockElement(tagName = 'div', id = '') {
  const listeners = {};
  const classSet = new Set();
  const children = [];
  const attributes = {};
  const el = {
    tagName: tagName.toUpperCase(),
    id,
    value: '',
    checked: false,
    disabled: false,
    title: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 200,
    clientHeight: 200,
    dataset: {},
    style: { display: '' },
    options: [],
    selectedOptions: [],
    children,
    get childElementCount() { return children.length; },
    get firstChild() { return children[0] || null; },
    classList: {
      add: (...names) => names.forEach(n => n && classSet.add(n)),
      remove: (...names) => names.forEach(n => classSet.delete(n)),
      contains: (name) => classSet.has(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classSet.has(name) : !!force;
        if (shouldAdd) classSet.add(name);
        else classSet.delete(name);
        return shouldAdd;
      }
    },
    set className(val) {
      classSet.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
    },
    get className() {
      return [...classSet].join(' ');
    },
    set innerHTML(val) {
      el._innerHTML = String(val || '');
      children.length = 0;
    },
    get innerHTML() {
      return el._innerHTML || '';
    },
    appendChild(child) {
      if (child && child._isFragment) {
        children.push(...child.children);
        child.children.length = 0;
      } else if (child) {
        children.push(child);
        if (el.tagName === 'SELECT') el.options = children;
      }
      return child;
    },
    insertBefore(child, ref) {
      const idx = children.indexOf(ref);
      if (idx === -1) children.push(child);
      else children.splice(idx, 0, child);
      if (el.tagName === 'SELECT') el.options = children;
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    insertAdjacentElement() {},
    setAttribute(k, v) { attributes[k] = String(v); },
    getAttribute(k) { return attributes[k]; },
    getBoundingClientRect: () => ({ top: 100, bottom: 700, height: 600 }),
    scrollIntoView() { el._scrolledIntoView = true; },
    focus() { el._focused = true; },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(item => item !== fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners[type] || [])]) {
        fn({ target: el, preventDefault() {}, ...event });
      }
    },
    querySelector(selector) {
      const dataIdMatch = selector.match(/^\.tool-card\[data-id="(.+)"\]$/);
      if (dataIdMatch) {
        return children.find(c => c.dataset && c.dataset.id === dataIdMatch[1]) || null;
      }
      return null;
    },
    querySelectorAll() { return []; }
  };
  return el;
}

function createRendererHarness(apiOverrides = {}) {
  const elementsById = new Map();
  const getEl = (id, tag = 'div') => {
    if (!elementsById.has(id)) {
      const inferredTag = id.startsWith('select-') || id.startsWith('log-filter-')
        ? 'select'
        : id.startsWith('btn-')
          ? 'button'
          : id.startsWith('input-')
            ? 'input'
            : tag;
      elementsById.set(id, createMockElement(inferredTag, id));
    }
    return elementsById.get(id);
  };

  // 预创建页面关键节点
  [
    'tools-grid', 'log-resizer', 'log-container', 'btn-check', 'btn-update-all', 'btn-install-all',
    'btn-admin', 'btn-clear-log', 'btn-copy-log', 'btn-export-log', 'btn-add-tool', 'btn-settings',
    'btn-install-agyyolo', 'btn-remove-agyyolo', 'btn-open-powershell', 'btn-export-report',
    'select-registry', 'env-banner', 'env-banner-text', 'btn-dismiss-env', 'log-filter-level',
    'log-filter-tool', 'log-search', 'env-node', 'env-npm', 'env-os', 'modal-overlay',
    'btn-modal-close', 'btn-modal-cancel', 'btn-modal-save', 'input-tool-name', 'input-tool-pkg',
    'input-tool-cmd', 'input-tool-version-arg', 'modal-form-error', 'settings-overlay',
    'btn-settings-close', 'btn-settings-cancel', 'btn-settings-save', 'select-bg-check',
    'check-minimize-tray', 'check-open-at-login', 'check-start-minimized', 'registry-overlay',
    'btn-registry-close', 'btn-registry-cancel', 'btn-registry-save', 'input-registry-url',
    'registry-form-error', 'confirm-overlay', 'confirm-title', 'confirm-message', 'btn-confirm-ok',
    'btn-confirm-cancel', 'btn-confirm-close', 'stats-bar', 'stat-update', 'stat-install',
    'stat-latest', 'stat-error', 'stat-unsupported', 'btn-ping-registry', 'btn-auto-registry',
    'registry-speed-results'
  ].forEach(id => getEl(id));

  const mainEl = createMockElement('main');
  const logSection = createMockElement('section');
  const docListeners = {};
  const ipcCallbacks = {};

  const electronAPI = {
    platform: 'win32',
    getTools: async () => [],
    checkVersions: async () => ({ runId: 1, results: [] }),
    checkVersion: async (id) => ({ id, name: id, installed: false, notFound: true, seq: 99 }),
    updateTool: async () => ({ success: true }),
    installTool: async () => ({ success: true }),
    uninstallTool: async () => ({ success: true }),
    getRegistries: async () => [
      { id: 'npm', name: 'npm 官方源', url: 'https://registry.npmjs.org/' },
      { id: 'npmmirror', name: '淘宝镜像源', url: 'https://registry.npmmirror.com/' }
    ],
    getCurrentRegistry: async () => 'https://registry.npmjs.org/',
    setRegistry: async (url) => ({ success: true, registry: url }),
    addCustomTool: async (cfg) => ({ success: true, tool: cfg }),
    removeCustomTool: async () => ({ success: true }),
    checkEnvironment: async () => ({ node: 'v22.0.0', npm: '10.0.0', os: 'Windows 11', errors: [] }),
    exportLog: async () => ({ success: true, filePath: 'log.txt' }),
    exportReport: async () => ({ success: true, filePath: 'report.md' }),
    copyToClipboard: async () => ({ success: true }),
    getSettings: async () => ({}),
    saveSettings: async () => ({ success: true }),
    showAdminTip: async () => {},
    installAgyyolo: async () => ({ success: true, results: [] }),
    removeAgyyolo: async () => ({ success: true, results: [] }),
    openPowerShell: async () => ({ success: true }),
    openExternal: async () => ({ success: true }),
    pingRegistry: async () => ({ success: true, ms: 50 }),
    onUpdateLog: (cb) => { ipcCallbacks.updateLog = cb; },
    onTriggerCheck: (cb) => { ipcCallbacks.triggerCheck = cb; },
    onCheckRunStarted: (cb) => { ipcCallbacks.checkRunStarted = cb; },
    onToolChecked: (cb) => { ipcCallbacks.toolChecked = cb; },
    onBackgroundResults: (cb) => { ipcCallbacks.backgroundResults = cb; },
    onHighlightTool: (cb) => { ipcCallbacks.highlightTool = cb; },
    removeAllLogListeners: () => {},
    ...apiOverrides
  };

  class MockHTMLButtonElement {}

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ paddingBottom: '20', rowGap: '18', gap: '18' }),
    localStorage: { getItem: () => null, setItem: () => {} },
    CSS: { escape: (s) => String(s) },
    HTMLButtonElement: MockHTMLButtonElement,
    window: {
      innerHeight: 760,
      electronAPI,
      addEventListener: () => {},
      removeEventListener: () => {},
      confirm: () => true
    },
    document: {
      body: createMockElement('body'),
      querySelector: (sel) => (sel === '.main' ? mainEl : sel === '.log-section' ? logSection : null),
      querySelectorAll: () => [],
      getElementById: (id) => getEl(id),
      createElement: (tag) => createMockElement(tag),
      createDocumentFragment: () => ({ _isFragment: true, children: [], appendChild(c) { this.children.push(c); } }),
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
      removeEventListener: (type, fn) => {
        if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
      }
    }
  };

  let source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  // 替换自动启动入口，改为测试按需调用并暴露内部状态读写辅助
  source = source.replace(/\ninit\(\);\s*$/, `
globalThis.__test = {
  init,
  classifyTool,
  uninstallTool,
  installAll,
  updateTool,
  mergeToolResult,
  highlightToolCard,
  saveCustomRegistry,
  saveCustomTool,
  measureAllRegistries,
  renderTools,
  getToolsData: () => toolsData,
  setToolsData: (v) => { toolsData = v; },
  getStatsFilter: () => statsFilter,
  setStatsFilter: (v) => { statsFilter = v; },
  setLatestCheckRunId: (v) => { latestCheckRunId = v; },
  bindLogListener
};
`);

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { test: sandbox.__test, getEl, ipcCallbacks, electronAPI };
}

async function run() {
  let failed = 0;
  const runCase = async (name, fn) => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}: ${err.stack || err.message}`);
    }
  };

  await runCase('uninstallTool defines tool properly and handles npm / keepData / script tools without ReferenceError', async () => {
    const uninstalledIds = [];
    const { test, getEl } = createRendererHarness({
      uninstallTool: async (id) => {
        uninstalledIds.push(id);
        return { success: true };
      }
    });
    test.setToolsData([
      { id: 'kimi', name: 'Kimi Code', pkg: '@moonshot-ai/kimi-code', installed: true, latestVersion: '1.0.0', currentVersion: '1.0.0', seq: 1 },
      { id: 'atomcode', name: 'AtomCode', installScript: { winUrl: 'https://example.com/i.ps1' }, uninstallKeepsData: true, installed: true, seq: 2 }
    ]);

    const p1 = test.uninstallTool('kimi');
    // 确认弹框应当打开且包含 npm 卸载说明
    assert.strictEqual(getEl('confirm-overlay').style.display, 'flex');
    assert.match(getEl('confirm-message').innerHTML, /npm 包会被移除/);
    getEl('btn-confirm-ok').dispatch('click');
    await p1;
    assert.deepStrictEqual(uninstalledIds, ['kimi']);

    const p2 = test.uninstallTool('atomcode');
    assert.strictEqual(getEl('confirm-overlay').style.display, 'flex');
    assert.match(getEl('confirm-message').innerHTML, /本地数据（如配置与会话记录）会被保留/);
    getEl('btn-confirm-ok').dispatch('click');
    await p2;
    assert.deepStrictEqual(uninstalledIds, ['kimi', 'atomcode']);
  });

  await runCase('installAll installs only notFound tools and skips tools that errored on version check', async () => {
    const installedIds = [];
    const { test } = createRendererHarness({
      installTool: async (id) => {
        installedIds.push(id);
        return { success: true };
      }
    });
    test.setToolsData([
      { id: 'missing-cli', name: 'Missing CLI', installed: false, notFound: true, supported: true, seq: 1 },
      { id: 'broken-cli', name: 'Broken CLI', installed: false, notFound: false, error: 'timeout', supported: true, seq: 2 },
      { id: 'unsupported-cli', name: 'Mac Only', installed: false, notFound: true, supported: false, seq: 3 }
    ]);

    await test.installAll();
    assert.deepStrictEqual(installedIds, ['missing-cli']);
  });

  await runCase('mergeToolResult preserves newer single-tool seq over stale batch result', async () => {
    const { test } = createRendererHarness();
    test.setToolsData([]);
    assert.strictEqual(test.mergeToolResult({ id: 'claude', currentVersion: '1.0.0', seq: 5 }), true);
    assert.strictEqual(test.mergeToolResult({ id: 'claude', currentVersion: '1.1.0', seq: 12 }), true);
    // 迟到的旧批次结果（seq=6 < 12）必须被忽略
    assert.strictEqual(test.mergeToolResult({ id: 'claude', currentVersion: '1.0.0', seq: 6 }), false);
    assert.strictEqual(test.getToolsData()[0].currentVersion, '1.1.0');
  });

  await runCase('background results update state and highlightToolCard clears conflicting statsFilter', async () => {
    const { test, ipcCallbacks } = createRendererHarness();
    test.bindLogListener();
    ipcCallbacks.backgroundResults({
      runId: 3,
      results: [
        { id: 'claude', name: 'Claude Code', installed: true, currentVersion: '1.0.0', latestVersion: '1.1.0', needsUpdate: true, seq: 10 }
      ]
    });
    assert.strictEqual(test.getToolsData()[0].needsUpdate, true);

    // 开启 install 过滤导致 claude（update 类别）不在网格中，调用 highlightToolCard 应自动解除过滤并高亮卡片
    test.setStatsFilter('install');
    test.renderTools();
    test.highlightToolCard('claude');
    assert.strictEqual(test.getStatsFilter(), null);
  });

  await runCase('modal validation writes inline error into modal instead of only hidden background log', async () => {
    const { test, getEl } = createRendererHarness();
    getEl('input-registry-url').value = 'http://insecure.example.com/';
    await test.saveCustomRegistry();
    assert.strictEqual(getEl('registry-form-error').style.display, 'block');
    assert.match(getEl('registry-form-error').textContent, /https:\/\//);

    getEl('input-tool-name').value = '';
    await test.saveCustomTool();
    assert.strictEqual(getEl('modal-form-error').style.display, 'block');
  });

  await runCase('measureAllRegistries includes active custom registry alongside presets', async () => {
    const pinged = [];
    const { test } = createRendererHarness({
      getCurrentRegistry: async () => 'https://npm.corp.example.com/',
      pingRegistry: async (url) => {
        pinged.push(url);
        return { success: true, ms: 20 };
      }
    });
    const results = await test.measureAllRegistries();
    assert.strictEqual(results.length, 3);
    assert(pinged.includes('https://npm.corp.example.com/'));
  });

  if (failed > 0) {
    process.exit(1);
  }
  console.log('渲染层回归测试全部通过');
}

run();
