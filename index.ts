/**
 * pi-lint — Pi extension entry point.
 *
 * Renders an inline linter above the input bar that flags conversational
 * anti-patterns in the current draft (vague openers, pronoun soup, scope
 * creep, unbounded loops, etc.). All rules are deterministic and run
 * locally — no LLM calls.
 *
 * UX:
 *   - widget appears above the editor with one line per finding
 *   - non-blocking: pressing Enter still sends the message
 *   - poll the editor every PI_LINT_POLL_MS (default 250ms)
 *
 * Configure with:
 *   /pi-lint                   → interactive menu
 *   /pi-lint status            → show current rule state
 *   /pi-lint disable <rule>    → turn off one rule
 *   /pi-lint enable <rule>     → turn it back on
 *   /pi-lint off | on          → globally disable / enable
 *   /pi-lint reset             → restore defaults
 *
 *   PI_LINT_DISABLE=rule1,rule2  (env, overrides persisted config)
 *   PI_LINT_OFF=1                (env, fully disable)
 *   PI_LINT_POLL_MS=250          (env, override poll interval)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { findingsSignature, lintAndFormat, PI_LINT_WIDGET_KEY } from "./lint.js";
import { isRuleActive, RULES } from "./rules.js";

const COMMAND_NAME = "pi-lint";
const DEFAULT_POLL_MS = 250;
const MIN_POLL_MS = 50;

const ALL_RULE_IDS = RULES.map((r) => r.id);

interface PersistedConfig {
	off?: boolean;
	disabled?: string[]; // rule ids the user explicitly turned off
	enabled?: string[]; // rule ids the user explicitly opted in (for default-off rules)
}

interface ResolvedConfig {
	off: boolean;
	disabled: Set<string>;
	enabled: Set<string>;
	pollMs: number;
}

// ---------- Config ----------

function configPath(): string {
	return join(homedir(), ".pi", "pi-lint.json");
}

function loadPersisted(): PersistedConfig {
	try {
		const raw = readFileSync(configPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function savePersisted(config: PersistedConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
}

function parseDisabledEnv(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && ALL_RULE_IDS.includes(s));
}

function parsePollEnv(raw: string | undefined): number {
	if (!raw) return DEFAULT_POLL_MS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < MIN_POLL_MS) return DEFAULT_POLL_MS;
	return n;
}

function resolveConfig(persisted: PersistedConfig): ResolvedConfig {
	const envOff = process.env.PI_LINT_OFF === "1" || process.env.PI_LINT_OFF?.toLowerCase() === "true";
	const off = envOff || persisted.off === true;

	const disabled = new Set<string>([
		...(persisted.disabled ?? []).filter((id) => ALL_RULE_IDS.includes(id)),
		...parseDisabledEnv(process.env.PI_LINT_DISABLE),
	]);

	const enabled = new Set<string>([
		...(persisted.enabled ?? []).filter((id) => ALL_RULE_IDS.includes(id)),
		...parseDisabledEnv(process.env.PI_LINT_ENABLE),
	]);

	return { off, disabled, enabled, pollMs: parsePollEnv(process.env.PI_LINT_POLL_MS) };
}

// ---------- The extension ----------

export default function (pi: ExtensionAPI): void {
	let persisted = loadPersisted();
	let config = resolveConfig(persisted);

	function persist(mutate: (draft: PersistedConfig) => void): void {
		const next: PersistedConfig = JSON.parse(JSON.stringify(persisted));
		mutate(next);
		persisted = next;
		config = resolveConfig(next);
		try {
			savePersisted(next);
		} catch (err) {
			console.error("[pi-lint] failed to save config:", err);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Reload from disk + re-overlay env each session in case it changed.
		persisted = loadPersisted();
		config = resolveConfig(persisted);

		let lastSig = "";

		const tick = (): void => {
			if (config.off) {
				if (lastSig !== "") {
					ctx.ui.setWidget(PI_LINT_WIDGET_KEY, undefined);
					lastSig = "";
				}
				return;
			}

			const draft = ctx.ui.getEditorText() ?? "";
			const { findings, lines } = lintAndFormat(
				ctx,
				draft,
				config.disabled,
				config.enabled,
				ctx.ui.theme,
			);
			const sig = findingsSignature(findings);
			if (sig === lastSig) return;
			lastSig = sig;

			if (lines.length === 0) {
				ctx.ui.setWidget(PI_LINT_WIDGET_KEY, undefined);
				return;
			}
			ctx.ui.setWidget(PI_LINT_WIDGET_KEY, lines, { placement: "aboveEditor" });
		};

		const handle = setInterval(tick, config.pollMs);
		(handle as { unref?: () => void }).unref?.();

		// Stash the interval so we can clear on shutdown.
		(ctx as unknown as { __piLintInterval?: ReturnType<typeof setInterval> }).__piLintInterval = handle;

		// Initial render so users see disabled-state immediately.
		tick();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const stash = ctx as unknown as { __piLintInterval?: ReturnType<typeof setInterval> };
		if (stash.__piLintInterval) {
			clearInterval(stash.__piLintInterval);
			stash.__piLintInterval = undefined;
		}
		ctx.ui.setWidget(PI_LINT_WIDGET_KEY, undefined);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Configure pi-lint (linter for the input bar)",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			const subcommands = ["status", "on", "off", "enable", "disable", "reset"];
			if (!trimmed.includes(" ")) {
				const items = subcommands
					.filter((s) => s.startsWith(trimmed))
					.map((s) => ({ value: s, label: s }));
				return items.length > 0 ? items : null;
			}
			const [sub, ...rest] = trimmed.split(" ");
			if (sub === "enable" || sub === "disable") {
				const partial = rest.join(" ");
				return ALL_RULE_IDS
					.filter((id) => id.startsWith(partial))
					.map((id) => ({ value: `${sub} ${id}`, label: `${sub} ${id}` }));
			}
			return null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => handleCommand(args, ctx),
	});

	async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();

		if (!trimmed) {
			await runMenu(ctx);
			return;
		}

		const [sub, ...restParts] = trimmed.split(/\s+/);
		const rest = restParts.join(" ").trim();

		switch (sub) {
			case "status":
				ctx.ui.notify(formatStatus(), "info");
				return;
			case "on":
				persist((d) => {
					d.off = false;
				});
				ctx.ui.notify("pi-lint: on", "info");
				return;
			case "off":
				persist((d) => {
					d.off = true;
				});
				ctx.ui.setWidget(PI_LINT_WIDGET_KEY, undefined);
				ctx.ui.notify("pi-lint: off", "info");
				return;
			case "enable": {
				if (!rest) {
					ctx.ui.notify(`Usage: /${COMMAND_NAME} enable <rule-id>`, "warning");
					return;
				}
				if (!ALL_RULE_IDS.includes(rest)) {
					ctx.ui.notify(`Unknown rule "${rest}". Known: ${ALL_RULE_IDS.join(", ")}`, "error");
					return;
				}
				persist((d) => {
					d.disabled = (d.disabled ?? []).filter((id) => id !== rest);
					const en = new Set(d.enabled ?? []);
					en.add(rest);
					d.enabled = Array.from(en);
				});
				ctx.ui.notify(`pi-lint: enabled "${rest}"`, "info");
				return;
			}
			case "disable": {
				if (!rest) {
					ctx.ui.notify(`Usage: /${COMMAND_NAME} disable <rule-id>`, "warning");
					return;
				}
				if (!ALL_RULE_IDS.includes(rest)) {
					ctx.ui.notify(`Unknown rule "${rest}". Known: ${ALL_RULE_IDS.join(", ")}`, "error");
					return;
				}
				persist((d) => {
					d.enabled = (d.enabled ?? []).filter((id) => id !== rest);
					const dis = new Set(d.disabled ?? []);
					dis.add(rest);
					d.disabled = Array.from(dis);
				});
				ctx.ui.notify(`pi-lint: disabled "${rest}"`, "info");
				return;
			}
			case "reset":
				persist((d) => {
					d.off = false;
					d.disabled = [];
					d.enabled = [];
				});
				ctx.ui.notify("pi-lint: reset to defaults", "info");
				return;
			default:
				ctx.ui.notify(
					`Unknown subcommand "${sub}". Try: status, on, off, enable <rule>, disable <rule>, reset`,
					"error",
				);
		}
	}

	function formatStatus(): string {
		const lines: string[] = [];
		lines.push(`pi-lint: ${config.off ? "off" : "on"}`);
		lines.push(`poll: ${config.pollMs}ms`);
		lines.push("rules:");
		for (const rule of RULES) {
			const active = isRuleActive(rule, config.disabled, config.enabled);
			const note = rule.defaultEnabled
				? active
					? "on (default)"
					: "off (you disabled it)"
				: active
					? "on (you enabled it)"
					: "off (default)";
			lines.push(`  ${rule.id} — ${note}`);
		}
		lines.push(`config file: ${configPath()}`);
		return lines.join("\n");
	}

	async function runMenu(ctx: ExtensionCommandContext): Promise<void> {
		const choice = await ctx.ui.select("Configure pi-lint", [
			config.off ? "Turn pi-lint on" : "Turn pi-lint off",
			"Toggle a rule",
			"Show status",
			"Reset to defaults",
		]);
		if (!choice) return;

		switch (choice) {
			case "Turn pi-lint off":
				await handleCommand("off", ctx);
				return;
			case "Turn pi-lint on":
				await handleCommand("on", ctx);
				return;
			case "Toggle a rule": {
				const items = RULES.map((r) => {
					const active = isRuleActive(r, config.disabled, config.enabled);
					const tag = active ? "on" : "off";
					const dim = r.defaultEnabled ? "" : " — off by default";
					return `${r.id} (${tag})${dim}`;
				});
				const pick = await ctx.ui.select("Pick a rule to toggle", items);
				if (!pick) return;
				const ruleId = pick.split(" ")[0];
				const rule = RULES.find((r) => r.id === ruleId);
				if (!rule) return;
				if (isRuleActive(rule, config.disabled, config.enabled)) {
					await handleCommand(`disable ${ruleId}`, ctx);
				} else {
					await handleCommand(`enable ${ruleId}`, ctx);
				}
				return;
			}
			case "Show status":
				ctx.ui.notify(formatStatus(), "info");
				return;
			case "Reset to defaults": {
				const ok = await ctx.ui.confirm("Reset pi-lint?", "This clears your saved config.");
				if (!ok) return;
				await handleCommand("reset", ctx);
				return;
			}
		}
	}
}
