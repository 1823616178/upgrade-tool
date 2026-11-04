# AI Code Tool Updater

一款基于 Electron 的 AI 编程助手工具更新器，检测最新版本并支持一键更新。

## 仓库地址

- Git 仓库：<https://cnb.cool/kakusun/upload-tool-client.git>
- 项目主页：<https://cnb.cool/kakusun/upload-tool-client>

## 功能特性

- 自动检测 AI 编程工具本地/远端版本（semver 比较含预发布规则，仅提示真正有更新的工具）
- 一键安装、更新、卸载（npm 全局包）
- 支持多种 AI 编程助手：Kimi、Claude、Cline、Codex、OpenCode、CodeBuddy、Qwen、Antigravity、AtomCode、Qoder、Grok、Command Code、MiMo Code 等
- 自定义 npm 工具与自定义镜像源
- 卡片按状态排序（可更新置顶）+ 检测统计摘要、执行中进度反馈、changelog 快捷链接
- 系统托盘、后台静默定时检测通知、设置页（检测间隔 / 最小化到托盘 / 开机自启 / 启动最小化）
- 实时日志：级别 / 工具筛选、关键词搜索、复制 / 导出、面板高度拖拽（双击复位）
- 镜像源测速与一键自动切换最快源、工具 emoji 徽章、Markdown 版本报告导出

## 安装

```bash
npm install
```

## 一键配置 agyyolo（Windows）

在别的 Windows 电脑上，把本项目复制过去后，双击运行：

```
setup-agyyolo.bat
```

即可将以下函数永久写入当前用户的 PowerShell Profile，使其在新开的 PowerShell 窗口中直接可用：

```powershell
function agyyolo {
    agy --dangerously-skip-permissions
}
```

脚本会自动处理 PowerShell 5.1 与 PowerShell 7+ 的配置文件，并避免重复写入。

> 注意：本脚本只配置函数，不检查 `agy` 命令本身是否在 PATH 中。如果运行时提示找不到 `agy`，请先将 `agy` 所在目录加入系统环境变量 `Path`。

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

# 构建所有平台
npm run build
```

构建产物输出到 `dist/` 目录，Windows 支持 NSIS 安装包和便携版（portable），macOS 支持 dmg 和 zip（x64 / arm64）。

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
