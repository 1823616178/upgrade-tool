# AI Code Tool Updater

一款基于 Electron 的 AI 编程助手工具更新器，检测最新版本并支持一键更新。

## 功能特性

- 自动检测 AI 编程工具最新版本
- 一键下载并更新安装
- 支持多种 AI 编程助手（KiMi、Claude、Codex、OpenCode、CodeBuddy、Qwen Code、Gemini CLI 等）
- 简洁直观的桌面端 UI

## 安装

```bash
npm install
```

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
