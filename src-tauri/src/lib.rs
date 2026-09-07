//! Gitnado - Git GUI Client
//!
//! A fully-featured, open-source, cross-platform Git GUI client
//! built with Tauri 2.0 and Rust.

pub mod commands;
pub mod error;
pub mod models;
pub mod services;
pub mod utils;

#[cfg(test)]
mod test_utils;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Listener, Manager};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use commands::local_ai::create_local_ai_state;
use commands::watcher::WatcherState;
use services::ai::mcp::server::create_mcp_state;
use services::ai::AiState;
use services::commit_index::SharedCommitIndex;
use services::{
    create_ai_state, create_autofetch_state, create_update_state, CancellationRegistry,
    RemoteOpRegistry,
};

/// Initialize the application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set up panic hook FIRST to capture crash information before abort
    // This runs even with panic="abort" in release builds
    std::panic::set_hook(Box::new(|panic_info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");

        let message = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        let location = panic_info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        // Use eprintln since tracing may not be initialized or may have issues
        eprintln!("╔══════════════════════════════════════════════════════════════╗");
        eprintln!("║                      PANIC DETECTED                          ║");
        eprintln!("╠══════════════════════════════════════════════════════════════╣");
        eprintln!("║ Thread: {:<54}║", thread_name);
        eprintln!("║ Location: {:<52}║", location);
        eprintln!("╠══════════════════════════════════════════════════════════════╣");
        eprintln!("║ Message:                                                     ║");
        // Wrap long messages
        for line in message.chars().collect::<Vec<_>>().chunks(60) {
            let line_str: String = line.iter().collect();
            eprintln!("║ {:<62}║", line_str);
        }
        eprintln!("╚══════════════════════════════════════════════════════════════╝");

        // Also try to log via tracing if available
        // This may or may not work depending on when the panic occurs
        tracing::error!(
            thread = thread_name,
            location = location,
            message = message,
            "PANIC: Application crashed"
        );

        // Capture backtrace if available
        let backtrace = std::backtrace::Backtrace::force_capture();
        eprintln!("\nBacktrace:\n{}", backtrace);
    }));

    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gitnado=debug,git2=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting Gitnado");

    // Build the app with plugins
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // Single-instance and deep-link plugins (desktop only)
    // Single-instance must be registered BEFORE deep-link for proper callback handling
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                // On Windows/Linux, deep links arrive as command line arguments
                if let Some(url) = argv.get(1) {
                    // `leviathan://` is the scheme from before the 0.9.0 rename;
                    // it stays registered so links minted back then still open.
                    if url.starts_with("gitnado://") || url.starts_with("leviathan://") {
                        tracing::info!("Received deep link via single-instance: {}", url);
                        let _ = app.emit("deep-link", url);
                    }
                }
                // Focus the main window when another instance is opened
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_deep_link::init())
            // Remembers window size, position and maximised state across launches.
            // VISIBLE is intentionally excluded: the tray "minimize to tray" feature
            // hides the window via `Window::hide`, and if visibility were persisted
            // the app would relaunch hidden with no obvious way to bring it back.
            // minWidth/minHeight from tauri.conf.json still apply since Tauri clamps
            // any restored size to those constraints. A restored position that no
            // longer matches a connected monitor is left alone by the plugin (it
            // only repositions the window when the saved coordinates intersect an
            // available monitor), so the window can never restore off-screen.
            .plugin(
                tauri_plugin_window_state::Builder::new()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::SIZE
                            | tauri_plugin_window_state::StateFlags::POSITION
                            | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                    )
                    .build(),
            );
    }

    let app = builder
        .manage(WatcherState::default())
        .manage(create_autofetch_state())
        .manage(create_update_state())
        .manage(CancellationRegistry::default())
        .manage(RemoteOpRegistry::default())
        .manage(SharedCommitIndex::default())
        .setup(|app| {
            // The identifier changed with the 0.9.0 rename, which moves the
            // per-app config/data directories; carry over the old ones so
            // settings and downloaded models survive the upgrade.
            for dir in [app.path().app_config_dir(), app.path().app_data_dir()]
                .into_iter()
                .flatten()
            {
                crate::utils::app_paths::adopt_legacy_identifier_dir(&dir);
            }

            // Initialize AI state with config directory
            let config_dir = app.path().app_config_dir().unwrap_or_default();
            app.manage(create_ai_state(config_dir.clone()));

            // Initialize local AI state with models directory
            let models_dir = app.path().app_data_dir().unwrap_or_default().join("models");
            let local_ai_state = create_local_ai_state(models_dir);
            app.manage(local_ai_state.clone());

            // Wire local AI state into AiService for lazy model loading.
            // Model loading is deferred to first inference request.
            {
                let ai_state: tauri::State<'_, AiState> = app.state();
                let mut service = ai_state.blocking_write();
                service.set_local_ai_state(local_ai_state);
            }

            // Initialize MCP server state from the saved configuration
            let mcp_state = create_mcp_state(config_dir);
            app.manage(mcp_state.clone());

            // Restart the MCP server if it was running when the app last exited.
            // A bind failure is recorded in the status so Settings can explain it.
            tauri::async_runtime::spawn(async move {
                let mut server = mcp_state.write().await;
                if server.get_config().enabled {
                    if let Err(e) = server.start().await {
                        tracing::warn!("Failed to auto-start MCP server: {}", e);
                    }
                }
            });

            // Initialize embedding index state
            let embedding_models_dir = app.path().app_data_dir().unwrap_or_default().join("models");
            let embedding_indexes_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_default()
                .join("embedding-indexes");
            app.manage(std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::services::embedding::EmbeddingIndexState::new(
                    embedding_models_dir,
                    embedding_indexes_dir,
                ),
            )));

            tracing::info!("Application setup complete");

            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                } else {
                    tracing::warn!("Main window not found, skipping devtools");
                }
            }

            // Set up system tray
            let minimize_to_tray = Arc::new(AtomicBool::new(false));
            let minimize_to_tray_clone = minimize_to_tray.clone();

            // Listen for tray settings updates from the frontend
            let minimize_to_tray_listener = minimize_to_tray.clone();
            app.listen("update-tray-settings", move |event| {
                if let Ok(settings) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(enabled) = settings.get("minimizeToTray").and_then(|v| v.as_bool())
                    {
                        minimize_to_tray_listener.store(enabled, Ordering::Relaxed);
                        tracing::info!("Minimize to tray setting updated: {}", enabled);
                    }
                }
            });

            // Build the tray menu
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;

            let show_hide =
                MenuItemBuilder::with_id("show_hide", "Show/Hide Gitnado").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_hide)
                .separator()
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("default window icon must be set in tauri.conf.json"),
                )
                .menu(&menu)
                .tooltip("Gitnado")
                .on_menu_event(
                    move |app: &tauri::AppHandle, event: tauri::menu::MenuEvent| match event
                        .id()
                        .as_ref()
                    {
                        "show_hide" => {
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    },
                )
                .on_tray_icon_event(
                    |tray: &tauri::tray::TrayIcon, event: tauri::tray::TrayIconEvent| {
                        if let tauri::tray::TrayIconEvent::Click { .. } = event {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    },
                )
                .build(app)?;

            // Handle window close event - minimize to tray if enabled
            if let Some(window) = app.get_webview_window("main") {
                let minimize_flag = minimize_to_tray_clone;
                let win_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if minimize_flag.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = win_clone.hide();
                            tracing::info!("Minimizing to tray instead of closing");
                        }
                    }
                });
            }

            // Start auto-update checking (every 24 hours)
            let update_state = app.state::<services::UpdateState>().inner().clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut service = update_state.write().await;
                service.start_periodic_check(24, app_handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::repository::open_repository,
            commands::repository::clone_repository,
            commands::repository::cancel_clone,
            commands::repository::init_repository,
            commands::repository::get_repository_info,
            commands::repository::get_clone_filter_info,
            commands::repository::list_tracked_files,
            commands::branch::get_branches,
            commands::branch::create_branch,
            commands::branch::delete_branch,
            commands::branch::rename_branch,
            commands::branch::checkout,
            commands::branch::checkout_with_autostash,
            commands::branch::set_upstream_branch,
            commands::branch::unset_upstream_branch,
            commands::branch::get_branch_tracking_info,
            commands::branch::create_orphan_branch,
            // Branch cleanup
            commands::branch_cleanup::get_cleanup_candidates,
            // Branch protection rules
            commands::branch_rules::get_branch_rules,
            commands::branch_rules::set_branch_rule,
            commands::branch_rules::delete_branch_rule,
            commands::commit::get_commit_history,
            commands::commit::get_commit_total,
            commands::commit::get_commit,
            commands::commit::create_commit,
            commands::commit::amend_commit,
            commands::commit::amend_commit_message,
            commands::commit::get_commit_message,
            commands::commit::is_head_published,
            commands::commit::edit_commit_date,
            commands::commit::reword_commit,
            commands::commit::search_commits,
            commands::commit::get_file_history,
            commands::staging::get_status,
            commands::staging::stage_files,
            commands::staging::unstage_files,
            commands::staging::discard_changes,
            commands::staging::stage_hunk,
            commands::staging::unstage_hunk,
            commands::staging::write_file_content,
            commands::staging::read_file_content,
            commands::staging::get_file_hunks,
            commands::staging::stage_hunk_by_index,
            commands::staging::unstage_hunk_by_index,
            commands::staging::stage_lines,
            commands::staging::strip_trailing_whitespace,
            commands::staging::get_sorted_file_status,
            commands::remote::get_remotes,
            commands::remote::get_fetch_remote,
            commands::remote::get_pull_remote,
            commands::remote::get_push_remote,
            commands::remote::add_remote,
            commands::remote::remove_remote,
            commands::remote::rename_remote,
            commands::remote::set_remote_url,
            commands::remote::fetch,
            commands::remote::fetch_all_remotes,
            commands::remote::get_fetch_status,
            commands::remote::pull,
            commands::remote::push,
            commands::remote::push_to_multiple_remotes,
            commands::remote::cancel_operation,
            commands::remote::deepen_repository,
            commands::remote::unshallow_repository,
            commands::merge::merge,
            commands::merge::abort_merge,
            commands::merge::commit_merge,
            commands::merge::rebase,
            commands::merge::continue_rebase,
            commands::merge::abort_rebase,
            commands::merge::get_rebase_commits,
            commands::merge::is_ancestor_of_head,
            commands::merge::execute_interactive_rebase,
            commands::merge::get_conflicts,
            commands::merge::get_blob_content,
            commands::merge::resolve_conflict,
            commands::merge::resolve_conflict_take_side,
            commands::merge::detect_conflict_markers,
            commands::merge::get_conflict_details,
            commands::stash::get_stashes,
            commands::stash::create_stash,
            commands::stash::apply_stash,
            commands::stash::drop_stash,
            commands::stash::pop_stash,
            commands::stash::stash_show,
            commands::tags::get_tags,
            commands::tags::get_tag_details,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::tags::push_tag,
            commands::tags::delete_remote_tag,
            commands::tags::edit_tag_message,
            commands::diff::get_diff,
            commands::diff::get_diff_with_options,
            commands::diff::get_file_diff,
            commands::diff::get_commit_files,
            commands::diff::get_commit_file_diff,
            commands::diff::get_commits_stats,
            commands::diff::get_file_blame,
            commands::diff::get_image_versions,
            commands::refs::get_refs_by_commit,
            commands::describe::describe,
            commands::shortlog::shortlog,
            commands::watcher::start_watching,
            commands::watcher::stop_watching,
            commands::rewrite::cherry_pick,
            commands::rewrite::continue_cherry_pick,
            commands::rewrite::abort_cherry_pick,
            commands::rewrite::skip_cherry_pick,
            commands::rewrite::revert,
            commands::rewrite::continue_revert,
            commands::rewrite::abort_revert,
            commands::rewrite::skip_revert,
            commands::rewrite::reset,
            commands::rewrite::get_rebase_state,
            commands::rewrite::get_rebase_todo,
            commands::rewrite::update_rebase_todo,
            commands::rewrite::skip_rebase_commit,
            commands::rewrite::drop_commit,
            commands::rewrite::reorder_commits,
            commands::rewrite::cherry_pick_from_branch,
            commands::rewrite::cherry_pick_range,
            commands::squash::squash_commits,
            commands::squash::fixup_commit,
            commands::reflog::get_reflog,
            commands::reflog::reset_to_reflog,
            // Undo/redo history
            commands::undo::get_undo_history,
            commands::undo::undo_last_action,
            commands::undo::redo_last_action,
            commands::undo::record_action,
            commands::clean::get_cleanable_files,
            commands::clean::clean_files,
            commands::clean::clean_all,
            commands::bisect::get_bisect_status,
            commands::bisect::bisect_start,
            commands::bisect::bisect_bad,
            commands::bisect::bisect_good,
            commands::bisect::bisect_skip,
            commands::bisect::bisect_reset,
            commands::submodule::get_submodules,
            commands::submodule::add_submodule,
            commands::submodule::init_submodules,
            commands::submodule::update_submodules,
            commands::submodule::sync_submodules,
            commands::submodule::deinit_submodule,
            commands::submodule::remove_submodule,
            commands::submodule::get_submodule_status,
            commands::submodule::submodule_foreach,
            commands::worktree::get_worktrees,
            commands::worktree::add_worktree,
            commands::worktree::remove_worktree,
            commands::worktree::prune_worktrees,
            commands::worktree::lock_worktree,
            commands::worktree::unlock_worktree,
            commands::worktree::move_worktree,
            commands::worktree::repair_worktrees,
            commands::lfs::get_lfs_status,
            commands::lfs::init_lfs,
            commands::lfs::lfs_track,
            commands::lfs::lfs_untrack,
            commands::lfs::get_lfs_files,
            commands::lfs::lfs_pull,
            commands::lfs::lfs_fetch,
            commands::lfs::lfs_prune,
            commands::lfs::lfs_migrate,
            // Repository maintenance
            commands::maintenance::run_garbage_collection,
            commands::maintenance::prune_remote_tracking_branches,
            commands::maintenance::verify_repository,
            commands::maintenance::get_repo_size_info,
            commands::maintenance::run_gc,
            commands::maintenance::run_fsck,
            commands::maintenance::run_prune,
            commands::maintenance::get_repository_stats,
            commands::maintenance::get_pack_info,
            commands::gpg::get_gpg_config,
            commands::gpg::get_gpg_keys,
            commands::gpg::set_signing_key,
            commands::gpg::set_commit_signing,
            commands::gpg::set_tag_signing,
            commands::gpg::get_commit_signature,
            commands::gpg::get_commits_signatures,
            commands::gpg::get_signing_status,
            commands::ssh::get_ssh_config,
            commands::ssh::get_ssh_keys,
            commands::ssh::generate_ssh_key,
            commands::ssh::test_ssh_connection,
            commands::ssh::add_key_to_agent,
            commands::ssh::list_agent_keys,
            commands::ssh::get_public_key_content,
            commands::ssh::delete_ssh_key,
            commands::config::get_config_value,
            commands::config::set_config_value,
            commands::config::unset_config_value,
            commands::config::get_config_list,
            commands::config::get_user_identity,
            commands::config::set_user_identity,
            commands::config::get_aliases,
            commands::config::set_alias,
            commands::config::delete_alias,
            commands::config::get_common_settings,
            // Line ending and encoding config
            commands::config::get_line_ending_config,
            commands::config::set_line_ending_config,
            commands::config::get_git_config,
            commands::config::set_git_config,
            commands::config::get_all_git_config,
            commands::config::unset_git_config,
            // Git profiles
            commands::profiles::get_profiles,
            commands::profiles::get_profiles_config,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
            commands::profiles::apply_profile,
            commands::profiles::detect_profile_for_repository,
            commands::profiles::get_assigned_profile,
            commands::profiles::assign_profile_to_repository,
            commands::profiles::unassign_profile_from_repository,
            commands::profiles::get_current_identity,
            // Unified profiles (git identity + global accounts)
            commands::unified_profiles::get_unified_profiles_config,
            commands::unified_profiles::get_unified_profiles,
            commands::unified_profiles::get_unified_profile,
            commands::unified_profiles::save_unified_profile,
            commands::unified_profiles::delete_unified_profile,
            commands::unified_profiles::set_default_unified_profile,
            // Global account commands (v3)
            commands::unified_profiles::get_global_accounts,
            commands::unified_profiles::get_global_accounts_by_type,
            commands::unified_profiles::get_global_account,
            commands::unified_profiles::save_global_account,
            commands::unified_profiles::delete_global_account,
            commands::unified_profiles::set_default_global_account,
            commands::unified_profiles::set_profile_default_account,
            commands::unified_profiles::remove_profile_default_account,
            commands::unified_profiles::update_global_account_cached_user,
            commands::unified_profiles::get_profile_preferred_account,
            commands::unified_profiles::get_repository_preferred_account,
            // Deprecated profile-scoped account commands (kept for compatibility)
            commands::unified_profiles::add_account_to_profile,
            commands::unified_profiles::update_account_in_profile,
            commands::unified_profiles::remove_account_from_profile,
            commands::unified_profiles::set_default_account_in_profile,
            commands::unified_profiles::update_profile_account_cached_user,
            commands::unified_profiles::detect_unified_profile_for_repository,
            commands::unified_profiles::get_assigned_unified_profile,
            commands::unified_profiles::assign_unified_profile_to_repository,
            commands::unified_profiles::unassign_unified_profile_from_repository,
            commands::unified_profiles::apply_unified_profile,
            commands::unified_profiles::get_current_git_identity,
            commands::unified_profiles::needs_unified_profiles_migration,
            commands::unified_profiles::preview_unified_profiles_migration,
            commands::unified_profiles::execute_unified_profiles_migration,
            commands::unified_profiles::get_migration_backup_info,
            commands::unified_profiles::restore_migration_backup,
            commands::unified_profiles::delete_migration_backup,
            commands::unified_profiles::get_account_from_any_profile,
            commands::unified_profiles::get_repository_account,
            commands::credentials::get_credential_helpers,
            commands::credentials::set_credential_helper,
            commands::credentials::unset_credential_helper,
            commands::credentials::get_available_helpers,
            commands::credentials::test_credentials,
            commands::credentials::erase_credentials,
            commands::credentials::store_git_credentials,
            commands::credentials::delete_git_credentials,
            commands::credentials::store_keyring_token,
            commands::credentials::get_keyring_token,
            commands::credentials::delete_keyring_token,
            commands::credentials::detect_credential_manager,
            // GitHub integration
            commands::github::check_github_connection,
            commands::github::detect_github_repo,
            commands::github::list_pull_requests,
            commands::github::get_pull_request,
            commands::github::create_pull_request,
            commands::github::get_pull_request_reviews,
            commands::github::get_workflow_runs,
            commands::github::get_check_runs,
            commands::github::get_commit_status,
            // GitHub Issues
            commands::github::list_issues,
            commands::github::get_issue,
            commands::github::create_issue,
            commands::github::update_issue_state,
            commands::github::get_issue_comments,
            commands::github::add_issue_comment,
            commands::github::get_repo_labels,
            // GitHub Releases
            commands::github::list_releases,
            commands::github::get_release_by_tag,
            commands::github::get_latest_release,
            commands::github::create_release,
            commands::github::delete_release,
            commands::github::configure_github_app,
            commands::github::get_github_app_config,
            commands::github::remove_github_app_config,
            commands::github::list_github_app_installations,
            // Azure DevOps integration
            commands::azure_devops::check_ado_connection,
            commands::azure_devops::detect_ado_repo,
            commands::azure_devops::list_ado_pull_requests,
            commands::azure_devops::get_ado_pull_request,
            commands::azure_devops::create_ado_pull_request,
            commands::azure_devops::get_ado_work_items,
            commands::azure_devops::query_ado_work_items,
            commands::azure_devops::create_azure_devops_work_item,
            commands::azure_devops::list_ado_pipeline_runs,
            commands::azure_devops::list_ado_organizations,
            // GitLab integration
            commands::gitlab::check_gitlab_connection,
            commands::gitlab::detect_gitlab_repo,
            commands::gitlab::list_gitlab_merge_requests,
            commands::gitlab::get_gitlab_merge_request,
            commands::gitlab::create_gitlab_merge_request,
            commands::gitlab::list_gitlab_issues,
            commands::gitlab::create_gitlab_issue,
            commands::gitlab::list_gitlab_pipelines,
            commands::gitlab::get_gitlab_labels,
            // Bitbucket integration
            commands::bitbucket::store_bitbucket_credentials,
            commands::bitbucket::get_bitbucket_credentials,
            commands::bitbucket::delete_bitbucket_credentials,
            commands::bitbucket::check_bitbucket_connection,
            commands::bitbucket::check_bitbucket_connection_with_token,
            commands::bitbucket::detect_bitbucket_repo,
            commands::bitbucket::list_bitbucket_pull_requests,
            commands::bitbucket::get_bitbucket_pull_request,
            commands::bitbucket::create_bitbucket_pull_request,
            commands::bitbucket::list_bitbucket_issues,
            commands::bitbucket::create_bitbucket_issue,
            commands::bitbucket::list_bitbucket_pipelines,
            // Commit templates
            commands::templates::get_commit_template,
            commands::templates::list_templates,
            commands::templates::save_template,
            commands::templates::delete_template,
            commands::templates::get_conventional_types,
            // PR/MR templates
            commands::pr_templates::get_pr_templates,
            commands::pr_templates::get_pr_template_content,
            // Issue templates
            commands::issue_templates::get_issue_templates,
            commands::issue_templates::get_issue_template_content,
            // Auto-fetch
            commands::autofetch::start_auto_fetch,
            commands::autofetch::trigger_auto_fetch,
            commands::autofetch::stop_auto_fetch,
            commands::autofetch::is_auto_fetch_running,
            commands::autofetch::get_remote_status,
            // Auto-update
            commands::update::check_for_update,
            commands::update::download_and_install_update,
            commands::update::start_auto_update_check,
            commands::update::stop_auto_update_check,
            commands::update::is_auto_update_running,
            commands::update::get_app_version,
            commands::update::get_build_info,
            // AI provider system
            commands::ai::get_ai_providers,
            commands::ai::get_active_ai_provider,
            commands::ai::set_ai_provider,
            commands::ai::set_ai_api_key,
            commands::ai::set_ai_model,
            commands::ai::test_ai_provider,
            commands::ai::auto_detect_ai_providers,
            commands::ai::generate_commit_message,
            commands::ai::is_ai_available,
            commands::ai::ai_unavailable_reason,
            commands::ai::suggest_conflict_resolution,
            commands::ai::generate_changelog,
            commands::ai::analyze_staged_changes,
            commands::ai::generate_pr_description,
            commands::ai::suggest_commit_splits,
            commands::ai::explain_conflict,
            commands::ai::find_reflog_entry,
            commands::merge::preview_rebase,
            // Local AI model management
            commands::local_ai::get_system_capabilities,
            commands::local_ai::get_available_models,
            commands::local_ai::get_downloaded_models,
            commands::local_ai::download_model,
            commands::local_ai::cancel_model_download,
            commands::local_ai::delete_model,
            commands::local_ai::get_model_status,
            commands::local_ai::get_loaded_model_name,
            commands::local_ai::get_recommended_model,
            commands::local_ai::load_model,
            commands::local_ai::unload_model,
            // MCP server
            commands::mcp::start_mcp_server,
            commands::mcp::stop_mcp_server,
            commands::mcp::get_mcp_status,
            commands::mcp::get_mcp_config,
            commands::mcp::set_mcp_config,
            commands::mcp::regenerate_mcp_token,
            // OAuth authentication
            commands::oauth::oauth_get_authorize_url,
            commands::oauth::oauth_start_github_flow,
            commands::oauth::oauth_exchange_code,
            commands::oauth::oauth_refresh_token,
            commands::oauth::oauth_wait_for_callback,
            commands::oauth::oauth_wait_for_github_callback,
            commands::oauth::oauth_cancel_flow,
            commands::oauth::discover_oidc_provider,
            commands::oauth::decode_oidc_id_token,
            // Git Flow
            commands::gitflow::get_gitflow_config,
            commands::gitflow::init_gitflow,
            commands::gitflow::gitflow_start_feature,
            commands::gitflow::gitflow_finish_feature,
            commands::gitflow::gitflow_record_squash_finish,
            commands::gitflow::gitflow_start_release,
            commands::gitflow::gitflow_finish_release,
            commands::gitflow::gitflow_start_hotfix,
            commands::gitflow::gitflow_finish_hotfix,
            // Patch operations
            commands::patch::create_patch,
            commands::patch::apply_patch,
            commands::patch::apply_patch_to_index,
            // Archive
            commands::archive::create_archive,
            commands::archive::get_archive_files,
            // Bundle
            commands::bundle::bundle_create,
            commands::bundle::bundle_verify,
            commands::bundle::bundle_list_heads,
            commands::bundle::bundle_unbundle,
            // Git Notes
            commands::notes::get_note,
            commands::notes::get_notes,
            commands::notes::set_note,
            commands::notes::remove_note,
            commands::notes::get_notes_refs,
            // Gitignore management
            commands::gitignore::get_gitignore,
            commands::gitignore::add_to_gitignore,
            commands::gitignore::remove_from_gitignore,
            commands::gitignore::is_ignored,
            commands::gitignore::check_ignore,
            commands::gitignore::check_ignore_verbose,
            commands::gitignore::get_gitignore_templates,
            // Gitattributes management
            commands::gitattributes::get_gitattributes,
            commands::gitattributes::add_gitattribute,
            commands::gitattributes::remove_gitattribute,
            commands::gitattributes::update_gitattribute,
            commands::gitattributes::get_common_attributes,
            // Git Hooks
            commands::hooks::get_hooks,
            commands::hooks::get_hook,
            commands::hooks::save_hook,
            commands::hooks::delete_hook,
            commands::hooks::toggle_hook,
            // Terminal integration
            commands::terminal::open_terminal,
            commands::terminal::open_file_manager,
            commands::terminal::open_in_editor,
            // Repository statistics
            commands::stats::get_repo_stats,
            commands::stats::get_contributor_stats,
            commands::stats::get_repo_statistics,
            // Search / grep
            commands::search::search_in_files,
            commands::search::search_in_diff,
            commands::search::search_in_commits,
            commands::search::search_in_commit_messages,
            commands::search::search_commits_by_content,
            commands::search::search_commits_by_file,
            // Search index (background indexing)
            commands::search_index::build_search_index,
            commands::search_index::search_index,
            commands::search_index::refresh_search_index,
            commands::search_index::drop_search_index,
            // Embedding index (semantic search)
            commands::embedding_index::build_embedding_index,
            commands::embedding_index::refresh_embedding_index,
            commands::embedding_index::semantic_search,
            commands::embedding_index::get_embedding_index_status,
            commands::embedding_index::cancel_embedding_build,
            commands::embedding_index::is_embedding_model_downloaded,
            commands::embedding_index::download_embedding_model,
            // Sparse checkout
            commands::sparse_checkout::get_sparse_checkout_config,
            commands::sparse_checkout::enable_sparse_checkout,
            commands::sparse_checkout::disable_sparse_checkout,
            commands::sparse_checkout::set_sparse_checkout_patterns,
            commands::sparse_checkout::add_sparse_checkout_patterns,
            // Avatar / Gravatar
            commands::avatar::get_avatar_url,
            commands::avatar::get_avatar_urls,
            // Commit signature verification
            commands::signature::verify_commit_signature,
            commands::signature::get_commits_signature_info,
            commands::signature::get_signing_config,
            // Branch comparison
            commands::compare::compare_branches,
            // External diff tool
            commands::difftool::get_diff_tool,
            commands::difftool::set_diff_tool,
            commands::difftool::list_diff_tools,
            commands::difftool::launch_diff_tool,
            // External merge tool
            commands::merge_tool::get_merge_tool_config,
            commands::merge_tool::set_merge_tool_config,
            commands::merge_tool::launch_merge_tool,
            commands::merge_tool::get_available_merge_tools,
            commands::merge_tool::auto_detect_merge_tool,
            // File operations (reveal, open in app/editor)
            commands::file::reveal_in_file_manager,
            commands::file::open_in_default_app,
            commands::file::open_in_configured_editor,
            commands::file::get_editor_config,
            commands::file::set_editor_config,
            // File encoding detection and conversion
            commands::encoding::detect_file_encoding,
            commands::encoding::convert_file_encoding,
            // Checkout file from commit/branch
            commands::checkout_file::checkout_file_from_commit,
            commands::checkout_file::checkout_file_from_branch,
            commands::checkout_file::get_file_at_commit,
            // Clipboard operations
            commands::clipboard::copy_to_clipboard,
            commands::clipboard::get_commit_info_for_copy,
            commands::clipboard::get_file_path_for_copy,
            // Commit message validation
            commands::validation::validate_commit_message,
            commands::validation::get_commit_message_rules,
            commands::validation::set_commit_message_rules,
            // Workspaces
            commands::workspace::get_workspaces,
            commands::workspace::get_workspace,
            commands::workspace::save_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::add_repository_to_workspace,
            commands::workspace::remove_repository_from_workspace,
            commands::workspace::update_workspace_last_opened,
            commands::workspace::validate_workspace_repositories,
            commands::workspace::search_workspace,
            commands::workspace::export_workspace,
            commands::workspace::import_workspace,
            // Bookmarks & recent repos
            commands::bookmarks::get_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            commands::bookmarks::update_bookmark,
            commands::bookmarks::get_recent_repos,
            commands::bookmarks::record_repo_opened,
            // Custom actions
            commands::custom_actions::get_custom_actions,
            commands::custom_actions::save_custom_action,
            commands::custom_actions::delete_custom_action,
            commands::custom_actions::run_custom_action,
            // Advanced search
            commands::advanced_search::filter_commits,
            commands::advanced_search::get_branch_diff_commits,
            commands::advanced_search::get_file_log,
            // JIRA integration
            commands::jira::get_jira_config,
            commands::jira::save_jira_config,
            commands::jira::get_jira_issues,
            commands::jira::get_jira_issue,
            commands::jira::get_jira_transitions,
            commands::jira::transition_jira_issue,
            commands::jira::create_branch_from_jira,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Unload the local AI model before the process exits to avoid
            // llama.cpp crashing during unordered global teardown.
            let ai_state = app_handle.state::<services::ai::AiState>().inner().clone();
            tauri::async_runtime::block_on(async {
                let service = ai_state.read().await;
                service.unload_local_model().await;
                tracing::info!("Unloaded local AI model for clean shutdown");
            });
        }
    });
}
