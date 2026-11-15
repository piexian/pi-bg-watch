# Changelog

## 0.1.4

- 通用进度源：log/file、heartbeat、tmux/pty；空日志按任务是否仍在运行区分提示；tmux 异步读取；output 的 log_file 可覆盖已记录来源

## 0.1.3

- TUI widget: collapse each task by default; fullscreen task-row clicks expand or collapse its summary, with regular-mode keyboard fallback

## 0.1.2

- TUI widget: collapse/bounded scrolling, per-task 3-line summaries, theme-accent animation
- Log panel with safe bounded tail reads (32 KiB tails; output 30/max 1000, panel 80, summary up to 20 lines)
- Require pi coding agent / pi-tui >= 1.5.0; completion notifications delivered via steer + triggerTurn
