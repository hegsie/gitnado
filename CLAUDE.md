# Claude Code Instructions

## Default Review Process

When I ask for a "review" (of the code, a change, a PR, the diff, a workflow, etc.), use this **recursive, multi-model, holistic** process by default — not a single-pass review:

1. **Three independent reviewers, three different models.** Run three reviewers in parallel, each on a different model (e.g. Opus, Sonnet, Haiku).
2. **No lenses.** Each reviewer reviews the ENTIRE changed surface holistically — correctness AND user experience AND completeness — NOT an assigned angle (do not split into "you do security / you do UX"). Each reads the full diff (`git diff <base>...HEAD`) and the full current files for context.
3. **Bar.** Surface real problems a user or maintainer would actually hit: correctness bugs, incomplete/dead-end flows, FE/BE contract mismatches (snake_case↔camelCase), missing empty/loading/error states, cross-provider inconsistency, and any UX that is not **user-simplicity driven and complete**. Ground every finding in `file:line` with a concrete, minimal fix. No invented nitpicks — verify each claim against the code first. Each reviewer ends its report with exactly one line: `VERDICT: N issues found` or `VERDICT: NO ISSUES FOUND`.
4. **Fix, then repeat.** Dedupe findings across the three reviewers, fix the real ones (with tests, and the full gate from "Before Committing" green), then re-run all three reviewers on the updated code.
5. **Convergence.** Repeat rounds until ALL THREE reviewers return `NO ISSUES FOUND` in the same round. Only then is the review complete.

Keep review artifacts out of the repo — reviewers return findings in their messages; do not commit review markdown files.

## Before Committing

Run all checks in sequence:
```bash
npm run lint && npm run typecheck && npm test && cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

CI treats all clippy warnings as errors.

Verify no snake_case in Tauri API calls (should return no matches):
```bash
grep -rn "_[a-z]*:" src/types/api.types.ts src/services/git.service.ts src/app-shell.ts src/components/ --include="*.ts" | grep -v "node_modules" | grep -v "__tests__"
```
If this returns matches in object literals being passed to `invokeCommand` or `gitService.*`, convert them to camelCase.

## Tauri Naming Conventions

Tauri automatically converts between Rust's snake_case and TypeScript's camelCase.
- Example: Rust `target_ref: String` → TypeScript `targetRef: string`

## UI Event Consistency Rules

When adding or modifying component operations (handlers, service calls, dialog actions), you MUST ensure:

### Event Dispatch Consistency
- **All sibling handlers must follow the same pattern.** If `handleAdd()` dispatches a `foo-changed` event, then `handleRemove()`, `handleUpdate()`, and any other handlers in the same component that modify the same state MUST also dispatch `foo-changed`. Never leave a handler without an event dispatch when its siblings have one.
- **Every dispatched event must have at least one listener.** Before dispatching a new CustomEvent, verify that a parent component (typically `app-shell.ts` or `lv-left-panel.ts`) has a corresponding `@event-name` handler. Orphaned events are dead code.
- **State-modifying operations in `app-shell.ts` must call `handleRefresh()`**, not just `graphCanvas?.refresh?.()`. The `handleRefresh()` method updates the repository store, refreshes the graph, refreshes the search index, and dispatches `repository-refresh` for other listeners.

### User Feedback Consistency
- **Every user-initiated operation must provide feedback** — either a toast notification (`showToast()`) or an inline message (`this.success`/`this.error`), depending on whether the dialog stays open.
- **Error paths must never be silent.** If `result.success` is checked, the `else` branch must show an error to the user. Console-only errors (`console.error`) are not sufficient — always pair with `showToast()` or `this.error`.
- **Window-level events (e.g., `ai-settings-changed`) must be dispatched by ALL handlers that change the relevant state.** Check the file for other handlers that dispatch the same event and ensure yours does too.

### Checklist Before Completing a UI Change
1. Does every success path dispatch the appropriate event?
2. Does every error path show user-visible feedback?
3. Are all sibling handlers in the same component consistent?
4. Is the dispatched event listened to by a parent?
5. Does `app-shell.ts` call `handleRefresh()` (not just graph refresh) after state-modifying operations?

## Testing Requirements

**CRITICAL: Tests must be written for every code change — not after, but as part of the change.** Do not consider any change done until tests exist for:
- Every code path (happy path, error paths, edge cases)
- Every user-visible outcome (UI updates, error messages, state changes)
- Every cross-component interaction affected by the change

### Unit Tests
- TypeScript/Lit components: `src/**/__tests__/*.test.ts` — use `@open-wc/testing` with `fixture()`, mock only Tauri invoke
- Rust functions: `#[cfg(test)] mod tests` block — use `TestRepo` with real git2 operations, not mocks

### Integration Tests (E2E)
Playwright E2E tests in `e2e/tests/*.spec.ts` run against the Vite dev server. They must cover complete user-visible behavior across the full stack.

**Requirements:**
- Cover all scenarios: happy path, error/failure, edge cases, cross-component effects
- Verify the UI actually reflects the result — not just that a command was called
- Test with real data flows (e.g., remote branch checkout should update the branch list)

### Running Tests
```bash
npm test                    # Unit tests
npm run test:e2e            # E2E tests (playwright.config.ts starts vite dev server)
npx playwright test --config=e2e/playwright.config.ts e2e/tests/branches.spec.ts      # Single file
npx playwright test --config=e2e/playwright.config.ts e2e/tests/branches.spec.ts:42   # Specific test
```

### E2E Test Architecture

E2E tests run against the Vite dev server (`localhost:1420`). All Tauri IPC calls are mocked via `__TAURI_INTERNALS__.invoke` overrides.

**Key files:**
- `e2e/fixtures/tauri-mock.ts` — Tauri IPC mock layer, default mock data, `setupOpenRepository()`, `initializeRepositoryStore()`
- `e2e/fixtures/test-helpers.ts` — `startCommandCaptureWithMocks()`, `findCommand()`, `injectCommandMock()`, `injectCommandError()`, `autoConfirmDialogs()`
- `e2e/pages/*.page.ts` — Page object models

**Store access:** Zustand stores exposed on `window.__GITNADO_STORES__` in dev mode. Repository store uses `openRepositories[]` + `activeIndex` (NOT `currentRepository`).

### E2E Test Conventions

- **No `waitForTimeout()`** — use Playwright auto-retrying assertions (`.toBeVisible()`, `.toHaveText()`, etc.) or `page.waitForFunction()`
- **Playwright auto-pierces shadow DOM** — never use `el.shadowRoot.querySelector()`
- **Use standardized helpers** from `test-helpers.ts`, not inline mock setup
- **Verify UI outcomes**, not just that commands were called
- **Include error scenarios** using `injectCommandError()`
- **Open dialogs via events or command palette** — don't set `@state()` properties directly

```typescript
// GOOD — use helpers
await startCommandCaptureWithMocks(page, {
  get_branches: [{ name: 'main', isCurrent: true }],
  checkout: null,
});

// GOOD — verify UI outcome after action
await btn.click();
await expect(page.locator('.branch-item')).toHaveCount(0);

// GOOD — test error scenarios
await injectCommandError(page, 'checkout', 'Conflict detected');
await expect(page.locator('.toast.error, .error-banner')).toBeVisible();
```

E2E tests run in CI on every push/PR to main and as a gate before release builds.
