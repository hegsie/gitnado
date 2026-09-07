# Gitnado Code Review

Comprehensive code review covering broken/incomplete features, UX issues, event wiring problems, architectural inconsistencies, and test coverage gaps.

**Static Analysis Baseline:**
- ESLint: ✅ Clean (0 errors, 0 warnings)
- TypeScript: ✅ Clean (0 errors)
- Unit Tests: ✅ 3,011 tests passing

---

## Verification Status (v0.3.1)

The findings below were manually verified against source code. Some original findings were **false positives** — these are documented here for transparency.

### ❌ Confirmed False Positives

| # | Original Finding | Why It's Wrong |
|---|------------------|----------------|
| 0.1 | XSS in command palette `highlightMatch()` | `highlightMatch()` calls `escapeHtml()` on ALL text segments before inserting `<mark>` tags. See `src/utils/fuzzy-search.ts:67-96`. SAFETY comment added. |
| 0.2 | Memory leak — graph canvas event listeners never removed | `cleanup()` (called from `disconnectedCallback`) removes ALL 7 canvas listeners at lines 626-631 plus observers at 645-646. SAFETY comment added. |
| — | N+1 IPC in GitHub dialog | `lv-github-dialog.ts` already batches with `Promise.all()` at lines 990, 1199, 1266. SAFETY comment added. |
| — | Event listener leak in app-shell `disconnectedCallback` | All listeners registered in `connectedCallback` have matching `removeEventListener` calls in `disconnectedCallback` (lines 843-859). SAFETY comment added. |
| 6.2 | OAuth client secrets in source code | Standard practice for desktop "public clients" per RFC 6749 §2.1. Cannot keep secrets in distributed binaries. Code already has thorough documentation with PKCE references. GitHub Desktop does the same. |
| — | Filesystem scope `$HOME/**` too broad | Required for a Git client — repos can be located anywhere under the home directory, and the inline file editor needs direct fs access. Documented in capabilities/default.json. |

### ✅ Fixed in v0.3.1

| # | Finding | Fix |
|---|---------|-----|
| **CRITICAL** | Path traversal in `checkout_file.rs` — user-provided `filePath` joined to repo path without validation | Added `validate_path_within_repo()` with canonicalize+starts_with. Applied to both `checkout_file_from_commit()` and `checkout_file_from_branch()`. |
| **HIGH** | OAuth race condition — single `pendingAuth` variable overwritten by concurrent flows | Replaced with `pendingAuthByProvider` Map keyed by provider. Each flow has independent state. |
| **HIGH** | Unhandled promise — `pollLoopbackCallback()` called without `.catch()` | Added `.catch()` handler with cleanup and error state notification. |
| **HIGH** | Browser `confirm()` in `git.service.ts` for network permission | Replaced with async `showConfirm()` from dialog service (Tauri native dialog). Updated all 4 callers to `await`. |
| **HIGH** | Missing upper bounds check in repository store setters | Added `isActiveIndexValid()` helper that checks both `< 0` and `>= length`. Applied to all 7 setter methods. |

### ✅ Fixed in v0.3.1 (second review pass)

| # | Finding | Fix |
|---|---------|-----|
| **CRITICAL** | Path traversal in `staging.rs`, `merge.rs`, `diff.rs` — 10 additional unvalidated `Path::join` sites | Extracted `validate_path_within_repo()` to shared `path_utils.rs` module. Applied to all path joins in `staging.rs` (4 sites), `merge.rs` (3 sites), `diff.rs` (3 sites). |
| **HIGH** | Network permission bypass — `pushToMultipleRemotes()` and `fetchAllRemotes()` skip `checkNetworkPermission()` | Added `checkNetworkPermission()` calls to both functions, matching single-remote variants. |
| **HIGH** | CSP disabled — `"csp": null` in `tauri.conf.json` | Added strict CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http://127.0.0.1; connect-src 'self' https: http://127.0.0.1; font-src 'self' data:` |
| **MEDIUM** | Unhandled promise — `deleteBranch().then()` with no `.catch()` in `app-shell.ts` | Added `.catch()` handler with error toast. |
| **MEDIUM** | CI workflow missing `permissions:` block | Added `permissions: contents: read` to `ci.yml`. |
| **MEDIUM** | No security scanning in CI | Added `security-audit` job with `npm audit` and `cargo audit`. |
| **MEDIUM** | Vulnerable `brace-expansion@5.0.3` | Updated via `npm audit fix` to patched version. |

---

## 0. CRITICAL - Security & Memory Issues

### 0.1 XSS Vulnerability in Command Palette via `highlightMatch()`

**Severity: CRITICAL**

The `highlightMatch()` function in `src/utils/fuzzy-search.ts:55-86` generates HTML strings with `<mark>` tags but **does not escape user-controlled input**. This HTML is rendered via Lit's `unsafeHTML` or `.innerHTML` in the command palette (`src/components/dialogs/lv-command-palette.ts`).

Malicious content in branch names, file names, or commit messages could inject arbitrary HTML/JavaScript:

```typescript
// fuzzy-search.ts:64-68 - No escaping before HTML insertion
return (
  text.slice(0, index) +
  '<mark>' + text.slice(index, index + query.length) + '</mark>' +
  text.slice(index + query.length)
);
```

A branch named `<img src=x onerror=alert(1)>` would execute JavaScript when searched.

**Fix:** Escape HTML entities (`<`, `>`, `&`, `"`, `'`) in the input text segments (not the `<mark>` tags) before concatenation.

### 0.2 Memory Leak - Graph Canvas Event Listeners Never Removed

**Severity: CRITICAL**

Seven event listeners are added to canvas/scroll DOM elements in `setupEventListeners()` (`src/components/graph/lv-graph-canvas.ts:603-621`) using `.bind(this)` which creates new function references. These are **never removed** — the `cleanup()` method (lines 624-639) only removes resize-related listeners.

```typescript
// Lines 609-621: ADDED but never removed
this.canvasEl.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
this.scrollEl.addEventListener('scroll', this.handleNativeScroll.bind(this));
this.canvasEl.addEventListener('mousemove', this.handleMouseMove.bind(this));
this.canvasEl.addEventListener('click', this.handleClick.bind(this));
this.canvasEl.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
this.canvasEl.addEventListener('contextmenu', this.handleContextMenu.bind(this));
this.canvasEl.addEventListener('keydown', this.handleKeyDown.bind(this));
```

**Impact:** Component remains in memory after unmounting. Repeated mount/unmount cycles cause exponential memory growth and ghost event handlers.

**Fix:** Convert handlers to arrow functions or store bound references, then remove all listeners in `cleanup()`.

### 0.3 Memory Leak - Avatar Cache Grows Unbounded

**Severity: HIGH**

`src/graph/canvas-renderer.ts:287-288` maintains an `avatarCache: Map<string, HTMLImageElement | null>` and `avatarLoadingSet: Set<string>` that accumulate entries forever. The `destroy()` method (line 1853) does not clear these caches.

- In a 1000-contributor repo: 1000+ Image objects (~64KB each = 64MB+ of GPU memory never freed)
- Switching repositories accumulates more images

**Fix:** Clear caches in `destroy()` and implement LRU eviction with a max size limit (e.g., 500 entries).

### 0.4 Unregistered Tauri Command Modules - Frontend Calls Will Fail

**Severity: CRITICAL**

Four command modules exist as complete Rust implementations but are **not declared in `src-tauri/src/commands/mod.rs`**, meaning they don't compile and their commands are unavailable at runtime:

| Module | Frontend calls (all broken) |
|---|---|
| `bookmarks.rs` | `get_bookmarks`, `add_bookmark`, `remove_bookmark`, `update_bookmark`, `get_recent_repos`, `record_repo_opened` |
| `custom_actions.rs` | `get_custom_actions`, `save_custom_action`, `delete_custom_action`, `run_custom_action` |
| `advanced_search.rs` | `filter_commits`, `get_file_log`, `get_branch_diff_commits` |
| `jira.rs` | JIRA integration commands (not yet called from frontend) |

Frontend actively calls these in `src/services/git.service.ts` (lines 5528-5816). All calls fail silently.

**Fix:**
1. Add to `src-tauri/src/commands/mod.rs`: `pub mod advanced_search; pub mod bookmarks; pub mod custom_actions; pub mod jira;`
2. Register all commands in `src-tauri/src/lib.rs` invoke_handler

---

## 1. BUGS - Broken Event Wiring

These are confirmed broken behaviors where dispatched events have no listener, or event names are mismatched.

### 1.1 `clean-complete` vs `files-cleaned` Event Name Mismatch

**Severity: BUG**

The clean dialog dispatches `clean-complete` but the app-shell listens for `files-cleaned`. The post-clean repository refresh never fires.

- `src/components/dialogs/lv-clean-dialog.ts:425` dispatches `clean-complete`
- `src/app-shell.ts:2611` listens for `@files-cleaned`

**Fix:** Change one to match the other.

### 1.2 `show-commit` from Reflog Dialog is Unhandled

**Severity: BUG**

The reflog dialog's "Show in graph" context menu action dispatches `show-commit`, but no parent component listens for it. Clicking "Show in graph" does nothing.

- `src/components/dialogs/lv-reflog-dialog.ts:461` dispatches `show-commit`
- No listener in `src/app-shell.ts`

**Fix:** Add a `@show-commit` handler on the reflog dialog in app-shell that calls `this.graphCanvas?.selectCommit(e.detail.oid)`.

### 1.3 `show-toast` Events from 3 Components Are Unhandled

**Severity: BUG**

Three components dispatch `show-toast` custom events that nobody listens for. Toasts from these components silently fail to display.

- `src/components/panels/lv-diff-view.ts` (lines 1065, 1070, 1076)
- `src/components/panels/lv-merge-editor.ts` (lines 547, 553, 559, 821, 827)
- `src/components/dialogs/lv-conflict-resolution-dialog.ts` (lines 423, 428, 434)

**Fix:** Replace `this.dispatchEvent(new CustomEvent('show-toast', ...))` with direct calls to `showToast()` from `notification.service.ts`, which is the pattern used everywhere else.

### 1.4 `merge-conflict` from Branch List is Unhandled

**Severity: BUG**

When a merge results in conflicts from the branch list sidebar, `merge-conflict` is dispatched but no parent listens for it. The conflict resolution dialog won't open automatically after a merge conflict.

- `src/components/sidebar/lv-branch-list.ts:1440,1504` dispatches `merge-conflict`
- No listener in the parent hierarchy

Note: `open-conflict-dialog` (for rebase conflicts) IS handled. Only the merge case is broken.

**Fix:** Add a `merge-conflict` handler that opens the conflict resolution dialog, or consolidate with `open-conflict-dialog`.

### 1.5 Gitflow Events Are Unhandled - No Refresh After Operations

**Severity: BUG**

All gitflow operations dispatch `gitflow-initialized` or `gitflow-operation` events, but nothing in the component hierarchy listens for them. After starting/finishing a feature, release, or hotfix, the graph and repository state are not refreshed.

- `src/components/sidebar/lv-gitflow-panel.ts` (lines 318, 343, 371, 397, 428, 454, 485)
- No listener in any parent component

**Fix:** Handle these events in the left panel or app-shell to trigger a repository refresh.

### 1.6 `open-repo-file` from Workspace Manager is Unhandled

**Severity: BUG**

The workspace manager dispatches `open-repo-file` when clicking a cross-repository search result, but nobody listens for it. The file cannot be opened.

- `src/components/dialogs/lv-workspace-manager-dialog.ts:1191` dispatches `open-repo-file`
- No listener anywhere

### 1.7 Repository Health Dialog Title Not Displayed

**Severity: BUG**

The `lv-modal` component uses the `modalTitle` property (defined at `src/components/dialogs/lv-modal.ts:114`), but the app-shell passes `title` instead of `modalTitle` for the Repository Health dialog.

- `src/app-shell.ts:2617` uses `title="Repository Health"`
- Should be `modalTitle="Repository Health"`

### 1.8 File History Commit Selection Doesn't Navigate Graph

**Severity: BUG**

When selecting a commit in the file history panel, `selectedCommit` is set directly but the graph is NOT scrolled/highlighted. Compare with the blame view which correctly calls `this.graphCanvas?.selectCommit(oid)`.

- `src/app-shell.ts` `handleFileHistoryCommitSelected` sets `this.selectedCommit` but doesn't call `graphCanvas.selectCommit()`
- `handleBlameCommitClick` correctly navigates the graph

### 1.9 `stash-created` Event from Stash List is Orphaned

**Severity: LOW**

`src/components/sidebar/lv-stash-list.ts:218` dispatches `stash-created` but no parent component listens for it.

### 1.10 `tab-changed` Event from Right Panel is Orphaned

**Severity: LOW**

`src/components/sidebar/lv-right-panel.ts:268` dispatches `tab-changed` on `switchTab()` but no parent listens.

### 1.11 Settings Dialog Has Inconsistent Event Dispatch

**Severity: HIGH**

In `src/components/dialogs/lv-settings-dialog.ts`, 3 AI-related handlers dispatch `ai-settings-changed` on window, but 13 sibling handlers that modify other settings dispatch no events at all:

**Missing events:** `handleThemeChange`, `handleFontSizeChange`, `handleDensityChange`, `handleGraphColorSchemeChange`, `handleBranchNameChange`, `handleToggle` (8 settings), `handleMergeToolChange`, `handleDiffToolChange`, `handleStaleBranchDaysChange`, `handleNetworkOperationTimeoutChange`, `handleAutoFetchIntervalChange`.

Per CLAUDE.md: "All sibling handlers must follow the same pattern."

### 1.12 Tag List Inconsistent Event Dispatch Between Delete and Push

**Severity: MEDIUM**

In `src/components/sidebar/lv-tag-list.ts`:
- `handleDeleteTag()` (line 485): ✅ Calls `loadTags()` + dispatches `tags-changed`
- `handlePushTag()` (line 543): ❌ Does NOT call `loadTags()` + dispatches `tag-pushed` (different event name)

Both modify tag state and should follow the same pattern.

### 1.13 `app-shell.ts` Uses `graphCanvas.refresh()` Instead of `handleRefresh()` in 3 Handlers

**Severity: HIGH**

Per CLAUDE.md: state-modifying operations must call `handleRefresh()`. Three handlers only call `graphCanvas?.refresh?.()`, skipping repository store updates, search index refresh, and `repository-refresh` event:

- Line 1324: `handleResetToCommit()` — after reset
- Line 1378: `handleFixupCommit()` — after fixup
- Line 1415: `handleSquashCommit()` — after squash

---

## 2. BUGS - Snake_case Tauri Parameters

Per the CLAUDE.md instructions, Tauri automatically converts between Rust's `snake_case` and TypeScript's `camelCase`. These methods pass snake_case keys which won't match Rust parameter names.

### 2.1 `searchCommits()` - 3 snake_case parameters

**File:** `src/services/git.service.ts:335-337`

```typescript
date_from: options.dateFrom,   // Should be: dateFrom
date_to: options.dateTo,       // Should be: dateTo
file_path: options.filePath,   // Should be: filePath
```

### 2.2 `resolveConflict()` - 1 snake_case parameter

**File:** `src/services/git.service.ts:989`

```typescript
file_path: filePath,   // Should be: filePath
```

### 2.3 `detectConflictMarkers()` - 1 snake_case parameter

**File:** `src/services/git.service.ts:1007`

```typescript
file_path: filePath,   // Should be: filePath
```

### 2.4 `getConflictDetails()` - 1 snake_case parameter

**File:** `src/services/git.service.ts:1024`

```typescript
file_path: filePath,   // Should be: filePath
```

### 2.5 `CloneProgress` Interface Uses snake_case Properties

**File:** `src/components/dialogs/lv-clone-dialog.ts:16-23`

```typescript
interface CloneProgress {
  received_objects: number;  // Should be: receivedObjects
  total_objects: number;     // Should be: totalObjects
  indexed_objects: number;   // Should be: indexedObjects
  received_bytes: number;    // Should be: receivedBytes
}
```

---

## 3. Architectural Inconsistencies

### 3.1 `workflowStore` Duplicates `unifiedProfileStore`

**Severity: HIGH**

`src/stores/workflow.store.ts` is a near-exact duplicate of the profile management portion of `src/stores/unified-profile.store.ts`. Both manage:
- `profiles` array, `activeProfile`, `currentRepositoryPath`, `isLoading`, error state
- Identical CRUD actions (`addProfile`, `updateProfile`, `removeProfile`)
- Identical helpers (`getProfileById` vs `getUnifiedProfileById`)

The `workflowStore` appears to be a legacy version that was superseded by `unifiedProfileStore` but never removed.

### 3.2 Recent Repositories Tracked in Two Stores

**Severity: HIGH**

- `src/stores/repository.store.ts`: `recentRepositories: RecentRepository[]` with `addRecentRepository(path, name)`
- `src/stores/settings.store.ts`: `recentRepositories: string[]` with `addRecentRepository(path)`

These maintain completely independent lists persisted under different localStorage keys. Only `repositoryStore` is actively used; the `settingsStore` version is vestigial.

### 3.3 `IntegrationAccount` Type Defined Three Times

**Severity: HIGH**

The `IntegrationAccount` interface is independently defined in:
1. `src/types/integration-accounts.types.ts` (lines 39-56)
2. `src/types/unified-profile.types.ts` (lines 43-60)
3. `src/types/unified-profile.types.ts` (lines 66-81 as `ProfileIntegrationAccount`)

These are not re-exports -- they're independent definitions that could diverge.

### 3.4 `uiStore` Modal System Entirely Unused

**Severity: HIGH**

`src/stores/ui.store.ts` defines a centralized modal system with `activeModal: ModalId`, `openModal()`, `closeModal()`. The `ModalId` type only covers 6 modals.

No component calls `openModal()` or `closeModal()`. Instead, the app-shell manages 23+ individual boolean `@state()` properties for each dialog. The store's modal system is dead code.

### 3.5 Factory Functions Duplicated Across Type Files

**Severity: MEDIUM**

`createEmpty*Account()` functions, `getAccountDisplayLabel()`, `generateAccountId()`/`generateId()`, and `INTEGRATION_TYPE_NAMES` exist in both:
- `src/types/integration-accounts.types.ts`
- `src/types/unified-profile.types.ts`

Components import from different files inconsistently.

### 3.6 Duplicate Maintenance Functions in git.service.ts

**Severity: MEDIUM**

| Old Function | New Function | Difference |
|---|---|---|
| `runGarbageCollection()` (line 6350) | `runGc()` (line 6705) | New one has toast notifications |
| `verifyRepository()` (line 6390) | `runFsck()` (line 6723) | New one has toast notifications |

The old versions call different Tauri commands but accomplish the same thing.

### 3.7 Two Incompatible Toast Notification Patterns

**Severity: MEDIUM**

- **Pattern A** (correct): `showToast('message', 'success')` from `notification.service.ts`
- **Pattern B** (broken): `this.dispatchEvent(new CustomEvent('show-toast', ...))` from components

Pattern B is used in 3 components (see Bug 1.3) and no parent ever handles it.

### 3.8 Tauri IPC Wrapper Bypassed by 5 Services

**Severity: MEDIUM**

These services use raw `invoke()` from `@tauri-apps/api/core` instead of the standardized `invokeCommand()` from `tauri-api.ts`, bypassing consistent error handling:
- `watcher.service.ts`
- `progress.service.ts`
- `credential.service.ts`
- `search-index.service.ts`
- `oauth.service.ts`

### 3.9 Window Events vs Component Events for Same Concept

**Severity: MEDIUM**

"Repository changed, please refresh" is dispatched as both:
- `window.dispatchEvent(new CustomEvent('repository-refresh'))` (in app-shell, commit-panel, file-status)
- `this.dispatchEvent(new CustomEvent('repository-changed', { bubbles: true, composed: true }))` (in left-panel, right-panel)

Different event names for the same semantic concept.

### 3.10 Error Masking in git.service.ts

**Severity: MEDIUM**

`getRepositoryStats()` (line 6307-6316) and `getPackInfo()` (line 6329-6338) return `success: true` with zeroed data when the actual backend command fails. Callers cannot distinguish between "the repo has 0 objects" and "the command failed."

### 3.11 Legacy + Multi-Account Credential Dual Systems

**Severity: LOW**

`credential.service.ts` maintains both a legacy system (single-token: `GitHubCredentials.getToken()`) and a multi-account system (`getAccountToken(type, accountId)`). The `git.service.ts` `getRepoToken()` function still uses legacy methods, meaning network operations (fetch/push/pull) always use the legacy single-token credential, not the multi-account system.

---

## 4. UX Usability Issues

### 4.1 Silent Error Failures (~25 instances)

**Severity: HIGH**

Numerous operations log errors to `console.error` but show no user-visible feedback. The user performs an action and nothing visibly happens.

**lv-branch-list.ts:**
- Checkout failure (line 952)
- Rename failure (line 996)
- Delete failure (line 1032)
- Merge failure (line 1073)
- Rebase failure (line 1115)
- Remote checkout failure (line 1481)

**lv-tag-list.ts:**
- Load tags failure (line 371)
- Checkout tag failure (line 478)
- Delete tag failure (line 508)
- Push tag failure (line 557)

**lv-stash-list.ts:**
- Load stashes failure (line 190)
- Create stash failure (line 215)
- Apply stash failure (line 255)
- Pop stash failure (line 277)
- Drop stash failure (line 308)

**lv-commit-panel.ts:**
- Fetch last commit message failure (line 778)

**lv-file-status.ts:**
- Open in editor failure (line 1310)
- Reveal in finder failure (line 1323)
- Copy path failure (line 1334)

**lv-clean-dialog.ts:**
- Load files failure (line 359)
- Clean failure (line 433)

**lv-branch-cleanup-dialog.ts:**
- `pruneRemoteTrackingBranches()` (line 564) — no try-catch, completely silent on failure

**lv-worktree-dialog.ts:**
- `loadBranches()` (line 386) — no error handling, no else branch on `result.success` check

### 4.2 Native `confirm()`/`prompt()` Instead of Themed Dialogs (~20 instances)

**Severity: MEDIUM**

The app has a custom `showConfirm` dialog service but many places use the browser's native `confirm()` and `prompt()`, creating a jarring UX inconsistency.

**Native `confirm()` usage:**
- `src/app-shell.ts:1230` -- Hard reset confirmation
- `src/components/dialogs/lv-credentials-dialog.ts:479,529` -- Remove/erase credentials
- `src/components/dialogs/lv-submodule-dialog.ts:458` -- Remove submodule
- `src/components/dialogs/lv-ssh-dialog.ts:481` -- Delete SSH key
- `src/components/dialogs/lv-reflog-dialog.ts:389` -- Hard reset from reflog
- `src/components/dialogs/lv-worktree-dialog.ts:441` -- Remove worktree
- `src/components/dialogs/lv-profile-manager-dialog.ts:658,687,810,921`
- `src/components/dialogs/lv-hooks-dialog.ts:757,942,965`
- `src/components/dialogs/lv-config-dialog.ts:491` -- Delete alias
- `src/components/panels/lv-merge-editor.ts:892`

**Native `prompt()` usage:**
- `src/components/sidebar/lv-branch-list.ts:979` -- Rename branch
- `src/components/sidebar/lv-branch-list.ts:1190` -- Set upstream
- `src/components/sidebar/lv-commit-panel.ts:675` -- Save template name
- `src/components/sidebar/lv-gitflow-panel.ts:334,388,414,445,471` -- Feature/release/hotfix names
- `src/components/toolbar/lv-search-bar.ts:331` -- Save search preset

### 4.3 Missing Loading States for Async Operations (~15 instances)

**Severity: MEDIUM**

These operations have no visual loading indicator. The user clicks and waits with no feedback.

**lv-branch-list.ts:**
- `handleCheckout()` (line 925) -- no loading state
- `handleRenameBranch()` (line 968) -- no loading state
- `handleDeleteBranch()` (line 1000) -- no loading state
- `handleMergeBranch()` (line 1036) -- no loading state
- `handleRebaseBranch()` (line 1078) -- no loading state
- `handleDeleteMergedBranches()` (line 860) -- iterates with no progress

**lv-tag-list.ts:**
- `handleCheckoutTag()` (line 455) -- no loading state
- `handleDeleteTag()` (line 482) -- no loading state
- `handlePushTag()` (line 539) -- no loading state

**lv-file-status.ts:**
- `handleStageFile()`, `handleUnstageFile()`, `handleDiscardFile()` -- no per-operation loading state

### 4.4 Missing Confirmations for Destructive Operations

**Severity: HIGH**

- **Clean dialog's "Delete Selected"** (`lv-clean-dialog.ts:415`): Permanently deletes files without a final "Are you sure?" confirmation
- **Revert commit** (`app-shell.ts:1128`): No confirmation before reverting
- **Soft/mixed reset** (`app-shell.ts:1222-1234`): Only hard reset has confirmation; soft/mixed resets move HEAD without warning
- **Tag checkout** (`lv-tag-list.ts:455`): No warning about entering detached HEAD state
- **Stash apply/pop** (`lv-stash-list.ts`): No confirmation before potentially overwriting working directory changes

### 4.5 Missing Disabled States / Double-Click Prevention

**Severity: MEDIUM**

Context menu actions in `lv-branch-list`, `lv-tag-list`, and `lv-stash-list` are always enabled. There's no guard to prevent double-clicking operations (e.g., merging a branch while another merge is in progress).

### 4.6 Inconsistent Notification Pattern in git.service.ts

**Severity: MEDIUM**

Network operations (fetch, pull, push) show toasts on success/failure. Equally important operations do not:

| Operation | Shows Toast? |
|---|---|
| fetch/pull/push | Yes |
| merge | No |
| rebase | No |
| cherry-pick | No |
| revert | No |
| reset | No |
| stash create/apply/pop | No |
| tag create/delete/push | No |
| squash commits | No |
| drop commit | No |

### 4.7 Keyboard Accessibility Gaps

**Severity: MEDIUM**

- Only 14 `aria-label` attributes across the entire component directory
- Only 3 `role` attributes across the entire codebase
- `lv-stash-list`, `lv-tag-list`: Clickable items with no keyboard handlers (no tabindex, no keydown)
- Context menus: Mouse-only interaction (no keyboard trapping, arrow key navigation, or Escape handling)
- Tab close button in toolbar: `<span class="tab-close">` with `@click` but no keyboard handler, no button role

---

## 5. Incomplete Features

### 5.1 `uiStore.globalLoading` Never Used

**Severity: LOW**

`src/stores/ui.store.ts` defines `globalLoading` and `setGlobalLoading()`, but no component or service ever calls `setGlobalLoading()`. This was presumably intended as a centralized loading state but was never wired up.

### 5.2 Potentially Unused Functions in git.service.ts

**Severity: LOW**

These functions are defined but appear only in the service definition and/or test files, never called from production components:

| Function | Line |
|---|---|
| `getCommitSignature()` (singular) | 2029 |
| `runGarbageCollection()` | 6350 |
| `verifyRepository()` | 6390 |
| `getRepoSizeInfo()` | 6408 |
| `getRepoStats()` | 4966 |
| `getContributorStats()` | 4976 |

### 5.3 Cache Usage Inconsistency

**Severity: LOW**

`getCommitsSignatures()` (batch, line 2039) uses caching, but `getCommitSignature()` (singular, line 2029) does not. A call to the singular version bypasses the cache entirely.

### 5.4 Progress Service Race Condition

**Severity: LOW**

`src/services/progress.service.ts`: `setupListeners()` is called without `await` in the constructor. Event listeners may not be ready for operations that start very quickly after initialization.

---

## 6. Security Considerations

### 6.1 Custom Actions Execute Arbitrary Shell Commands

**Severity: CRITICAL (by design, but worth documenting)**

`src-tauri/src/commands/custom_actions.rs` (lines 164-178): User-defined commands from the database are executed directly via `Command::new("cmd").args(["/C", &full_command])` with no sanitization or allowlist. This is an intentional feature but should be clearly documented as running with full app privileges.

### 6.2 OAuth Client Secrets in Source Code

**Severity: HIGH (acknowledged)**

`src/services/oauth.service.ts` contains embedded client secrets. This is documented as a known limitation with a recommendation to use PKCE-only flows.

### 6.3 Unencrypted In-Memory Credential Cache

**Severity: MEDIUM**

`src-tauri/src/services/credentials_service.rs`: Credentials are cached in plain text in a `Mutex<HashMap>` with no cleanup mechanism and no encryption.

### 6.4 Unbounded OAuth Pending Server Storage

**Severity: MEDIUM**

`src-tauri/src/services/oauth.rs`: The `PENDING_SERVERS` HashMap grows unboundedly if OAuth callbacks don't execute. No TTL or cleanup timer.

### 6.5 Potential Panics on Git Reference Names (Rust)

**Severity: HIGH**

Multiple calls to `reference.name().unwrap()` and `branch.get().name().unwrap()` in `src-tauri/src/commands/branch.rs` (lines 128, 281, 299, 308, 712) can panic if the reference name contains invalid UTF-8. In git2-rs, `Reference::name()` returns `Option<&str>`.

```rust
repo.set_head(reference.name().unwrap())?;  // Panics on non-UTF-8
repo.set_head(branch.get().name().unwrap())?;  // Panics on non-UTF-8
```

**Fix:** Use `.ok_or_else(|| GitnadoError::OperationFailed("Invalid reference name encoding".to_string()))?`

### 6.6 Potential Panic on `strip_prefix` in Branch Upstream Handling (Rust)

**Severity: MEDIUM**

`src-tauri/src/commands/branch.rs:342` uses `.strip_prefix("refs/remotes/").unwrap()` which panics if upstream is exactly `"refs/remotes/"` with no trailing content.

**Fix:** Use `.unwrap_or(&upstream)` or proper error handling.

### 6.7 Mutex Poisoning Not Handled in Watcher Service (Rust)

**Severity: MEDIUM**

Multiple `.lock().unwrap()` calls on mutexes in `src-tauri/src/commands/watcher.rs` (lines 47, 48, 67, 75, 117-118) will panic if any thread panics while holding the lock. The spawned background thread (line 63) uses these locks in a loop, and any panic in event handling poisons the mutex permanently.

**Fix:** Use `.lock().map_err(|_| GitnadoError::OperationFailed("Lock poisoned".to_string()))?` pattern.

---

## 7. Test Coverage Gaps

### 7.1 Component Unit Test Coverage: 21%

Only 13 of 62 components have dedicated unit tests. Major untested components:

**Dialogs (20 untested):** lv-bisect-dialog, lv-cherry-pick-dialog, lv-clean-dialog, lv-clone-dialog, lv-config-dialog, lv-conflict-resolution-dialog, lv-create-branch-dialog, lv-create-tag-dialog, lv-credentials-dialog, lv-gpg-dialog, lv-init-dialog, lv-keyboard-shortcuts-dialog, lv-lfs-dialog, lv-reflog-dialog, lv-repository-health-dialog, lv-settings-dialog, lv-ssh-dialog, lv-submodule-dialog, lv-worktree-dialog, lv-command-palette

**Layout & Views (13 untested):** lv-left-panel, lv-right-panel, lv-commit-panel, lv-output-panel, lv-toolbar, lv-blame-view, lv-file-history, lv-merge-editor, lv-commit-details, lv-welcome, lv-stash-list, lv-modal, lv-avatar

### 7.2 Store Test Coverage: 57%

Untested stores: `settings.store.ts`, `ui.store.ts`, `workflow.store.ts`

### 7.3 Utility Test Coverage: 20%

Only `diff-utils.ts` and `fuzzy-search.ts` have tests. Untested: `format.ts`, `logger.ts`, `md5.ts`, `platform.ts`, `syntax-highlighter.ts`, `shiki-highlighter.ts`, `external-link.ts`

### 7.4 Service Test Gaps

Critical services without dedicated unit tests: `cache.service.ts`, `dialog.service.ts`, `drag-drop.service.ts`, `notification.service.ts`, `progress.service.ts`, `watcher.service.ts`, `workspace.service.ts`

### 7.5 Rust Backend Test Gaps

Only 7 integration tests exist in `src-tauri/tests/`. Missing tests for:
- Security-focused scenarios (command injection in custom actions)
- Concurrency / race condition scenarios
- OAuth flow cleanup and TTL behavior
- Error recovery edge cases

---

## 8. Summary: Prioritized Action Items

### Critical (Security / Data Loss / Functionality Broken)
1. **NEW** Fix XSS vulnerability in `highlightMatch()` — escape HTML entities in user input
2. **NEW** Fix memory leak in graph canvas — 7 event listeners never removed
3. **NEW** Register 4 missing Tauri command modules (`bookmarks`, `custom_actions`, `advanced_search`, `jira`)
4. Fix `clean-complete` / `files-cleaned` event name mismatch
5. Fix 5 snake_case Tauri parameter bugs in `git.service.ts` and `lv-clone-dialog.ts`
6. Wire up `merge-conflict` event from branch list to open conflict dialog
7. Wire up `gitflow-initialized`/`gitflow-operation` events to trigger refresh
8. Fix `show-toast` events (replace with direct `showToast()` calls)
9. Wire up `show-commit` from reflog dialog to navigate graph
10. Fix Repository Health dialog `title` -> `modalTitle`

### High Priority (Panics / Data Integrity / UX)
11. **NEW** Fix 5 potential panics from `.unwrap()` on `reference.name()` in `branch.rs`
12. **NEW** Fix avatar cache memory leak — add cleanup in `destroy()` and LRU eviction
13. **NEW** Fix `app-shell.ts` to use `handleRefresh()` instead of `graphCanvas.refresh()` in 3 handlers
14. **NEW** Fix inconsistent event dispatch in settings dialog (13 handlers missing events)
15. Add user-visible error feedback to ~27 silent-failure operations
16. Add confirmation dialogs for destructive operations (clean, revert, soft/mixed reset)
17. Remove or consolidate `workflowStore` with `unifiedProfileStore`
18. Remove duplicate `recentRepositories` from `settingsStore`
19. Consolidate triplicate `IntegrationAccount` type definitions

### Medium Priority (Quality / Consistency / Robustness)
20. **NEW** Handle mutex poisoning in watcher service (`.lock().unwrap()` → proper error handling)
21. **NEW** Fix `strip_prefix().unwrap()` potential panic in branch upstream handling
22. **NEW** Fix tag list inconsistent event dispatch (delete vs push)
23. Replace ~20 native `confirm()`/`prompt()` calls with themed dialogs
24. Add loading states to async operations in branch/tag/stash lists
25. Add disabled states to prevent double-clicking operations
26. Consolidate duplicate maintenance functions in git.service.ts
27. Standardize Tauri IPC usage (use `invokeCommand` everywhere)
28. Consolidate window events vs component events for refresh
29. Remove unused `uiStore` modal system
30. Add missing notification toasts for merge/rebase/cherry-pick/stash operations

### Low Priority (Polish / Maintenance)
31. **NEW** Remove orphaned `stash-created` and `tab-changed` events
32. Improve keyboard accessibility (aria-labels, tab navigation, context menu keyboard support)
33. Add cache consistency for `getCommitSignature()` singular
34. Fix error masking in `getRepositoryStats()` and `getPackInfo()`
35. Increase component unit test coverage (currently ~47-53%)
36. Increase utility test coverage (currently 20%)
37. Remove unused functions from git.service.ts
38. Move inline types from git.service.ts to proper type files
39. Add Rust tests for `search_index.rs` and `embedding_index.rs`
