// 工具列表数据
let toolsData = [];
let isChecking = false;
let isUpdating = false;

// DOM 元素
const toolsGrid = document.getElementById('tools-grid');
const logContainer = document.getElementById('log-container');
const btnCheck = document.getElementById('btn-check');
const btnUpdateAll = document.getElementById('btn-update-all');
const btnAdmin = document.getElementById('btn-admin');
const btnClearLog = document.getElementById('btn-clear-log');

// 初始化
async function init() {
  renderSkeleton();
  bindEvents();
  bindLogListener();
  // 启动时自动检测一次
  await checkVersions();
}

function bindEvents() {
  btnCheck.addEventListener('click', checkVersions);
  btnUpdateAll.addEventListener('click', updateAll);
  btnAdmin.addEventListener('click', () => window.electronAPI.showAdminTip());
  btnClearLog.addEventListener('click', clearLog);
}

function bindLogListener() {
  window.electronAPI.removeAllLogListeners();
  window.electronAPI.onUpdateLog((data) => {
    appendLog(data.type, data.toolId, data.message, data.time);
  });
}

// 渲染加载占位
function renderSkeleton() {
  toolsGrid.innerHTML = '';
  const names = ['Kimi Code', 'Claude Code', 'OpenAI Codex', 'OpenCode', 'CodeBuddy', 'Qwen Code', 'Gemini CLI'];
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

// 渲染工具卡片
function renderTools() {
  toolsGrid.innerHTML = '';
  let updateCount = 0;

  for (const tool of toolsData) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.id = tool.id;

    let statusClass = 'status-not-installed';
    let statusText = '未安装';
    let canUpdate = false;

    if (tool.notFound) {
      statusClass = 'status-not-installed';
      statusText = '未安装';
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

    card.innerHTML = `
      <div class="tool-header">
        <h3 class="tool-name">${tool.name}</h3>
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
        <button class="btn btn-primary btn-update btn-sm" data-id="${tool.id}" ${!canUpdate || isUpdating ? 'disabled' : ''}>
          更新
        </button>
      </div>
    `;

    toolsGrid.appendChild(card);
  }

  // 绑定单个更新按钮
  document.querySelectorAll('.btn-update').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      updateTool(id);
    });
  });

  btnUpdateAll.disabled = updateCount === 0 || isUpdating;
}

// 检测版本
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

// 更新单个工具
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
    // 更新完成后重新检测当前工具版本
    await refreshSingleTool(toolId);
  }
}

// 一键更新全部
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

// 刷新单个工具版本（只重查该工具，不触发全部重检）
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

// 更新 UI 状态
function updateUIState(updating, activeToolId) {
  btnCheck.disabled = updating;
  btnUpdateAll.disabled = updating;

  document.querySelectorAll('.tool-card').forEach(card => {
    const id = card.dataset.id;
    const btn = card.querySelector('.btn-update');
    const status = card.querySelector('.tool-status');

    if (updating && activeToolId && id === activeToolId) {
      card.classList.add('updating');
      status.className = 'tool-status status-updating';
      status.textContent = '更新中';
    }

    if (btn) {
      btn.disabled = updating;
    }
  });
}

// 日志相关
function clearLog() {
  logContainer.innerHTML = '';
}

function appendLog(type, toolId, message, time) {
  // 清理空消息
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

// 启动
init();
