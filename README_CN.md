[English](./README.md) | **中文**

<h1 align="center">
  <br>
  Antigravity 资源监控器
  <br>
</h1>

<p align="center">
  <strong>实时内存监控 &middot; 泄漏自动清理 &middot; 进程管理面板</strong>
</p>

<p align="center">
  <a href="https://github.com/FlorianHuo/antigravity-resource-monitor/releases"><img src="https://img.shields.io/github/v/release/FlorianHuo/antigravity-resource-monitor?style=flat-square&color=blue" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square" alt="macOS">
  <img src="https://img.shields.io/github/license/FlorianHuo/antigravity-resource-monitor?style=flat-square" alt="License">
</p>

---

## 问题

Antigravity 的 `language_server` 在开启新的 AI 对话时，可能出现**严重的内存泄漏**。单次对话就能吃掉 **10+ GB** 内存，导致整个系统卡死。目前没有任何内置保护机制。

## 方案

这个扩展在后台运行一个轻量级监控：

1. **检测** -- 通过 macOS `top` 实时监测 `language_server` 的内存占用（与「活动监视器」一致）
2. **清理** -- 内存超过阈值（默认 2 GB）时立即终止泄漏进程
3. **恢复** -- Antigravity 自动重启新的 server，AI 功能继续可用

全自动，无需任何手动操作。

---

## 功能

### 内存泄漏自动清理

> 后台定时检测 `language_server` 内存。超过阈值时终止进程，Antigravity 在几秒内自动重启。

- 阈值、检测间隔、开关均可在设置中调整
- 清理时右下角状态栏短暂闪烁提示（5 秒）
- 10 秒冷却防止重复触发

### 状态栏

> 实时显示当前窗口的内存占用，按严重程度着色。

- **绿色** < 1 GB &middot; **黄色** 1-2 GB &middot; **红色** > 2 GB
- macOS 内存压力指示 (Normal / Warn / Critical)
- Tooltip 中显示 Braille 字符内存走势

### 进程管理面板

> WebView 面板，显示所有 Antigravity 工作区及进程树。

- 一键关闭远程工作区（自动清理整个进程树）
- 检测僵尸工作区，支持批量清理
- 自定义工作区标签，自动识别对话标题

---

## 快速开始

### 安装

从 [**Releases**](https://github.com/FlorianHuo/antigravity-resource-monitor/releases) 下载 `.vsix` 文件：

```
Cmd+Shift+P > Extensions: Install from VSIX...
```

重新加载窗口。完成 -- 监控自动启动。

### 屏蔽报错弹窗（可选）

清理泄漏进程后 Antigravity 会弹出错误提示，运行以下命令可以屏蔽：

```
Cmd+Shift+P > Resource Monitor: Apply Crash Notification Patch
```

或通过命令行：

```bash
python3 scripts/patch_suppress_crash.py
```

Antigravity 更新后需重新运行。使用 `--restore` 可还原。

---

## 自定义配置

在设置中搜索 **Resource Monitor** (`Cmd+,`)：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `leakWatchdog.enabled` | `true` | 启用/禁用泄漏监控 |
| `leakWatchdog.thresholdMB` | `2048` | 清理阈值（MB） |
| `leakWatchdog.checkIntervalSeconds` | `5` | 检测频率 |
| `statusBar.updateIntervalSeconds` | `3` | 状态栏刷新频率 |

## 命令

| 命令 | 说明 |
|------|------|
| `Process Dashboard` | 打开进程管理面板 |
| `Toggle Visibility` | 显示/隐藏状态栏 |
| `Apply Crash Notification Patch` | 一键屏蔽报错弹窗 |
| `Restore Original Files` | 还原补丁 |

## 系统要求

- **仅支持 macOS**（使用 `top`、`ps`、`memory_pressure`、`vm_stat`）
- Antigravity（任意近期版本）
- Python 3（仅用于可选的报错屏蔽补丁）

---

## 从源码构建

```bash
git clone https://github.com/FlorianHuo/antigravity-resource-monitor.git
cd antigravity-resource-monitor
npm install
npm run deploy   # 编译 + 安装到 ~/.antigravity/extensions/
```

## 许可证

[MIT](./LICENSE)
