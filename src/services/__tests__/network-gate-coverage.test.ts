/**
 * Exhaustive guard on the network gate's coverage.
 *
 * Twice now the gate has shipped covering less than it claimed, both times for
 * the same reason: coverage was a hand-written list, so it only held what
 * someone remembered to add. Round 18 missed six operations. Round 19 missed a
 * seventh (`prune_remote_tracking_branches`) plus every hosting-provider API —
 * and the test written to catch that class of gap missed them too, because it
 * was another hand-written list of *functions*.
 *
 * This test inverts it. It turns offline mode on, calls EVERY exported function
 * in the services that can reach the network, and asserts that not one of them
 * reaches a command known to make an outbound request. Adding an ungated
 * network call fails this test without anyone having to remember to register it.
 *
 * Round 20 showed the inversion was only half done: the sweep enumerated
 * git.service and nothing else, so `download_model` (multi-GB, huggingface.co),
 * `download_embedding_model` and the two GitHub App endpoints in
 * credential.service shipped with no frontend gate and a green suite.
 *
 * And the claim that followed — "every service that invokes a command capable
 * of leaving the machine is swept here" — was false while it stood:
 * unified-profile.service checks a GitLab, Azure DevOps or Bitbucket account
 * against that provider's API every five minutes on a background timer, and
 * three of its four provider branches went straight to `invokeCommand`. It is
 * swept now, and driven with real accounts (see `drivenCalls`), because a
 * module whose arguments never reach an invoke is coverage on paper only.
 *
 * Every service that invokes a command capable of leaving the machine is swept
 * here — see SWEPT_MODULES, and the exclusions named beside it.
 *
 * The last hole was one level down: the sweep could only judge a command it
 * RECOGNISED. `get_commit_status` is a real api.github.com request, it was the
 * one provider API left on the ungated `invokeCommand`, and it appeared in
 * neither NETWORK_COMMANDS nor LOCAL_COMMANDS — so this file called it, watched
 * it go out with offline mode on, and reported green. The two sets are now
 * required to PARTITION every command the sweep reaches, so a command nobody
 * has classified fails the suite instead of being ignored by it.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invoked: string[] = [];

/**
 * Per-test replies, cleared in `afterEach`. The sweep needs shapes that are
 * merely permissive; a test about a SPECIFIC remote (a filesystem one, say)
 * needs the command to answer with that remote.
 */
const responses: Record<string, unknown> = {};

(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: ((command: string) => {
    invoked.push(command);
    if (command in responses) return Promise.resolve(responses[command]);
    // Shapes permissive enough that callers which post-process a result don't
    // throw before reaching their invoke.
    if (command === 'get_remotes') return Promise.resolve([]);
    // A stored credential. `refreshAccountCachedUser` returns before any
    // provider check when the account has no token, so with a null keyring the
    // whole of unified-profile.service would be swept without ever reaching an
    // invoke — a sweep that proves nothing is worse than no sweep.
    if (command === 'get_keyring_token') return Promise.resolve('sweep-token');
    // A real authorize response, so the sweep reaches what `startOAuth` does
    // NEXT — hand the URL to the system browser. With a null reply it threw
    // first and the browser handoff was never exercised. No `loopbackPort`, so
    // no background poll is left running behind the sweep.
    if (command === 'oauth_get_authorize_url') {
      return Promise.resolve({
        authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=sweep',
        state: 'sweep-state',
      });
    }
    // A cloud AI provider is SELECTED for the sweep. With NOTHING selected the
    // AI gate deliberately permits the call: `resolve_provider` on the Rust
    // side tries the embedded model first and then skips every provider whose
    // endpoint the security settings forbid, so the fallback cannot leave the
    // machine, and `guard_ai_request` — which judges only
    // `active_provider_endpoint()` — refuses nothing up front either. The state
    // this sweep has to exercise is the one where a cloud provider IS chosen
    // and the staged diff would really be posted to it.
    if (command === 'get_active_ai_provider') return Promise.resolve('open_ai');
    return Promise.resolve(null);
  }) as MockInvoke,
  transformCallback: () => 0,
};

/**
 * The sweep calls `copyToClipboard` like every other export. The real async
 * clipboard API leaves its promise pending in a headless browser — no
 * permission, no user gesture — which used to hang both sweeps until the
 * 10 s mocha timeout, and got written off as load flakiness for months.
 *
 * `copyToClipboard` now bounds that wait itself, so the sweep no longer hangs
 * either way; this stub keeps it instant and deterministic instead of paying
 * the timeout, exactly as `__TAURI_INTERNALS__` above stubs the IPC layer.
 * The sweep still calls the function and still checks what it invoked, so
 * nothing the test guards is weakened.
 */
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
  configurable: true,
  writable: true,
});

import { expect } from '@open-wc/testing';
import * as gitService from '../git.service.ts';
import * as credentialService from '../credential.service.ts';
import * as localAiService from '../local-ai.service.ts';
import * as updateService from '../update.service.ts';
import * as unifiedProfileService from '../unified-profile.service.ts';
import * as aiService from '../ai.service.ts';
import * as oauthService from '../oauth.service.ts';
import { embeddingIndexService } from '../embedding-index.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';

/**
 * Tauri commands that make an outbound request.
 *
 * `detect_*_repo` parse the local remote URL, `gitflow_*` are local git
 * operations, and `lfs_prune` / `init_submodules` / `sync_submodules` /
 * `get_remote_status` touch only on-disk state — all deliberately absent.
 */
const NETWORK_COMMANDS = new Set([
  // git operations
  'clone_repository', 'fetch', 'pull', 'push', 'push_tag', 'delete_remote_tag',
  'push_to_multiple_remotes', 'fetch_all_remotes', 'add_submodule',
  'update_submodules', 'lfs_pull', 'lfs_fetch',
  'prune_remote_tracking_branches', 'start_auto_fetch',
  // `deepen_repository` and `unshallow_repository` both shell out to
  // `git fetch` (`--deepen` / `--unshallow`); `test_credentials` opens an
  // `ssh -T` session to the remote's host when the remote is an SSH one. All
  // three were absent from this list, so the sweep called them, they invoked,
  // and it stayed green - this file's own documented failure mode.
  'deepen_repository', 'unshallow_repository', 'test_credentials',
  // hosting-provider APIs
  'check_ado_connection', 'check_github_connection', 'check_gitlab_connection',
  'create_ado_pull_request', 'create_azure_devops_work_item',
  'create_bitbucket_issue', 'create_bitbucket_pull_request',
  'create_gitlab_issue', 'create_gitlab_merge_request', 'create_issue',
  'create_pull_request', 'create_release', 'delete_release',
  'get_ado_pull_request', 'get_ado_work_items', 'get_bitbucket_pull_request',
  'get_check_runs', 'get_commit_status',
  'get_gitlab_labels', 'get_gitlab_merge_request',
  'get_issue', 'get_issue_comments', 'get_latest_release', 'get_pull_request',
  'get_pull_request_reviews', 'get_release_by_tag', 'get_workflow_runs',
  'list_ado_organizations', 'list_ado_pipeline_runs', 'list_ado_pull_requests',
  'list_bitbucket_issues', 'list_bitbucket_pipelines',
  'list_bitbucket_pull_requests', 'list_gitlab_issues',
  'list_gitlab_merge_requests', 'list_gitlab_pipelines', 'list_issues',
  'list_pull_requests', 'list_releases', 'query_ado_work_items',
  'test_ssh_connection', 'update_issue_state', 'add_issue_comment',
  'get_repo_labels', 'check_bitbucket_connection',
  'check_bitbucket_connection_with_token',
  // account repository listings (clone dialog's "From account" picker)
  'list_github_repositories', 'list_gitlab_projects',
  'list_bitbucket_repositories', 'list_ado_repositories',
  // GitHub App auth — `configure_github_app` mints an installation token from
  // api.github.com before it stores anything, and the installation listing is
  // a plain API read.
  'configure_github_app', 'list_github_app_installations',
  // model weights, fetched from huggingface.co
  'download_model', 'download_embedding_model',
  // the auto-updater: `check_for_update` fetches latest.json from the release
  // host and `download_and_install_update` pulls a binary and runs it.
  'check_for_update', 'download_and_install_update',
  // ai.service: every call that reaches the ACTIVE provider, which is a cloud
  // provider (api.openai.com, api.anthropic.com, ...) whenever one is
  // selected. `is_ai_available` and `ai_unavailable_reason` are here too: both
  // ask that provider whether it is reachable, which is itself a request.
  'test_ai_provider', 'generate_commit_message', 'suggest_conflict_resolution',
  'generate_changelog', 'analyze_staged_changes', 'generate_pr_description',
  'suggest_commit_splits', 'explain_conflict', 'find_reflog_entry',
  'is_ai_available', 'ai_unavailable_reason',
  // oauth.service: the token endpoint (github.com, gitlab, Entra, bitbucket)
  // and the OIDC issuer's `.well-known` document.
  'oauth_exchange_code', 'oauth_refresh_token', 'discover_oidc_provider',
  // Not a Tauri command of ours but the shell plugin's: it hands a URL to the
  // system browser, which then fetches it. It is in this set because that is
  // the step `startOAuth` takes BEFORE any of the gated commands — with
  // offline mode on it opened github.com, the user authorised the app against
  // their real account, and only the code exchange afterwards was refused.
  'plugin:shell|open',
]);

/**
 * Commands that must NEVER be gated: they read local files only. Routing one
 * through the provider wrapper would make offline mode refuse something that
 * never left the machine — which is what happened to the issue-template
 * readers, latent only because nothing calls them yet.
 */
const LOCAL_COMMANDS = new Set([
  // keyring reads/writes and the local-AI + embedding operations that only
  // touch this machine. Gating any of these would make offline mode hide the
  // controls that turn offline mode off, or refuse an already-downloaded model.
  'get_keyring_token', 'store_keyring_token', 'delete_keyring_token',
  'get_github_app_config', 'remove_github_app_config',
  'detect_credential_manager',
  'get_system_capabilities', 'get_available_models', 'get_downloaded_models',
  'get_recommended_model', 'get_model_status', 'get_loaded_model_name',
  'load_model', 'unload_model', 'delete_model', 'cancel_model_download',
  'build_embedding_index', 'refresh_embedding_index', 'semantic_search',
  'get_embedding_index_status', 'cancel_embedding_build',
  'is_embedding_model_downloaded',
  'get_issue_templates',
  'get_issue_template_content',
  'lfs_prune',
  'init_submodules',
  'sync_submodules',
  'get_remote_status',
  'detect_github_repo',
  'detect_gitlab_repo',
  'detect_bitbucket_repo',
  'detect_ado_repo',
  // update.service: reading the running version, and the three commands that
  // only start/stop/inspect the periodic timer. The timer is deliberately NOT
  // gated here — every tick of it runs the backend gate itself, so turning
  // offline mode back off resumes updates without a restart. Gating the
  // scheduling call would break exactly that.
  'get_app_version',
  'start_auto_update_check',
  'stop_auto_update_check',
  'is_auto_update_running',

  // ai.service: reading and writing the AI configuration, and the local-only
  // probe. Gating any of these would make offline mode hide the controls that
  // turn a cloud provider off, and `auto_detect_ai_providers` probes only
  // Ollama and LM Studio, both on localhost.
  'get_ai_providers', 'get_active_ai_provider', 'set_ai_provider',
  'set_ai_api_key', 'set_ai_model', 'auto_detect_ai_providers',

  // oauth.service: building the authorize URL (it mints PKCE values and binds
  // a LOOPBACK socket — nothing outbound), waiting on that loopback socket,
  // releasing it, and decoding a JWT already in hand.
  'oauth_get_authorize_url', 'oauth_wait_for_callback', 'oauth_cancel_flow',
  'decode_oidc_id_token',

  // ---- the rest of the surface the sweep touches ---------------------------
  //
  // Local git and configuration work: reads and writes under the repository
  // directory, the app's own config files, and the OS keyring. None of them
  // opens a socket, and none of them is behind the BACKEND gate either (the
  // scanner in `scripts/security-lock.mjs` finds no `guard_*` on any path from
  // these commands).
  //
  // They are listed so the two sets above PARTITION everything the sweep
  // reaches — see the partition test below. Without that, a command in neither
  // set was simply invisible: `get_commit_status` is a real api.github.com
  // request, it sat on the ungated wrapper, and this file called it, watched it
  // go out with offline mode on, and stayed green, because nobody had
  // classified it. A new command now has to be put in one set or the other
  // before the suite passes.
  'abort_cherry_pick', 'abort_merge', 'abort_rebase', 'abort_revert', 'add_bookmark',
  'add_gitattribute', 'add_key_to_agent', 'add_remote', 'add_sparse_checkout_patterns',
  'add_to_gitignore', 'add_worktree', 'amend_commit', 'apply_patch', 'apply_patch_to_index',
  'apply_profile', 'apply_stash', 'apply_unified_profile', 'assign_profile_to_repository',
  'assign_unified_profile_to_repository', 'auto_detect_merge_tool', 'bisect_bad',
  'bisect_good', 'bisect_reset', 'bisect_skip', 'bisect_start', 'bundle_create',
  'bundle_list_heads', 'bundle_unbundle', 'bundle_verify', 'cancel_clone', 'check_ignore',
  'check_ignore_verbose', 'checkout', 'checkout_file_from_branch', 'checkout_file_from_commit',
  'checkout_with_autostash', 'cherry_pick', 'cherry_pick_from_branch', 'cherry_pick_range',
  'clean_all', 'clean_files', 'commit_merge', 'compare_branches', 'continue_cherry_pick',
  'continue_rebase', 'continue_revert', 'convert_file_encoding', 'create_archive',
  'create_branch', 'create_commit', 'create_orphan_branch', 'create_patch', 'create_stash',
  'create_tag', 'deinit_submodule', 'delete_alias', 'delete_branch', 'delete_branch_rule',
  'delete_custom_action', 'delete_git_credentials', 'delete_global_account', 'delete_hook',
  'delete_migration_backup', 'delete_profile', 'delete_ssh_key', 'delete_tag',
  'delete_template', 'delete_unified_profile', 'describe', 'detect_conflict_markers',
  'detect_file_encoding', 'detect_profile_for_repository',
  'detect_unified_profile_for_repository', 'disable_sparse_checkout', 'discard_changes',
  'drop_commit', 'drop_stash', 'edit_commit_date', 'edit_tag_message',
  'enable_sparse_checkout', 'erase_credentials', 'execute_interactive_rebase',
  'execute_unified_profiles_migration', 'filter_commits', 'fixup_commit', 'generate_ssh_key',
  'get_aliases', 'get_all_git_config', 'get_archive_files', 'get_assigned_profile',
  'get_assigned_unified_profile', 'get_available_helpers', 'get_available_merge_tools',
  'get_avatar_url', 'get_avatar_urls', 'get_bisect_status', 'get_blob_content',
  'get_bookmarks', 'get_branch_diff_commits', 'get_branch_rules', 'get_branch_tracking_info',
  'get_branches', 'get_cleanable_files', 'get_cleanup_candidates', 'get_clone_filter_info',
  'get_commit', 'get_commit_file_diff', 'get_commit_files', 'get_commit_history',
  'get_commit_info_for_copy', 'get_commit_message', 'get_commit_message_rules',
  'get_commit_template', 'get_commit_total', 'get_commits_signature_info',
  'get_common_attributes', 'get_common_settings', 'get_config_list', 'get_config_value',
  'get_conflict_details', 'get_conflicts', 'get_contributor_stats', 'get_conventional_types',
  'get_credential_helpers', 'get_current_git_identity', 'get_current_identity',
  'get_custom_actions', 'get_diff', 'get_diff_tool', 'get_diff_with_options',
  'get_editor_config', 'get_fetch_remote', 'get_fetch_status', 'get_file_at_commit',
  'get_file_blame', 'get_file_diff', 'get_file_history', 'get_file_hunks', 'get_file_log',
  'get_file_path_for_copy', 'get_git_config', 'get_gitattributes', 'get_gitflow_config',
  'get_gitignore', 'get_gitignore_templates', 'get_global_account', 'get_global_accounts',
  'get_global_accounts_by_type', 'get_gpg_config', 'get_gpg_keys', 'get_hook', 'get_hooks',
  'get_image_versions', 'get_lfs_files', 'get_lfs_status', 'get_line_ending_config',
  'get_merge_tool_config', 'get_migration_backup_info', 'get_note', 'get_notes',
  'get_notes_refs', 'get_pack_info', 'get_pr_template_content', 'get_pr_templates',
  'get_profile_preferred_account', 'get_profiles', 'get_profiles_config',
  'get_public_key_content', 'get_pull_remote', 'get_push_remote', 'get_rebase_commits',
  'get_rebase_state', 'get_rebase_todo', 'get_recent_repos', 'get_reflog',
  'get_refs_by_commit', 'get_remotes', 'get_repo_statistics', 'get_repo_stats',
  'get_repository_account', 'get_repository_preferred_account', 'get_repository_stats',
  'get_signing_config', 'get_signing_status', 'get_sorted_file_status',
  'get_sparse_checkout_config', 'get_ssh_config', 'get_ssh_keys', 'get_stashes', 'get_status',
  'get_submodules', 'get_tag_details', 'get_tags', 'get_undo_history', 'get_unified_profile',
  'get_unified_profiles', 'get_unified_profiles_config', 'get_user_identity', 'get_worktrees',
  'gitflow_finish_feature', 'gitflow_finish_hotfix', 'gitflow_finish_release',
  'gitflow_record_squash_finish', 'gitflow_start_feature', 'gitflow_start_hotfix',
  'gitflow_start_release', 'init_gitflow', 'init_lfs', 'init_repository',
  'is_ancestor_of_head', 'is_auto_fetch_running', 'is_ignored', 'launch_diff_tool',
  'launch_merge_tool', 'lfs_track', 'lfs_untrack', 'list_agent_keys', 'list_diff_tools',
  'list_templates', 'list_tracked_files', 'lock_worktree', 'merge',
  'needs_unified_profiles_migration', 'open_file_manager', 'open_in_configured_editor',
  'open_in_default_app', 'open_in_editor', 'open_repository', 'open_terminal', 'pop_stash',
  'preview_merge', 'preview_rebase', 'preview_unified_profiles_migration', 'prune_worktrees',
  'read_file_content', 'rebase', 'record_action', 'record_repo_opened', 'redo_last_action',
  'remove_bookmark', 'remove_from_gitignore', 'remove_gitattribute', 'remove_note',
  'remove_profile_default_account', 'remove_remote', 'remove_submodule', 'remove_worktree',
  'rename_branch', 'rename_remote', 'reorder_commits', 'reset', 'reset_to_reflog',
  'resolve_conflict', 'resolve_conflict_take_side', 'restore_migration_backup',
  'reveal_in_file_manager', 'revert', 'reword_commit', 'run_custom_action', 'run_fsck',
  'run_gc', 'run_prune', 'save_custom_action', 'save_global_account', 'save_hook',
  'save_profile', 'save_template', 'save_unified_profile', 'search_commits',
  'search_commits_by_content', 'search_commits_by_file', 'search_in_commit_messages',
  'search_in_commits', 'search_in_diff', 'search_in_files', 'set_alias', 'set_branch_rule',
  'set_commit_message_rules', 'set_commit_signing', 'set_config_value',
  'set_credential_helper', 'set_default_global_account', 'set_default_unified_profile',
  'set_diff_tool', 'set_editor_config', 'set_git_config', 'set_line_ending_config',
  'set_merge_tool_config', 'set_note', 'set_profile_default_account', 'set_remote_url',
  'set_signing_key', 'set_sparse_checkout_patterns', 'set_tag_signing', 'set_upstream_branch',
  'set_user_identity', 'shortlog', 'skip_cherry_pick', 'skip_rebase_commit', 'skip_revert',
  'squash_commits', 'stage_files', 'stage_hunk', 'stage_hunk_by_index', 'stage_lines',
  'stash_show', 'stop_auto_fetch', 'store_git_credentials', 'toggle_hook',
  'trigger_auto_fetch', 'unassign_profile_from_repository',
  'unassign_unified_profile_from_repository', 'undo_last_action', 'unlock_worktree',
  'unset_config_value', 'unset_credential_helper', 'unset_git_config', 'unset_upstream_branch',
  'unstage_files', 'unstage_hunk', 'unstage_hunk_by_index', 'update_bookmark',
  'update_gitattribute', 'update_global_account_cached_user', 'update_rebase_todo',
  'validate_commit_message', 'verify_commit_signature', 'write_file_content'
]);

/**
 * Exports that register long-lived listeners or intentionally never invoke.
 * Calling them would leak subscriptions across the suite, and none of them
 * reach the network themselves.
 */
const SKIP = new Set([
  'setupRemoteOperationListeners',
  'cleanupRemoteOperationListeners',
  'onFileChange',
  'onOperationProgress',
  'isNetworkGateRefusal',
  // local-ai.service: registers app-lifetime Tauri event listeners.
  'listenForModelDownloadFailures',
  // embedding-index.service: same, for the index progress events.
  'onProgress',
  // update.service: app-lifetime Tauri event listeners for the updater's
  // progress and result events. None of them invoke a command.
  'onUpdateAvailable',
  'onUpdateChecked',
  'onUpdateDownloading',
  'onDownloadProgress',
  'onUpdateReady',
  'onUpdateError',
  // unified-profile.service: starts (or stops) the 5-minute token-validation
  // timer. Sweeping it would leave an interval running for the rest of the
  // suite; the work it schedules is `refreshAccountCachedUser`, which the sweep
  // drives directly below.
  'startPeriodicTokenValidation',
  'stopPeriodicTokenValidation',
  // Reads the whole profile config and then kicks off the same validation.
  'initializeUnifiedProfiles',
  // oauth.service: registers the app-lifetime deep-link listeners, and the
  // state-change subscription. `onOAuthStateChange` would also install the
  // sweep's argument grab-bag as a "listener", which every later
  // `notifyStateChange` would then try to call.
  'initOAuthListener',
  'onOAuthStateChange',
]);

/**
 * Every service whose exports can reach a Tauri command that leaves the
 * machine. A service listed here is swept whole — no per-function registry to
 * keep up to date, which is the entire point of this file.
 *
 * Deliberately NOT listed: services that only ever invoke commands in
 * LOCAL_COMMANDS. Nothing else — the claim above is the whole point of the
 * file, and it was false twice: ai.service was left out because
 * `ai.service.test.ts` pins its refusal per provider (coverage of one service
 * by another file is not coverage HERE, and its commands were in neither
 * classification set, so the partition test could not see them either), and
 * oauth.service was left out while it had no frontend gate at all.
 */
const SWEPT_MODULES: Array<{ label: string; entries: Array<[string, unknown]> }> = [
  { label: 'git.service', entries: Object.entries(gitService) },
  { label: 'credential.service', entries: Object.entries(credentialService) },
  { label: 'local-ai.service', entries: Object.entries(localAiService) },
  // The auto-updater was the last outbound path with no frontend gate and no
  // entry in this sweep — and the only one that runs unattended and installs a
  // binary. It is swept whole now, like everything else here.
  { label: 'update.service', entries: Object.entries(updateService) },
  // The account refresher: it checks a GitHub, GitLab, Azure DevOps or
  // Bitbucket account's token against that provider's API every five minutes
  // in the background. Three of the four went straight to `invokeCommand`
  // while the GitHub branch beside them used the gated wrapper, and this file
  // claimed to sweep "every service that invokes a command capable of leaving
  // the machine" without listing it.
  { label: 'unified-profile.service', entries: Object.entries(unifiedProfileService) },
  // The AI providers: with OpenAI / Anthropic / Gemini selected, "Generate
  // commit message" posts the staged diff. It gates itself, but it was not
  // swept — so the gate held only for as long as someone remembered it.
  { label: 'ai.service', entries: Object.entries(aiService) },
  // Sign in with GitHub. It had NO frontend gate: with offline mode on it
  // opened the system browser, the user granted their real account access, and
  // only the code exchange afterwards hit the backend guard and refused.
  { label: 'oauth.service', entries: Object.entries(oauthService) },
  {
    label: 'embedding-index.service',
    // A class instance: its methods live on the prototype, so Object.entries
    // would return nothing and the sweep would pass vacuously.
    entries: Object.getOwnPropertyNames(
      Object.getPrototypeOf(embeddingIndexService) as object,
    )
      .filter((name) => name !== 'constructor')
      .map((name) => [
        name,
        (embeddingIndexService as unknown as Record<string, unknown>)[name],
      ]) as Array<[string, unknown]>,
  },
];

/**
 * Every callable the sweep will exercise: each module's exported functions,
 * plus the methods of exported namespace objects (credential.service groups
 * per-provider credential helpers that way, and a gap could hide in one).
 */
function sweptCallables(): SweptCall[] {
  const out: SweptCall[] = [];
  for (const { label, entries } of SWEPT_MODULES) {
    for (const [name, value] of entries) {
      if (SKIP.has(name)) continue;
      if (typeof value === 'function') {
        out.push({ label, name, fn: value as (...a: unknown[]) => unknown, args: ARGS });
        continue;
      }
      // A plain namespace object of helpers (GitHubCredentials, ...).
      if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
          if (typeof member === 'function' && !SKIP.has(key)) {
            out.push({
              label,
              name: `${name}.${key}`,
              fn: (member as (...a: unknown[]) => unknown).bind(value),
              args: ARGS,
            });
          }
        }
      }
    }
  }
  return [...out, ...drivenCalls()];
}

/** A grab-bag of arguments wide enough to get any of these functions to its
 * invoke. Extra arguments are ignored by JS; missing ones arrive undefined. */
const ARGS: unknown[] = [
  { path: '/repo', name: 'v1', url: 'https://example.test/x.git', title: 't', head: 'h', base: 'b' },
  'https://example.test/x.git',
  'main',
  'feature',
  1,
];

type SweptCall = {
  label: string;
  name: string;
  fn: (...a: unknown[]) => unknown;
  args: unknown[];
};

/**
 * Calls the grab-bag above cannot drive to their invoke, given real arguments
 * so the sweep exercises them instead of passing vacuously.
 *
 * `refreshAccountCachedUser` switches on `account.integrationType`, so ARGS —
 * which carries none — falls into the default branch, finds no token and
 * returns before any provider check. Adding the module to SWEPT_MODULES without
 * these would look like coverage and prove nothing.
 */
function drivenCalls(): SweptCall[] {
  const account = (
    integrationType: string,
    config: Record<string, unknown>,
  ): Record<string, unknown> => ({
    id: `${integrationType}-sweep`,
    name: `${integrationType} sweep account`,
    integrationType,
    urlPatterns: [],
    isDefault: false,
    color: null,
    config,
    cachedUser: null,
  });

  const extra: SweptCall[] = [
    {
      // The grab-bag's first argument is an object, and an issuer URL is a
      // string the service reads as one — so without this the call throws
      // before it ever reaches its invoke.
      label: 'oauth.service',
      name: 'discoverOidcProvider(issuer)',
      fn: oauthService.discoverOidcProvider as unknown as (...a: unknown[]) => unknown,
      args: ['https://auth.example.test'],
    },
    {
      // `testAiProvider` is gated on the provider NAMED, so drive it with a
      // real cloud one: the grab-bag's object is an unrecognised provider,
      // which is a different (fail-closed) branch.
      label: 'ai.service',
      name: 'testAiProvider(open_ai)',
      fn: aiService.testAiProvider as unknown as (...a: unknown[]) => unknown,
      args: ['open_ai'],
    },
  ];

  return [
    ...extra,
    ...[
    ['github', { type: 'github' }],
    ['gitlab', { type: 'gitlab', instanceUrl: 'https://gitlab.example.test' }],
    ['azure-devops', { type: 'azure-devops', organization: 'contoso' }],
    ['bitbucket', { type: 'bitbucket', workspace: 'team' }],
    ].map(([integrationType, config]) => ({
      label: 'unified-profile.service',
      name: `refreshAccountCachedUser(${integrationType as string})`,
      fn: unifiedProfileService.refreshAccountCachedUser as unknown as (
        ...a: unknown[]
      ) => unknown,
      args: [account(integrationType as string, config as Record<string, unknown>)],
    })),
  ];
}

describe('network gate coverage', () => {
  afterEach(() => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    for (const key of Object.keys(responses)) delete responses[key];
  });

  it('offline mode stops every exported function from reaching a network command', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const leaked = new Map<string, string>();
    for (const { label, name, fn, args } of sweptCallables()) {
      invoked.length = 0;
      try {
        await fn(...args);
      } catch {
        // A rejected call is fine — it certainly didn't reach the network.
      }
      const hit = invoked.find((c) => NETWORK_COMMANDS.has(c));
      if (hit) leaked.set(`${label}: ${name}`, hit);
    }

    expect(
      Array.from(leaked, ([fn, cmd]) => `${fn} -> ${cmd}`),
      'these reached the network with offline mode on',
    ).to.deep.equal([]);
  });

  it('the two sets classify every command the sweep reaches', async () => {
    // The offline assertion above can only judge a command it recognises, so a
    // command in NEITHER set is one it silently ignores. That is how
    // `get_commit_status` — a real api.github.com request, on the ungated
    // `invokeCommand` — was swept, watched going out with offline mode on, and
    // reported green: the two hand-kept lists were never required to be total.
    //
    // They are now. A command reached here and in neither set is a
    // classification nobody has made: put it in NETWORK_COMMANDS (and gate it,
    // or the offline assertion above fails) or in LOCAL_COMMANDS (a claim that
    // it never leaves the machine).
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });

    const unclassified = new Set<string>();
    for (const { fn, args } of sweptCallables()) {
      invoked.length = 0;
      try {
        await fn(...args);
      } catch {
        /* a rejected call still reveals what it invoked */
      }
      for (const command of invoked) {
        if (!NETWORK_COMMANDS.has(command) && !LOCAL_COMMANDS.has(command)) {
          unclassified.add(command);
        }
      }
    }

    expect(
      [...unclassified].sort(),
      'classify these as network or local — an unclassified command is one the offline sweep ignores',
    ).to.deep.equal([]);
  });

  it('offline mode does not block commands that never leave the machine', async () => {
    // Routing a local read through the provider wrapper makes offline mode
    // refuse something that never left the machine. The issue-template readers
    // only `fs::read` well-known paths under the repo directory.
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const localCalls: Array<{ name: string; command: string; run: () => Promise<unknown> }> = [
      {
        name: 'getIssueTemplates',
        command: 'get_issue_templates',
        run: () => gitService.getIssueTemplates('/repo'),
      },
      {
        name: 'getIssueTemplateContent',
        command: 'get_issue_template_content',
        run: () => gitService.getIssueTemplateContent('/repo', '.github/ISSUE_TEMPLATE/bug.md'),
      },
      { name: 'lfsPrune', command: 'lfs_prune', run: () => gitService.lfsPrune('/repo') },
      {
        name: 'initSubmodules',
        command: 'init_submodules',
        run: () => gitService.initSubmodules('/repo'),
      },
      {
        name: 'syncSubmodules',
        command: 'sync_submodules',
        run: () => gitService.syncSubmodules('/repo'),
      },
      {
        name: 'getRemoteStatus',
        command: 'get_remote_status',
        run: () => gitService.getRemoteStatus('/repo'),
      },
    ];

    const blocked: string[] = [];
    for (const local of localCalls) {
      invoked.length = 0;
      try {
        await local.run();
      } catch {
        /* ignore */
      }
      if (!invoked.includes(local.command)) blocked.push(`${local.name} -> ${local.command}`);
    }

    expect(blocked, 'these are local reads and must not be gated').to.deep.equal([]);
  });

  /**
   * A remote that is a place on this machine — a USB disk, a `file://` path —
   * opens no socket, so neither offline mode nor the allowlist has anything to
   * say about it. Both refused one: offline mode answered before it looked at
   * the target at all, and the allowlist read `/mnt/usb/repo.git` as the host
   * `mnt`, so the only entry that could permit it was the literal `mnt` — and
   * no entry at all could permit `file:///…`, which has no host.
   *
   * Same principle as the loopback carve-out the AI endpoints already get, and
   * as the Offline Mode description itself: "block every operation that leaves
   * this machine".
   */
  it('offline mode permits a push and a fetch to a remote on this machine', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });
    responses.get_remotes = [
      { name: 'backup', url: '/mnt/usb/repo.git', pushUrl: null },
      { name: 'archive', url: 'file:///srv/git/app.git', pushUrl: null },
    ];

    invoked.length = 0;
    await gitService.push({ path: '/repo', remote: 'backup' });
    expect(invoked.includes('push'), 'a push to a USB disk never leaves the machine').to.equal(
      true,
    );

    invoked.length = 0;
    await gitService.fetch({ path: '/repo', remote: 'archive' });
    expect(invoked.includes('fetch'), 'a fetch from a file:// path opens no socket').to.equal(
      true,
    );
  });

  it('an allowlist permits a remote on this machine', async () => {
    settingsStore.setState({
      offlineMode: false,
      confirmNetworkOps: false,
      remoteAllowlist: ['github.com'],
    });
    responses.get_remotes = [{ name: 'backup', url: '/mnt/usb/repo.git', pushUrl: null }];

    invoked.length = 0;
    await gitService.push({ path: '/repo', remote: 'backup' });
    expect(
      invoked.includes('push'),
      'an allowlist of hosts cannot be asked about a path, and must not refuse one',
    ).to.equal(true);
  });

  /**
   * The `file://` half of the carve-out, in the spellings the backend gate
   * already permits. `is_local_target` accepts every LOOPBACK host — loopback
   * is definitively this machine, which is why an AI endpoint on it is carved
   * out too — while this mirror accepted an empty host and `localhost` only.
   * So the backend decided `file://127.0.0.1/…` never leaves the machine and
   * this half refused it first with "Offline mode is enabled", and under
   * offline mode no allowlist entry can work around that.
   */
  it('offline mode permits a file:// remote on loopback', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    for (const url of [
      'file://127.0.0.1/srv/git/app.git',
      'file://[::1]/srv/git/app.git',
      'file://build.localhost/srv/git/app.git',
    ]) {
      responses.get_remotes = [{ name: 'loop', url, pushUrl: null }];
      invoked.length = 0;
      await gitService.push({ path: '/repo', remote: 'loop' });
      expect(invoked.includes('push'), `${url} is this machine`).to.equal(true);

      invoked.length = 0;
      await gitService.fetch({ path: '/repo', remote: 'loop' });
      expect(invoked.includes('fetch'), `${url} opens no socket off this box`).to.equal(true);
    }
  });

  it('a remote that only looks local is still refused', async () => {
    // The exclusions: a UNC path is SMB, and a `file://` URL whose host is
    // another machine is handed to the transport with that host. `.localhost`
    // has to be a real suffix, so `localhost.evil.test` is another machine.
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    for (const url of [
      '//server/share/repo.git',
      'file://server/share/repo.git',
      'file://localhost.evil.test/share/repo.git',
    ]) {
      responses.get_remotes = [{ name: 'smb', url, pushUrl: null }];
      invoked.length = 0;
      const result = await gitService.push({ path: '/repo', remote: 'smb' });
      expect(invoked.includes('push'), `${url} leaves this machine`).to.equal(false);
      expect(result.success).to.equal(false);
    }
  });

  /**
   * The fetch url says nothing about where a push goes. Resolving the PUSH url
   * only when an allowlist existed meant that, with offline mode on, a remote
   * whose fetch url is a local path and whose `pushurl` is a real host was
   * judged on the path and let through — the backend gate then refused it,
   * which is the two gates disagreeing.
   */
  it('a local fetch url does not excuse a push url that leaves the machine', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });
    responses.get_remotes = [
      { name: 'origin', url: '/mnt/usb/repo.git', pushUrl: 'https://github.com/o/r.git' },
    ];

    invoked.length = 0;
    const result = await gitService.push({ path: '/repo', remote: 'origin' });
    expect(invoked.includes('push'), 'the push goes to github.com').to.equal(false);
    expect(result.success).to.equal(false);

    // The same remote's FETCH url is local, and a fetch really does stay here.
    invoked.length = 0;
    await gitService.fetch({ path: '/repo', remote: 'origin' });
    expect(invoked.includes('fetch')).to.equal(true);
  });

  /**
   * The local-target carve-out landed on the paths the review happened to look
   * at, and not on the ones beside them. Each test below is one of those
   * neighbours: the same repository, the same setting, two buttons that must
   * agree — and did not.
   */
  it('offline mode permits pruning remotes that live on this machine', async () => {
    // The offline branch answered ahead of the carve-out AND ahead of the
    // remote list, so this refused; and because `checkNetworkAllowed` returns
    // null for a local target, no toast fired and the dialogs suppress
    // `BLOCKED` — the button did nothing at all, in silence.
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });
    responses.get_remotes = [
      { name: 'backup', url: '/mnt/usb/repo.git', pushUrl: null },
      { name: 'archive', url: 'file:///srv/git/app.git', pushUrl: null },
    ];

    invoked.length = 0;
    const result = await gitService.pruneRemoteTrackingBranches('/repo');
    expect(
      invoked.includes('prune_remote_tracking_branches'),
      'pruning a USB disk contacts nothing',
    ).to.equal(true);
    expect(result.success).to.equal(true);
  });

  it('offline mode still refuses a prune that reaches a remote host', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });
    responses.get_remotes = [
      { name: 'backup', url: '/mnt/usb/repo.git', pushUrl: null },
      { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null },
    ];

    invoked.length = 0;
    const result = await gitService.pruneRemoteTrackingBranches('/repo');
    expect(
      invoked.includes('prune_remote_tracking_branches'),
      'one remote in the gesture leaves the machine, so the whole gesture is refused',
    ).to.equal(false);
    expect(result.success).to.equal(false);
    expect(result.error?.code).to.equal('BLOCKED');
  });

  /**
   * Push-to-multiple resolved its real destinations only under an ALLOWLIST,
   * where single `push` had already moved to "any policy". So with offline
   * mode on the two buttons judged different URLs for the same remote, and
   * disagreed in both directions.
   */
  it('a multi-push is judged on each PUSH url under offline mode too', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });
    responses.get_remotes = [
      { name: 'mirror', url: '/mnt/usb/repo.git', pushUrl: 'https://github.com/o/r.git' },
      { name: 'backup', url: 'https://github.com/o/r.git', pushUrl: '/mnt/usb/repo.git' },
    ];

    invoked.length = 0;
    const leaves = await gitService.pushToMultipleRemotes({ path: '/repo', remotes: ['mirror'], force: false, forceWithLease: false, pushTags: false });
    expect(
      invoked.includes('push_to_multiple_remotes'),
      'a local fetch url does not excuse a pushurl that reaches github.com',
    ).to.equal(false);
    expect(leaves.success).to.equal(false);

    invoked.length = 0;
    const stays = await gitService.pushToMultipleRemotes({ path: '/repo', remotes: ['backup'], force: false, forceWithLease: false, pushTags: false });
    expect(
      invoked.includes('push_to_multiple_remotes'),
      'a pushurl on this machine is permitted, exactly as single push permits it',
    ).to.equal(true);
    expect(stays.success).to.equal(true);

    // The single-push button on the same two remotes, which must agree.
    invoked.length = 0;
    await gitService.push({ path: '/repo', remote: 'mirror' });
    expect(invoked.includes('push')).to.equal(false);
    invoked.length = 0;
    await gitService.push({ path: '/repo', remote: 'backup' });
    expect(invoked.includes('push')).to.equal(true);
  });

  /**
   * The LFS endpoint was resolved only under an allowlist, so offline mode
   * judged the git remote instead of the `.lfsconfig` endpoint the transfer
   * really contacts — again in both directions.
   */
  it('an LFS transfer is judged on its own endpoint under offline mode too', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    // A remote git remote, an LFS endpoint on this machine.
    responses.get_remotes = [
      { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null },
    ];
    responses.get_lfs_endpoint = '/mnt/usb/lfs';
    invoked.length = 0;
    const local = await gitService.lfsPull('/repo');
    expect(invoked.includes('lfs_pull'), 'the transfer never leaves the machine').to.equal(true);
    expect(local.success).to.equal(true);

    // The mirror image: a local git remote, an LFS endpoint that leaves.
    responses.get_remotes = [{ name: 'origin', url: '/mnt/usb/repo.git', pushUrl: null }];
    responses.get_lfs_endpoint = 'https://lfs.example.com/o/r';
    invoked.length = 0;
    const remote = await gitService.lfsFetch('/repo');
    expect(invoked.includes('lfs_fetch'), 'the transfer reaches lfs.example.com').to.equal(false);
    expect(remote.success).to.equal(false);
  });

  /**
   * Fetch-all gated ONE remote — the default fetch remote — while the backend
   * guards every one of them (`fetch_all_remotes` in remote.rs loops
   * `guard_remote` over `repo.remotes()`). So the gate whose job is to refuse
   * before any work starts waved a github.com fetch through, and handed the
   * user a red backend error in the case it should have explained itself.
   */
  it('fetch-all is gated on every remote, not just the default one', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });
    responses.get_fetch_remote = 'backup';
    responses.get_remotes = [
      { name: 'backup', url: '/mnt/usb/repo.git', pushUrl: null },
      { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null },
    ];

    invoked.length = 0;
    const mixed = await gitService.fetchAllRemotes({ path: '/repo', prune: false, tags: false });
    expect(
      invoked.includes('fetch_all_remotes'),
      'the gesture fetches github.com too, whatever the default remote is',
    ).to.equal(false);
    expect(mixed.success).to.equal(false);

    // Every remote on this machine: nothing to refuse.
    responses.get_remotes = [
      { name: 'backup', url: '/mnt/usb/repo.git', pushUrl: null },
      { name: 'archive', url: 'file:///srv/git/app.git', pushUrl: null },
    ];
    invoked.length = 0;
    const allLocal = await gitService.fetchAllRemotes({ path: '/repo', prune: false, tags: false });
    expect(invoked.includes('fetch_all_remotes'), 'none of these opens a socket').to.equal(true);
    expect(allLocal.success).to.equal(true);
  });

  it('an allowlist refuses fetch-all before the backend has to', async () => {
    settingsStore.setState({
      offlineMode: false,
      confirmNetworkOps: false,
      remoteAllowlist: ['github.com'],
    });
    responses.get_fetch_remote = 'origin';
    responses.get_remotes = [
      { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null },
      { name: 'upstream', url: 'https://gitlab.example/o/r.git', pushUrl: null },
    ];

    invoked.length = 0;
    const result = await gitService.fetchAllRemotes({ path: '/repo', prune: false, tags: false });
    expect(
      invoked.includes('fetch_all_remotes'),
      'the backend refuses the whole gesture, so the frontend must explain it first',
    ).to.equal(false);
    expect(result.error?.code).to.equal('BLOCKED');
  });

  /**
   * The dead end this sweep existed to catch and could not see, because
   * oauth.service was not in it: with offline mode on, "Sign in with GitHub"
   * opened the system browser, the user granted their REAL account access, the
   * callback landed, and only then did the code exchange hit the backend guard
   * and refuse. The refusal has to come before the browser is opened.
   */
  it('offline mode refuses a sign-in before the browser is ever opened', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const states: string[] = [];
    const unsubscribe = oauthService.onOAuthStateChange((state) => {
      if (state.provider === 'github' && state.status === 'error') {
        states.push(state.error ?? '');
      }
    });
    invoked.length = 0;
    await oauthService.startOAuth('github', 'client-id');
    unsubscribe();

    expect(invoked.includes('oauth_get_authorize_url'), 'no flow is started').to.equal(false);
    expect(invoked.includes('plugin:shell|open'), 'the browser is never opened').to.equal(false);
    expect(states, 'the dialog is told, the way it is told about every other failure')
      .to.have.lengthOf(1);
    expect(states[0]).to.contain('offline mode');
    expect(states[0]).to.contain('Settings > Security');
  });

  it('an allowlist naming the provider still permits a sign-in', async () => {
    // A gate that refused either way would just be offline mode by another name.
    settingsStore.setState({
      offlineMode: false,
      confirmNetworkOps: false,
      remoteAllowlist: ['github.com'],
    });

    invoked.length = 0;
    await oauthService.startOAuth('github', 'client-id');

    expect(invoked.includes('oauth_get_authorize_url')).to.equal(true);
    expect(invoked.includes('plugin:shell|open')).to.equal(true);

    // A list that does not name it refuses, and says which host is missing.
    settingsStore.setState({ offlineMode: false, remoteAllowlist: ['gitlab.com'] });
    const errors: string[] = [];
    const unsubscribe = oauthService.onOAuthStateChange((state) => {
      if (state.status === 'error') errors.push(state.error ?? '');
    });
    invoked.length = 0;
    await oauthService.startOAuth('github', 'client-id');
    unsubscribe();

    expect(invoked.includes('plugin:shell|open')).to.equal(false);
    expect(errors[0]).to.contain('github.com');
    expect(errors[0]).to.contain('allowlist');
  });

  it('the token exchange and the OIDC discovery refuse with the same reason', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    let exchangeError: string | null = null;
    try {
      await oauthService.exchangeCode('github', 'state', 'code');
    } catch (err) {
      exchangeError = (err as Error).message;
    }
    expect(exchangeError).to.contain('offline mode');

    let discoveryError: string | null = null;
    try {
      await oauthService.discoverOidcProvider('https://auth.example.test');
    } catch (err) {
      discoveryError = (err as Error).message;
    }
    expect(discoveryError).to.contain('auth.example.test');
    expect(discoveryError).to.contain('offline mode');

    let refreshError: string | null = null;
    try {
      await oauthService.refreshToken('gitlab', 'refresh-token', 'https://gitlab.example.test');
    } catch (err) {
      refreshError = (err as Error).message;
    }
    expect(refreshError).to.contain('gitlab.example.test');
  });

  /**
   * `test_ai_provider` is in NETWORK_COMMANDS because it CAN leave the machine
   * — it probes whichever provider is named. Ollama and LM Studio listen on
   * localhost, so the same command must still go through for them, and the
   * sweep above never drives it with a local provider.
   */
  it('a local AI provider is still reachable with offline mode on', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    for (const provider of ['ollama', 'lm_studio', 'local_inference'] as const) {
      invoked.length = 0;
      const result = await aiService.testAiProvider(provider);
      expect(invoked.includes('test_ai_provider'), `${provider} runs on this machine`).to.equal(
        true,
      );
      expect(result.error?.code).to.not.equal('BLOCKED');
    }

    // A provider this build does not recognise is not known to be local, and
    // reading "local" as "not in the cloud list" made it fail OPEN.
    invoked.length = 0;
    const unknown = await aiService.testAiProvider(
      'brand_new_cloud_provider' as unknown as Parameters<typeof aiService.testAiProvider>[0],
    );
    expect(invoked.includes('test_ai_provider'), 'an unknown destination fails closed').to.equal(
      false,
    );
    expect(unknown.error?.code).to.equal('BLOCKED');
  });

  it('every command in LOCAL_COMMANDS is absent from NETWORK_COMMANDS', () => {
    const both = [...LOCAL_COMMANDS].filter((c) => NETWORK_COMMANDS.has(c));
    expect(both, 'a command cannot be both local and network').to.deep.equal([]);
  });

  it('a configured allowlist does not refuse provider APIs on the allowed host', async () => {
    // Failing closed is right for a git remote and wrong for a provider call,
    // which has no repo-relative remote to resolve. Passing repoPath: null with
    // no host made EVERY provider API refuse the moment any allowlist existed.
    settingsStore.setState({ offlineMode: false, remoteAllowlist: ['github.com'] });

    invoked.length = 0;
    const result = await gitService.listPullRequests('owner', 'repo');

    expect(result.success, 'a github.com allowlist permits GitHub APIs').to.not.equal(false);
    expect(invoked.includes('list_pull_requests')).to.equal(true);
  });

  it('a configured allowlist still refuses a provider on a host not on the list', async () => {
    settingsStore.setState({ offlineMode: false, remoteAllowlist: ['github.com'] });

    invoked.length = 0;
    const result = await gitService.listGitLabIssues('https://gitlab.com', 'g/p');

    expect(result.success, 'gitlab.com is not on the list').to.equal(false);
    expect(invoked.includes('list_gitlab_issues')).to.equal(false);
  });

  /**
   * A refusal the user cannot read is barely better than a silent one: each of
   * these is rendered by its caller (`aiError` in the settings dialog, a thrown
   * message in the GitHub App flow), so the text has to name the setting and
   * where to change it.
   */
  it('a refused download or GitHub App call explains itself', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const model = await localAiService.downloadModel('gemma-3-1b-q4km');
    expect(model.success).to.equal(false);
    expect(model.error?.code, 'the code every other refusal uses').to.equal('BLOCKED');
    expect(model.error?.message).to.contain('Offline mode');
    expect(model.error?.message).to.contain('Settings > Security');

    let embeddingError: string | null = null;
    try {
      await embeddingIndexService.downloadModel();
    } catch (err) {
      embeddingError = (err as Error).message;
    }
    expect(embeddingError, 'the embedding model download must refuse too').to.contain(
      'Offline mode',
    );

    let appError: string | null = null;
    try {
      await credentialService.configureGitHubApp(1, 'pem', 2);
    } catch (err) {
      appError = (err as Error).message;
    }
    expect(appError).to.contain('api.github.com');
    expect(appError).to.contain('offline mode');

    let listError: string | null = null;
    try {
      await credentialService.listGitHubAppInstallations(1, 'pem');
    } catch (err) {
      listError = (err as Error).message;
    }
    expect(listError).to.contain('api.github.com');

    // The Settings "Check for Updates" button renders this message inline, so
    // pressing it offline says why instead of silently doing nothing — which
    // is what it did while the updater had no gate at all.
    const update = await updateService.checkForUpdate();
    expect(update.success).to.equal(false);
    expect(update.error?.code, 'the code every other refusal uses').to.equal('BLOCKED');
    expect(update.error?.message).to.contain('offline mode');
    expect(update.error?.message).to.contain('Settings > Security');

    const install = await updateService.downloadAndInstallUpdate();
    expect(install.success, 'installing a binary is the same request').to.equal(false);
    expect(install.error?.code).to.equal('BLOCKED');
  });

  it('an allowlist refusal names the host that is missing from it', async () => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: ['github.com'] });

    const model = await localAiService.downloadModel('gemma-3-1b-q4km');
    expect(model.success).to.equal(false);
    expect(model.error?.message).to.contain('huggingface.co');
    expect(model.error?.message).to.contain('allowlist');

    // The same allowlist names api.github.com's domain, so the GitHub App
    // calls are permitted — an allowlist that refused everything would just be
    // offline mode with extra steps.
    invoked.length = 0;
    try {
      await credentialService.listGitHubAppInstallations(1, 'pem');
    } catch {
      /* the mocked command returns null, which the caller rejects — fine */
    }
    expect(invoked.includes('list_github_app_installations')).to.equal(true);

    // github.com IS on this list, so the updater is allowed through — an
    // allowlist that refused either way would just be offline mode by another
    // name.
    invoked.length = 0;
    const allowedUpdate = await updateService.checkForUpdate();
    expect(allowedUpdate.success, 'a github.com allowlist permits the updater').to.not.equal(false);
    expect(invoked.includes('check_for_update')).to.equal(true);

    // A list that does not name it refuses, and says which host is missing.
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: ['gitlab.com'] });
    invoked.length = 0;
    const refusedUpdate = await updateService.checkForUpdate();
    expect(refusedUpdate.success).to.equal(false);
    expect(refusedUpdate.error?.message).to.contain('github.com');
    expect(refusedUpdate.error?.message).to.contain('allowlist');
    expect(invoked.includes('check_for_update')).to.equal(false);
  });

  it('the same sweep does reach those commands when offline mode is off', async () => {
    // Guards the test itself: if the sweep stopped exercising anything (an
    // argument shape drifting, say), the assertion above would pass vacuously.
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });

    const reached = new Set<string>();
    for (const { fn, args } of sweptCallables()) {
      invoked.length = 0;
      try {
        await fn(...args);
      } catch {
        /* ignore */
      }
      for (const c of invoked) if (NETWORK_COMMANDS.has(c)) reached.add(c);
    }

    expect(reached.size, 'the sweep actually exercises network commands').to.be.greaterThan(10);
    // The four that shipped ungated. Without these the sweep could stop
    // exercising them (an argument shape drifting, an export renamed) and the
    // offline assertion above would pass without proving anything.
    for (const command of [
      'download_model',
      'download_embedding_model',
      'configure_github_app',
      'list_github_app_installations',
      'check_for_update',
      'download_and_install_update',
      // The shallow-clone fetches and the SSH credential test, ungated on the
      // frontend until they were classified above.
      'deepen_repository',
      'unshallow_repository',
      'test_credentials',
      // The one hosting-provider API left on the ungated wrapper. It was in
      // neither classification set, so the sweep called it, watched it reach
      // api.github.com with offline mode on, and stayed green.
      'get_commit_status',
      // The three provider checks in unified-profile.service. They prove the
      // driven calls above really do reach a provider API: without them the
      // module could be listed, swept and assert nothing at all.
      'check_gitlab_connection',
      'check_ado_connection',
      'check_bitbucket_connection_with_token',
      // ai.service and oauth.service, the two modules the sweep claimed to
      // cover and did not. `plugin:shell|open` is the browser handoff that
      // made the OAuth dead end possible.
      'generate_commit_message',
      'test_ai_provider',
      'is_ai_available',
      'oauth_exchange_code',
      'oauth_refresh_token',
      'discover_oidc_provider',
      'plugin:shell|open',
    ]) {
      expect(reached.has(command), `the sweep reaches ${command} when nothing blocks it`).to.equal(
        true,
      );
    }
  });
});
