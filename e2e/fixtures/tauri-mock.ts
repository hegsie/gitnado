import type { Page } from '@playwright/test';

/**
 * Mock data types matching the Rust backend responses
 */
export interface MockRepository {
  path: string;
  name: string;
  isValid: boolean;
  isBare: boolean;
  headRef: string | null;
  /** Commit HEAD points at when detached; absent/null while on a branch. */
  detachedHeadOid?: string | null;
  state: string;
}

export interface MockBranch {
  name: string;
  shorthand: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  targetOid: string;
  aheadBehind?: { ahead: number; behind: number };
  lastCommitTimestamp?: number;
  isStale: boolean;
}

export interface MockCommit {
  oid: string;
  shortId: string;
  message: string;
  summary: string;
  body: string | null;
  author: { name: string; email: string; timestamp: number };
  committer: { name: string; email: string; timestamp: number };
  parentIds: string[];
  timestamp: number;
}

export interface MockStatusEntry {
  path: string;
  status: string;
  isStaged: boolean;
  isConflicted: boolean;
}

export interface MockStash {
  index: number;
  message: string;
  oid: string;
}

export interface MockTag {
  name: string;
  targetOid: string;
  message: string | null;
  tagger: { name: string; email: string; timestamp: number } | null;
  isAnnotated: boolean;
}

export interface MockRemote {
  name: string;
  url: string;
  pushUrl: string | null;
}

export interface MockNote {
  commitOid: string;
  message: string;
  notesRef: string;
}

/**
 * Default mock data for a typical repository state
 */
export const defaultMockData = {
  // Repository info
  repository: {
    path: '/tmp/test-repo',
    name: 'test-repo',
    isValid: true,
    isBare: false,
    headRef: 'main',
    state: 'clean',
  } as MockRepository,

  // Branches
  branches: [
    {
      name: 'main',
      shorthand: 'main',
      isHead: true,
      isRemote: false,
      upstream: 'origin/main',
      targetOid: 'abc123def456',
      aheadBehind: { ahead: 0, behind: 0 },
      lastCommitTimestamp: Date.now() / 1000,
      isStale: false,
    },
    {
      name: 'feature/test',
      shorthand: 'feature/test',
      isHead: false,
      isRemote: false,
      upstream: null,
      targetOid: 'def456abc789',
      isStale: false,
    },
    {
      name: 'origin/main',
      shorthand: 'origin/main',
      isHead: false,
      isRemote: true,
      upstream: null,
      targetOid: 'abc123def456',
      isStale: false,
    },
  ] as MockBranch[],

  // Commit history
  commits: [
    {
      oid: 'abc123def456',
      shortId: 'abc123d',
      message: 'Initial commit\n\nThis is the first commit.',
      summary: 'Initial commit',
      body: 'This is the first commit.',
      author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      parentIds: [],
      timestamp: Date.now() / 1000,
    },
    {
      oid: 'def456abc789',
      shortId: 'def456a',
      message: 'Add feature\n\nImplemented new feature.',
      summary: 'Add feature',
      body: 'Implemented new feature.',
      author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 - 3600 },
      committer: {
        name: 'Test User',
        email: 'test@example.com',
        timestamp: Date.now() / 1000 - 3600,
      },
      parentIds: ['abc123def456'],
      timestamp: Date.now() / 1000 - 3600,
    },
  ] as MockCommit[],

  // Status
  status: {
    staged: [] as MockStatusEntry[],
    unstaged: [
      { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
      { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
    ] as MockStatusEntry[],
  },

  // Stashes
  stashes: [] as MockStash[],

  // Tags
  tags: [
    {
      name: 'v1.0.0',
      targetOid: 'abc123def456',
      message: 'Release v1.0.0',
      tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      isAnnotated: true,
    },
  ] as MockTag[],

  // Remotes
  remotes: [{ name: 'origin', url: 'https://github.com/test/repo.git', pushUrl: null }] as MockRemote[],

  // Git notes (refs/notes/*) — empty by default, like a fresh clone
  notes: [] as MockNote[],
  // Git Flow config — an UNINITIALIZED repo (a read that succeeded). Without
  // this case the command falls through to the unmocked default (null), which
  // the panel reports as a config READ FAILURE.
  gitflowConfig: {
    initialized: false,
    masterBranch: 'main',
    developBranch: 'develop',
    featurePrefix: 'feature/',
    releasePrefix: 'release/',
    hotfixPrefix: 'hotfix/',
    supportPrefix: 'support/',
    versionTagPrefix: 'v',
  },

  // Settings
  settings: {
    theme: 'dark' as const,
    vimMode: false,
    showAvatars: true,
    showCommitSize: true,
    wordWrap: false,
    confirmBeforeDiscard: true,
  },
};

/**
 * Tauri command handler that returns mock data
 */
function createMockHandler(mocks: typeof defaultMockData) {
  return (command: string, args?: Record<string, unknown>): unknown => {
    switch (command) {
      // Repository commands
      case 'open_repository':
      case 'get_repository_info':
        return mocks.repository;

      case 'get_recent_repositories':
        return [mocks.repository];

      // Branch commands
      case 'get_branches':
        return mocks.branches;

      case 'get_current_branch':
        return mocks.branches.find((b) => b.isHead) || null;

      case 'compare_branches':
        return {
          baseRef: (args?.base as string) ?? '',
          compareRef: (args?.compare as string) ?? '',
          ahead: 1,
          behind: 0,
          mergeBase: 'abc123def456',
          commitsAhead: args?.includeCommits
            ? [
                {
                  oid: 'def456abc789',
                  shortOid: 'def456a',
                  message: 'Add the feature',
                  authorName: 'Test User',
                  authorDate: Math.floor(Date.now() / 1000),
                },
              ]
            : null,
          commitsBehind: args?.includeCommits ? [] : null,
          filesChanged: args?.includeFiles
            ? [{ path: 'src/feature.ts', status: 'modified', additions: 12, deletions: 4, oldPath: null }]
            : null,
          totalAdditions: 12,
          totalDeletions: 4,
        };

      // === Branch mutations ===
      case 'checkout':
      case 'checkout_branch': {
        const refName = (args?.refName as string) || (args?.name as string) || '';
        mocks.branches.forEach((b) => { b.isHead = false; });
        const remoteBranch = mocks.branches.find((b) => b.name === refName && b.isRemote);
        if (remoteBranch) {
          const firstSlash = refName.indexOf('/');
          const localName = firstSlash > 0 ? refName.substring(firstSlash + 1) : refName;
          const targetOid = remoteBranch.targetOid || 'checkout-oid';
          const existingLocal = mocks.branches.find((b) => b.name === localName && !b.isRemote);
          if (existingLocal) {
            existingLocal.isHead = true;
            existingLocal.upstream = refName;
          } else {
            mocks.branches.push({
              name: localName,
              shorthand: localName,
              isHead: true,
              isRemote: false,
              upstream: refName,
              targetOid,
              isStale: false,
            } as MockBranch);
          }
        } else {
          const branch = mocks.branches.find((b) => b.name === refName);
          if (branch) branch.isHead = true;
        }
        const newHead = mocks.branches.find((b) => b.isHead);
        if (newHead) mocks.repository.headRef = newHead.name;
        return null;
      }
      case 'create_branch': {
        const name = (args?.name as string) || '';
        const startPoint = (args?.startPoint as string) || mocks.commits[0]?.oid || 'abc123';
        mocks.branches.push({
          name,
          shorthand: name,
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: startPoint,
          isStale: false,
        } as MockBranch);
        return null;
      }
      case 'delete_branch': {
        const branchName = (args?.name as string) || '';
        mocks.branches = mocks.branches.filter(
          (b) => b.name !== branchName && b.shorthand !== branchName
        );
        return null;
      }
      case 'rename_branch':
        return null;
      case 'checkout_with_autostash': {
        const refName = (args?.refName as string) || '';
        mocks.branches.forEach((b) => { b.isHead = false; });
        const remoteBranch = mocks.branches.find((b) => b.name === refName && b.isRemote);
        if (remoteBranch) {
          const firstSlash = refName.indexOf('/');
          const localName = firstSlash > 0 ? refName.substring(firstSlash + 1) : refName;
          const targetOid = remoteBranch.targetOid || 'checkout-oid';
          const existingLocal = mocks.branches.find((b) => b.name === localName && !b.isRemote);
          if (existingLocal) {
            existingLocal.isHead = true;
            existingLocal.upstream = refName;
          } else {
            mocks.branches.push({
              name: localName,
              shorthand: localName,
              isHead: true,
              isRemote: false,
              upstream: refName,
              targetOid,
              isStale: false,
            } as MockBranch);
          }
        } else {
          const branch = mocks.branches.find((b) => b.name === refName);
          if (branch) branch.isHead = true;
        }
        const newHead = mocks.branches.find((b) => b.isHead);
        if (newHead) mocks.repository.headRef = newHead.name;
        return { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'Switched branch' };
      }

      case 'get_remote_status': {
        // Get ahead/behind from the current branch
        const headBranch = mocks.branches.find((b) => b.isHead);
        if (headBranch?.aheadBehind) {
          return { ahead: headBranch.aheadBehind.ahead, behind: headBranch.aheadBehind.behind };
        }
        return { ahead: 0, behind: 0 };
      }

      // Commit commands
      case 'get_commit_history':
        return mocks.commits;

      case 'get_commit':
        return mocks.commits.find((c) => c.oid === args?.oid) || mocks.commits[0];

      case 'get_refs_by_commit':
        return {};

      case 'create_commit': {
        const oid = 'new-commit-' + Date.now().toString(36);
        const shortId = oid.substring(0, 7);
        const message = (args?.message as string) || '';
        const summary = message.split('\n')[0];
        mocks.commits.unshift({
          oid,
          shortId,
          message,
          summary,
          body: message.includes('\n') ? message.substring(message.indexOf('\n') + 1).trim() : null,
          author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          parentIds: mocks.commits.length > 0 ? [mocks.commits[0].oid] : [],
          timestamp: Date.now() / 1000,
        });
        mocks.status.staged = [];
        return oid;
      }

      // Status commands
      case 'get_status':
        return [...mocks.status.staged, ...mocks.status.unstaged];

      case 'get_staged_files':
        return mocks.status.staged;

      case 'get_unstaged_files':
        return mocks.status.unstaged;

      // Staging mutations
      case 'stage_files': {
        const paths = (args?.paths as string[]) || [];
        const toStage = mocks.status.unstaged.filter((f) => paths.includes(f.path));
        mocks.status.unstaged = mocks.status.unstaged.filter((f) => !paths.includes(f.path));
        mocks.status.staged.push(...toStage.map((f) => ({ ...f, isStaged: true })));
        return null;
      }
      case 'unstage_files': {
        const paths = (args?.paths as string[]) || [];
        const toUnstage = mocks.status.staged.filter((f) => paths.includes(f.path));
        mocks.status.staged = mocks.status.staged.filter((f) => !paths.includes(f.path));
        mocks.status.unstaged.push(...toUnstage.map((f) => ({ ...f, isStaged: false })));
        return null;
      }
      case 'stage_all': {
        const all = mocks.status.unstaged.map((f) => ({ ...f, isStaged: true }));
        mocks.status.staged.push(...all);
        mocks.status.unstaged = [];
        return null;
      }
      case 'unstage_all': {
        const all = mocks.status.staged.map((f) => ({ ...f, isStaged: false }));
        mocks.status.unstaged.push(...all);
        mocks.status.staged = [];
        return null;
      }

      // Stash commands
      case 'get_stashes':
        return mocks.stashes;

      case 'create_stash': {
        const stashMsg = (args?.message as string) || `WIP on ${mocks.repository.headRef || 'HEAD'}`;
        mocks.stashes.unshift({
          index: 0,
          message: stashMsg,
          oid: 'stash-' + Date.now().toString(36),
        });
        mocks.stashes.forEach((s, i) => { s.index = i; });
        mocks.status.unstaged = [];
        return null;
      }
      case 'apply_stash':
        return null;
      case 'pop_stash': {
        const popIndex = (args?.index as number) ?? 0;
        mocks.stashes = mocks.stashes.filter((s) => s.index !== popIndex);
        mocks.stashes.forEach((s, i) => { s.index = i; });
        return null;
      }
      case 'drop_stash': {
        const dropIndex = (args?.index as number) ?? 0;
        mocks.stashes = mocks.stashes.filter((s) => s.index !== dropIndex);
        mocks.stashes.forEach((s, i) => { s.index = i; });
        return null;
      }
      case 'stash_show': {
        const showIndex = (args?.index as number) ?? 0;
        return {
          index: showIndex,
          // Echoed like the real command: the panel checks it before rendering.
          oid: mocks.stashes[showIndex]?.oid ?? '',
          message: mocks.stashes[showIndex]?.message ?? '',
          files: [
            { path: 'src/app.ts', additions: 4, deletions: 2, status: 'modified' },
            { path: 'src/new.ts', additions: 7, deletions: 0, status: 'added' },
          ],
          totalAdditions: 11,
          totalDeletions: 2,
          patch: null,
        };
      }

      // Tag commands
      case 'get_tags':
        return mocks.tags;

      case 'create_tag': {
        const tagName = (args?.name as string) || (args?.tagName as string) || '';
        const tagTarget = (args?.targetOid as string) || mocks.commits[0]?.oid || 'abc123';
        mocks.tags.push({
          name: tagName,
          targetOid: tagTarget,
          message: (args?.message as string) || null,
          tagger: (args?.message as string)
            ? { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 }
            : null,
          isAnnotated: !!(args?.message as string),
        });
        return null;
      }
      case 'delete_tag': {
        const tagToDelete = (args?.name as string) || (args?.tagName as string) || '';
        mocks.tags = mocks.tags.filter((t) => t.name !== tagToDelete);
        return null;
      }
      case 'push_tag':
        return null;
      // Deleting a tag offers to delete the remote copy too — the local
      // delete leaves it behind and the tag fetch refspec restores it.
      case 'delete_remote_tag':
        return null;

      // `git describe` names a commit after the nearest tag below it. The
      // default answer is built from the seeded tag list so the dialog has
      // something real to render; specs that need the untagged repository
      // case override this command with a NO_TAGS_REACHABLE failure.
      case 'describe': {
        const describeTag = mocks.tags[0]?.name ?? 'v1.0.0';
        return {
          description: `${describeTag}-2-gabc123d`,
          tag: describeTag,
          commitsAhead: 2,
          commitHash: 'abc123d',
          isDirty: false,
        };
      }

      // Rewrite commands (cherry-pick, revert, reset, merge, rebase)
      case 'cherry_pick':
      case 'revert':
      case 'reset':
      case 'merge':
      case 'rebase':
      case 'abort_cherry_pick':
      case 'abort_merge':
      case 'abort_rebase':
      case 'abort_revert':
        return null;

      // Remote commands
      case 'get_remotes':
        return mocks.remotes;

      // The remote a fetch/pull/push resolves to before the network gate runs.
      // Unmocked these fell through to the default arm's `null`, so every
      // remote operation silently ran the "could not resolve" fallback and no
      // test ever saw the remote the app actually picked.
      //
      // An explicit `remote` wins, mirroring the backend's resolve_*_remote,
      // which hands back the requested remote untouched. The tag force-push
      // retry re-resolves the destination the rejected push was aimed at, so
      // ignoring the argument here answered `origin` for a push aimed at
      // `upstream`. This must stay the ONLY arm for these three commands —
      // a second `case 'get_push_remote'` later in the switch is unreachable.
      case 'get_fetch_remote':
      case 'get_pull_remote':
      case 'get_push_remote':
        return (args?.remote as string) ?? mocks.remotes[0]?.name ?? 'origin';

      case 'fetch':
        return null;
      case 'push': {
        const headForPush = mocks.branches.find((b) => b.isHead);
        if (headForPush?.aheadBehind) headForPush.aheadBehind.ahead = 0;
        return null;
      }
      case 'pull': {
        const headForPull = mocks.branches.find((b) => b.isHead);
        if (headForPull?.aheadBehind) headForPull.aheadBehind.behind = 0;
        return null;
      }

      // Diff commands
      case 'get_diff':
      case 'get_file_diff': {
        // get_file_diff sends { path: repoPath, filePath, staged }
        const filePathArg = (args?.filePath as string) || (args?.path as string) || 'src/main.ts';
        // Check if this is an image file
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];
        const isImage = imageExtensions.some(ext => filePathArg.toLowerCase().endsWith(ext));
        const imageType = isImage ? filePathArg.split('.').pop()?.toLowerCase() || 'png' : null;
        return {
          path: filePathArg,
          oldPath: null,
          status: 'modified',
          hunks: isImage ? [] : [
            {
              header: '@@ -1,5 +1,6 @@',
              oldStart: 1,
              oldLines: 5,
              newStart: 1,
              newLines: 6,
              lines: [
                { content: 'line 1', origin: 'context', oldLineNo: 1, newLineNo: 1 },
                { content: 'line 2', origin: 'deletion', oldLineNo: 2, newLineNo: null },
                { content: 'new line 2', origin: 'addition', oldLineNo: null, newLineNo: 2 },
              ],
            },
          ],
          isBinary: isImage,
          isImage,
          imageType,
          additions: isImage ? 0 : 1,
          deletions: isImage ? 0 : 1,
        };
      }

      case 'get_image_versions': {
        // Return mock image data - small 2x2 red/green PNG images encoded in base64
        // Old image: 2x2 red pixels
        const oldImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQI12P4z8DwHwAFAAH/plkKSgAAAABJRU5ErkJggg==';
        // New image: 2x2 green pixels
        const newImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQI12Ng+M/AAAADhAH/hc2rNAAAAABJRU5ErkJggg==';
        // get_image_versions sends { path: repoPath, filePath, staged }
        const imageFilePath = (args?.filePath as string) || (args?.path as string) || 'image.png';
        const imageType = imageFilePath.split('.').pop()?.toLowerCase() || 'png';
        return {
          path: imageFilePath,
          oldData: oldImageBase64,
          newData: newImageBase64,
          oldSize: [2, 2] as [number, number],
          newSize: [2, 2] as [number, number],
          imageType,
        };
      }

      // Profile commands
      case 'get_profiles':
        return [{ id: 'default', name: 'Default', gitName: 'Test User', gitEmail: 'test@example.com' }];

      case 'get_active_profile':
        return { id: 'default', name: 'Default', gitName: 'Test User', gitEmail: 'test@example.com' };

      // Integration account commands
      case 'get_integration_accounts':
        return [];

      // AI commands
      case 'get_ai_model_status':
        return { available: false, downloading: false };

      case 'generate_commit_message':
        return { summary: 'Auto-generated commit', body: null };

      // AI availability
      case 'is_ai_available':
        return false;
      // Null = "AI is usable"; a test wanting the unavailable-provider UI
      // overrides this with { reason, providerSelected }.
      case 'ai_unavailable_reason':
        return null;

      // AI provider commands
      case 'get_ai_providers':
        return [
          { providerType: 'local_inference', name: 'Local AI (Embedded)', available: false, requiresApiKey: false, hasApiKey: false, endpoint: '', models: [], selectedModel: null },
          { providerType: 'ollama', name: 'Ollama', available: false, requiresApiKey: false, hasApiKey: false, endpoint: 'http://localhost:11434', models: [], selectedModel: null },
          { providerType: 'anthropic', name: 'Anthropic Claude', available: false, requiresApiKey: true, hasApiKey: false, endpoint: 'https://api.anthropic.com', models: [], selectedModel: null },
        ];
      case 'get_active_ai_provider':
        return null;
      case 'set_ai_provider':
      case 'set_ai_api_key':
      case 'set_ai_model':
      case 'test_ai_provider':
        return null;

      // Local AI commands
      case 'get_system_capabilities':
        return { totalRamBytes: 16000000000, availableRamBytes: 8000000000, gpuInfo: null, recommendedTier: 'standard', gpuAccelerationAvailable: true };
      case 'get_available_models':
        return [
          { id: 'gemma-3-1b-q4km', displayName: 'Gemma 3 1B (Q4_K_M)', hfRepo: 'unsloth/gemma-3-1b-it-GGUF', hfFilename: 'gemma-3-1b-it-Q4_K_M.gguf', sha256: '', sizeBytes: 700000000, minRamBytes: 8000000000, tier: 'ultra_light', architecture: 'gemma3', contextLength: 8192 },
        ];
      case 'get_downloaded_models':
        return [];
      case 'get_model_status':
        return 'unloaded';
      case 'get_loaded_model_name':
        return null;
      case 'get_recommended_model':
        return null;
      case 'load_model':
      case 'unload_model':
      case 'download_model':
      case 'cancel_model_download':
      case 'delete_model':
        return null;

      // Settings
      case 'get_settings':
        return mocks.settings;

      // GitHub commands
      case 'check_github_connection':
        return { connected: false, user: null, scopes: [] };

      case 'detect_github_repo':
        return null;

      // Template commands
      case 'list_templates':
        return [];
      case 'save_template':
        return args?.template || null;
      case 'get_commit_template':
        return null;
      case 'get_conventional_types':
        return [
          { typeName: 'feat', description: 'A new feature', emoji: null },
          { typeName: 'fix', description: 'A bug fix', emoji: null },
          { typeName: 'docs', description: 'Documentation only changes', emoji: null },
          { typeName: 'style', description: 'Code style changes', emoji: null },
          { typeName: 'refactor', description: 'Code refactoring', emoji: null },
          { typeName: 'test', description: 'Adding tests', emoji: null },
          { typeName: 'chore', description: 'Maintenance tasks', emoji: null },
        ];

      // Identity
      case 'get_user_identity':
        return { name: 'Test User', email: 'test@example.com' };

      // Unified profile commands
      case 'get_unified_profiles_config':
        return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
      case 'save_global_account':
        return args;
      case 'update_global_account_cached_user':
      case 'load_unified_profile_for_repository':
        return null;

      // Credential/vault commands
      case 'get_machine_vault_password':
        return 'test-vault-password';
      case 'store_git_credentials':
      case 'delete_git_credentials':
        return null;

      // Integration detection commands
      case 'detect_ado_repo':
      case 'detect_gitlab_repo':
      case 'detect_bitbucket_repo':
        return null;

      // Integration connection commands
      case 'check_ado_connection':
      case 'check_gitlab_connection':
      case 'check_bitbucket_connection':
      case 'check_bitbucket_connection_with_token':
        return { connected: false, user: null };

      // Default - log unmocked commands
      default:
        console.warn(`[Tauri Mock] Unmocked command: ${command}`, args);
        return null;
    }
  };
}

/**
 * Setup Tauri mocks on a Playwright page
 *
 * @param page - Playwright page instance
 * @param customMocks - Optional custom mock data to merge with defaults
 */
export async function setupTauriMocks(
  page: Page,
  customMocks?: Partial<typeof defaultMockData>
): Promise<void> {
  const mocks = { ...defaultMockData, ...customMocks };

  // Inject the mock before any page scripts run
  await page.addInitScript(
    ({ mockData }) => {
      // Deep clone mock data into mutable state that mutations can update
      const state = JSON.parse(JSON.stringify(mockData)) as typeof defaultMockData;

      // === Backend event delivery ===
      // Tauri's `listen()` registers a JS callback through `transformCallback`
      // and then invokes `plugin:event|listen` with that callback's id. Keep
      // both so tests can emit backend events the app really listens to.
      const eventCallbacks = new Map<number, (e: unknown) => void>();
      const eventListeners = new Map<number, { event: string; cb: (e: unknown) => void }>();
      let nextCallbackId = 1;

      // `unlisten()` from @tauri-apps/api calls into the event plugin's own
      // internals before the IPC round trip, so it has to exist for teardown.
      (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {},
      };

      (window as unknown as Record<string, unknown>).__EMIT_TAURI_EVENT__ = (
        event: string,
        payload: unknown
      ) => {
        for (const listener of eventListeners.values()) {
          if (listener.event === event) {
            listener.cb({ event, id: 0, payload });
          }
        }
      };

      const commandHandler = (command: string, args?: Record<string, unknown>): unknown => {
        switch (command) {
          case 'open_repository':
          case 'get_repository_info':
            return state.repository;
          case 'get_recent_repositories':
            return [state.repository];
          case 'get_branches':
            return state.branches;
          case 'get_current_branch':
            return state.branches.find((b: MockBranch) => b.isHead) || null;
          case 'compare_branches': {
            const compareArgs = (args ?? {}) as {
              base?: string;
              compare?: string;
              includeCommits?: boolean;
              includeFiles?: boolean;
            };
            return {
              baseRef: compareArgs.base ?? '',
              compareRef: compareArgs.compare ?? '',
              ahead: 1,
              behind: 0,
              mergeBase: 'abc123def456',
              commitsAhead: compareArgs.includeCommits
                ? [
                    {
                      oid: 'def456abc789',
                      shortOid: 'def456a',
                      message: 'Add the feature',
                      authorName: 'Test User',
                      authorDate: Math.floor(Date.now() / 1000),
                    },
                  ]
                : null,
              commitsBehind: compareArgs.includeCommits ? [] : null,
              filesChanged: compareArgs.includeFiles
                ? [
                    {
                      path: 'src/feature.ts',
                      status: 'modified',
                      additions: 12,
                      deletions: 4,
                      oldPath: null,
                    },
                  ]
                : null,
              totalAdditions: 12,
              totalDeletions: 4,
            };
          }
          case 'get_remote_status': {
            const headBranch = state.branches.find((b: MockBranch) => b.isHead);
            if (headBranch?.aheadBehind) {
              return { ahead: headBranch.aheadBehind.ahead, behind: headBranch.aheadBehind.behind };
            }
            return { ahead: 0, behind: 0 };
          }
          case 'get_commit_history':
            return state.commits;
          case 'get_commit':
            return (
              state.commits.find((c: MockCommit) => c.oid === (args as { oid?: string })?.oid) ||
              state.commits[0]
            );
          case 'get_refs_by_commit':
            return {};
          case 'get_status':
            return [...state.status.staged, ...state.status.unstaged];
          case 'get_staged_files':
            return state.status.staged;
          case 'get_unstaged_files':
            return state.status.unstaged;
          case 'get_stashes':
            return state.stashes;
          case 'get_tags':
            return state.tags;
          case 'get_remotes':
            return state.remotes;
          // See the other builder's switch: an explicit `remote` wins, and
          // this is the ONLY arm for these three commands.
          case 'get_fetch_remote':
          case 'get_pull_remote':
          case 'get_push_remote':
            return (
              (args as { remote?: string })?.remote ??
              state.remotes[0]?.name ??
              'origin'
            );
          case 'get_profiles':
            return [
              { id: 'default', name: 'Default', gitName: 'Test User', gitEmail: 'test@example.com' },
            ];
          case 'get_active_profile':
            return {
              id: 'default',
              name: 'Default',
              gitName: 'Test User',
              gitEmail: 'test@example.com',
            };
          case 'get_integration_accounts':
            return [];
          case 'get_ai_model_status':
            return { available: false, downloading: false };
          case 'check_github_connection':
            return { connected: false, user: null, scopes: [] };
          case 'detect_github_repo':
            return null;
          case 'get_settings':
            return state.settings;
          case 'get_diff':
          case 'get_file_diff': {
            // get_file_diff sends { path: repoPath, filePath, staged }
            const filePathArg = (args as { filePath?: string; path?: string })?.filePath || (args as { path?: string })?.path || 'src/main.ts';
            // Check if this is an image file
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];
            const isImage = imageExtensions.some(ext => filePathArg.toLowerCase().endsWith(ext));
            const imageType = isImage ? filePathArg.split('.').pop()?.toLowerCase() || 'png' : null;
            return {
              path: filePathArg,
              oldPath: null,
              status: 'modified',
              hunks: [],
              isBinary: isImage,
              isImage,
              imageType,
              additions: isImage ? 0 : 1,
              deletions: isImage ? 0 : 1,
            };
          }
          case 'get_image_versions': {
            // Return mock image data - small 2x2 red/green PNG images encoded in base64
            // Old image: 2x2 red pixels
            const oldImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQI12P4z8DwHwAFAAH/plkKSgAAAABJRU5ErkJggg==';
            // New image: 2x2 green pixels
            const newImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQI12Ng+M/AAAADhAH/hc2rNAAAAABJRU5ErkJggg==';
            // get_image_versions sends { path: repoPath, filePath, staged }
            const imageFilePath = (args as { filePath?: string; path?: string })?.filePath || (args as { path?: string })?.path || 'image.png';
            const imageType = imageFilePath.split('.').pop()?.toLowerCase() || 'png';
            return {
              path: imageFilePath,
              oldData: oldImageBase64,
              newData: newImageBase64,
              oldSize: [2, 2] as [number, number],
              newSize: [2, 2] as [number, number],
              imageType,
            };
          }
          // === Staging mutations ===
          case 'stage_files': {
            const paths = ((args as { paths?: string[] })?.paths) || [];
            const toStage = state.status.unstaged.filter((f: MockStatusEntry) => paths.includes(f.path));
            state.status.unstaged = state.status.unstaged.filter((f: MockStatusEntry) => !paths.includes(f.path));
            state.status.staged.push(...toStage.map((f: MockStatusEntry) => ({ ...f, isStaged: true })));
            return null;
          }
          case 'unstage_files': {
            const paths = ((args as { paths?: string[] })?.paths) || [];
            const toUnstage = state.status.staged.filter((f: MockStatusEntry) => paths.includes(f.path));
            state.status.staged = state.status.staged.filter((f: MockStatusEntry) => !paths.includes(f.path));
            state.status.unstaged.push(...toUnstage.map((f: MockStatusEntry) => ({ ...f, isStaged: false })));
            return null;
          }
          case 'stage_all': {
            const all = state.status.unstaged.map((f: MockStatusEntry) => ({ ...f, isStaged: true }));
            state.status.staged.push(...all);
            state.status.unstaged = [];
            return null;
          }
          case 'unstage_all': {
            const all = state.status.staged.map((f: MockStatusEntry) => ({ ...f, isStaged: false }));
            state.status.unstaged.push(...all);
            state.status.staged = [];
            return null;
          }

          // === Branch mutations ===
          case 'checkout':
          case 'checkout_branch': {
            const refName = ((args as { refName?: string })?.refName) || ((args as { name?: string })?.name) || '';
            // Clear isHead on all branches
            state.branches.forEach((b: MockBranch) => { b.isHead = false; });
            const remoteBranch = state.branches.find((b: MockBranch) => b.name === refName && b.isRemote);
            if (remoteBranch) {
              // Remote branch checkout: create local tracking branch
              const firstSlash = refName.indexOf('/');
              const localName = firstSlash > 0 ? refName.substring(firstSlash + 1) : refName;
              const targetOid = remoteBranch.targetOid || 'checkout-oid';
              const existingLocal = state.branches.find((b: MockBranch) => b.name === localName && !b.isRemote);
              if (existingLocal) {
                existingLocal.isHead = true;
                existingLocal.upstream = refName;
              } else {
                state.branches.push({
                  name: localName,
                  shorthand: localName,
                  isHead: true,
                  isRemote: false,
                  upstream: refName,
                  targetOid,
                  isStale: false,
                } as MockBranch);
              }
            } else {
              const branch = state.branches.find((b: MockBranch) => b.name === refName);
              if (branch) branch.isHead = true;
            }
            const newHead = state.branches.find((b: MockBranch) => b.isHead);
            if (newHead) state.repository.headRef = newHead.name;
            return null;
          }
          case 'create_branch': {
            const name = (args as { name?: string })?.name || '';
            const startPoint = (args as { startPoint?: string })?.startPoint || state.commits[0]?.oid || 'abc123';
            state.branches.push({
              name,
              shorthand: name,
              isHead: false,
              isRemote: false,
              upstream: null,
              targetOid: startPoint,
              isStale: false,
            } as MockBranch);
            return null;
          }
          case 'delete_branch': {
            const branchName = (args as { name?: string })?.name || '';
            state.branches = state.branches.filter(
              (b: MockBranch) => b.name !== branchName && b.shorthand !== branchName
            );
            return null;
          }
          case 'rename_branch':
            return null;
          case 'checkout_with_autostash': {
            const refName = ((args as { refName?: string })?.refName) || '';
            // Clear isHead on all branches
            state.branches.forEach((b: MockBranch) => { b.isHead = false; });
            const remoteBranch = state.branches.find((b: MockBranch) => b.name === refName && b.isRemote);
            if (remoteBranch) {
              const firstSlash = refName.indexOf('/');
              const localName = firstSlash > 0 ? refName.substring(firstSlash + 1) : refName;
              const targetOid = remoteBranch.targetOid || 'checkout-oid';
              const existingLocal = state.branches.find((b: MockBranch) => b.name === localName && !b.isRemote);
              if (existingLocal) {
                existingLocal.isHead = true;
                existingLocal.upstream = refName;
              } else {
                state.branches.push({
                  name: localName,
                  shorthand: localName,
                  isHead: true,
                  isRemote: false,
                  upstream: refName,
                  targetOid,
                  isStale: false,
                } as MockBranch);
              }
            } else {
              const branch = state.branches.find((b: MockBranch) => b.name === refName);
              if (branch) branch.isHead = true;
            }
            const newHead = state.branches.find((b: MockBranch) => b.isHead);
            if (newHead) state.repository.headRef = newHead.name;
            return { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'Switched branch' };
          }

          // === Commit mutations ===
          case 'create_commit': {
            const oid = 'new-commit-' + Date.now().toString(36);
            const shortId = oid.substring(0, 7);
            const message = (args as { message?: string })?.message || '';
            const summary = message.split('\n')[0];
            state.commits.unshift({
              oid,
              shortId,
              message,
              summary,
              body: message.includes('\n') ? message.substring(message.indexOf('\n') + 1).trim() : null,
              author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
              committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
              parentIds: state.commits.length > 0 ? [state.commits[0].oid] : [],
              timestamp: Date.now() / 1000,
            } as MockCommit);
            state.status.staged = [];
            return oid;
          }

          // === Tag mutations ===
          case 'create_tag': {
            const tagName = (args as { name?: string; tagName?: string })?.name || (args as { tagName?: string })?.tagName || '';
            const targetOid = (args as { targetOid?: string })?.targetOid || state.commits[0]?.oid || 'abc123';
            state.tags.push({
              name: tagName,
              targetOid,
              message: (args as { message?: string })?.message || null,
              tagger: (args as { message?: string })?.message
                ? { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 }
                : null,
              isAnnotated: !!(args as { message?: string })?.message,
            } as MockTag);
            return null;
          }
          case 'delete_tag': {
            const tagToDelete = (args as { name?: string; tagName?: string })?.name || (args as { tagName?: string })?.tagName || '';
            state.tags = state.tags.filter((t: MockTag) => t.name !== tagToDelete);
            return null;
          }
          case 'push_tag':
            return null;
          // See the other builder's switch — tag delete offers the remote too.
          case 'delete_remote_tag':
            return null;

          // `git describe` names a commit after the nearest tag below it. The
          // default answer is built from the seeded tag list so the dialog has
          // something real to render; specs that need the untagged repository
          // case override this command with a NO_TAGS_REACHABLE failure.
          case 'describe': {
            const describeTag = state.tags[0]?.name ?? 'v1.0.0';
            return {
              description: `${describeTag}-2-gabc123d`,
              tag: describeTag,
              commitsAhead: 2,
              commitHash: 'abc123d',
              isDirty: false,
            };
          }

          // === Stash mutations ===
          case 'create_stash': {
            const stashMsg = (args as { message?: string })?.message || `WIP on ${state.repository.headRef || 'HEAD'}`;
            state.stashes.unshift({
              index: 0,
              message: stashMsg,
              oid: 'stash-' + Date.now().toString(36),
            } as MockStash);
            state.stashes.forEach((s: MockStash, i: number) => { s.index = i; });
            state.status.unstaged = [];
            return null;
          }
          case 'apply_stash':
            return null;
          case 'pop_stash': {
            const popIndex = (args as { index?: number })?.index ?? 0;
            state.stashes = state.stashes.filter((s: MockStash) => s.index !== popIndex);
            state.stashes.forEach((s: MockStash, i: number) => { s.index = i; });
            return null;
          }
          case 'drop_stash': {
            const dropIndex = (args as { index?: number })?.index ?? 0;
            state.stashes = state.stashes.filter((s: MockStash) => s.index !== dropIndex);
            state.stashes.forEach((s: MockStash, i: number) => { s.index = i; });
            return null;
          }
          case 'stash_show': {
            const showIndex = (args as { index?: number })?.index ?? 0;
            return {
              index: showIndex,
              // Echoed like the real command: the panel checks it first.
              oid: state.stashes[showIndex]?.oid ?? '',
              message: state.stashes[showIndex]?.message ?? '',
              files: [
                { path: 'src/app.ts', additions: 4, deletions: 2, status: 'modified' },
                { path: 'src/new.ts', additions: 7, deletions: 0, status: 'added' },
              ],
              totalAdditions: 11,
              totalDeletions: 2,
              patch: null,
            };
          }

          // === Remote mutations ===
          case 'fetch':
            return null;
          case 'push': {
            const headForPush = state.branches.find((b: MockBranch) => b.isHead);
            if (headForPush?.aheadBehind) headForPush.aheadBehind.ahead = 0;
            return null;
          }
          case 'pull': {
            const headForPull = state.branches.find((b: MockBranch) => b.isHead);
            if (headForPull?.aheadBehind) headForPull.aheadBehind.behind = 0;
            return null;
          }

          // === Rewrite commands ===
          case 'cherry_pick':
          case 'revert':
          case 'reset':
          case 'merge':
          case 'rebase':
          case 'abort_cherry_pick':
          case 'abort_merge':
          case 'abort_rebase':
          case 'abort_revert':
            return null;

          // === Template commands ===
          case 'list_templates':
            return [];
          case 'save_template':
            return (args as { template?: unknown })?.template || null;
          case 'get_commit_template':
            return null;
          case 'get_conventional_types':
            return [
              { typeName: 'feat', description: 'A new feature', emoji: null },
              { typeName: 'fix', description: 'A bug fix', emoji: null },
              { typeName: 'docs', description: 'Documentation only changes', emoji: null },
              { typeName: 'style', description: 'Code style changes', emoji: null },
              { typeName: 'refactor', description: 'Code refactoring', emoji: null },
              { typeName: 'test', description: 'Adding tests', emoji: null },
              { typeName: 'chore', description: 'Maintenance tasks', emoji: null },
            ];

          // === AI commands ===
          case 'is_ai_available':
            return false;
          case 'ai_unavailable_reason':
            return null;
          case 'generate_commit_message':
            return { summary: 'Auto-generated commit', body: null };
          case 'get_ai_providers':
            return [
              { providerType: 'local_inference', name: 'Local AI (Embedded)', available: false, requiresApiKey: false, hasApiKey: false, endpoint: '', models: [], selectedModel: null },
            ];
          case 'get_active_ai_provider':
            return null;
          case 'set_ai_provider':
          case 'set_ai_api_key':
          case 'set_ai_model':
          case 'test_ai_provider':
            return null;
          case 'get_system_capabilities':
            return { totalRamBytes: 16000000000, availableRamBytes: 8000000000, gpuInfo: null, recommendedTier: 'standard', gpuAccelerationAvailable: true };
          case 'get_available_models':
            return [];
          case 'get_downloaded_models':
            return [];
          case 'get_model_status':
            return 'unloaded';
          case 'get_loaded_model_name':
            return null;
          case 'get_recommended_model':
            return null;
          case 'load_model':
          case 'unload_model':
          case 'download_model':
          case 'cancel_model_download':
          case 'delete_model':
            return null;

          // === Identity commands ===
          case 'get_user_identity':
            return { name: 'Test User', email: 'test@example.com' };

          // === Unified profile commands ===
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'save_global_account':
            return args;
          case 'update_global_account_cached_user':
          case 'load_unified_profile_for_repository':
            return null;

          // === Credential/vault commands ===
          case 'get_machine_vault_password':
            return 'test-vault-password';
          case 'store_git_credentials':
          case 'delete_git_credentials':
            return null;

          // === Statistics commands ===
          case 'get_repo_statistics':
            return {
              totalCommits: 0,
              totalBranches: 0,
              totalTags: 0,
              totalContributors: 0,
              totalFiles: 0,
              repoSizeBytes: 0,
              firstCommitDate: null,
              lastCommitDate: null,
              repoAgeDays: 0,
              activityByMonth: [],
              activityByWeekday: [],
              activityByHour: [],
              topContributors: [],
              fileTypes: [],
              totalLinesAdded: 0,
              totalLinesDeleted: 0,
            };

          // === Git notes commands ===
          case 'get_notes_refs': {
            const refs = [...new Set(state.notes.map((n: MockNote) => n.notesRef))];
            // Mirrors the backend: the default ref is always reported, even
            // when the repo only keeps notes in custom refs, so the selector
            // always has a valid write target.
            if (!refs.includes('refs/notes/commits')) refs.push('refs/notes/commits');
            return refs;
          }
          case 'get_note': {
            const ref = (args?.notesRef as string) ?? 'refs/notes/commits';
            return (
              state.notes.find(
                (n: MockNote) => n.notesRef === ref && n.commitOid === args?.commitOid,
              ) ?? null
            );
          }
          case 'get_notes': {
            const ref = (args?.notesRef as string) ?? 'refs/notes/commits';
            return state.notes.filter((n: MockNote) => n.notesRef === ref);
          }
          case 'set_note': {
            const note: MockNote = {
              commitOid: args?.commitOid as string,
              message: args?.message as string,
              notesRef: (args?.notesRef as string) ?? 'refs/notes/commits',
            };
            const existing = state.notes.findIndex(
              (n: MockNote) => n.notesRef === note.notesRef && n.commitOid === note.commitOid,
            );
            if (existing >= 0) state.notes[existing] = note;
            else state.notes.push(note);
            return note;
          }
          case 'remove_note': {
            const ref = (args?.notesRef as string) ?? 'refs/notes/commits';
            state.notes = state.notes.filter(
              (n: MockNote) => !(n.notesRef === ref && n.commitOid === args?.commitOid),
            );
            return null;
          }
          // === Git Flow ===
          case 'get_gitflow_config':
            return state.gitflowConfig;

          // === Integration detection commands ===
          case 'detect_ado_repo':
          case 'detect_gitlab_repo':
          case 'detect_bitbucket_repo':
            return null;

          // === Integration connection commands ===
          case 'check_ado_connection':
          case 'check_gitlab_connection':
          case 'check_bitbucket_connection':
          case 'check_bitbucket_connection_with_token':
            return { connected: false, user: null };

          default:
            console.warn(`[Tauri Mock] Unmocked command: ${command}`, args);
            return null;
        }
      };

      const handler = (command: string, args?: Record<string, unknown>): unknown => {
        switch (command) {
          case 'plugin:event|listen': {
            const cb = eventCallbacks.get(args?.handler as number);
            const id = nextCallbackId++;
            if (cb) eventListeners.set(id, { event: args?.event as string, cb });
            return id;
          }
          case 'plugin:event|unlisten':
            eventListeners.delete(args?.eventId as number);
            return null;
        }
        return commandHandler(command, args);
      };

      // Set up the Tauri internals mock
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          return handler(command, args);
        },
        transformCallback: (cb: (e: unknown) => void) => {
          const id = nextCallbackId++;
          eventCallbacks.set(id, cb);
          return id;
        },
        convertFileSrc: (path: string) => path,
      };

      // Also mock the event system
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        ...((window as unknown as Record<string, Record<string, unknown>>)
          .__TAURI_INTERNALS__ ?? {}),
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      };
    },
    { mockData: mocks }
  );
}

/**
 * Create mock data with modified files in the working directory
 */
export function withModifiedFiles(files: MockStatusEntry[]): Partial<typeof defaultMockData> {
  return {
    status: {
      staged: [],
      unstaged: files,
    },
  };
}

/**
 * Create mock data with staged files ready to commit
 */
export function withStagedFiles(files: MockStatusEntry[]): Partial<typeof defaultMockData> {
  return {
    status: {
      staged: files.map((f) => ({ ...f, isStaged: true })),
      unstaged: [],
    },
  };
}

/**
 * Create mock data for an empty/new repository
 */
export function emptyRepository(): Partial<typeof defaultMockData> {
  return {
    repository: {
      ...defaultMockData.repository,
      headRef: null,
    },
    branches: [],
    commits: [],
    status: { staged: [], unstaged: [] },
    stashes: [],
    tags: [],
  };
}

/**
 * Create mock data for a repository with conflicts
 */
export function withConflicts(): Partial<typeof defaultMockData> {
  return {
    repository: {
      ...defaultMockData.repository,
      state: 'merge',
    },
    status: {
      staged: [],
      unstaged: [{ path: 'CONFLICT.md', status: 'conflicted', isStaged: false, isConflicted: true }],
    },
  };
}

/**
 * Initialize the repository store with mock data.
 * Call this after page.goto() to simulate an open repository.
 *
 * @param page - Playwright page instance
 * @param customMocks - Optional custom mock data
 */
export async function initializeRepositoryStore(
  page: Page,
  customMocks?: Partial<typeof defaultMockData>
): Promise<void> {
  const mocks = { ...defaultMockData, ...customMocks };

  // Wait for stores to be available
  await page.waitForFunction(() => {
    return typeof (window as unknown as Record<string, unknown>).__GITNADO_STORES__ !== 'undefined';
  }, { timeout: 10000 });

  // Initialize the repository store with mock data
  await page.evaluate(
    ({ repository, branches, stashes, tags, status }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: {
          getState: () => {
            addRepository: (repo: unknown) => void;
            setBranches: (branches: unknown[]) => void;
            setStashes: (stashes: unknown[]) => void;
            setTags: (tags: unknown[]) => void;
            setStatus: (status: unknown[]) => void;
            setCurrentBranch: (branch: unknown) => void;
          };
        };
      };

      if (!stores?.repositoryStore) {
        throw new Error('Repository store not available');
      }

      const state = stores.repositoryStore.getState();

      // Add the repository to open it
      state.addRepository(repository);

      // Set branches, stashes, tags, and status
      state.setBranches(branches);
      state.setStashes(stashes);
      state.setTags(tags);
      state.setStatus([...status.staged, ...status.unstaged]);

      // Set current branch
      const currentBranch = branches.find((b: { isHead?: boolean }) => b.isHead);
      if (currentBranch) {
        state.setCurrentBranch(currentBranch);
      }
    },
    {
      repository: mocks.repository,
      branches: mocks.branches,
      stashes: mocks.stashes,
      tags: mocks.tags,
      status: mocks.status,
    }
  );

  await page.waitForFunction(() => {
    const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
      repositoryStore?: { getState: () => { openRepositories: unknown[] } };
    } | undefined;
    return (stores?.repositoryStore?.getState()?.openRepositories?.length ?? 0) > 0;
  });
}

/**
 * Combined setup: Tauri mocks + repository store initialization.
 * This is the recommended way to set up tests that need an open repository.
 *
 * @param page - Playwright page instance
 * @param customMocks - Optional custom mock data
 */
export async function setupOpenRepository(
  page: Page,
  customMocks?: Partial<typeof defaultMockData>
): Promise<void> {
  // First set up Tauri IPC mocks
  await setupTauriMocks(page, customMocks);

  // Navigate to the app
  await page.goto('/');

  // Wait for app to load
  await page.waitForLoadState('domcontentloaded');

  // Initialize the repository store
  await initializeRepositoryStore(page, customMocks);
}

/**
 * Helper to create mock data with vim mode enabled
 */
export function withVimMode(): Partial<typeof defaultMockData> {
  return {
    settings: {
      ...defaultMockData.settings,
      vimMode: true,
    },
  };
}

// =============================================================================
// Profile and Account Types for E2E Tests
// =============================================================================

export interface MockUnifiedProfile {
  id: string;
  name: string;
  gitName: string;
  gitEmail: string;
  signingKey: string | null;
  urlPatterns: string[];
  isDefault: boolean;
  color: string;
  defaultAccounts: Partial<Record<'github' | 'gitlab' | 'azure-devops' | 'bitbucket', string>>;
}

export interface MockIntegrationAccount {
  id: string;
  name: string;
  integrationType: 'github' | 'gitlab' | 'azure-devops' | 'bitbucket';
  config: { type: string; instanceUrl?: string; organization?: string; workspace?: string };
  color: string | null;
  cachedUser: { username: string; displayName: string; avatarUrl: string | null } | null;
  urlPatterns: string[];
  isDefault: boolean;
}

export interface ProfilesAndAccountsOptions {
  profiles: MockUnifiedProfile[];
  accounts: MockIntegrationAccount[];
  repositoryAssignments?: Record<string, string>;
  /** Account IDs that are connected (have valid tokens) */
  connectedAccounts?: string[];
}

/**
 * Initialize the unified profile store with profiles and accounts.
 * Call this after page.goto() to set up test profiles and accounts.
 *
 * @param page - Playwright page instance
 * @param options - Profiles and accounts configuration
 */
export async function initializeUnifiedProfileStore(
  page: Page,
  options: ProfilesAndAccountsOptions
): Promise<void> {
  // Wait for stores to be available
  await page.waitForFunction(() => {
    return typeof (window as unknown as Record<string, unknown>).__GITNADO_STORES__ !== 'undefined' &&
           typeof ((window as unknown as Record<string, unknown>).__GITNADO_STORES__ as Record<string, unknown>).unifiedProfileStore !== 'undefined';
  }, { timeout: 10000 });

  // Initialize the unified profile store with test data
  await page.evaluate(
    ({ profiles, accounts, repositoryAssignments, connectedAccounts }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        unifiedProfileStore: {
          getState: () => {
            setConfig: (config: unknown) => void;
            setProfiles: (profiles: unknown[]) => void;
            setAccounts: (accounts: unknown[]) => void;
            setActiveProfile: (profile: unknown) => void;
            setAccountConnectionStatus: (accountId: string, status: string) => void;
          };
        };
      };

      if (!stores?.unifiedProfileStore) {
        throw new Error('Unified profile store not available');
      }

      const state = stores.unifiedProfileStore.getState();

      // Set the full config
      const config = {
        version: 3,
        profiles,
        accounts,
        repositoryAssignments: repositoryAssignments ?? {},
      };
      state.setConfig(config);

      // Set the active profile (first default or first profile)
      const defaultProfile = profiles.find((p: { isDefault?: boolean }) => p.isDefault) || profiles[0];
      if (defaultProfile) {
        state.setActiveProfile(defaultProfile);
      }

      // Set connection status for connected accounts
      if (connectedAccounts && connectedAccounts.length > 0) {
        for (const accountId of connectedAccounts) {
          state.setAccountConnectionStatus(accountId, 'connected');
        }
      }
    },
    {
      profiles: options.profiles,
      accounts: options.accounts,
      repositoryAssignments: options.repositoryAssignments ?? {},
      connectedAccounts: options.connectedAccounts ?? [],
    }
  );

  await page.waitForFunction(() => {
    const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
      unifiedProfileStore?: { getState: () => { profiles: unknown[] } };
    } | undefined;
    return (stores?.unifiedProfileStore?.getState()?.profiles?.length ?? 0) > 0;
  });
}

/**
 * Combined setup: Tauri mocks + repository store + unified profile store.
 * Use this to set up tests that need an open repository with specific profiles/accounts.
 *
 * @param page - Playwright page instance
 * @param options - Profiles and accounts configuration
 * @param customMocks - Optional custom mock data for repository
 */
export async function setupProfilesAndAccounts(
  page: Page,
  options: ProfilesAndAccountsOptions,
  customMocks?: Partial<typeof defaultMockData>
): Promise<void> {
  // First set up Tauri IPC mocks - include profile/account data in mocks
  await setupTauriMocks(page, customMocks);

  // Navigate to the app
  await page.goto('/');

  // Wait for app to load
  await page.waitForLoadState('domcontentloaded');

  // Initialize the repository store
  await initializeRepositoryStore(page, customMocks);

  // Initialize the unified profile store with profiles and accounts
  await initializeUnifiedProfileStore(page, options);
}
