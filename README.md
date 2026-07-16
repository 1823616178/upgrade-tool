# AI Code Tool Updater

一款基于 Electron 的 AI 编程助手工具更新器，检测最新版本并支持一键更新。

## 功能特性

- 自动检测 AI 编程工具本地/远端版本（semver 比较，仅提示真正有更新的工具）
- 一键安装、更新、卸载（npm 全局包）
- 支持多种 AI 编程助手：Kimi、Claude、Codex、OpenCode、CodeBuddy、Qwen、Antigravity、AtomCode、Qoder、Grok 等
- 自定义 npm 工具与自定义镜像源
- 系统托盘、后台定时检测通知、设置页（检测间隔 / 最小化到托盘）
- 实时日志：复制 / 导出

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
# 构建 Windows 安装包
npm run build:win

# 构建所有平台
npm run build
```

构建产物输出到 `dist/` 目录，支持 NSIS 安装包和便携版（portable）两种格式。

## 技术栈

- [Electron](https://www.electronjs.org/) v31
- [electron-builder](https://www.electron.build/) v24.13.3

## License

MIT
