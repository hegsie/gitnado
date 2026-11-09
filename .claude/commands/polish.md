---
description: Audit a feature area or dialog for UX polish, dialog flow issues, visual/design defects, and seam bugs
argument-hint: "[feature area, dialog, path, or 'recent' — e.g. 'dialogs', 'stash', 'src/components/dialogs/', 'recent']"
---

# Polish & UX Audit: $ARGUMENTS

You are auditing **$ARGUMENTS** in Gitnado for bugs, broken user/dialog flows, and UX/design polish defects that a user would actually hit.

Four classes of defect are in scope, weighted equally:

1. **Dialog & User Flows** — focus traps, Escape/Enter keyboard handling, closing on error and losing user input, stale state when reopening or switching `openRepositories[]`, missing loading/disabled states (double-submit), dead-end flows, and unrecoverable errors.
2. **Design & Visual Polish** — layout/overflow breaks on long branch/file/repo names, inconsistent spacing/typography/design tokens, jarring state transitions, missing or unhelpful empty states, unclear destructive confirmations, and cross-provider (`github`/`gitlab`/`bitbucket`/`azure_devops`) UI drift.
3. **Bugs & Seam Errors** — TS↔Rust `snake_case` leaks, `invokeCommand` error paths that only `console.error` without `showToast()`/`this.error`, orphaned `CustomEvent`s, sibling handlers missing event dispatches, `app-shell.ts` calling `graphCanvas?.refresh?.()` instead of `handleRefresh()`, and async races across repo/branch switches.
4. **Entry-Point Parity** — divergent behaviour between toolbar buttons, context menus, command palette (`gn-command-palette.ts`), and keyboard shortcuts (`keyboard.service.ts`) for the same action.

## Ground rules

- **Prove it or drop it.** Every finding must cite `file:line` and state a concrete repro: "user does X with Y state, gets Z, should get W".
- **Check `CODE_REVIEW.md` first** for documented deliberate patterns (escaped-then-highlighted HTML, listener cleanup in `disconnectedCallback`, OAuth public-client secrets, broad `$HOME` fs scope) and `SAFETY:` comments.
- **Read the whole path before judging.** Follow the call chain from gesture to backend and back to UI render before reporting a missing guard or toast.

## Workflow

1. **Three independent reviewers, three different models.** Run three reviewers in parallel (Opus, Sonnet, Haiku), each auditing the **entire** target scope holistically with no split lenses.
2. **Dedupe & verify.** Refute false positives against the code and `CODE_REVIEW.md`. Keep only confirmed, reproducible defects.
3. **Fix & test.** Fix all confirmed issues with surgical changes and unit + E2E tests covering happy paths, error paths, and UI outcomes.
4. **Gate.** Run:
   ```bash
   npm run lint && npm run typecheck && npm test && cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
   ```
