# AI Code Tool Updater — UI 优化、功能增强与 BUG 修复设计

日期：2026-07-16
范围：BUG 修复（8 项 + 安全加固）+ 功能增强（4 项）+ UI 优化（保留现有设计系统）
实施节奏：三阶段顺序实施，每阶段独立验证

## 背景

Electron 31 桌面应用（原生 JS，无框架无打包器），集中管理本机 AI 编程 CLI 工具的版本检测、安装、更新、卸载。主进程 `main.js`（1487 行）、preload 桥 `preload.js`、渲染层 `index.html` + `script.js` + `style.css`（深色玻璃拟态设计系统，design tokens 完备）。

代码审查发现 8 个真实 BUG，用户确认三项都做：修复全部 BUG、4 项功能增强、UI 优化（改动幅度由实施方判断，结论：保留现有设计系统，不做推倒式改版）。

## 阶段一：BUG 修复

| # | 问题 | 位置 | 修法 |
|---|------|------|------|
| B1 | `files` 未含 `build/`，打包后窗口/托盘/通知图标全部缺失，托盘创建被静默 catch，"最小化到托盘"在正式版失效 | `package.json` | `files` 增加 `build/icon.ico`、`build/icon.png` |
| B2 | 窗口销毁后 `mainWindow = null`，托盘菜单"显示主窗口"/"立即检测更新"/双击/通知点击全部静默失效 | `main.js` | 抽出 `showOrCreateWindow()`：窗口存在则 show+focus，否则重建；"立即检测更新"在重建窗口时等 `did-finish-load` 后再发 `trigger-check`，避免渲染进程未绑定监听丢消息 |
| B3 | `minimizeToTray === false` 时关窗，窗口销毁但托盘仍在，应用变僵尸（只能退出） | `main.js` close 事件 | 该设置关闭时，关窗即销毁托盘并允许正常退出（`window-all-closed` 时 `!tray` → `app.quit()`） |
| B4 | 卡片渲染用 `innerHTML` 拼接未转义的 `tool.name`、版本号；日志区 `log-tool` 同样未转义 | `script.js` | 统一 `escapeHtml`；补转义 `"` 和 `'`（`title` 属性场景） |
| B5 | `renderSkeleton` 硬编码 11 个工具名，与 `BUILTIN_TOOLS` 及自定义工具不同步 | `script.js` | `init()` 先 `get-tools` 取真实列表，再按列表渲染骨架 |
| B6 | `compareSemver` 忽略预发布版本，`2.0.0-rc.1` 被判等于 `2.0.0` | `main.js` | `parseSemver` 提取预发布标识，按 semver 规则比较：同 major.minor.patch 时无预发布 > 有预发布；都有预发布逐段比较（数字段数值比，字母段字典序） |
| B7 | 日志区"点击「检测版本」开始"空提示在首条日志后仍残留 | `script.js` | `appendLog` 时移除 `.log-empty`，`clearLog` 时恢复 |
| B8 | `refreshProcessPath` 用注册表 PATH 整体覆盖 `process.env.Path`，丢失进程继承的额外路径 | `main.js` | 改为合并：注册表 PATH 在前，当前进程独有的多余条目追加在后 |

安全加固（随阶段一落地）：

- `index.html` 增加 CSP meta：`default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:`，与 B4 形成纵深防御
- 死代码清理：删除无人调用的 `update-all` / `install-all` IPC handler（`main.js`）及 preload 对应暴露（渲染端自行串行循环调用 `update-tool`/`install-tool`，不经过这两个 handler）

## 阶段二：功能增强

### F1 状态排序 + 统计摘要

- `renderTools` 前排序：可更新 → 未安装/检测失败（可安装）→ 远端检测失败 → 本地较新 → 最新；同类内保持原顺序（稳定排序）
- 主区域顶部（`tools-grid` 上方）新增统计条：彩色徽章显示 X 可更新 · Y 未安装 · Z 最新 · W 检测失败；首次检测完成前不显示
- 统计条仅展示，不做点击过滤（YAGNI）

### F2 卡片级进度反馈

- 执行中的卡片：顶部加 indeterminate 进度条动画，动作按钮替换为 spinner
- 批量执行（一键更新/安装全部）：工具栏按钮文本显示进度计数 `执行中 (2/5)`
- 复用现有 `isUpdating` 状态机，新增批量进度计数变量

### F3 日志过滤与搜索

- 日志数据落入 `logEntries[]` 数组（`{type, toolId, message, time}`），上限 2000 条，超出从头部截断
- 日志区 header 增加：级别筛选（全部/info/success/error/start/data）、工具筛选（system + 动态工具列表）、关键词搜索输入框
- 过滤只影响视图渲染；复制/导出始终作用于全部日志，不受过滤器影响
- `clearLog` 清空数组并恢复空提示（与 B7 衔接）

### F4 实用小功能

- 设置页增加"开机自启动"复选框：`app.setLoginItemSettings({ openAtLogin })`，仅 `app.isPackaged` 时实际生效（dev 模式保存设置但不应用，避免指向 electron.exe）；启动时读取设置并应用
- 卡片"最新版本"旁加 changelog 链接图标：npm 工具 → `https://www.npmjs.com/package/<pkg>`；脚本安装工具（antigravity/atomcode/qoder/qoder_cn/grok）→ 各自官网（复用 `SCRIPT_INSTALLED_TOOLS` 的 `docsUrl`，并入工具配置输出）
- 后台定时检测改为静默执行（`checkTool` 增加 silent 参数，不 `sendLog`），仅在发现有更新时弹系统通知，避免后台检测向日志窗口刷屏
- 检测前自动刷新 PATH：现有逻辑已具备（`check-versions` handler 调 `refreshProcessPath`），无需改动

## 阶段三：UI 优化

保留现有深色玻璃拟态设计系统与 design tokens，做结构化增量优化：

- 新增统计条、日志过滤栏、卡片进度条、spinner 的样式，全部复用现有 tokens（颜色、圆角、动效曲线）
- 工具卡片加状态色左边条（`border-left` 3px，随状态类变色）；"可更新"卡片的"最新"版本号用 warning 色高亮
- 卡片入场 stagger 动画（逐张淡入上移）；模态框支持 Esc 键关闭
- 卡片区与日志区空间分配微调：`tools-grid` 的 `max-height` 由 44vh 放宽至 50vh
- 不引入新字体、新色板、新布局框架

## 数据流与接口变化

- `getAllTools()` 输出增加 `docsUrl` 字段（脚本安装工具）——供 F4 changelog 链接使用
- `checkTool(tool)` 签名变为 `checkTool(tool, { silent })`——后台定时检测传 silent
- preload 删除 `updateAll` / `installAll` 两个暴露（配合死代码清理）
- 设置项新增 `openAtLogin`（布尔，默认 false）、`minimizeToTray`/`backgroundCheckHours` 语义不变

## 错误处理

- `showOrCreateWindow()` 中窗口重建失败不阻断托盘其他动作
- CSP 若误伤 Google Fonts 加载，回退字体链已存在（`font-family` 有系统字体兜底），功能不受影响
- 日志数组截断逻辑保证长时间运行内存有界
- 开机自启动在非打包环境下仅保存设置不调用 API，避免 dev 模式污染登录项

## 验证

项目无测试框架，不引入（YAGNI）。采用手动冒烟清单：

1. `npm start` 全链路：环境检测 → 版本检测（骨架屏 → 卡片 + 统计条）→ 单工具安装/更新/卸载 → 一键更新全部（进度计数）→ 日志级别/工具/关键词过滤 → 复制/导出日志 → 设置保存（含开机自启）→ 自定义工具增删（含 XSS 用例：名称填 `<img src=x onerror=alert(1)>`）→ 自定义镜像源
2. 托盘行为：关窗最小化到托盘 → 托盘菜单显示主窗口/立即检测；关闭"最小化到托盘"后关窗应正常退出；托盘退出
3. `npm run build:win` 后检查 `dist/win-unpacked/resources/app.asar` 内含 `build/icon.ico` 与 `build/icon.png`（B1 直接证据），安装版窗口/托盘/通知图标正常

## 明确不做（YAGNI）

- 工具配置的表驱动大重构（特判分支散布 4 处的问题留作后续专项）
- 主题切换（明暗色）、卡片搜索/过滤、可拖拽分栏
- 统计条点击过滤、测试框架引入
