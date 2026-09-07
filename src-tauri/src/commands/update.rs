//! Update commands for checking and installing application updates

use crate::error::Result;
use crate::services::update_service::{
    check_for_update_manual, install_update, UpdateCheckEvent, UpdateState,
};
use tauri::{command, AppHandle, State};

/// Check for updates manually (does not auto-install)
#[command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheckEvent> {
    check_for_update_manual(&app)
        .await
        .map_err(crate::error::GitnadoError::OperationFailed)
}

/// Download and install the available update
#[command]
pub async fn download_and_install_update(app: AppHandle) -> Result<()> {
    install_update(&app)
        .await
        .map_err(crate::error::GitnadoError::OperationFailed)
}

/// Start automatic update checking
#[command]
pub async fn start_auto_update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
    interval_hours: u32,
) -> Result<()> {
    if interval_hours == 0 {
        return Err(crate::error::GitnadoError::OperationFailed(
            "Interval must be greater than 0".to_string(),
        ));
    }

    let mut service = state.write().await;
    service.start_periodic_check(interval_hours, app);
    Ok(())
}

/// Stop automatic update checking
#[command]
pub async fn stop_auto_update_check(state: State<'_, UpdateState>) -> Result<()> {
    let mut service = state.write().await;
    service.stop_periodic_check();
    Ok(())
}

/// Check if auto-update is running
#[command]
pub async fn is_auto_update_running(state: State<'_, UpdateState>) -> Result<bool> {
    let service = state.read().await;
    Ok(service.is_running())
}

/// Get current application version
#[command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Build information for supply chain transparency
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub rust_version: String,
    pub target: String,
    pub profile: String,
}

/// Get build information for security/transparency display
#[command]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        rust_version: option_env!("RUSTC_VERSION")
            .unwrap_or("unknown")
            .to_string(),
        target: option_env!("TARGET").unwrap_or("unknown").to_string(),
        profile: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::update_service::{create_update_state, UpdateService};

    #[test]
    fn test_get_app_version() {
        let version = get_app_version();

        // Version should not be empty
        assert!(!version.is_empty());

        // Version should follow semver format (x.y.z or similar)
        let parts: Vec<&str> = version.split('.').collect();
        assert!(parts.len() >= 2, "Version should have at least major.minor");

        // Each part should be parseable as a number (for major and minor at least)
        assert!(
            parts[0].parse::<u32>().is_ok(),
            "Major version should be a number"
        );
        assert!(
            parts[1].parse::<u32>().is_ok(),
            "Minor version should be a number"
        );
    }

    #[test]
    fn test_get_app_version_matches_cargo() {
        let version = get_app_version();
        let cargo_version = env!("CARGO_PKG_VERSION");
        assert_eq!(version, cargo_version);
    }

    #[test]
    fn test_update_service_new() {
        let service = UpdateService::new();
        assert!(!service.is_running());
    }

    #[test]
    fn test_update_service_default() {
        let service = UpdateService::default();
        assert!(!service.is_running());
    }

    #[test]
    fn test_create_update_state() {
        let state = create_update_state();
        // Should be able to access the state
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let service = state.read().await;
            assert!(!service.is_running());
        });
    }

    #[tokio::test]
    async fn test_update_state_read_write() {
        let state = create_update_state();

        // Test read access
        {
            let service = state.read().await;
            assert!(!service.is_running());
        }

        // Test write access
        {
            let mut service = state.write().await;
            // Just verify we can get write access
            assert!(!service.is_running());
            // We can't actually start periodic check without an AppHandle
            // but we can verify stop works
            service.stop_periodic_check();
        }

        // Should still not be running
        {
            let service = state.read().await;
            assert!(!service.is_running());
        }
    }

    #[tokio::test]
    async fn test_update_service_stop_when_not_running() {
        let state = create_update_state();

        // Stopping when not running should be safe
        {
            let mut service = state.write().await;
            service.stop_periodic_check();
            assert!(!service.is_running());
        }
    }

    #[test]
    fn test_update_check_event_serialization() {
        use crate::services::update_service::UpdateCheckEvent;

        let event = UpdateCheckEvent {
            update_available: true,
            current_version: "0.1.0".to_string(),
            latest_version: Some("0.2.0".to_string()),
            release_notes: Some("Bug fixes and improvements".to_string()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("updateAvailable")); // camelCase
        assert!(json.contains("true"));
        assert!(json.contains("0.1.0"));
        assert!(json.contains("0.2.0"));
        assert!(json.contains("Bug fixes"));
    }

    #[test]
    fn test_update_check_event_no_update() {
        use crate::services::update_service::UpdateCheckEvent;

        let event = UpdateCheckEvent {
            update_available: false,
            current_version: "0.2.0".to_string(),
            latest_version: None,
            release_notes: None,
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("updateAvailable"));
        assert!(json.contains("false"));
        assert!(json.contains("0.2.0"));
        assert!(json.contains("null") || json.contains("latestVersion\":null"));
    }

    // Note: Testing the actual update commands (check_for_update, download_and_install_update,
    // start_auto_update_check, stop_auto_update_check, is_auto_update_running) requires
    // a Tauri AppHandle which is only available in a running Tauri application context.
    // These functions are better tested through integration tests or manual testing.
}
