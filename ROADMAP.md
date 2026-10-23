# Gitnado Roadmap

This document outlines the strategic vision and planned features for Gitnado. For current features, see [README.md](README.md).

## Vision

Gitnado is transitioning from a "Git GUI with AI" to a **Local-First AI Development Hub**. The goal is to move beyond simple commit message generation and leverage Gitnado's unique position inside the user's filesystem and Git history.

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

Remaining future work:

- **In-app PTY terminal emulator** — `open_terminal` launches the external OS terminal from the toolbar or Output panel; a full embedded PTY terminal panel remains a future enhancement.
- **Dedicated Vulkan/CUDA release binary variants in CI** — `.github/workflows/build.yml` builds default release artifacts; separate prebuilt CUDA/Vulkan installer matrix targets remain planned.

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

Last updated: 2026-10-23
