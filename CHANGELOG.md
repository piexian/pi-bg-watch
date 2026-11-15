# Changelog

## 0.1.3

- TUI widget: collapse each task by default; fullscreen task-row clicks expand or collapse its summary, with regular-mode keyboard fallback

## 0.1.2

- TUI widget: collapse/bounded scrolling, per-task 3-line summaries, theme-accent animation
- Log panel with safe bounded tail reads (32 KiB tails; output 30/max 1000, panel 80, summary up to 20 lines)
- Require pi coding agent / pi-tui >= 1.5.0; completion notifications delivered via steer + triggerTurn
