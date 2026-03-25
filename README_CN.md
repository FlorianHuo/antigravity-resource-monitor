[English](./README.md) | **中文**

# Antigravity 资源监控器

一款轻量级 macOS 扩展，实时监控 Antigravity 的内存占用，**自动检测并清理泄漏的 `language_server` 进程**，同时提供完整的进程管理面板。

> **解决什么问题？** Antigravity 的 `language_server` 在开启新的 AI 对话时可能出现严重的内存泄漏，单次对话就能吃掉 10+ GB 内存，导致整个系统卡死。这个扩展会在后台自动检测并清理泄漏进程，让你的 Mac 保持流畅。

## 核心功能

### 内存泄漏自动清理

- 后台定时检测 `language_server` 的真实内存占用（与「活动监视器」显示一致）
- 一旦超过阈值（默认 2 GB），立即终止泄漏进程
- Antigravity 会自动重启新的 language server，AI 功能继续可用
- 清理时右下角状态栏短暂闪烁提示

### 状态栏监控

- **实时内存**：显示当前窗口的内存占用，与「活动监视器」一致
- **颜色分级**：绿色 (< 1 GB)、黄色 (1-2 GB)、红色 (> 2 GB)
- **系统压力**：显示 macOS 内存压力等级 (Normal / Warn / Critical)
- **迷你趋势图**：Tooltip 中显示 Braille 字符构成的内存变化曲线

### 进程管理面板

- 显示所有 Antigravity 工作区及其进程详情
- 一键关闭远程工作区（自动清理整个进程树）
- 自动检测僵尸工作区，支持批量清理

## 安装

### 方式一：直接下载（推荐）

1. 从 [Releases](https://github.com/FlorianHuo/antigravity-resource-monitor/releases) 下载最新的 `.vsix` 文件
2. 在 Antigravity 中 `Cmd+Shift+P` > `Extensions: Install from VSIX...`
3. 选择下载的文件，重新加载窗口即可

### 方式二：从源码构建

```bash
git clone https://github.com/FlorianHuo/antigravity-resource-monitor.git
cd antigravity-resource-monitor
npm install
npm run compile

# 安装到 Antigravity
VERSION=$(node -p "require('./package.json').version")
EXT_DIR="$HOME/.antigravity/extensions/florian.antigravity-resource-monitor-${VERSION}"
mkdir -p "$EXT_DIR/out"
cp -f out/extension.js out/extension.js.map "$EXT_DIR/out/"
cp -f package.json "$EXT_DIR/"
```

重新加载 Antigravity 窗口即可。

### 可选：屏蔽报错弹窗

清理泄漏进程后，Antigravity 会弹出一些错误提示（"server crashed unexpectedly" 等）。可以通过以下两种方式屏蔽：

**方式一（推荐）：** 在 Antigravity 中 `Cmd+Shift+P` > `Resource Monitor: Apply Crash Notification Patch`

**方式二：** 命令行
```bash
python3 scripts/patch_suppress_crash.py           # 打补丁
python3 scripts/patch_suppress_crash.py --status   # 查看状态
python3 scripts/patch_suppress_crash.py --restore  # 还原
```

补丁会自动备份原始文件。Antigravity 更新后需要重新运行。

## 自定义配置

在 Antigravity 设置中搜索 `Resource Monitor`：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `leakWatchdog.enabled` | `true` | 启用/禁用内存泄漏自动清理 |
| `leakWatchdog.thresholdMB` | `2048` | 触发清理的内存阈值（MB） |
| `leakWatchdog.checkIntervalSeconds` | `5` | 检测间隔（秒） |
| `statusBar.updateIntervalSeconds` | `3` | 状态栏刷新间隔（秒） |

## 系统要求

- **仅支持 macOS**（使用 `top`、`ps`、`memory_pressure` 等系统命令）
- Antigravity（任意近期版本）
- Python 3（仅用于可选的报错屏蔽补丁）

## 命令列表

| 命令 | 说明 |
|------|------|
| `Resource Monitor: Process Dashboard` | 打开进程管理面板 |
| `Resource Monitor: Apply Crash Notification Patch` | 一键屏蔽报错弹窗 |
| `Resource Monitor: Toggle Visibility` | 显示/隐藏状态栏 |

## 许可证

MIT
