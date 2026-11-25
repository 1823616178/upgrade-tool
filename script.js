// ===== 状态变量 =====
let toolsData = [];
let isChecking = false;
let latestCheckRunId = 0;
/**
 * 工具级操作锁：维护“正在操作”的工具 ID -> 操作类型（'update' | 'install' | 'uninstall'）
 * 单个工具执行期间仅锁定自身卡片，其它工具仍可独立操作；直到新版本回查完成后才解锁
 */
const updatingTools = new Map();
/** 批量更新/安装是否正在执行（防止局部刷新时误把批量按钮重新启用） */
let isBatchRunning = false;
/** 切换到「自定义源」前，记住当前选中的镜像源，取消时可恢复 */
let previousRegistryUrl = '';
/** stats 栏当前过滤状态（null=无过滤，字符串=展示对应类别） */
let statsFilter = null;

// ===== 日志数据（过滤视图的数据源；复制/导出始终作用于全部条目） =====
const MAX_LOG_ENTRIES = 2000;
const logEntries = [];
const logFilters = { level: '', tool: '', keyword: '' };
let visibleLogCount = 0;
let logSearchTimer = null;

// ===== 日志面板高度 =====
const LOG_HEIGHT_STORAGE_KEY = 'ai-tool-updater:log-panel-height';
const MIN_LOG_HEIGHT = 150;
const MIN_GRID_HEIGHT = 160;
let logPanelHeight = null;

// ===== DOM 元素 =====
const mainEl = document.querySelector('.main');
const toolsGrid = document.getElementById('tools-grid');
const logSection = document.querySelector('.log-section');
const logResizer = document.getElementById('log-resizer');
const logContainer = document.getElementById('log-container');
const btnCheck = document.getElementById('btn-check');
const btnUpdateAll = document.getElementById('btn-update-all');
const btnInstallAll = document.getElementById('btn-install-all');
const btnAdmin = document.getElementById('btn-admin');
const btnClearLog = document.getElementById('btn-clear-log');
const btnCopyLog = document.getElementById('btn-copy-log');
const btnExportLog = document.getElementById('btn-export-log');
const btnAddTool = document.getElementById('btn-add-tool');
const btnSettings = document.getElementById('btn-settings');
const btnInstallAgyyolo = document.getElementById('btn-install-agyyolo');
const btnRemoveAgyyolo = document.getElementById('btn-remove-agyyolo');
const btnOpenPowerShell = document.getElementById('btn-open-powershell');
const btnExportReport = document.getElementById('btn-export-report');
const selectRegistry = document.getElementById('select-registry');
const envBanner = document.getElementById('env-banner');
const envBannerText = document.getElementById('env-banner-text');
const btnDismissEnv = document.getElementById('btn-dismiss-env');
const logFilterLevel = document.getElementById('log-filter-level');
const logFilterTool = document.getElementById('log-filter-tool');
const logSearch = document.getElementById('log-search');
const envNode = document.getElementById('env-node');
const envNpm = document.getElementById('env-npm');
const envOs = document.getElementById('env-os');

// 自定义工具模态框
const modalOverlay = document.getElementById('modal-overlay');
const btnModalClose = document.getElementById('btn-modal-close');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalSave = document.getElementById('btn-modal-save');
const inputToolName = document.getElementById('input-tool-name');
const inputToolPkg = document.getElementById('input-tool-pkg');
const inputToolCmd = document.getElementById('input-tool-cmd');
const inputToolVersionArg = document.getElementById('input-tool-version-arg');
const modalFormError = document.getElementById('modal-form-error');

// 设置模态框
const settingsOverlay = document.getElementById('settings-overlay');
const btnSettingsClose = document.getElementById('btn-settings-close');
const btnSettingsCancel = document.getElementById('btn-settings-cancel');
const btnSettingsSave = document.getElementById('btn-settings-save');
const selectBgCheck = document.getElementById('select-bg-check');
const checkMinimizeTray = document.getElementById('check-minimize-tray');
const checkOpenAtLogin = document.getElementById('check-open-at-login');
const checkStartMinimized = document.getElementById('check-start-minimized');

// 自定义镜像源模态框
const registryOverlay = document.getElementById('registry-overlay');
const btnRegistryClose = document.getElementById('btn-registry-close');
const btnRegistryCancel = document.getElementById('btn-registry-cancel');
const btnRegistrySave = document.getElementById('btn-registry-save');
const inputRegistryUrl = document.getElementById('input-registry-url');
const registryFormError = document.getElementById('registry-form-error');

// ===== 初始化 =====
async function init() {
  bindEvents();
  bindLogListener();
  applyPlatformUI();
  initLogResizer();

  // 环境检测独立执行，不阻塞首屏和版本检测
  checkEnvironment();

  // 并行执行：镜像源加载、骨架屏渲染（基于真实工具列表，含自定义工具）
  await Promise.all([
    loadRegistries(),
    renderSkeletonFromTools()
  ]);

  // 加载完成后立即启动流式检测
  await checkVersions();
}

/** 根据运行平台调整 UI（隐藏 Windows 专属功能，macOS/Linux 用「终端」代替 PowerShell） */
function applyPlatformUI() {
  const platform = window.electronAPI.platform;
  if (platform === 'win32') return;

  if (btnInstallAgyyolo) btnInstallAgyyolo.style.display = 'none';
  if (btnRemoveAgyyolo) btnRemoveAgyyolo.style.display = 'none';
  if (btnOpenPowerShell) {
    btnOpenPowerShell.innerHTML = '<span class="icon">💻</span> 终端';
    btnOpenPowerShell.title = platform === 'darwin' ? '打开 Terminal' : '打开终端';
  }
}

// ===== 日志面板高度拖拽 =====
function getMaxLogPanelHeight() {
  const style = getComputedStyle(mainEl);
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const gap = parseFloat(style.rowGap) || parseFloat(style.gap) || 0;
  const mainBottom = mainEl.getBoundingClientRect().bottom - paddingBottom;
  const gridTop = toolsGrid.getBoundingClientRect().top;
  return Math.max(MIN_LOG_HEIGHT, mainBottom - gridTop - MIN_GRID_HEIGHT - gap);
}

function setLogPanelHeight(height, { persist = false } = {}) {
  const desired = Number.isFinite(height) ? height : logSection.getBoundingClientRect().height;
  const clamped = Math.min(Math.max(Math.round(desired), MIN_LOG_HEIGHT), getMaxLogPanelHeight());

  logPanelHeight = clamped;
  logSection.style.flex = `0 0 ${clamped}px`;
  logResizer.setAttribute('aria-valuenow', String(clamped));

  if (persist) {
    try {
      localStorage.setItem(LOG_HEIGHT_STORAGE_KEY, String(clamped));
    } catch { /* localStorage 不可用时忽略 */ }
  }
  return clamped;
}

function getDefaultLogPanelHeight() {
  const height = mainEl.getBoundingClientRect().height || window.innerHeight * 0.6;
  return Math.round(height * 0.3);
}

function clampLogPanelHeight() {
  if (logPanelHeight === null) return;
  setLogPanelHeight(logPanelHeight);
}

function initLogResizer() {
  let saved = NaN;
  try {
    saved = Number(localStorage.getItem(LOG_HEIGHT_STORAGE_KEY));
  } catch { /* localStorage 不可用时使用默认值 */ }

  setLogPanelHeight(Number.isFinite(saved) && saved > 0 ? saved : getDefaultLogPanelHeight());

  logResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = logSection.getBoundingClientRect().height;
    let nextHeight = startHeight;
    let frame = null;

    logResizer.classList.add('dragging');
    document.body.classList.add('is-resizing-log');

    const onMove = (ev) => {
      nextHeight = startHeight + (startY - ev.clientY);
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setLogPanelHeight(nextHeight);
      });
    };

    const finish = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      setLogPanelHeight(nextHeight, { persist: true });
      logResizer.classList.remove('dragging');
      document.body.classList.remove('is-resizing-log');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  logResizer.addEventListener('dblclick', () => {
    setLogPanelHeight(getDefaultLogPanelHeight(), { persist: true });
  });

  logResizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 24 : -24;
    setLogPanelHeight((logPanelHeight ?? logSection.getBoundingClientRect().height) + delta, { persist: true });
  });

  window.addEventListener('resize', () => requestAnimationFrame(clampLogPanelHeight));
}

async function renderSkeletonFromTools() {
  try {
    const tools = await window.electronAPI.getTools();
    renderSkeleton(tools);
  } catch (err) {
    appendLog('error', 'system', `加载工具列表失败: ${err.message}`);
    renderSkeleton([]);
  }
}

// ===== 模态框内联错误提示辅助 =====
function showFormError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function clearFormError(el) {
  showFormError(el, '');
}

// ===== 事件绑定 =====
function bindEvents() {
  btnCheck.addEventListener('click', checkVersions);
  btnUpdateAll.addEventListener('click', updateAll);
  btnInstallAll.addEventListener('click', installAll);
  btnAdmin.addEventListener('click', () => window.electronAPI.showAdminTip());
  btnInstallAgyyolo.addEventListener('click', installAgyyolo);
  if (btnRemoveAgyyolo) btnRemoveAgyyolo.addEventListener('click', removeAgyyolo);
  btnOpenPowerShell.addEventListener('click', openPowerShell);
  btnExportReport.addEventListener('click', exportVersionReport);
  btnClearLog.addEventListener('click', clearLog);
  btnCopyLog.addEventListener('click', copyLog);
  btnExportLog.addEventListener('click', exportLog);
  btnAddTool.addEventListener('click', openModal);
  btnSettings.addEventListener('click', openSettings);

  const btnPingRegistry = document.getElementById('btn-ping-registry');
  if (btnPingRegistry) btnPingRegistry.addEventListener('click', pingAllRegistries);
  const btnAutoRegistry = document.getElementById('btn-auto-registry');
  if (btnAutoRegistry) btnAutoRegistry.addEventListener('click', autoSelectFastestRegistry);
  btnDismissEnv.addEventListener('click', () => { envBanner.style.display = 'none'; });

  toolsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('btn-update'))          updateTool(btn.dataset.id);
    else if (btn.classList.contains('btn-install'))    installTool(btn.dataset.id);
    else if (btn.classList.contains('btn-uninstall'))  uninstallTool(btn.dataset.id);
    else if (btn.classList.contains('btn-remove'))     removeCustomTool(btn.dataset.id);
    else if (btn.classList.contains('changelog-link') && btn.dataset.url) {
      window.electronAPI.openExternal(btn.dataset.url);
    }
  });

  selectRegistry.addEventListener('change', onRegistryChange);

  // 自定义工具模态框（支持输入时自动清错 + 回车提交）
  btnModalClose.addEventListener('click', closeModal);
  btnModalCancel.addEventListener('click', closeModal);
  btnModalSave.addEventListener('click', saveCustomTool);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  [inputToolName, inputToolPkg, inputToolCmd, inputToolVersionArg].forEach((input) => {
    if (!input) return;
    input.addEventListener('input', () => clearFormError(modalFormError));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveCustomTool();
      }
    });
  });

  // 设置模态框
  btnSettingsClose.addEventListener('click', closeSettings);
  btnSettingsCancel.addEventListener('click', closeSettings);
  btnSettingsSave.addEventListener('click', saveSettingsFromUI);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  // 自定义镜像源模态框（支持输入时自动清错 + 回车提交）
  btnRegistryClose.addEventListener('click', cancelCustomRegistry);
  btnRegistryCancel.addEventListener('click', cancelCustomRegistry);
  btnRegistrySave.addEventListener('click', saveCustomRegistry);
  registryOverlay.addEventListener('click', (e) => {
    if (e.target === registryOverlay) cancelCustomRegistry();
  });
  if (inputRegistryUrl) {
    inputRegistryUrl.addEventListener('input', () => clearFormError(registryFormError));
    inputRegistryUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveCustomRegistry();
      }
    });
  }

  // 日志过滤
  logFilterLevel.addEventListener('change', () => { logFilters.level = logFilterLevel.value; renderLogs(); });
  logFilterTool.addEventListener('change', () => { logFilters.tool = logFilterTool.value; renderLogs(); });
  logSearch.addEventListener('input', () => {
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => {
      logFilters.keyword = logSearch.value;
      renderLogs();
    }, 150);
  });

  // Esc 关闭任意打开的模态框（确认弹框有独立键盘拦截，优先忽略）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const confirmOverlay = document.getElementById('confirm-overlay');
    if (confirmOverlay && confirmOverlay.style.display === 'flex') return;
    if (modalOverlay.style.display === 'flex') closeModal();
    else if (settingsOverlay.style.display === 'flex') closeSettings();
    else if (registryOverlay.style.display === 'flex') cancelCustomRegistry();
  });
}

/**
 * 合并单个工具检测结果到 toolsData
 * 通过主进程单调递增的 seq 防止迟到的旧批次覆盖已由单工具刷新得到的更新状态
 */
function mergeToolResult(result) {
  if (!result || !result.id) return false;
  const idx = toolsData.findIndex(t => t.id === result.id);
  if (idx !== -1) {
    const existingSeq = Number(toolsData[idx].seq) || 0;
    const incomingSeq = Number(result.seq) || 0;
    if (incomingSeq > 0 && existingSeq > incomingSeq) {
      return false;
    }
    toolsData[idx] = result;
  } else {
    toolsData.push(result);
  }
  return true;
}

function bindLogListener() {
  window.electronAPI.removeAllLogListeners();
  window.electronAPI.onUpdateLog((data) => {
    appendLog(data.type, data.toolId, data.message, data.time);
  });
  window.electronAPI.onTriggerCheck(() => {
    checkVersions();
  });
  window.electronAPI.onCheckRunStarted((runId) => {
    if (Number.isSafeInteger(runId)) latestCheckRunId = Math.max(latestCheckRunId, runId);
  });
  window.electronAPI.onToolChecked((payload) => {
    if (payload && payload.runId === latestCheckRunId) onSingleToolChecked(payload.result);
  });
  if (window.electronAPI.onBackgroundResults) {
    window.electronAPI.onBackgroundResults((payload) => {
      if (!payload || !Array.isArray(payload.results) || isChecking) return;
      if (Number.isSafeInteger(payload.runId)) {
        latestCheckRunId = Math.max(latestCheckRunId, payload.runId);
      }
      for (const item of payload.results) {
        mergeToolResult(item);
      }
      renderTools();
    });
  }
  window.electronAPI.onHighlightTool((toolId) => {
    highlightToolCard(toolId);
  });
}

// ===== 环境健康检测 =====
async function checkEnvironment() {
  try {
    const env = await window.electronAPI.checkEnvironment();

    if (envNode) envNode.textContent = `Node: ${env.node || '未安装'}`;
    if (envNpm) envNpm.textContent = `npm: ${env.npm || '未安装'}`;
    if (envOs) envOs.textContent = env.os || 'OS: 未知';

    if (env.errors && env.errors.length > 0) {
      envBanner.style.display = 'flex';
      envBannerText.textContent = env.errors.join(' | ');

      const oldLink = envBanner.querySelector('.env-banner-link');
      if (oldLink) oldLink.remove();

      if (env.errors.some(e => /Node\.js|npm/i.test(e))) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'env-banner-link';
        link.textContent = '打开 Node.js 官网';
        link.addEventListener('click', () => {
          window.electronAPI.openExternal('https://nodejs.org/');
        });
        envBannerText.insertAdjacentElement('afterend', link);
      }

      appendLog('error', 'system', `环境异常: ${env.errors.join('; ')}`);
    }
  } catch (err) {
    appendLog('error', 'system', `环境检测失败: ${err.message}`);
  }
}

// ===== 镜像源加载 =====
async function loadRegistries() {
  try {
    const registries = await window.electronAPI.getRegistries();
    const current = await window.electronAPI.getCurrentRegistry();
    previousRegistryUrl = current;

    selectRegistry.innerHTML = '';
    for (const reg of registries) {
      const option = document.createElement('option');
      option.value = reg.url;
      option.textContent = reg.name;
      if (reg.url === current) option.selected = true;
      selectRegistry.appendChild(option);
    }

    const customEntry = document.createElement('option');
    customEntry.value = '__custom__';
    customEntry.textContent = '自定义源...';
    selectRegistry.appendChild(customEntry);

    const isPreset = registries.some(r => r.url === current);
    if (!isPreset && current) {
      const customActive = document.createElement('option');
      customActive.value = current;
      customActive.textContent = `自定义: ${current}`;
      customActive.selected = true;
      selectRegistry.insertBefore(customActive, customEntry);
      previousRegistryUrl = current;
    }
  } catch (err) {
    appendLog('error', 'system', `加载镜像源失败: ${err.message}`);
  }
}

async function onRegistryChange() {
  const url = selectRegistry.value;
  if (url === '__custom__') {
    openCustomRegistryModal();
    return;
  }
  try {
    const result = await window.electronAPI.setRegistry(url);
    if (!result.success) {
      appendLog('error', 'system', result.message || '镜像源切换失败');
      await loadRegistries();
      return;
    }
    previousRegistryUrl = result.registry || url;
    appendLog('info', 'system', `镜像源已切换为: ${previousRegistryUrl}`);
  } catch (err) {
    appendLog('error', 'system', `镜像源切换失败: ${err.message}`);
    await loadRegistries();
  }
}

function openCustomRegistryModal() {
  clearFormError(registryFormError);
  inputRegistryUrl.value = previousRegistryUrl && !isPresetRegistry(previousRegistryUrl)
    ? previousRegistryUrl
    : '';
  registryOverlay.style.display = 'flex';
  inputRegistryUrl.focus();
}

function isPresetRegistry(url) {
  const options = Array.from(selectRegistry.options);
  return options.some(o => o.value === url && o.value !== '__custom__' && !o.textContent.startsWith('自定义:'));
}

function cancelCustomRegistry() {
  clearFormError(registryFormError);
  registryOverlay.style.display = 'none';
  loadRegistries();
}

async function saveCustomRegistry() {
  const url = inputRegistryUrl.value.trim();
  if (!url) {
    showFormError(registryFormError, '请输入镜像源 URL');
    return;
  }
  if (!/^https:\/\//i.test(url)) {
    showFormError(registryFormError, '镜像源 URL 必须以 https:// 开头');
    return;
  }
  try {
    const result = await window.electronAPI.setRegistry(url);
    if (!result.success) {
      showFormError(registryFormError, result.message || '镜像源切换失败');
      return;
    }
    clearFormError(registryFormError);
    registryOverlay.style.display = 'none';
    previousRegistryUrl = result.registry || url;
    await loadRegistries();
    appendLog('success', 'system', `已使用自定义镜像源: ${previousRegistryUrl}`);
  } catch (err) {
    showFormError(registryFormError, `镜像源切换失败: ${err.message}`);
  }
}

// ===== 设置页 =====
async function openSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    const hours = settings.backgroundCheckHours ?? 4;
    selectBgCheck.value = String(hours);
    checkMinimizeTray.checked = settings.minimizeToTray !== false;
    checkOpenAtLogin.checked = !!settings.openAtLogin;
    checkStartMinimized.checked = !!settings.startMinimized;
    settingsOverlay.style.display = 'flex';
  } catch (err) {
    appendLog('error', 'system', `加载设置失败: ${err.message}`);
  }
}

function closeSettings() {
  settingsOverlay.style.display = 'none';
}

async function saveSettingsFromUI() {
  try {
    const backgroundCheckHours = parseInt(selectBgCheck.value, 10);
    const minimizeToTray = checkMinimizeTray.checked;
    const openAtLogin = checkOpenAtLogin.checked;
    const startMinimized = checkStartMinimized.checked;
    await window.electronAPI.saveSettings({ backgroundCheckHours, minimizeToTray, openAtLogin, startMinimized });
    closeSettings();
    appendLog('success', 'system', `设置已保存：后台检测 ${backgroundCheckHours === 0 ? '已关闭' : `每 ${backgroundCheckHours} 小时`}，托盘最小化 ${minimizeToTray ? '开' : '关'}，开机自启 ${openAtLogin ? '开' : '关'}，启动最小化 ${startMinimized ? '开' : '关'}`);
  } catch (err) {
    appendLog('error', 'system', `保存设置失败: ${err.message}`);
  }
}

// ===== 自定义工具模态框 =====
function openModal() {
  clearFormError(modalFormError);
  inputToolName.value = '';
  inputToolPkg.value = '';
  inputToolCmd.value = '';
  inputToolVersionArg.value = '--version';
  modalOverlay.style.display = 'flex';
  inputToolName.focus();
}

function closeModal() {
  clearFormError(modalFormError);
  modalOverlay.style.display = 'none';
}

async function saveCustomTool() {
  const name = inputToolName.value.trim();
  const pkg = inputToolPkg.value.trim();
  const cmd = inputToolCmd.value.trim();
  const versionArg = inputToolVersionArg.value.trim() || '--version';

  if (!name || !pkg || !cmd) {
    showFormError(modalFormError, '请填写完整的工具信息（名称、包名、命令名为必填）');
    return;
  }

  try {
    const result = await window.electronAPI.addCustomTool({ name, pkg, cmd, versionArg });
    if (!result || result.success === false) {
      showFormError(modalFormError, (result && result.message) || '添加自定义工具失败');
      return;
    }
    closeModal();
    appendLog('success', 'system', `自定义工具 "${name}" 已添加，正在刷新...`);
    await checkVersions();
  } catch (err) {
    showFormError(modalFormError, `添加自定义工具失败: ${err.message}`);
  }
}

// ===== 卡片标题与骨架屏模板 =====
function buildToolTitleHtml(tool) {
  const defaultIcon = tool.isCustom ? '🔧' : (tool.name ? tool.name.charAt(0).toUpperCase() : '•');
  const icon = escapeHtml(tool.icon || defaultIcon);
  const customBadge = tool.isCustom ? '<span class="custom-badge">自定义</span>' : '';
  return `<span class="tool-icon" aria-hidden="true">${icon}</span>${escapeHtml(tool.name)} ${customBadge}`;
}

function renderSkeleton(tools) {
  toolsGrid.innerHTML = '';
  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'tool-card animate-in';
    card.dataset.id = tool.id;
    card.innerHTML = `
      <div class="card-progress"></div>
      <div class="tool-card-body">
        <div class="tool-header">
          <h3 class="tool-name">${buildToolTitleHtml(tool)}</h3>
          <span class="tool-status status-not-installed">等待检测</span>
        </div>
        <div class="version-info">
          <div class="version-item">
            <span class="version-label">当前</span>
            <span class="version-value">-</span>
          </div>
          <span class="version-arrow">→</span>
          <div class="version-item">
            <span class="version-label">最新</span>
            <span class="version-value">-</span>
          </div>
        </div>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary btn-sm" disabled>更新</button>
      </div>
    `;
    toolsGrid.appendChild(card);
  }
}

// ===== 工具状态分类（卡片渲染与统计摘要共用，保证口径一致） =====
function classifyTool(tool) {
  if (tool.supported === false) {
    return { rank: 5, statusClass: 'status-unsupported', statusText: '平台不支持', canUpdate: false, canInstall: false, stat: 'unsupported', cardClass: 'card-unsupported' };
  }
  if (tool.notFound) {
    return { rank: 1, statusClass: 'status-not-installed', statusText: '未安装', canUpdate: false, canInstall: true, stat: 'install', cardClass: 'card-not-installed' };
  }
  if (tool.error && !tool.installed) {
    // 命令存在于 PATH 但本地版本执行失败（超时/异常）：单卡允许手动重试更新，但不计入「未安装」以免被「一键安装全部」误重装
    return { rank: 1, statusClass: 'status-error', statusText: '检测失败', canUpdate: true, canInstall: false, stat: 'error', cardClass: 'card-error' };
  }
  if (tool.needsUpdate) {
    return { rank: 0, statusClass: 'status-update', statusText: '可更新', canUpdate: true, canInstall: false, stat: 'update', cardClass: 'card-update' };
  }
  if (tool.installed && tool.isAhead) {
    return { rank: 3, statusClass: 'status-latest', statusText: '本地较新', canUpdate: false, canInstall: false, stat: 'latest', cardClass: 'card-latest' };
  }
  if (tool.installed && tool.latestVersion) {
    return { rank: 4, statusClass: 'status-latest', statusText: '最新', canUpdate: false, canInstall: false, stat: 'latest', cardClass: 'card-latest' };
  }
  if (tool.installed) {
    return { rank: 2, statusClass: 'status-error', statusText: '远端检测失败', canUpdate: true, canInstall: false, stat: 'error', cardClass: 'card-error' };
  }
  return { rank: 1, statusClass: 'status-not-installed', statusText: '未安装', canUpdate: false, canInstall: true, stat: 'install', cardClass: 'card-not-installed' };
}

function buildActionsHtml(tool, cls) {
  const id = escapeHtml(tool.id);
  const busyAction = updatingTools.get(tool.id);
  const locked = (busyAction || isBatchRunning) ? 'disabled' : '';
  const spinner = '<span class="spinner"></span>';

  let actionBtn;
  if (cls.canUpdate) {
    const label = (busyAction === 'update' || busyAction === 'install') ? spinner : '更新';
    actionBtn = `<button class="btn btn-primary btn-update btn-sm" data-id="${id}" ${locked}>${label}</button>`;
  } else if (cls.canInstall) {
    const label = busyAction === 'install' ? spinner : '安装';
    actionBtn = `<button class="btn btn-success btn-install btn-sm" data-id="${id}" ${locked}>${label}</button>`;
  } else if (cls.stat === 'unsupported') {
    actionBtn = `<button class="btn btn-sm" disabled title="当前平台不支持安装 ${escapeHtml(tool.name)}">不支持</button>`;
  } else {
    actionBtn = `<button class="btn btn-primary btn-sm" disabled>已是最新</button>`;
  }

  const uninstallLabel = busyAction === 'uninstall' ? spinner : '卸载';
  const uninstallBtn = tool.installed
    ? `<button class="btn btn-danger-ghost btn-uninstall btn-sm" data-id="${id}" ${locked}>${uninstallLabel}</button>`
    : '';

  const changelogUrl = tool.docsUrl || (tool.pkg ? `https://www.npmjs.com/package/${tool.pkg}` : '');
  const changelogLink = changelogUrl
    ? `<button class="btn btn-ghost btn-sm changelog-link" data-url="${escapeHtml(changelogUrl)}" title="查看 ${escapeHtml(tool.name)} 更新说明" type="button">🔗</button>`
    : '';

  const removeBtn = tool.isCustom
    ? `<button class="btn btn-danger-ghost btn-remove btn-sm" data-id="${id}" ${locked} title="移除此自定义工具">🗑️</button>`
    : '';

  return actionBtn + uninstallBtn + changelogLink + removeBtn;
}

function getToolStates() {
  const ranked = toolsData.map(tool => ({ tool, cls: classifyTool(tool) }));
  const stats = { update: 0, install: 0, latest: 0, error: 0, unsupported: 0 };
  let updateCount = 0;
  let installCount = 0;
  for (const { tool, cls } of ranked) {
    stats[cls.stat]++;
    if (tool.needsUpdate) updateCount++;
    if (cls.canInstall) installCount++;
  }
  return { ranked, stats, updateCount, installCount };
}

/** 统一同步顶部工具栏按钮禁用状态，避免局部刷新误启用按钮 */
function syncToolbarButtons(counts) {
  const { updateCount, installCount } = counts || getToolStates();
  const anyBusy = isChecking || isBatchRunning || updatingTools.size > 0;
  if (btnCheck) btnCheck.disabled = anyBusy;
  if (btnUpdateAll) btnUpdateAll.disabled = anyBusy || updateCount === 0;
  if (btnInstallAll) btnInstallAll.disabled = anyBusy || installCount === 0;
}

// ===== 渲染工具卡片 =====
function renderTools() {
  const animateIn = toolsGrid.childElementCount === 0;
  const scrollTop = toolsGrid.scrollTop;
  toolsGrid.innerHTML = '';

  const { ranked, stats, updateCount, installCount } = getToolStates();
  ranked.sort((a, b) => a.cls.rank - b.cls.rank);

  for (let cardIdx = 0; cardIdx < ranked.length; cardIdx++) {
    const { tool, cls } = ranked[cardIdx];

    if (statsFilter && cls.stat !== statsFilter) continue;

    const isBusy = updatingTools.has(tool.id);
    const card = document.createElement('div');
    card.className = `tool-card ${cls.cardClass}${isBusy ? ' updating' : ''}${animateIn ? ' animate-in' : ''}`;
    card.dataset.id = tool.id;

    const statusClass = isBusy ? 'status-updating' : cls.statusClass;
    const statusText = isBusy ? '执行中' : cls.statusText;
    const latestClass = cls.canUpdate ? 'version-value version-highlight' : 'version-value';

    card.innerHTML = `
      <div class="card-progress"></div>
      <div class="tool-card-body">
        <div class="tool-header">
          <h3 class="tool-name">${buildToolTitleHtml(tool)}</h3>
          <span class="tool-status ${statusClass}">${statusText}</span>
        </div>
        <div class="version-info">
          <div class="version-item">
            <span class="version-label">当前</span>
            <span class="version-value" title="${escapeHtml(tool.currentVersion || '')}">${escapeHtml(tool.currentVersion || '-')}</span>
          </div>
          <span class="version-arrow">→</span>
          <div class="version-item">
            <span class="version-label">最新</span>
            <span class="${latestClass}" title="${escapeHtml(tool.latestVersion || '')}">${escapeHtml(tool.latestVersion || '-')}</span>
          </div>
        </div>
      </div>
      <div class="tool-actions">${buildActionsHtml(tool, cls)}</div>
    `;

    toolsGrid.appendChild(card);
    if (animateIn) card.style.animationDelay = `${cardIdx * 30}ms`;
  }

  syncToolbarButtons({ updateCount, installCount });
  updateStatsBar(stats);
  updateLogToolFilter();

  if (!animateIn) toolsGrid.scrollTop = scrollTop;
}

// ===== 统计摘要条 =====
function updateStatsBar(stats) {
  const bar = document.getElementById('stats-bar');
  if (!bar) return;
  if (!toolsData.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  document.getElementById('stat-update').textContent = stats.update;
  document.getElementById('stat-install').textContent = stats.install;
  document.getElementById('stat-latest').textContent = stats.latest;
  document.getElementById('stat-error').textContent = stats.error;
  const statUnsupported = document.getElementById('stat-unsupported');
  if (statUnsupported) statUnsupported.textContent = stats.unsupported || 0;

  const chips = bar.querySelectorAll('.stat-chip[data-filter]');
  chips.forEach(chip => {
    const active = statsFilter === chip.dataset.filter;
    chip.classList.toggle('stat-chip-active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  clampLogPanelHeight();
}

// ===== 检测版本 =====
async function checkVersions() {
  if (isChecking) return;
  isChecking = true;
  statsFilter = null;
  syncToolbarButtons();
  btnCheck.innerHTML = '<span class="icon">⏳</span> 检测中...';
  appendLog('info', 'system', '开始检测所有工具版本...');

  try {
    const response = await window.electronAPI.checkVersions();
    if (!response || response.runId !== latestCheckRunId) return;
    for (const item of response.results || []) {
      mergeToolResult(item);
    }
    isChecking = false;
    renderTools();
    appendLog('success', 'system', '版本检测完成');
  } catch (err) {
    appendLog('error', 'system', `检测失败: ${err.message}`);
  } finally {
    isChecking = false;
    btnCheck.innerHTML = '<span class="icon">🔍</span> 检测版本';
    syncToolbarButtons();
  }
}

function onSingleToolChecked(result) {
  if (!mergeToolResult(result)) return;
  updateSingleCard(result);
}

// ===== 工具级执行锁辅助 =====
function setToolBusy(toolId, actionType) {
  updatingTools.set(toolId, actionType);
  syncToolbarButtons();

  const card = toolsGrid.querySelector(`.tool-card[data-id="${CSS.escape(toolId)}"]`);
  if (!card) return;
  card.classList.add('updating');
  const status = card.querySelector('.tool-status');
  if (status) {
    status.className = 'tool-status status-updating';
    status.textContent = '执行中';
  }
  const targetSelector = actionType === 'uninstall' ? '.btn-uninstall' : '.btn-update, .btn-install';
  const actionBtn = card.querySelector(targetSelector);
  if (actionBtn) {
    actionBtn.innerHTML = '<span class="spinner"></span>';
  }
  card.querySelectorAll('.btn-update, .btn-install, .btn-uninstall, .btn-remove').forEach(btn => {
    btn.disabled = true;
  });
}

function clearToolBusy(toolId) {
  updatingTools.delete(toolId);
  syncToolbarButtons();
}

// ===== 更新单个工具 =====
async function updateTool(toolId) {
  if (updatingTools.has(toolId) || isBatchRunning) return;
  setToolBusy(toolId, 'update');

  try {
    await window.electronAPI.updateTool(toolId);
    await refreshSingleTool(toolId, { rerender: false });
  } catch (err) {
    appendLog('error', toolId, `更新异常: ${err.message}`);
  } finally {
    clearToolBusy(toolId);
    renderTools();
  }
}

// ===== 安装单个工具 =====
async function installTool(toolId) {
  if (updatingTools.has(toolId) || isBatchRunning) return;
  setToolBusy(toolId, 'install');

  try {
    await window.electronAPI.installTool(toolId);
    await refreshSingleTool(toolId, { rerender: false });
  } catch (err) {
    appendLog('error', toolId, `安装异常: ${err.message}`);
  } finally {
    clearToolBusy(toolId);
    renderTools();
  }
}

// ===== 一键配置 agyyolo 到 PowerShell Profile =====
async function installAgyyolo() {
  try {
    btnInstallAgyyolo.disabled = true;
    appendLog('start', 'system', '正在检测 agy 是否安装 ...');
    const result = await window.electronAPI.installAgyyolo();
    if (result && result.cancelled) {
      appendLog('info', 'system', result.message || '已取消，未修改 Profile。');
    }
    // 成功/失败逐项详情与汇总已由主进程通过 sendLog 流式推送，此处不再重复打印
  } catch (err) {
    appendLog('error', 'system', `配置 agyyolo 异常: ${err.message}`);
  } finally {
    btnInstallAgyyolo.disabled = false;
  }
}

async function removeAgyyolo() {
  try {
    btnRemoveAgyyolo.disabled = true;
    const result = await window.electronAPI.removeAgyyolo();
    if (result && result.cancelled) {
      appendLog('info', 'system', result.message || '已取消，未修改 Profile。');
    }
  } catch (err) {
    appendLog('error', 'system', `撤销 agyyolo 配置异常: ${err.message}`);
  } finally {
    btnRemoveAgyyolo.disabled = false;
  }
}

async function openPowerShell() {
  const termName = window.electronAPI.platform === 'win32' ? 'PowerShell' : '终端';
  try {
    appendLog('info', 'system', `正在打开${termName}窗口...`);
    const result = await window.electronAPI.openPowerShell();
    if (result.success) {
      appendLog('success', 'system', `${termName}窗口已成功打开`);
    } else {
      appendLog('error', 'system', `打开${termName}失败: ${result.error}`);
    }
  } catch (err) {
    appendLog('error', 'system', `打开${termName}异常: ${err.message}`);
  }
}

// ===== 卸载单个工具 =====
async function uninstallTool(toolId) {
  if (updatingTools.has(toolId) || isBatchRunning) return;
  const tool = toolsData.find(t => t.id === toolId) || {};
  const name = tool.name || getToolName(toolId);
  const safeName = escapeHtml(name);

  let detail;
  if (!tool.installScript) {
    detail = `将卸载 <b>${safeName}</b>，其全局安装的 npm 包会被移除。`;
  } else if (tool.uninstallKeepsData) {
    detail = `将卸载 <b>${safeName}</b>，其本地数据（如配置与会话记录）会被保留。`;
  } else {
    detail = `将按官方指引卸载 <b>${safeName}</b>，本地数据默认保留。`;
  }
  const confirmed = await showConfirmModal(
    `确定卸载 ${name}？`,
    detail,
    '卸载',
    'danger'
  );
  if (!confirmed) return;

  setToolBusy(toolId, 'uninstall');

  try {
    const result = await window.electronAPI.uninstallTool(toolId);
    if (!result.success && result.docsUrl) {
      const msgDetail = result.message
        ? `<br><small style="color:var(--text-muted)">${escapeHtml(result.message)}</small>`
        : '';
      const goDoc = await showConfirmModal(
        `${name} 需手动卸载`,
        `自动卸载失败，是否打开官方文档按指引手动卸载？${msgDetail}<br><small style="color:var(--text-muted)">${escapeHtml(result.docsUrl)}</small>`,
        '打开官方文档',
        'primary'
      );
      if (goDoc) await window.electronAPI.openExternal(result.docsUrl);
    }
    await refreshSingleTool(toolId, { rerender: false });
  } catch (err) {
    appendLog('error', toolId, `卸载异常: ${err.message}`);
  } finally {
    clearToolBusy(toolId);
    renderTools();
  }
}

// ===== 移除自定义工具 =====
async function removeCustomTool(toolId) {
  const name = getToolName(toolId);
  const confirmed = await showConfirmModal(
    '移除自定义工具',
    `确定要从列表中移除「${escapeHtml(name)}」吗？<br><small style="color:var(--text-muted)">不会卸载已安装的 npm 包</small>`,
    '移除',
    'danger'
  );
  if (!confirmed) return;
  try {
    await window.electronAPI.removeCustomTool(toolId);
    appendLog('info', 'system', `自定义工具 "${name}" 已移除`);
    toolsData = toolsData.filter(t => t.id !== toolId);
    renderTools();
  } catch (err) {
    appendLog('error', 'system', `移除失败: ${err.message}`);
  }
}

// ===== 一键更新全部 =====
async function updateAll() {
  const ids = toolsData.filter(t => t.needsUpdate).map(t => t.id);
  await runBatch(ids, btnUpdateAll, window.electronAPI.updateTool, {
    verb: '更新', actionType: 'update', idleHtml: '<span class="icon">🚀</span> 一键更新全部'
  });
}

// ===== 一键安装全部未安装工具 =====
async function installAll() {
  // 仅批量安装明确未安装（notFound）且当前平台支持的工具，避免误重装检测异常的已装工具
  const ids = toolsData.filter(t => classifyTool(t).canInstall).map(t => t.id);
  await runBatch(ids, btnInstallAll, window.electronAPI.installTool, {
    verb: '安装', actionType: 'install', idleHtml: '<span class="icon">📦</span> 一键安装全部'
  });
}

async function runBatch(ids, button, action, { verb, actionType, idleHtml }) {
  if (ids.length === 0 || isBatchRunning || updatingTools.size > 0) return;

  isBatchRunning = true;
  syncToolbarButtons();
  // 锁定所有卡片操作按钮，避免批量执行期间插入其它操作
  toolsGrid.querySelectorAll('.btn-update, .btn-install, .btn-uninstall, .btn-remove').forEach(btn => {
    btn.disabled = true;
  });
  appendLog('start', 'system', `开始一键${verb} ${ids.length} 个工具...`);

  try {
    for (let i = 0; i < ids.length; i++) {
      const toolId = ids[i];
      button.innerHTML = `<span class="icon">⏳</span> ${verb}中 (${i + 1}/${ids.length})`;
      setToolBusy(toolId, actionType);
      try {
        await action(toolId);
      } catch (err) {
        appendLog('error', toolId, `${verb}异常: ${err.message}`);
      } finally {
        clearToolBusy(toolId);
      }
      await refreshSingleTool(toolId, { rerender: false });
    }
    appendLog('success', 'system', `全部${verb}任务执行完毕`);
  } finally {
    isBatchRunning = false;
    button.innerHTML = idleHtml;
    renderTools();
  }
}

// ===== 刷新单个工具 =====
async function refreshSingleTool(toolId, { rerender = true } = {}) {
  try {
    const updated = await window.electronAPI.checkVersion(toolId);
    if (!updated || !updated.id) return;
    if (!mergeToolResult(updated)) return;
    updateSingleCard(toolsData.find(t => t.id === toolId) || updated);
    if (rerender) renderTools();
  } catch (err) {
    appendLog('error', toolId, `刷新版本失败: ${err.message}`);
  }
}

// ===== 日志相关 =====
function clearLog() {
  logEntries.length = 0;
  renderLogs();
}

function appendLog(type, toolId, message, time) {
  if (!message || message.trim() === '') return;

  const stamp = time || new Date().toLocaleTimeString();
  const lines = message.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return;

  const stickToBottom = isLogScrolledToBottom();

  const fragment = document.createDocumentFragment();
  let added = 0;
  for (const line of lines) {
    const entry = { type, toolId, message: line, time: stamp };
    logEntries.push(entry);
    if (logMatchesFilters(entry)) {
      fragment.appendChild(buildLogLine(entry));
      added++;
    }
  }

  let dropped = 0;
  if (logEntries.length > MAX_LOG_ENTRIES) {
    const removed = logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
    dropped = removed.filter(logMatchesFilters).length;
  }

  if (added === 0 && dropped === 0) return;

  if (visibleLogCount === 0 && added > 0) logContainer.innerHTML = '';
  for (let i = 0; i < dropped && logContainer.firstChild; i++) {
    logContainer.removeChild(logContainer.firstChild);
  }
  if (added > 0) logContainer.appendChild(fragment);
  visibleLogCount = visibleLogCount - dropped + added;

  if (visibleLogCount === 0) {
    renderLogEmptyState();
    return;
  }
  if (stickToBottom) logContainer.scrollTop = logContainer.scrollHeight;
}

function logMatchesFilters(entry) {
  if (logFilters.level && entry.type !== logFilters.level) return false;
  if (logFilters.tool && entry.toolId !== logFilters.tool) return false;
  const keyword = logFilters.keyword.toLowerCase();
  if (keyword && !entry.message.toLowerCase().includes(keyword)) return false;
  return true;
}

function isLogScrolledToBottom() {
  return logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 40;
}

function renderLogEmptyState() {
  logContainer.innerHTML = `<div class="log-empty">${logEntries.length === 0 ? '点击「检测版本」开始' : '没有匹配过滤条件的日志'}</div>`;
}

function renderLogs() {
  const fragment = document.createDocumentFragment();
  visibleLogCount = 0;

  for (const entry of logEntries) {
    if (!logMatchesFilters(entry)) continue;
    fragment.appendChild(buildLogLine(entry));
    visibleLogCount++;
  }

  logContainer.innerHTML = '';
  if (visibleLogCount === 0) {
    renderLogEmptyState();
    return;
  }
  logContainer.appendChild(fragment);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function buildLogLine(entry) {
  const div = document.createElement('div');
  div.className = `log-line log-${entry.type}`;
  const toolName = entry.toolId === 'system' ? 'SYSTEM' : getToolName(entry.toolId);
  div.innerHTML = `
    <span class="log-time">[${entry.time}]</span>
    <span class="log-tool">${escapeHtml(toolName)}</span>
    <span class="log-message">${escapeHtml(entry.message)}</span>
  `;
  return div;
}

function updateLogToolFilter() {
  if (!logFilterTool) return;
  const current = logFilterTool.value;
  logFilterTool.innerHTML = '<option value="">全部工具</option><option value="system">SYSTEM</option>';
  for (const t of toolsData) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    logFilterTool.appendChild(opt);
  }
  logFilterTool.value = current;
  if (logFilterTool.value !== current) {
    logFilters.tool = '';
  }
}

function getLogText() {
  return logEntries.map(e => {
    const toolName = e.toolId === 'system' ? 'SYSTEM' : getToolName(e.toolId);
    return `[${e.time}] ${toolName} ${e.message}`;
  }).join('\n');
}

async function copyLog() {
  const text = getLogText();
  if (!text) {
    appendLog('info', 'system', '当前没有日志可复制');
    return;
  }
  try {
    await window.electronAPI.copyToClipboard(text);
    appendLog('success', 'system', '日志已复制到剪贴板');
  } catch (err) {
    appendLog('error', 'system', `复制失败: ${err.message}`);
  }
}

async function exportLog() {
  const text = getLogText();
  if (!text) {
    appendLog('info', 'system', '当前没有日志可导出');
    return;
  }
  try {
    const result = await window.electronAPI.exportLog(text);
    if (result && result.cancelled) {
      appendLog('info', 'system', '已取消导出日志');
    }
  } catch (err) {
    appendLog('error', 'system', `导出失败: ${err.message}`);
  }
}

// ===== 导出全部工具版本报告 =====
async function exportVersionReport() {
  if (!toolsData.length) {
    appendLog('info', 'system', '请先点击「检测版本」再导出');
    return;
  }
  const registryName = selectRegistry.selectedOptions[0] ? selectRegistry.selectedOptions[0].textContent : '未知';
  const lines = [
    '# AI 工具版本报告',
    '',
    `- 生成时间: ${new Date().toLocaleString()}`,
    `- 操作系统: ${envOs.textContent || '未知'}`,
    `- 镜像源: ${registryName}`,
    '',
    '| 工具 | 状态 | 当前版本 | 最新版本 |',
    '|---|---|---|---|',
  ];
  for (const t of toolsData) {
    const cls = classifyTool(t);
    const esc = (v) => String(v || '-').replace(/\|/g, '\\|');
    lines.push(`| ${esc(t.name)} | ${cls.statusText} | ${esc(t.currentVersion)} | ${esc(t.latestVersion)} |`);
  }
  try {
    const result = await window.electronAPI.exportReport({
      text: lines.join('\n'),
      defaultName: `ai-tools-report-${new Date().toISOString().slice(0, 10)}.md`
    });
    if (result && result.cancelled) appendLog('info', 'system', '已取消导出版本报告');
  } catch (err) {
    appendLog('error', 'system', `导出报告失败: ${err.message}`);
  }
}

// ===== 工具函数 =====
function getToolName(toolId) {
  const tool = toolsData.find(t => t.id === toolId);
  return tool ? tool.name : toolId.toUpperCase();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== 流式检测：局部更新单张卡片 =====
function updateSingleCard(tool) {
  const existing = toolsGrid.querySelector(`.tool-card[data-id="${CSS.escape(tool.id)}"]`);
  if (!existing) {
    renderTools();
    return;
  }
  const cls = classifyTool(tool);
  const isBusy = updatingTools.has(tool.id);

  const nameEl = existing.querySelector('.tool-name');
  if (nameEl) {
    nameEl.innerHTML = buildToolTitleHtml(tool);
  }

  const statusEl = existing.querySelector('.tool-status');
  if (statusEl) {
    statusEl.className = `tool-status ${isBusy ? 'status-updating' : cls.statusClass}`;
    statusEl.textContent = isBusy ? '执行中' : cls.statusText;
  }

  const keepAnim = existing.classList.contains('animate-in') ? ' animate-in' : '';
  existing.className = `tool-card ${cls.cardClass}${isBusy ? ' updating' : ''}${keepAnim}`;

  const versionValues = existing.querySelectorAll('.version-value');
  if (versionValues.length >= 2) {
    versionValues[0].textContent = tool.currentVersion || '-';
    versionValues[0].title = tool.currentVersion || '';
    versionValues[1].className = cls.canUpdate ? 'version-value version-highlight' : 'version-value';
    versionValues[1].textContent = tool.latestVersion || '-';
    versionValues[1].title = tool.latestVersion || '';
  }

  const actionsEl = existing.querySelector('.tool-actions');
  if (actionsEl) {
    actionsEl.innerHTML = buildActionsHtml(tool, cls);
  }

  const { stats, updateCount, installCount } = getToolStates();
  updateStatsBar(stats);
  syncToolbarButtons({ updateCount, installCount });
}

// ===== 高亮并滚动到指定工具卡片（通知点击后定位） =====
function highlightToolCard(toolId) {
  if (!toolId) return;
  let card = toolsGrid.querySelector(`.tool-card[data-id="${CSS.escape(toolId)}"]`);
  // 若当前处于过滤视图且目标卡片被隐藏，自动解除过滤以确保定位可见
  if (!card && statsFilter) {
    statsFilter = null;
    renderTools();
    card = toolsGrid.querySelector(`.tool-card[data-id="${CSS.escape(toolId)}"]`);
  }
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card.classList.add('card-highlighted');
  card.addEventListener('animationend', () => {
    card.classList.remove('card-highlighted');
  }, { once: true });
}

// ===== 自定义确认弹框 =====
function showConfirmModal(title, message, confirmText = '确认', confirmVariant = 'primary') {
  return new Promise((resolve) => {
    const overlay   = document.getElementById('confirm-overlay');
    const titleEl   = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const btnOk     = document.getElementById('btn-confirm-ok');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    const btnClose  = document.getElementById('btn-confirm-close');

    if (!overlay) {
      resolve(window.confirm(`${title}\n${message.replace(/<[^>]*>/g, '')}`));
      return;
    }

    titleEl.textContent  = title;
    messageEl.innerHTML  = message;
    btnOk.textContent    = confirmText;
    btnOk.className      = `btn ${confirmVariant === 'danger' ? 'btn-danger-solid' : 'btn-primary'}`;
    overlay.style.display = 'flex';

    const cleanup = (result) => {
      overlay.style.display = 'none';
      btnOk.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      btnClose.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel  = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };
    const onKeydown = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') {
        if (e.target instanceof HTMLButtonElement && overlay.contains(e.target)) return;
        cleanup(true);
      }
    };

    btnOk.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKeydown);

    (confirmVariant === 'danger' ? btnCancel : btnOk).focus();
  });
}

// ===== Stats 栏点击过滤绑定 =====
(function bindStatsFilter() {
  const bar = document.getElementById('stats-bar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.stat-chip[data-filter]');
    if (!chip) return;
    const filter = chip.dataset.filter;
    statsFilter = (statsFilter === filter) ? null : filter;
    renderTools();
  });
})();

// ===== 镜像源测速（含用户当前自定义镜像源） =====
async function measureAllRegistries() {
  const [presets, current] = await Promise.all([
    window.electronAPI.getRegistries(),
    window.electronAPI.getCurrentRegistry()
  ]);
  const targets = [...presets];
  if (current && !presets.some(r => r.url === current)) {
    targets.push({ name: `自定义: ${current}`, url: current });
  }
  return Promise.all(
    targets.map(async (reg) => {
      const res = await window.electronAPI.pingRegistry(reg.url);
      return { name: reg.name, url: reg.url, ...res };
    })
  );
}

async function pingAllRegistries() {
  const speedResults = document.getElementById('registry-speed-results');
  if (!speedResults) return;
  const btnPing = document.getElementById('btn-ping-registry');
  if (btnPing) { btnPing.disabled = true; btnPing.textContent = '测速中...'; }

  speedResults.style.display = 'block';
  speedResults.innerHTML = '<div class="ping-loading">正在测速，请稍候...</div>';

  try {
    const results = await measureAllRegistries();

    speedResults.innerHTML = results.map(r => {
      const ms = r.ms != null ? `${r.ms}ms` : '—';
      const level = r.success && r.ms < 300 ? 'fast' : r.success && r.ms < 1000 ? 'medium' : 'slow';
      const icon = r.success ? (level === 'fast' ? '🟢' : level === 'medium' ? '🟡' : '🔴') : '❌';
      return `<div class="ping-row">
        <span class="ping-icon">${icon}</span>
        <span class="ping-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        <span class="ping-ms ping-${level}">${r.success ? ms : escapeHtml(r.message || '超时')}</span>
      </div>`;
    }).join('');
  } catch (err) {
    speedResults.innerHTML = `<div class="ping-error">测速失败: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btnPing) { btnPing.disabled = false; btnPing.textContent = '🚀 测速'; }
  }
}

async function autoSelectFastestRegistry() {
  const btnAuto = document.getElementById('btn-auto-registry');
  if (btnAuto) { btnAuto.disabled = true; btnAuto.textContent = '选择中...'; }
  try {
    const results = await measureAllRegistries();
    const fastest = results.filter(r => r.success).sort((a, b) => a.ms - b.ms)[0];
    if (!fastest) {
      appendLog('error', 'system', '所有镜像源测速失败，无法自动选择');
      return;
    }
    const result = await window.electronAPI.setRegistry(fastest.url);
    if (!result.success) {
      appendLog('error', 'system', result.message || '切换镜像源失败');
      return;
    }
    await loadRegistries();
    appendLog('success', 'system', `已自动切换到最快镜像源: ${fastest.name} (${fastest.ms}ms)`);
  } catch (err) {
    appendLog('error', 'system', `自动选择镜像源失败: ${err.message}`);
  } finally {
    if (btnAuto) { btnAuto.disabled = false; btnAuto.textContent = '⚡ 自动选最快'; }
  }
}

// ===== 启动 =====
init();
