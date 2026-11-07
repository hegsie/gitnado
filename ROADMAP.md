# Gitnado Roadmap

This document outlines the strategic vision and planned features for Gitnado. For current features, see [README.md](README.md).

## Vision

Gitnado is transitioning from a "Git GUI with AI" to a **Local-First AI Development Hub**, and next to the place where developers supervise, review and ship work done by both humans and AI coding agents. The goal is to move beyond simple commit message generation and leverage Gitnado's unique position inside the user's filesystem and Git history.

Unlike commercial alternatives, Gitnado:

- **Runs entirely offline** with no telemetry, account requirements, or cloud dependencies
- **Respects your privacy** by keeping all data local
- **Performs exceptionally** even with large repositories
- **Remains open source** and transparent
- **Costs $0 in API credits** — all AI features are powered by your own hardware

Our north star: *A privacy-first, AI-native Git workstation where intelligence runs on your GPU, not someone else's cloud.*

---

## Strategic Phases

### 1. Short-term: Stabilize and Delight ✅

**Goal:** Make core Git workflows rock-solid and pleasant enough for a full workday without dropping to the terminal (except for very advanced commands).

**Test:** "Can I do a full workday in this client (branching, committing, rebasing, resolving conflicts, reviewing diffs) without dropping to the terminal?"

#### Core Commit Workflow

- ✅ **Staging refinements**
  - Line-level staging (stage/unstage individual lines within hunks)
  - Better visual feedback for partially staged files
  - Preserve partial staging during file edits

- ✅ **Commit operations**
  - Commit message templates with variables
  - Auto-populate from .gitmessage
  - Conventional commits support
  - Signed-off-by and Co-authored-by commit trailers (`src/components/sidebar/gn-commit-panel.ts`)
  - Quick amend/reword/fixup/squash from history

- ✅ **Auto-stashing**
  - Auto-stash on checkout with conflicts
  - Smart stash application after branch switch
  - Stash conflict resolution

#### Repository Browsing & Navigation

- ✅ **Branch management**
  - Clearer branch list with grouping (local/remote/stale)
  - Quick branch switching with fuzzy search
  - Branch health indicators (ahead/behind, last commit date)
  - Delete merged branches in bulk

- ✅ **Log view improvements**
  - Search and filtering by author, message, date range, file path
  - Save filter presets
  - Performance for repositories with 100k+ commits
  - Blame integration from log view

- ✅ **Tags & remotes**
  - Better tag visualization in graph
  - Remote management improvements
  - Quick remote branch tracking setup

#### UX Polish

- ✅ **Keyboard shortcuts**
  - Comprehensive keyboard navigation
  - Customizable keyboard shortcut editor
  - Vim-style navigation
  - Quick switcher (files, branches, commits)

- ✅ **Visual themes**
  - Dark/light themes
  - Syntax highlighting themes
  - Custom color schemes for graph and UI (default, pastel, vibrant, monochrome, high-contrast)
  - Compact/comfortable/spacious density settings

- ✅ **Responsiveness & feedback**
  - Live transfer progress (`TransferMonitor` emitting `operation-progress` events with byte/object counts and transfer speed) across clone, fetch, pull, and push (`src-tauri/src/commands/remote.rs`, `src-tauri/src/services/transfer_monitor.rs`)
  - Full cancellation support via `CancellationRegistry` for clone, fetch, pull, and push operations
  - Better error messages with suggested fixes
  - Toast notifications for background operations

#### Performance & Reliability

- ✅ **Large repository handling**
  - Virtual scrolling for graph and diffs
  - Lazy loading for commit history
  - Background indexing for faster searches
  - Memory optimization for huge diffs

- ✅ **Robustness**
  - Operation timeout handling
  - Conflict detection and recovery
  - Repository health checks
  - Automatic fsck and gc recommendations

---

### 2. Medium-term: Power Features (Still Offline)

**Goal:** Add advanced features that power users need while maintaining the privacy-first promise. No accounts, telemetry, or cloud services required.

#### Advanced Branch & History Management

- ✅ **Visual interactive rebase**
  - Drag-and-drop reordering of commits
  - Edit/squash/fixup/drop actions in UI
  - Conflict resolution during rebase
  - Preview of rebase result before executing

- ✅ **Branch graph enhancements**
  - Filter graph by author, message, date, path
  - Hide/show branches dynamically
  - Export graph as image/SVG
  - Graph performance for complex histories

- ✅ **Branch cleanup automation**
  - One-click "delete merged branches" with accurate graph-based merge detection
  - Stale branch detection with configurable rules
  - Safe delete with upstream tracking verification
  - Remote tracking branch pruning

#### Conflict Resolution

- ✅ **Built-in 3-way merge editor**
  - Side-by-side conflict view with base/theirs/ours
  - Inline explanations of conflict origin
  - Smart conflict resolution suggestions (AI-powered per-chunk and batch resolution)
  - Chunk-by-chunk resolution workflow

- ✅ **External merge tool integration**
  - Configure Kdiff3, Beyond Compare, Meld, P4Merge
  - Launch external tool from conflict view
  - Auto-detect common merge tools (availability checking)
  - Custom tool configuration

#### Multi-Repository Workflows

- ✅ **Workspace concept**
  - Group related repositories (monorepos or microservices)
  - Quick switching between workspace repos
  - Batch operations (fetch all, pull all, status overview)
  - Workspace persistence and management dialog

- ✅ **Workspace enhancements**
  - Workspace-level search (find across all repos)
  - Import/export workspace configurations
  - Clone and setup entire project structures (planned)

#### Local Hooks & Automation

- ✅ **Custom actions**
  - Define per-repo custom commands
  - Execute scripts from the UI

- ✅ **Git hooks UI**
  - Visual hook configuration (pre-commit, commit-msg, pre-push)
  - Hook templates (lint, format, test)
  - Enable/disable hooks per repository
  - Hook execution logs and debugging (`gn-hooks-dialog.ts` Execution Log tab & `gn-output-panel.ts` with search filter and terminal launcher)

---

### 3. Long-term: Polish & Hardening

**Goal:** Make Gitnado robust, accessible, and trusted for professional use.

#### Accessibility

- ✅ Screen reader support — `aria-live` toast announcements, `role="dialog"` with `aria-modal`, command palette `role="combobox"` with `role="listbox"`/`role="option"`, graph canvas `aria-label` with commit count
- ✅ Keyboard-only navigation
- ✅ High-contrast theme
- ✅ Configurable font sizes and density
- ✅ Focus indicators — global `:focus-visible` styles in shared stylesheet, keyboard-only outlines via `:focus:not(:focus-visible)` suppression
- ✅ Skip link — "Skip to main content" link appears on Tab, jumps past toolbar
- ✅ Focus trap in modals — Tab cycles within dialog, focus restored on close
- ✅ Accessibility audit — addressed WCAG 2.4.7 (Focus Visible), 4.1.3 (Status Messages), 2.4.3 (Focus Order), `prefers-reduced-motion`, high-contrast/`forced-colors` support (including commit graph contrast), and `gn-toggle` accessible switch semantics (`role="switch"`, `aria-checked`, `aria-label`/`aria-labelledby`), verified by `src/styles/__tests__/a11y-styles.test.ts` and `src/components/dialogs/__tests__/gn-settings-dialog-contrast.test.ts`

#### Security Hardening

- ✅ **Paranoid mode** — enforced across both the frontend git service layer and the Rust backend (`src-tauri/src/services/security.rs` `guard_url` across git remote operations, AI provider API clients, avatar fetches, and model/embedding downloads), with offline mode blocking network operations, confirmation prompts before network calls, and remote domain allowlisting.
- ✅ **Supply chain transparency** — build info command exposes app version, Rust version, build target, and profile. Settings stored in Zustand with localStorage persistence.

---

### 4. Next: The Agent-Era Git Workstation (2027) 🚧

**Goal:** Close the gaps opened by the latest wave of Git clients and make Gitnado the best place to *supervise* code written by both humans and AI agents, without giving up local-first, no-account, no-telemetry defaults.

**Test:** "Can I run three coding agents in parallel, review and reshape what they produced, and ship it as a clean stack of PRs, without leaving Gitnado or sending code anywhere I didn't choose?"

#### Where the market moved (2025–2026)

| Client | What they shipped recently | Gitnado today |
|--------|----------------------------|---------------|
| GitKraken Desktop 12.x | Agent Mode and an Agent Sessions panel tracking Claude Code / Copilot CLI / Codex across worktrees; AI Commit Composer ("compose / recompose commits with AI"); Launchpad PR and issue dashboard; MCP server | Worktrees, read-only MCP host, AI split suggestions for staged changes. No agent supervision, no history recompose, no cross-provider inbox |
| Tower | Stacked branches with one-click restack and stack merge; better "fully merged" detection for squash and rebase merges; archived and pinned branches | Merged and stale detection. No stacks |
| GitButler | Parallel (virtual) branches, stacked branches, an Agents tab with one branch per agent, Claude Code hooks, operations-log undo | Undo/redo history plus semantic undo. No parallel branches, no agent hooks |
| GitHub Desktop / JetBrains | Copilot commit messages; AI conflict resolution in the IDE | Already matched, and runs locally |

Gitnado's advantage stays the same: everything above runs **locally, with no account, and with any model you choose**. The work below is about doing those things better, not copying them.

#### 4.1 Agent Supervision ("Mission Control")

- ✅ **Agent Sessions panel:** detect Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Aider and other terminal agents running against an open repo or any of its worktrees. Show each session's state (working / waiting for input / done / errored), branch, changed files and elapsed time.
- ✅ **One-click "Start agent on a task":** create a worktree and branch (optionally from a Jira, GitHub, GitLab or Azure DevOps issue), then launch the chosen agent CLI in the embedded terminal (see 4.6) with the issue as context.
- ✅ **Live change feed:** a per-session diff stream with "accept hunk", "revert hunk" and "send feedback to agent" actions, so reviewing agent output is as easy as reviewing a staged diff.
- ✅ **Agent checkpoints:** snapshot the working tree (hidden refs under `refs/gitnado/checkpoints/*`) before and after each agent turn. Any turn can be rolled back from the Checkpoints dialog without touching the reflog by hand. Automatic per-turn capture comes from the agent hooks bridge below.
- ✅ **Agent hooks bridge:** an optional hook installer (e.g. Claude Code `PreToolUse` / `Stop` hooks) that tags commits and checkpoints with the session ID so you can see which agent wrote which code.
- ✅ **Guardrails:** run the existing "Vibe Check" secret and risk scan automatically when an agent finishes. Block or warn before agent output is pushed. Paranoid mode applies to agents too. _(Block-or-warn before push is shipped: a local secret scan of the outgoing commits on agent branches, set in Settings → Agent Guardrails.)_

#### 4.2 MCP 2.0: Gitnado as the Agent's Git Brain

- **Write tools behind a consent gate:** `stage`, `commit`, `create_branch`, `create_worktree`, `stash`, `checkout`. Every write is either previewed in the UI and approved, or allowed by a per-repo policy ("agents may commit on `agent/*` branches only").
- **Higher-level read tools:** `semantic_search_history`, `explain_commit`, `predict_rebase_conflicts`, `get_conflicts`, `get_pr_comments`. These expose Gitnado's existing AI and analysis features to any MCP client.
- **Transport and setup:** stdio and Streamable HTTP transports, a per-client token list with revoke, and one-click "Add to Claude Code / Cursor / VS Code" config snippets.
- **MCP client mode:** let Gitnado's own AI features call user-configured MCP servers (issue trackers, docs, internal tools) for richer commit, PR and review context.

#### 4.3 Stacked Branches & Stacked PRs

- **First-class stacks:** declare a branch as stacked on another, see the stack as a single lane in the graph and branch list, and navigate up and down the stack.
- **Restack:** one-click restack of the entire stack after the base moves, using Ghost Rebase to predict conflicts before running it. Also handles a lower branch being squash-merged.
- **Stacked PRs:** create and update one PR/MR per stack level on GitHub, GitLab, Bitbucket and Azure DevOps with correct base branches and an auto-maintained stack table in each description. Merge from the bottom and retarget the rest automatically.
- **Better merged detection:** detect squash-merged and rebase-merged branches (patch-id / tree comparison) for branch cleanup and stack pruning.

#### 4.4 AI History Editing

- **Commit Composer / Recompose:** select a range of commits (or the working tree) and let AI propose a new, logically grouped commit series with messages. Show a before/after preview, apply it through the existing interactive-rebase engine, and keep a one-click undo.
- **Hunk-level split suggestions:** extend AI-Assisted Staging from file groups to hunk and line groups.
- **AI fixup targeting:** for each staged hunk, suggest the commit it most likely belongs to (`git absorb`-style, AI-ranked) and create `fixup!` commits automatically.
- **Explain anything:** "Explain this commit / branch / PR / file history" in plain language, with streaming output, from the graph, blame and PR views.
- **AI stash and branch naming:** generate stash messages and branch names from the diff or the linked issue.

#### 4.5 AI Review & Collaboration

- **Local AI PR review:** run a full review of any PR/MR branch (yours or a teammate's) using a local or BYO model. Show findings inline in the diff view and optionally post them as review comments through the existing provider integrations.
- **Review comment resolution:** turn a PR review comment into a suggested patch (or an agent task) and push the fix.
- **Unified Launchpad:** a single inbox of PRs to review, PRs with failing CI, assigned issues and mentions across GitHub, GitLab, Bitbucket, Azure DevOps and Jira, with snooze and pin. Fetched directly from providers, with no Gitnado cloud involved.
- **CI awareness:** show pipeline status per commit and branch in the graph. "Explain this CI failure" summarizes job logs with AI and offers a fix.
- **Shareable patches without a cloud:** share a working-tree change as a signed patch file, bundle or provider gist/snippet, as an offline-friendly alternative to cloud patch services.

#### 4.6 Core Platform Gaps

- ✅ **Embedded PTY terminal:** a full in-app terminal panel (per repo and per worktree), required for agent sessions. Replaces "open external terminal" as the default.
- **Parallel work without context switches:** a worktree-first UX (create, switch and clean up worktrees from the branch list) and, as an exploration, GitButler-style parallel branches applied to one working tree.
- **Operation timeline:** unify undo/redo, reflog, agent checkpoints and stash into one browsable timeline with diff previews (in the spirit of jj's operation log).
- **SSH commit signing and signature verification badges** across the graph, alongside the existing GPG support.
- **Repository insights (local-only):** commit and PR cycle-time, churn hotspots, ownership and bus-factor maps computed from local history. No telemetry.
- **Dedicated CUDA/Vulkan release builds** in the CI matrix.

#### 4.7 Local AI Refresh

- **Model catalog refresh:** move tier defaults to current small and coding models (e.g. Gemma 3n / newer Qwen Coder and Phi releases) and refresh the hardware and latency table below.
- **Code-aware embeddings:** index diffs and code, not just commit messages, for semantic search. Add hybrid (BM25 + vector) ranking.
- **Speculative decoding and KV-cache reuse** for faster local generation. NPU execution paths where the runtime supports them.
- **Per-feature model routing:** pick a model per task (tiny local model for commit messages, larger local or BYO cloud model for review and composition) with a visible cost/privacy indicator for each request.
- **AI privacy ledger:** a local, inspectable log of every AI request: which provider, what context was sent, and token counts. Cloud providers stay strictly opt-in.

#### Guiding principles for Phase 4

1. **Agents are guests:** every agent write is reviewable, attributable and undoable.
2. **Local by default, BYO everything:** no Gitnado account, no Gitnado cloud, any model, any agent.
3. **AI is optional:** every AI-assisted flow has a fully working non-AI path.

---

## Detailed Feature Backlog

### UI/UX Enhancements

- ✅ **Inline editing** — edit files directly in diff view with syntax-aware editing
- ✅ **Image diff** — side-by-side, onion skin, swipe slider, difference highlighting (PNG, JPG, GIF, WebP)
- ✅ **Notifications & background operations** — push/pull notifications, conflict alerts, system tray, per-repo preferences
- ✅ **Auto-fetch** — configurable intervals, fetch on focus, remote change indicators, rate limiting, pause/resume
- ✅ **Native application menu bar** — full native OS menu bar (File, Edit, View, Repository, Branch, Tools, Window, Help) wired between Rust (`src-tauri/src/menu.rs`) and the frontend (`src/services/app-menu.service.ts`)
- ✅ **Localisation (i18n)** — `@lit/localize` runtime localization with English and French locales (`src/i18n/`)
- ✅ **Jira integration UI** — full Jira dialog (`src/components/dialogs/gn-jira-dialog.ts`, `src-tauri/src/commands/jira.rs`) with connection setup & testing, JQL issue filtering, status transitions, and one-click branch creation from Jira issues
- ✅ **Inline PR/MR review comments** — view and post general and file/line-scoped review comments directly inside the GitHub, GitLab, Azure DevOps, and Bitbucket integration dialogs (`get_*_pr_comments`, `add_*_pr_comment`)
- ✅ **Git Output panel & terminal launcher** — searchable/filterable Git command & hook output panel (`src/components/panels/gn-output-panel.ts`) with one-click external terminal launcher

---

### Advanced Git Features

- ✅ **Patch operations** — create patches (format-patch), apply with context awareness, mailbox patches (am)
- ✅ **Archive & export** — ZIP/TAR/TAR.GZ archives, specific refs, custom prefix paths
- ✅ **Git notes** — add/edit/remove commit notes, custom notes refs, namespace management
- ✅ **Sparse checkout** — initialize, add/remove paths, cone mode, disable
- ✅ **Bundle operations** — create/verify/list/unbundle for offline transfer and air-gapped environments

- ✅ **Shallow, partial & recursive submodule clones**
  - Shallow clone with configurable `--depth` (clone dialog)
  - Partial clone with `--filter` (blob:none, tree:0) via clone dialog dropdown
  - Single-branch clone option
  - Recursive submodule clone (`--recurse-submodules`) option in `gn-clone-dialog.ts` and `clone_repository`
  - Deepen shallow clones incrementally (`git fetch --deepen`)
  - Convert shallow to full clone (`git fetch --unshallow`)
  - Repository metadata: `isShallow`, `isPartialClone`, `cloneFilter` exposed in Repository struct
  - Fetch missing objects handled transparently by git on demand

---

### Maintenance & Performance

- ✅ **Repository maintenance** — garbage collection with progress, prune unreachable objects, repack, health dialog
- ✅ **Repository health & diagnostics** — fsck with detailed output, integrity checks, health score and recommendations
- ✅ **Performance optimization** — virtual scrolling, lazy loading, background indexing, incremental rendering for large diffs

---

### Distribution & Platform Support

- ✅ **Code signing & notarization**
  - macOS: Apple Developer certificate, notarization, hardened runtime, CI/CD automation
  - Windows: MSI/NSIS installers with signing
  - Linux: DEB, AppImage, RPM packages

- ✅ **Auto-updates** — Tauri updater with signing key, background download with install prompt

- ✅ **Package manager delivery** — winget, Homebrew cask (Apple Silicon tap), and Scoop manifest published automatically on each release; community-maintained AUR package. Future candidates: Chocolatey, Flathub, Snapcraft

- ✅ **Rename to Gitnado (0.9.0)** — new name, icon and identifiers

---

### AI & Machine Learning Features

#### Shipped

- ✅ **Local AI backends** — Ollama, LM Studio auto-detection, configurable model selection, provider fallback
- ✅ **Cloud AI providers** — Anthropic Claude, GitHub Copilot, OpenAI, Google Gemini, API key management
- ✅ **AI-assisted workflows**
  - Generate commit messages from staged changes
  - Conflict resolution suggestions with reasoning

#### Phase 1: The "Sovereign Brain" ✅

*Establishing the hardware-accelerated foundation.*

- ✅ **Adaptive Model Switching** — Gitnado detects system VRAM/GPU and selects the optimal model:
  - **Ultra-light (8GB RAM):** Uses **Gemma 3 1B** (distilled) or **Llama 3.2 1B**
  - **Standard (16GB+ RAM):** Uses **Gemma 3 4B** or **Phi-4-mini** (3.8B)
  - **Pro (32GB+ RAM):** Uses **Qwen 2.5 Coder 14B** (Q4_K_M)
  - System capability detection across RAM, GPU vendor/architecture (Metal + Accelerate on macOS, NVIDIA CUDA, AMD ROCm & Vulkan), VRAM, unified memory detection (Apple Silicon & AMD Ryzen AI APUs), and NPU detection (Apple Neural Engine & AMD XDNA) with tier-based recommendations

- ✅ **GPU-Accelerated Local Inference & Token Streaming** — Rust-native GGUF inference via `llama-cpp-2` with hardware acceleration: Metal + Accelerate on macOS, NVIDIA CUDA, AMD ROCm & Vulkan on Linux/Windows, unified memory & NPU awareness, dynamic VRAM layer offloading, CPU fallback, and real-time token-by-token streaming (`ai-stream-token` events) for commit message generation. Supports llama, gemma, phi, mistral, and qwen architectures.

- ✅ **The "Context Proxy" (MCP)** — Local-first implementation of the **Model Context Protocol**. Gitnado serves as an MCP host with HTTP/JSON-RPC server, exposing 7 Git tools (`get_commit_history`, `get_branches`, `get_status`, `get_diff`, `get_file_blame`, `search_commits`, `get_open_repositories`) for external tools to query.

- ✅ **Local Model Management & Custom GGUF Import** — Download models from HuggingFace with SHA-256 verification, progress tracking, cancellation support, or import arbitrary local `.gguf` files from disk (`import_custom_model`). Load/unload/delete models. Settings UI with system capabilities display and model browser.

- ✅ **7 Cloud AI Providers** — Ollama, LM Studio, OpenAI, Anthropic Claude, GitHub Copilot, Google Gemini, and embedded local inference. API key management, provider testing, per-provider model selection.

#### Phase 2: Semantic Git History ✅

*Moving from keyword search to "Meaning Search."*

- ✅ **Semantic Search Infrastructure** — Per-repository SQLite vector storage with sqlite-vec for cosine similarity search. Candle-based (pure Rust) BERT embedding engine using all-MiniLM-L6-v2 (384-dim vectors) that auto-accelerates on Metal and CUDA with CPU fallback. Incremental indexing with background builds and progress events.

- ✅ **Natural Language History Search** — Semantic search mode toggle in the search bar. Embeds queries and finds semantically similar commits via vector similarity. Integrated into the commit graph with highlighting.

- ✅ **Automatic Changelog Generation** — AI-powered release notes from commit history between any two refs. Standalone dialog with tag selectors and copy-to-clipboard. Accessible via command palette ("Generate Changelog").

#### Phase 3: The "Local Bouncer" ✅

*Local AI Code Review before you push.*

- ✅ **Pre-Commit "Vibe Check"** — Regex-based secret detection (AWS keys, private keys, passwords, API keys, tokens) + LLM analysis for complexity spikes and quality issues. Risk badge (low/medium/high) in commit panel with expandable findings list.

- ✅ **Automated PR Descriptions** — AI Generate button on PR/MR body textarea in all 4 integration dialogs (GitHub, GitLab, Azure DevOps, Bitbucket). Analyzes branch commits + diff stats to produce structured PR descriptions.

- ✅ **AI-Assisted Staging** — Tangled commit detection via LLM analysis of staged diffs. Shows split suggestions with file groupings and conventional commit messages. One-click "Stage This Group" to stage only the files in each group.

#### Phase 4: The "Rebase Pilot" ✅

*Eliminating Git anxiety through predictive resolution.*

- ✅ **Conflict Explainer** — AI explains WHY a conflict occurred in the merge editor, summarizing what each branch changed. Provides plain-language explanation alongside the existing resolution suggestions.

- ✅ **Predictive Rebase ("Ghost Rebase")** — Runs a dry-run rebase in a temporary detached worktree to predict conflicts before the real rebase. Reports total commits, clean vs conflicting, and lists affected files. Worktree is automatically cleaned up.

- ✅ **Semantic Undo (Reflog Intelligence)** — "Smart Undo (AI)" command in the command palette accepts natural language queries ("before the rebase", "undo last 3 commits"). LLM matches the query to reflog entries and performs a soft reset with confirmation.

#### Hardware & Model Specs (2026-2027)

> Due for a refresh under Phase 4.7.

| Feature | Model Recommendation | Est. RAM Usage | Latency Goal |
|---------|---------------------|---------------|--------------|
| **Commit Messages** | Gemma 3 1B | 1.2 GB | < 500ms |
| **Semantic Search** | Nomic-Embed-v1.5 | 500 MB | < 200ms |
| **Code Review** | Phi-4 (3.8B) | 3.5 GB | 2-5 sec |
| **Conflict Analysis** | Llama 4 Scout (17B) | 12 GB (Opt.) | 5-10 sec |

#### The Competitive Killer

By Q2 2027, Gitnado's primary advantage is that **it costs $0 in API credits** and **is 100% air-gapped**. While GitKraken users are paying $15/month for cloud-based AI that sees their private code, Gitnado users are getting the same intelligence powered by their own GPU.

---

### Authentication & Security

- ✅ **GitHub OAuth** — browser-based OAuth 2.0 with PKCE, automatic token refresh, scope management
- ✅ **GitLab OAuth** — OAuth for GitLab.com and self-hosted instances, custom OAuth application configuration
- ✅ **Bitbucket** — OAuth authentication, workspace and repository access, PRs/issues/pipelines
- ✅ **Azure DevOps** — Microsoft Entra ID OAuth (work/school accounts) + org-scoped PAT authentication, PRs/work items/pipelines. Global PATs deprecated March 2026, fully removed December 2026.

- ✅ **GitHub App Installation** — users configure their own GitHub App (App ID, private key, installation ID). RS256 JWT authentication with automatic installation token refresh (1-hour tokens, cached with 5-min buffer). Fine-grained, org-level permissions that don't expire.
- ✅ **Git Credential Manager Detection** — auto-detects GCM, osxkeychain, and configured credential helpers. Delegates credential resolution when available, falls back to Gitnado's built-in keyring storage.

- ✅ **Enterprise SSO (OIDC)** — OpenID Connect support for corporate identity providers (Okta, Azure AD, Auth0, Keycloak, etc.). OIDC discovery via `.well-known/openid-configuration`, PKCE-protected authorization code flow, JWT ID token decoding for user identity extraction. Configurable issuer URL, client ID, and scopes.

---

### Testing & Quality Assurance

- ✅ **Unit tests** — 261+ test files, 5,200+ tests via web-test-runner, 228+ Rust AI tests
- ✅ **E2E tests** — 61 Playwright test files covering dialogs, git operations, UI components, OAuth flows
- ✅ **Rust tests** — integration tests for Tauri commands with TestRepo helpers
- ✅ **CI/CD** — GitHub Actions build workflow with signing for tagged releases

---

## Open Work

Recently shipped milestones (as of 2026-10-23):

- ✅ **Jira integration UI** — `gn-jira-dialog.ts` wired into the toolbar and command palette with connection management, JQL issue search, status transitions, and branch creation from Jira issues.
- ✅ **Inline PR/MR review comments** — GitHub, GitLab, Azure DevOps, and Bitbucket dialogs support viewing and posting general and line-level diff review comments.
- ✅ **Recursive submodule clone (`--recurse-submodules`)** — `clone_repository` and `gn-clone-dialog.ts` support cloning submodules recursively (enabled by default).
- ✅ **Hook execution logs & Output panel filter/terminal launcher** — `gn-hooks-dialog.ts` records and displays historical hook execution logs, and `gn-output-panel.ts` provides output search/filtering and a quick external terminal launcher.
- ✅ **Local AI `Pro` tier, custom `.gguf` import & token streaming** — `Pro` (32GB+ RAM / 12GB+ VRAM) model tier (Qwen 2.5 Coder 14B), local `.gguf` model import from disk (`import_custom_model`), and real-time `ai-stream-token` streaming during commit message generation.
- ✅ **Unified Provider Dialog Base (`GnProviderDialogBase`)** — shared abstract base class (`src/components/dialogs/gn-provider-dialog-base.ts`) unifying repository detection, generation-counter stale-response guards, deferred repo reconciliation during account ops, PR/MR creation guards, and review comment drawers across GitHub, GitLab, Bitbucket, and Azure DevOps dialogs.

### Architectural Refactoring & Modularization ✅

- ✅ **`AppShell` & `GnRepoScopedDialogBase` (`arch-1`)** — Extracted `GnRepoScopedDialogBase` (`src/components/dialogs/gn-repo-scoped-dialog-base.ts`) for repository-bound dialogs (`gn-remote-dialog`, `gn-clean-dialog`, `gn-submodule-dialog`, `gn-worktree-dialog`, `gn-lfs-dialog`, `gn-gpg-dialog`, `gn-bisect-dialog`) to pin `repositoryPath` at operation start, invalidate stale loads on repo switch, and always emit `{ repositoryPath }` in `*-changed` events. Wired `@remotes-changed` in `AppShell` through `refreshConflictDialogRepo` and moved `showJiraDialog` into `dialog.store.ts`.
- ✅ **`git.service.ts` Domain Modularization (`arch-2`)** — Split the 9,619-line `src/services/git.service.ts` monolith into 9 focused domain modules under `src/services/git/` (`shared.ts`, `repository.ts`, `branches-tags.ts`, `diff-blame.ts`, `merge-rebase.ts`, `remotes.ts`, `security-credentials.ts`, `providers.ts`, `ai-workspace.ts`) while keeping `src/services/git.service.ts` as a 100% backwards-compatible barrel export.
- ✅ **Provider Stack Phase 2 — Shared Auth Lifecycle & Rust HTTP Layer (`arch-3`)** — Extracted `runDisconnectOperation` and `runDeleteIntegrationOperation` into `GnProviderDialogBase` across GitHub, GitLab, Bitbucket, and Azure DevOps dialogs, and extracted `src-tauri/src/services/provider_http.rs` for shared `reqwest::Client` construction, outbound-host security checks, auth header builders, and HTTP status/rate-limit error formatting across `commands/{github,gitlab,bitbucket,azure_devops}.rs`.
- ✅ **Rust Mega-Commands Modularization (`arch-4`)** — Decomposed monolithic Rust command files (`merge.rs` 7,891 → 873 lines, `remote.rs` 5,487 → 475 lines, `rewrite.rs` 4,612 → 348 lines, `commit.rs` 4,410 → 223 lines) into focused domain submodules under `src-tauri/src/commands/{merge,remote,rewrite,commit}/` while preserving all Tauri command signatures and unit tests.

Remaining future work is tracked in [Phase 4: The Agent-Era Git Workstation](#4-next-the-agent-era-git-workstation-2027-). The previously listed items (embedded PTY terminal, dedicated CUDA/Vulkan release builds) are now part of 4.6.

Apple Silicon only on macOS is a deliberate choice, not a gap: Apple is winding down Intel
support across macOS, so `.github/workflows/build.yml` targets `aarch64-apple-darwin` alone and
there are no plans for an `x86_64-apple-darwin` or universal build.

---

## Contributing to the Roadmap

Have ideas or feedback on these plans? We welcome community input!

1. **Open an issue** to discuss new feature ideas
2. **Comment on existing issues** to vote or provide use cases
3. **Submit a PR** if you want to help implement a feature
4. **Join discussions** in GitHub Discussions for broader topics

Remember: Gitnado's core value proposition is **privacy-first, offline-capable, high-performance Git GUI**. Features should align with these principles.

---

Last updated: 2026-11-01
