# UI 优化、功能增强与 BUG 修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 AI Code Tool Updater 的 8 个 BUG（含打包图标缺失、托盘僵尸进程、XSS），落地 4 项功能增强（状态排序+统计摘要、卡片进度反馈、日志过滤搜索、实用小功能），并在保留现有设计系统的前提下完成 UI 打磨。

**Architecture:** Electron 31 三层结构（`main.js` 主进程 / `preload.js` 桥 / `index.html`+`script.js`+`style.css` 渲染层）。无测试框架（spec 决策，不引入），纯函数用 `scripts/verify-semver.js` 提取断言，其余靠 `node --check` 语法校验 + 构建产物检查 + 手动冒烟。

**Tech Stack:** Electron 31、electron-builder 24、原生 JS/CSS。

**Spec:** `docs/superpowers/specs/2026-07-16-ui-optimization-and-bugfixes-design.md`

**执行说明:**
- 所有 Commit 步骤仅在用户授权 git 提交后执行；未授权则跳过。
- 工作区存在用户既有的未提交改动（README/index.html/main.js/package.json/script.js/style.css），本计划代码基于该工作区状态编写。首次提交前如何处理这些 WIP，以用户在手交接时的决定为准。
- 每个 Task 完成后必须能通过其验证步骤，再进入下一个 Task。

---

## 阶段一：BUG 修复

### Task 1: B1 — 打包产物包含 build 图标

**Files:**
- Modify: `package.json`（`build.files` 数组，第 35-42 行）

- [ ] **Step 1: 修改 files 数组**

将：

```json
    "files": [
      "main.js",
      "preload.js",
      "index.html",
      "style.css",
      "script.js",
      "package.json"
    ],
```

改为：

```json
    "files": [
      "main.js",
      "preload.js",
      "index.html",
      "style.css",
      "script.js",
      "package.json",
      "build/icon.ico",
      "build/icon.png"
    ],
```

- [ ] **Step 2: 验证 JSON 有效且包含图标**

Run: `node -e "const p=require('./package.json'); if(!p.build.files.includes('build/icon.ico')||!p.build.files.includes('build/icon.png')) process.exit(1); console.log('OK', p.build.files.join(','))"`
Expected: `OK main.js,preload.js,index.html,style.css,script.js,package.json,build/icon.ico,build/icon.png`

（asar 产物验证在 Task 8 统一执行）

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "fix: include build icons in packaged app files"
```

---

### Task 2: B6 — semver 预发布版本比较

**Files:**
- Create: `scripts/verify-semver.js`
- Modify: `main.js`（`parseSemver` 第 469-479 行、`compareSemver` 第 485-493 行）

- [ ] **Step 1: 写验证脚本（先失败）**

创建 `scripts/verify-semver.js`：

```js
// scripts/verify-semver.js
// 从 main.js 中提取 semver 相关纯函数并断言比较行为（无测试框架下的轻量验证）
// 用法：node scripts/verify-semver.js，全部 PASS 退出码 0，否则 1
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// 提取顶层函数定义（以 "function name(" 开始、以行首 "}" 结束）
for (const name of ['extractVersionNumber', 'parseSemver', 'comparePrerelease', 'compareSemver']) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) {
    console.error(`未找到函数: ${name}`);
    process.exit(1);
  }
  eval(m[0]);
}

const cases = [
  ['1.2.3', '1.2.4', -1],
  ['1.2.4', '1.2.3', 1],
  ['1.2.3', '1.2.3', 0],
  ['v1.2.3', '1.2.3', 0],
  ['2.0.0-rc.1', '2.0.0', -1],          // 预发布 < 正式版
  ['2.0.0', '2.0.0-rc.1', 1],
  ['2.0.0-rc.1', '2.0.0-rc.2', -1],     // 数字段数值比较
  ['2.0.0-alpha', '2.0.0-alpha.1', -1], // 段数少者更小
  ['2.0.0-alpha.1', '2.0.0-alpha.beta', -1], // 数字段 < 字母段
  ['1.0.0+build.1', '1.0.0', 0],        // 构建元数据忽略
  ['2.1.201 (Claude Code)', '2.1.202', -1], // 含杂质的版本输出
];

let failed = 0;
for (const [a, b, expected] of cases) {
  const got = compareSemver(a, b);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} compareSemver(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got} (期望 ${expected})`);
}
console.log(failed ? `${failed} 个用例失败` : '全部通过');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 运行验证脚本确认失败**

Run: `node scripts/verify-semver.js`
Expected: 退出码 1，输出 `未找到函数: comparePrerelease`

- [ ] **Step 3: 修改 main.js —— parseSemver 提取预发布标识**

将 `main.js` 中的 `parseSemver`（含 JSDoc）：

```js
/**
 * 解析 semver 的 major.minor.patch（忽略预发布与构建元数据做数值比较）
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
function parseSemver(version) {
  if (!version) return null;
  const cleaned = String(version).trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}
```

替换为：

```js
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
```

- [ ] **Step 4: 修改 main.js —— 新增 comparePrerelease 并更新 compareSemver**

将 `compareSemver`（含 JSDoc）：

```js
/**
 * 比较两个版本号
 * @returns {number|null} -1: a<b, 0: a==b, 1: a>b, null: 无法比较
 */
function compareSemver(a, b) {
  const pa = parseSemver(extractVersionNumber(a) || a);
  const pb = parseSemver(extractVersionNumber(b) || b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}
```

替换为：

```js
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
    if (na !== null && nb !== null) {
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
```

- [ ] **Step 5: 运行验证脚本确认通过**

Run: `node scripts/verify-semver.js`
Expected: 全部 11 个用例 PASS，输出 `全部通过`，退出码 0

- [ ] **Step 6: 语法校验**

Run: `node --check main.js && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add main.js scripts/verify-semver.js
git commit -m "fix: compare semver prerelease per spec (2.0.0-rc.1 < 2.0.0)"
```

---

### Task 3: B8 — refreshProcessPath 合并而非覆盖

**Files:**
- Modify: `main.js`（`refreshProcessPath` win32 分支，第 550-554 行）

- [ ] **Step 1: 修改合并逻辑**

将：

```js
      const parts = [machinePath, userPath].filter(Boolean);
      if (parts.length) {
        process.env.Path = parts.join(';');
        process.env.PATH = process.env.Path;
      }
```

替换为：

```js
      const registryParts = [machinePath, userPath]
        .filter(Boolean)
        .join(';')
        .split(';')
        .filter(Boolean);
      if (registryParts.length) {
        // 合并而非覆盖：注册表 PATH 在前，保留当前进程继承的额外条目（如便携运行时注入的路径）
        const currentParts = (process.env.Path || process.env.PATH || '').split(';').filter(Boolean);
        const seen = new Set(registryParts.map(p => p.toLowerCase()));
        const extras = currentParts.filter(p => !seen.has(p.toLowerCase()));
        const merged = [...registryParts, ...extras].join(';');
        process.env.Path = merged;
        process.env.PATH = merged;
      }
```

- [ ] **Step 2: 语法校验**

Run: `node --check main.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "fix: merge registry PATH instead of overwriting process PATH"
```

---

### Task 4: B2 + B3 — 窗口/托盘生命周期修复

**Files:**
- Modify: `main.js`（`createWindow` close 处理第 209-215 行；`createTray` 第 241-285 行；通知点击第 315-320 行）

- [ ] **Step 1: createWindow 的 close 事件——未开启托盘最小化时销毁托盘**

将：

```js
  // 关闭窗口时最小化到托盘（如果用户开启了该选项且托盘已创建）
  mainWindow.on('close', (event) => {
    const settings = loadSettings();
    if (settings.minimizeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
```

替换为：

```js
  // 关闭窗口时最小化到托盘（如果用户开启了该选项且托盘已创建）
  mainWindow.on('close', (event) => {
    const settings = loadSettings();
    if (settings.minimizeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // 用户未开启"最小化到托盘"：关窗即退出，先销毁托盘避免应用变僵尸进程
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
```

- [ ] **Step 2: 新增 showOrCreateWindow 与 sendTriggerCheck**

在 `createWindow` 函数结束之后、`// ===== 系统托盘 =====` 注释之前插入：

```js
/**
 * 显示已有窗口或重建新窗口（窗口被销毁后，托盘动作仍可恢复界面）
 * @returns {BrowserWindow|null}
 */
function showOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  createWindow();
  return mainWindow;
}

/**
 * 向渲染进程发送"立即检测"指令
 * 窗口刚重建时页面尚未加载完成，等 did-finish-load 再发，避免渲染进程未绑定监听而丢消息
 */
function sendTriggerCheck() {
  const win = showOrCreateWindow();
  if (!win) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('trigger-check');
      }
    });
  } else {
    win.webContents.send('trigger-check');
  }
}

```

- [ ] **Step 3: 托盘菜单改用新函数**

将 `createTray` 中：

```js
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '立即检测更新',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        // 通知渲染进程执行检测
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('trigger-check');
        }
      }
    },
```

替换为：

```js
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        showOrCreateWindow();
      }
    },
    {
      label: '立即检测更新',
      click: () => {
        sendTriggerCheck();
      }
    },
```

并将双击处理：

```js
  // 双击托盘图标恢复窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
```

替换为：

```js
  // 双击托盘图标恢复窗口（窗口已销毁时重建）
  tray.on('double-click', () => {
    showOrCreateWindow();
  });
```

- [ ] **Step 4: 后台检测通知点击改用新函数**

将 `startBackgroundCheck` 中：

```js
        notification.on('click', () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        });
```

替换为：

```js
        notification.on('click', () => {
          showOrCreateWindow();
        });
```

- [ ] **Step 5: 语法校验**

Run: `node --check main.js && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "fix: recreate window from tray after close; quit cleanly when tray minimize disabled"
```

---

### Task 5: B4 — XSS 转义

**Files:**
- Modify: `script.js`（`escapeHtml` 第 827-832 行；`renderTools` 模板第 432-453 行；`appendLog` 第 767-771 行）

- [ ] **Step 1: escapeHtml 补转义引号**

将：

```js
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

替换为：

```js
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: renderTools 模板转义 tool.name / 版本号 / tool.id**

将 `renderTools` 中的卡片模板：

```js
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
        ${uninstallBtn}
        ${removeBtn}
      </div>
    `;
```

替换为（注意 `title` 属性同样转义）：

```js
    card.innerHTML = `
      <div class="tool-header">
        <h3 class="tool-name">${escapeHtml(tool.name)} ${customBadge}</h3>
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
          <span class="version-value" title="${escapeHtml(tool.latestVersion || '')}">${escapeHtml(tool.latestVersion || '-')}</span>
        </div>
      </div>
      <div class="tool-actions">
        ${actionBtn}
        ${uninstallBtn}
        ${removeBtn}
      </div>
    `;
```

同函数内 4 处按钮模板中的 `data-id="${tool.id}"` 全部改为 `data-id="${escapeHtml(tool.id)}"`（btn-update、btn-install、btn-uninstall、btn-remove）。

- [ ] **Step 3: appendLog 转义工具名**

将：

```js
    div.innerHTML = `
      <span class="log-time">[${t}]</span>
      <span class="log-tool">${toolName}</span>
      <span class="log-message">${escapeHtml(line)}</span>
    `;
```

替换为：

```js
    div.innerHTML = `
      <span class="log-time">[${t}]</span>
      <span class="log-tool">${escapeHtml(toolName)}</span>
      <span class="log-message">${escapeHtml(line)}</span>
    `;
```

- [ ] **Step 4: 语法校验**

Run: `node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add script.js
git commit -m "fix: escape tool name/version in card and log rendering (XSS)"
```

---

### Task 6: B5 骨架屏真实工具列表 + B7 日志空提示

**Files:**
- Modify: `script.js`（`init` 第 56-69 行；`renderSkeleton` 第 333-361 行；`clearLog` 第 752-754 行；`appendLog` 第 756 行附近）

- [ ] **Step 1: init 加载真实工具列表渲染骨架**

将：

```js
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
```

替换为：

```js
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
```

- [ ] **Step 2: renderSkeleton 改为数据驱动**

将 `renderSkeleton` 整个函数：

```js
// ===== 渲染骨架屏 =====
function renderSkeleton() {
  toolsGrid.innerHTML = '';
  const names = ['Kimi Code', 'Claude Code', 'OpenAI Codex', 'OpenCode', 'CodeBuddy', 'Qwen Code', 'Antigravity CLI', 'AtomCode', 'Qoder CLI', 'Qoder CLI (国内镜像)', 'Grok CLI'];
  for (const name of names) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
      <div class="tool-header">
        <h3 class="tool-name">${name}</h3>
        ...
      </div>
      ...
    `;
    toolsGrid.appendChild(card);
  }
}
```

替换为：

```js
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
```

- [ ] **Step 3: B7 — appendLog 移除空提示**

在 `appendLog` 函数体的第一行（`if (!message || message.trim() === '') return;` 之后）插入：

```js
  // 首条日志到来时移除空状态提示
  const emptyHint = logContainer.querySelector('.log-empty');
  if (emptyHint) emptyHint.remove();
```

- [ ] **Step 4: B7 — clearLog 恢复空提示**

将：

```js
function clearLog() {
  logContainer.innerHTML = '';
}
```

替换为：

```js
function clearLog() {
  logContainer.innerHTML = '<div class="log-empty">点击「检测版本」开始</div>';
}
```

- [ ] **Step 5: 语法校验**

Run: `node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add script.js
git commit -m "fix: render skeleton from real tool list; clear log empty hint on first entry"
```

---

### Task 7: CSP 加固 + 死代码清理

**Files:**
- Modify: `index.html`（head 第 5-6 行后）
- Modify: `main.js`（删除 `install-all` 第 1108-1120 行、`update-all` 第 1122-1134 行 handler）
- Modify: `preload.js`（删除 `updateAll`/`installAll` 第 24-28 行）

- [ ] **Step 1: index.html 增加 CSP**

在 `<meta name="viewport" ... />` 之后插入：

```html
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:" />
```

- [ ] **Step 2: main.js 删除死 handler**

删除以下两段（含注释）：

```js
// 批量安装未安装的工具（串行执行，避免并发 npm 全局安装冲突）
ipcMain.handle('install-all', async (event, toolIds) => {
  const results = [];
  for (const toolId of toolIds) {
    try {
      const result = await doInstallOrUpdate(toolId);
      results.push({ toolId, ...result });
    } catch (err) {
      results.push({ toolId, success: false, message: err.message });
    }
  }
  return results;
});

// 更新全部可更新工具（串行执行，逐个返回结果）
ipcMain.handle('update-all', async (event, toolIds) => {
  const results = [];
  for (const toolId of toolIds) {
    try {
      const result = await doInstallOrUpdate(toolId);
      results.push({ toolId, ...result });
    } catch (err) {
      results.push({ toolId, success: false, message: err.message });
    }
  }
  return results;
});
```

- [ ] **Step 3: preload.js 删除对应暴露**

删除：

```js
  // 更新多个工具
  updateAll: (toolIds) => ipcRenderer.invoke('update-all', toolIds),

  // 批量安装未安装的工具
  installAll: (toolIds) => ipcRenderer.invoke('install-all', toolIds),
```

- [ ] **Step 4: 验证死代码确已移除且渲染端不依赖**

Run: `grep -c "update-all\|install-all" main.js; grep -n "electronAPI.updateAll\|electronAPI.installAll" script.js; node --check main.js && node --check preload.js && echo OK`
Expected: 第一条输出 `0`；第二条无输出（渲染端本地函数 `updateAll`/`installAll` 保留，不经过 IPC）；最后输出 `OK`

- [ ] **Step 5: Commit**

```bash
git add index.html main.js preload.js
git commit -m "chore: add CSP meta; remove unused update-all/install-all IPC"
```

---

### Task 8: 阶段一构建验证（B1 直接证据）

**Files:** 无（仅验证）

- [ ] **Step 1: 构建**

Run: `npm run build:win`
Expected: 成功产出 `dist/AI Code Tool Updater Setup 1.0.0.exe` 与便携版

- [ ] **Step 2: 检查 asar 内含图标**

Run: `node_modules/.bin/asar list dist/win-unpacked/resources/app.asar | grep "build/icon"`
Expected 输出包含：

```
/build/icon.ico
/build/icon.png
```

若两条都在，B1 修复确认生效。

---

## 阶段二：功能增强

### Task 9: F1 — 状态排序 + 统计摘要

**Files:**
- Modify: `index.html`（`<main class="main">` 内、`tools-grid` 之前）
- Modify: `script.js`（`renderTools` 整体重写）
- Modify: `style.css`（追加样式）

- [ ] **Step 1: index.html 增加统计条**

在 `<main class="main">` 之后、`<div id="tools-grid" class="tools-grid">` 之前插入：

```html
            <div id="stats-bar" class="stats-bar" style="display: none;">
                <span class="stat-chip stat-chip-update">🚀 <b id="stat-update">0</b> 可更新</span>
                <span class="stat-chip stat-chip-install">📦 <b id="stat-install">0</b> 未安装</span>
                <span class="stat-chip stat-chip-latest">✅ <b id="stat-latest">0</b> 最新</span>
                <span class="stat-chip stat-chip-error">⚠️ <b id="stat-error">0</b> 检测失败</span>
            </div>
```

- [ ] **Step 2: script.js 新增 classifyTool 并重写 renderTools**

将 `renderTools` 整个函数（第 363-493 行）替换为以下两个函数：

```js
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

    card.innerHTML = `
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

  btnUpdateAll.disabled = updateCount === 0 || isUpdating;
  // 当有未安装工具且不在更新状态时，启用一键安装
  if (btnInstallAll) btnInstallAll.disabled = installCount === 0 || isUpdating;

  updateStatsBar(stats);
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
```

- [ ] **Step 3: style.css 追加样式**

在文件末尾追加：

```css
/* ========================================
   Stats Bar（检测摘要）
   ======================================== */
.stats-bar {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--surface-card);
}

.stat-chip b {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
}

.stat-chip-update { color: #fbbf24; border-color: rgba(245, 158, 11, 0.25); background: rgba(245, 158, 11, 0.08); }
.stat-chip-install { color: #a5b4fc; border-color: rgba(99, 102, 241, 0.25); background: rgba(99, 102, 241, 0.08); }
.stat-chip-latest { color: #34d399; border-color: rgba(16, 185, 129, 0.25); background: rgba(16, 185, 129, 0.08); }
.stat-chip-error { color: #f87171; border-color: rgba(239, 68, 68, 0.25); background: rgba(239, 68, 68, 0.08); }

/* 可更新时"最新"版本号高亮 */
.version-highlight { color: var(--warning); font-weight: 700; }
```

- [ ] **Step 4: 语法校验**

Run: `node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add index.html script.js style.css
git commit -m "feat: sort cards by status and add summary stats bar"
```

---

### Task 10: F2 — 卡片级进度反馈

**Files:**
- Modify: `script.js`（`renderTools` 模板、`updateUIState`、`updateAll`、`installAll`）
- Modify: `style.css`（追加样式）

- [ ] **Step 1: 卡片模板加进度条元素**

在 `renderTools` 的 `card.innerHTML` 模板中，将：

```js
    card.innerHTML = `
      <div class="tool-header">
```

改为：

```js
    card.innerHTML = `
      <div class="card-progress"></div>
      <div class="tool-header">
```

- [ ] **Step 2: updateUIState 动作按钮替换为 spinner**

将 `updateUIState` 整个函数替换为：

```js
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
```

- [ ] **Step 3: updateAll 批量进度计数**

将 `updateAll` 整个函数替换为：

```js
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
```

- [ ] **Step 4: installAll 批量进度计数**

将 `installAll` 整个函数替换为：

```js
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
```

- [ ] **Step 5: style.css 追加样式**

在文件末尾追加：

```css
/* ========================================
   卡片执行中进度反馈
   ======================================== */
.card-progress {
  display: none;
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 2px;
  overflow: hidden;
}

.tool-card.updating .card-progress { display: block; }

.card-progress::after {
  content: '';
  position: absolute;
  top: 0; left: -40%;
  width: 40%; height: 100%;
  background: linear-gradient(90deg, transparent, var(--primary-light), transparent);
  animation: progressSlide 1.2s ease-in-out infinite;
}

@keyframes progressSlide {
  to { left: 100%; }
}

/* Spinner（按钮内） */
.spinner {
  display: inline-block;
  width: 12px; height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 6: 语法校验**

Run: `node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add script.js style.css
git commit -m "feat: card-level progress bar, button spinner, batch progress counter"
```

---

### Task 11: F3 — 日志过滤与搜索

**Files:**
- Modify: `index.html`（`log-header` 区域）
- Modify: `script.js`（日志状态、DOM 引用、`bindEvents`、`appendLog`/`clearLog`/`getLogText` 重写、`renderTools` 末尾）
- Modify: `style.css`（追加样式）

- [ ] **Step 1: index.html log-header 加过滤控件**

将：

```html
                <div class="log-header">
                    <h2>实时日志</h2>
                    <div class="log-actions">
```

替换为：

```html
                <div class="log-header">
                    <h2>实时日志</h2>
                    <div class="log-filters">
                        <select id="log-filter-level" class="log-filter-select" title="按级别筛选">
                            <option value="">全部级别</option>
                            <option value="info">info</option>
                            <option value="success">success</option>
                            <option value="error">error</option>
                            <option value="start">start</option>
                            <option value="data">data</option>
                        </select>
                        <select id="log-filter-tool" class="log-filter-select" title="按工具筛选">
                            <option value="">全部工具</option>
                        </select>
                        <input id="log-search" type="text" class="log-search-input" placeholder="搜索日志..." />
                    </div>
                    <div class="log-actions">
```

- [ ] **Step 2: script.js 增加 DOM 引用与日志状态**

在 DOM 元素声明区（`const btnDismissEnv = ...` 之后、`const envNode = ...` 之前）插入：

```js
const logFilterLevel = document.getElementById('log-filter-level');
const logFilterTool = document.getElementById('log-filter-tool');
const logSearch = document.getElementById('log-search');
```

在状态变量区（`let previousRegistryUrl = '';` 之后）插入：

```js
// ===== 日志数据（过滤视图的数据源；复制/导出始终作用于全部条目） =====
const MAX_LOG_ENTRIES = 2000; // 上限，防止长时间运行内存无限增长
const logEntries = [];
const logFilters = { level: '', tool: '', keyword: '' };
```

- [ ] **Step 3: bindEvents 绑定过滤器**

在 `bindEvents` 函数末尾（`}` 之前）插入：

```js
  // 日志过滤
  logFilterLevel.addEventListener('change', () => { logFilters.level = logFilterLevel.value; renderLogs(); });
  logFilterTool.addEventListener('change', () => { logFilters.tool = logFilterTool.value; renderLogs(); });
  logSearch.addEventListener('input', () => { logFilters.keyword = logSearch.value; renderLogs(); });
```

- [ ] **Step 4: 重写 appendLog / clearLog / getLogText，新增 renderLogs / buildLogLine / updateLogToolFilter**

将现有的 `clearLog`、`appendLog`、`getLogText` 三个函数整体替换为：

```js
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
```

注意：这一步同时移除了 Task 6 中 `appendLog` 里的 `emptyHint` 处理——`renderLogs` 已统一接管空提示。

- [ ] **Step 5: renderTools 末尾同步工具过滤器**

在 `renderTools` 中 `updateStatsBar(stats);` 之后插入一行：

```js
  updateLogToolFilter();
```

- [ ] **Step 6: style.css 追加样式**

在文件末尾追加：

```css
/* ========================================
   日志过滤器
   ======================================== */
.log-header { gap: 12px; }

.log-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
}

.log-filter-select {
  appearance: none;
  -webkit-appearance: none;
  background: rgba(8, 14, 26, 0.5);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 4px 20px 4px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  outline: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 10 10'%3E%3Cpath fill='%2364748b' d='M5 7L0.5 2.5h9z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
}

.log-filter-select:hover,
.log-filter-select:focus { border-color: var(--primary); color: var(--text); }

.log-search-input {
  background: rgba(2, 5, 14, 0.5);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text);
  outline: none;
  width: 140px;
  transition: var(--transition);
}

.log-search-input::placeholder { color: var(--text-muted); }

.log-search-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}
```

- [ ] **Step 7: 语法校验**

Run: `node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 8: Commit**

```bash
git add index.html script.js style.css
git commit -m "feat: log filtering by level/tool and keyword search"
```

---

### Task 12: F4 — 开机自启 + changelog 链接 + 静默后台检测

**Files:**
- Modify: `main.js`（`SCRIPT_INSTALLED_TOOLS` 上移并接入 `getAllTools`、`applyLoginItem`、生命周期、`save-settings`、`checkTool`/`checkLocalVersion`/`startBackgroundCheck` 静默化）
- Modify: `index.html`（设置模态框）
- Modify: `script.js`（设置读写、`renderTools` changelog 链接）
- Modify: `style.css`（追加样式）

- [ ] **Step 1: main.js —— SCRIPT_INSTALLED_TOOLS 上移到 BUILTIN_TOOLS 之后**

删除原位置（`// ===== 卸载执行 =====` 注释之后）的：

```js
// 通过官方安装脚本安装的工具：无统一卸载命令，提供文档链接引导
const SCRIPT_INSTALLED_TOOLS = {
  antigravity: { docsUrl: 'https://antigravity.google/' },
  atomcode: { docsUrl: 'https://atomgit.com/' },
  qoder: { docsUrl: 'https://qoder.com/' },
  qoder_cn: { docsUrl: 'https://qoder.com.cn/' },
  grok: { docsUrl: 'https://x.ai/' }
};
```

并在 `// ===== 自定义工具持久化 =====` 注释之前插入同一段内容（保持一字不差）。

- [ ] **Step 2: getAllTools 输出附带 docsUrl**

将 `getAllTools` 末尾的：

```js
    return {
      ...t,
      updateCmd
    };
```

替换为：

```js
    return {
      ...t,
      updateCmd,
      // 脚本安装工具附带官网链接（渲染层 changelog 入口）；npm 工具由渲染层用 pkg 拼 npmjs 链接
      docsUrl: SCRIPT_INSTALLED_TOOLS[t.id] ? SCRIPT_INSTALLED_TOOLS[t.id].docsUrl : null
    };
```

- [ ] **Step 3: main.js —— applyLoginItem 与生命周期恢复设置**

在 `// ===== 应用生命周期 =====` 注释之后、`app.whenReady()` 之前插入：

```js
/**
 * 应用/取消开机自启动
 * 仅打包版生效：dev 模式下 setLoginItemSettings 会指向 electron.exe，直接跳过
 * @param {boolean} openAtLogin
 */
function applyLoginItem(openAtLogin) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!openAtLogin });
  } catch { /* 平台不支持时静默忽略 */ }
}

```

并将：

```js
// Electron 就绪后创建窗口、托盘并启动后台检测
app.whenReady().then(() => {
  createWindow();
  createTray();
  startBackgroundCheck();
});
```

替换为：

```js
// Electron 就绪后创建窗口、托盘并启动后台检测
app.whenReady().then(() => {
  createWindow();
  createTray();
  startBackgroundCheck();
  // 恢复用户的开机自启动设置（仅打包版实际生效）
  const settings = loadSettings();
  if (settings.openAtLogin) {
    applyLoginItem(true);
  }
});
```

- [ ] **Step 4: save-settings handler 应用开机自启**

将：

```js
// 保存设置，如果后台检测间隔有变化则重启定时器
ipcMain.handle('save-settings', (event, newSettings) => {
  saveSettings(newSettings);
  if ('backgroundCheckHours' in newSettings) {
    startBackgroundCheck();
  }
  return { success: true };
});
```

替换为：

```js
// 保存设置，如果后台检测间隔有变化则重启定时器，开机自启变化则应用登录项
ipcMain.handle('save-settings', (event, newSettings) => {
  saveSettings(newSettings);
  if ('backgroundCheckHours' in newSettings) {
    startBackgroundCheck();
  }
  if ('openAtLogin' in newSettings) {
    applyLoginItem(newSettings.openAtLogin);
  }
  return { success: true };
});
```

- [ ] **Step 5: checkLocalVersion 支持静默模式**

将 `checkLocalVersion` 签名行：

```js
async function checkLocalVersion(tool) {
```

替换为：

```js
async function checkLocalVersion(tool, options = {}) {
  // 静默模式（后台定时检测）不输出日志，避免刷屏
  const log = options.silent ? () => {} : sendLog;
```

并将该函数内 3 处 atomcode 分支的 `sendLog(` 改为 `log(`（`检测本地路径`、`检测到本地版本`、`执行全路径检测失败`）。

- [ ] **Step 6: checkTool 支持静默模式并透传**

将 `checkTool` 的 JSDoc 与签名：

```js
/**
 * 检测单个工具的完整版本信息（本地 + 远端并行查询）
 * @param {object} tool - 工具配置对象
 * @returns {Promise<object>} 合并后的检测结果，包含 needsUpdate 标志
 */
async function checkTool(tool) {
  sendLog('info', tool.id, `正在检测 ${tool.name} ...`);
  const [local, remote] = await Promise.all([
    checkLocalVersion(tool),
    checkLatestVersion(tool)
  ]);
```

替换为：

```js
/**
 * 检测单个工具的完整版本信息（本地 + 远端并行查询）
 * @param {object} tool - 工具配置对象
 * @param {object} [options] - { silent } 静默模式不发送日志（后台定时检测使用）
 * @returns {Promise<object>} 合并后的检测结果，包含 needsUpdate 标志
 */
async function checkTool(tool, options = {}) {
  const log = options.silent ? () => {} : sendLog;
  log('info', tool.id, `正在检测 ${tool.name} ...`);
  const [local, remote] = await Promise.all([
    checkLocalVersion(tool, options),
    checkLatestVersion(tool)
  ]);
```

并将该函数末尾的：

```js
  sendLog('success', tool.id, `${tool.name}: ${local.installed ? local.version : '未安装'} -> ${remoteDesc}`);
```

替换为：

```js
  log('success', tool.id, `${tool.name}: ${local.installed ? local.version : '未安装'} -> ${remoteDesc}`);
```

- [ ] **Step 7: startBackgroundCheck 静默执行**

将：

```js
      const tools = getAllTools();
      const results = await Promise.all(tools.map(checkTool));
```

替换为：

```js
      const tools = getAllTools();
      // 后台定时检测静默执行（不刷日志窗口），仅在有更新时弹系统通知
      const results = await Promise.all(tools.map(t => checkTool(t, { silent: true })));
```

- [ ] **Step 8: index.html 设置模态框加开机自启**

在最小化到托盘的 `form-row` 之后插入：

```html
                <div class="form-group form-row">
                    <label class="checkbox-label" for="check-open-at-login">
                        <input id="check-open-at-login" type="checkbox" />
                        <span>开机自动启动（仅安装版生效）</span>
                    </label>
                </div>
```

- [ ] **Step 9: script.js 设置读写**

DOM 声明区（`const checkMinimizeTray = ...` 之后）插入：

```js
const checkOpenAtLogin = document.getElementById('check-open-at-login');
```

`openSettings` 中 `checkMinimizeTray.checked = settings.minimizeToTray !== false;` 之后插入：

```js
    checkOpenAtLogin.checked = !!settings.openAtLogin;
```

将 `saveSettingsFromUI` 整个函数替换为：

```js
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
```

- [ ] **Step 10: script.js renderTools 加 changelog 链接**

在 `renderTools` 中 `const latestClass = ...` 之后插入：

```js
    // changelog 入口：脚本安装工具用官网，npm 工具指向 npmjs 包页
    const changelogUrl = tool.docsUrl || (tool.pkg ? `https://www.npmjs.com/package/${tool.pkg}` : '');
    const changelogLink = changelogUrl
      ? `<button class="changelog-link" data-url="${escapeHtml(changelogUrl)}" title="查看 ${escapeHtml(tool.name)} 更新说明" type="button">🔗</button>`
      : '';
```

并将版本区模板：

```js
        <span class="version-arrow">→</span>
        <div class="version-item">
          <span class="version-label">最新</span>
          <span class="${latestClass}" title="${escapeHtml(tool.latestVersion || '')}">${escapeHtml(tool.latestVersion || '-')}</span>
        </div>
      </div>
```

替换为：

```js
        <span class="version-arrow">→</span>
        <div class="version-item">
          <span class="version-label">最新</span>
          <span class="${latestClass}" title="${escapeHtml(tool.latestVersion || '')}">${escapeHtml(tool.latestVersion || '-')}</span>
        </div>
        ${changelogLink}
      </div>
```

在删除按钮绑定之后插入：

```js
  // 绑定 changelog 链接
  document.querySelectorAll('.changelog-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = e.currentTarget.dataset.url;
      if (url) window.electronAPI.openExternal(url);
    });
  });
```

- [ ] **Step 11: style.css 追加样式**

在文件末尾追加：

```css
/* ===== Changelog 链接 ===== */
.changelog-link {
  flex-shrink: 0;
  align-self: center;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  padding: 2px;
  opacity: 0.55;
  transition: var(--transition);
}

.changelog-link:hover { opacity: 1; transform: scale(1.15); }
```

- [ ] **Step 12: 语法校验**

Run: `node --check main.js && node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 13: Commit**

```bash
git add main.js index.html script.js style.css
git commit -m "feat: open-at-login setting, changelog links, silent background check"
```

---

## 阶段三：UI 优化

### Task 13: 卡片状态边条 + 入场动画 + Esc 关闭模态框 + 布局微调 + README 同步

**Files:**
- Modify: `style.css`（追加/修改）
- Modify: `script.js`（`bindEvents`、`renderTools` 动画延迟）
- Modify: `README.md`（功能特性列表）

- [ ] **Step 1: style.css 卡片状态左边条与入场动画**

在文件末尾追加：

```css
/* ========================================
   卡片状态左边条（配合 renderTools 的 card-* 类）
   ======================================== */
.tool-card { border-left: 3px solid transparent; }
.tool-card.card-update { border-left-color: #fbbf24; }
.tool-card.card-latest { border-left-color: #10b981; }
.tool-card.card-not-installed { border-left-color: rgba(148, 163, 184, 0.35); }
.tool-card.card-error { border-left-color: #f87171; }

/* ========================================
   卡片入场动画（backwards 填充，不干扰 hover 位移）
   ======================================== */
@keyframes cardIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.tool-card { animation: cardIn 0.3s var(--ease) backwards; }
```

- [ ] **Step 2: 卡片区高度微调**

将 `.tools-grid` 的：

```css
  max-height: 44vh;
```

改为：

```css
  max-height: 50vh;
```

- [ ] **Step 3: script.js 卡片入场 stagger**

在 `renderTools` 的 `toolsGrid.appendChild(card);` 之后插入：

```js
    // 入场动画逐张延迟
    card.style.animationDelay = `${sorted.indexOf(tool) * 30}ms`;
```

注意：`sorted.indexOf(tool)` 依赖同一数组引用，正确；不要用 `toolsData.indexOf`。

- [ ] **Step 4: script.js Esc 关闭模态框**

在 `bindEvents` 函数末尾（日志过滤绑定之后）插入：

```js
  // Esc 关闭任意打开的模态框
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalOverlay.style.display === 'flex') closeModal();
    else if (settingsOverlay.style.display === 'flex') closeSettings();
    else if (registryOverlay.style.display === 'flex') cancelCustomRegistry();
  });
```

- [ ] **Step 5: README 功能特性同步**

将 README.md 的：

```markdown
- 自动检测 AI 编程工具本地/远端版本（semver 比较，仅提示真正有更新的工具）
- 一键安装、更新、卸载（npm 全局包）
- 支持多种 AI 编程助手：Kimi、Claude、Codex、OpenCode、CodeBuddy、Qwen、Antigravity、AtomCode、Qoder、Grok 等
- 自定义 npm 工具与自定义镜像源
- 系统托盘、后台定时检测通知、设置页（检测间隔 / 最小化到托盘）
- 实时日志：复制 / 导出
```

替换为：

```markdown
- 自动检测 AI 编程工具本地/远端版本（semver 比较含预发布规则，仅提示真正有更新的工具）
- 一键安装、更新、卸载（npm 全局包）
- 支持多种 AI 编程助手：Kimi、Claude、Codex、OpenCode、CodeBuddy、Qwen、Antigravity、AtomCode、Qoder、Grok 等
- 自定义 npm 工具与自定义镜像源
- 卡片按状态排序（可更新置顶）+ 检测统计摘要、执行中进度反馈、changelog 快捷链接
- 系统托盘、后台静默定时检测通知、设置页（检测间隔 / 最小化到托盘 / 开机自启）
- 实时日志：级别 / 工具筛选、关键词搜索、复制 / 导出
```

- [ ] **Step 6: 语法校验**

Run: `node --check script.js && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add style.css script.js README.md
git commit -m "style: card status edge, stagger animation, esc-to-close, grid height; sync README"
```

---

### Task 14: 最终全量验证

**Files:** 无（仅验证与交付）

- [ ] **Step 1: 全量语法与单元验证**

Run: `node --check main.js && node --check preload.js && node --check script.js && node scripts/verify-semver.js`
Expected: 无语法错误；`全部通过`，退出码 0

- [ ] **Step 2: 构建并验证 asar 图标**

Run: `npm run build:win` 然后 `node_modules/.bin/asar list dist/win-unpacked/resources/app.asar | grep "build/icon"`
Expected: 构建成功；输出包含 `/build/icon.ico` 与 `/build/icon.png`

- [ ] **Step 3: 手动冒烟清单（交付用户在 GUI 中过一遍）**

启动 `npm start`，逐项确认：

1. 启动：骨架屏数量/名称与真实工具一致 → 检测完成后统计条出现且计数与卡片徽章一致
2. 排序：可更新卡片置顶，"最新"版本号黄色高亮；卡片有状态色左边条与逐张入场动画
3. 单工具更新：卡片顶部进度条 + 按钮 spinner + 状态"执行中"；完成后刷新
4. 一键更新全部：按钮显示 `更新中 (n/m)` 计数
5. 日志：级别/工具/关键词过滤生效；清空后恢复空提示；复制/导出内容为全部日志（不受过滤影响）
6. 设置：改检测间隔/最小化到托盘/开机自启 → 保存 → 重开设置页值保持
7. changelog：卡片 🔗 图标打开对应 npm 包页/官网
8. XSS 用例：添加自定义工具名称填 `<img src=x onerror=alert(1)>` → 应显示为纯文本，无弹窗
9. 托盘：开"最小化到托盘"时关窗 → 托盘菜单"显示主窗口"/"立即检测更新"/双击均可恢复；关"最小化到托盘"后关窗 → 应用进程退出（任务管理器无残留）
10. 模态框：Esc 可关闭三个模态框
11. DevTools Console 无 CSP 报错（Google Fonts 正常加载）

- [ ] **Step 4: 打包版冒烟（可选但推荐）**

安装 `dist/AI Code Tool Updater Setup 1.0.0.exe`，确认：窗口图标、托盘图标、通知图标正常显示；托盘菜单工作正常（B1/B2 的最终证据）。
