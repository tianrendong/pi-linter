/**
 * pi-lint rules — pure functions over a small LintContext.
 *
 * No Pi imports here on purpose: keeps the rule set unit-testable in isolation
 * and forces every input the rules need to be made explicit on LintContext.
 */

export type Severity = "info" | "warn" | "critical";

/**
 * Everything the rules need to know to evaluate the current draft.
 *
 * `text`               — current editor text (the draft about to be sent)
 * `isFirstMessage`     — true if no user messages exist yet on the active branch
 * `lastAssistantText`  — last assistant turn's text content, or null
 * `priorReviewPasteCount` — how many *prior* user messages on the branch looked
 *                          like pasted code-review comments
 */
export interface LintContext {
	text: string;
	isFirstMessage: boolean;
	lastAssistantText: string | null;
	priorReviewPasteCount: number;
}

export interface Finding {
	ruleId: string;
	severity: Severity;
	headline: string; // short, fits on one line
	hint?: string; // longer suggestion / template
}

export interface Rule {
	id: string;
	defaultEnabled: boolean;
	check(ctx: LintContext): Finding | null;
}

// ---------- Helpers ----------

const URL_RE = /\bhttps?:\/\/\S+/i;
// Path with extension OR :line, OR a leading ./ ~ / segment.
const PATH_RE = /(?:^|\s)(?:[~./][\w./-]+|[\w./-]+\.\w{1,8})(?::\d+)?\b/;
const ISSUE_ID_RE = /(?:[A-Z]{2,}-\d+|#\d+)\b/;
const REVIEW_LINE_RE = /^\s*(?:Comment\s*\d+\s*:|Hunk\s*:|@@\s*-)/im;

const REACTIVE_PHRASES = [
	"still not working",
	"still broken",
	"still failing",
	"still wrong",
	"try again",
	"same issue",
	"same problem",
	"same error",
	"didn't work",
	"didnt work",
	"doesn't work",
	"doesnt work",
	"not working",
];

const IMPERATIVE_ONLY = new Set([
	"do it",
	"yes",
	"go",
	"continue",
	"ok",
	"okay",
	"proceed",
	"fix it",
	"please",
	"sure",
	"k",
	"y",
]);

const SCOPE_CREEP_OPENERS = [
	"let's also",
	"lets also",
	"also,",
	"btw,",
	"by the way,",
	"while you're at it",
	"while you are at it",
	"one more thing",
	"oh and",
	"oh, and",
];

const LOOP_TRIGGERS = [
	"watch",
	"monitor",
	"keep running",
	"keep trying",
	"keep retrying",
	"loop",
	"forever",
	"indefinitely",
	"in a loop",
];
const LOOP_EVERY_RE = /\bevery\s+\d+\s*(?:ms|s|sec|seconds?|m|min|minutes?|h|hours?)?/i;
const LOOP_UNTIL_RE = /\buntil\b/i;

// Words that signal a stop / escalation criterion. If any are present, treat
// the loop as bounded.
const STOP_WORDS = [
	"stop when",
	"stop after",
	"stop if",
	"escalate",
	"give up",
	"max",
	"at most",
	"once",
	"ping me",
	"notify me",
	"tell me when",
	"unless",
	"after n",
	"retry once",
	"retry twice",
	"retry up to",
];

function lower(s: string): string {
	return s.toLowerCase();
}

function trimmedLower(s: string): string {
	return lower(s.trim());
}

function includesAny(haystack: string, needles: string[]): boolean {
	return needles.some((n) => haystack.includes(n));
}

function startsWithAny(haystack: string, needles: string[]): boolean {
	return needles.some((n) => haystack.startsWith(n));
}

function hasAnchor(text: string): boolean {
	return URL_RE.test(text) || PATH_RE.test(text) || ISSUE_ID_RE.test(text);
}

/** Heuristic check for "this draft looks like a pasted review comment". */
export function looksLikeReviewPaste(text: string): boolean {
	return REVIEW_LINE_RE.test(text);
}

/**
 * Split a draft into (review-block, instruction-text).
 *
 * Review-block lines are anything matched by REVIEW_LINE_RE and the diff-style
 * lines that typically follow them. Instruction text is the remainder — what
 * the user actually wrote *to* the agent on top of the paste.
 */
function nonPasteLength(text: string): number {
	const lines = text.split("\n");
	let kept: string[] = [];
	let inHunk = false;
	for (const line of lines) {
		if (REVIEW_LINE_RE.test(line)) {
			inHunk = true;
			continue;
		}
		// Heuristic: lines that look like diff context once we're in a hunk.
		if (inHunk && /^[\s+\-@]/.test(line) && line.trim().length > 0) {
			continue;
		}
		if (line.trim() === "") {
			inHunk = false;
		}
		kept.push(line);
	}
	return kept.join("\n").trim().length;
}

/**
 * Count "bare" pronouns — pronouns not anchored to a noun.
 *
 * Approximation without a POS tagger:
 *   - `it`, `them`, `they` are always counted (they're pure pronouns).
 *   - `this`, `that` count only when NOT immediately followed by a lowercase
 *     word of length >= 3 (which would make them determiners: "this file",
 *     "that line"). Standalone use ("this is broken") is bare.
 */
function countBarePronouns(text: string): number {
	let count = 0;
	const re = /\b(this|that|it|them|they)\b(\s+([A-Za-z][A-Za-z'-]*))?/gi;
	for (const m of text.matchAll(re)) {
		const word = m[1].toLowerCase();
		const next = m[3]?.toLowerCase();
		if (word === "it" || word === "them" || word === "they") {
			count++;
			continue;
		}
		// this / that
		if (!next || next.length < 3) {
			count++;
			continue;
		}
		// "this is", "that was" — `this` here is still a bare pronoun.
		if (next === "is" || next === "was" || next === "are" || next === "were" || next === "will" || next === "should") {
			count++;
			continue;
		}
		// otherwise it's acting as a determiner ("this file") — anchored.
	}
	return count;
}

// ---------- Rules ----------

export const RULES: Rule[] = [
	// ----- Basics (default-on) -----
	{
		id: "vague-opener",
		defaultEnabled: true,
		check(ctx) {
			if (!ctx.isFirstMessage) return null;
			const t = ctx.text.trim();
			if (t.length === 0 || t.length >= 60) return null;
			if (hasAnchor(t)) return null;
			return {
				ruleId: "vague-opener",
				severity: "warn",
				headline: "vague opener — add a link, file path, or error",
				hint: "implement <linear/notion url>  ·  fix <file>:<line>: <error>",
			};
		},
	},

	// ----- Off by default; opt in via `/pi-lint enable <id>` -----
	{
		id: "pronoun-soup",
		defaultEnabled: false,
		check(ctx) {
			const t = ctx.text;
			if (t.length === 0 || t.length >= 300) return null;
			if (countBarePronouns(t) < 2) return null;
			return {
				ruleId: "pronoun-soup",
				severity: "warn",
				headline: "pronoun soup — replace bare it/this/they with concrete names",
				hint: "\"the receipt processor\" not \"it\"  ·  \"models.py:42\" not \"that line\"",
			};
		},
	},

	{
		id: "reactive-noop",
		defaultEnabled: true, // basics
		check(ctx) {
			const t = ctx.text.trim();
			if (t.length === 0 || t.length >= 80) return null;
			const lc = lower(t);
			if (!includesAny(lc, REACTIVE_PHRASES)) return null;
			return {
				ruleId: "reactive-noop",
				severity: "warn",
				headline: "reactive no-op — add what's new: command run, fresh output, what changed",
				hint: "ran X, got Y instead of Z; restarted the worker first",
			};
		},
	},

	{
		id: "imperative-only",
		defaultEnabled: false,
		check(ctx) {
			const lc = trimmedLower(ctx.text).replace(/[.!?]+$/g, "");
			if (lc.length === 0) return null;
			if (!IMPERATIVE_ONLY.has(lc)) return null;
			const last = ctx.lastAssistantText?.trim() ?? "";
			if (last.endsWith("?")) return null;
			return {
				ruleId: "imperative-only",
				severity: "warn",
				headline: "imperative only — last turn wasn't a yes/no question",
				hint: "say what to do: \"go ahead with option B\"  ·  \"continue with the migration plan\"",
			};
		},
	},

	{
		id: "scope-creep",
		defaultEnabled: false,
		check(ctx) {
			if (ctx.isFirstMessage) return null;
			const lc = trimmedLower(ctx.text);
			if (lc.length === 0) return null;
			if (!startsWithAny(lc, SCOPE_CREEP_OPENERS)) return null;
			return {
				ruleId: "scope-creep",
				severity: "info",
				headline: "scope creep — open a new session/PR for unrelated work",
				hint: "capture in TODO.md, finish current PR, start a fresh pi session",
			};
		},
	},

	{
		id: "reversal",
		defaultEnabled: false,
		check(ctx) {
			const lc = trimmedLower(ctx.text);
			if (!lc.startsWith("actually,") && !lc.startsWith("actually ")) return null;
			return {
				ruleId: "reversal",
				severity: "info",
				headline: "reversal — decide the shape upfront before coding next time",
				hint: "\"sketch the data model first, push back if you disagree\"",
			};
		},
	},

	{
		id: "unbounded-loop",
		defaultEnabled: true, // basics
		check(ctx) {
			const lc = lower(ctx.text);
			if (lc.length === 0) return null;
			const hasLoop =
				includesAny(lc, LOOP_TRIGGERS) || LOOP_EVERY_RE.test(lc) || LOOP_UNTIL_RE.test(lc);
			if (!hasLoop) return null;
			if (includesAny(lc, STOP_WORDS)) return null;
			return {
				ruleId: "unbounded-loop",
				severity: "critical",
				headline: "unbounded loop — add stop criteria: when to escalate or quit",
				hint: "\"retry once on flaky tests, ping me on any other failure\"",
			};
		},
	},

	{
		id: "naked-review-paste",
		defaultEnabled: false,
		check(ctx) {
			if (!REVIEW_LINE_RE.test(ctx.text)) return null;
			if (nonPasteLength(ctx.text) >= 40) return null;
			return {
				ruleId: "naked-review-paste",
				severity: "warn",
				headline: "naked review paste — tell the agent what to do with these comments",
				hint: "\"address all\"  ·  \"validate first, then fix #1 and #3\"  ·  \"ignore style ones\"",
			};
		},
	},

	{
		id: "review-drip",
		defaultEnabled: false,
		check(ctx) {
			if (!looksLikeReviewPaste(ctx.text)) return null;
			if (ctx.priorReviewPasteCount < 2) return null;
			return {
				ruleId: "review-drip",
				severity: "info",
				headline: `review drip — ${ctx.priorReviewPasteCount + 1} review pastes this session, batch them`,
				hint: "\"here are 5 comments, address them all and tell me which you disagree with\"",
			};
		},
	},
];

/**
 * A rule fires if the user explicitly opted it in (`enabled.has(id)`)
 * OR it is a default-on rule that the user has not disabled.
 */
export function isRuleActive(
	rule: Rule,
	disabled: ReadonlySet<string>,
	enabled: ReadonlySet<string>,
): boolean {
	if (enabled.has(rule.id)) return true;
	if (disabled.has(rule.id)) return false;
	return rule.defaultEnabled;
}

export function runRules(
	ctx: LintContext,
	disabled: ReadonlySet<string>,
	enabled: ReadonlySet<string> = new Set(),
): Finding[] {
	const findings: Finding[] = [];
	for (const rule of RULES) {
		if (!isRuleActive(rule, disabled, enabled)) continue;
		const f = rule.check(ctx);
		if (f) findings.push(f);
	}
	return findings;
}
