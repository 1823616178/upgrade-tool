// ===== 状态变量 =====
let toolsData = [];
let isChecking = false;
let isUpdating = false;
/** 切换到「自定义源」前，记住当前选中的镜像源，取消时可恢复 */
let previousRegistryUrl = '';

// ===== 日志数据（过滤视图的数据源；复制/导出始终作用于全部条目） =====
const MAX_LOG_ENTRIES = 2000; // 上限，防止长时间运行内存无限增长
const logEntries = [];
const logFilters = { level: '', tool: '', keyword: '' };

// ===== DOM 元素 =====
const toolsGrid = document.getElementById('tools-grid');
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
const btnOpenPowerShell = document.getElementById('btn-open-powershell');
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

// 设置模态框
const settingsOverlay = document.getElementById('settings-overlay');
const btnSettingsClose = document.getElementById('btn-settings-close');
const btnSettingsCancel = document.getElementById('btn-settings-cancel');
const btnSettingsSave = document.getElementById('btn-settings-save');
const selectBgCheck = document.getElementById('select-bg-check');
const checkMinimizeTray = document.getElementById('check-minimize-tray');
const checkOpenAtLogin = document.getElementById('check-open-at-login');

// 自定义镜像源模态框
const registryOverlay = document.getElementById('registry-overlay');
const btnRegistryClose = document.getElementById('btn-registry-close');
const btnRegistryCancel = document.getElementById('btn-registry-cancel');
const btnRegistrySave = document.getElementById('btn-registry-save');
const inputRegistryUrl = document.getElementById('input-registry-url');

// ===== 初始化 =====
async function init() {
  bindEvents();
  bindLogListener();

  // 并行执行：环境检测、镜像源加载、骨架屏渲染（基于真实工具列表，含自定义工具）
  await Promise.all([
    checkEnvironment(),
    loadRegistries(),
    renderSkeletonFromTools()
  ]);

  // 启动时自动检测一次
  await checkVersions();
}

/** 从主进程获取真实工具列表并渲染骨架屏（内置 + 自定义，数量与名称始终同步） */
async function renderSkeletonFromTools() {
  try {
    const tools = await window.electronAPI.getTools();
    renderSkeleton(tools);
  } catch (err) {
    appendLog('error', 'system', `加载工具列表失败: ${err.message}`);
    renderSkeleton([]);
  }
}

// ===== 事件绑定 =====
function bindEvents() {
  btnCheck.addEventListener('click', checkVersions);
  btnUpdateAll.addEventListener('click', updateAll);
  btnInstallAll.addEventListener('click', installAll);
  btnAdmin.addEventListener('click', () => window.electronAPI.showAdminTip());
  btnInstallAgyyolo.addEventListener('click', installAgyyolo);
  btnOpenPowerShell.addEventListener('click', openPowerShell);
  btnClearLog.addEventListener('click', clearLog);
  btnCopyLog.addEventListener('click', copyLog);
  btnExportLog.addEventListener('click', exportLog);
  btnAddTool.addEventListener('click', openModal);
  btnSettings.addEventListener('click', openSettings);
  btnDismissEnv.addEventListener('click', () => { envBanner.style.display = 'none'; });

  // 镜像源切换（含自定义源弹窗）
  selectRegistry.addEventListener('change', onRegistryChange);

  // 自定义工具模态框
  btnModalClose.addEventListener('click', closeModal);
  btnModalCancel.addEventListener('click', closeModal);
  btnModalSave.addEventListener('click', saveCustomTool);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // 设置模态框
  btnSettingsClose.addEventListener('click', closeSettings);
  btnSettingsCancel.addEventListener('click', closeSettings);
  btnSettingsSave.addEventListener('click', saveSettingsFromUI);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  // 自定义镜像源模态框
  btnRegistryClose.addEventListener('click', cancelCustomRegistry);
  btnRegistryCancel.addEventListener('click', cancelCustomRegistry);
  btnRegistrySave.addEventListener('click', saveCustomRegistry);
  registryOverlay.addEventListener('click', (e) => {
    if (e.target === registryOverlay) cancelCustomRegistry();
  });

  // 日志过滤
  logFilterLevel.addEventListener('change', () => { logFilters.level = logFilterLevel.value; renderLogs(); });
  logFilterTool.addEventListener('change', () => { logFilters.tool = logFilterTool.value; renderLogs(); });
  logSearch.addEventListener('input', () => { logFilters.keyword = logSearch.value; renderLogs(); });

  // Esc 关闭任意打开的模态框
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalOverlay.style.display === 'flex') closeModal();
    else if (settingsOverlay.style.display === 'flex') closeSettings();
    else if (registryOverlay.style.display === 'flex') cancelCustomRegistry();
  });
}

function bindLogListener() {
  window.electronAPI.removeAllLogListeners();
  window.electronAPI.onUpdateLog((data) => {
    appendLog(data.type, data.toolId, data.message, data.time);
  });
  // 监听托盘菜单发出的检测命令
  window.electronAPI.onTriggerCheck(() => {
    checkVersions();
  });
}

// ===== 环境健康检测 =====
async function checkEnvironment() {
  try {
    const env = await window.electronAPI.checkEnvironment();

    // 展示环境信息到 footer
    if (envNode) envNode.textContent = `Node: ${env.node || '未安装'}`;
    if (envNpm) envNpm.textContent = `npm: ${env.npm || '未安装'}`;
    if (envOs) envOs.textContent = env.os || 'OS: 未知';

    // 如果有错误，显示警告横幅 + Node 下载链接
    if (env.errors && env.errors.length > 0) {
      envBanner.style.display = 'flex';
      envBannerText.textContent = env.errors.join(' | ');

      // 移除旧链接，避免重复添加
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

    // 添加「自定义源…」入口（始终 value 为 __custom__）
    const customEntry = document.createElement('option');
    customEntry.value = '__custom__';
    customEntry.textContent = '自定义源...';
    selectRegistry.appendChild(customEntry);

    // 当前源不在预设中：额外展示一条当前自定义源
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
  registryOverlay.style.display = 'none';
  // 恢复到切换前的源
  loadRegistries();
}

async function saveCustomRegistry() {
  const url = inputRegistryUrl.value.trim();
  if (!url) {
    appendLog('error', 'system', '请输入镜像源 URL');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    appendLog('error', 'system', '镜像源 URL 必须以 http:// 或 https:// 开头');
    return;
  }
  try {
    const result = await window.electronAPI.setRegistry(url);
    if (!result.success) {
      appendLog('error', 'system', result.message || '镜像源切换失败');
      return;
    }
    registryOverlay.style.display = 'none';
    previousRegistryUrl = result.registry || url;
    await loadRegistries();
    appendLog('success', 'system', `已使用自定义镜像源: ${previousRegistryUrl}`);
  } catch (err) {
    appendLog('error', 'system', `镜像源切换失败: ${err.message}`);
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
    await window.electronAPI.saveSettings({ backgroundCheckHours, minimizeToTray, openAtLogin });
    closeSettings();
    appendLog('success', 'system', `设置已保存：后台检测 ${backgroundCheckHours === 0 ? '已关闭' : `每 ${backgroundCheckHours} 小时`}，托盘最小化 ${minimizeToTray ? '开' : '关'}，开机自启 ${openAtLogin ? '开' : '关'}`);
  } catch (err) {
    appendLog('error', 'system', `保存设置失败: ${err.message}`);
  }
}

// ===== 自定义工具模态框 =====
function openModal() {
  inputToolName.value = '';
  inputToolPkg.value = '';
  inputToolCmd.value = '';
  inputToolVersionArg.value = '--version';
  modalOverlay.style.display = 'flex';
  inputToolName.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
}

async function saveCustomTool() {
  const name = inputToolName.value.trim();
  const pkg = inputToolPkg.value.trim();
  const cmd = inputToolCmd.value.trim();
  const versionArg = inputToolVersionArg.value.trim() || '--version';

  if (!name || !pkg || !cmd) {
    appendLog('error', 'system', '请填写完整的工具信息（名称、包名、命令名为必填）');
    return;
  }

  try {
    const result = await window.electronAPI.addCustomTool({ name, pkg, cmd, versionArg });
    if (!result || result.success === false) {
      appendLog('error', 'system', (result && result.message) || '添加自定义工具失败');
      return;
    }
    closeModal();
    appendLog('success', 'system', `自定义工具 "${name}" 已添加，正在刷新...`);
    await checkVersions();
  } catch (err) {
    appendLog('error', 'system', `添加自定义工具失败: ${err.message}`);
  }
}

// ===== 渲染骨架屏（按真实工具列表） =====
function renderSkeleton(tools) {
  toolsGrid.innerHTML = '';
  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
      <div class="tool-header">
        <h3 class="tool-name">${escapeHtml(tool.name)}</h3>
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
      <div class="tool-actions">
        <button class="btn btn-primary btn-sm" disabled>更新</button>
      </div>
    `;
    toolsGrid.appendChild(card);
  }
}

// ===== 工具状态分类（卡片渲染与统计摘要共用，保证口径一致） =====
// rank 用于排序：可更新(0) → 未安装/检测失败(1) → 远端检测失败(2) → 本地较新(3) → 最新(4)
// stat 用于统计条口径：与卡片状态徽章一一对应（"本地较新"计入 latest）
function classifyTool(tool) {
  if (tool.notFound) {
    return { rank: 1, statusClass: 'status-not-installed', statusText: '未安装', canUpdate: false, canInstall: true, stat: 'install', cardClass: 'card-not-installed' };
  }
  if (tool.error && !tool.installed) {
    return { rank: 1, statusClass: 'status-error', statusText: '检测失败', canUpdate: false, canInstall: true, stat: 'error', cardClass: 'card-error' };
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

// ===== 渲染工具卡片 =====
function renderTools() {
  toolsGrid.innerHTML = '';
  let updateCount = 0;
  let installCount = 0;
  const stats = { update: 0, install: 0, latest: 0, error: 0 };

  // 按状态排序（稳定排序，同类内保持原顺序）
  const sorted = [...toolsData].sort((a, b) => classifyTool(a).rank - classifyTool(b).rank);

  for (const tool of sorted) {
    const cls = classifyTool(tool);
    stats[cls.stat]++;
    if (cls.canUpdate) updateCount++;
    if (cls.canInstall) installCount++;

    const card = document.createElement('div');
    card.className = `tool-card ${cls.cardClass}`;
    card.dataset.id = tool.id;

    // 动作按钮：更新 / 安装 / 禁用
    let actionBtn = '';
    if (cls.canUpdate) {
      actionBtn = `<button class="btn btn-primary btn-update btn-sm" data-id="${escapeHtml(tool.id)}" ${isUpdating ? 'disabled' : ''}>更新</button>`;
    } else if (cls.canInstall) {
      actionBtn = `<button class="btn btn-success btn-install btn-sm" data-id="${escapeHtml(tool.id)}" ${isUpdating ? 'disabled' : ''}>安装</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-sm" disabled>已是最新</button>`;
    }

    // 已安装的工具附加卸载按钮
    let uninstallBtn = '';
    if (tool.installed) {
      uninstallBtn = `<button class="btn btn-danger-ghost btn-uninstall btn-sm" data-id="${escapeHtml(tool.id)}" ${isUpdating ? 'disabled' : ''}>卸载</button>`;
    }

    // 自定义工具附加删除按钮
    let removeBtn = '';
    if (tool.isCustom) {
      removeBtn = `<button class="btn btn-danger-ghost btn-remove btn-sm" data-id="${escapeHtml(tool.id)}" title="移除此自定义工具">🗑️</button>`;
    }

    // 自定义工具标识
    const customBadge = tool.isCustom ? '<span class="custom-badge">自定义</span>' : '';

    // 可更新时"最新"版本号高亮
    const latestClass = cls.canUpdate ? 'version-value version-highlight' : 'version-value';

    // changelog 入口：脚本安装工具用官网，npm 工具指向 npmjs 包页
    const changelogUrl = tool.docsUrl || (tool.pkg ? `https://www.npmjs.com/package/${tool.pkg}` : '');
    const changelogLink = changelogUrl
      ? `<button class="btn btn-ghost btn-sm changelog-link" data-url="${escapeHtml(changelogUrl)}" title="查看 ${escapeHtml(tool.name)} 更新说明" type="button">🔗</button>`
      : '';

    card.innerHTML = `
      <div class="card-progress"></div>
      <div class="tool-header">
        <h3 class="tool-name">${escapeHtml(tool.name)} ${customBadge}</h3>
        <span class="tool-status ${cls.statusClass}">${cls.statusText}</span>
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
      <div class="tool-actions">
        ${actionBtn}
        ${uninstallBtn}
        ${changelogLink}
        ${removeBtn}
      </div>
    `;

    toolsGrid.appendChild(card);
    // 入场动画逐张延迟
    card.style.animationDelay = `${sorted.indexOf(tool) * 30}ms`;
  }

  // 绑定更新按钮
  document.querySelectorAll('.btn-update').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      updateTool(id);
    });
  });

  // 绑定安装按钮
  document.querySelectorAll('.btn-install').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      installTool(id);
    });
  });

  // 绑定卸载按钮
  document.querySelectorAll('.btn-uninstall').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      uninstallTool(id);
    });
  });

  // 绑定删除按钮
  document.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      removeCustomTool(id);
    });
  });

  // 绑定 changelog 链接
  document.querySelectorAll('.changelog-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = e.currentTarget.dataset.url;
      if (url) window.electronAPI.openExternal(url);
    });
  });

  btnUpdateAll.disabled = updateCount === 0 || isUpdating;
  // 当有未安装工具且不在更新状态时，启用一键安装
  if (btnInstallAll) btnInstallAll.disabled = installCount === 0 || isUpdating;

  updateStatsBar(stats);
  updateLogToolFilter();
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
}

// ===== 检测版本 =====
async function checkVersions() {
  if (isChecking) return;
  isChecking = true;
  btnCheck.disabled = true;
  btnCheck.innerHTML = '<span class="icon">⏳</span> 检测中...';
  // 不再自动清空日志，方便对照历史输出；需要清空请点「清空」
  appendLog('info', 'system', '开始检测所有工具版本...');

  try {
    toolsData = await window.electronAPI.checkVersions();
    renderTools();
    appendLog('success', 'system', '版本检测完成');
  } catch (err) {
    appendLog('error', 'system', `检测失败: ${err.message}`);
  } finally {
    isChecking = false;
    btnCheck.disabled = false;
    btnCheck.innerHTML = '<span class="icon">🔍</span> 检测版本';
  }
}

// ===== 更新单个工具 =====
async function updateTool(toolId) {
  if (isUpdating) return;
  isUpdating = true;
  updateUIState(true, toolId);

  try {
    appendLog('start', toolId, `开始更新 ${getToolName(toolId)} ...`);
    const result = await window.electronAPI.updateTool(toolId);
    if (!result.success) {
      appendLog('error', toolId, result.message || '更新失败');
    }
  } catch (err) {
    appendLog('error', toolId, `更新异常: ${err.message}`);
  } finally {
    isUpdating = false;
    updateUIState(false);
    await refreshSingleTool(toolId);
  }
}

// ===== 安装单个工具（新增功能） =====
async function installTool(toolId) {
  if (isUpdating) return;
  isUpdating = true;
  updateUIState(true, toolId);

  try {
    appendLog('start', toolId, `开始安装 ${getToolName(toolId)} ...`);
    const result = await window.electronAPI.installTool(toolId);
    if (!result.success) {
      appendLog('error', toolId, result.message || '安装失败');
    }
  } catch (err) {
    appendLog('error', toolId, `安装异常: ${err.message}`);
  } finally {
    isUpdating = false;
    updateUIState(false);
    await refreshSingleTool(toolId);
  }
}

// ===== 一键配置 agyyolo 到 PowerShell Profile =====
async function installAgyyolo() {
  try {
    btnInstallAgyyolo.disabled = true;
    appendLog('start', 'system', '正在检测 agy 是否安装 ...');

    const result = await window.electronAPI.installAgyyolo();
    if (!result.success) {
      appendLog('error', 'system', result.message || 'agyyolo 配置失败');
      return;
    }

    for (const item of result.results) {
      const status = item.ok ? 'OK' : 'FAIL';
      const type = item.ok ? 'success' : 'error';
      appendLog(type, 'system', `[${status}] ${item.profile} - ${item.reason}`);
    }

    appendLog('success', 'system', 'agyyolo 配置完成。请重新打开 PowerShell 窗口使用 agyyolo。');
  } catch (err) {
    appendLog('error', 'system', `配置 agyyolo 异常: ${err.message}`);
  } finally {
    btnInstallAgyyolo.disabled = false;
  }
}

async function openPowerShell() {
  try {
    appendLog('info', 'system', '正在打开 PowerShell 窗口...');
    const result = await window.electronAPI.openPowerShell();
    if (result.success) {
      appendLog('success', 'system', 'PowerShell 窗口已成功打开');
    } else {
      appendLog('error', 'system', `打开 PowerShell 失败: ${result.error}`);
    }
  } catch (err) {
    appendLog('error', 'system', `打开 PowerShell 异常: ${err.message}`);
  }
}

// ===== 卸载单个工具 =====
async function uninstallTool(toolId) {
  if (isUpdating) return;
  const name = getToolName(toolId);
  if (!confirm(`确定要卸载 ${name} 吗？`)) return;

  isUpdating = true;
  updateUIState(true, toolId);

  try {
    appendLog('start', toolId, `开始卸载 ${name} ...`);
    const result = await window.electronAPI.uninstallTool(toolId);
    if (!result.success) {
      appendLog('error', toolId, result.message || '卸载失败');
      // 脚本安装类工具：引导打开官方文档
      if (result.docsUrl && confirm(`${name} 需手动卸载。\n是否打开官方文档？\n\n${result.docsUrl}`)) {
        await window.electronAPI.openExternal(result.docsUrl);
      }
    }
  } catch (err) {
    appendLog('error', toolId, `卸载异常: ${err.message}`);
  } finally {
    isUpdating = false;
    updateUIState(false);
    await refreshSingleTool(toolId);
  }
}

// ===== 移除自定义工具 =====
async function removeCustomTool(toolId) {
  const name = getToolName(toolId);
  if (!confirm(`确定要从列表中移除自定义工具「${name}」吗？\n（不会卸载已安装的 npm 包）`)) return;
  try {
    await window.electronAPI.removeCustomTool(toolId);
    appendLog('info', 'system', `自定义工具 "${name}" 已移除`);
    // 从本地数据中移除并重新渲染
    toolsData = toolsData.filter(t => t.id !== toolId);
    renderTools();
  } catch (err) {
    appendLog('error', 'system', `移除失败: ${err.message}`);
  }
}

// ===== 一键更新全部 =====
async function updateAll() {
  const ids = toolsData.filter(t => t.needsUpdate).map(t => t.id);
  if (ids.length === 0) return;

  if (isUpdating) return;
  isUpdating = true;

  appendLog('start', 'system', `开始一键更新 ${ids.length} 个工具...`);

  try {
    for (let i = 0; i < ids.length; i++) {
      const toolId = ids[i];
      btnUpdateAll.innerHTML = `<span class="icon">⏳</span> 更新中 (${i + 1}/${ids.length})`;
      updateUIState(true, toolId);
      appendLog('start', toolId, `开始更新 ${getToolName(toolId)} ...`);
      const result = await window.electronAPI.updateTool(toolId);
      if (!result.success) {
        appendLog('error', toolId, result.message || '更新失败');
      }
      await refreshSingleTool(toolId);
    }
    appendLog('success', 'system', '全部更新任务执行完毕');
  } catch (err) {
    appendLog('error', 'system', `一键更新异常: ${err.message}`);
  } finally {
    isUpdating = false;
    btnUpdateAll.innerHTML = '<span class="icon">🚀</span> 一键更新全部';
    updateUIState(false);
    await silentRefreshAll();
  }
}

// ===== 一键安装全部未安装工具 =====
async function installAll() {
  const ids = toolsData.filter(t => !t.installed).map(t => t.id);
  if (ids.length === 0) return;

  if (isUpdating) return;
  isUpdating = true;

  appendLog('start', 'system', `开始一键安装 ${ids.length} 个工具...`);

  try {
    for (let i = 0; i < ids.length; i++) {
      const toolId = ids[i];
      btnInstallAll.innerHTML = `<span class="icon">⏳</span> 安装中 (${i + 1}/${ids.length})`;
      updateUIState(true, toolId);
      appendLog('start', toolId, `开始安装 ${getToolName(toolId)} ...`);
      const result = await window.electronAPI.installTool(toolId);
      if (!result.success) {
        appendLog('error', toolId, result.message || '安装失败');
      }
      await refreshSingleTool(toolId);
    }
    appendLog('success', 'system', '全部安装任务执行完毕');
  } catch (err) {
    appendLog('error', 'system', `一键安装异常: ${err.message}`);
  } finally {
    isUpdating = false;
    btnInstallAll.innerHTML = '<span class="icon">📦</span> 一键安装全部';
    updateUIState(false);
    await silentRefreshAll();
  }
}

// ===== 刷新单个工具 =====
async function refreshSingleTool(toolId) {
  try {
    const updated = await window.electronAPI.checkVersion(toolId);
    const idx = toolsData.findIndex(t => t.id === toolId);
    if (idx !== -1) {
      toolsData[idx] = updated;
    }
    renderTools();
  } catch (err) {
    appendLog('error', toolId, `刷新版本失败: ${err.message}`);
  }
}

// 静默刷新所有工具版本（不清空日志）
async function silentRefreshAll() {
  try {
    toolsData = await window.electronAPI.checkVersions();
    renderTools();
  } catch (err) {
    appendLog('error', 'system', `刷新版本失败: ${err.message}`);
  }
}

// ===== UI 状态更新 =====
function updateUIState(updating, activeToolId) {
  btnCheck.disabled = updating;
  btnUpdateAll.disabled = updating;
  if (btnInstallAll) btnInstallAll.disabled = updating;

  document.querySelectorAll('.tool-card').forEach(card => {
    const id = card.dataset.id;
    const btns = card.querySelectorAll('.btn-update, .btn-install, .btn-uninstall');
    const status = card.querySelector('.tool-status');

    if (updating && activeToolId && id === activeToolId) {
      card.classList.add('updating');
      if (status) {
        status.className = 'tool-status status-updating';
        status.textContent = '执行中';
      }
      // 动作按钮替换为 spinner，提供明确的执行中反馈（结束后 refreshSingleTool 会重渲染恢复）
      const actionBtn = card.querySelector('.btn-update, .btn-install');
      if (actionBtn) {
        actionBtn.innerHTML = '<span class="spinner"></span>';
      }
    } else if (!updating) {
      card.classList.remove('updating');
    }

    btns.forEach(btn => { btn.disabled = updating; });
  });
}

// ===== 日志相关 =====
function clearLog() {
  logEntries.length = 0;
  renderLogs();
}

function appendLog(type, toolId, message, time) {
  if (!message || message.trim() === '') return;

  const lines = message.split(/\r?\n/).filter(line => line.trim() !== '');
  for (const line of lines) {
    logEntries.push({ type, toolId, message: line, time: time || new Date().toLocaleTimeString() });
  }
  // 超出上限从头部截断
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  }
  renderLogs();
}

/** 按当前过滤条件渲染日志视图（过滤只影响视图，不改变数据） */
function renderLogs() {
  const keyword = logFilters.keyword.toLowerCase();
  const fragment = document.createDocumentFragment();
  let visible = 0;

  for (const entry of logEntries) {
    if (logFilters.level && entry.type !== logFilters.level) continue;
    if (logFilters.tool && entry.toolId !== logFilters.tool) continue;
    if (keyword && !entry.message.toLowerCase().includes(keyword)) continue;
    fragment.appendChild(buildLogLine(entry));
    visible++;
  }

  logContainer.innerHTML = '';
  if (visible === 0) {
    logContainer.innerHTML = `<div class="log-empty">${logEntries.length === 0 ? '点击「检测版本」开始' : '没有匹配过滤条件的日志'}</div>`;
    return;
  }
  logContainer.appendChild(fragment);
  logContainer.scrollTop = logContainer.scrollHeight;
}

/** 构建单行日志 DOM（全程转义，防注入） */
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

/** 同步工具过滤器选项（随工具列表变化；尽量保留当前选择） */
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
  // 若所选工具已被移除（如自定义工具删除），回退到"全部工具"
  if (logFilterTool.value !== current) {
    logFilters.tool = '';
  }
}

// 获取日志纯文本（始终导出全部条目，不受过滤器影响）
function getLogText() {
  return logEntries.map(e => {
    const toolName = e.toolId === 'system' ? 'SYSTEM' : getToolName(e.toolId);
    return `[${e.time}] ${toolName} ${e.message}`;
  }).join('\n');
}

// 复制日志到剪贴板
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

// 导出日志到文件
async function exportLog() {
  const text = getLogText();
  if (!text) {
    appendLog('info', 'system', '当前没有日志可导出');
    return;
  }
  try {
    const result = await window.electronAPI.exportLog(text);
    if (result.success) {
      appendLog('success', 'system', `日志已导出到: ${result.filePath}`);
    }
  } catch (err) {
    appendLog('error', 'system', `导出失败: ${err.message}`);
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

// ===== 启动 =====
init();
