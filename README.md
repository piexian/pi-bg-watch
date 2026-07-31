# pi-bg-watch

[English](./README_EN.md) | 中文

pi 编码代理的后台任务生命周期管理扩展。

监控后台进程，进程退出时自动通知会话——无需轮询。设计借鉴 grok-build 的任务管理和 Claude Code 的 BashOutput/KillBash 模式。

## 功能

| Action | 说明 |
|--------|------|
| `watch` | 给一个正在运行的后台 PID 挂上完成通知 |
| `list` | 列出所有监控中的任务及实时状态 |
| `status` | 详细信息：进程存活、运行时长、watcher 健康状态 |
| `output` | 按需读取日志文件尾部（不必等完成） |
| `cancel` | 取消监控（目标进程继续运行） |
| `kill` | 终止目标进程（SIGTERM → 宽限期 → SIGKILL） |

**TUI 集成**：底部状态栏显示 `◎ 2 bg tasks running`，编辑器上方 widget 列出活跃任务及运行时长。

**自动恢复**：如果 watcher 异常退出（崩溃/重启）或进程在会话中断期间结束，重新 watch 同一 PID 时会自动清理残留状态并补发遗漏的完成通知。

## 安装

```bash
pi install git:github.com/piexian/pi-bg-watch
```

或克隆到本地后添加到 settings：

```bash
git clone https://github.com/piexian/pi-bg-watch ~/.pi/agent/extensions/pi-bg-watch
```

## 用法

### 工具调用（由 agent 自动使用）

```
# 启动后台进程后挂监控：
bg_watch({ action: "watch", pid: 12345, label: "npm build", log_file: "/tmp/build.log" })

# 查看进度（仅在用户主动要求时）：
bg_watch({ action: "output", pid: 12345 })

# 取消监控：
bg_watch({ action: "cancel", pid: 12345 })

# 终止进程：
bg_watch({ action: "kill", pid: 12345 })
```

### 斜杠命令

```
/bg-watch list
/bg-watch watch 12345 my build task
/bg-watch status 12345
/bg-watch cancel 12345
/bg-watch kill 12345
/bg-watch 12345 my task        # 简写（兼容旧用法）
```

## 工作原理

1. `watch` 生成一个 **detached watcher 子进程**，每 3s 通过 `kill(pid, 0)` 轮询目标 PID 存活状态
2. 目标退出后，watcher 写入 `.done.json` 状态文件并自毁
3. 扩展的 checker（2s 间隔）消费 done 文件，通过 `pi.sendMessage({ triggerTurn: true, deliverAs: "nextTurn" })` 注入完成消息
4. Agent 收到系统消息后自动处理——无需用户输入

状态文件存放在 `~/.pi/agent/bg-watch/`。

## 防轮询设计

工具描述和 prompt guidelines 明确指示 agent 在挂上监控后**禁止轮询**。完成通知由系统自动推送，节省 token 且不阻塞对话。

## 环境要求

- pi coding agent（任意近期版本）
- Linux 或 macOS（使用 `process.kill(pid, 0)` 检测存活）

## 许可证

MIT
