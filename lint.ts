/**
 * pi-lint orchestrator.
 *
 * Wires the pure rules in `rules.ts` to Pi runtime state:
 *  - reads the current draft from the editor
 *  - extracts isFirstMessage / lastAssistantText / priorReviewPasteCount
 *    from the active branch
 *  - renders findings as a widget above the input bar (default placement)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	type Finding,
	type LintContext,
	looksLikeReviewPaste,
	runRules,
	type Severity,
} from "./rules.js";

export const PI_LINT_WIDGET_KEY = "pi-lint";

// ---------- Building the LintContext from Pi session state ----------

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

function isMessageEntry(entry: Entry): entry is Entry & {
	type: "message";
	message: { role: string; content: unknown };
} {
	return (entry as { type?: string })?.type === "message";
}

function messageRole(entry: Entry): string | undefined {
	if (!isMessageEntry(entry)) return undefined;
	return (entry.message as { role?: string }).role;
}

function userMessageText(entry: Entry): string {
	if (!isMessageEntry(entry)) return "";
	const msg = entry.message as { role: string; content: unknown };
	if (msg.role !== "user") return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((p): p is { type: "text"; text: string } => (p as { type?: string })?.type === "text")
		.map((p) => p.text)
		.join("\n");
}

function assistantMessageText(entry: Entry): string {
	if (!isMessageEntry(entry)) return "";
	const msg = entry.message as { role: string; content: unknown };
	if (msg.role !== "assistant") return "";
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((p): p is { type: "text"; text: string } => (p as { type?: string })?.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

export function buildLintContext(ctx: ExtensionContext, draft: string): LintContext {
	let branch: Entry[] = [];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		branch = [];
	}

	let userCount = 0;
	let priorReviewPasteCount = 0;
	let lastAssistantText: string | null = null;

	for (const entry of branch) {
		const role = messageRole(entry);
		if (role === "user") {
			userCount++;
			const text = userMessageText(entry);
			if (text && looksLikeReviewPaste(text)) priorReviewPasteCount++;
		} else if (role === "assistant") {
			const text = assistantMessageText(entry);
			if (text) lastAssistantText = text;
		}
	}

	return {
		text: draft,
		isFirstMessage: userCount === 0,
		lastAssistantText,
		priorReviewPasteCount,
	};
}

// ---------- Widget rendering ----------

function severityGlyph(sev: Severity): string {
	switch (sev) {
		case "critical":
			return "✖";
		case "warn":
			return "▲";
		case "info":
			return "ℹ";
	}
}

function severityColor(sev: Severity): string {
	switch (sev) {
		case "critical":
			return "error";
		case "warn":
			return "warning";
		case "info":
			return "muted";
	}
}

export function findingsSignature(findings: Finding[]): string {
	return findings.map((f) => `${f.severity}:${f.ruleId}`).join("|");
}

/**
 * Structural type for the theme object — we only need `fg(color, text)`.
 * Avoids importing the runtime-internal `Theme` from pi-coding-agent.
 */
export interface ThemeLike {
	fg(color: string, text: string): string;
}

export function renderFindings(findings: Finding[], theme: ThemeLike): string[] {
	if (findings.length === 0) return [];
	const lines: string[] = [];
	for (const f of findings) {
		const glyph = theme.fg(severityColor(f.severity), severityGlyph(f.severity));
		const id = theme.fg("dim", `pi-lint:${f.ruleId}`);
		lines.push(`${glyph} ${f.headline}  ${id}`);
		if (f.hint) {
			lines.push(`  ${theme.fg("dim", "↳")} ${theme.fg("muted", f.hint)}`);
		}
	}
	return lines;
}

/**
 * Drafts that are pure shell invocations (pi's bash mode, leading `!` or
 * `!!`) are not natural-language prompts — the rules are not designed for
 * them and would mostly fire false positives (e.g. `!watch the queue`,
 * `!grep -rn 'still failing' .`). Skip linting entirely.
 */
export function isBashModeDraft(draft: string): boolean {
	return /^\s*!/.test(draft);
}

export function lintAndFormat(
	ctx: ExtensionContext,
	draft: string,
	disabled: ReadonlySet<string>,
	enabled: ReadonlySet<string>,
	theme: ThemeLike,
): { findings: Finding[]; lines: string[] } {
	if (isBashModeDraft(draft)) {
		return { findings: [], lines: [] };
	}
	const lintCtx = buildLintContext(ctx, draft);
	const findings = runRules(lintCtx, disabled, enabled);
	return { findings, lines: renderFindings(findings, theme) };
}
