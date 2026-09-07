# Gitnado: Comprehensive Development Plan

## A fully-featured, open-source Git GUI client

---

# Table of Contents

1. [Project Overview](#1-project-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Technical Risk Analysis & Decisions](#4-technical-risk-analysis--decisions)
5. [Core Git Engine](#5-core-git-engine)
6. [User Interface Components](#6-user-interface-components)
7. [Graph Visualization System](#7-graph-visualization-system)
8. [Repository Management](#8-repository-management)
9. [Branch Management](#9-branch-management)
10. [Commit Operations](#10-commit-operations)
11. [Staging & Working Directory](#11-staging--working-directory)
12. [Diff & Blame System](#12-diff--blame-system)
13. [Merge & Conflict Resolution](#13-merge--conflict-resolution)
14. [Rebase Operations](#14-rebase-operations)
15. [Stash Management](#15-stash-management)
16. [Remote Operations](#16-remote-operations)
17. [Tag Management](#17-tag-management)
18. [Submodule Support](#18-submodule-support)
19. [Git LFS Support](#19-git-lfs-support)
20. [Git Hooks](#20-git-hooks)
21. [Gitflow Support](#21-gitflow-support)
22. [Search & Filter System](#22-search--filter-system)
23. [Integration Hub](#23-integration-hub)
24. [Pull Request Management](#24-pull-request-management)
25. [Issue Tracking Integration](#25-issue-tracking-integration)
26. [Workspace Management](#26-workspace-management)
27. [Profile & Account System](#27-profile-account-system)
28. [Settings & Preferences](#28-settings--preferences)
29. [Theming System](#29-theming-system)
30. [Keyboard Shortcuts](#30-keyboard-shortcuts)
31. [Notifications System](#31-notifications-system)
32. [Terminal Integration](#32-terminal-integration)
33. [Editor Integration](#33-editor-integration)
34. [File History & Timeline](#34-file-history--timeline)
35. [Undo/Redo System](#35-undoredo-system)
36. [Performance & Optimization](#36-performance--optimization)
37. [Security](#37-security)
38. [Accessibility](#38-accessibility)
39. [Internationalization](#39-internationalization)
40. [Auto-Update System](#40-auto-update-system)
41. [Analytics & Telemetry](#41-analytics--telemetry)
42. [Development Phases](#42-development-phases) *(includes Phase 0: POC)*
43. [Testing Strategy](#43-testing-strategy) *(includes Cross-Platform Testing)*
44. [Documentation](#44-documentation)

**Appendices**:
- [Appendix A: Competitor Feature Comparison](#appendix-a-competitor-feature-comparison)
- [Appendix B: Technology Alternatives Considered](#appendix-b-technology-alternatives-considered)
- [Appendix C: Estimated Resource Requirements](#appendix-c-estimated-resource-requirements)
- [Appendix D: Risk Assessment](#appendix-d-risk-assessment)
- [Appendix E: Technical Spike Documents](#appendix-e-technical-spike-documents)

---

# 1. Project Overview

## 1.1 Vision Statement
Create a fully-featured, open-source, cross-platform Git GUI client that provides professional-grade functionality while remaining free for all users.

## 1.2 Target Platforms
- Windows 10/11 (x64, ARM64)
- macOS 11+ (Intel, Apple Silicon)
- Linux (Ubuntu, Fedora, Arch, Debian - x64, ARM64)
  - AppImage
  - .deb package
  - .rpm package
  - Flatpak
  - Snap

## 1.3 License
- GPLv3 or MIT (to be decided based on dependency licenses)

## 1.4 Core Principles
- Privacy-first (no telemetry by default)
- Offline-capable
- Fast and responsive
- Accessible
- Extensible via plugins

---

# 2. Technology Stack

## 2.1 Primary Stack (Recommended)

### Backend/Core
| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Rust | Core application logic, git operations |
| Git Library | git2-rs (libgit2 bindings) | All git operations |
| Async Runtime | Tokio | Async I/O, background tasks |
| IPC | Tauri Commands | Frontend-backend communication |
| Database | SQLite (rusqlite) | Local caching, settings, history |
| Keychain | keyring-rs | Secure credential storage |

### Frontend
| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | Tauri 2.0 | Desktop application shell |
| Language | TypeScript 5.x (Strict Mode) | Type-safe development |
| UI Library | Lit 3.x | Web Components with reactive properties |
| State Management | @lit-labs/context + Zustand | Application state |
| Routing | @vaadin/router | Client-side routing |
| Styling | Lit CSS (Shadow DOM) + CSS Custom Properties | Scoped component styling |
| Design Tokens | Style Dictionary | Theme variables & tokens |
| Graph Rendering | Custom Canvas/WebGL | Commit graph visualization |
| Diff Rendering | Monaco Editor / CodeMirror 6 | Code diff display |
| Icons | Lucide (via @lucide/lit) / Phosphor | UI iconography |
| Animations | Web Animations API + Motion One | Smooth transitions |
| Build Tool | Vite | Fast HMR and bundling |
| Testing | @open-wc/testing + Web Test Runner | Component testing |

### Key NPM Dependencies

```json
{
  "dependencies": {
    "lit": "^3.1.0",
    "@lit-labs/context": "^0.5.0",
    "@lit-labs/router": "^0.1.0",
    "@lit/localize": "^0.12.0",
    "@vaadin/router": "^1.7.5",
    "@tauri-apps/api": "^2.0.0",
    "zustand": "^4.5.0",
    "@lucide/lit": "^0.300.0",
    "monaco-editor": "^0.45.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@open-wc/testing": "^4.0.0",
    "@web/test-runner": "^0.18.0",
    "@web/test-runner-playwright": "^0.11.0",
    "@lit/localize-tools": "^0.7.0",
    "@custom-elements-manifest/analyzer": "^0.9.0"
  }
}
```

## 2.2 Alternative Stack (Electron-based)

### Backend/Core
| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js | Core application logic |
| Git Library | nodegit / simple-git / isomorphic-git | Git operations |
| IPC | Electron IPC | Frontend-backend communication |
| Database | better-sqlite3 / LevelDB | Local storage |

### Frontend
| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | Electron | Desktop shell |
| UI Library | React 18 + TypeScript | UI components |
| State Management | Zustand / Jotai | State management |
| Styling | Tailwind CSS / Styled Components | Styling |

---

# 3. Architecture

## 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (WebView)                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │  Graph   │ │  Diff    │ │  File    │ │ Settings │   ...     │
│  │  View    │ │  View    │ │  Tree    │ │  Panel   │           │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
├─────────────────────────────────────────────────────────────────┤
│                      STATE MANAGEMENT                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Repository State │ UI State │ Settings │ Cache        │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                         IPC LAYER                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Commands │ Events │ Streaming │ File Watchers          │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND (Rust)                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    SERVICE LAYER                          │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │  │
│  │  │  Repo   │ │ Branch  │ │ Commit  │ │ Remote  │  ...   │  │
│  │  │ Service │ │ Service │ │ Service │ │ Service │        │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                      GIT LAYER                            │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │                  libgit2 (git2-rs)                   │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │              Git CLI Fallback (edge cases)          │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   INTEGRATION LAYER                       │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │  │
│  │  │ GitHub │ │ GitLab │ │Bitbuck.│ │ Azure  │ │ Jira   │ │  │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   PERSISTENCE LAYER                       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐│  │
│  │  │ SQLite  │ │Keychain │ │  File   │ │ Config Files    ││  │
│  │  │  Cache  │ │ Access  │ │ System  │ │ (.gitconfig)    ││  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘│  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 3.2 Directory Structure

```
openkraken/
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/             # Tauri command handlers
│   │   │   ├── mod.rs
│   │   │   ├── repository.rs
│   │   │   ├── branch.rs
│   │   │   ├── commit.rs
│   │   │   ├── remote.rs
│   │   │   ├── stash.rs
│   │   │   ├── tag.rs
│   │   │   ├── diff.rs
│   │   │   ├── merge.rs
│   │   │   ├── rebase.rs
│   │   │   ├── submodule.rs
│   │   │   ├── lfs.rs
│   │   │   ├── hooks.rs
│   │   │   └── settings.rs
│   │   ├── services/             # Business logic
│   │   │   ├── mod.rs
│   │   │   ├── git_service.rs
│   │   │   ├── graph_service.rs
│   │   │   ├── diff_service.rs
│   │   │   ├── search_service.rs
│   │   │   ├── integration_service.rs
│   │   │   └── workspace_service.rs
│   │   ├── models/               # Data structures
│   │   │   ├── mod.rs
│   │   │   ├── repository.rs
│   │   │   ├── commit.rs
│   │   │   ├── branch.rs
│   │   │   ├── remote.rs
│   │   │   ├── diff.rs
│   │   │   └── graph.rs
│   │   ├── integrations/         # Third-party integrations
│   │   │   ├── mod.rs
│   │   │   ├── github.rs
│   │   │   ├── gitlab.rs
│   │   │   ├── bitbucket.rs
│   │   │   ├── azure_devops.rs
│   │   │   ├── jira.rs
│   │   │   └── trello.rs
│   │   ├── db/                   # Database layer
│   │   │   ├── mod.rs
│   │   │   ├── migrations/
│   │   │   ├── cache.rs
│   │   │   └── settings.rs
│   │   ├── security/             # Security utilities
│   │   │   ├── mod.rs
│   │   │   ├── credentials.rs
│   │   │   ├── ssh.rs
│   │   │   └── gpg.rs
│   │   └── utils/                # Utilities
│   │       ├── mod.rs
│   │       ├── file_watcher.rs
│   │       ├── git_config.rs
│   │       └── platform.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                          # Frontend (TypeScript + Lit)
│   ├── components/               # Lit Web Components
│   │   ├── graph/
│   │   │   ├── commit-graph.ts
│   │   │   ├── commit-node.ts
│   │   │   ├── branch-line.ts
│   │   │   ├── merge-point.ts
│   │   │   ├── graph-canvas.ts
│   │   │   └── index.ts
│   │   ├── diff/
│   │   │   ├── diff-view.ts
│   │   │   ├── split-diff.ts
│   │   │   ├── unified-diff.ts
│   │   │   ├── hunk-view.ts
│   │   │   ├── line-numbers.ts
│   │   │   └── index.ts
│   │   ├── tree/
│   │   │   ├── file-tree.ts
│   │   │   ├── file-node.ts
│   │   │   ├── folder-node.ts
│   │   │   └── index.ts
│   │   ├── panels/
│   │   │   ├── left-panel.ts
│   │   │   ├── right-panel.ts
│   │   │   ├── bottom-panel.ts
│   │   │   ├── commit-panel.ts
│   │   │   ├── history-panel.ts
│   │   │   └── index.ts
│   │   ├── modals/
│   │   │   ├── base-modal.ts
│   │   │   ├── clone-modal.ts
│   │   │   ├── branch-modal.ts
│   │   │   ├── merge-modal.ts
│   │   │   ├── rebase-modal.ts
│   │   │   ├── settings-modal.ts
│   │   │   ├── conflict-modal.ts
│   │   │   ├── integration-modal.ts
│   │   │   └── index.ts
│   │   ├── common/
│   │   │   ├── ok-button.ts
│   │   │   ├── ok-input.ts
│   │   │   ├── ok-select.ts
│   │   │   ├── ok-checkbox.ts
│   │   │   ├── ok-tooltip.ts
│   │   │   ├── ok-context-menu.ts
│   │   │   ├── ok-toast.ts
│   │   │   ├── ok-tabs.ts
│   │   │   ├── ok-dropdown.ts
│   │   │   ├── ok-icon.ts
│   │   │   └── index.ts
│   │   ├── toolbar/
│   │   │   ├── main-toolbar.ts
│   │   │   ├── branch-selector.ts
│   │   │   ├── quick-actions.ts
│   │   │   └── index.ts
│   │   ├── statusbar/
│   │   │   ├── status-bar.ts
│   │   │   └── index.ts
│   │   └── index.ts              # Export all components
│   ├── controllers/              # Lit Reactive Controllers
│   │   ├── keyboard-controller.ts
│   │   ├── resize-controller.ts
│   │   ├── intersection-controller.ts
│   │   └── index.ts
│   ├── context/                  # Lit Context Providers
│   │   ├── repository-context.ts
│   │   ├── theme-context.ts
│   │   ├── settings-context.ts
│   │   └── index.ts
│   ├── stores/                   # Zustand Stores
│   │   ├── repository.store.ts
│   │   ├── commits.store.ts
│   │   ├── branches.store.ts
│   │   ├── remotes.store.ts
│   │   ├── staging.store.ts
│   │   ├── diff.store.ts
│   │   ├── settings.store.ts
│   │   ├── ui.store.ts
│   │   ├── integrations.store.ts
│   │   └── index.ts
│   ├── services/                 # Business Logic Services
│   │   ├── tauri-api.ts          # Tauri IPC wrapper
│   │   ├── git.service.ts
│   │   ├── graph.service.ts
│   │   ├── shortcuts.service.ts
│   │   └── index.ts
│   ├── utils/                    # Utility Functions
│   │   ├── format.ts
│   │   ├── date.ts
│   │   ├── color.ts
│   │   ├── platform.ts
│   │   ├── lit-helpers.ts        # Lit-specific utilities
│   │   └── index.ts
│   ├── types/                    # TypeScript Type Definitions
│   │   ├── git.types.ts
│   │   ├── graph.types.ts
│   │   ├── api.types.ts
│   │   ├── components.types.ts
│   │   └── index.ts
│   ├── styles/                   # Shared Styles
│   │   ├── shared-styles.ts      # Lit CSSResult exports
│   │   ├── tokens.css            # CSS Custom Properties
│   │   ├── themes/
│   │   │   ├── light.css
│   │   │   ├── dark.css
│   │   │   └── high-contrast.css
│   │   └── index.ts
│   ├── decorators/               # Custom Decorators
│   │   ├── debounce.ts
│   │   ├── memoize.ts
│   │   └── index.ts
│   ├── directives/               # Lit Directives
│   │   ├── virtual-scroll.ts
│   │   ├── syntax-highlight.ts
│   │   └── index.ts
│   ├── app-shell.ts              # Main application shell component
│   ├── router.ts                 # Application routing setup
│   ├── index.ts                  # Application entry point
│   └── index.html
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docs/
├── .github/
│   └── workflows/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── web-test-runner.config.js     # @open-wc testing config
├── custom-elements.json          # Web Components manifest
├── lit-localize.json             # i18n configuration
└── README.md
```

## 3.3 Data Flow

```
User Action → UI Component → Store Update → IPC Command → Rust Handler
     ↑                                                          │
     │                                                          ▼
     └──── UI Update ←── Store Update ←── IPC Response ←── Git Operation
```

## 3.4 Lit Element Implementation Patterns

### 3.4.1 Component Structure

All components follow a consistent pattern using TypeScript decorators:

```typescript
import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { consume } from '@lit-labs/context';
import { repositoryContext, type Repository } from '../context/repository-context.js';
import { sharedStyles } from '../styles/shared-styles.js';

@customElement('ok-commit-node')
export class CommitNode extends LitElement {
  // Shared styles + component-specific styles
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        contain: content;
      }
      .commit {
        display: flex;
        align-items: center;
        padding: var(--spacing-sm);
        border-radius: var(--radius-md);
        cursor: pointer;
      }
      .commit:hover {
        background: var(--color-hover);
      }
      .commit.selected {
        background: var(--color-selected);
      }
      .sha {
        font-family: var(--font-mono);
        color: var(--color-primary);
      }
    `
  ];

  // Public reactive properties (can be set via attributes)
  @property({ type: Object }) commit!: Commit;
  @property({ type: Boolean, reflect: true }) selected = false;

  // Internal reactive state
  @state() private expanded = false;
  @state() private hovered = false;

  // Context consumption (from parent providers)
  @consume({ context: repositoryContext, subscribe: true })
  @state() private repository?: Repository;

  // DOM queries
  @query('.commit') private commitElement!: HTMLElement;

  // Lifecycle: called when properties change
  protected willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('commit')) {
      // Perform setup when commit changes
    }
  }

  // Lifecycle: called after render
  protected firstUpdated(): void {
    // DOM is now available
    this.commitElement.focus();
  }

  // Event handlers
  private handleClick(): void {
    this.dispatchEvent(new CustomEvent('commit-selected', {
      detail: { commit: this.commit },
      bubbles: true,
      composed: true  // Crosses shadow DOM boundaries
    }));
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      this.handleClick();
    }
  }

  // Render method
  render() {
    return html`
      <div
        class="commit ${this.selected ? 'selected' : ''}"
        role="button"
        tabindex="0"
        aria-selected=${this.selected}
        @click=${this.handleClick}
        @keydown=${this.handleKeydown}
        @mouseenter=${() => this.hovered = true}
        @mouseleave=${() => this.hovered = false}
      >
        <span class="sha">${this.commit.sha.slice(0, 7)}</span>
        <span class="message">${this.commit.message}</span>
        ${this.hovered ? html`
          <ok-tooltip>Click to view details</ok-tooltip>
        ` : null}
      </div>
    `;
  }
}

// TypeScript declaration for HTML usage
declare global {
  interface HTMLElementTagNameMap {
    'ok-commit-node': CommitNode;
  }
}
```

### 3.4.2 State Management with Zustand

```typescript
// stores/repository.store.ts
import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

export interface RepositoryState {
  currentRepo: Repository | null;
  recentRepos: Repository[];
  isLoading: boolean;
  error: string | null;
  
  // Actions
  openRepository: (path: string) => Promise<void>;
  closeRepository: () => void;
  refreshStatus: () => Promise<void>;
}

export const repositoryStore = createStore<RepositoryState>()(
  subscribeWithSelector((set, get) => ({
    currentRepo: null,
    recentRepos: [],
    isLoading: false,
    error: null,

    openRepository: async (path: string) => {
      set({ isLoading: true, error: null });
      try {
        const repo = await invoke<Repository>('open_repository', { path });
        set({ currentRepo: repo, isLoading: false });
      } catch (e) {
        set({ error: String(e), isLoading: false });
      }
    },

    closeRepository: () => {
      set({ currentRepo: null });
    },

    refreshStatus: async () => {
      const { currentRepo } = get();
      if (!currentRepo) return;
      // Refresh logic...
    },
  }))
);

// Reactive controller for Lit components
export class RepositoryController implements ReactiveController {
  host: ReactiveControllerHost;
  private unsubscribe?: () => void;

  state: RepositoryState = repositoryStore.getState();

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.unsubscribe = repositoryStore.subscribe((state) => {
      this.state = state;
      this.host.requestUpdate();
    });
  }

  hostDisconnected() {
    this.unsubscribe?.();
  }
}
```

### 3.4.3 Context Providers

```typescript
// context/repository-context.ts
import { createContext } from '@lit-labs/context';
import type { Repository } from '../types/git.types.js';

export const repositoryContext = createContext<Repository | undefined>('repository');

// Provider component
@customElement('ok-repository-provider')
export class RepositoryProvider extends LitElement {
  @provide({ context: repositoryContext })
  @property({ type: Object })
  repository?: Repository;

  render() {
    return html`<slot></slot>`;
  }
}
```

### 3.4.4 Lit Directives for Performance

```typescript
// directives/virtual-scroll.ts
import { Directive, directive, PartInfo } from 'lit/directive.js';

class VirtualScrollDirective extends Directive {
  private observer?: IntersectionObserver;
  
  render(items: any[], renderItem: (item: any) => TemplateResult) {
    // Virtual scrolling implementation
  }
}

export const virtualScroll = directive(VirtualScrollDirective);

// Usage in component:
render() {
  return html`
    <div class="scroll-container">
      ${virtualScroll(this.commits, (commit) => html`
        <ok-commit-node .commit=${commit}></ok-commit-node>
      `)}
    </div>
  `;
}
```

### 3.4.5 Tauri IPC Integration

```typescript
// services/tauri-api.ts
import { invoke } from '@tauri-apps/api/tauri';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export class TauriAPI {
  // Type-safe command invocation
  static async openRepository(path: string): Promise<Repository> {
    return invoke<Repository>('open_repository', { path });
  }

  static async getCommits(options: CommitQueryOptions): Promise<Commit[]> {
    return invoke<Commit[]>('get_commits', { options });
  }

  static async stageFiles(paths: string[]): Promise<void> {
    return invoke('stage_files', { paths });
  }

  // Event listeners
  static onRepositoryChanged(callback: (repo: Repository) => void): Promise<UnlistenFn> {
    return listen<Repository>('repository-changed', (event) => {
      callback(event.payload);
    });
  }

  static onFileSystemChange(callback: (changes: FileChange[]) => void): Promise<UnlistenFn> {
    return listen<FileChange[]>('fs-changed', (event) => {
      callback(event.payload);
    });
  }
}
```

### 3.4.6 Testing Components

```typescript
// tests/commit-node.test.ts
import { fixture, html, expect } from '@open-wc/testing';
import { CommitNode } from '../src/components/graph/commit-node.js';

describe('CommitNode', () => {
  it('renders commit SHA', async () => {
    const commit = { sha: 'abc1234567890', message: 'Test commit' };
    const el = await fixture<CommitNode>(html`
      <ok-commit-node .commit=${commit}></ok-commit-node>
    `);
    
    const sha = el.shadowRoot!.querySelector('.sha');
    expect(sha?.textContent).to.equal('abc1234');
  });

  it('dispatches event on click', async () => {
    const commit = { sha: 'abc1234567890', message: 'Test' };
    const el = await fixture<CommitNode>(html`
      <ok-commit-node .commit=${commit}></ok-commit-node>
    `);
    
    let eventFired = false;
    el.addEventListener('commit-selected', () => { eventFired = true; });
    
    el.shadowRoot!.querySelector('.commit')?.click();
    expect(eventFired).to.be.true;
  });

  it('is accessible', async () => {
    const commit = { sha: 'abc1234567890', message: 'Test' };
    const el = await fixture<CommitNode>(html`
      <ok-commit-node .commit=${commit}></ok-commit-node>
    `);
    
    await expect(el).to.be.accessible();
  });
});
```

---

# 4. Technical Risk Analysis & Decisions

This section documents key technical decisions made after extensive analysis of the three highest-risk areas: graph rendering, libgit2 limitations, and cross-platform file system challenges.

## 4.1 Risk Summary Matrix

| Risk Area | Severity | Mitigation Status | Key Decision |
|-----------|----------|-------------------|--------------|
| Graph Rendering Performance | 🔴 High | ✅ Resolved | Hybrid Canvas + DOM with git-optimized layout |
| libgit2 Interactive Rebase | 🔴 High | ✅ Resolved | CLI fallback with GIT_SEQUENCE_EDITOR |
| Git LFS Support | 🔴 High | ✅ Resolved | Wrap git-lfs CLI commands |
| Line Ending Handling | 🔴 High | ✅ Resolved | Auto-detect, warn, offer batch fix |
| File Locking (Windows) | 🟠 Medium | ✅ Resolved | Retry with exponential backoff |
| Case Sensitivity | 🟠 Medium | ✅ Resolved | Pre-checkout scan and warnings |
| Path Length (Windows) | 🟠 Medium | ✅ Resolved | Detect and offer solutions |
| Symlinks | 🟠 Medium | ✅ Resolved | Fallback to regular files with warning |
| Hooks Execution | 🟠 Medium | ✅ Resolved | Manual invocation wrapper |
| Unicode Normalization | 🟡 Low | ✅ Resolved | NFC normalization internally |

## 4.2 Graph Rendering Architecture

### 4.2.1 Decision: Hybrid Canvas + DOM Approach

After analyzing rendering technologies, the hybrid approach provides the best balance:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       HYBRID RENDERING                               │
├─────────────────────────────────────────────────────────────────────┤
│   Canvas Layer (WebGL optional)     │     DOM Layer (Lit)           │
│   ─────────────────────────────     │     ───────────────           │
│   • Commit nodes (circles)          │     • Branch labels           │
│   • Branch lines (paths)            │     • Tag labels              │
│   • Merge connections               │     • Tooltips                │
│   • Selection highlights            │     • Context menus           │
│                                     │     • Accessibility overlays  │
│   Performance: 60fps @ 100K nodes   │     Native events & a11y      │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2.2 Layout Algorithm: Git-Optimized

Use a git-specific algorithm optimized for first-parent traversal:

1. Treat first-parent chain as "main line" (lane 0)
2. Spawn new lanes for side branches at branch points
3. Merge lanes when branches merge
4. O(n) complexity, deterministic output

**NOT using:** Sugiyama (too slow), Force-directed (non-deterministic)

### 4.2.3 Performance Targets

| Metric | Target | Stretch Goal |
|--------|--------|--------------|
| Initial render (10K commits) | < 500ms | < 200ms |
| Scroll FPS | 60fps | 120fps |
| Click-to-select latency | < 50ms | < 16ms |
| Memory (100K commits) | < 500MB | < 200MB |

### 4.2.4 Key Techniques

- **Virtual Scrolling**: Only render visible commits + buffer
- **Spatial Index**: Grid-based hit testing for O(1) lookups
- **Tile Caching**: Cache rendered canvas regions
- **Layout in Rust**: Compute lane assignments in backend
- **Incremental Updates**: Don't recalculate on every new commit

## 4.3 Git Engine Architecture

### 4.3.1 Decision: libgit2 + CLI Hybrid

libgit2 (via git2-rs) handles ~80% of operations. CLI fallback for complex features.

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitService (Unified API)                      │
│                                                                  │
│   Single interface for all git operations                        │
│   Automatically chooses implementation internally                │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │   libgit2    │  │   Git CLI    │  │   External   │
   │   (git2-rs)  │  │   Wrapper    │  │   Tools      │
   │              │  │              │  │              │
   │ • Clone      │  │ • Rebase -i  │  │ • git-lfs    │
   │ • Commit     │  │ • Bisect     │  │ • gpg        │
   │ • Branch     │  │ • Filter     │  │ • ssh-keygen │
   │ • Merge      │  │ • gc         │  │              │
   │ • Diff/Blame │  │ • Worktree   │  │              │
   │ • Push/Pull  │  │   (complex)  │  │              │
   └──────────────┘  └──────────────┘  └──────────────┘
```

### 4.3.2 Operation Implementation Matrix

| Operation | Implementation | Notes |
|-----------|----------------|-------|
| Clone/Init/Open | libgit2 | Full support |
| Commit/Stage | libgit2 + hooks | Manual hook execution |
| Branch/Tag | libgit2 | Full support |
| Merge | libgit2 | Full support |
| Diff/Blame | libgit2 | Full support |
| Push/Pull/Fetch | libgit2 + LFS | LFS via CLI wrapper |
| Basic Rebase | libgit2 | Non-interactive only |
| Interactive Rebase | **CLI** | Via GIT_SEQUENCE_EDITOR |
| Stash | libgit2 | Include untracked via flags |
| Cherry-pick | libgit2 | Single commit; loop for range |
| Bisect | **CLI** | Not in libgit2 |
| LFS Operations | **git-lfs CLI** | All LFS via CLI |
| GPG Signing | gpgme or **CLI** | Depends on complexity |
| SSH Signing | **CLI** | git 2.34+ feature |
| Hooks | Manual execution | Invoke before/after operations |

### 4.3.3 Interactive Rebase via CLI

```rust
// Key insight: bypass editor with GIT_SEQUENCE_EDITOR
fn interactive_rebase(onto: &str, instructions: &[RebaseInstruction]) -> Result<()> {
    // 1. Generate todo file content
    let todo = format_rebase_todo(instructions);
    
    // 2. Execute with editor bypass
    Command::new("git")
        .env("GIT_SEQUENCE_EDITOR", "cat")  // Use our todo as-is
        .args(["rebase", "-i", onto])
        .exec()?;
    
    // 3. Handle conflicts via status polling
}
```

### 4.3.4 Hooks Execution

libgit2 does NOT execute hooks. We must invoke them manually:

```rust
// Before commit:
hooks.execute("pre-commit", &[])?;
hooks.execute("commit-msg", &[&msg_file])?;

// Create commit via libgit2
let oid = repo.commit(...)?;

// After commit:
hooks.execute("post-commit", &[])?;  // Non-blocking
```

### 4.3.5 Minimum System Requirements

| Requirement | Required | Optional |
|-------------|----------|----------|
| git CLI ≥ 2.20 | ✅ Yes | - |
| git-lfs | - | ✅ For LFS repos |
| GPG | - | ✅ For signing |
| SSH | ✅ Yes | - |

## 4.4 Cross-Platform Compatibility

### 4.4.1 Platform Differences Summary

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Case sensitive | ❌ No | ❌ No | ✅ Yes |
| Line endings | CRLF | LF | LF |
| Symlinks | ⚠️ Admin/Dev Mode | ✅ Yes | ✅ Yes |
| Max path | 260* | 1024 | 4096 |
| File locking | Mandatory | Advisory | Advisory |
| Unicode | NFC | NFD | NFC |

*Can be extended with registry setting

### 4.4.2 Automatic Git Configuration

On repository open, configure git settings appropriately:

| Setting | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `core.ignoreCase` | `true` | `true` | `false` |
| `core.autocrlf` | `true` or `input` | `input` | `input` |
| `core.symlinks` | `false`* | `true` | `true` |
| `core.fileMode` | `false` | `true` | `true` |
| `core.precomposeUnicode` | - | `true` | - |
| `core.longpaths` | `true`** | - | - |

*Unless Developer Mode enabled
**Requires Windows registry change

### 4.4.3 Pre-Operation Safety Checks

Before clone/checkout, scan for issues:

```rust
fn pre_checkout_safety_check(tree: &Tree) -> Vec<Warning> {
    let mut warnings = vec![];
    
    // Case conflicts (Windows/macOS)
    if !is_case_sensitive() {
        warnings.extend(find_case_conflicts(tree));
    }
    
    // Path length (Windows)
    warnings.extend(find_long_paths(tree, max_path_length()));
    
    // Symlinks (if not supported)
    if !symlinks_supported() {
        warnings.extend(find_symlinks(tree));
    }
    
    // Illegal filenames (Windows reserved names)
    warnings.extend(find_illegal_filenames(tree));
    
    // Unicode normalization collisions
    warnings.extend(find_normalization_collisions(tree));
    
    warnings
}
```

### 4.4.4 File Locking Retry Strategy (Windows)

```rust
async fn retry_with_lock_handling<T>(
    operation: impl Fn() -> Result<T>,
    max_retries: u32,
) -> Result<T> {
    for attempt in 0..max_retries {
        match operation() {
            Ok(result) => return Ok(result),
            Err(e) if is_lock_error(&e) => {
                let delay = Duration::from_millis(100 * 2u64.pow(attempt));
                tokio::time::sleep(delay).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(Error::FileLocked)
}
```

### 4.4.5 Line Ending Handling

1. **Detection**: Scan files for CRLF/LF/mixed on status
2. **Display**: Show indicator badge in diff view
3. **Warning**: Alert on mixed endings in same file
4. **Fix**: Offer batch normalization with .gitattributes

### 4.4.6 User-Facing Warnings

| Issue | When | Severity | Action |
|-------|------|----------|--------|
| Case conflict | Clone/checkout | Error | Block + explain |
| Path too long | Clone/checkout | Error | Offer solutions |
| Symlink unsupported | Clone/checkout | Warning | Create as file |
| File locked | Any write | Error | Retry dialog |
| Mixed line endings | Diff/status | Warning | Offer fix |
| Illegal filename | Clone/checkout | Error | Suggest rename |

## 4.5 Pre-Implementation Proof of Concept

### 4.5.1 POC Scope (3 weeks)

**Week 1: Graph Layout**
- Mock commit data generator
- Git-optimized lane assignment algorithm
- Unit tests with known graph topologies

**Week 2: Canvas Rendering**
- Lit Element canvas component
- Render nodes and edges
- Hit testing with spatial index
- Hover/selection interactions

**Week 3: Integration**
- Virtual scrolling
- Connect to real git data via Tauri
- Performance benchmarking against targets

### 4.5.2 POC Success Criteria

| Metric | Target |
|--------|--------|
| FPS (10K commits) | ≥ 60fps |
| Initial render (10K) | < 500ms |
| Memory (10K) | < 100MB |
| Hit test latency | < 1ms |

## 4.6 Future Considerations

### 4.6.1 gitoxide (Pure Rust Git)

Monitor gitoxide development as a potential libgit2 replacement:

| Aspect | libgit2 | gitoxide |
|--------|---------|----------|
| License | GPL v2 + exception | MIT/Apache 2.0 |
| Maturity | Very mature | Actively developing |
| Features | ~80% of git | ~60% (growing) |
| Performance | Good | Excellent |

**Recommendation**: Design GitService trait for swappability. Revisit in 12-18 months.

### 4.6.2 WebGL Upgrade Path

If Canvas 2D proves insufficient for extremely large repos (500K+ commits):

1. Keep same component API
2. Swap CanvasRenderingContext2D for WebGL (via regl)
3. Add tile-based rendering for zoom/pan optimization

---

# 5. Core Git Engine

## 5.1 Repository Operations

### 4.1.1 Repository Discovery
- [ ] Scan directory for .git folder
- [ ] Detect bare repositories
- [ ] Detect worktrees
- [ ] Identify repository type (normal, bare, submodule, worktree)
- [ ] Read repository configuration
- [ ] Parse .git/config file
- [ ] Detect default branch name
- [ ] Identify repository state (normal, merging, rebasing, cherry-picking, reverting, bisecting, applying)

### 4.1.2 Repository Initialization
- [ ] Initialize new repository
- [ ] Initialize bare repository
- [ ] Set initial branch name (configurable default)
- [ ] Create initial commit option
- [ ] Add default .gitignore templates
  - [ ] Language-specific templates
  - [ ] Framework-specific templates
  - [ ] IDE-specific templates
- [ ] Add default .gitattributes
- [ ] Initialize with README option
- [ ] Initialize with LICENSE option (license selector)

### 4.1.3 Repository Cloning
- [ ] Clone via HTTPS
- [ ] Clone via SSH
- [ ] Clone via Git protocol
- [ ] Clone via file path (local)
- [ ] Shallow clone (--depth)
- [ ] Single branch clone
- [ ] Clone with submodules (--recursive)
- [ ] Clone with LFS files
- [ ] Clone to specific directory
- [ ] Clone progress reporting
  - [ ] Counting objects progress
  - [ ] Receiving objects progress
  - [ ] Resolving deltas progress
  - [ ] Checking out files progress
- [ ] Clone cancellation
- [ ] Resume interrupted clone
- [ ] Mirror clone
- [ ] Sparse checkout configuration during clone

### 4.1.4 Repository Opening
- [ ] Open from recent repositories list
- [ ] Open from file browser
- [ ] Drag and drop folder to open
- [ ] Open from command line argument
- [ ] Open from URL handler (openkraken://open?path=...)
- [ ] Validate repository integrity on open
- [ ] Handle corrupted repositories gracefully
- [ ] Repository health check
  - [ ] Check for missing objects
  - [ ] Check for broken refs
  - [ ] Check index integrity

### 4.1.5 Working Directory Operations
- [ ] Get working directory status
- [ ] Watch for file system changes
- [ ] Debounce rapid file changes
- [ ] Detect binary files
- [ ] Detect file encoding
- [ ] Handle large files appropriately
- [ ] Detect line ending style (LF/CRLF)
- [ ] Apply .gitattributes rules
- [ ] Respect .gitignore rules
- [ ] Handle nested .gitignore files
- [ ] Handle global gitignore
- [ ] Handle repository-specific excludes (.git/info/exclude)

---

# 6. Cross-Platform Compatibility

## 6.1 Platform Detection

### 6.1.1 Startup Detection
- [ ] Detect operating system and version
- [ ] Detect filesystem case sensitivity
- [ ] Detect symlink support
- [ ] Detect long path support (Windows)
- [ ] Detect inotify limits (Linux)
- [ ] Detect Developer Mode (Windows)
- [ ] Store platform capabilities in app state

### 6.1.2 Repository-Level Detection
- [ ] Detect filesystem of repository location
- [ ] Check for case conflicts in tree
- [ ] Check for path length issues
- [ ] Check for symlinks when unsupported
- [ ] Check for illegal filenames
- [ ] Check for Unicode normalization issues

## 6.2 Case Sensitivity Handling

### 8.2.1 Detection
- [ ] Test filesystem case sensitivity on startup
- [ ] Scan repository for case-conflicting paths
- [ ] Detect case-only renames in status

### 8.2.2 User Warnings
- [ ] Pre-clone warning for case conflicts
- [ ] Pre-checkout warning for case conflicts
- [ ] Block operations with explanation when conflicts detected
- [ ] Offer to proceed anyway with confirmation

### 8.2.3 Safe Rename
- [ ] Two-step rename via temp file for case-only changes
- [ ] Update index correctly for case changes

## 6.3 Line Ending Management

### 8.3.1 Configuration
- [ ] Parse .gitattributes for eol settings
- [ ] Respect core.autocrlf configuration
- [ ] Configure appropriate defaults per platform
- [ ] Support text=auto detection

### 8.3.2 Detection & Display
- [ ] Detect line endings in files (CRLF/LF/mixed)
- [ ] Show line ending indicator in diff view
- [ ] Warn on mixed line endings within file
- [ ] Show line ending changes in diff

### 8.3.3 Normalization
- [ ] Batch normalize line endings
- [ ] Generate appropriate .gitattributes
- [ ] Preview normalization changes before apply

## 6.4 Path Length Handling (Windows)

### 6.4.1 Detection
- [ ] Check if long paths enabled in registry
- [ ] Scan tree for paths exceeding MAX_PATH
- [ ] Warn before checkout of long paths

### 6.4.2 Solutions
- [ ] Provide PowerShell command to enable long paths
- [ ] Suggest cloning to shorter base path
- [ ] Document subst drive workaround

## 6.5 Symlink Handling

### 6.5.1 Detection
- [ ] Test symlink capability on startup
- [ ] Detect symlinks in repository tree
- [ ] Check Developer Mode on Windows

### 6.5.2 Fallback Behavior
- [ ] Create regular file with target path as content
- [ ] Mark such files visually in UI
- [ ] Show warning banner about symlink limitations
- [ ] Provide enable instructions for Windows

## 6.6 File Locking (Windows)

### 6.6.1 Detection
- [ ] Detect sharing violation errors
- [ ] Attempt to identify locking process

### 6.6.2 Handling
- [ ] Retry with exponential backoff
- [ ] Show "file locked" dialog with process info if available
- [ ] Offer retry/cancel options
- [ ] Log lock events for debugging

## 6.7 Unicode & Filename Handling

### 6.7.1 Normalization
- [ ] Normalize paths to NFC internally
- [ ] Handle NFD from macOS correctly
- [ ] Configure core.precomposeUnicode on macOS

### 6.7.2 Illegal Characters
- [ ] Validate filenames against Windows restrictions
- [ ] Check for reserved names (CON, PRN, etc.)
- [ ] Warn before clone/checkout of invalid names
- [ ] Suggest valid rename alternatives

## 6.8 File Permissions

### 6.8.1 Configuration
- [ ] Set core.fileMode based on platform
- [ ] Track execute bit in index

### 6.8.2 UI
- [ ] Show file mode in file list
- [ ] Allow toggle of executable flag
- [ ] Detect executable files by shebang/extension

## 6.9 File Watching

### 6.9.1 Platform-Specific
- [ ] Use appropriate watcher per platform
- [ ] Filter .git internal changes (except refs)
- [ ] Debounce rapid changes
- [ ] Handle watcher errors gracefully

### 6.9.2 Linux-Specific
- [ ] Check inotify limits on startup
- [ ] Warn if limits too low
- [ ] Provide fix command for limits

## 6.10 Cross-Platform Testing Requirements

### 6.10.1 CI Matrix
- [ ] Windows latest
- [ ] macOS latest
- [ ] Ubuntu latest
- [ ] Windows with long paths enabled
- [ ] macOS with case-sensitive APFS (disk image)

### 6.10.2 Test Scenarios
- [ ] Case conflict scenarios
- [ ] Line ending normalization
- [ ] Symlink creation and fallback
- [ ] Long path operations
- [ ] File locking and retry
- [ ] Unicode filename handling

---

# 7. User Interface Components

## 7.1 Main Window Layout

### 7.1.1 Window Chrome
- [ ] Custom title bar (optional, platform-dependent)
- [ ] Native title bar option
- [ ] Window controls (minimize, maximize, close)
- [ ] Window state persistence (size, position, maximized)
- [ ] Multi-monitor support
- [ ] Window snapping support
- [ ] Full-screen mode
- [ ] Tab bar for multiple repositories

### 7.1.2 Main Layout Structure
```
┌─────────────────────────────────────────────────────────────────┐
│                         TOOLBAR                                  │
├──────────┬──────────────────────────────────┬───────────────────┤
│          │                                   │                   │
│   LEFT   │         CENTER (GRAPH)           │      RIGHT        │
│  PANEL   │                                   │      PANEL        │
│          │                                   │                   │
│          ├──────────────────────────────────┤                   │
│          │      BOTTOM PANEL (DIFF/COMMIT)  │                   │
│          │                                   │                   │
├──────────┴──────────────────────────────────┴───────────────────┤
│                        STATUS BAR                                │
└─────────────────────────────────────────────────────────────────┘
```

### 5.1.3 Panel System
- [ ] Resizable panels (drag dividers)
- [ ] Collapsible panels
- [ ] Panel size persistence
- [ ] Minimum panel sizes
- [ ] Double-click divider to reset
- [ ] Panel visibility toggles
- [ ] Panel layout presets
- [ ] Custom layout saving

## 5.2 Toolbar

### 5.2.1 Primary Actions
- [ ] Undo button
- [ ] Redo button
- [ ] Pull button
  - [ ] Pull dropdown (pull options)
  - [ ] Pull with rebase option
  - [ ] Pull specific branch
- [ ] Push button
  - [ ] Push dropdown (push options)
  - [ ] Force push (with confirmation)
  - [ ] Push to specific remote
  - [ ] Push tags
- [ ] Fetch button
  - [ ] Fetch all remotes
  - [ ] Fetch specific remote
  - [ ] Prune option
- [ ] Branch button
  - [ ] Create branch
  - [ ] Quick branch switcher
- [ ] Stash button
  - [ ] Stash changes
  - [ ] Stash dropdown (pop, apply, drop)
- [ ] Pop stash button
- [ ] Terminal button
- [ ] Settings button

### 5.2.2 Repository Info
- [ ] Current repository name
- [ ] Repository dropdown/switcher
- [ ] Current branch name with icon
- [ ] Branch ahead/behind indicators
- [ ] Sync status indicator
- [ ] Repository state indicator (merging, rebasing, etc.)

### 5.2.3 Search
- [ ] Global search bar
- [ ] Search filter dropdown
- [ ] Search history
- [ ] Search keyboard shortcut indicator

## 5.3 Left Panel

### 5.3.1 Local Section
- [ ] Expandable/collapsible section
- [ ] Local branches list
- [ ] Current branch indicator
- [ ] Branch context menu
- [ ] Branch filter/search
- [ ] Branch grouping (by folder/prefix)
- [ ] Create branch button
- [ ] Double-click to checkout
- [ ] Drag branch to merge
- [ ] Branch icons (current, tracking, etc.)

### 5.3.2 Remote Section
- [ ] Remote repositories list
- [ ] Expandable remote branches
- [ ] Remote branch context menu
- [ ] Add remote button
- [ ] Remote status indicators
- [ ] Fetch remote button
- [ ] Remove remote option
- [ ] Edit remote URL option

### 5.3.3 Tags Section
- [ ] Tags list (sorted by date or name)
- [ ] Tag search/filter
- [ ] Lightweight vs annotated tag indicator
- [ ] Tag context menu
- [ ] Create tag button
- [ ] Double-click to checkout tag
- [ ] Push tags option

### 5.3.4 Stashes Section
- [ ] Stashes list
- [ ] Stash preview on hover
- [ ] Stash context menu
  - [ ] Apply stash
  - [ ] Pop stash
  - [ ] Drop stash
  - [ ] Create branch from stash
- [ ] Stash count indicator
- [ ] Stash date/message display

### 5.3.5 Submodules Section
- [ ] Submodules list
- [ ] Submodule status indicators
- [ ] Update submodule option
- [ ] Initialize submodule option
- [ ] Open submodule in new tab
- [ ] Submodule context menu

### 5.3.6 Pull Requests Section
- [ ] Open PRs list
- [ ] PR status indicators
- [ ] Quick PR actions
- [ ] PR filters (mine, review requested, all)
- [ ] Create PR button

### 5.3.7 Issues Section (when integrated)
- [ ] Assigned issues list
- [ ] Issue status indicators
- [ ] Quick issue actions
- [ ] Create issue button

## 5.4 Right Panel (Commit Details)

### 5.4.1 Commit Information
- [ ] Commit SHA (full and short, click to copy)
- [ ] Commit message (subject and body)
- [ ] Author information
  - [ ] Author name
  - [ ] Author email
  - [ ] Author avatar (Gravatar or integration)
  - [ ] Author date
- [ ] Committer information (if different)
  - [ ] Committer name
  - [ ] Committer email
  - [ ] Committer date
- [ ] Parent commit(s) links
- [ ] Child commit(s) links
- [ ] GPG signature status
- [ ] Refs pointing to commit (branches, tags)

### 5.4.2 Changed Files List
- [ ] File tree view
- [ ] Flat list view
- [ ] Toggle between views
- [ ] File status icons (added, modified, deleted, renamed, copied)
- [ ] File path with syntax highlighting
- [ ] Lines added/removed indicators
- [ ] Click to view diff
- [ ] File context menu
  - [ ] Open file
  - [ ] Open in external editor
  - [ ] Copy file path
  - [ ] View file history
  - [ ] Blame file
  - [ ] Checkout file at this commit
- [ ] File search/filter
- [ ] Show/hide file extensions
- [ ] Sort options (name, status, path)

### 5.4.3 Commit Actions
- [ ] Cherry-pick commit
- [ ] Revert commit
- [ ] Create branch from commit
- [ ] Create tag on commit
- [ ] Reset to commit (soft, mixed, hard)
- [ ] Checkout commit (detached HEAD)
- [ ] Copy commit SHA
- [ ] Copy commit message
- [ ] Open in web (GitHub, GitLab, etc.)
- [ ] Email patch

## 5.5 Bottom Panel

### 5.5.1 Diff View
- [ ] Split diff view (side-by-side)
- [ ] Unified diff view
- [ ] Toggle between views
- [ ] Syntax highlighting
- [ ] Line numbers
- [ ] Diff gutter (added/removed indicators)
- [ ] Inline blame option
- [ ] Word-level diff highlighting
- [ ] Character-level diff highlighting
- [ ] Diff navigation (next/previous hunk)
- [ ] Hunk staging (for staging area)
- [ ] Line staging (for staging area)
- [ ] Expand/collapse context
- [ ] Change context lines count
- [ ] Ignore whitespace option
- [ ] Ignore blank lines option
- [ ] Show/hide unchanged regions
- [ ] Binary file handling
- [ ] Image diff (for image files)
  - [ ] Side-by-side comparison
  - [ ] Onion skin
  - [ ] Swipe comparison
  - [ ] Difference highlighting
- [ ] Large file handling
- [ ] Copy diff to clipboard
- [ ] File header with file info

### 5.5.2 Commit/Staging Panel
- [ ] Unstaged changes section
  - [ ] File list
  - [ ] Stage all button
  - [ ] Discard all button
  - [ ] File context menu
  - [ ] Drag to stage
- [ ] Staged changes section
  - [ ] File list
  - [ ] Unstage all button
  - [ ] File context menu
  - [ ] Drag to unstage
- [ ] Commit message input
  - [ ] Subject line (with character counter)
  - [ ] Body text area
  - [ ] Markdown preview option
  - [ ] Message templates
  - [ ] Recent messages dropdown
  - [ ] Co-authors input
  - [ ] Conventional commit helpers
- [ ] Commit options
  - [ ] Amend previous commit checkbox
  - [ ] Sign commit checkbox (GPG)
  - [ ] Allow empty commit checkbox
- [ ] Commit button
- [ ] Commit and push button
- [ ] WIP (Work in Progress) quick commit

### 5.5.3 Terminal Panel
- [ ] Integrated terminal emulator
- [ ] Multiple terminal tabs
- [ ] Terminal themes
- [ ] Copy/paste support
- [ ] Clear terminal
- [ ] Kill process
- [ ] Auto-open on git command

## 5.6 Status Bar

### 5.6.1 Left Section
- [ ] Branch name
- [ ] Branch sync status (ahead/behind)
- [ ] Repository state
- [ ] Last fetch time

### 5.6.2 Center Section
- [ ] Background operations progress
- [ ] Operation status messages

### 5.6.3 Right Section
- [ ] Line ending indicator (LF/CRLF)
- [ ] Encoding indicator
- [ ] File count (modified/staged)
- [ ] Integration status
- [ ] Notifications indicator

---

# 8. Graph Visualization System

> **Technical Decisions**: See Section 4.2 for detailed architecture decisions.

## 8.1 Graph Rendering Engine

### 8.1.1 Architecture (Hybrid Canvas + DOM)
- [ ] Canvas layer for commit nodes and branch lines
- [ ] DOM layer (Lit) for labels, tooltips, context menus
- [ ] WebGL upgrade path for 500K+ commit repos
- [ ] Virtual scrolling with overscan buffer
- [ ] Spatial index for O(1) hit testing
- [ ] Layout computed in Rust backend

### 8.1.2 Performance Targets
- [ ] 60fps scrolling at 100K commits
- [ ] Initial render < 500ms for 10K commits
- [ ] Click-to-select < 50ms latency
- [ ] Memory < 500MB for 100K commits

### 8.1.3 Core Rendering
- [ ] Canvas-based rendering (WebGL optional upgrade)
- [ ] Virtual scrolling for performance
- [ ] Lazy loading of commit data
- [ ] Smooth 60fps scrolling
- [ ] Zoom support
- [ ] High DPI / Retina support
- [ ] Hardware acceleration
- [ ] Tile caching for rendered regions

### 8.1.4 Graph Layout Algorithm (Git-Optimized)
- [ ] First-parent chain as "main line" (lane 0)
- [ ] Spawn lanes for side branches
- [ ] Merge lanes when branches merge
- [ ] O(n) complexity, deterministic output
- [ ] Consistent branch positioning
- [ ] Octopus merge support
- [ ] Branch color assignment
- [ ] Color persistence for branches
- [ ] Layout caching with invalidation

### 8.1.5 Graph Elements
- [ ] Commit nodes
  - [ ] Circle/dot representation
  - [ ] Color based on branch
  - [ ] Selection highlight
  - [ ] Hover state
  - [ ] Multi-select support
- [ ] Branch lines
  - [ ] Curved bezier connections
  - [ ] Straight line option
  - [ ] Branch colors
  - [ ] Line thickness options
- [ ] Merge points
  - [ ] Visual merge indicators
  - [ ] Multiple parent visualization
- [ ] Branch labels (DOM layer)
  - [ ] Local branch labels
  - [ ] Remote branch labels
  - [ ] Tag labels
  - [ ] HEAD indicator
  - [ ] Label grouping when crowded
  - [ ] Accessible via keyboard

### 8.1.6 Graph Columns
- [ ] Graph column (canvas)
- [ ] Commit message column (DOM)
  - [ ] Subject line display
  - [ ] Truncation with ellipsis
  - [ ] Full message tooltip
- [ ] Author column
  - [ ] Author name
  - [ ] Author avatar
- [ ] Date/Time column
  - [ ] Relative time (2 hours ago)
  - [ ] Absolute time
  - [ ] Toggle between formats
- [ ] SHA column
  - [ ] Short SHA display
  - [ ] Click to copy
- [ ] Refs column
  - [ ] Branch badges
  - [ ] Tag badges
  - [ ] Remote tracking badges
- [ ] Column customization
  - [ ] Show/hide columns
  - [ ] Reorder columns
  - [ ] Resize columns
  - [ ] Column width persistence

## 8.2 Graph Interactions

### 8.2.1 Navigation
- [ ] Scroll to commit
- [ ] Scroll to branch
- [ ] Scroll to tag
- [ ] Scroll to HEAD
- [ ] Keyboard navigation (up/down)
- [ ] Page up/down support
- [ ] Home/End support
- [ ] Search result navigation

### 8.2.2 Selection
- [ ] Single commit selection
- [ ] Multi-commit selection (Ctrl+click)
- [ ] Range selection (Shift+click)
- [ ] Select all visible
- [ ] Selection persistence

### 8.2.3 Context Menu
- [ ] Commit context menu
  - [ ] All commit actions
  - [ ] Branch creation
  - [ ] Tag creation
  - [ ] Reset options
  - [ ] Revert/cherry-pick
- [ ] Branch label context menu
  - [ ] Checkout
  - [ ] Merge into current
  - [ ] Rebase onto
  - [ ] Delete
  - [ ] Rename
  - [ ] Push
  - [ ] Pull
- [ ] Tag label context menu
  - [ ] Checkout
  - [ ] Delete
  - [ ] Push
- [ ] Multi-select context menu
  - [ ] Squash commits
  - [ ] Create patch
  - [ ] Cherry-pick range

### 8.2.4 Drag and Drop
- [ ] Drag branch to commit (checkout)
- [ ] Drag branch to branch (merge)
- [ ] Drag commit to branch (cherry-pick)
- [ ] Drag tag to commit (move tag)
- [ ] Visual feedback during drag
- [ ] Drop zone highlighting

## 8.3 Graph Filtering

### 8.3.1 Branch Filtering
- [ ] Show current branch only
- [ ] Show selected branches only
- [ ] Hide merged branches
- [ ] First parent only (--first-parent)
- [ ] Include remote branches toggle

### 8.3.2 Author Filtering
- [ ] Filter by author name
- [ ] Filter by author email
- [ ] Multiple author selection
- [ ] Author autocomplete

### 8.3.3 Date Filtering
- [ ] After date
- [ ] Before date
- [ ] Date range
- [ ] Relative date presets (last week, last month, etc.)

### 8.3.4 Path Filtering
- [ ] Filter by file path
- [ ] Filter by directory
- [ ] Multiple path selection
- [ ] Path autocomplete

### 8.3.5 Message Filtering
- [ ] Search in commit messages
- [ ] Regex support
- [ ] Case sensitivity toggle

### 8.3.6 Advanced Filtering
- [ ] Combine multiple filters
- [ ] Save filter presets
- [ ] Quick filter toggle
- [ ] Clear all filters

---

# 9. Repository Management

## 7.1 Recent Repositories

### 7.1.1 Repository List
- [ ] Recently opened repositories
- [ ] Last opened time
- [ ] Repository path
- [ ] Repository name
- [ ] Quick open on click
- [ ] Remove from list option
- [ ] Clear all recent
- [ ] Pin favorite repositories
- [ ] Repository groups/folders
- [ ] Repository status preview

### 7.1.2 Repository Scanning
- [ ] Scan directory for repositories
- [ ] Recursive scanning
- [ ] Add all found repositories
- [ ] Ignore list for scanning

## 7.2 Repository Tabs

### 7.2.1 Tab Management
- [ ] Open repository in new tab
- [ ] Tab drag reordering
- [ ] Tab close button
- [ ] Close other tabs
- [ ] Close tabs to the right
- [ ] Tab context menu
- [ ] Tab overflow handling
- [ ] Tab tooltips (full path)
- [ ] Unsaved changes indicator
- [ ] Tab state persistence
- [ ] Restore tabs on restart

### 7.2.2 Tab Features
- [ ] Rename tab (custom name)
- [ ] Tab color coding
- [ ] Pin tab
- [ ] Duplicate tab
- [ ] Move tab to new window

## 7.3 Workspaces

### 7.3.1 Workspace Features
- [ ] Group related repositories
- [ ] Workspace-wide operations
  - [ ] Fetch all
  - [ ] Pull all
  - [ ] Status overview
- [ ] Cross-repository search
- [ ] Workspace file
- [ ] Share workspace configuration
- [ ] Workspace presets

---

# 10. Branch Management

## 8.1 Branch Operations

### 8.1.1 Create Branch
- [ ] Create from current HEAD
- [ ] Create from specific commit
- [ ] Create from existing branch
- [ ] Create from tag
- [ ] Create from remote branch
- [ ] Auto-checkout after create option
- [ ] Branch name validation
- [ ] Branch name suggestions
- [ ] Create and push option

### 8.1.2 Checkout Branch
- [ ] Checkout local branch
- [ ] Checkout remote branch (create tracking)
- [ ] Checkout tag (detached HEAD warning)
- [ ] Checkout commit (detached HEAD warning)
- [ ] Handle uncommitted changes
  - [ ] Stash and checkout
  - [ ] Discard and checkout
  - [ ] Abort checkout
  - [ ] Bring changes to new branch
- [ ] Force checkout option

### 8.1.3 Delete Branch
- [ ] Delete local branch
- [ ] Delete remote branch
- [ ] Delete merged branches only
- [ ] Force delete unmerged branch (with warning)
- [ ] Bulk delete branches
- [ ] Delete confirmation dialog
- [ ] Protect certain branches from deletion

### 8.1.4 Rename Branch
- [ ] Rename local branch
- [ ] Update remote tracking (delete old, push new)
- [ ] Update local references
- [ ] Rename validation

### 8.1.5 Branch Tracking
- [ ] Set upstream branch
- [ ] Unset upstream branch
- [ ] Change upstream branch
- [ ] Track remote branch
- [ ] View tracking relationship

## 8.2 Branch Comparison

### 8.2.1 Compare Branches
- [ ] Select two branches to compare
- [ ] Show commits unique to each
- [ ] Show common ancestor
- [ ] Show diff between branches
- [ ] Show file differences
- [ ] Ahead/behind count

### 8.2.2 Branch History
- [ ] View branch creation point
- [ ] View branch merge history
- [ ] View branch activity timeline

---

# 11. Commit Operations

## 9.1 Creating Commits

### 9.1.1 Basic Commit
- [ ] Stage files
- [ ] Enter commit message
- [ ] Create commit
- [ ] Commit hooks execution
- [ ] Commit validation
- [ ] Empty commit prevention (unless forced)

### 9.1.2 Advanced Commit Options
- [ ] Amend last commit
- [ ] Amend with message edit
- [ ] Amend without message edit
- [ ] GPG sign commit
- [ ] Add co-authors
- [ ] Set author (override)
- [ ] Set date (override)
- [ ] Allow empty commit

### 9.1.3 Commit Message
- [ ] Subject line (50 char recommendation)
- [ ] Body (72 char wrap recommendation)
- [ ] Message templates
  - [ ] Repository templates
  - [ ] Global templates
  - [ ] Custom templates
- [ ] Commit message history
- [ ] Message validation
- [ ] Conventional commits support
  - [ ] Type prefix (feat, fix, docs, etc.)
  - [ ] Scope
  - [ ] Breaking change indicator
  - [ ] Issue reference
- [ ] Spell check (optional)
- [ ] Message preview

### 9.1.4 Commit Templates
- [ ] Load .gitmessage template
- [ ] Custom template management
- [ ] Template variables
- [ ] Branch name insertion
- [ ] Issue number insertion

## 9.2 Modifying Commits

### 9.2.1 Amend Commit
- [ ] Amend staged changes to last commit
- [ ] Amend commit message only
- [ ] Warning if already pushed

### 9.2.2 Revert Commit
- [ ] Revert single commit
- [ ] Revert merge commit (select parent)
- [ ] Revert range of commits
- [ ] No-commit revert option
- [ ] Edit revert message

### 9.2.3 Cherry-pick
- [ ] Cherry-pick single commit
- [ ] Cherry-pick range of commits
- [ ] Cherry-pick with message edit
- [ ] Cherry-pick without commit
- [ ] Handle conflicts
- [ ] Abort cherry-pick

### 9.2.4 Reset
- [ ] Soft reset (keep changes staged)
- [ ] Mixed reset (keep changes unstaged)
- [ ] Hard reset (discard changes)
- [ ] Reset to specific commit
- [ ] Reset single file
- [ ] Confirm destructive operations
- [ ] Show what will be affected

### 9.2.5 Fixup/Squash
- [ ] Create fixup commit
- [ ] Create squash commit
- [ ] Auto-squash with rebase

---

# 12. Staging & Working Directory

## 10.1 Staging Area

### 10.1.1 Stage Operations
- [ ] Stage single file
- [ ] Stage multiple files
- [ ] Stage all changes
- [ ] Stage by directory
- [ ] Stage by pattern/glob
- [ ] Stage renamed files
- [ ] Stage deleted files
- [ ] Stage intent to add (new files)

### 10.1.2 Partial Staging (Hunk Staging)
- [ ] Stage individual hunks
- [ ] Stage individual lines
- [ ] Split hunk and stage parts
- [ ] Interactive staging UI
- [ ] Preview staged changes
- [ ] Edit hunk before staging

### 10.1.3 Unstage Operations
- [ ] Unstage single file
- [ ] Unstage multiple files
- [ ] Unstage all
- [ ] Unstage hunks
- [ ] Unstage lines

## 10.2 Working Directory

### 10.2.1 Discard Changes
- [ ] Discard changes to single file
- [ ] Discard changes to multiple files
- [ ] Discard all changes
- [ ] Discard hunks
- [ ] Discard lines
- [ ] Confirmation dialogs
- [ ] Backup before discard option

### 10.2.2 File Operations
- [ ] Add new files
- [ ] Delete files
- [ ] Rename/move files
- [ ] View file in explorer
- [ ] Open file in editor
- [ ] Copy file path
- [ ] Ignore file (add to .gitignore)
- [ ] Assume unchanged
- [ ] Skip worktree

### 10.2.3 Status Display
- [ ] Modified files
- [ ] New/untracked files
- [ ] Deleted files
- [ ] Renamed files
- [ ] Copied files
- [ ] Conflicted files
- [ ] Ignored files (toggle visibility)
- [ ] Submodule changes
- [ ] LFS tracked files

---

# 13. Diff & Blame System

## 11.1 Diff Display

### 11.1.1 Diff Modes
- [ ] Split/side-by-side view
- [ ] Unified view
- [ ] Inline view
- [ ] Toggle between modes
- [ ] Mode persistence per repository

### 11.1.2 Diff Visualization
- [ ] Syntax highlighting (language detection)
- [ ] Line numbers (old and new)
- [ ] Added lines highlighting (green)
- [ ] Removed lines highlighting (red)
- [ ] Modified lines highlighting
- [ ] Changed word highlighting
- [ ] Changed character highlighting
- [ ] Whitespace visualization
- [ ] Tab/space indicators

### 11.1.3 Diff Navigation
- [ ] Next/previous change
- [ ] Next/previous file
- [ ] Jump to line number
- [ ] Go to specific hunk
- [ ] Keyboard navigation
- [ ] Change overview scrollbar

### 11.1.4 Diff Options
- [ ] Ignore whitespace changes
- [ ] Ignore all whitespace
- [ ] Ignore blank lines
- [ ] Ignore line endings
- [ ] Context lines (default 3)
- [ ] Show/hide unchanged regions
- [ ] Word wrap
- [ ] Font size adjustment

### 11.1.5 Diff Actions
- [ ] Copy diff to clipboard
- [ ] Copy file content (old or new)
- [ ] Stage/unstage from diff view
- [ ] Discard changes from diff view
- [ ] Edit file from diff view
- [ ] Create patch from diff
- [ ] Apply patch

### 11.1.6 Special File Handling
- [ ] Binary file indication
- [ ] Image diff
  - [ ] 2-up comparison
  - [ ] Swipe comparison
  - [ ] Onion skin
  - [ ] Difference highlighting
  - [ ] Metadata display (dimensions, size)
- [ ] PDF diff (if possible)
- [ ] Large file handling
  - [ ] Warning for large files
  - [ ] Truncation with option to load more
  - [ ] Performance optimization

## 11.2 Blame View

### 11.2.1 Blame Display
- [ ] Line-by-line blame annotation
- [ ] Commit SHA (short)
- [ ] Author name
- [ ] Date/time
- [ ] Commit message preview
- [ ] Color coding by recency
- [ ] Color coding by author

### 11.2.2 Blame Navigation
- [ ] Click commit to view details
- [ ] Navigate to parent commit (blame at previous version)
- [ ] Navigate to child commit
- [ ] View file at blamed commit
- [ ] Copy commit SHA

### 11.2.3 Blame Options
- [ ] Ignore whitespace
- [ ] Detect moved lines (-M)
- [ ] Detect copied lines (-C)
- [ ] Ignore revisions file
- [ ] Show line age

---

# 14. Merge & Conflict Resolution

## 12.1 Merge Operations

### 12.1.1 Basic Merge
- [ ] Merge branch into current
- [ ] Fast-forward merge
- [ ] No fast-forward (--no-ff)
- [ ] Fast-forward only (--ff-only)
- [ ] Squash merge
- [ ] Custom merge message
- [ ] Abort merge

### 12.1.2 Merge Preview
- [ ] Preview merge result
- [ ] Show potential conflicts
- [ ] Show files that will change
- [ ] Show commit graph preview

### 12.1.3 Merge Strategies
- [ ] Recursive (default)
- [ ] Resolve
- [ ] Ours
- [ ] Theirs
- [ ] Octopus
- [ ] Subtree

### 12.1.4 Merge Options
- [ ] --no-commit
- [ ] --no-edit
- [ ] --allow-unrelated-histories
- [ ] -X ignore-space-change
- [ ] -X ignore-all-space
- [ ] -X patience
- [ ] -X rename-threshold

## 12.2 Conflict Resolution

### 12.2.1 Conflict Detection
- [ ] List all conflicted files
- [ ] Show conflict markers
- [ ] Conflict status in file tree
- [ ] Conflict count badge

### 12.2.2 Conflict Resolution UI
- [ ] Three-way merge view
  - [ ] Base version (center/ancestor)
  - [ ] Ours version (left/current)
  - [ ] Theirs version (right/incoming)
  - [ ] Result version (bottom)
- [ ] Conflict highlighting
- [ ] Take ours button
- [ ] Take theirs button
- [ ] Take both button
- [ ] Manual editing
- [ ] Previous/next conflict navigation
- [ ] Mark as resolved
- [ ] Mark all as resolved

### 12.2.3 Conflict Tools
- [ ] Built-in merge tool
- [ ] External merge tool integration
  - [ ] VS Code
  - [ ] Sublime Merge
  - [ ] Beyond Compare
  - [ ] Meld
  - [ ] KDiff3
  - [ ] P4Merge
  - [ ] Custom tool configuration
- [ ] Auto-resolve simple conflicts
- [ ] Conflict history (if same conflict resolved before)

### 12.2.4 Post-Conflict
- [ ] Stage resolved files
- [ ] Complete merge commit
- [ ] Abort and return to previous state
- [ ] Conflict resolution summary

---

# 15. Rebase Operations

> **Implementation Note**: Basic rebase uses libgit2. Interactive rebase requires CLI fallback using GIT_SEQUENCE_EDITOR bypass. See Section 4.3 for details.

## 15.1 Standard Rebase (libgit2)

### 15.1.1 Basic Rebase
- [ ] Rebase current branch onto another
- [ ] Rebase onto specific commit
- [ ] Rebase onto remote branch
- [ ] Continue rebase
- [ ] Skip commit
- [ ] Abort rebase

### 13.1.2 Rebase Options
- [ ] --onto support
- [ ] Preserve merges (--rebase-merges)
- [ ] Autostash (--autostash)
- [ ] Autosquash (--autosquash)
- [ ] --no-verify (skip hooks)
- [ ] GPG sign rebased commits

### 13.1.3 Rebase Conflict Resolution
- [ ] Show current rebase progress (1 of N)
- [ ] Current commit being applied
- [ ] Conflict resolution (same as merge)
- [ ] Mark resolved and continue
- [ ] Edit commit during rebase

## 15.2 Interactive Rebase (CLI Fallback)

> Uses git CLI with GIT_SEQUENCE_EDITOR set to bypass editor. Todo list generated by UI.

### 15.2.1 Interactive Rebase UI
- [ ] Visual rebase editor
- [ ] Drag-and-drop commit reordering
- [ ] Commit action selection
  - [ ] Pick
  - [ ] Reword
  - [ ] Edit
  - [ ] Squash
  - [ ] Fixup
  - [ ] Drop
  - [ ] Exec (run command)
  - [ ] Break (pause for amending)
- [ ] Commit preview
- [ ] Batch action application
- [ ] Start interactive rebase
- [ ] Validate rebase plan

### 13.2.2 Interactive Rebase Actions
- [ ] Squash commits
- [ ] Reorder commits
- [ ] Edit commit message (reword)
- [ ] Split commit
- [ ] Combine non-adjacent commits
- [ ] Remove commits
- [ ] Insert commands between commits

### 13.2.3 Interactive Rebase Progress
- [ ] Current step indicator
- [ ] Pause at each step option
- [ ] Manual intervention at edit points
- [ ] Continue after edit
- [ ] Abort at any point

---

# 16. Stash Management

## 14.1 Stash Operations

### 14.1.1 Create Stash
- [ ] Stash all changes
- [ ] Stash staged changes only
- [ ] Stash with message
- [ ] Stash including untracked files
- [ ] Stash including ignored files
- [ ] Keep index (stash but leave staged)
- [ ] Partial stash (selected files)

### 14.1.2 Apply Stash
- [ ] Apply stash (keep stash)
- [ ] Pop stash (remove after apply)
- [ ] Apply specific stash by index
- [ ] Apply to different branch
- [ ] Handle conflicts on apply
- [ ] Apply index separately

### 14.1.3 Manage Stashes
- [ ] View stash list
- [ ] View stash contents (diff)
- [ ] Drop stash
- [ ] Drop all stashes
- [ ] Create branch from stash
- [ ] Rename stash message

## 14.2 Stash UI

### 14.2.1 Stash List View
- [ ] Stash index
- [ ] Stash message
- [ ] Branch stashed from
- [ ] Date created
- [ ] Files count
- [ ] Quick actions (apply, pop, drop)

### 14.2.2 Stash Detail View
- [ ] Changed files list
- [ ] Diff view for each file
- [ ] Untracked files (if stashed)
- [ ] Staged vs unstaged indication

---

# 17. Remote Operations

## 15.1 Remote Management

### 15.1.1 Add Remote
- [ ] Add remote by URL
- [ ] HTTPS URL
- [ ] SSH URL
- [ ] Local path
- [ ] Validate URL format
- [ ] Test connection
- [ ] Set as default upstream

### 15.1.2 Edit Remote
- [ ] Rename remote
- [ ] Change URL
- [ ] Change fetch URL separately
- [ ] Change push URL separately
- [ ] Change default branch

### 15.1.3 Remove Remote
- [ ] Remove remote
- [ ] Clean up tracking branches
- [ ] Confirmation dialog

## 15.2 Fetch Operations

### 15.2.1 Fetch
- [ ] Fetch from specific remote
- [ ] Fetch all remotes
- [ ] Fetch with prune
- [ ] Fetch tags
- [ ] Fetch specific branch
- [ ] Background fetch (periodic)
- [ ] Fetch progress indication

### 15.2.2 Fetch Configuration
- [ ] Auto-fetch interval
- [ ] Auto-fetch on repository open
- [ ] Prune on fetch by default
- [ ] Fetch tags by default

## 15.3 Pull Operations

### 15.3.1 Pull
- [ ] Pull from tracking branch
- [ ] Pull from specific remote/branch
- [ ] Pull with merge (default)
- [ ] Pull with rebase
- [ ] Pull with rebase and preserve merges
- [ ] Pull with stash (auto-stash)
- [ ] Pull --ff-only
- [ ] Pull progress indication

### 15.3.2 Pull Configuration
- [ ] Default pull behavior (merge/rebase)
- [ ] Auto-stash on pull
- [ ] Prune on pull

### 15.3.3 Pull Conflicts
- [ ] Detect incoming conflicts
- [ ] Resolve merge conflicts
- [ ] Resolve rebase conflicts
- [ ] Abort pull

## 15.4 Push Operations

### 15.4.1 Push
- [ ] Push current branch
- [ ] Push to tracking branch
- [ ] Push to specific remote/branch
- [ ] Push all branches
- [ ] Push tags
- [ ] Push single tag
- [ ] Set upstream on push
- [ ] Push progress indication

### 15.4.2 Force Push
- [ ] Force push (--force)
- [ ] Force with lease (--force-with-lease)
- [ ] Confirmation dialog
- [ ] Warning about consequences

### 15.4.3 Push Configuration
- [ ] Default push behavior
- [ ] Push tags by default
- [ ] Verify before force push

### 15.4.4 Push Errors
- [ ] Handle rejected pushes
- [ ] Non-fast-forward detection
- [ ] Suggest pull/force push

---

# 18. Tag Management

## 16.1 Tag Operations

### 16.1.1 Create Tag
- [ ] Lightweight tag
- [ ] Annotated tag
- [ ] Tag message input
- [ ] Tag on current HEAD
- [ ] Tag on specific commit
- [ ] Tag on branch
- [ ] GPG sign tag
- [ ] Tag name validation

### 16.1.2 Delete Tag
- [ ] Delete local tag
- [ ] Delete remote tag
- [ ] Confirmation dialog
- [ ] Bulk delete

### 16.1.3 Push Tags
- [ ] Push single tag
- [ ] Push all tags
- [ ] Push tags with commits

### 16.1.4 Checkout Tag
- [ ] Checkout tag (detached HEAD)
- [ ] Create branch from tag

## 16.2 Tag Display

### 16.2.1 Tag List
- [ ] Sort by name
- [ ] Sort by date
- [ ] Filter/search tags
- [ ] Tag type indicator (lightweight/annotated)
- [ ] Tag message preview
- [ ] Associated commit info

### 16.2.2 Tag Details
- [ ] Tag name
- [ ] Tag message (if annotated)
- [ ] Tagger info (if annotated)
- [ ] Tagged commit
- [ ] GPG signature status

---

# 19. Submodule Support

## 17.1 Submodule Operations

### 17.1.1 Add Submodule
- [ ] Add submodule by URL
- [ ] Set submodule path
- [ ] Set submodule branch
- [ ] Initialize after add
- [ ] Clone recursive option

### 17.1.2 Initialize Submodule
- [ ] Initialize single submodule
- [ ] Initialize all submodules
- [ ] Recursive initialization

### 17.1.3 Update Submodule
- [ ] Update single submodule
- [ ] Update all submodules
- [ ] Recursive update
- [ ] Update to specific commit
- [ ] Update to tracked branch
- [ ] Remote update (--remote)
- [ ] Merge update
- [ ] Rebase update

### 17.1.4 Remove Submodule
- [ ] Deinit submodule
- [ ] Remove from .gitmodules
- [ ] Remove from .git/config
- [ ] Remove submodule directory
- [ ] Clean up completely

### 17.1.5 Sync Submodule
- [ ] Sync URL from .gitmodules
- [ ] Sync all submodules

## 17.2 Submodule Display

### 17.2.1 Submodule List
- [ ] Submodule name
- [ ] Submodule path
- [ ] Current commit SHA
- [ ] Tracking branch
- [ ] Status (initialized, not initialized, modified, new commits)
- [ ] Ahead/behind tracking branch

### 17.2.2 Submodule Actions
- [ ] Open submodule in new tab
- [ ] View submodule changes
- [ ] Stage submodule update
- [ ] Checkout specific commit in submodule
- [ ] Fetch in submodule

---

# 20. Git LFS Support

> **Implementation Note**: Git LFS is NOT supported by libgit2. All LFS operations use git-lfs CLI wrapper. See Section 4.3 for details.

## 20.1 LFS Prerequisites

### 20.1.1 Detection
- [ ] Check if git-lfs is installed on startup
- [ ] Detect LFS-enabled repositories (.gitattributes with filter=lfs)
- [ ] Show warning if git-lfs not installed but repo uses LFS
- [ ] Provide installation instructions per platform

### 20.1.2 CLI Wrapper
- [ ] LfsManager service wrapping git-lfs commands
- [ ] Progress parsing from git-lfs output
- [ ] Error handling and user-friendly messages
- [ ] Timeout handling for large transfers

## 20.2 LFS Operations

### 20.2.1 Setup
- [ ] Initialize LFS in repository (git lfs install)
- [ ] Track file patterns (git lfs track)
- [ ] Untrack file patterns (git lfs untrack)
- [ ] View tracked patterns
- [ ] Migrate existing files to LFS (git lfs migrate)

### 20.2.2 LFS Status
- [ ] List LFS tracked files (git lfs ls-files)
- [ ] Show LFS file sizes
- [ ] Identify LFS pointer files
- [ ] LFS storage usage

### 20.2.3 LFS Transfer
- [ ] Fetch LFS objects (git lfs fetch)
- [ ] Pull LFS objects (git lfs pull)
- [ ] Push LFS objects (git lfs push) - BEFORE regular push
- [ ] Transfer progress indication
- [ ] Batch transfer support

### 20.2.4 LFS Management
- [ ] Prune old LFS objects (git lfs prune)
- [ ] Lock files (git lfs lock)
- [ ] Unlock files (git lfs unlock)
- [ ] View locked files (git lfs locks)
- [ ] Verify LFS objects (git lfs fsck)

## 20.3 LFS Display

### 20.3.1 LFS Indicator
- [ ] LFS icon on tracked files
- [ ] Pointer file vs actual file indication
- [ ] File size (pointer vs actual)

### 20.3.2 LFS Configuration UI
- [ ] Add track patterns
- [ ] Remove track patterns
- [ ] View .gitattributes
- [ ] LFS server configuration

## 20.4 Clone/Checkout Integration

### 20.4.1 Post-Clone
- [ ] Detect LFS after clone completes
- [ ] Automatically run git lfs fetch
- [ ] Automatically run git lfs checkout
- [ ] Show progress during LFS hydration

### 20.4.2 Pre-Push
- [ ] Detect LFS files in commits to push
- [ ] Run git lfs push before regular push
- [ ] Handle LFS push failures

---

# 21. Git Hooks

> **Implementation Note**: libgit2 does NOT execute hooks. All hooks are manually invoked before/after operations. See Section 4.3 for details.

## 21.1 Hook Execution Engine

### 21.1.1 Manual Invocation
- [ ] HooksManager service for invoking hooks
- [ ] Find hook in .git/hooks/
- [ ] Check hook is executable (Unix) or has shebang/extension (Windows)
- [ ] Execute hook with appropriate arguments
- [ ] Capture stdout/stderr output
- [ ] Handle hook exit codes

### 21.1.2 Integration Points
- [ ] pre-commit: before commit creation
- [ ] commit-msg: with temp message file path
- [ ] post-commit: after successful commit (non-blocking)
- [ ] pre-push: before push with remote info
- [ ] pre-rebase: before rebase operations
- [ ] post-checkout: after checkout (non-blocking)
- [ ] post-merge: after merge (non-blocking)

### 21.1.3 Hook Output Display
- [ ] Show hook output in dedicated panel
- [ ] Parse ANSI colors from hook output
- [ ] Show hook name and duration
- [ ] Clear distinction between stdout and stderr

## 21.2 Hook Management

### 21.2.1 View Hooks
- [ ] List all hooks
- [ ] Active vs inactive indication
- [ ] Hook file contents preview
- [ ] Sample hooks

### 21.2.2 Edit Hooks
- [ ] Edit hook in built-in editor
- [ ] Edit hook in external editor
- [ ] Enable/disable hooks (toggle executable bit)
- [ ] Create from template

### 21.2.3 Supported Hooks
- [ ] pre-commit
- [ ] prepare-commit-msg
- [ ] commit-msg
- [ ] post-commit
- [ ] pre-rebase
- [ ] post-checkout
- [ ] post-merge
- [ ] pre-push
- [ ] pre-receive (server)
- [ ] update (server)
- [ ] post-receive (server)
- [ ] post-update (server)
- [ ] pre-auto-gc
- [ ] post-rewrite

### 21.2.4 Hook Failure Handling
- [ ] Block operation on non-zero exit (for pre-* hooks)
- [ ] Show error message from hook
- [ ] Offer "skip hook" option (--no-verify equivalent)
- [ ] Hook timeout handling (configurable)

## 21.3 Hook Templates

### 21.3.1 Built-in Templates
- [ ] Conventional commit validator
- [ ] Branch name validator
- [ ] Lint runner
- [ ] Test runner
- [ ] Secret detection

### 21.3.2 Custom Templates
- [ ] Save custom templates
- [ ] Import templates
- [ ] Share templates

---

# 22. Gitflow Support

## 20.1 Gitflow Initialization

### 20.1.1 Initialize Gitflow
- [ ] Initialize in repository
- [ ] Configure branch names
  - [ ] Main/master branch
  - [ ] Develop branch
  - [ ] Feature prefix
  - [ ] Release prefix
  - [ ] Hotfix prefix
  - [ ] Support prefix
  - [ ] Version tag prefix
- [ ] Create initial branches
- [ ] Gitflow configuration persistence

## 20.2 Gitflow Operations

### 20.2.1 Feature Branches
- [ ] Start feature
- [ ] Finish feature
- [ ] Publish feature
- [ ] Pull feature
- [ ] Track feature
- [ ] Delete feature

### 20.2.2 Release Branches
- [ ] Start release
- [ ] Finish release
- [ ] Publish release
- [ ] Pull release
- [ ] Track release
- [ ] Delete release

### 20.2.3 Hotfix Branches
- [ ] Start hotfix
- [ ] Finish hotfix
- [ ] Publish hotfix
- [ ] Delete hotfix

### 20.2.4 Support Branches
- [ ] Start support
- [ ] Support branch management

## 20.3 Gitflow UI

### 20.3.1 Gitflow Panel
- [ ] Gitflow status indicator
- [ ] Current flow state
- [ ] Quick action buttons
- [ ] Branch categorization by flow type

### 20.3.2 Gitflow Visualization
- [ ] Color code branches by type
- [ ] Flow type labels
- [ ] Flow direction indicators

---

# 23. Search & Filter System

## 21.1 Commit Search

### 21.1.1 Search Criteria
- [ ] Search by commit message
- [ ] Search by author name
- [ ] Search by author email
- [ ] Search by committer
- [ ] Search by commit SHA
- [ ] Search by date range
- [ ] Search by file path
- [ ] Search by file content (diff search)
- [ ] Regex support
- [ ] Case sensitivity toggle

### 21.1.2 Search Options
- [ ] Search current branch only
- [ ] Search all branches
- [ ] Search all refs
- [ ] Include remotes
- [ ] First parent only
- [ ] Limit results

### 21.1.3 Search UI
- [ ] Search bar with filters
- [ ] Advanced search dialog
- [ ] Search results list
- [ ] Result preview
- [ ] Navigate to result
- [ ] Search history
- [ ] Saved searches

## 21.2 File Search

### 21.2.1 File Search Features
- [ ] Search file names
- [ ] Search file paths
- [ ] Search file contents
- [ ] Fuzzy matching
- [ ] Glob pattern support

### 21.2.2 File Search Results
- [ ] File name and path
- [ ] File type icon
- [ ] Quick actions (open, view history, blame)

## 21.3 Branch Search

### 21.3.1 Branch Filtering
- [ ] Filter by name
- [ ] Filter by author
- [ ] Filter by date
- [ ] Show merged only
- [ ] Show unmerged only
- [ ] Local vs remote

---

# 24. Integration Hub

## 22.1 GitHub Integration

### 22.1.1 Authentication
- [ ] OAuth authentication
- [ ] Personal access token
- [ ] GitHub Enterprise support
- [ ] Multiple account support
- [ ] Token permission management

### 22.1.2 Repository Features
- [ ] Clone from GitHub
- [ ] Create repository on GitHub
- [ ] Fork repository
- [ ] View repository on GitHub
- [ ] Repository settings
- [ ] Collaborators management

### 22.1.3 Pull Request Features
- [ ] Create pull request
- [ ] View pull requests
- [ ] Pull request details
  - [ ] Title and description
  - [ ] Reviewers
  - [ ] Labels
  - [ ] Milestone
  - [ ] Assignees
  - [ ] Linked issues
- [ ] Pull request actions
  - [ ] Edit PR
  - [ ] Close/reopen PR
  - [ ] Merge PR (merge, squash, rebase)
  - [ ] Request review
  - [ ] Approve/request changes
- [ ] Pull request comments
  - [ ] View comments
  - [ ] Add comments
  - [ ] Inline code comments
  - [ ] Reply to comments
- [ ] Pull request checks/status
- [ ] Draft pull requests

### 22.1.4 Issue Features
- [ ] View issues
- [ ] Create issues
- [ ] Edit issues
- [ ] Close/reopen issues
- [ ] Labels
- [ ] Assignees
- [ ] Milestones
- [ ] Link issues to commits

### 22.1.5 GitHub Actions
- [ ] View workflows
- [ ] View workflow runs
- [ ] Re-run workflows
- [ ] Cancel runs
- [ ] View logs

### 22.1.6 GitHub Gists
- [ ] Create gist from selection
- [ ] View gists
- [ ] Clone gist

## 22.2 GitLab Integration

### 22.2.1 Authentication
- [ ] OAuth authentication
- [ ] Personal access token
- [ ] GitLab Self-Managed support
- [ ] Multiple account support

### 22.2.2 Repository Features
- [ ] Clone from GitLab
- [ ] Create repository
- [ ] Fork repository
- [ ] View on GitLab

### 22.2.3 Merge Request Features
- [ ] Create merge request
- [ ] View merge requests
- [ ] MR details (similar to GitHub PR)
- [ ] MR actions
- [ ] MR comments
- [ ] MR pipelines

### 22.2.4 Issue Features
- [ ] View issues
- [ ] Create issues
- [ ] Edit issues
- [ ] Labels, assignees, milestones
- [ ] Boards support

### 22.2.5 CI/CD
- [ ] View pipelines
- [ ] View jobs
- [ ] Retry jobs
- [ ] Cancel jobs
- [ ] View logs

## 22.3 Bitbucket Integration

### 22.3.1 Authentication
- [ ] App password
- [ ] OAuth
- [ ] Bitbucket Server support

### 22.3.2 Repository Features
- [ ] Clone from Bitbucket
- [ ] Create repository
- [ ] Fork repository
- [ ] View on Bitbucket

### 22.3.3 Pull Request Features
- [ ] Create pull request
- [ ] View pull requests
- [ ] PR details and actions
- [ ] PR comments
- [ ] Merge PR

### 22.3.4 Issue Features (if enabled)
- [ ] View issues
- [ ] Create issues

### 22.3.5 Pipelines
- [ ] View pipelines
- [ ] View steps
- [ ] View logs

## 22.4 Azure DevOps Integration

### 22.4.1 Authentication
- [ ] Personal access token
- [ ] OAuth
- [ ] Azure DevOps Server support

### 22.4.2 Repository Features
- [ ] Clone from Azure
- [ ] Create repository
- [ ] View on Azure

### 22.4.3 Pull Request Features
- [ ] Create PR
- [ ] View PRs
- [ ] PR details and actions
- [ ] Code review
- [ ] Merge PR

### 22.4.4 Work Items
- [ ] View work items
- [ ] Link to commits
- [ ] Create work items

### 22.4.5 Pipelines
- [ ] View builds
- [ ] View releases
- [ ] Trigger builds

## 22.5 Jira Integration

### 22.5.1 Authentication
- [ ] API token
- [ ] OAuth
- [ ] Jira Server support

### 22.5.2 Issue Features
- [ ] View assigned issues
- [ ] View project issues
- [ ] Issue search
- [ ] Issue details
- [ ] Update issue status
- [ ] Log time
- [ ] Add comments
- [ ] Link commits to issues

### 22.5.3 Smart Commits
- [ ] Parse issue keys from commit messages
- [ ] Update issue status via commit
- [ ] Log time via commit

## 22.6 Trello Integration

### 22.6.1 Authentication
- [ ] API key + token
- [ ] OAuth

### 22.6.2 Board Features
- [ ] View boards
- [ ] View lists
- [ ] View cards
- [ ] Create cards
- [ ] Update cards
- [ ] Link commits to cards

## 22.7 Slack Integration

### 22.7.1 Notifications
- [ ] Push notifications
- [ ] PR notifications
- [ ] Build notifications
- [ ] Custom notifications

---

# 25. Pull Request Management

## 23.1 Pull Request Creation

### 23.1.1 Create PR UI
- [ ] Source branch selection
- [ ] Target branch selection
- [ ] Title input (auto-filled from commits)
- [ ] Description editor (Markdown)
- [ ] Template support
- [ ] Reviewers selection
- [ ] Assignees selection
- [ ] Labels selection
- [ ] Milestone selection
- [ ] Linked issues
- [ ] Draft PR option
- [ ] Create button

### 23.1.2 PR Preview
- [ ] Preview diff before creation
- [ ] Preview commits to include
- [ ] Check for conflicts
- [ ] Verify CI will pass

## 23.2 Pull Request List

### 23.2.1 PR List View
- [ ] Open PRs tab
- [ ] Closed PRs tab
- [ ] All PRs tab
- [ ] PR number
- [ ] PR title
- [ ] Author
- [ ] Status (open, closed, merged)
- [ ] Review status
- [ ] CI status
- [ ] Labels
- [ ] Updated date
- [ ] Comments count

### 23.2.2 PR Filtering
- [ ] Filter by author
- [ ] Filter by assignee
- [ ] Filter by reviewer
- [ ] Filter by label
- [ ] Filter by status
- [ ] Filter by branch

### 23.2.3 PR Sorting
- [ ] Sort by created date
- [ ] Sort by updated date
- [ ] Sort by comments
- [ ] Sort by review status

## 23.3 Pull Request Details

### 23.3.1 PR Information
- [ ] Title (editable)
- [ ] Description (editable, Markdown preview)
- [ ] Author info
- [ ] Created/updated dates
- [ ] Source/target branches
- [ ] Merge status
- [ ] Conflict status

### 23.3.2 PR Tabs
- [ ] Conversation tab
  - [ ] Timeline of events
  - [ ] Comments
  - [ ] Review comments
  - [ ] Status checks
- [ ] Commits tab
  - [ ] List of commits
  - [ ] Commit details
- [ ] Files changed tab
  - [ ] Diff view
  - [ ] File list
  - [ ] Inline commenting
- [ ] Checks tab
  - [ ] CI status
  - [ ] Check details
  - [ ] Re-run checks

### 23.3.3 PR Actions
- [ ] Edit PR
- [ ] Close PR
- [ ] Reopen PR
- [ ] Merge PR
  - [ ] Create merge commit
  - [ ] Squash and merge
  - [ ] Rebase and merge
- [ ] Delete branch after merge option
- [ ] Convert to draft
- [ ] Mark ready for review

### 23.3.4 Code Review
- [ ] Start review
- [ ] Add inline comments
- [ ] Add general comments
- [ ] Suggest changes
- [ ] Approve
- [ ] Request changes
- [ ] Comment only
- [ ] Submit review

---

# 26. Issue Tracking Integration

## 24.1 Issue List

### 24.1.1 Issue View
- [ ] Issue number/key
- [ ] Issue title
- [ ] Status
- [ ] Priority
- [ ] Assignee
- [ ] Labels/tags
- [ ] Created date
- [ ] Updated date

### 24.1.2 Issue Filtering
- [ ] Filter by status
- [ ] Filter by assignee
- [ ] Filter by label
- [ ] Filter by priority
- [ ] Filter by milestone/sprint
- [ ] Text search

## 24.2 Issue Details

### 24.2.1 Issue Information
- [ ] Title
- [ ] Description
- [ ] Status
- [ ] Assignee
- [ ] Reporter
- [ ] Labels
- [ ] Priority
- [ ] Milestone
- [ ] Due date
- [ ] Time tracking

### 24.2.2 Issue Actions
- [ ] Edit issue
- [ ] Change status
- [ ] Assign/unassign
- [ ] Add labels
- [ ] Add comment
- [ ] Link to commit
- [ ] Link to branch

## 24.3 Commit-Issue Linking

### 24.3.1 Auto-linking
- [ ] Detect issue keys in commit messages
- [ ] Create links automatically
- [ ] Show linked issues in commit details

### 24.3.2 Manual Linking
- [ ] Link commit to issue
- [ ] Link branch to issue
- [ ] Link PR to issue

---

# 27. Workspace Management

## 25.1 Workspace Features

### 25.1.1 Create Workspace
- [ ] Workspace name
- [ ] Add repositories
- [ ] Workspace settings
- [ ] Save workspace file

### 25.1.2 Workspace Operations
- [ ] Open workspace
- [ ] Add repository to workspace
- [ ] Remove repository from workspace
- [ ] Workspace-wide fetch
- [ ] Workspace-wide pull
- [ ] Workspace status overview

### 25.1.3 Workspace View
- [ ] All repositories status
- [ ] Quick repository switching
- [ ] Unified graph view (optional)
- [ ] Cross-repository search

## 25.2 Team Workspaces (Cloud-synced)

### 25.2.1 Team Features
- [ ] Create team workspace
- [ ] Invite team members
- [ ] Shared workspace settings
- [ ] Workspace permissions
- [ ] Activity feed

---

# 28. Profile & Account System

## 26.1 User Profile

### 26.1.1 Profile Settings
- [ ] Display name
- [ ] Email (for commits)
- [ ] Avatar
- [ ] Default branch preferences
- [ ] Default merge preferences

### 26.1.2 Git Identity
- [ ] Global Git user name
- [ ] Global Git email
- [ ] Per-repository overrides
- [ ] Multiple profiles

## 26.2 Integration Accounts

### 26.2.1 Account Management
- [ ] GitHub accounts
- [ ] GitLab accounts
- [ ] Bitbucket accounts
- [ ] Azure DevOps accounts
- [ ] Jira accounts
- [ ] Default account per service
- [ ] Account switching

## 26.3 Authentication

### 26.3.1 Credential Management
- [ ] HTTPS credentials (keychain/credential manager)
- [ ] SSH key management
  - [ ] Generate SSH key
  - [ ] Import SSH key
  - [ ] View SSH keys
  - [ ] Add key to agent
  - [ ] Copy public key
  - [ ] Upload to service
- [ ] GPG key management
  - [ ] Generate GPG key
  - [ ] Import GPG key
  - [ ] View GPG keys
  - [ ] Set signing key

---

# 29. Settings & Preferences

## 27.1 General Settings

### 27.1.1 Application
- [ ] Language selection
- [ ] Auto-start with system
- [ ] Check for updates automatically
- [ ] Send anonymous usage data
- [ ] Default repository path
- [ ] Max recent repositories

### 27.1.2 Default Behaviors
- [ ] Default clone protocol (HTTPS/SSH)
- [ ] Default pull behavior (merge/rebase)
- [ ] Default push behavior
- [ ] Auto-fetch interval
- [ ] Auto-stash before pull
- [ ] Prune on fetch

## 27.2 Editor Settings

### 27.2.1 Diff Settings
- [ ] Default diff view (split/unified)
- [ ] Context lines
- [ ] Ignore whitespace
- [ ] Word wrap in diff
- [ ] Show line numbers
- [ ] Highlight current line

### 27.2.2 Commit Settings
- [ ] Sign commits by default
- [ ] Default commit message template
- [ ] Spell check enabled
- [ ] Auto-wrap message at 72 chars
- [ ] Show commit guidelines

### 27.2.3 External Tools
- [ ] External diff tool
- [ ] External merge tool
- [ ] External editor
- [ ] Terminal emulator

## 27.3 UI Settings

### 27.3.1 Appearance
- [ ] Theme selection
- [ ] Font family
- [ ] Font size
- [ ] Line height
- [ ] Zoom level
- [ ] Toolbar position
- [ ] Status bar visibility

### 27.3.2 Graph Settings
- [ ] Branch color scheme
- [ ] Show avatars in graph
- [ ] Date format
- [ ] Relative vs absolute time
- [ ] Graph column width
- [ ] Commit density

### 27.3.3 Panel Settings
- [ ] Default panel layout
- [ ] Panel sizes
- [ ] Auto-hide panels

## 27.4 Repository-Specific Settings

### 27.4.1 Repository Settings
- [ ] Git identity override
- [ ] Auto-fetch for this repo
- [ ] Default remote
- [ ] Gitflow configuration
- [ ] Custom hooks
- [ ] Excluded files (local)

## 27.5 Keyboard Settings

### 27.5.1 Shortcuts
- [ ] View all shortcuts
- [ ] Customize shortcuts
- [ ] Reset to defaults
- [ ] Export shortcuts
- [ ] Import shortcuts

---

# 30. Theming System

## 28.1 Built-in Themes

### 28.1.1 Core Themes
- [ ] Light theme
- [ ] Dark theme
- [ ] High contrast light
- [ ] High contrast dark
- [ ] System theme (auto-switch)

### 28.1.2 Theme Elements
- [ ] Background colors
- [ ] Text colors
- [ ] Accent colors
- [ ] Border colors
- [ ] Graph colors
- [ ] Diff colors (added/removed/modified)
- [ ] Syntax highlighting colors

## 28.2 Custom Themes

### 28.2.1 Theme Editor
- [ ] Color picker for each element
- [ ] Live preview
- [ ] Save custom theme
- [ ] Export theme
- [ ] Import theme

### 28.2.2 Theme Marketplace (Future)
- [ ] Browse themes
- [ ] Download themes
- [ ] Rate themes
- [ ] Share themes

---

# 31. Keyboard Shortcuts

## 29.1 Global Shortcuts

### 29.1.1 Application
- [ ] `Ctrl/Cmd + N` - New repository
- [ ] `Ctrl/Cmd + O` - Open repository
- [ ] `Ctrl/Cmd + W` - Close tab
- [ ] `Ctrl/Cmd + Q` - Quit application
- [ ] `Ctrl/Cmd + ,` - Open settings
- [ ] `Ctrl/Cmd + Shift + P` - Command palette
- [ ] `F11` - Toggle full screen

### 29.1.2 Repository
- [ ] `Ctrl/Cmd + Shift + N` - New branch
- [ ] `Ctrl/Cmd + Shift + C` - Commit
- [ ] `Ctrl/Cmd + Shift + A` - Stage all
- [ ] `Ctrl/Cmd + Shift + Z` - Undo
- [ ] `Ctrl/Cmd + Shift + Y` - Redo

### 29.1.3 Navigation
- [ ] `Ctrl/Cmd + 1` - Focus graph
- [ ] `Ctrl/Cmd + 2` - Focus staging
- [ ] `Ctrl/Cmd + 3` - Focus diff
- [ ] `Ctrl/Cmd + Tab` - Next tab
- [ ] `Ctrl/Cmd + Shift + Tab` - Previous tab
- [ ] `Ctrl/Cmd + F` - Search
- [ ] `Ctrl/Cmd + G` - Go to commit

### 29.1.4 Git Operations
- [ ] `Ctrl/Cmd + Shift + F` - Fetch all
- [ ] `Ctrl/Cmd + Shift + L` - Pull
- [ ] `Ctrl/Cmd + Shift + U` - Push
- [ ] `Ctrl/Cmd + Shift + S` - Stash
- [ ] `Ctrl/Cmd + Shift + T` - Pop stash

### 29.1.5 Graph Navigation
- [ ] `↑/↓` - Navigate commits
- [ ] `Enter` - View commit details
- [ ] `Space` - Toggle commit selection
- [ ] `Home` - Go to HEAD
- [ ] `End` - Go to oldest commit

## 29.2 Context-Specific Shortcuts

### 29.2.1 Staging Area
- [ ] `S` - Stage file
- [ ] `U` - Unstage file
- [ ] `D` - Discard changes
- [ ] `Space` - Stage/unstage selection

### 29.2.2 Diff View
- [ ] `]` - Next hunk
- [ ] `[` - Previous hunk
- [ ] `S` - Stage hunk
- [ ] `U` - Unstage hunk

---

# 32. Notifications System

## 30.1 In-App Notifications

### 30.1.1 Notification Types
- [ ] Success notifications (commit complete, push successful)
- [ ] Error notifications (operation failed)
- [ ] Warning notifications (force push warning)
- [ ] Info notifications (fetch complete, new commits available)
- [ ] Progress notifications (clone progress, long operations)

### 30.1.2 Notification UI
- [ ] Toast notifications
- [ ] Notification center
- [ ] Notification history
- [ ] Click to navigate
- [ ] Dismiss notifications
- [ ] Clear all

### 30.1.3 Notification Settings
- [ ] Enable/disable notification types
- [ ] Notification duration
- [ ] Sound notifications

## 30.2 System Notifications

### 30.2.1 Desktop Notifications
- [ ] Background fetch notifications
- [ ] PR notifications
- [ ] CI status notifications
- [ ] Mention notifications

### 30.2.2 Notification Preferences
- [ ] Enable system notifications
- [ ] Notification types to show
- [ ] Do not disturb mode

---

# 33. Terminal Integration

## 31.1 Built-in Terminal

### 31.1.1 Terminal Features
- [ ] Full terminal emulator (xterm.js)
- [ ] Repository working directory
- [ ] Multiple terminal tabs
- [ ] Split terminals
- [ ] Terminal themes (follows app theme)
- [ ] Font customization
- [ ] Scrollback buffer

### 31.1.2 Shell Support
- [ ] System default shell
- [ ] Bash
- [ ] Zsh
- [ ] PowerShell
- [ ] Cmd
- [ ] Git Bash (Windows)
- [ ] Custom shell configuration

### 31.1.3 Terminal Integration
- [ ] Open terminal at repository
- [ ] Run git commands
- [ ] Command history
- [ ] Auto-complete git commands
- [ ] Recognize git state changes
- [ ] Refresh UI after terminal git commands

## 31.2 External Terminal

### 31.2.1 External Terminal Support
- [ ] Open in system terminal
- [ ] Configure preferred terminal
- [ ] Open at repository path
- [ ] iTerm2 integration (macOS)
- [ ] Windows Terminal integration
- [ ] Hyper integration

---

# 34. Editor Integration

## 32.1 External Editor Support

### 32.1.1 Supported Editors
- [ ] VS Code
- [ ] Visual Studio
- [ ] Sublime Text
- [ ] Atom
- [ ] IntelliJ IDEA / JetBrains IDEs
- [ ] Vim / Neovim
- [ ] Emacs
- [ ] Notepad++
- [ ] TextMate
- [ ] Custom editor configuration

### 32.1.2 Editor Actions
- [ ] Open file in editor
- [ ] Open repository in editor
- [ ] Open diff in editor
- [ ] Open commit message in editor
- [ ] Edit hook in editor

## 32.2 IDE Plugins (Future)

### 32.2.1 Plugin Features
- [ ] VS Code extension
- [ ] JetBrains plugin
- [ ] Sublime Text plugin
- [ ] Two-way sync with IDE

---

# 35. File History & Timeline

## 33.1 File History

### 33.1.1 History View
- [ ] Chronological commit list for file
- [ ] Commit message
- [ ] Author and date
- [ ] Lines changed
- [ ] Navigate to commit
- [ ] View file at any commit

### 33.1.2 History Actions
- [ ] Compare with current
- [ ] Compare with any version
- [ ] Copy file at version
- [ ] Checkout file at version
- [ ] View blame at version

## 33.2 Timeline View

### 33.2.1 Activity Timeline
- [ ] All changes over time
- [ ] Group by day/week/month
- [ ] Filter by file type
- [ ] Filter by author
- [ ] Visual timeline graph

---

# 36. Undo/Redo System

## 34.1 Undo Operations

### 34.1.1 Undoable Actions
- [ ] Commit (undo last commit)
- [ ] Stage/unstage files
- [ ] Discard changes
- [ ] Branch creation
- [ ] Branch deletion
- [ ] Checkout
- [ ] Merge
- [ ] Rebase
- [ ] Reset
- [ ] Cherry-pick
- [ ] Revert

### 34.1.2 Undo Implementation
- [ ] Use reflog for git operations
- [ ] Track local actions
- [ ] Multi-step undo
- [ ] Undo confirmation for destructive operations

## 34.2 Redo Operations

### 34.2.1 Redo Support
- [ ] Redo undone actions
- [ ] Redo stack management
- [ ] Clear redo on new action

## 34.3 History Panel

### 34.3.1 Action History
- [ ] List of recent actions
- [ ] Action details
- [ ] Undo to specific point
- [ ] Action timestamps

---

# 37. Performance & Optimization

## 35.1 Repository Performance

### 35.1.1 Large Repository Support
- [ ] Lazy loading commits
- [ ] Commit caching
- [ ] Incremental graph building
- [ ] Background graph computation
- [ ] Partial clone support
- [ ] Sparse checkout support

### 35.1.2 File System Performance
- [ ] Efficient file watching
- [ ] Debounced status updates
- [ ] Large file handling
- [ ] Binary file detection

### 35.1.3 Memory Management
- [ ] Efficient data structures
- [ ] Memory pooling
- [ ] Garbage collection optimization
- [ ] Memory usage monitoring

## 35.2 UI Performance

### 35.2.1 Rendering Optimization
- [ ] Virtual scrolling everywhere
- [ ] Canvas rendering for graph
- [ ] Efficient re-rendering
- [ ] Animation frame optimization
- [ ] Hardware acceleration

### 35.2.2 Startup Performance
- [ ] Fast cold start
- [ ] Progressive loading
- [ ] Splash screen with progress
- [ ] Background initialization

## 35.3 Network Performance

### 35.3.1 Network Optimization
- [ ] Connection pooling
- [ ] Request batching
- [ ] Caching API responses
- [ ] Offline mode
- [ ] Retry with backoff

---

# 38. Security

## 36.1 Credential Security

### 36.1.1 Credential Storage
- [ ] Use system keychain (Keychain, Windows Credential Manager, Secret Service)
- [ ] No plain text storage
- [ ] Encrypted credential cache
- [ ] Credential timeout

### 36.1.2 SSH Security
- [ ] SSH key passphrase protection
- [ ] SSH agent integration
- [ ] SSH key fingerprint verification
- [ ] Known hosts management

### 36.1.3 GPG Security
- [ ] GPG key management
- [ ] Signature verification
- [ ] Trust model support

## 36.2 Application Security

### 36.2.1 Code Signing
- [ ] Windows code signing
- [ ] macOS code signing & notarization
- [ ] Linux signature verification

### 36.2.2 Update Security
- [ ] Signed updates
- [ ] HTTPS only
- [ ] Update verification

### 36.2.3 Data Protection
- [ ] No sensitive data in logs
- [ ] Secure IPC
- [ ] Sandboxing where possible

---

# 39. Accessibility

## 37.1 Screen Reader Support

### 37.1.1 ARIA Implementation
- [ ] Proper ARIA labels
- [ ] ARIA roles
- [ ] ARIA states
- [ ] Live regions for updates

### 37.1.2 Screen Reader Testing
- [ ] VoiceOver (macOS)
- [ ] NVDA (Windows)
- [ ] JAWS (Windows)
- [ ] Orca (Linux)

## 37.2 Keyboard Accessibility

### 37.2.1 Full Keyboard Navigation
- [ ] All actions keyboard accessible
- [ ] Visible focus indicators
- [ ] Logical tab order
- [ ] Skip links

## 37.3 Visual Accessibility

### 37.3.1 Visual Options
- [ ] High contrast themes
- [ ] Font size adjustment
- [ ] Color blind friendly palettes
- [ ] Reduced motion option
- [ ] Zoom support

---

# 40. Internationalization (i18n)

## 38.1 Language Support

### 38.1.1 Initial Languages
- [ ] English (default)
- [ ] Spanish
- [ ] French
- [ ] German
- [ ] Portuguese
- [ ] Chinese (Simplified)
- [ ] Chinese (Traditional)
- [ ] Japanese
- [ ] Korean
- [ ] Russian

### 38.1.2 Translation System (lit-localize)
- [ ] @lit/localize setup
- [ ] Message extraction with @lit/localize-tools
- [ ] XLIFF translation file format
- [ ] Runtime locale switching
- [ ] Translation management platform integration
- [ ] Community translation contributions
- [ ] Context annotations for translators
- [ ] Pluralization support
- [ ] Date/time formatting per locale

## 38.2 Localization

### 38.2.1 Regional Formats
- [ ] Date formats
- [ ] Time formats
- [ ] Number formats
- [ ] Currency formats (if needed)

### 38.2.2 RTL Support
- [ ] Arabic
- [ ] Hebrew
- [ ] RTL layout mirroring

---

# 41. Auto-Update System

## 39.1 Update Detection

### 39.1.1 Update Checking
- [ ] Check on startup
- [ ] Periodic background checks
- [ ] Manual check option
- [ ] Release channel selection (stable/beta)

## 39.2 Update Process

### 39.2.1 Update Download
- [ ] Background download
- [ ] Download progress
- [ ] Pause/resume download
- [ ] Bandwidth limiting

### 39.2.2 Update Installation
- [ ] Install on quit
- [ ] Install now option
- [ ] Automatic silent updates (optional)
- [ ] Rollback capability

### 39.2.3 Update Notification
- [ ] New version notification
- [ ] Release notes display
- [ ] Skip version option
- [ ] Remind later

---

# 42. Analytics & Telemetry

## 40.1 Optional Analytics

### 40.1.1 Collected Data (Opt-in only)
- [ ] Application version
- [ ] OS and version
- [ ] Feature usage (anonymized)
- [ ] Error reports (anonymized)
- [ ] Performance metrics

### 40.1.2 Privacy
- [ ] No personal data
- [ ] No repository data
- [ ] No file contents
- [ ] Clear opt-in process
- [ ] Easy opt-out
- [ ] Data deletion request

## 40.2 Error Reporting

### 40.2.1 Crash Reports
- [ ] Automatic crash detection
- [ ] Crash report dialog
- [ ] Stack trace (anonymized)
- [ ] System info (anonymized)
- [ ] User description option

---

# 43. Development Phases

## Phase 0: Proof of Concept (Weeks 1-3)

**Objective**: Validate the three highest-risk technical decisions before committing to full implementation.

### POC Sprint 1: Graph Rendering (Week 1)

**Goal**: Prove we can render 10K commits at 60fps

- [ ] Set up minimal Vite + Lit project
- [ ] Create mock commit data generator (configurable size, branching, merges)
- [ ] Implement git-optimized lane assignment algorithm
- [ ] Unit tests with known graph topologies
- [ ] Visual verification tool for layout correctness

**Success Criteria**:
- Layout algorithm produces correct, readable graphs
- Algorithm runs in < 200ms for 10K commits

### POC Sprint 2: Canvas Rendering (Week 2)

**Goal**: Achieve target frame rate with interactions

- [ ] Lit Element canvas component (`ok-poc-graph`)
- [ ] Render commit nodes (circles) and edges (bezier curves)
- [ ] Implement spatial index for hit testing (grid-based)
- [ ] Add hover highlighting and click selection
- [ ] Virtual scrolling with overscan buffer
- [ ] Performance profiling setup

**Success Criteria**:
| Metric | Target |
|--------|--------|
| FPS (10K commits, scrolling) | ≥ 60fps |
| Initial render (10K commits) | < 500ms |
| Memory usage (10K commits) | < 100MB |
| Hit test latency | < 1ms |

### POC Sprint 3: Integration & Validation (Week 3)

**Goal**: Connect to real git data and validate end-to-end

- [ ] Tauri integration with git2-rs
- [ ] Load real repository data
- [ ] Test with varied repo sizes (100, 1K, 10K, 50K commits)
- [ ] Test with complex histories (linux kernel subset, monorepos)
- [ ] Cross-platform smoke test (Windows, macOS, Linux)
- [ ] Document findings and architectural decisions

**Success Criteria**:
- Real repo with 10K commits renders at target performance
- No platform-specific rendering issues
- Clear go/no-go recommendation documented

### POC Deliverables

1. **Technical Report**: Performance measurements, architectural decisions
2. **Code Artifacts**: Reusable graph components for main project
3. **Risk Assessment Update**: Revised risk matrix with POC findings
4. **Go/No-Go Decision**: Proceed with main implementation or pivot

---

## Phase 1: Foundation (Months 1-3)

### Milestone 1.1: Project Setup
- [ ] Repository setup (GitHub)
- [ ] CI/CD pipeline
- [ ] Development environment documentation
- [ ] Contribution guidelines
- [ ] Code of conduct

### Milestone 1.2: Core Architecture
- [ ] Tauri project scaffolding
- [ ] Rust backend structure
- [ ] Lit Element + TypeScript setup
- [ ] Vite build configuration
- [ ] Component library foundation (ok-* prefix)
- [ ] Zustand store architecture
- [ ] Lit Context providers setup
- [ ] IPC layer implementation
- [ ] Basic window management
- [ ] CSS custom properties / design tokens
- [ ] Web Test Runner configuration

### Milestone 1.3: Git Foundation
- [ ] libgit2 integration
- [ ] Repository discovery
- [ ] Repository opening
- [ ] Basic status reading
- [ ] File system watching

## Phase 2: Essential Features (Months 4-6)

### Milestone 2.1: Repository Operations
- [ ] Clone functionality
- [ ] Init functionality
- [ ] Open recent repositories
- [ ] Repository tabs

### Milestone 2.2: Basic Graph
- [ ] Simple commit graph rendering
- [ ] Branch visualization
- [ ] Basic navigation
- [ ] Commit selection

### Milestone 2.3: Staging & Commits
- [ ] Working directory status
- [ ] Stage/unstage files
- [ ] Commit creation
- [ ] Commit message editing

### Milestone 2.4: Basic Diff
- [ ] File diff display
- [ ] Split diff view
- [ ] Syntax highlighting
- [ ] Basic staging from diff

## Phase 3: Core Git (Months 7-9)

### Milestone 3.1: Branch Operations
- [ ] Create branch
- [ ] Checkout branch
- [ ] Delete branch
- [ ] Rename branch
- [ ] Branch tracking

### Milestone 3.2: Remote Operations
- [ ] Fetch
- [ ] Pull
- [ ] Push
- [ ] Remote management

### Milestone 3.3: Merge & Rebase
- [ ] Basic merge
- [ ] Merge conflict detection
- [ ] Basic conflict resolution UI
- [ ] Basic rebase

### Milestone 3.4: Stash & Tags
- [ ] Stash operations
- [ ] Stash management UI
- [ ] Tag operations
- [ ] Tag management UI

## Phase 4: Advanced Features (Months 10-12)

### Milestone 4.1: Interactive Rebase
- [ ] Interactive rebase UI
- [ ] Commit reordering
- [ ] Squash/fixup
- [ ] Reword

### Milestone 4.2: Advanced Diff
- [ ] Hunk staging
- [ ] Line staging
- [ ] Word-level diff
- [ ] Image diff
- [ ] Blame view

### Milestone 4.3: Search & Filter
- [ ] Commit search
- [ ] Branch filtering
- [ ] Graph filtering
- [ ] File search

### Milestone 4.4: Settings & Preferences
- [ ] Settings UI
- [ ] Theme support
- [ ] Keyboard shortcuts
- [ ] External tool configuration

## Phase 5: Integrations (Months 13-15)

### Milestone 5.1: GitHub Integration
- [ ] GitHub authentication
- [ ] PR creation
- [ ] PR viewing
- [ ] Basic code review

### Milestone 5.2: GitLab Integration
- [ ] GitLab authentication
- [ ] MR support
- [ ] Basic features

### Milestone 5.3: Other Integrations
- [ ] Bitbucket
- [ ] Azure DevOps
- [ ] Jira (basic)

### Milestone 5.4: Terminal
- [ ] Terminal emulator integration
- [ ] Terminal configuration
- [ ] Shell support

## Phase 6: Polish & Launch (Months 16-18)

### Milestone 6.1: Performance
- [ ] Large repository optimization
- [ ] Memory optimization
- [ ] Startup optimization
- [ ] UI responsiveness

### Milestone 6.2: Accessibility
- [ ] Screen reader support
- [ ] Keyboard navigation
- [ ] High contrast themes
- [ ] Accessibility testing

### Milestone 6.3: Internationalization
- [ ] i18n framework
- [ ] Initial translations
- [ ] RTL support

### Milestone 6.4: Launch Preparation
- [ ] Documentation
- [ ] Website
- [ ] Marketing materials
- [ ] Launch announcement

---

# 44. Testing Strategy

## 44.1 Unit Testing

### 44.1.1 Rust Backend Tests
- [ ] Git operation tests
- [ ] Service tests
- [ ] Model tests
- [ ] Integration tests (git2)

### 44.1.2 Frontend Tests (Lit Element)
- [ ] Component tests using @open-wc/testing
- [ ] Web Test Runner configuration
- [ ] Zustand store tests
- [ ] Utility function tests
- [ ] Controller tests
- [ ] Context provider tests
- [ ] Directive tests

### 44.1.3 Testing Tools
- [ ] @open-wc/testing - Lit testing utilities
- [ ] @web/test-runner - Browser-based test runner
- [ ] @web/test-runner-playwright - Cross-browser testing
- [ ] sinon - Mocking/stubbing
- [ ] chai - Assertions

## 44.2 Integration Testing

### 44.2.1 IPC Tests
- [ ] Command/response tests
- [ ] Event tests
- [ ] Error handling tests

### 44.2.2 Git Integration Tests
- [ ] Repository operation tests
- [ ] Branch operation tests
- [ ] Remote operation tests
- [ ] Merge/rebase tests

## 44.3 End-to-End Testing

### 44.3.1 E2E Framework
- [ ] Playwright or WebdriverIO
- [ ] Test scenarios
- [ ] Cross-platform testing

### 44.3.2 E2E Scenarios
- [ ] Clone and open repository
- [ ] Create and commit changes
- [ ] Branch and merge workflows
- [ ] Push and pull workflows
- [ ] Conflict resolution

## 44.4 Performance Testing

### 44.4.1 Benchmarks
- [ ] Repository opening time
- [ ] Graph rendering performance
- [ ] Large repository handling
- [ ] Memory usage

### 44.4.2 Performance Test Targets

| Metric | Small Repo (1K) | Medium (10K) | Large (100K) |
|--------|-----------------|--------------|--------------|
| Open time | < 100ms | < 500ms | < 2s |
| Graph render | < 50ms | < 200ms | < 1s |
| Scroll FPS | 60fps | 60fps | 60fps |
| Memory | < 50MB | < 100MB | < 500MB |

### 44.4.3 Performance Test Repositories

- [ ] Create/maintain benchmark repositories:
  - `perf-test-1k`: 1,000 commits, simple history
  - `perf-test-10k`: 10,000 commits, moderate branching
  - `perf-test-100k`: 100,000 commits, complex history
  - `perf-test-monorepo`: Many files, few commits
  - `perf-test-deep`: Deep history, many merges

## 44.5 Cross-Platform Testing

### 44.5.1 CI Matrix Configuration

```yaml
# .github/workflows/cross-platform.yml
name: Cross-Platform Tests

on: [push, pull_request]

jobs:
  test-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Enable Long Paths
        run: |
          reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f
      - name: Run Tests
        run: cargo test --features platform-tests
      - name: Run Long Path Tests
        run: cargo test --features long-path-tests
        
  test-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Tests
        run: cargo test --features platform-tests
      - name: Test Case-Sensitive APFS
        run: |
          hdiutil create -size 100m -fs "Case-sensitive APFS" -volname "CSTest" /tmp/cs.dmg
          hdiutil attach /tmp/cs.dmg
          cd /Volumes/CSTest && cargo test --features case-sensitive-tests
          
  test-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Tests
        run: cargo test --features platform-tests
      - name: Test Case-Insensitive (vfat)
        run: |
          dd if=/dev/zero of=/tmp/ci.img bs=1M count=100
          mkfs.vfat /tmp/ci.img
          sudo mkdir -p /mnt/ci && sudo mount -o loop /tmp/ci.img /mnt/ci
          sudo chown $USER /mnt/ci
          cd /mnt/ci && cargo test --features case-insensitive-tests
```

### 44.5.2 Platform-Specific Test Scenarios

**Case Sensitivity Tests**:
- [ ] Detect case conflicts in tree before checkout
- [ ] Handle case-only renames correctly
- [ ] Warn user about case conflicts on clone
- [ ] Track case changes in status

**Line Ending Tests**:
- [ ] Detect line ending style in files
- [ ] Handle mixed line endings
- [ ] Apply .gitattributes rules correctly
- [ ] Normalize on commit as configured

**Path Length Tests (Windows)**:
- [ ] Detect paths exceeding MAX_PATH
- [ ] Warn before checkout of long paths
- [ ] Handle long paths when enabled
- [ ] Suggest solutions for long path issues

**Symlink Tests**:
- [ ] Detect symlink support on platform
- [ ] Create symlinks when supported
- [ ] Fall back to regular files when unsupported
- [ ] Warn user about symlink limitations

**File Locking Tests (Windows)**:
- [ ] Detect file lock errors
- [ ] Retry operations with backoff
- [ ] Report locking process when possible
- [ ] Handle antivirus interference

**Unicode Tests**:
- [ ] Handle NFC vs NFD normalization
- [ ] Detect normalization collisions
- [ ] Handle special characters in filenames
- [ ] Reject Windows-illegal characters

### 44.5.3 Test Repository Collection

```rust
// Create standardized test repos for edge cases
mod test_repos {
    /// Repository with case conflicts
    pub fn case_conflicts() -> TempRepo;
    
    /// Repository with mixed line endings
    pub fn mixed_line_endings() -> TempRepo;
    
    /// Repository with very long paths
    pub fn long_paths() -> TempRepo;
    
    /// Repository with symlinks
    pub fn with_symlinks() -> TempRepo;
    
    /// Repository with Unicode filenames
    pub fn unicode_filenames() -> TempRepo;
    
    /// Repository with Windows-illegal filenames
    pub fn illegal_filenames() -> TempRepo;
    
    /// Repository with submodules
    pub fn with_submodules() -> TempRepo;
    
    /// Repository using Git LFS
    pub fn with_lfs() -> TempRepo;
    
    /// Repository with merge conflicts
    pub fn conflicting() -> TempRepo;
    
    /// Large repository for performance testing
    pub fn large_history(commits: usize) -> TempRepo;
}
```

### 44.5.4 Compatibility Test Matrix

| Test Category | Windows | macOS | Linux |
|---------------|---------|-------|-------|
| Case sensitivity | ⚠️ Test | ⚠️ Test | ✅ Native |
| Line endings | ⚠️ CRLF | ✅ LF | ✅ LF |
| Long paths | ⚠️ Test | ✅ OK | ✅ OK |
| Symlinks | ⚠️ Test | ✅ OK | ✅ OK |
| File locking | ⚠️ Test | ✅ Advisory | ✅ Advisory |
| Unicode (NFD) | ✅ NFC | ⚠️ NFD | ✅ NFC |
| Permissions | ⚠️ No exec | ✅ Full | ✅ Full |

## 44.6 Accessibility Testing

### 44.6.1 Automated Tests
- [ ] axe-core integration
- [ ] Lighthouse audits

### 44.6.2 Manual Testing
- [ ] Screen reader testing
- [ ] Keyboard-only testing

---

# 45. Documentation

## 43.1 User Documentation

### 43.1.1 Getting Started
- [ ] Installation guide
- [ ] Quick start guide
- [ ] First repository tutorial

### 43.1.2 Feature Guides
- [ ] Repository management
- [ ] Branch workflows
- [ ] Merge and rebase
- [ ] Remote operations
- [ ] Integrations setup

### 43.1.3 Reference
- [ ] Keyboard shortcuts
- [ ] Settings reference
- [ ] Troubleshooting guide
- [ ] FAQ

## 43.2 Developer Documentation

### 43.2.1 Architecture
- [ ] Architecture overview
- [ ] Component documentation
- [ ] API documentation

### 43.2.2 Contributing
- [ ] Development setup
- [ ] Code style guide
- [ ] PR process
- [ ] Issue templates

### 43.2.3 Plugin Development (Future)
- [ ] Plugin API
- [ ] Plugin examples
- [ ] Distribution

## 43.3 API Documentation

### 43.3.1 Internal APIs
- [ ] IPC commands documentation
- [ ] Event documentation
- [ ] Type definitions

---

# Appendix A: Competitor Feature Comparison

| Feature | Sourcetree | Fork | GitHub Desktop | Gitnado |
|---------|------------|------|----------------|-----------|
| Graph visualization | ✅ | ✅ | ❌ | 🎯 |
| Interactive rebase | ✅ | ✅ | ❌ | 🎯 |
| Built-in merge tool | ✅ | ✅ | ❌ | 🎯 |
| GitHub integration | ✅ | ❌ | ✅ | 🎯 |
| GitLab integration | ✅ | ❌ | ❌ | 🎯 |
| Jira integration | ✅ | ❌ | ❌ | 🎯 |
| Gitflow support | ✅ | ✅ | ❌ | 🎯 |
| LFS support | ✅ | ✅ | ✅ | 🎯 |
| Free | ✅ | ❌ | ✅ | ✅ |
| Open source | ❌ | ❌ | ✅ | ✅ |
| Cross-platform | ❌* | ✅ | ✅ | 🎯 |

*Sourcetree Windows/Mac only

🎯 = Planned for Gitnado

---

# Appendix B: Technology Alternatives Considered

## Git Libraries

| Library | Language | Pros | Cons |
|---------|----------|------|------|
| git2-rs | Rust | Fast, full-featured, well-maintained | Complex API |
| nodegit | Node.js | libgit2 bindings for Node | Async complexities |
| simple-git | Node.js | Simple API | Shell wrapper, slower |
| isomorphic-git | JS | Pure JS, works in browser | Incomplete features |
| go-git | Go | Pure Go implementation | Go dependency |

## UI Frameworks

| Framework | Pros | Cons |
|-----------|------|------|
| **Tauri + Lit Element** | Tiny bundle (~5KB), Web Standards, TypeScript-first, future-proof | Smaller ecosystem, build your own components |
| Tauri + Svelte | Small bundle, fast, Rust backend | Younger ecosystem, custom syntax |
| Tauri + React | Large ecosystem, familiar | Larger bundle than Lit/Svelte |
| Electron + React | Proven, huge ecosystem | Large bundle, slow |
| Qt | Native performance | Complex, licensing |
| Flutter | Cross-platform mobile too | Desktop still maturing |

### Why Lit Element Was Chosen

1. **Web Standards**: Built on Web Components - works everywhere, framework-agnostic
2. **TypeScript-First**: Decorator-based API with excellent type inference
3. **Minimal Runtime**: ~5KB vs Svelte's ~10KB vs React's ~40KB
4. **Shadow DOM**: True CSS encapsulation, no style leakage
5. **Future-Proof**: Standards-based, won't be deprecated
6. **Interoperability**: Components work with any framework or vanilla JS
7. **Performance**: lit-html's tagged template literals are highly optimized

---

# Appendix C: Estimated Resource Requirements

## Development Team (Ideal)

| Role | Count | Focus |
|------|-------|-------|
| Project Lead | 1 | Architecture, coordination |
| Rust Developer | 2 | Backend, git operations |
| Frontend Developer | 2 | UI, graph visualization |
| UI/UX Designer | 1 | Design system, UX |
| QA Engineer | 1 | Testing, quality |
| DevOps | 1 | CI/CD, releases |
| Technical Writer | 1 | Documentation |

## Minimum Viable Team

| Role | Count |
|------|-------|
| Full-stack Developer | 2-3 |
| Designer (part-time) | 1 |

## Timeline Estimates

| Phase | Duration | Team Size | Key Focus |
|-------|----------|-----------|-----------|
| **Phase 0: POC** | 3 weeks | 1-2 devs | Graph rendering validation |
| Phase 1: Foundation | 3 months | 2-3 devs | Core architecture, git integration |
| Phase 2: Essential Features | 3 months | 3-4 devs | Clone, basic graph, staging, commits |
| Phase 3: Core Git | 3 months | 3-4 devs | Branches, remotes, merge/rebase |
| Phase 4: Advanced Features | 3 months | 4-5 devs | Interactive rebase, advanced diff |
| Phase 5: Integrations | 3 months | 4-5 devs | GitHub, GitLab, terminal |
| Phase 6: Polish & Launch | 3 months | 4-5 devs | Performance, a11y, i18n |

**Total: ~19 months to full feature parity** (3 weeks POC + 18 months development)

---

# Appendix D: Risk Assessment

## Technical Risks (Post-Analysis)

| Risk | Probability | Impact | Status | Mitigation |
|------|-------------|--------|--------|------------|
| Graph performance | Medium | High | ✅ Mitigated | Hybrid Canvas+DOM, git-optimized layout, virtualization |
| libgit2 limitations | Medium | High | ✅ Mitigated | CLI fallback for rebase/bisect/LFS |
| Cross-platform FS issues | High | Medium | ✅ Mitigated | Pre-checkout safety checks, platform-specific handling |
| Line endings | Very High | Medium | ✅ Mitigated | Auto-detect, warn, batch fix with .gitattributes |
| File locking (Windows) | Medium | Medium | ✅ Mitigated | Retry with exponential backoff |
| Case sensitivity | High | High | ✅ Mitigated | Pre-clone scan, warnings, 2-step rename |
| Path length (Windows) | Medium | High | ✅ Mitigated | Detection, solutions (enable long paths, shorter path) |
| Symlinks | Medium | Medium | ✅ Mitigated | Fallback to regular files with warning |
| Unicode normalization | Low | High | ✅ Mitigated | NFC normalization internally |
| Tauri limitations | Low | High | ⚠️ Monitored | Electron fallback plan documented |

## Project Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Scope creep | High | High | Strict MVP definition, POC-first approach |
| Contributor burnout | Medium | High | Sustainable pace, recognition |
| Competition features | Medium | Medium | Focus on open-source differentiators |
| Funding | Medium | High | Sponsorship, optional features |

---

# Appendix E: Technical Spike Documents

Detailed technical analysis was performed for the three highest-risk areas. These documents provide implementation details, code examples, and architectural decisions:

## E.1 Graph Rendering Technical Spike

**File**: `graph-rendering-technical-spike.md`

Covers:
- Layout algorithm comparison (Sugiyama vs git-optimized)
- Rendering technology analysis (DOM, SVG, Canvas, WebGL)
- Virtual scrolling implementation
- Hit testing with spatial indexing
- Performance targets and benchmarks
- 3-week POC implementation plan

## E.2 libgit2 Limitations Technical Spike

**File**: `libgit2-limitations-technical-spike.md`

Covers:
- Feature comparison matrix (libgit2 vs git CLI)
- Critical gaps analysis (interactive rebase, LFS, hooks)
- CLI fallback architecture
- Credential handling strategies
- Hooks execution wrapper
- Future consideration: gitoxide

## E.3 Cross-Platform File System Technical Spike

**File**: `cross-platform-filesystem-technical-spike.md`

Covers:
- Platform differences matrix (Windows, macOS, Linux)
- Case sensitivity detection and handling
- Line ending detection, conversion, and UI
- File permission handling
- Symlink support and fallbacks
- Path length limits and solutions
- File locking retry strategies
- Unicode normalization (NFC/NFD)
- Cross-platform CI configuration
- Test repository collection

---

*Document Version: 2.1*
*Last Updated: December 2024*
*Stack: Tauri 2.0 + Rust + Lit Element 3.x + TypeScript 5.x*
*Technical Spikes Completed: ✅ Graph Rendering, ✅ libgit2 Limitations, ✅ Cross-Platform FS*
*License: CC BY-SA 4.0*

## Changelog

### Version 2.1 (December 2024)
- Fixed section numbering inconsistencies throughout document
- Added Phase 0 (POC) to development phases with detailed 3-week breakdown
- Updated testing strategy section numbers (44.x)
- Updated timeline estimates to include POC phase (19 months total)
- Added comprehensive cross-platform CI configuration
- Added test repository collection for edge cases
- Added compatibility test matrix
- Linked all three technical spike documents in Appendix E

### Version 2.0 (December 2024)
- Added Section 4: Technical Risk Analysis & Decisions
- Added Section 6: Cross-Platform Compatibility
- Updated Section 8: Graph Visualization with hybrid Canvas+DOM architecture
- Updated Section 15: Rebase with CLI fallback notes for interactive rebase
- Updated Section 20: Git LFS with CLI wrapper implementation
- Updated Section 21: Git Hooks with manual execution strategy
- Incorporated findings from three technical spikes:
  - Graph Rendering Performance
  - libgit2 Limitations & Mitigation
  - Cross-Platform File System Challenges
- Renumbered all sections to accommodate new content

### Version 1.1 (December 2024)
- Changed frontend from Svelte to Lit Element + TypeScript
- Updated directory structure for Lit components
- Added Lit implementation patterns and examples
- Updated testing strategy for @open-wc/testing

### Version 1.0 (December 2024)
- Initial comprehensive development plan
- 43 sections covering all planned features
- Technology stack: Tauri + Rust + Svelte
