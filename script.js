// ===== 状态变量 =====
let toolsData = [];
let isChecking = false;
/**
 * 工具级操作锁（替代全局 isUpdating 布尔）
 * 使用 Set 维护“正在操作”的工具 ID，支持同时操作多个工具
 */
const updatingTools = new Set();
/** 切换到「自定义源」前，记住当前选中的镜像源，取消时可恢复 */
let previousRegistryUrl = '';
/** stats 栏当前过滤状态（null=无过滤，字符串=展示对应类别） */
let statsFilter = null;

// ===== 日志数据（过滤视图的数据源；复制/导出始终作用于全部条目） =====
const MAX_LOG_ENTRIES = 2000; // 上限，防止长时间运行内存无限增长
const logEntries = [];
const logFilters = { level: '', tool: '', keyword: '' };
/** 当前实际渲染到 DOM 的日志条数（增量渲染需要它来维护空状态与截断） */
let visibleLogCount = 0;

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

  // 加载完成后旦即启动流式检测
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
  btnExportReport.addEventListener('click', exportVersionReport);
  btnClearLog.addEventListener('click', clearLog);
  btnCopyLog.addEventListener('click', copyLog);
  btnExportLog.addEventListener('click', exportLog);
  btnAddTool.addEventListener('click', openModal);
  btnSettings.addEventListener('click', openSettings);
  // 镜像源测速：必须用 addEventListener 绑定，
  // 页面 CSP 为 script-src 'self'（无 unsafe-inline），HTML 内联 onclick 会被直接拦截
  const btnPingRegistry = document.getElementById('btn-ping-registry');
  if (btnPingRegistry) btnPingRegistry.addEventListener('click', pingAllRegistries);
  const btnAutoRegistry = document.getElementById('btn-auto-registry');
  if (btnAutoRegistry) btnAutoRegistry.addEventListener('click', autoSelectFastestRegistry);
  btnDismissEnv.addEventListener('click', () => { envBanner.style.display = 'none'; });

  // 工具卡片按钮：事件委托绑定一次，卡片重渲染/局部替换后都无需重新绑定
  // （disabled 的按钮不会派发 click，操作锁仍然有效）
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
  // 监听流式检测结果（每检测完一个工具就更新对应卡片）
  window.electronAPI.onToolChecked((result) => {
    onSingleToolChecked(result);
  });
  // 监听高亮指定工具（来自系统通知点击）
  window.electronAPI.onHighlightTool((toolId) => {
    highlightToolCard(toolId);
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
    // data-id 必须写上：流式检测结果回来时 updateSingleCard 靠它定位卡片，
    // 缺了会导致每个结果都退化成全量 renderTools()，骨架屏当场塌缩成一张卡
    card.dataset.id = tool.id;
    card.innerHTML = `
      <div class="card-progress"></div>
      <div class="tool-card-body">
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
  // 当前平台不支持的工具（声明了 platforms 且不含当前平台）：显示"平台不支持"，不提供安装/更新
  if (tool.supported === false) {
    return { rank: 5, statusClass: 'status-unsupported', statusText: '平台不支持', canUpdate: false, canInstall: false, stat: 'unsupported', cardClass: 'card-unsupported' };
  }
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

/**
 * 构建卡片操作区（.tool-actions）的 HTML
 * renderTools（全量渲染）与 updateSingleCard（流式局部更新）共用，
 * 避免两处各写一份模板导致长期漂移
 * @param {object} tool - 工具数据
 * @param {object} cls  - classifyTool(tool) 的结果
 * @returns {string} 操作区内部 HTML
 */
function buildActionsHtml(tool, cls) {
  const id = escapeHtml(tool.id);
  const locked = updatingTools.has(tool.id) ? 'disabled' : '';

  let actionBtn;
  if (cls.canUpdate) {
    actionBtn = `<button class="btn btn-primary btn-update btn-sm" data-id="${id}" ${locked}>更新</button>`;
  } else if (cls.canInstall) {
    actionBtn = `<button class="btn btn-success btn-install btn-sm" data-id="${id}" ${locked}>安装</button>`;
  } else if (cls.stat === 'unsupported') {
    // 当前平台不支持：按钮置灰且不可点击（无 data-id，事件委托不会响应）
    actionBtn = `<button class="btn btn-sm" disabled title="当前平台不支持安装 ${escapeHtml(tool.name)}">不支持</button>`;
  } else {
    actionBtn = `<button class="btn btn-primary btn-sm" disabled>已是最新</button>`;
  }

  // 已安装的工具附加卸载按钮
  const uninstallBtn = tool.installed
    ? `<button class="btn btn-danger-ghost btn-uninstall btn-sm" data-id="${id}" ${locked}>卸载</button>`
    : '';

  // changelog 入口：脚本安装工具用官网，npm 工具指向 npmjs 包页
  const changelogUrl = tool.docsUrl || (tool.pkg ? `https://www.npmjs.com/package/${tool.pkg}` : '');
  const changelogLink = changelogUrl
    ? `<button class="btn btn-ghost btn-sm changelog-link" data-url="${escapeHtml(changelogUrl)}" title="查看 ${escapeHtml(tool.name)} 更新说明" type="button">🔗</button>`
    : '';

  // 自定义工具附加删除按钮
  const removeBtn = tool.isCustom
    ? `<button class="btn btn-danger-ghost btn-remove btn-sm" data-id="${id}" title="移除此自定义工具">🗑️</button>`
    : '';

  return actionBtn + uninstallBtn + changelogLink + removeBtn;
}

// ===== 渲染工具卡片 =====
function renderTools() {
  toolsGrid.innerHTML = '';
  let updateCount = 0;
  let installCount = 0;
  const stats = { update: 0, install: 0, latest: 0, error: 0, unsupported: 0 };

  // 按状态排序（稳定排序，同类内保持原顺序）
  const sorted = [...toolsData].sort((a, b) => classifyTool(a).rank - classifyTool(b).rank);

  for (let cardIdx = 0; cardIdx < sorted.length; cardIdx++) {
    const tool = sorted[cardIdx];
    const cls = classifyTool(tool);
    stats[cls.stat]++;
    if (cls.canUpdate) updateCount++;
    if (cls.canInstall) installCount++;

    // stats 栏过滤：如果当前有活跃过滤，只显示匹配类别的卡片
    if (statsFilter && cls.stat !== statsFilter) continue;

    const card = document.createElement('div');
    card.className = `tool-card ${cls.cardClass}`;
    card.dataset.id = tool.id;

    // 自定义工具标识
    const customBadge = tool.isCustom ? '<span class="custom-badge">自定义</span>' : '';

    // 可更新时"最新"版本号高亮
    const latestClass = cls.canUpdate ? 'version-value version-highlight' : 'version-value';

    card.innerHTML = `
      <div class="card-progress"></div>
      <div class="tool-card-body">
        <div class="tool-header">
          <h3 class="tool-name"><span class="tool-icon" aria-hidden="true">${escapeHtml(tool.icon || tool.name.charAt(0).toUpperCase())}</span>${escapeHtml(tool.name)} ${customBadge}</h3>
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
      </div>
      <div class="tool-actions">${buildActionsHtml(tool, cls)}</div>
    `;

    toolsGrid.appendChild(card);
    // 入场动画逐张延迟（用 cardIdx 取代 O(n) indexOf）
    card.style.animationDelay = `${cardIdx * 30}ms`;
  }

  // 卡片按钮通过 toolsGrid 上的事件委托统一处理（见 bindEvents），此处无需逐个绑定

  btnUpdateAll.disabled = updateCount === 0 || updatingTools.size > 0;
  // 当有未安装工具且不在更新状态时，启用一键安装
  if (btnInstallAll) btnInstallAll.disabled = installCount === 0 || updatingTools.size > 0;

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
  const statUnsupported = document.getElementById('stat-unsupported');
  if (statUnsupported) statUnsupported.textContent = stats.unsupported || 0;

  // 更新各统计概率上的活跃状态（点击可过滤）
  const chips = bar.querySelectorAll('.stat-chip[data-filter]');
  chips.forEach(chip => {
    const filter = chip.dataset.filter;
    chip.classList.toggle('stat-chip-active', statsFilter === filter);
  });
}

// ===== 检测版本 =====
async function checkVersions() {
  if (isChecking) return;
  isChecking = true;
  // 重置头部 stats 过滤，防止旧过滤干扰新结果
  statsFilter = null;
  btnCheck.disabled = true;
  btnCheck.innerHTML = '<span class="icon">⏳</span> 检测中...';
  // 不再自动清空日志，方便对照历史输出；需要清空请点「清空」
  appendLog('info', 'system', '开始检测所有工具版本...');

  // 流式检测：初始化工具数据（骨架屏状态）后，每检测完一个通过 onToolChecked 即时刷新对应卡片
  // 最终 checkVersions 返回全部结果（用于应急投票原则等）
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

/**
 * 流式检测回调：单个工具检测完成时立即更新对应卡片
 * @param {object} result - checkTool 返回的单个工具结果
 */
function onSingleToolChecked(result) {
  if (!result || !result.id) return;
  const idx = toolsData.findIndex(t => t.id === result.id);
  if (idx !== -1) {
    toolsData[idx] = result;
  } else {
    // 首次检测时，数据可能还未充充，直接 push
    toolsData.push(result);
  }
  // 局部更新对应卡片（流式更新不重渲染全部卡片，再比较性能）
  updateSingleCard(result);
}

// ===== 更新单个工具 =====
async function updateTool(toolId) {
  if (updatingTools.has(toolId)) return;
  updatingTools.add(toolId);
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
    updatingTools.delete(toolId);
    updateUIState(false, toolId);
    await refreshSingleTool(toolId);
  }
}

// ===== 安装单个工具（新增功能） =====
async function installTool(toolId) {
  if (updatingTools.has(toolId)) return;
  updatingTools.add(toolId);
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
    updatingTools.delete(toolId);
    updateUIState(false, toolId);
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
  if (updatingTools.has(toolId)) return;
  const name = getToolName(toolId);
  // showConfirmModal 的正文走 innerHTML，工具名（可能是用户自定义）必须转义
  const safeName = escapeHtml(name);
  // 使用自定义模态框替代原生 confirm()
  const confirmed = await showConfirmModal(
    `确定卸载 ${name}？`,
    `将卸载 <b>${safeName}</b>，其全局安装的 npm 包会被移除。`,
    '卸载',
    'danger'
  );
  if (!confirmed) return;

  updatingTools.add(toolId);
  updateUIState(true, toolId);

  try {
    appendLog('start', toolId, `开始卸载 ${name} ...`);
    const result = await window.electronAPI.uninstallTool(toolId);
    if (!result.success) {
      appendLog('error', toolId, result.message || '卸载失败');
      // 脚本安装类工具：引导打开官方文档
      if (result.docsUrl) {
        const goDoc = await showConfirmModal(
          `${name} 需手动卸载`,
          `${safeName} 通过官方脚本安装，无统一卸载命令。是否打开官方文档？<br><small style="color:var(--text-muted)">${escapeHtml(result.docsUrl)}</small>`,
          '打开官方文档',
          'primary'
        );
        if (goDoc) await window.electronAPI.openExternal(result.docsUrl);
      }
    }
  } catch (err) {
    appendLog('error', toolId, `卸载异常: ${err.message}`);
  } finally {
    updatingTools.delete(toolId);
    updateUIState(false, toolId);
    await refreshSingleTool(toolId);
  }
}

// ===== 移除自定义工具 =====
async function removeCustomTool(toolId) {
  const name = getToolName(toolId);
  const confirmed = await showConfirmModal(
    `移除自定义工具`,
    `确定要从列表中移除「${escapeHtml(name)}」吗？<br><small style="color:var(--text-muted)">不会卸载已安装的 npm 包</small>`,
    '移除',
    'danger'
  );
  if (!confirmed) return;
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
  await runBatch(ids, btnUpdateAll, window.electronAPI.updateTool, {
    verb: '更新', idleHtml: '<span class="icon">🚀</span> 一键更新全部'
  });
}

// ===== 一键安装全部未安装工具 =====
async function installAll() {
  // 仅安装未安装且当前平台支持的工具（不支持的跳过）
  const ids = toolsData.filter(t => !t.installed && t.supported !== false).map(t => t.id);
  await runBatch(ids, btnInstallAll, window.electronAPI.installTool, {
    verb: '安装', idleHtml: '<span class="icon">📦</span> 一键安装全部'
  });
}

/**
 * 逐个执行批量安装/更新（updateAll 与 installAll 共用）
 * 每个工具独立 try/finally：单个工具 IPC 异常不会中断后续工具，也不会让它的操作锁永远不释放
 * @param {string[]} ids - 待处理的工具 ID
 * @param {HTMLButtonElement} button - 顶部批量按钮（显示进度）
 * @param {(toolId: string) => Promise<object>} action - updateTool / installTool
 * @param {{ verb: string, idleHtml: string }} labels
 */
async function runBatch(ids, button, action, { verb, idleHtml }) {
  if (ids.length === 0 || updatingTools.size > 0) return;

  appendLog('start', 'system', `开始一键${verb} ${ids.length} 个工具...`);

  try {
    for (let i = 0; i < ids.length; i++) {
      const toolId = ids[i];
      button.innerHTML = `<span class="icon">⏳</span> ${verb}中 (${i + 1}/${ids.length})`;
      updatingTools.add(toolId);
      updateUIState(true, toolId);
      appendLog('start', toolId, `开始${verb} ${getToolName(toolId)} ...`);
      try {
        const result = await action(toolId);
        if (!result.success) {
          appendLog('error', toolId, result.message || `${verb}失败`);
        }
      } catch (err) {
        appendLog('error', toolId, `${verb}异常: ${err.message}`);
      } finally {
        updatingTools.delete(toolId);
      }
      await refreshSingleTool(toolId);
    }
    appendLog('success', 'system', `全部${verb}任务执行完毕`);
  } finally {
    button.innerHTML = idleHtml;
    updateUIState(false);
    // 循环中每个工具都已经 refreshSingleTool 过了，这里只需重排/重绘，
    // 不必再对全部工具（含没动过的）跑一次完整检测
    renderTools();
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

/**
 * 追加日志（增量渲染）
 *
 * 早期实现每来一条日志就整体重建全部条目（上限 2000）的 DOM，安装时 npm 的流式输出
 * 会把它变成 O(n^2) —— 界面明显卡顿。这里改为只为新增行创建节点并 append，
 * 只有过滤条件变化或清空时才走 renderLogs() 全量重建。
 */
function appendLog(type, toolId, message, time) {
  if (!message || message.trim() === '') return;

  const stamp = time || new Date().toLocaleTimeString();
  const lines = message.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return;

  // 追加前先判断视图是否贴在底部，决定之后要不要自动滚动
  const stickToBottom = isLogScrolledToBottom();

  const fragment = document.createDocumentFragment();
  let added = 0;
  for (const line of lines) {
    const entry = { type, toolId, message: line, time: stamp };
    logEntries.push(entry);
    // 命中当前过滤条件的才进入视图（数据始终保留全量，复制/导出不受影响）
    if (logMatchesFilters(entry)) {
      fragment.appendChild(buildLogLine(entry));
      added++;
    }
  }

  // 超出上限从头部截断（数据与 DOM 同步裁剪）
  let dropped = 0;
  if (logEntries.length > MAX_LOG_ENTRIES) {
    const removed = logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
    dropped = removed.filter(logMatchesFilters).length;
  }

  if (added === 0 && dropped === 0) return;

  // 有新内容要显示时，先清掉空状态占位
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
  // 只在用户本来就贴着底部时才跟随滚动，否则不打断用户回看历史日志
  if (stickToBottom) logContainer.scrollTop = logContainer.scrollHeight;
}

/** 单条日志是否命中当前过滤条件 */
function logMatchesFilters(entry) {
  if (logFilters.level && entry.type !== logFilters.level) return false;
  if (logFilters.tool && entry.toolId !== logFilters.tool) return false;
  const keyword = logFilters.keyword.toLowerCase();
  if (keyword && !entry.message.toLowerCase().includes(keyword)) return false;
  return true;
}

/** 日志视图是否已滚动到底部（留 40px 容差） */
function isLogScrolledToBottom() {
  return logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 40;
}

/** 渲染空状态占位 */
function renderLogEmptyState() {
  logContainer.innerHTML = `<div class="log-empty">${logEntries.length === 0 ? '点击「检测版本」开始' : '没有匹配过滤条件的日志'}</div>`;
}

/**
 * 按当前过滤条件全量重建日志视图（过滤只影响视图，不改变数据）
 * 仅在过滤条件变化或清空日志时调用；正常追加走 appendLog 的增量路径
 */
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
    // 表格内容转义竖线，防止工具名/版本号破坏表格结构
    const esc = (v) => String(v || '-').replace(/\|/g, '\\|');
    lines.push(`| ${esc(t.name)} | ${cls.statusText} | ${esc(t.currentVersion)} | ${esc(t.latestVersion)} |`);
  }
  try {
    const result = await window.electronAPI.exportReport({
      text: lines.join('\n'),
      defaultName: `ai-tools-report-${new Date().toISOString().slice(0, 10)}.md`
    });
    if (!result || !result.success) appendLog('info', 'system', '已取消导出版本报告');
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
/**
 * 单个工具检测完成后，局部更新对应卡片而非重渲染全部
 * 如果卡片不存在（骨架屏已销毁），降级为全量 renderTools
 * @param {object} tool - 检测结果
 */
function updateSingleCard(tool) {
  const existing = toolsGrid.querySelector(`.tool-card[data-id="${CSS.escape(tool.id)}"]`);
  if (!existing) {
    renderTools();
    return;
  }
  const cls = classifyTool(tool);

  // 更新状态徽章
  const statusEl = existing.querySelector('.tool-status');
  if (statusEl) {
    statusEl.className = `tool-status ${cls.statusClass}`;
    statusEl.textContent = cls.statusText;
  }

  // 更新卡片边条颜色（保留 updating 状态）
  existing.className = `tool-card ${cls.cardClass}${existing.classList.contains('updating') ? ' updating' : ''}`;

  // 更新版本号
  const versionValues = existing.querySelectorAll('.version-value');
  if (versionValues.length >= 2) {
    versionValues[0].textContent = tool.currentVersion || '-';
    versionValues[0].title = tool.currentVersion || '';
    versionValues[1].className = cls.canUpdate ? 'version-value version-highlight' : 'version-value';
    versionValues[1].textContent = tool.latestVersion || '-';
    versionValues[1].title = tool.latestVersion || '';
  }

  // 更新操作按钮区域（局部替换）
  // 事件由 toolsGrid 上的委托统一处理，替换 innerHTML 后无需重新绑定
  const actionsEl = existing.querySelector('.tool-actions');
  if (actionsEl) {
    actionsEl.innerHTML = buildActionsHtml(tool, cls);
  }

  // 同步顶部按钮状态
  const hasUpdatable = toolsData.some(t => t.needsUpdate);
  btnUpdateAll.disabled = !hasUpdatable || updatingTools.size > 0;
}

// ===== 高亮并滚动到指定工具卡片（通知点击后定位） =====
/**
 * 高亮指定工具的卡片并滚动至可视区域
 * @param {string} toolId - 要高亮的工具 ID
 */
function highlightToolCard(toolId) {
  if (!toolId) return;
  const card = toolsGrid.querySelector(`.tool-card[data-id="${CSS.escape(toolId)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card.classList.add('card-highlighted');
  card.addEventListener('animationend', () => {
    card.classList.remove('card-highlighted');
  }, { once: true });
}

// ===== 自定义确认弹框（替代原生 confirm()） =====
/**
 * 显示样式统一的确认弹框，返回 Promise<boolean>
 * @param {string} title          - 弹框标题
 * @param {string} message        - 弹框正文（支持 HTML）
 * @param {string} confirmText    - 确认按钮文字
 * @param {'danger'|'primary'} confirmVariant - 确认按钮风格
 */
function showConfirmModal(title, message, confirmText = '确认', confirmVariant = 'primary') {
  return new Promise((resolve) => {
    const overlay   = document.getElementById('confirm-overlay');
    const titleEl   = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const btnOk     = document.getElementById('btn-confirm-ok');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    const btnClose  = document.getElementById('btn-confirm-close');

    if (!overlay) {
      // 降级：DOM 中无确认弹框时使用原生 confirm
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
        // 焦点在弹框按钮上时交给按钮自身处理：危险操作默认聚焦「取消」，
        // 若这里一律 cleanup(true)，按回车反而会确认卸载
        if (e.target instanceof HTMLButtonElement && overlay.contains(e.target)) return;
        cleanup(true);
      }
    };

    btnOk.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKeydown);

    // 危险操作默认聚焦取消按钮，避免误操作
    (confirmVariant === 'danger' ? btnCancel : btnOk).focus();
  });
}

// ===== Stats 栏点击过滤绑定 =====
// 点击统计类别 chip 切换过滤；再次点击取消过滤
(function bindStatsFilter() {
  const bar = document.getElementById('stats-bar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.stat-chip[data-filter]');
    if (!chip) return;
    const filter = chip.dataset.filter;
    statsFilter = (statsFilter === filter) ? null : filter;
    renderTools();
    // 读取当前统计数字再更新 chip 活跃状态
    updateStatsBar({
      update:  parseInt(document.getElementById('stat-update').textContent,  10) || 0,
      install: parseInt(document.getElementById('stat-install').textContent, 10) || 0,
      latest:  parseInt(document.getElementById('stat-latest').textContent,  10) || 0,
      error:   parseInt(document.getElementById('stat-error').textContent,   10) || 0,
      unsupported: parseInt((document.getElementById('stat-unsupported') || {}).textContent || '0', 10) || 0,
    });
  });
})();

// ===== 镜像源测速 =====
/**
 * 测速全部预设镜像源，返回 [{ name, url, success, ms, message }]
 * 供「测速」展示与「自动选最快」共用，避免两处重复实现
 */
async function measureAllRegistries() {
  const registries = await window.electronAPI.getRegistries();
  return Promise.all(
    registries.map(async (reg) => {
      const res = await window.electronAPI.pingRegistry(reg.url);
      return { name: reg.name, url: reg.url, ...res };
    })
  );
}

/**
 * 对所有预设镜像源进行延迟测试，在设置弹框中展示结果
 */
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
        <span class="ping-name">${escapeHtml(r.name)}</span>
        <span class="ping-ms ping-${level}">${r.success ? ms : (r.message || '超时')}</span>
      </div>`;
    }).join('');
  } catch (err) {
    speedResults.innerHTML = `<div class="ping-error">测速失败: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btnPing) { btnPing.disabled = false; btnPing.textContent = '🚀 测速'; }
  }
}

/**
 * 自动测速并切换到最快的镜像源
 */
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
