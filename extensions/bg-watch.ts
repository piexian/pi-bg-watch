/**
 * bg-watch — Background task lifecycle manager for pi coding agent
 *
 * Registers the `bg_watch` tool and `/bg-watch` command.
 * Actions: watch | list | status | output | cancel | kill
 *
 * Architecture: spawns a detached watcher subprocess that polls target PID
 * liveness via kill(pid, 0). On exit, the watcher writes a .done.json state
 * file; the extension's interval checker consumes it and injects a completion
 * message into the session via pi.sendMessage (steer, triggerTurn).
 * Watcher PID is recorded in state for precise cleanup on cancel/kill.
 *
 * Session-scoped: each watch record carries a sessionId. Only records
 * belonging to the current session are displayed and notified. Stale
 * records from dead sessions are cleaned up on session_start.
 *
 * Design inspired by grok-build (task_id + get_output + kill) and
 * Claude Code (BashOutput / KillBash separation).
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, replaceControlCharacters, ScrollView, stripTerminalSequences, Text, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".pi", "agent", "bg-watch");
const WATCH_INTERVAL_MS = 3_000; // watcher poll interval
const CHECK_INTERVAL_MS = 2_000; // extension done-file consume interval
const MAX_WATCH_MS = 12 * 60 * 60 * 1000; // 12h safety timeout
const KILL_GRACE_MS = 5_000; // grace period after SIGTERM before SIGKILL
const LOG_TAIL_BYTES = 32 * 1024;
const LOG_TAIL_LINES = 80;
const WIDGET_LOG_LINES = 3;
const MAX_WIDGET_LINES = 12;
const UI_SPINNER_INTERVAL_MS = 180;
const LOG_PANEL_REFRESH_MS = 1_000;
const TMUX_CAPTURE_TIMEOUT_MS = 400;
const TMUX_CACHE_MS = 500;
const HEARTBEAT_MAX_BYTES = 16 * 1024;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ─── Data Structures ───────────────────────────────────────

type ProgressSourceType = "log" | "file" | "heartbeat" | "tmux" | "pty";

type ProgressSource = {
	type: ProgressSourceType;
	path?: string;
	target?: string;
};

type ProgressKind =
	| "content"
	| "unconfigured"
	| "unreadable"
	| "empty-running"
	| "empty-exited"
	| "alive-no-progress"
	| "exited-no-progress"
	| "heartbeat-missing"
	| "heartbeat-invalid"
	| "tmux-unavailable"
	| "tmux-target"
	| "tmux-timeout"
	| "tmux-pending";

type ProgressSnapshot = {
	kind: ProgressKind;
	text: string;
};

type WatchRecord = {
	pid: number;
	label: string;
	sessionId?: string; // owning session
	logFile?: string;
	progressSource?: ProgressSource;
	quiet?: boolean;
	startedAt: number;
	watcherPid?: number; // watcher subprocess PID, for cleanup on cancel
	command?: string; // optional: original command description
};

type DoneRecord = WatchRecord & {
	exitCode: number | null;
	finishedAt: number;
	timedOut?: boolean; // whether exited due to timeout
};

// ─── Path Helpers ──────────────────────────────────────────

function statePath(pid: number): string {
	return join(STATE_DIR, `${pid}.json`);
}

function donePath(pid: number): string {
	return join(STATE_DIR, `${pid}.done.json`);
}

function ensureDir(): void {
	mkdirSync(STATE_DIR, { recursive: true });
}

// ─── Process Helpers ───────────────────────────────────────

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

// Unified progress snapshot: widget, panel, output, and completion all read through here.
type TmuxRaw =
	| { ok: true; text: string }
	| { ok: false; kind: "tmux-unavailable" | "tmux-target" | "tmux-timeout"; text: string };

type TmuxCacheEntry = {
	at: number;
	raw?: TmuxRaw;
	inflight?: Promise<TmuxRaw>;
};

const tmuxCaptureCache = new Map<string, TmuxCacheEntry>();
let tmuxDidUpdate: (() => void) | undefined;

function cleanLine(value: string): string {
	return replaceControlCharacters(stripTerminalSequences(value)).replace(/\s+/g, " ").trim();
}

function formatAge(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s > 3600) return `${Math.floor(s / 3600)}h 前`;
	if (s > 60) return `${Math.floor(s / 60)}m 前`;
	return `${s}s 前`;
}

function emptyLogSnapshot(alive: boolean): ProgressSnapshot {
	return alive
		? { kind: "empty-running", text: "暂无可用日志，任务仍在运行" }
		: { kind: "empty-exited", text: "任务已结束且日志为空" };
}

function noProgressSnapshot(alive: boolean): ProgressSnapshot {
	return alive
		? { kind: "alive-no-progress", text: "进程存活，暂无可读进度" }
		: { kind: "exited-no-progress", text: "任务已结束，暂无可读进度" };
}

function describeProgressSource(source: ProgressSource | undefined): string {
	if (!source) return "未配置";
	if (source.type === "heartbeat") return source.path ? `heartbeat ${source.path}` : "heartbeat";
	if (source.type === "tmux" || source.type === "pty") return source.target ? `${source.type} ${source.target}` : source.type;
	return source.path ? `${source.type} ${source.path}` : source.type;
}

function normalizeProgressSource(source: ProgressSource | undefined, logFile: string | undefined): ProgressSource | undefined {
	if (source) {
		if ((source.type === "log" || source.type === "file") && !source.path && logFile) {
			return { type: source.type, path: logFile };
		}
		return source;
	}
	if (logFile) return { type: "log", path: logFile };
	return undefined;
}

function resolveOutputSource(
	requested: ProgressSource | undefined,
	logFile: string | undefined,
	rec: WatchRecord | null | undefined,
): ProgressSource | undefined {
	if (requested) return normalizeProgressSource(requested, logFile ?? rec?.logFile);
	if (logFile) return { type: "log", path: logFile };
	return normalizeProgressSource(rec?.progressSource, rec?.logFile);
}

function progressSourceError(source: ProgressSource | undefined): string | undefined {
	if (!source) return;
	if ((source.type === "log" || source.type === "file") && !source.path) return "progress_source.type=log/file 需要 path";
	if (source.type === "heartbeat" && !source.path) return "progress_source.type=heartbeat 需要 path";
	if ((source.type === "tmux" || source.type === "pty") && !source.target) return "progress_source.type=tmux/pty 需要 target";
	return;
}

function isProgressReadError(kind: ProgressKind): boolean {
	return kind === "unconfigured"
		|| kind === "unreadable"
		|| kind === "heartbeat-missing"
		|| kind === "heartbeat-invalid"
		|| kind === "tmux-unavailable"
		|| kind === "tmux-target"
		|| kind === "tmux-timeout";
}

function readLogTail(logFile: string, lines = 30, maxBytes = LOG_TAIL_BYTES): string | null {
	const lineLimit = Number.isFinite(lines) ? Math.min(1_000, Math.max(1, Math.floor(lines))) : 30;
	const byteLimit = Number.isFinite(maxBytes) ? Math.min(LOG_TAIL_BYTES, Math.max(1, Math.floor(maxBytes))) : LOG_TAIL_BYTES;
	const truncatedMark = "[truncated] ";
	let fd: number | undefined;
	try {
		fd = openSync(logFile, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - byteLimit);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		const bytesRead = length > 0 ? readSync(fd, buffer, 0, length, start) : 0;
		if (bytesRead === 0) return "";
		// Skip continuation bytes of a character split by the window start.
		let decodeStart = 0;
		if (start > 0) while (decodeStart < bytesRead && (buffer[decodeStart] & 0xc0) === 0x80) decodeStart++;
		let content = buffer.toString("utf8", decodeStart, bytesRead).replace(/\r\n?/g, "\n");
		if (start > 0) {
			const newline = content.indexOf("\n");
			if (newline < 0) content = `${truncatedMark}${content}`;
			else if (newline === content.length - 1) content = `${truncatedMark}${content.slice(0, -1)}`;
			// Drop the partial first line, then keep the last N whole lines.
			else content = content.slice(newline + 1);
		}
		if (content.endsWith("\n")) content = content.slice(0, -1);
		const cleaned = content
			.split("\n")
			.map((line) => replaceControlCharacters(stripTerminalSequences(line)).trimEnd());
		return cleaned.slice(-lineLimit).join("\n");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function readHeartbeat(path: string, alive: boolean): ProgressSnapshot {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		if (size > HEARTBEAT_MAX_BYTES) {
			return { kind: "heartbeat-invalid", text: `heartbeat 解析失败：${path}` };
		}
		const buffer = Buffer.alloc(size);
		const bytesRead = size > 0 ? readSync(fd, buffer, 0, size, 0) : 0;
		let data: unknown;
		try {
			data = JSON.parse(buffer.toString("utf8", 0, bytesRead));
		} catch {
			return { kind: "heartbeat-invalid", text: `heartbeat 解析失败：${path}` };
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return { kind: "heartbeat-invalid", text: `heartbeat 解析失败：${path}` };
		}
		const obj = data as Record<string, unknown>;
		const parts: string[] = [];
		if (typeof obj.state === "string" && obj.state.trim()) parts.push(cleanLine(obj.state));
		if (typeof obj.phase === "string" && obj.phase.trim()) parts.push(cleanLine(obj.phase));
		if (obj.progress !== undefined) {
			if (typeof obj.progress !== "number" || !Number.isFinite(obj.progress) || obj.progress < 0 || obj.progress > 1) {
				return { kind: "heartbeat-invalid", text: `heartbeat 解析失败：${path}` };
			}
			parts.push(`${Math.round(obj.progress * 100)}%`);
		}
		if (typeof obj.message === "string" && obj.message.trim()) parts.push(cleanLine(obj.message));
		if (obj.updatedAt !== undefined) {
			const ts = typeof obj.updatedAt === "number"
				? obj.updatedAt
				: typeof obj.updatedAt === "string"
					? Date.parse(obj.updatedAt)
					: Number.NaN;
			if (Number.isFinite(ts)) parts.push(formatAge(ts));
		}
		if (parts.length === 0) return noProgressSnapshot(alive);
		return { kind: "content", text: parts.join(" · ") };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return { kind: "heartbeat-missing", text: `heartbeat 文件不存在：${path}` };
		return { kind: "unreadable", text: `heartbeat 文件不可读：${path}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function tmuxLineLimit(lines: number): number {
	return Number.isFinite(lines) ? Math.min(1_000, Math.max(1, Math.floor(lines))) : 80;
}

function tmuxCacheKey(target: string, lineLimit: number): string {
	return `${target}\0${lineLimit}`;
}

function pruneTmuxCache(now: number): void {
	for (const [key, entry] of tmuxCaptureCache) {
		if (entry.inflight) continue;
		if (now - entry.at >= TMUX_CACHE_MS) tmuxCaptureCache.delete(key);
	}
}

function snapshotFromTmuxRaw(raw: TmuxRaw | undefined, alive: boolean, pending: boolean): ProgressSnapshot {
	if (raw) {
		if (!raw.ok) return { kind: raw.kind, text: raw.text };
		if (!raw.text) return noProgressSnapshot(alive);
		return { kind: "content", text: raw.text };
	}
	if (pending) return { kind: "tmux-pending", text: "tmux 读取中" };
	return { kind: "tmux-unavailable", text: "tmux 不可用" };
}

function runTmuxCapture(target: string, lineLimit: number): Promise<TmuxRaw> {
	const displayTarget = cleanLine(target) || target;
	return new Promise((resolve) => {
		execFile("tmux", ["capture-pane", "-p", "-t", target, "-S", `-${lineLimit}`], {
			encoding: "utf8",
			timeout: TMUX_CAPTURE_TIMEOUT_MS,
			maxBuffer: LOG_TAIL_BYTES,
			windowsHide: true,
		}, (err, stdout) => {
			if (!err) {
				const cleaned = String(stdout ?? "")
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map((line) => replaceControlCharacters(stripTerminalSequences(line)).trimEnd());
				while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "") cleaned.pop();
				resolve({ ok: true, text: cleaned.slice(-lineLimit).join("\n") });
				return;
			}
			const e = err as NodeJS.ErrnoException & { killed?: boolean };
			if (e.code === "ENOENT") resolve({ ok: false, kind: "tmux-unavailable", text: "tmux 不可用" });
			else if (e.killed === true || e.code === "ETIMEDOUT") resolve({ ok: false, kind: "tmux-timeout", text: `tmux 读取超时：${displayTarget}` });
			else resolve({ ok: false, kind: "tmux-target", text: `tmux 目标不可用：${displayTarget}` });
		});
	});
}

function ensureTmuxCapture(target: string, lineLimit: number): TmuxCacheEntry {
	const now = Date.now();
	pruneTmuxCache(now);
	const key = tmuxCacheKey(target, lineLimit);
	const existing = tmuxCaptureCache.get(key);
	if (existing?.inflight) return existing;
	if (existing?.raw && now - existing.at < TMUX_CACHE_MS) return existing;
	const inflight = runTmuxCapture(target, lineLimit).then((raw) => {
		tmuxCaptureCache.set(key, { at: Date.now(), raw });
		tmuxDidUpdate?.();
		return raw;
	});
	const entry: TmuxCacheEntry = { at: existing?.at ?? now, raw: existing?.raw, inflight };
	tmuxCaptureCache.set(key, entry);
	return entry;
}

function readTmuxProgress(target: string, lines: number, alive: boolean): ProgressSnapshot {
	const lineLimit = tmuxLineLimit(lines);
	const entry = ensureTmuxCapture(target, lineLimit);
	return snapshotFromTmuxRaw(entry.raw, alive, !!entry.inflight && !entry.raw);
}

async function readTmuxProgressAsync(target: string, lines: number, alive: boolean): Promise<ProgressSnapshot> {
	const lineLimit = tmuxLineLimit(lines);
	const entry = ensureTmuxCapture(target, lineLimit);
	const raw = entry.inflight ? await entry.inflight : entry.raw;
	return snapshotFromTmuxRaw(raw, alive, false);
}

function readProgress(source: ProgressSource | undefined, opts: { alive: boolean; lines?: number; maxBytes?: number }): ProgressSnapshot {
	const lines = opts.lines ?? 30;
	const maxBytes = opts.maxBytes ?? LOG_TAIL_BYTES;
	if (!source) return { kind: "unconfigured", text: "未配置进度源（无 progress_source / log_file）" };

	if (source.type === "heartbeat") {
		if (!source.path) return { kind: "unconfigured", text: "未配置进度源（heartbeat 缺少 path）" };
		return readHeartbeat(source.path, opts.alive);
	}
	if (source.type === "tmux" || source.type === "pty") {
		if (!source.target) return { kind: "unconfigured", text: "未配置进度源（tmux/pty 缺少 target）" };
		return readTmuxProgress(source.target, lines, opts.alive);
	}
	if (!source.path) return { kind: "unconfigured", text: "未配置进度源（无 progress_source / log_file）" };
	const tail = readLogTail(source.path, lines, maxBytes);
	if (tail === null) return { kind: "unreadable", text: `进度源不可读：${source.path}` };
	if (!tail.trim()) return emptyLogSnapshot(opts.alive);
	return { kind: "content", text: tail };
}

async function readProgressAsync(source: ProgressSource | undefined, opts: { alive: boolean; lines?: number; maxBytes?: number }): Promise<ProgressSnapshot> {
	if (source && (source.type === "tmux" || source.type === "pty") && source.target) {
		return readTmuxProgressAsync(source.target, opts.lines ?? 30, opts.alive);
	}
	return readProgress(source, opts);
}

// ─── Detached Watcher Source ───────────────────────────────

const WATCHER_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const [pid, stateDir, intervalMs, maxMs] = [
  Number(process.argv[1]), process.argv[2], Number(process.argv[3]), Number(process.argv[4])
];
const startedAt = Date.now();
const timer = setInterval(() => {
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  const timedOut = Date.now() - startedAt > maxMs;
  if (!alive || timedOut) {
    clearInterval(timer);
    const recordPath = path.join(stateDir, pid + ".json");
    let record = {};
    try { record = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch {}
    const done = { ...record, exitCode: null, finishedAt: Date.now(), timedOut };
    fs.writeFileSync(path.join(stateDir, pid + ".done.json"), JSON.stringify(done));
    try { fs.unlinkSync(recordPath); } catch {}
    process.exit(0);
  }
}, intervalMs);
`;

// ─── Main Extension ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	ensureDir();
	let checkTimer: ReturnType<typeof setInterval> | null = null;
	let currentSessionId: string | undefined;
	type UiRef = Pick<ExtensionContext["ui"], "setStatus" | "setWidget"> & { isTui: boolean };

	// Bounded text viewport: composes Text+ScrollView, clips rendered output to a given height.
	// Owner calls render() each frame with its allowed height; holds no timers.
	class BoundedTextView {
		private readonly text: Text;
		private readonly scroller: ScrollView;

		constructor() {
			this.text = new Text();
			this.scroller = new ScrollView(this.text, { follow: "end", scrollbar: "hidden" });
		}

		get isFollowingEnd(): boolean {
			return this.scroller.isFollowingEnd;
		}

		get scrollTop(): number {
			return this.scroller.scrollTop;
		}

		render(lines: string[], width: number, height: number, requestRender: () => void): string[] {
			const allowed = Math.max(1, height);
			const display = lines.map((line) =>
				truncateToWidth(replaceControlCharacters(stripTerminalSequences(line)), width),
			);
			this.text.setText(display.join("\n"));
			this.scroller.updateLayout(display.length, allowed, requestRender);
			return display.slice(this.scroller.scrollTop, this.scroller.scrollTop + allowed);
		}

		scrollBy(delta: number): void {
			this.scroller.scrollBy(delta);
		}

		scrollToStart(): void {
			this.scroller.scrollToStart();
		}

		scrollToEnd(): void {
			this.scroller.scrollToEnd();
		}

		dispose(): void {
			this.text.setText("");
			this.scroller.updateLayout(0, 1, () => {});
		}
	}

	type WidgetTaskRow = {
		pid: number;
		start: number;
		end: number;
	};

	class BackgroundTaskWidget {
		private readonly tui: TUI;
		private readonly theme: Theme;
		private readonly view = new BoundedTextView();
		private readonly onTogglePid: (pid: number) => void;
		private lines: string[] = [];
		private taskRows: WidgetTaskRow[] = [];
		private lastScrollTop = 0;
		private frame = 0;
		private bodyHeight = MAX_WIDGET_LINES - 1;
		private timer: ReturnType<typeof setInterval> | null = null;
		private disposed = false;

		constructor(tui: TUI, theme: Theme, lines: string[], taskRows: WidgetTaskRow[], onTogglePid: (pid: number) => void) {
			this.tui = tui;
			this.theme = theme;
			this.onTogglePid = onTogglePid;
			this.setLines(lines, taskRows);
			this.timer = setInterval(() => {
				if (this.disposed) return;
				this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
				this.tui.requestRender();
			}, UI_SPINNER_INTERVAL_MS);
			this.timer.unref?.();
		}

		setLines(lines: string[], taskRows: WidgetTaskRow[]): void {
			if (this.disposed) return;
			this.lines = lines;
			this.taskRows = taskRows;
			if (this.view.isFollowingEnd) this.view.scrollToEnd();
			this.tui.requestRender();
		}

		render(width: number): string[] {
			if (this.disposed) return [];
			const [header = "bg-watch", ...body] = this.lines;
			const icon = this.theme.fg("accent", SPINNER_FRAMES[this.frame]);
			// Total rows cap: 12, or shrink to terminal height (title + body).
			const maxTotal = Math.min(MAX_WIDGET_LINES, this.tui.terminal.rows - 1);
			this.bodyHeight = Math.max(1, maxTotal - 1);
			const clipped = this.view.render(body, width, this.bodyHeight, () => this.tui.requestRender());
			this.lastScrollTop = this.view.scrollTop;
			const hint = this.tui.mode === "fullscreen" ? "点击任务展开/收起" : "Ctrl+Shift+B 全部展开/收起";
			return [truncateToWidth(`${icon} ${header} · ${hint}`, width), ...clipped];
		}

		invalidate(): void {}

		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (this.disposed) return;
			if (this.tui.mode !== "fullscreen") return;
			if (event.type !== "click" || event.button !== "left") return;
			const sourceIndex = event.y <= 0 ? 0 : event.y + this.lastScrollTop;
			const hit = this.taskRows.find((row) => sourceIndex >= row.start && sourceIndex < row.end);
			if (!hit) return;
			this.onTogglePid(hit.pid);
			this.tui.requestRender();
			return { handled: true };
		}

		scrollBy(delta: number): void {
			if (this.disposed) return;
			this.view.scrollBy(delta);
			this.tui.requestRender();
		}

		scrollPage(direction: number): void {
			this.scrollBy(direction * this.bodyHeight);
		}

		dispose(): void {
			if (this.disposed) return;
			this.disposed = true;
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
			this.view.dispose();
		}
	}

	class LiveLogPanel {
		readonly capturesViewportInput = true;
		private readonly tui: TUI;
		private readonly theme: Theme;
		private readonly view = new BoundedTextView();
		private readonly record: WatchRecord;
		private sourceLabel = "未配置";
		private readonly closePanel: () => void;
		private readonly done: (result: undefined) => void;
		private content = "";
		private bodyHeight = 1;
		private timer: ReturnType<typeof setInterval> | null = null;
		private closed = false;

		constructor(
			tui: TUI,
			theme: Theme,
			record: WatchRecord,
			closePanel: () => void,
			done: (result: undefined) => void,
		) {
			this.tui = tui;
			this.theme = theme;
			this.record = record;
			this.closePanel = closePanel;
			this.done = done;
			this.refresh();
			this.timer = setInterval(() => {
				this.refresh();
				this.tui.requestRender();
			}, LOG_PANEL_REFRESH_MS);
			this.timer.unref?.();
		}

		// Re-read progress at 1 Hz; empty / unreadable / unconfigured stay distinct.
		private refresh(): void {
			const source = normalizeProgressSource(this.record.progressSource, this.record.logFile);
			const snapshot = readProgress(source, {
				alive: isAlive(this.record.pid),
				lines: LOG_TAIL_LINES,
				maxBytes: LOG_TAIL_BYTES,
			});
			this.content = snapshot.text;
			this.sourceLabel = describeProgressSource(source);
		}

		render(width: number): string[] {
			if (this.closed) return [];
			const label = replaceControlCharacters(stripTerminalSequences(this.record.label));
			const path = replaceControlCharacters(stripTerminalSequences(this.sourceLabel));
			const meta = this.theme.fg("muted", truncateToWidth(`${label} · ${path}`, width));
			const hint = this.theme.fg("dim", truncateToWidth("↑↓ / PgUp PgDn / Home End · Esc 或 q 关闭", width));
			// title + meta + hint + 1 spare row reserved from terminal height.
			this.bodyHeight = Math.max(1, this.tui.terminal.rows - 4);
			const body = this.view.render(this.content.split("\n"), width, this.bodyHeight, () => this.tui.requestRender());
			return [
				this.theme.fg("accent", truncateToWidth(`bg-watch logs · PID ${this.record.pid}`, width)),
				meta,
				...body,
				hint,
			];
		}

		invalidate(): void {}

		handleInput(data: string): void {
			if (this.closed) return;
			if (matchesKey(data, "escape") || matchesKey(data, "q")) {
				this.close();
				return;
			}
			// Scroll only the body view; fixed title/meta/hint never move.
			if (matchesKey(data, "up")) this.view.scrollBy(-1);
			else if (matchesKey(data, "down")) this.view.scrollBy(1);
			else if (matchesKey(data, "pageUp")) this.view.scrollBy(-this.bodyHeight);
			else if (matchesKey(data, "pageDown")) this.view.scrollBy(this.bodyHeight);
			else if (matchesKey(data, "home")) this.view.scrollToStart();
			else if (matchesKey(data, "end")) this.view.scrollToEnd();
			else return;
			this.tui.requestRender();
		}

		// q/Esc/shutdown path: resolve custom command, then notify panel closed.
		close(): void {
			if (this.closed) return;
			this.dispose();
			this.done(undefined);
			this.closePanel();
		}

		// Sole cleanup; idempotent for host dispose after done.
		dispose(): void {
			if (this.closed) return;
			this.closed = true;
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
			this.view.dispose();
		}
	}

	let uiRef: UiRef | null = null;
	let widgetComponent: BackgroundTaskWidget | null = null;
	let activeLogPanel: LiveLogPanel | null = null;
	let widgetMountRequested = false;
	const expandedPids = new Set<number>();
	let latestWidgetLines: string[] = [];
	let latestTaskRows: WidgetTaskRow[] = [];

	// ── TUI Display ──

	function buildWidgetLines(active: WatchRecord[], expandedPids: ReadonlySet<number>, interactive: boolean): { lines: string[]; taskRows: WidgetTaskRow[] } {
		const running = active.filter((record) => isAlive(record.pid)).length;
		const lines = [`bg-watch · ${running}/${active.length} running`];
		const taskRows: WidgetTaskRow[] = [];
		for (const record of active) {
			const alive = isAlive(record.pid);
			const label = truncateToWidth(replaceControlCharacters(stripTerminalSequences(record.label)), 80);
			const expanded = interactive && expandedPids.has(record.pid);
			const prefix = interactive ? `  ${expanded ? "▾" : "▸"} ` : "  ";
			const start = lines.length;
			lines.push(`${prefix}${alive ? "●" : "○"} PID ${record.pid}: ${label} (${formatDuration(Date.now() - record.startedAt)})${alive ? "" : " [exited]"}`);
			if (expanded) {
				const source = normalizeProgressSource(record.progressSource, record.logFile);
				const snapshot = readProgress(source, { alive, lines: WIDGET_LOG_LINES, maxBytes: LOG_TAIL_BYTES });
				if (snapshot.kind === "content") {
					for (const line of snapshot.text.split("\n").slice(-WIDGET_LOG_LINES)) {
						lines.push(`    ${truncateToWidth(line, 140)}`);
					}
				} else {
					lines.push(`    ${truncateToWidth(snapshot.text, 140)}`);
				}
			}
			taskRows.push({ pid: record.pid, start, end: lines.length });
		}
		return { lines, taskRows };
	}

	function togglePidExpanded(pid: number): void {
		if (expandedPids.has(pid)) expandedPids.delete(pid);
		else expandedPids.add(pid);
		refreshUI();
	}

	function clearExpandedPids(): void {
		expandedPids.clear();
	}

	function disposeWidget(): void {
		widgetComponent?.dispose();
		widgetComponent = null;
		widgetMountRequested = false;
	}

	function refreshUI(): void {
		if (!uiRef) return;
		const active = listActive();
		if (active.length === 0) {
			uiRef.setStatus("bg-watch", undefined);
			disposeWidget();
			latestWidgetLines = [];
			latestTaskRows = [];
			uiRef.setWidget("bg-watch", undefined);
			return;
		}

		const running = active.filter((record) => isAlive(record.pid)).length;
		uiRef.setStatus("bg-watch", `● ${running} bg task${running > 1 ? "s" : ""} running`);
		if (!uiRef.isTui) {
			latestWidgetLines = buildWidgetLines(active, expandedPids, false).lines;
			latestTaskRows = [];
			const capped = latestWidgetLines.length > MAX_WIDGET_LINES
				? [...latestWidgetLines.slice(0, MAX_WIDGET_LINES - 1), `  … ${latestWidgetLines.length - MAX_WIDGET_LINES + 1} more lines`]
				: latestWidgetLines;
			uiRef.setWidget("bg-watch", capped, { placement: "aboveEditor" });
			return;
		}

		const built = buildWidgetLines(active, expandedPids, true);
		latestWidgetLines = built.lines;
		latestTaskRows = built.taskRows;
		if (!widgetMountRequested) {
			widgetMountRequested = true;
			uiRef.setWidget(
				"bg-watch",
				(tui, theme) => {
					const component = new BackgroundTaskWidget(tui, theme, latestWidgetLines, latestTaskRows, togglePidExpanded);
					widgetComponent = component;
					return component;
				},
				{ placement: "aboveEditor" },
			);
		}
		widgetComponent?.setLines(latestWidgetLines, latestTaskRows);
	}
	tmuxDidUpdate = () => refreshUI();

	pi.registerShortcut(Key.ctrlShift("b"), {
		description: "Toggle bg-watch log summary",
		handler: () => {
			const active = listActive();
			if (active.length === 0) return;
			const allExpanded = active.every((record) => expandedPids.has(record.pid));
			if (allExpanded) expandedPids.clear();
			else for (const record of active) expandedPids.add(record.pid);
			refreshUI();
		},
	});

	pi.registerShortcut(Key.ctrlShift("pageUp"), {
		description: "bg-watch: scroll widget summary up (向上滚动)",
		handler: () => {
			widgetComponent?.scrollPage(-1);
		},
	});

	pi.registerShortcut(Key.ctrlShift("pageDown"), {
		description: "bg-watch: scroll widget summary down (向下滚动)",
		handler: () => {
			widgetComponent?.scrollPage(1);
		},
	});

	// ── Internal Methods ──

	function startWatcher(record: WatchRecord): number {
		ensureDir();
		const watcher = spawn(
			process.execPath,
			["-e", WATCHER_SOURCE, String(record.pid), STATE_DIR, String(WATCH_INTERVAL_MS), String(MAX_WATCH_MS)],
			{ detached: true, stdio: "ignore" },
		);
		watcher.unref();
		// record watcher PID for cleanup on cancel
		record.watcherPid = watcher.pid;
		writeFileSync(statePath(record.pid), JSON.stringify(record));
		return watcher.pid ?? -1;
	}

	function removeWatch(pid: number): void {
		// load record to get watcherPid
		const rec = loadRecord(pid);
		if (rec?.watcherPid && isAlive(rec.watcherPid)) {
			killPid(rec.watcherPid, "SIGKILL");
		}
		// clean up state file
		try { unlinkSync(statePath(pid)); } catch { /* ignore if missing */ }
	}

	function loadRecord(pid: number): WatchRecord | null {
		try {
			return JSON.parse(readFileSync(statePath(pid), "utf8")) as WatchRecord;
		} catch {
			return null;
		}
	}

	/** List active watches belonging to the current session only */
	function listActive(): WatchRecord[] {
		ensureDir();
		return readdirSync(STATE_DIR)
			.filter((f) => f.endsWith(".json") && !f.endsWith(".done.json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(STATE_DIR, f), "utf8")) as WatchRecord;
				} catch {
					return null;
				}
			})
			.filter((r): r is WatchRecord => r !== null && r.sessionId === currentSessionId);
	}

	/** Consume done files belonging to the current session only */
	function consumeDone(): DoneRecord[] {
		ensureDir();
		const out: DoneRecord[] = [];
		for (const f of readdirSync(STATE_DIR)) {
			if (!f.endsWith(".done.json")) continue;
			try {
				const rec = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8")) as DoneRecord;
				if (rec.sessionId === currentSessionId) {
					out.push(rec);
					unlinkSync(join(STATE_DIR, f));
				}
			} catch { /* ignore corrupt files */ }
		}
		return out;
	}

	/** Clean up stale records from dead sessions (watcher dead + process dead) */
	function cleanupStaleRecords(): void {
		ensureDir();
		for (const f of readdirSync(STATE_DIR)) {
			if (!f.endsWith(".json") || f.endsWith(".done.json")) continue;
			try {
				const rec = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8")) as WatchRecord;
				if (rec.sessionId === currentSessionId) continue; // ours
				const watcherDead = !rec.watcherPid || !isAlive(rec.watcherPid);
				const processDead = !isAlive(rec.pid);
				if (watcherDead && processDead) {
					unlinkSync(join(STATE_DIR, f));
				}
			} catch {
				// corrupt file, remove it
				try { unlinkSync(join(STATE_DIR, f)); } catch {}
			}
		}
		// also clean orphaned done files from other sessions
		for (const f of readdirSync(STATE_DIR)) {
			if (!f.endsWith(".done.json")) continue;
			try {
				const rec = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8")) as DoneRecord;
				if (rec.sessionId !== currentSessionId) {
					const processDead = !isAlive(rec.pid);
					if (processDead) unlinkSync(join(STATE_DIR, f));
				}
			} catch {
				try { unlinkSync(join(STATE_DIR, f)); } catch {}
			}
		}
	}

	async function notifyDone(done: DoneRecord): Promise<void> {
		const duration = Math.round((done.finishedAt - done.startedAt) / 1000);
		const durationStr = duration > 3600
			? `${Math.floor(duration / 3600)}h${Math.floor((duration % 3600) / 60)}m`
			: duration > 60
				? `${Math.floor(duration / 60)}m${duration % 60}s`
				: `${duration}s`;
		const reason = done.timedOut ? "（超时自动结束）" : "";
		const lines = [
			`[bg-watch] 后台任务已结束：${replaceControlCharacters(stripTerminalSequences(done.label))}（PID ${done.pid}，运行 ${durationStr}）${reason}`,
			`后续操作：`,
			`1. 查看进度：bg_watch({ action: "output", pid: ${done.pid} })`,
			`2. 确认产出：git status / 检查目标文件`,
			`3. 如需重新运行：启动新进程后再次 bg_watch`,
		];
		const source = normalizeProgressSource(done.progressSource, done.logFile);
		const snapshot = await readProgressAsync(source, { alive: false, lines: 20, maxBytes: LOG_TAIL_BYTES });
		if (snapshot.kind === "content") {
			lines.push("", `进度（${describeProgressSource(source)}）：`, "```", snapshot.text, "```");
		} else {
			lines.push("", snapshot.text);
		}
		// steer + triggerTurn: if agent is actively working (goal/streaming), the message
		// queues and is delivered before the next LLM call (no interruption); if agent is
		// idle, triggerTurn fires a new turn so the notification gets processed.
		pi.sendMessage({
			customType: "bg-watch-done",
			content: lines.join("\n"),
			display: true,
			details: { pid: done.pid, label: done.label, exitCode: done.exitCode, timedOut: done.timedOut },
		}, { deliverAs: "steer", triggerTurn: true });
	}

	function startChecker(): void {
		if (checkTimer) return;
		checkTimer = setInterval(() => {
			void (async () => {
				for (const done of consumeDone()) {
					if (!done.quiet) await notifyDone(done);
				}
				refreshUI();
				if (listActive().length === 0 && checkTimer) {
					clearInterval(checkTimer);
					checkTimer = null;
					refreshUI();
				}
			})();
		}, CHECK_INTERVAL_MS);
		checkTimer.unref?.();
	}

	function formatDuration(ms: number): string {
		const s = Math.round(ms / 1000);
		if (s > 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
		if (s > 60) return `${Math.floor(s / 60)}m${s % 60}s`;
		return `${s}s`;
	}


	async function openLogPanel(pid: number, ctx: ExtensionContext): Promise<void> {
		const record = loadRecord(pid);
		if (!record) {
			ctx.ui.notify(`PID ${pid} 不在监控列表中`, "warning");
			return;
		}
		if (record.sessionId !== currentSessionId) {
			ctx.ui.notify("日志面板仅限当前会话的监控记录。", "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("日志面板仅在 TUI 模式可用；请使用 bg_watch output 查看一次进度。", "warning");
			return;
		}
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => {
				const panel = new LiveLogPanel(tui, theme, record, () => {
					activeLogPanel = null;
				}, done);
				activeLogPanel = panel;
				return panel;
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
		);
	}

	// ── Register Tool ──

	pi.registerTool({
		name: "bg_watch",
		label: "Background Task Manager",
		description:
			"后台任务生命周期管理：挂监控(watch)、查状态(status)、看输出(output)、取消监控(cancel)、终止进程(kill)、列清单(list)。" +
			"启动后台进程后立即 watch 挂上完成通知，系统会在进程退出时自动推送消息，无需轮询。" +
			"挂上监控后应继续做其他事或结束当前回合等待通知，禁止循环调用 status/output 来等待完成。" +
			"仅在用户主动要求时才用 output 查看一次进度；需要中途干预时用 cancel/kill。",
		promptSnippet: "Manage background tasks: watch, status, output, cancel, kill, list",
		promptGuidelines: [
			"After launching any long-running background process (nohup, &, detached), call bg_watch with its PID so completion is reported automatically.",
			"CRITICAL: After calling bg_watch(action=watch), do NOT poll, loop, sleep, or repeatedly call status/output to check progress. The system will automatically inject a completion message into the conversation when the process exits. Continue with other work or end your turn and wait.",
			"NEVER use bash sleep/wait loops or repeated bg_watch(action=status) calls to wait for a background task. This defeats the purpose of the tool and wastes tokens.",
			"If the user explicitly asks to check progress, use action=output ONCE to show the progress source. Do not loop.",
			"When watching, pass log_file or an explicit progress_source (log/file, heartbeat, tmux/pty). Do not infer the source from command.",
			"Use action=cancel to stop monitoring (process keeps running); action=kill to terminate the process itself.",
		],
		parameters: Type.Object({
			action: Type.Optional(Type.Union([
				Type.Literal("watch"),
				Type.Literal("list"),
				Type.Literal("status"),
				Type.Literal("output"),
				Type.Literal("cancel"),
				Type.Literal("kill"),
			], { description: "操作类型，默认 watch" })),
			pid: Type.Optional(Type.Number({ description: "目标进程 PID（watch/status/output/cancel/kill 时必填）" })),
			label: Type.Optional(Type.String({ description: "任务描述标签（watch 时必填）" })),
			log_file: Type.Optional(Type.String({ description: "普通文本日志路径；未设置 progress_source 时作为 log 进度源" })),
			progress_source: Type.Optional(Type.Object({
				type: Type.Union([
					Type.Literal("log"),
					Type.Literal("file"),
					Type.Literal("heartbeat"),
					Type.Literal("tmux"),
					Type.Literal("pty"),
				], { description: "log/file 读文本尾部；heartbeat 读 JSON 状态文件；tmux/pty 按 target 调用 tmux capture-pane" }),
				path: Type.Optional(Type.String({ description: "log/file/heartbeat 的文件路径" })),
				target: Type.Optional(Type.String({ description: "tmux/pty 的 capture-pane 目标，例如 session:window.pane" })),
			})),
			quiet: Type.Optional(Type.Boolean({ description: "为 true 时完成不发提醒（默认 false）" })),
			lines: Type.Optional(Type.Number({ description: "output 时读取的尾部行数（默认 30）" })),
			command: Type.Optional(Type.String({ description: "可选：原始命令描述，便于 list 时识别" })),
		}),
		async execute(_id, params) {
			const action = params.action ?? "watch";

			// ── list ──
			if (action === "list") {
				const active = listActive();
				if (active.length === 0) {
					return { content: [{ type: "text", text: "当前没有监控中的后台任务。" }], details: undefined };
				}
				const lines = active.map((r) => {
					const alive = isAlive(r.pid);
					const elapsed = formatDuration(Date.now() - r.startedAt);
					const cmd = r.command ? ` [${r.command}]` : "";
					return `- PID ${r.pid}${alive ? " ●" : " ○"} ${r.label}${cmd}（${elapsed}）${alive ? "" : " ⚠️进程已退出但通知未消费"}`;
				});
				return { content: [{ type: "text", text: `监控中的后台任务（${active.length}）：\n${lines.join("\n")}\n\n● 运行中 ○ 已退出` }], details: undefined };
			}

			// all actions below require pid
			if (!params.pid) {
				return { content: [{ type: "text", text: `bg_watch ${action}: 需要 pid 参数。` }], details: undefined, isError: true };
			}
			const pid = params.pid;

			// ── watch ──
			if (action === "watch") {
				if (!params.label) {
					return { content: [{ type: "text", text: "bg_watch watch: label 必填。" }], details: undefined, isError: true };
				}
				// check if already watched
				const existing = loadRecord(pid);
				if (existing) {
					// watcher dead but state file remains → auto-cleanup and allow re-watch
					const watcherAlive = existing.watcherPid ? isAlive(existing.watcherPid) : false;
					if (watcherAlive) {
						return { content: [{ type: "text", text: `PID ${pid} 已在监控中（watcher ${existing.watcherPid} 存活）。如需重新挂，先 cancel 再 watch。` }], details: undefined, isError: true };
					}
					// watcher dead, clean stale state
					removeWatch(pid);
				}
				if (!isAlive(pid)) {
					// process exited: check for unconsumed done file, deliver notification immediately
					const dp = donePath(pid);
					if (existsSync(dp)) {
						try {
							const done = JSON.parse(readFileSync(dp, "utf8")) as DoneRecord;
							unlinkSync(dp);
							if (!done.quiet) await notifyDone(done);
						} catch { /* corrupt file, just delete */ try { unlinkSync(dp); } catch {} }
						refreshUI();
						return { content: [{ type: "text", text: `PID ${pid} 已退出，完成通知已补发。无需重新挂监控。` }], details: undefined };
					}
					return { content: [{ type: "text", text: `PID ${pid} 不存在或已退出，无法挂监控。` }], details: undefined, isError: true };
				}
				const progressSource = normalizeProgressSource(params.progress_source, params.log_file);
				const sourceErr = progressSourceError(progressSource);
				if (sourceErr) {
					return { content: [{ type: "text", text: `bg_watch watch: ${sourceErr}` }], details: undefined, isError: true };
				}
				const record: WatchRecord = {
					pid,
					label: params.label,
					sessionId: currentSessionId,
					logFile: params.log_file ?? ((progressSource?.type === "log" || progressSource?.type === "file") ? progressSource.path : undefined),
					progressSource,
					quiet: params.quiet,
					startedAt: Date.now(),
					command: params.command,
				};
				const watcherPid = startWatcher(record);
				startChecker();
				refreshUI();
				return {
					content: [{ type: "text", text: `已挂监控：PID ${pid}（${params.label}），watcher=${watcherPid}。\n⚠️ 进程退出时系统会自动推送通知，无需轮询。请继续其他工作或结束当前回合等待。\n中途可用 action=output 查看一次进度，action=cancel 取消监控，action=kill 终止进程。` }],
					details: { pid, label: params.label, watcherPid },
				};
			}

			// ── status ──
			if (action === "status") {
				const rec = loadRecord(pid);
				if (!rec) {
					// may have completed, check done file
					if (existsSync(donePath(pid))) {
						return { content: [{ type: "text", text: `PID ${pid} 已完成但通知尚未消费，等待下一轮 checker 处理。` }], details: undefined };
					}
					return { content: [{ type: "text", text: `PID ${pid} 不在监控列表中。` }], details: undefined, isError: true };
				}
				const alive = isAlive(pid);
				const watcherAlive = rec.watcherPid ? isAlive(rec.watcherPid) : false;
				const elapsed = formatDuration(Date.now() - rec.startedAt);
				const lines = [
					`任务：${rec.label}`,
					`PID：${pid}（${alive ? "运行中" : "已退出"}）`,
					`已运行：${elapsed}`,
					`Watcher：${rec.watcherPid ?? "未知"}（${watcherAlive ? "健康" : "已退出 ⚠️"}）`,
					`进度源：${describeProgressSource(normalizeProgressSource(rec.progressSource, rec.logFile))}`,
					`日志：${rec.logFile ?? "未设置"}`,
					`命令：${rec.command ?? "未记录"}`,
				];
				if (!alive) lines.push("⚠️ 目标进程已退出，完成通知即将触发。");
				if (!watcherAlive && alive) lines.push("⚠️ Watcher 异常退出，完成通知可能丢失。建议 cancel 后重新 watch。");
				return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
			}

			// ── output ──
			if (action === "output") {
				const rec = loadRecord(pid);
				const progressSource = resolveOutputSource(params.progress_source, params.log_file, rec);
				const sourceErr = progressSourceError(progressSource);
				if (sourceErr) {
					return { content: [{ type: "text", text: `bg_watch output: ${sourceErr}` }], details: undefined, isError: true };
				}
				const alive = isAlive(pid);
				const snapshot = await readProgressAsync(progressSource, { alive, lines: params.lines ?? 30, maxBytes: LOG_TAIL_BYTES });
				const header = `[${alive ? "运行中" : "已退出"}]`;
				const text = snapshot.kind === "content"
					? `${header} ${describeProgressSource(progressSource)}：\n\`\`\`\n${snapshot.text}\n\`\`\``
					: `${header} ${snapshot.text}`;
				return {
					content: [{ type: "text", text }],
					details: undefined,
					isError: isProgressReadError(snapshot.kind) || undefined,
				};
			}

			// ── cancel ──
			if (action === "cancel") {
				const rec = loadRecord(pid);
				if (!rec) {
					return { content: [{ type: "text", text: `PID ${pid} 不在监控列表中，无需取消。` }], details: undefined };
				}
				removeWatch(pid);
				refreshUI();
				const targetAlive = isAlive(pid);
				return {
					content: [{ type: "text", text: `已取消对 PID ${pid}（${rec.label}）的监控。${targetAlive ? "目标进程仍在运行。" : "目标进程已退出。"}\n如需重新挂监控：bg_watch({ action: "watch", pid: ${pid}, label: "..." })` }],
					details: undefined,
				};
			}

			// ── kill ──
			if (action === "kill") {
				const rec = loadRecord(pid);
				if (!isAlive(pid)) {
					// process dead, clean up watch
					if (rec) removeWatch(pid);
					return { content: [{ type: "text", text: `PID ${pid} 已不存在，无需终止。${rec ? "已清理监控状态。" : ""}` }], details: undefined };
				}
				// SIGTERM
				killPid(pid, "SIGTERM");
				// wait grace period
				const deadline = Date.now() + KILL_GRACE_MS;
				let exited = false;
				while (Date.now() < deadline) {
					if (!isAlive(pid)) { exited = true; break; }
					await new Promise((r) => setTimeout(r, 200));
				}
				if (!exited) {
					// SIGKILL
					killPid(pid, "SIGKILL");
					await new Promise((r) => setTimeout(r, 300));
				}
				// clean up watch
				if (rec) removeWatch(pid);
				refreshUI();
				const finalAlive = isAlive(pid);
				return {
					content: [{ type: "text", text: finalAlive
						? `⚠️ PID ${pid} 未能终止（可能需要手动处理）。`
						: `已终止 PID ${pid}${rec ? `（${rec.label}）` : ""}。${exited ? "（SIGTERM 生效）" : "（SIGKILL 强制终止）"}监控已清理。` }],
					details: undefined,
				};
			}

			return { content: [{ type: "text", text: `未知 action: ${action}` }], details: undefined, isError: true };
		},
	});

	// ── Register Command ──

	pi.registerCommand("bg-watch", {
		description: "后台任务管理 (bg-watch [watch|list|status|logs|cancel|kill] [pid] [label])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "list";

			if (sub === "list" || parts.length === 0) {
				const active = listActive();
				ctx.ui.notify(
					active.length === 0
						? "没有监控中的后台任务"
						: active.map((r) => `${isAlive(r.pid) ? "●" : "○"} PID ${r.pid}: ${r.label}（${formatDuration(Date.now() - r.startedAt)}）`).join("\n"),
					"info",
				);
				return;
			}

			// legacy compat: /bg-watch <pid> [label]
			const firstAsPid = Number(sub);
			if (Number.isInteger(firstAsPid) && firstAsPid > 0) {
				const pid = firstAsPid;
				const label = parts.slice(1).join(" ") || `PID ${pid}`;
				if (!isAlive(pid)) {
					ctx.ui.notify(`PID ${pid} 不存在或已退出`, "error");
					return;
				}
				if (loadRecord(pid)) {
					ctx.ui.notify(`PID ${pid} 已在监控中`, "warning");
					return;
				}
				startWatcher({ pid, label, sessionId: currentSessionId, startedAt: Date.now() });
				startChecker();
				refreshUI();
				ctx.ui.notify(`已监控 PID ${pid}（${label}）`, "info");
				return;
			}

			// subcommands: watch/status/cancel/kill <pid>
			const pid = Number(parts[1]);
			if (!Number.isInteger(pid) || pid <= 0) {
				ctx.ui.notify("用法: /bg-watch <watch|list|status|logs|cancel|kill> <pid> [label]", "warning");
				return;
			}

			if (sub === "logs") {
				await openLogPanel(pid, ctx);
				return;
			}

			if (sub === "watch") {
				const label = parts.slice(2).join(" ") || `PID ${pid}`;
				if (!isAlive(pid)) { ctx.ui.notify(`PID ${pid} 不存在或已退出`, "error"); return; }
				if (loadRecord(pid)) { ctx.ui.notify(`PID ${pid} 已在监控中`, "warning"); return; }
				startWatcher({ pid, label, sessionId: currentSessionId, startedAt: Date.now() });
				startChecker();
				refreshUI();
				ctx.ui.notify(`已监控 PID ${pid}（${label}）`, "info");
				return;
			}

			if (sub === "status") {
				const rec = loadRecord(pid);
				if (!rec) { ctx.ui.notify(`PID ${pid} 不在监控中`, "warning"); return; }
				const alive = isAlive(pid);
				ctx.ui.notify(`${rec.label}: PID ${pid} ${alive ? "运行中" : "已退出"}（${formatDuration(Date.now() - rec.startedAt)}）`, "info");
				return;
			}

			if (sub === "cancel") {
				const rec = loadRecord(pid);
				if (!rec) { ctx.ui.notify(`PID ${pid} 不在监控中`, "warning"); return; }
				removeWatch(pid);
				refreshUI();
				ctx.ui.notify(`已取消监控 PID ${pid}（${rec.label}）`, "info");
				return;
			}

			if (sub === "kill") {
				if (!isAlive(pid)) {
					const rec = loadRecord(pid);
					if (rec) removeWatch(pid);
					refreshUI();
					ctx.ui.notify(`PID ${pid} 已不存在`, "info");
					return;
				}
				killPid(pid, "SIGTERM");
				setTimeout(() => {
					if (isAlive(pid)) killPid(pid, "SIGKILL");
					const rec = loadRecord(pid);
					if (rec) removeWatch(pid);
					refreshUI();
				}, KILL_GRACE_MS);
				ctx.ui.notify(`正在终止 PID ${pid}（SIGTERM → ${KILL_GRACE_MS / 1000}s 后 SIGKILL）`, "info");
				return;
			}

			ctx.ui.notify(`未知子命令: ${sub}。可用: watch, list, status, logs, cancel, kill`, "warning");
		},
	});

	// ── Session Start Recovery ──

	pi.on("session_start", async (_event, ctx) => {
		// capture session ID for scoping
		currentSessionId = ctx.sessionManager.getSessionId();

		// release the previous session's UI component before rebinding the context
		if (uiRef) {
			uiRef.setStatus("bg-watch", undefined);
			uiRef.setWidget("bg-watch", undefined);
		}
		disposeWidget();
		activeLogPanel?.close();
		activeLogPanel = null;
		uiRef = null;
		clearExpandedPids();

		// capture UI ref for widget/status updates
		if (ctx.hasUI) {
			uiRef = {
				isTui: ctx.mode === "tui",
				setStatus: (key, text) => ctx.ui.setStatus(key, text),
				setWidget: ctx.ui.setWidget.bind(ctx.ui),
			};
		}

		// clean up stale records from dead sessions
		cleanupStaleRecords();

		// consume done files for THIS session only
		tmuxDidUpdate = () => refreshUI();
		const pending = consumeDone();
		for (const done of pending) {
			if (!done.quiet) await notifyDone(done);
		}
		if (listActive().length > 0) startChecker();
		refreshUI();
	});

	pi.on("session_shutdown", () => {
		tmuxDidUpdate = undefined;
		tmuxCaptureCache.clear();
		if (checkTimer) clearInterval(checkTimer);
		checkTimer = null;
		if (uiRef) {
			uiRef.setStatus("bg-watch", undefined);
			uiRef.setWidget("bg-watch", undefined);
		}
		disposeWidget();
		activeLogPanel?.close();
		activeLogPanel = null;
		uiRef = null;
		currentSessionId = undefined;
		clearExpandedPids();
	});
}
