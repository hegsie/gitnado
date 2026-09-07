# Copilot Instructions for Gitnado

## Project Overview

Gitnado is a modern, cross-platform Git GUI client built with **Tauri 2.0**, **Lit** (web components), and **Rust**. It's designed to be a fast, privacy-first alternative to existing Git clients with no telemetry, no account requirements, and offline-first operation.

### Key Technologies & Versions

- **Frontend**: TypeScript 5.3+, Lit 3.3+, Vite 7.3+
- **Backend**: Rust 1.70+, Tauri 2.0
- **Git Operations**: libgit2 (via git2-rs 0.20) for core operations, system Git for complex tasks
- **State Management**: Zustand 5.0+
- **Testing**: Web Test Runner, Playwright (E2E)
- **Build System**: Vite (frontend), Cargo (backend)

## Repository Structure

```
gitnado/
├── src/                      # Frontend (TypeScript/Lit)
│   ├── components/           # UI web components
│   │   ├── common/           # Shared components (buttons, inputs, etc.)
│   │   ├── dialogs/          # Modal dialogs
│   │   ├── graph/            # Commit graph visualization
│   │   ├── panels/           # Content panels (diff, blame, etc.)
│   │   ├── sidebar/          # Navigation sidebars
│   │   └── toolbar/          # Top toolbar
│   ├── services/             # API and service layer (Git, integrations)
│   ├── stores/               # Zustand state management
│   ├── types/                # TypeScript type definitions
│   ├── styles/               # CSS and design tokens
│   └── utils/                # Helper functions
│
├── src-tauri/                # Backend (Rust)
│   ├── src/
│   │   ├── commands/         # Tauri IPC command handlers
│   │   ├── services/         # Business logic
│   │   └── models/           # Data structures
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri configuration
│
├── e2e/                      # End-to-end tests (Playwright)
│   └── tests/                # E2E test specs
│
├── docs/                     # Additional documentation
├── .github/                  # GitHub configuration
│   ├── workflows/            # CI/CD pipelines
│   └── copilot-instructions.md
├── CLAUDE.md                 # Development guidelines for AI agents
└── README.md                 # Project documentation
```

## Installation & Setup

### Prerequisites

1. **Node.js** 20+ (for frontend development)
2. **Rust** 1.70+ (install via [rustup](https://rustup.rs/))
3. **System Git** 2.20+ (required for advanced Git operations)

### Platform-Specific Dependencies

#### macOS
```bash
xcode-select --install
```

#### Linux (Debian/Ubuntu)
```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libgtk-3-dev \
  libglib2.0-dev \
  libdbus-1-dev
```

#### Windows
Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload.

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/hegsie/gitnado.git
cd Gitnado

# Install frontend dependencies
npm install

# Start development mode (runs both frontend and backend)
npm run tauri:dev
```

## Development Workflow

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server only (frontend) |
| `npm run tauri:dev` | Run app in development mode (frontend + backend) |
| `npm run tauri:build` | Build production application |
| `npm run build` | Build frontend only |

### Testing Commands

**IMPORTANT**: Always run tests before committing changes.

```bash
# Run all unit tests
npm test

# Run unit tests in watch mode (for TDD)
npm run test:watch

# Run end-to-end tests
npm run test:e2e

# Run E2E tests interactively
npm run test:e2e:ui

# Type check without emitting files
npm run typecheck
```

### Linting & Formatting

**CRITICAL**: These checks MUST pass before any commit.

```bash
# Lint TypeScript code
npm run lint

# Lint and auto-fix issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without modifying files
npm run format:check

# Format Rust code
cd src-tauri && cargo fmt

# Lint Rust code with Clippy
cd src-tauri && cargo clippy
```

### Pre-commit Checklist

Run ALL of these before committing:

```bash
# Quick check (all-in-one)
npm run lint && npm run typecheck && cd src-tauri && cargo fmt --check && cargo clippy

# Also verify no snake_case in Tauri API calls (should return no matches)
grep -rn "_[a-z]*:" src/types/api.types.ts | grep -v "//"
```

## Coding Standards

### TypeScript/Frontend

1. **Web Components**: Use Lit web components with decorators
   - `@customElement('element-name')` for component registration
   - `@property()` for reactive properties
   - `@state()` for internal state

2. **Type Safety**:
   - Use explicit types, avoid `any` (warnings allowed with justification)
   - Enable strict mode TypeScript checks
   - Use TypeScript 5.3+ features

3. **Import Paths**: Use path aliases defined in `tsconfig.json`
   - `@/*` for `src/*`
   - `@components/*`, `@stores/*`, `@services/*`, etc.

4. **State Management**:
   - Use Zustand for global state
   - Keep component state local when possible
   - Follow reactive patterns

5. **ESLint Rules**: Follow `.eslintrc.cjs` configuration
   - Unused vars: Warn (prefix with `_` to ignore)
   - No explicit any: Warn
   - No console: Off (logging is allowed)

6. **Testing**:
   - Unit tests in `src/**/__tests__/*.test.ts`
   - Use `@open-wc/testing` for Lit components
   - Mock Tauri IPC calls with `@tauri-apps/api`
   - Mock external dependencies
   - E2E tests in `e2e/tests/*.spec.ts` using Playwright

### Rust/Backend

1. **Rust Edition**: 2021, minimum version 1.70

2. **Code Style**:
   - Run `cargo fmt` to auto-format
   - Run `cargo clippy` and fix all warnings
   - Follow Rust naming conventions (snake_case for functions/variables)

3. **Error Handling**:
   - Use `thiserror` for custom errors
   - Use `anyhow` for application-level error handling
   - Return `Result<T, E>` for fallible operations

4. **Tauri Commands**:
   - Place in `src-tauri/src/commands/`
   - Use `#[tauri::command]` macro
   - Return `Result<T, String>` or custom error types
   - **CRITICAL**: Use snake_case in Rust; Tauri auto-converts to camelCase for TypeScript

5. **Git Operations**:
   - Prefer libgit2 (via `git2` crate) for core operations (fast, portable)
   - Use system Git (via shell) for complex operations (rebase, submodules)
   - Document why system Git is needed when used

6. **Testing**:
   - Unit tests in `src-tauri/tests/`
   - Use Rust's built-in test framework
   - Test Git operations with tempfile repositories

## Tauri Naming Convention (CRITICAL)

**Automatic Conversion**: Tauri converts between Rust's snake_case and TypeScript's camelCase.

- Rust command parameter: `target_ref: String` → TypeScript: `targetRef: string`
- Rust: `no_ff: Option<bool>` → TypeScript: `noFf?: boolean`
- Rust: `include_untracked: bool` → TypeScript: `includeUntracked: boolean`

**Rules**:
- ✅ Always use snake_case in Rust code
- ✅ Always use camelCase in TypeScript code
- ❌ Never use snake_case in TypeScript when calling Tauri commands
- ❌ Never use camelCase in Rust command parameters

**Pre-commit check**:
```bash
# Should return no matches
grep -rn "_[a-z]*:" src/types/api.types.ts src/services/git.service.ts src/app-shell.ts src/components/ --include="*.ts" | grep -v "node_modules" | grep -v "__tests__"
```

## Architecture & Design Patterns

### Multi-Process Architecture

- **Frontend Process**: Web UI in WebView (Lit components, Zustand state)
- **Backend Process**: Rust application (Tauri commands, Git operations)
- **IPC**: Type-safe communication via Tauri's command system

### Key Design Decisions

1. **libgit2** for core Git operations (staging, commits, branches) - speed and portability
2. **System Git** for complex operations (rebase, submodules) - avoid libgit2 limitations
3. **Zustand** for reactive state management on frontend
4. **SQLite** for caching repository metadata and indexing
5. **AI features via pluggable providers** (e.g., local Ollama/LM Studio, Anthropic, GitHub Copilot, OpenAI-compatible) - can run entirely offline when using local providers

### File Organization

- Frontend: Feature-based organization (components by type, not by feature)
- Backend: Layer-based organization (commands, services, models)
- Shared types: `src/types/` and `src-tauri/src/models/`

## Testing Requirements

### When Adding New Features

1. **Unit Tests**: REQUIRED for all new components and services
   - Frontend: `src/**/__tests__/*.test.ts`
   - Backend: `src-tauri/tests/`
   - Test edge cases, error handling, boundary conditions

2. **Integration Tests**: REQUIRED for user-facing features
   - E2E tests in `e2e/tests/*.spec.ts`
   - Test complete user workflows
   - Include tests for user interactions

3. **Test Patterns**:
   - Follow existing test patterns in the codebase
   - Use `@open-wc/testing` for Lit component tests
   - Use Playwright for E2E tests
   - Mock external dependencies (Tauri invoke, network calls)

### Running Tests

```bash
# Unit tests (fast, run frequently)
npm test

# E2E tests (slow, run before PR)
npm run test:e2e
```

## Boundaries & Exclusions

### DO NOT Modify

1. **Build Artifacts**: `node_modules/`, `target/`, `dist/`
2. **IDE/OS Files**: `.idea/`, `.vscode/`, `.DS_Store`
3. **Test Results**: `e2e/test-results/`, `playwright-report/`
4. **Environment Files**: `.env`, `.env.local` (never commit secrets)
5. **Git Internals**: `.git/` directory
6. **CI/CD Workflows**: `.github/workflows/` (unless explicitly requested)
7. **Tauri Config**: `src-tauri/tauri.conf.json` (requires careful review)

### DO NOT

- Add new dependencies without justification (keep bundle size small)
- Introduce telemetry, analytics, or external tracking
- Add cloud dependencies or account requirements
- Remove or modify existing tests (could cause regressions)
- Use deprecated APIs or libraries
- Introduce security vulnerabilities
- Break offline-first functionality

### Style Guidelines

- **Comments**: Only add if they match existing style or explain complex logic
- **Libraries**: Use existing libraries when possible; avoid adding new ones
- **Formatting**: Let Prettier/rustfmt handle formatting
- **Naming**: Follow TypeScript/Rust conventions consistently

## Common Tasks

### Adding a New Tauri Command

1. Create Rust function in `src-tauri/src/commands/`
2. Use `#[tauri::command]` macro
3. Add to command list in `src-tauri/src/main.rs`
4. Define TypeScript types in `src/types/api.types.ts` (use camelCase)
5. Create service wrapper in `src/services/` if needed
6. Add unit tests
7. Update documentation if public API

### Adding a New UI Component

1. Create component in `src/components/<category>/`
2. Use `@customElement` decorator
3. Define props with `@property()` or `@state()`
4. Add styles (scoped to component)
5. Create unit tests in `__tests__/` subdirectory
6. Document props and events
7. Add to E2E tests if user-facing

### Adding a Git Operation

1. Implement in `src-tauri/src/services/git/` (prefer libgit2)
2. Add Tauri command in `src-tauri/src/commands/git/`
3. Create TypeScript service wrapper in `src/services/git.service.ts`
4. Add unit tests (Rust and TypeScript)
5. Add E2E test for user workflow
6. Update documentation

## Performance Considerations

- **Large Repositories**: Use pagination, virtual scrolling, lazy loading
- **Git Operations**: Prefer libgit2 for speed; use background threads for long operations
- **State Updates**: Batch state updates in Zustand to avoid excessive renders
- **Bundle Size**: Keep dependencies minimal; use dynamic imports for large features
- **Memory**: Clean up event listeners and subscriptions in component lifecycle

## Security Best Practices

- **Input Validation**: Validate all user input before Git operations
- **Path Traversal**: Use safe path operations, avoid user-controlled paths
- **Credentials**: Use platform keyring (keyring crate), never store in plaintext
- **OAuth Tokens**: Store in OS keyring via the `keyring` crate
- **Shell Commands**: Sanitize inputs when invoking system Git
- **GPG**: Validate GPG keys before signing

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- `ci.yml`: Lint, type check, tests on every push
- `build.yml`: Build releases for macOS/Windows/Linux

All workflows must pass before merging.

## Resources & Documentation

- **Main Docs**: [README.md](../README.md)
- **Development Guide**: [CLAUDE.md](../CLAUDE.md)
- **Roadmap**: [ROADMAP.md](../ROADMAP.md)
- **OAuth Setup**: [docs/oauth-setup.md](../docs/oauth-setup.md)
- **Tauri Docs**: https://v2.tauri.app/
- **Lit Docs**: https://lit.dev/
- **libgit2 Docs**: https://libgit2.org/

## Quick Reference

### Most Common Commands

```bash
# Development
npm run tauri:dev              # Start dev mode
npm run lint && npm test       # Quick validation

# Pre-commit
npm run lint && npm run typecheck && cd src-tauri && cargo fmt --check && cargo clippy

# Build
npm run tauri:build           # Production build

# Testing
npm test                      # Unit tests
npm run test:e2e              # E2E tests
```

### File Paths Reference

- Frontend components: `src/components/<category>/<name>.ts`
- Rust commands: `src-tauri/src/commands/<category>.rs`
- Services: `src/services/<name>.service.ts`
- Types: `src/types/<name>.types.ts`
- Tests (TS): `src/**/__tests__/*.test.ts`
- Tests (Rust): `src-tauri/tests/<name>.rs`
- E2E: `e2e/tests/<feature>.spec.ts`

---

**For more details**, see:
- [CLAUDE.md](../CLAUDE.md) - Detailed development guidelines
- [README.md](../README.md) - Project overview and features
- [ROADMAP.md](../ROADMAP.md) - Planned features
