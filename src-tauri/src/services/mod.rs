//! Service layer for Gitnado
//!
//! This module contains services that provide higher-level abstractions
//! over the raw git operations.

pub mod ai;
pub mod autofetch_service;
pub mod cancellation;
pub mod commit_index;
pub mod credentials_service;
pub mod embedding;
pub mod git_service;
pub mod github_app;
#[cfg(not(target_os = "macos"))]
pub mod keyring_util;
pub mod loopback_server;
pub mod oauth;
pub mod remote_ops;
pub mod transfer_monitor;
pub mod update_service;
pub mod watcher_service;

pub use ai::{create_ai_state, AiState};
pub use autofetch_service::{create_autofetch_state, AutoFetchState};
pub use cancellation::CancellationRegistry;
pub use credentials_service::CredentialsHelper;
pub use git_service::GitService;
pub use remote_ops::{RemoteOp, RemoteOpRegistry};
pub use transfer_monitor::{OperationProgress, TransferMonitor};
pub use update_service::{create_update_state, UpdateState};
pub use watcher_service::WatcherService;
