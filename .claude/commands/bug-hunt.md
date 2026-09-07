---
description: Hunt for bugs, bad implementations, and incoherent UX across a feature area (not diff-scoped)
argument-hint: "[feature area, path, or 'recent' — e.g. 'stash', 'src/components/dialogs/lv-github-dialog.ts', 'recent']"
---

# Bug Hunt: $ARGUMENTS

You are hunting for **real defects a user would actually hit** in Gitnado. This is not a diff review — you are auditing a *feature area as it exists today*, including code nobody has touched in months.

Three classes of defect are in scope, weighted equally:

1. **Bugs** — wrong behaviour, crashes, data loss, races, unhandled failures.
2. **Bad implementations** — code that "works" but is wired wrong: duplicated logic that has drifted, state that can't be reached, contracts held together by coincidence, error handling that swallows.
3. **Incorrect or incoherent UX** — flows that dead-end, silent failures, the same operation behaving differently depending on where the user invoked it, missing empty/loading/error states, confirmations that lie about what they do.

## Ground rules

- **Prove it or drop it.** Every finding must cite `file:line` and be traceable in the code you actually read. If you cannot state a concrete repro — "user does X with Y state, gets Z, should get W" — it is not a finding.
- **No invented nitpicks.** Style, naming preferences, "could be more idiomatic", missing comments, hypothetical futures — all out of scope unless they cause a defect.
- **A pattern that looks wrong may be deliberate.** `CODE_REVIEW.md` documents past false positives (escaped-then-highlighted HTML, listener cleanup in `disconnectedCallback`, OAuth public-client secrets, broad `$HOME` fs scope). Check it before reporting anything in those areas, and check for `SAFETY:` comments.
- **Read the whole path before judging.** A missing `.catch()` may be caught upstream; a missing toast may be shown by the caller. Follow the call chain to both ends.
- **Do not fix anything yet.** This command produces a ranked findings report. Fixes happen after the user picks.

## Phase 0 — Scope and inventory

Establish the surface before reading line by line.

- If `$ARGUMENTS` names a feature (e.g. "stash", "rebase", "worktrees"), find every layer it touches: `src-tauri/src/commands/*.rs`, `src/services/*.ts`, `src/types/api.types.ts`, the owning component(s), the store slice, and its tests.
- If `$ARGUMENTS` is `recent`, use `git log --since="3 weeks ago" --name-only --pretty=format:` to rank files by churn and hunt the top ~15.
- If `$ARGUMENTS` is empty, ask which area — do not audit 76 Rust command files at once.

Write a short inventory: every **user-reachable entry point** into this area. Gitnado exposes the same operation from many places — toolbar buttons, context menus, the command palette (`lv-command-palette.ts`), keyboard shortcuts (`keyboard.service.ts`), dialogs, and drag-and-drop. Enumerate them all; divergence between them is one of the richest defect sources here.

## Phase 1 — Trace each flow end to end

For each entry point, walk the full stack and note where it breaks:

```
user gesture → component handler → service (git.service.ts / *.service.ts)
  → invokeCommand → Rust command → git2 / process
  → Result → TS return type → store mutation → re-render → user feedback
```

Bugs in this codebase concentrate at the **seams**. At each arrow ask: what happens on failure, on empty, on slow, and on the second concurrent call?

## Phase 2 — Defect taxonomy

Hunt these deliberately. Each is a pattern that has produced real bugs in this repo.

### A. Contract seams (TS ↔ Rust)
- snake_case leaking into an `invokeCommand` argument object or `gitService.*` call — Tauri will silently pass `undefined` and the command fails or misbehaves. Sweep:
  ```bash
  grep -rn "_[a-z]*:" src/types/api.types.ts src/services/ src/app-shell.ts src/components/ --include="*.ts" | grep -v __tests__
  ```
- TS interface in `api.types.ts` disagreeing with the Rust struct it mirrors — extra field, wrong optionality, renamed field, field the backend never populates.
- `Option<T>` → `T | null` vs `T | undefined` mismatches; code checking `if (x)` where `0`/`""` is legitimate.
- Rust returning `Ok(vec![])` where the caller renders "error", or returning `Err` where empty is the normal case.

### B. Event wiring
- A `CustomEvent` dispatched with **no listener anywhere** — dead code, and the user's action silently does nothing. For each event name found, grep for the matching `@name=` / `addEventListener`.
- **Sibling asymmetry**: `handleAdd` dispatches `foo-changed` but `handleRemove`/`handleUpdate` don't, so the UI goes stale after one of three operations.
- State-modifying handlers in `app-shell.ts` calling only `graphCanvas?.refresh?.()` instead of `handleRefresh()` — graph updates but the store, search index, and `repository-refresh` listeners don't.
- Window-level events (`ai-settings-changed` and friends) dispatched by some handlers that change the state but not all of them.

### C. Feedback and states
- **Silent error paths**: `if (result.success) {...}` with no `else`, or an `else` that only does `console.error`. Sweep:
  ```bash
  grep -rn "console.error" src --include="*.ts" | grep -v __tests__
  ```
  For each, ask whether the user sees anything. If not, that's a finding.
- Missing **empty / loading / disabled** states: a list that renders nothing with no "no branches yet" message; a button clickable while the operation is in flight (double-submit); a long git operation with no progress indication.
- Dialogs that close on failure and lose the user's input, or stay open with no message.
- Toast vs inline (`this.error`/`this.success`) chosen inconsistently between sibling handlers.

### D. Cross-provider coherence
`github` / `gitlab` / `bitbucket` / `azure_devops` (and their dialogs, OAuth flows, and Rust commands) should behave the same. Diff them against each other and report where one provider is missing pagination, error mapping, a rate-limit path, token refresh, an empty state, or a confirm that the others have.

### E. Async, races, staleness
- Unawaited promises and `.then()` without `.catch()`.
- **Concurrent-flow state**: a single module-level mutable variable serving flows that can overlap (this is exactly how the OAuth `pendingAuth` bug happened — it needed to be a Map keyed by provider). Look for any shared "pending"/"current"/"inFlight" singleton.
- **Stale results**: an async call that resolves *after* the user switched repository, branch, or commit, then writes its result into the now-wrong context. The repository store is `openRepositories[]` + `activeIndex` — any code that captured a repo path or index before an `await` is suspect.
- Anything assuming a single open repository, or indexing `openRepositories` without bounds checks on both ends.
- Watchers/intervals/listeners registered in `connectedCallback` (or a service `init`) with no matching teardown.

### F. Rust backend
- `Path::join` on user-supplied paths without `validate_path_within_repo()` from `path_utils.rs` — path traversal.
- `.unwrap()` / `.expect()` on anything derived from user input, repo state, or IO, outside `#[cfg(test)]` — a panic across the Tauri boundary is a hung UI, not an error message.
- Raw `git2` / IO error strings surfaced straight to the user with no translation.
- Operations that mutate the repo without the network-permission check its siblings perform, or without honouring the repo pin.
- Missing validation on refs/branch names/remote names before shelling out or calling git2.

### G. Destructive operations
For anything that can lose work — `clean`, force branch delete, hard reset, discard changes, stash drop, rebase, force push — verify: an explicit confirm exists, the confirm text names *exactly* what will be destroyed (count and scope), the operation is actually blocked when the user declines, and there is a stated recovery path where one exists.

### H. Dead ends and half-wired features
- Buttons/menu items that call a handler that does nothing, or a command that isn't registered.
- `TODO` / `FIXME` / `not implemented` on a user-reachable path.
- Features present in one surface but absent from the command palette or keyboard map, with no reason.
- Settings that are persisted but never read, or read but never applied without a restart the UI never mentions.

## Phase 3 — Verify before reporting

For every candidate, run an adversarial pass against yourself: **try to refute it.** Re-read the surrounding code and the call sites looking for the thing that makes it *not* a bug — the upstream guard, the caller's error handling, the `SAFETY:` comment, the test that covers it. Default to dropping the finding when you can't close the gap.

Then classify what survives:
- **CONFIRMED** — you traced the full path and can state the repro concretely.
- **PLAUSIBLE** — the defect is real in the code you read, but one link (e.g. runtime data shape) you could not verify statically. Say which link.

Drop everything else. A short report of real bugs beats a long one padded with maybes.

## Phase 4 — Report

Rank by severity — user-visible data loss and crashes first, then wrong behaviour, then incoherent UX, then bad-implementation risk. For each finding:

```
### [SEVERITY] Short title
**Where:** src/path/file.ts:123 (+ any other sites)
**Verdict:** CONFIRMED | PLAUSIBLE
**What breaks:** concrete repro — state, gesture, observed result, expected result.
**Why:** the mechanism, in one or two sentences.
**Minimal fix:** the smallest change that resolves it. No refactors.
**Test gap:** which existing test should have caught this and why it didn't, or the test to add.
```

End with exactly one line: `VERDICT: N issues found` or `VERDICT: NO ISSUES FOUND`.

Do **not** write findings to a file in the repo — report them in your message. Do not commit anything.

## Scaling up

For a scope larger than ~5 files, fan out: run three independent hunters in parallel on three different models (Opus, Sonnet, Haiku), each auditing the **entire** scope holistically with this same prompt — do not assign each one a lens or a subset. Dedupe their findings, keep what survives Phase 3, and report the union. If the user asks for a fix pass afterwards, apply the fixes with tests and re-run all three hunters until every one returns `NO ISSUES FOUND` in the same round.

Before handing back any fixes:

```bash
npm run lint && npm run typecheck && npm test && cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings
```
