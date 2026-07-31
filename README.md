# pi-bg-watch

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

**TUI integration**: Shows a footer status line (`◎ 2 bg tasks running`) and a widget above the editor listing active tasks with elapsed time.

**Auto-recovery**: If the watcher dies (crash/restart) or the process exits while the session is interrupted, re-watching the same PID auto-cleans stale state and delivers any missed completion notification.

## Install

```bash
pi install git:github.com/earendil-works/pi-bg-watch
```

Or clone locally and add to settings:

```bash
git clone https://github.com/earendil-works/pi-bg-watch ~/.pi/agent/extensions/pi-bg-watch
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
/bg-watch cancel 12345
/bg-watch kill 12345
/bg-watch 12345 my task        # shorthand (legacy compat)
```

## How It Works

1. `watch` spawns a **detached watcher subprocess** that polls `/proc/<pid>` (via `kill(pid, 0)`) every 3s
2. When the target exits, the watcher writes a `.done.json` state file and self-destructs
3. The extension's checker (2s interval) consumes done files and injects a completion message via `pi.sendMessage({ triggerTurn: true, deliverAs: "nextTurn" })`
4. The agent receives the notification as a system message and can act on it — no user input needed

State files live in `~/.pi/agent/bg-watch/`.

## Anti-Polling Design

The tool description and prompt guidelines explicitly instruct the agent to **never poll** after attaching a watcher. The completion notification is pushed automatically. This saves tokens and avoids blocking the conversation.

## Requirements

- pi coding agent (any recent version)
- Linux or macOS (uses `process.kill(pid, 0)` for liveness checks)

## License

MIT
