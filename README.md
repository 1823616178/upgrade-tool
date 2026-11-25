# AI Code Tool Updater

一款基于 Electron 的 AI 编程助手工具更新器，检测最新版本并支持一键更新。

## 仓库地址

- Git 仓库：<https://cnb.cool/kakusun/upload-tool-client.git>
- 项目主页：<https://cnb.cool/kakusun/upload-tool-client>

## 功能特性

- 自动检测 AI 编程工具本地/远端版本（semver 比较含预发布规则，仅提示真正有更新的工具）
- 一键安装、更新、卸载（npm 全局包）
- 支持多种 AI 编程助手：Kimi、Claude、Cline、Cursor、Codex、OpenCode、CodeBuddy、Qwen、Antigravity、AtomCode、Qoder、Grok、Command Code、MiMo Code、CNB CLI 等
- 自定义 npm 工具与自定义镜像源
- npm 更新先从所选 HTTPS registry 解析版本，再安装精确版本；官方安装脚本先下载到临时文件并检查 HTTPS/响应完整性后执行
- 卡片按状态排序（可更新置顶）+ 检测统计摘要、执行中进度反馈、changelog 快捷链接
- 系统托盘、后台静默定时检测通知、设置页（检测间隔 / 最小化到托盘 / 开机自启 / 启动最小化）
- 实时日志：级别 / 工具筛选、关键词搜索、复制 / 导出、面板高度拖拽（双击复位）
- 镜像源测速与一键自动切换最快源、工具 emoji 徽章、Markdown 版本报告导出

## 安装

```bash
npm install
```

镜像源只接受 HTTPS；npm 工具安装前会从当前 registry 解析精确版本，不再使用可变的 `latest` 标签执行安装。厂商脚本会先从内置的官方 HTTPS 地址完整下载到受限临时文件，检查响应、大小和长度，再由本地解释器执行；下载失败时不会执行。以上措施不等于独立签名或可信哈希校验，仍需信任所选 registry、厂商及其依赖。

## 一键配置 agyyolo（Windows）

在别的 Windows 电脑上，把本项目复制过去后，双击运行：

```
setup-agyyolo.bat
```

脚本会先说明风险，并要求输入 `YES` 才继续；默认取消，不会修改任何 Profile。它会将以下函数写入当前用户的 PowerShell Profile：

```powershell
function agyyolo {
    agy --dangerously-skip-permissions
}
```

该命令会跳过 `agy` 的逐项权限确认，可能允许它直接修改文件或运行命令。安装会检查 `agy` 是否可用，并支持 PowerShell 5.1 与 PowerShell 7+ 的用户 Profile；写入采用临时文件替换，任一路径失败都会显示为失败。已有 UTF-8 BOM 会保留，无法安全解码的 Profile 不会被覆盖。

如需撤销，在同一目录运行 `setup-agyyolo.bat -Remove`，并输入 `REMOVE` 确认。应用内的“撤销 yolo”按钮也会移除本工具标记的代码块；不会删除其他 Profile 内容。无法识别为本工具配置的同名函数，以及被改写、重复或损坏的管理块都会原样保留并报告冲突。

## 开发

```bash
npm start
```

## 构建

```bash
# 构建 Windows 安装包（不签名）
npm run build:win

# Windows 自签名 + 打包
npm run sign:win

# 构建 macOS 安装包（需在 macOS 上执行）
npm run build:mac

# 构建当前主机的默认目标（不是跨平台全量构建）
npm run build
```

构建产物输出到 `dist/` 目录。`build:win` 目标为 Windows x64（NSIS 安装包和 portable）；`build:mac` 目标为 macOS x64 / arm64（dmg 和 zip），macOS 目标需在 macOS 上构建。`npm run build` 只按当前构建主机和 electron-builder 默认目标构建，不会自动同时产出 Windows 与 macOS 包。

运行 `npm test` 可执行 JS 语法检查、语义版本与多行版本提取、HTTPS registry 与输入校验、IPC/自定义配置防护、PATH 内存扫描与并发限流、渲染层交互状态（卸载确认/批量过滤/序号合并/模态框内联报错）、`agyyolo`/`cmdcyolo` Profile 可逆管理及 POSIX 子进程组清理回归测试。

### Windows 代码签名

`npm run sign:win` 优先使用 `CSC_KEY_PASSWORD` 环境变量；没有时读取 `build/.cert-password`。两者都不存在且证书已存在时会交互输入密码；首次生成证书会自动生成随机密码并写入 `build/.cert-password`（已 gitignore）。密码不再写入 `package.json`。

### macOS

- Electron 43 最低支持 macOS 11，macOS 13（Ventura）可直接运行。
- 自构建的未签名应用首次启动会被 Gatekeeper 拦截，可右键选择「打开」，或执行 `xattr -cr "/Applications/AI Code Tool Updater.app"`。
- 应用会从登录 shell 读取 PATH，兼容 Homebrew（`/opt/homebrew/bin`）、nvm 等安装的 node/npm；如果仍提示未安装，请确认终端中 `node -v` 可用。

## 技术栈

- [Electron](https://www.electronjs.org/) v43
- [electron-builder](https://www.electron.build/) v26

> 注：Electron 42 起，`npm install` 不再通过 postinstall 下载 Electron 二进制，
> 改为首次运行（`npm start`）时动态下载约 100MB，需保证网络可达。

## License

MIT
