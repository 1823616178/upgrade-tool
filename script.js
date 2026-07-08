// ===== 状态变量 =====
let toolsData = [];
let isChecking = false;
let isUpdating = false;

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
const btnInstallAgyyolo = document.getElementById('btn-install-agyyolo');
const btnOpenPowerShell = document.getElementById('btn-open-powershell');
const selectRegistry = document.getElementById('select-registry');
const envBanner = document.getElementById('env-banner');
const envBannerText = document.getElementById('env-banner-text');
const btnDismissEnv = document.getElementById('btn-dismiss-env');
const envNode = document.getElementById('env-node');
const envNpm = document.getElementById('env-npm');
const envOs = document.getElementById('env-os');

// 模态框元素
const modalOverlay = document.getElementById('modal-overlay');
const btnModalClose = document.getElementById('btn-modal-close');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalSave = document.getElementById('btn-modal-save');
const inputToolName = document.getElementById('input-tool-name');
const inputToolPkg = document.getElementById('input-tool-pkg');
const inputToolCmd = document.getElementById('input-tool-cmd');
const inputToolVersionArg = document.getElementById('input-tool-version-arg');

// ===== 初始化 =====
async function init() {
  renderSkeleton();
  bindEvents();
  bindLogListener();

  // 并行执行：环境检测、镜像源加载、版本检测
  await Promise.all([
    checkEnvironment(),
    loadRegistries()
  ]);

  // 启动时自动检测一次
  await checkVersions();
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
  btnDismissEnv.addEventListener('click', () => { envBanner.style.display = 'none'; });

  // 镜像源切换
  selectRegistry.addEventListener('change', async () => {
    const url = selectRegistry.value;
    await window.electronAPI.setRegistry(url);
    appendLog('info', 'system', `镜像源已切换，下次检测/更新将使用新源`);
  });

  // 模态框事件
  btnModalClose.addEventListener('click', closeModal);
  btnModalCancel.addEventListener('click', closeModal);
  btnModalSave.addEventListener('click', saveCustomTool);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
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

    // 如果有错误，显示警告横幅
    if (env.errors && env.errors.length > 0) {
      envBanner.style.display = 'flex';
      envBannerText.textContent = env.errors.join(' | ');
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

    selectRegistry.innerHTML = '';
    for (const reg of registries) {
      const option = document.createElement('option');
      option.value = reg.url;
      option.textContent = reg.name;
      if (reg.url === current) option.selected = true;
      selectRegistry.appendChild(option);
    }

    // 添加"自定义"选项（支持用户输入自定义源地址）
    const customOption = document.createElement('option');
    customOption.value = '__custom__';
    customOption.textContent = '自定义源...';
    selectRegistry.appendChild(customOption);

    // 如果当前源不在预设列表中，选中自定义并显示
    const isPreset = registries.some(r => r.url === current);
    if (!isPreset) {
      customOption.value = current;
      customOption.textContent = `自定义: ${current}`;
      customOption.selected = true;
    }
  } catch (err) {
    appendLog('error', 'system', `加载镜像源失败: ${err.message}`);
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
    await window.electronAPI.addCustomTool({ name, pkg, cmd, versionArg });
    closeModal();
    appendLog('success', 'system', `自定义工具 "${name}" 已添加，正在刷新...`);
    await checkVersions();
  } catch (err) {
    appendLog('error', 'system', `添加自定义工具失败: ${err.message}`);
  }
}

// ===== 渲染骨架屏 =====
function renderSkeleton() {
  toolsGrid.innerHTML = '';
  const names = ['Kimi Code', 'Claude Code', 'OpenAI Codex', 'OpenCode', 'CodeBuddy', 'Qwen Code', 'Antigravity CLI'];
  for (const name of names) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
      <div class="tool-header">
        <h3 class="tool-name">${name}</h3>
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

// ===== 渲染工具卡片 =====
function renderTools() {
  toolsGrid.innerHTML = '';
  let updateCount = 0;
  let installCount = 0;

  for (const tool of toolsData) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.id = tool.id;

    let statusClass = 'status-not-installed';
    let statusText = '未安装';
    let canUpdate = false;
    let canInstall = false;

    if (tool.notFound) {
      statusClass = 'status-not-installed';
      statusText = '未安装';
      canInstall = true; // 未安装的工具可以一键安装
      installCount++;
    } else if (tool.error && !tool.installed) {
      statusClass = 'status-error';
      statusText = '检测失败';
    } else if (tool.needsUpdate) {
      statusClass = 'status-update';
      statusText = '可更新';
      canUpdate = true;
      updateCount++;
    } else if (tool.installed && tool.latestVersion) {
      statusClass = 'status-latest';
      statusText = '最新';
    } else if (tool.installed) {
      statusClass = 'status-error';
      statusText = '远端检测失败';
    }

    // 动作按钮：更新 / 安装 / 禁用
    let actionBtn = '';
    if (canUpdate) {
      actionBtn = `<button class="btn btn-primary btn-update btn-sm" data-id="${tool.id}" ${isUpdating ? 'disabled' : ''}>更新</button>`;
    } else if (canInstall) {
      actionBtn = `<button class="btn btn-success btn-install btn-sm" data-id="${tool.id}" ${isUpdating ? 'disabled' : ''}>安装</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-sm" disabled>已是最新</button>`;
    }

    // 自定义工具附加删除按钮
    let removeBtn = '';
    if (tool.isCustom) {
      removeBtn = `<button class="btn btn-danger-ghost btn-remove btn-sm" data-id="${tool.id}" title="移除此自定义工具">🗑️</button>`;
    }

    // 自定义工具标识
    const customBadge = tool.isCustom ? '<span class="custom-badge">自定义</span>' : '';

    card.innerHTML = `
      <div class="tool-header">
        <h3 class="tool-name">${tool.name} ${customBadge}</h3>
        <span class="tool-status ${statusClass}">${statusText}</span>
      </div>
      <div class="version-info">
        <div class="version-item">
          <span class="version-label">当前</span>
          <span class="version-value" title="${tool.currentVersion || ''}">${tool.currentVersion || '-'}</span>
        </div>
        <span class="version-arrow">→</span>
        <div class="version-item">
          <span class="version-label">最新</span>
          <span class="version-value" title="${tool.latestVersion || ''}">${tool.latestVersion || '-'}</span>
        </div>
      </div>
      <div class="tool-actions">
        ${actionBtn}
        ${removeBtn}
      </div>
    `;

    toolsGrid.appendChild(card);
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

  // 绑定删除按钮
  document.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      removeCustomTool(id);
    });
  });

  btnUpdateAll.disabled = updateCount === 0 || isUpdating;
  // 当有未安装工具且不在更新状态时，启用一键安装
  if (btnInstallAll) btnInstallAll.disabled = installCount === 0 || isUpdating;
}

// ===== 检测版本 =====
async function checkVersions() {
  if (isChecking) return;
  isChecking = true;
  btnCheck.disabled = true;
  btnCheck.innerHTML = '<span class="icon">⏳</span> 检测中...';
  clearLog();
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

// ===== 移除自定义工具 =====
async function removeCustomTool(toolId) {
  const name = getToolName(toolId);
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
  updateUIState(true);

  appendLog('start', 'system', `开始一键更新 ${ids.length} 个工具...`);

  try {
    await window.electronAPI.updateAll(ids);
    appendLog('success', 'system', '全部更新任务执行完毕');
  } catch (err) {
    appendLog('error', 'system', `一键更新异常: ${err.message}`);
  } finally {
    isUpdating = false;
    updateUIState(false);
    await checkVersions();
  }
}

// ===== 一键安装全部未安装工具 =====
async function installAll() {
  const ids = toolsData.filter(t => t.notFound).map(t => t.id);
  if (ids.length === 0) return;

  if (isUpdating) return;
  isUpdating = true;
  updateUIState(true);

  appendLog('start', 'system', `开始一键安装 ${ids.length} 个工具...`);

  try {
    await window.electronAPI.installAll(ids);
    appendLog('success', 'system', '全部安装任务执行完毕');
  } catch (err) {
    appendLog('error', 'system', `一键安装异常: ${err.message}`);
  } finally {
    isUpdating = false;
    updateUIState(false);
    await checkVersions();
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

  document.querySelectorAll('.tool-card').forEach(card => {
    const id = card.dataset.id;
    const btn = card.querySelector('.btn-update, .btn-install');
    const status = card.querySelector('.tool-status');

    if (updating && activeToolId && id === activeToolId) {
      card.classList.add('updating');
      if (status) {
        status.className = 'tool-status status-updating';
        status.textContent = '执行中';
      }
    }

    if (btn) {
      btn.disabled = updating;
    }
  });
}

// ===== 日志相关 =====
function clearLog() {
  logContainer.innerHTML = '';
}

function appendLog(type, toolId, message, time) {
  if (!message || message.trim() === '') return;

  const lines = message.split(/\r?\n/).filter(line => line.trim() !== '');
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = `log-line log-${type}`;

    const t = time || new Date().toLocaleTimeString();
    const toolName = toolId === 'system' ? 'SYSTEM' : getToolName(toolId);

    div.innerHTML = `
      <span class="log-time">[${t}]</span>
      <span class="log-tool">${toolName}</span>
      <span class="log-message">${escapeHtml(line)}</span>
    `;

    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

// 获取日志纯文本
function getLogText() {
  const lines = logContainer.querySelectorAll('.log-line');
  return Array.from(lines).map(line => {
    const time = line.querySelector('.log-time')?.textContent || '';
    const tool = line.querySelector('.log-tool')?.textContent || '';
    const msg = line.querySelector('.log-message')?.textContent || '';
    return `${time} ${tool} ${msg}`;
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
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===== 启动 =====
init();
