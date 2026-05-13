# pi-linter

> Inline session linter for [pi](https://github.com/earendil-works/pi-coding-agent). Catches vague openers, pronoun soup, scope creep, unbounded loops, and other input anti-patterns **before** you hit Enter.

A small, deterministic linter that renders findings above the input bar in pi.
No LLM calls, no latency. Pure regex/heuristic rules. Suggestions only — it
never blocks your message.

```
▲ vague opener — add a link, file path, or error  pi-lint:vague-opener
  ↳ implement <linear/notion url>  ·  fix <file>:<line>: <error>
✖ unbounded loop — add stop criteria: when to escalate or quit  pi-lint:unbounded-loop
  ↳ "retry once on flaky tests, ping me on any other failure"
```

## Why

System-prompt linters (PromptLint, PromptDoctor, etc.) check production prompt
artifacts for things like prompt injection and token bloat. **pi-lint targets a
different surface**: the *user's chat turn* in a multi-turn coding-agent
session. Its rules need conversation context (last assistant turn, message
count) and they fire on the soft, human anti-patterns that quietly degrade
agent sessions.

## Install

```bash
pi install npm:pi-linter
```

Or develop locally:

```bash
git clone https://github.com/tianrendong/pi-packs
cd pi-packs
npm install
pi install ./packages/pi-linter
```

> The npm package is `pi-linter` (the unscoped `pi-lint` slot was blocked by npm's name-similarity check). Slash commands, config file (`~/.pi/pi-lint.json`), and env vars (`PI_LINT_*`) all still use `pi-lint`.

## Rules

pi-linter ships with a small **basics** set on by default. The other rules are
opt-in via `/pi-lint enable <rule>` — the philosophy is to start quiet and let
you turn things on once you've seen them help.

### On by default

| Rule | Severity | Triggers when | Fix template |
|---|---|---|---|
| `vague-opener` | warn | First message of session, <60 chars, no URL / file path / issue ID | `implement <linear/notion url>` · `fix <file>:<line>: <error>` |
| `reactive-noop` | warn | Prompt <80 chars matching `still not working`, `try again`, `same issue`, `didn't work`, `still failing/broken/wrong` | `"ran X, got Y instead of Z; restarted the worker first"` |
| `unbounded-loop` | critical | Contains `watch`, `monitor`, `keep running/trying`, `every <N>`, `until`, `loop`, `forever` AND no stop criterion | `"retry once on flaky tests, ping me on any other failure"` |

### Off by default (opt in)

| Rule | Severity | Triggers when |
|---|---|---|
| `pronoun-soup` | warn | Prompt <300 chars contains 2+ bare `this/that/it/them/they` not anchored to a noun |
| `imperative-only` | warn | Prompt is exactly `do it`, `yes`, `go`, `continue`, `ok`, `proceed`, `fix it`, etc. AND last assistant turn didn't end with a question |
| `scope-creep` | info | Not the first message AND starts with `let's also`, `also,`, `btw,`, `while you're at it`, `one more thing` |
| `reversal` | info | Starts with `actually,` or `actually ` |
| `naked-review-paste` | warn | Contains `Comment N:` / `Hunk:` AND non-paste instruction text is <40 chars |
| `review-drip` | info | 3rd+ pasted review comment in the same session |

## Configure

Inside pi:

```
/pi-lint                    interactive menu
/pi-lint status             show rule state
/pi-lint disable <rule>     turn off one rule
/pi-lint enable <rule>      turn it back on
/pi-lint off                fully disable
/pi-lint on                 re-enable
/pi-lint reset              restore defaults
```

Persistent config lives at `~/.pi/pi-lint.json`.

### Environment variables

Env vars override the persisted config so existing setups keep working:

| Var | Effect |
|---|---|
| `PI_LINT_OFF=1` | Fully disable pi-lint for this session |
| `PI_LINT_DISABLE=rule1,rule2` | Disable specific rules for this session |
| `PI_LINT_ENABLE=rule1,rule2` | Opt in to off-by-default rules for this session |
| `PI_LINT_POLL_MS=250` | How often to re-evaluate the draft (default 250ms, min 50ms) |

## How it works

- On `session_start`, pi-lint installs an interval that polls the editor text
  every ~250ms.
- Each tick rebuilds a small `LintContext` from session state
  (`isFirstMessage`, `lastAssistantText`, `priorReviewPasteCount`) and runs all
  enabled rules against the current draft.
- If the set of findings changes, pi-lint updates a widget above the editor via
  `ctx.ui.setWidget("pi-lint", lines, { placement: "aboveEditor" })`.
- On `session_shutdown`, the interval is cleared and the widget is removed.

The rules in [`rules.ts`](./rules.ts) are pure functions over `LintContext`.
You can read them like ESLint rules — the file is small and adding a new rule
is one entry in the `RULES` array.

## Quiet contexts

pi-linter intentionally **stays silent** when:

- The draft is a pi bash-mode invocation (leading `!` or `!!`, e.g. `!ls`,
  `!!grep -rn 'still failing' .`). These are shell commands, not natural-language
  prompts — the rules don't apply.
- The draft is empty or whitespace-only.
- `/pi-lint off` or `PI_LINT_OFF=1`.

## Compatibility

Works in interactive mode (TUI). In `-p` print mode and JSON mode, `hasUI` is
false and pi-lint is a no-op. In RPC mode, `getEditorText()` returns `""`, so
pi-lint also stays silent there.

## License

MIT — see [LICENSE](./LICENSE).
