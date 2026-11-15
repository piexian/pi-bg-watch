# pi-bg-watch

English | [中文](./README.md)

Background task lifecycle manager for [pi](https://pi.dev) coding agent.

Watches background processes and automatically notifies the session when they exit — no polling needed. Inspired by grok-build's task management and Claude Code's BashOutput/KillBash pattern.

## Features

| Action | Description |
|--------|-------------|
| `watch` | Attach a completion watcher to a running background PID |
| `list` | Show all watched tasks with live status |
| `status` | Detailed info: process alive, elapsed time, watcher health |
| `output` | Read log file tail on demand (no need to wait for completion) |
| `cancel` | Stop monitoring (target process keeps running) |
| `kill` | Terminate target process (SIGTERM → grace period → SIGKILL) |

**TUI integration**: Static footer status line (`● 2 bg tasks running`); the widget above the editor uses a theme-accent animation and lists active tasks with elapsed time (up to 12 lines), collapsed per task by default; click a task row in fullscreen mode to expand or collapse up to 3 log-summary lines, while regular TUI uses `Ctrl+Shift+B` to expand or collapse all and `Ctrl+Shift+PgUp/PgDn` to scroll.

**Log panel**: `/bg-watch logs <pid>` opens a panel with `↑↓`/`PgUp`/`PgDn`/`Home`/`End` scrolling; scrolling up pauses follow and `End` resumes; `Esc`/`q` closes. Title and hints stay fixed; content refreshes every second.

**Bounded reads**: log tails read at most 32 KiB; `output` returns 30 lines by default (max 1000), the panel up to 80 lines, completion summaries up to 20 lines; control characters are stripped and overlong single lines are marked truncated.

**Non-TUI**: RPC keeps a string widget of up to 12 lines; print/json show no UI — use `bg_watch output` only when asked.

**Auto-recovery**: If the watcher dies (crash/restart) or the process exits while the session is interrupted, re-watching the same PID auto-cleans stale state and delivers any missed completion notification.

## Install

```bash
pi install git:github.com/piexian/pi-bg-watch
```

Or clone locally and add to settings:

```bash
git clone https://github.com/piexian/pi-bg-watch ~/.pi/agent/extensions/pi-bg-watch
```

## Usage

### As a tool (called by the agent)

```
# After launching a background process:
bg_watch({ action: "watch", pid: 12345, label: "npm build", log_file: "/tmp/build.log" })

# Check progress (only when user asks):
bg_watch({ action: "output", pid: 12345 })

# Cancel monitoring:
bg_watch({ action: "cancel", pid: 12345 })

# Kill the process:
bg_watch({ action: "kill", pid: 12345 })
```

### As a slash command

```
/bg-watch list
/bg-watch watch 12345 my build task
/bg-watch status 12345
/bg-watch logs 12345
/bg-watch cancel 12345
/bg-watch kill 12345
/bg-watch 12345 my task        # shorthand (legacy compat)
```

## How It Works

1. `watch` spawns a **detached watcher subprocess** that polls `/proc/<pid>` (via `kill(pid, 0)`) every 3s
2. When the target exits, the watcher writes a `.done.json` state file and self-destructs
3. The extension's checker (2s interval) consumes done files and injects a completion message via `pi.sendMessage(msg, { deliverAs: "steer", triggerTurn: true })`
4. The agent receives the notification as a system message and can act on it — no user input needed

State files live in `~/.pi/agent/bg-watch/`.

## Anti-Polling Design

The tool description and prompt guidelines explicitly instruct the agent to **never poll** after attaching a watcher. The completion notification is pushed automatically. This saves tokens and avoids blocking the conversation.

## Requirements

- pi coding agent / pi-tui >= 1.5.0
- Linux or macOS (uses `process.kill(pid, 0)` for liveness checks)

## License

MIT
