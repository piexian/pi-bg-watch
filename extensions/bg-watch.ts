/**
 * bg-watch — Background task lifecycle manager for pi coding agent
 *
 * Registers the `bg_watch` tool and `/bg-watch` command.
 * Actions: watch | list | status | output | cancel | kill
 *
 * Architecture: spawns a detached watcher subprocess that polls target PID
 * liveness via kill(pid, 0). On exit, the watcher writes a .done.json state
 * file; the extension's interval checker consumes it and injects a completion
 * message into the session via pi.sendMessage (triggerTurn + nextTurn).
 * Watcher PID is recorded in state for precise cleanup on cancel/kill.
 *
 * Design inspired by grok-build (task_id + get_output + kill) and
 * Claude Code (BashOutput / KillBash separation).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".pi", "agent", "bg-watch");
const WATCH_INTERVAL_MS = 3_000; // watcher poll interval
const CHECK_INTERVAL_MS = 2_000; // extension done-file consume interval
const MAX_WATCH_MS = 12 * 60 * 60 * 1000; // 12h safety timeout
const KILL_GRACE_MS = 5_000; // grace period after SIGTERM before SIGKILL

// ─── Data Structures ───────────────────────────────────────────────

type WatchRecord = {
	pid: number;
	label: string;
	logFile?: string;
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

// ─── Path Helpers ───────────────────────────────────────────────

function statePath(pid: number): string {
	return join(STATE_DIR, `${pid}.json`);
}

function donePath(pid: number): string {
	return join(STATE_DIR, `${pid}.done.json`);
}

function ensureDir(): void {
	mkdirSync(STATE_DIR, { recursive: true });
}

// ─── Process Helpers ───────────────────────────────────────────────

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

// ─── Detached Watcher Source ──────────────────────────────────

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

// ─── Main Extension ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	ensureDir();
	let checkTimer: ReturnType<typeof setInterval> | null = null;
	let uiRef: { setStatus: (key: string, text: string | undefined) => void; setWidget: (key: string, content: string[] | undefined, options?: { placement?: string }) => void; theme?: any } | null = null;

	// ── TUI Display ──

	function refreshUI(): void {
		if (!uiRef) return;
		const active = listActive();
		if (active.length === 0) {
			uiRef.setStatus("bg-watch", undefined);
			uiRef.setWidget("bg-watch", undefined);
			return;
		}
		// footer status bar: brief indicator
		const running = active.filter((r) => isAlive(r.pid)).length;
		const statusText = `◎ ${running} bg task${running > 1 ? "s" : ""} running`;
		uiRef.setStatus("bg-watch", statusText);
		// widget: detailed list (above editor)
		const widgetLines = active.map((r) => {
			const alive = isAlive(r.pid);
			const elapsed = formatDuration(Date.now() - r.startedAt);
			const icon = alive ? "●" : "○";
			return `  ${icon} PID ${r.pid}: ${r.label} (${elapsed})${alive ? "" : " [exited]"}`;
		});
		uiRef.setWidget("bg-watch", ["◎ bg-watch", ...widgetLines]);
	}

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
		try { unlinkSync(statePath(pid)); } catch { /* 不存在则忽略 */ }
	}

	function loadRecord(pid: number): WatchRecord | null {
		try {
			return JSON.parse(readFileSync(statePath(pid), "utf8")) as WatchRecord;
		} catch {
			return null;
		}
	}

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
			.filter((r): r is WatchRecord => r !== null);
	}

	function consumeDone(): DoneRecord[] {
		ensureDir();
		const out: DoneRecord[] = [];
		for (const f of readdirSync(STATE_DIR)) {
			if (!f.endsWith(".done.json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(STATE_DIR, f), "utf8")) as DoneRecord);
				unlinkSync(join(STATE_DIR, f));
			} catch { /* 忽略损坏文件 */ }
		}
		return out;
	}

	function notifyDone(done: DoneRecord): void {
		const duration = Math.round((done.finishedAt - done.startedAt) / 1000);
		const durationStr = duration > 3600
			? `${Math.floor(duration / 3600)}h${Math.floor((duration % 3600) / 60)}m`
			: duration > 60
				? `${Math.floor(duration / 60)}m${duration % 60}s`
				: `${duration}s`;
		const reason = done.timedOut ? "（超时自动结束）" : "";
		const lines = [
			`[bg-watch] 后台任务已结束：${done.label}（PID ${done.pid}，运行 ${durationStr}）${reason}`,
			`后续操作：`,
			`1. 查看日志：bg_watch({ action: "output", pid: ${done.pid} })`,
			`2. 确认产出：git status / 检查目标文件`,
			`3. 如需重新运行：启动新进程后再次 bg_watch`,
		];
		// attach log tail on completion
		if (done.logFile && existsSync(done.logFile)) {
			try {
				const content = readFileSync(done.logFile, "utf8");
				const tail = content.trimEnd().split("\n").slice(-20).join("\n");
				lines.push("", `日志尾部（${done.logFile}）：`, "```", tail, "```");
			} catch { /* 读不到就跳过 */ }
		}
		pi.sendMessage({
			customType: "bg-watch-done",
			content: lines.join("\n"),
			display: true,
			details: { pid: done.pid, label: done.label, exitCode: done.exitCode, timedOut: done.timedOut },
		}, { triggerTurn: true, deliverAs: "nextTurn" });
	}

	function startChecker(): void {
		if (checkTimer) return;
		checkTimer = setInterval(() => {
			for (const done of consumeDone()) {
				if (!done.quiet) notifyDone(done);
			}
			// refresh TUI display
			refreshUI();
			// stop timer when no active watches
			if (listActive().length === 0 && checkTimer) {
				clearInterval(checkTimer);
				checkTimer = null;
				refreshUI(); // clear widget/status
			}
		}, CHECK_INTERVAL_MS);
		checkTimer.unref?.();
	}

	function formatDuration(ms: number): string {
		const s = Math.round(ms / 1000);
		if (s > 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
		if (s > 60) return `${Math.floor(s / 60)}m${s % 60}s`;
		return `${s}s`;
	}

	function readLogTail(logFile: string, lines = 30): string | null {
		if (!existsSync(logFile)) return null;
		try {
			const content = readFileSync(logFile, "utf8");
			return content.trimEnd().split("\n").slice(-lines).join("\n");
		} catch {
			return null;
		}
	}

	// ── Register Tool ──

	pi.registerTool({
		name: "bg_watch",
		label: "Background Task Manager",
		description:
			"后台任务生命周期管理：挂监控(watch)、查状态(status)、看输出(output)、取消监控(cancel)、终止进程(kill)、列清单(list)。" +
			"启动后台进程后立即 watch 挂上完成通知，系统会在进程退出时自动推送消息，无需轮询。" +
			"挂上监控后应继续做其他事或结束当前回合等待通知，禁止循环调用 status/output 来等待完成。" +
			"仅在用户主动要求时才用 output 查看一次日志；需要中途干预时用 cancel/kill。",
		promptSnippet: "Manage background tasks: watch, status, output, cancel, kill, list",
		promptGuidelines: [
			"After launching any long-running background process (nohup, &, detached), call bg_watch with its PID so completion is reported automatically.",
			"CRITICAL: After calling bg_watch(action=watch), do NOT poll, loop, sleep, or repeatedly call status/output to check progress. The system will automatically inject a completion message into the conversation when the process exits. Continue with other work or end your turn and wait.",
			"NEVER use bash sleep/wait loops or repeated bg_watch(action=status) calls to wait for a background task. This defeats the purpose of the tool and wastes tokens.",
			"If the user explicitly asks to check progress, use action=output ONCE to show the log tail. Do not loop.",
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
			log_file: Type.Optional(Type.String({ description: "日志文件路径，output 时读取尾部；watch 时记录以便完成时附带" })),
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
					return { content: [{ type: "text", text: "当前没有监控中的后台任务。" }] };
				}
				const lines = active.map((r) => {
					const alive = isAlive(r.pid);
					const elapsed = formatDuration(Date.now() - r.startedAt);
					const cmd = r.command ? ` [${r.command}]` : "";
					return `- PID ${r.pid}${alive ? " ●" : " ○"} ${r.label}${cmd}（${elapsed}）${alive ? "" : " ⚠️进程已退出但通知未消费"}`;
				});
				return { content: [{ type: "text", text: `监控中的后台任务（${active.length}）：\n${lines.join("\n")}\n\n● 运行中 ○ 已退出` }] };
			}

			// all actions below require pid
			if (!params.pid) {
				return { content: [{ type: "text", text: `bg_watch ${action}: 需要 pid 参数。` }], isError: true };
			}
			const pid = params.pid;

			// ── watch ──
			if (action === "watch") {
				if (!params.label) {
					return { content: [{ type: "text", text: "bg_watch watch: label 必填。" }], isError: true };
				}
				// check if already watched
				const existing = loadRecord(pid);
				if (existing) {
					// watcher dead but state file remains → auto-cleanup and allow re-watch
					const watcherAlive = existing.watcherPid ? isAlive(existing.watcherPid) : false;
					if (watcherAlive) {
						return { content: [{ type: "text", text: `PID ${pid} 已在监控中（watcher ${existing.watcherPid} 存活）。如需重新挂，先 cancel 再 watch。` }], isError: true };
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
							if (!done.quiet) notifyDone(done);
						} catch { /* 损坏文件直接删除 */ try { unlinkSync(dp); } catch {} }
						refreshUI();
						return { content: [{ type: "text", text: `PID ${pid} 已退出，完成通知已补发。无需重新挂监控。` }] };
					}
					return { content: [{ type: "text", text: `PID ${pid} 不存在或已退出，无法挂监控。` }], isError: true };
				}
				const record: WatchRecord = {
					pid,
					label: params.label,
					logFile: params.log_file,
					quiet: params.quiet,
					startedAt: Date.now(),
					command: params.command,
				};
				const watcherPid = startWatcher(record);
				startChecker();
				refreshUI();
				return {
					content: [{ type: "text", text: `已挂监控：PID ${pid}（${params.label}），watcher=${watcherPid}。\n⚠️ 进程退出时系统会自动推送通知，无需轮询。请继续其他工作或结束当前回合等待。\n中途可用 action=output 查看一次日志，action=cancel 取消监控，action=kill 终止进程。` }],
					details: { pid, label: params.label, watcherPid },
				};
			}

			// ── status ──
			if (action === "status") {
				const rec = loadRecord(pid);
				if (!rec) {
					// may have completed, check done file
					if (existsSync(donePath(pid))) {
						return { content: [{ type: "text", text: `PID ${pid} 已完成但通知尚未消费，等待下一轮 checker 处理。` }] };
					}
					return { content: [{ type: "text", text: `PID ${pid} 不在监控列表中。` }], isError: true };
				}
				const alive = isAlive(pid);
				const watcherAlive = rec.watcherPid ? isAlive(rec.watcherPid) : false;
				const elapsed = formatDuration(Date.now() - rec.startedAt);
				const lines = [
					`任务：${rec.label}`,
					`PID：${pid}（${alive ? "运行中" : "已退出"}）`,
					`已运行：${elapsed}`,
					`Watcher：${rec.watcherPid ?? "未知"}（${watcherAlive ? "健康" : "已退出 ⚠️"}）`,
					`日志：${rec.logFile ?? "未设置"}`,
					`命令：${rec.command ?? "未记录"}`,
				];
				if (!alive) lines.push("⚠️ 目标进程已退出，完成通知即将触发。");
				if (!watcherAlive && alive) lines.push("⚠️ Watcher 异常退出，完成通知可能丢失。建议 cancel 后重新 watch。");
				return { content: [{ type: "text", text: lines.join("\n") }] };
			}

			// ── output ──
			if (action === "output") {
				const rec = loadRecord(pid);
				const logFile = params.log_file ?? rec?.logFile;
				if (!logFile) {
					return { content: [{ type: "text", text: `PID ${pid} 未关联日志文件。请提供 log_file 参数。` }], isError: true };
				}
				const tail = readLogTail(logFile, params.lines ?? 30);
				if (tail === null) {
					return { content: [{ type: "text", text: `日志文件不存在或不可读：${logFile}` }], isError: true };
				}
				const alive = isAlive(pid);
				return {
					content: [{ type: "text", text: `[${alive ? "运行中" : "已退出"}] ${logFile} 尾部：\n\`\`\`\n${tail}\n\`\`\`` }],
				};
			}

			// ── cancel ──
			if (action === "cancel") {
				const rec = loadRecord(pid);
				if (!rec) {
					return { content: [{ type: "text", text: `PID ${pid} 不在监控列表中，无需取消。` }] };
				}
				removeWatch(pid);
				refreshUI();
				const targetAlive = isAlive(pid);
				return {
					content: [{ type: "text", text: `已取消对 PID ${pid}（${rec.label}）的监控。${targetAlive ? "目标进程仍在运行。" : "目标进程已退出。"}\n如需重新挂监控：bg_watch({ action: "watch", pid: ${pid}, label: "..." })` }],
				};
			}

			// ── kill ──
			if (action === "kill") {
				const rec = loadRecord(pid);
				if (!isAlive(pid)) {
					// process dead, clean up watch
					if (rec) removeWatch(pid);
					return { content: [{ type: "text", text: `PID ${pid} 已不存在，无需终止。${rec ? "已清理监控状态。" : ""}` }] };
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
				};
			}

			return { content: [{ type: "text", text: `未知 action: ${action}` }], isError: true };
		},
	});

	// ── Register Command ──

	pi.registerCommand("bg-watch", {
		description: "后台任务管理 (bg-watch [watch|list|status|cancel|kill] [pid] [label])",
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
				startWatcher({ pid, label, startedAt: Date.now() });
				startChecker();
				refreshUI();
				ctx.ui.notify(`已监控 PID ${pid}（${label}）`, "info");
				return;
			}

			// subcommands: watch/status/cancel/kill <pid>
			const pid = Number(parts[1]);
			if (!Number.isInteger(pid) || pid <= 0) {
				ctx.ui.notify("用法: /bg-watch <watch|list|status|cancel|kill> <pid> [label]", "warning");
				return;
			}

			if (sub === "watch") {
				const label = parts.slice(2).join(" ") || `PID ${pid}`;
				if (!isAlive(pid)) { ctx.ui.notify(`PID ${pid} 不存在或已退出`, "error"); return; }
				if (loadRecord(pid)) { ctx.ui.notify(`PID ${pid} 已在监控中`, "warning"); return; }
				startWatcher({ pid, label, startedAt: Date.now() });
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

			ctx.ui.notify(`未知子命令: ${sub}。可用: watch, list, status, cancel, kill`, "warning");
		},
	});

	// ── Session Start Recovery ──

	pi.on("session_start", async (_event, ctx) => {
		// capture UI ref for widget/status updates
		if (ctx.hasUI) {
			uiRef = {
				setStatus: (key, text) => ctx.ui.setStatus(key, text),
				setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options as any),
				theme: (ctx.ui as any).theme,
			};
		}
		const pending = consumeDone();
		for (const done of pending) {
			if (!done.quiet) notifyDone(done);
		}
		if (listActive().length > 0) startChecker();
		refreshUI();
	});
}
