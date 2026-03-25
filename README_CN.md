[English](./README.md) | **中文**

# Antigravity 资源监控器

一款轻量级 macOS 扩展，实时监控 Antigravity 每个窗口的内存占用，**自动检测并杀死泄漏的 `language_server` 进程**，并提供完整的进程管理面板。

> **为什么需要它？** Antigravity 的 `language_server` 在开启新的 AI 对话时可能出现严重的内存泄漏，单次对话即可消耗 10+ GB 内存，导致系统卡死。本扩展自动检测并杀死泄漏进程，保持你的 Mac 流畅运行。

## 功能

### 内存泄漏看门狗

- 每隔几秒检测 `language_server` 的真实内存占用（与活动监视器一致）
- 超过阈值时自动杀死进程（默认 2 GB）
- Antigravity 会无缝重启新的 language server，AI 功能继续可用
- 杀死进程时状态栏会短暂闪烁提示

### 状态栏

- **实时内存显示**：与活动监视器匹配的内存数值
- **颜色提示**：绿色 (< 1 GB)、黄色 (1-2 GB)、红色 (> 2 GB)
- **系统压力**：macOS 内存压力等级 (Normal/Warn/Critical)
- **迷你走势图**：Tooltip 中的 Braille 字符内存趋势

### 进程面板

- 显示所有 Antigravity 工作区及其进程
- 安全关闭远程工作区（原子化进程树清理）
- 检测并批量清理僵尸工作区

## 安装

### 方式一：从 Release 下载（推荐）

1. 从 [Releases](https://github.com/FlorianHuo/antigravity-resource-monitor/releases) 下载最新的 `.vsix` 文件
2. 在 Antigravity 中打开命令面板 (`Cmd+Shift+P`)
3. 运行 `Extensions: Install from VSIX...` 并选择下载的文件
4. 重新加载窗口

### 方式二：手动安装

```bash
git clone https://github.com/FlorianHuo/antigravity-resource-monitor.git
cd antigravity-resource-monitor
npm install
npm run compile

# 复制到 Antigravity 扩展目录
VERSION=$(node -p "require('./package.json').version")
EXT_DIR="$HOME/.antigravity/extensions/florian.antigravity-resource-monitor-${VERSION}"
mkdir -p "$EXT_DIR/out"
cp -f out/extension.js out/extension.js.map "$EXT_DIR/out/"
cp -f package.json "$EXT_DIR/"
```

重新加载 Antigravity 窗口即可激活。

### 可选：屏蔽崩溃通知

看门狗杀死泄漏的 server 后，Antigravity 会弹出错误提示（"server crashed unexpectedly"）。运行以下脚本可以静默这些通知：

```bash
python3 scripts/patch_suppress_crash.py           # 应用补丁
python3 scripts/patch_suppress_crash.py --status   # 查看补丁状态
python3 scripts/patch_suppress_crash.py --restore  # 恢复原始文件
```

该脚本会自动备份原始文件，Antigravity 更新后需重新运行。

## 自定义配置

在 Antigravity 的设置中搜索 `Resource Monitor`：

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `leakWatchdog.enabled` | `true` | 是否启用泄漏看门狗 |
| `leakWatchdog.thresholdMB` | `2048` | 触发杀死进程的内存阈值 (MB) |
| `leakWatchdog.checkIntervalSeconds` | `5` | 检测间隔 (秒) |
| `statusBar.updateIntervalSeconds` | `3` | 状态栏刷新间隔 (秒) |

## 系统要求

- **仅支持 macOS**（使用 `top`、`ps`、`memory_pressure`、`vm_stat` 等 macOS 命令）
- Antigravity（任意近期版本）
- Python 3（仅用于可选的崩溃通知补丁）

## 命令

| 命令 | 说明 |
|------|------|
| `Resource Monitor: Process Dashboard` | 打开进程监控面板 |
| `Resource Monitor: Show Memory Details` | 同上 |
| `Resource Monitor: Toggle Visibility` | 显示/隐藏状态栏指标 |

## 许可证

MIT
