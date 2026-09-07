//! GitHub App authentication service
//!
//! Handles JWT generation and installation token management for
//! GitHub App-based authentication (fine-grained, org-level permissions).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Configuration for a GitHub App
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAppConfig {
    pub app_id: u64,
    pub private_key_pem: String,
    pub installation_id: u64,
}

/// A cached installation access token
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationToken {
    pub token: String,
    pub expires_at: String,
}

/// Information about a GitHub App installation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInstallation {
    pub id: u64,
    pub account: AppInstallationAccount,
    // GitHub's API returns snake_case; keep camelCase for the FE (Serialize) but
    // accept the API's snake_case on deserialize via aliases, or parsing fails.
    #[serde(alias = "app_id")]
    pub app_id: u64,
    #[serde(alias = "target_type")]
    pub target_type: String,
    pub permissions: serde_json::Value,
}

/// Account info for an installation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInstallationAccount {
    pub login: String,
    pub id: u64,
    #[serde(rename = "type")]
    pub account_type: String,
    #[serde(alias = "avatar_url")]
    pub avatar_url: Option<String>,
}

/// JWT claims for GitHub App authentication
#[derive(Debug, Serialize, Deserialize)]
struct GitHubJwtClaims {
    iat: u64,
    exp: u64,
    iss: String,
}

/// Cached token state
pub struct GitHubAppState {
    cached_tokens: std::collections::HashMap<u64, InstallationToken>,
}

pub type SharedGitHubAppState = Arc<RwLock<GitHubAppState>>;

impl Default for GitHubAppState {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHubAppState {
    pub fn new() -> Self {
        Self {
            cached_tokens: std::collections::HashMap::new(),
        }
    }

    /// Get a cached token if still valid (with 5-min buffer)
    pub fn get_cached_token(&self, installation_id: u64) -> Option<&str> {
        if let Some(token) = self.cached_tokens.get(&installation_id) {
            if let Ok(expires) = DateTime::parse_from_rfc3339(&token.expires_at) {
                let now = Utc::now();
                let buffer = chrono::Duration::minutes(5);
                if expires > now + buffer {
                    return Some(&token.token);
                }
            }
        }
        None
    }

    /// Cache a token
    pub fn cache_token(&mut self, installation_id: u64, token: InstallationToken) {
        self.cached_tokens.insert(installation_id, token);
    }

    /// Remove cached token
    pub fn remove_cached_token(&mut self, installation_id: u64) {
        self.cached_tokens.remove(&installation_id);
    }
}

/// Generate a JWT for GitHub App authentication.
///
/// The JWT is signed with RS256 using the app's private key and is valid for 10 minutes.
pub fn generate_jwt(app_id: u64, private_key_pem: &str) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("System time error: {}", e))?
        .as_secs();

    let claims = GitHubJwtClaims {
        iat: now.saturating_sub(60), // 60 seconds in the past to account for clock drift
        exp: now + 600,              // 10 minutes
        iss: app_id.to_string(),
    };

    let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
        .map_err(|e| format!("Invalid RSA private key: {}", e))?;

    let header = Header::new(Algorithm::RS256);

    encode(&header, &claims, &key).map_err(|e| format!("Failed to generate JWT: {}", e))
}

/// Get an installation access token from GitHub.
///
/// Uses the JWT to authenticate and request a short-lived installation token.
pub async fn get_installation_token(
    jwt: &str,
    installation_id: u64,
) -> Result<InstallationToken, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/app/installations/{}/access_tokens",
        installation_id
    );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", jwt))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Gitnado-Git-Client")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Failed to request installation token: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("GitHub API error ({}): {}", status, body));
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        token: String,
        expires_at: String,
    }

    let token_response: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    Ok(InstallationToken {
        token: token_response.token,
        expires_at: token_response.expires_at,
    })
}

/// List all installations for a GitHub App.
pub async fn list_installations(jwt: &str) -> Result<Vec<AppInstallation>, String> {
    let client = reqwest::Client::new();

    let response = client
        .get("https://api.github.com/app/installations")
        .header("Authorization", format!("Bearer {}", jwt))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Gitnado-Git-Client")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Failed to list installations: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("GitHub API error ({}): {}", status, body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse installations: {}", e))
}

/// Get or refresh an installation token, using cache when possible.
pub async fn get_or_refresh_token(
    state: &SharedGitHubAppState,
    config: &GitHubAppConfig,
) -> Result<String, String> {
    // Check cache first
    {
        let guard = state.read().await;
        if let Some(token) = guard.get_cached_token(config.installation_id) {
            return Ok(token.to_string());
        }
    }

    // Generate new token
    let jwt = generate_jwt(config.app_id, &config.private_key_pem)?;
    let token = get_installation_token(&jwt, config.installation_id).await?;
    let token_str = token.token.clone();

    // Cache it
    {
        let mut guard = state.write().await;
        guard.cache_token(config.installation_id, token);
    }

    Ok(token_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jwt_claims_structure() {
        let claims = GitHubJwtClaims {
            iat: 1000,
            exp: 1600,
            iss: "12345".to_string(),
        };

        let json = serde_json::to_string(&claims).unwrap();
        assert!(json.contains("12345"));
        assert!(json.contains("1000"));
        assert!(json.contains("1600"));
    }

    #[test]
    fn test_app_installation_parses_github_snake_case() {
        // GitHub's REST API returns snake_case; deserialization must accept it.
        let body = r#"{
            "id": 42,
            "account": {"login": "octocat", "id": 1, "type": "User", "avatar_url": "https://x/y.png"},
            "app_id": 99,
            "target_type": "Organization",
            "permissions": {"contents": "read"}
        }"#;
        let install: AppInstallation = serde_json::from_str(body).unwrap();
        assert_eq!(install.app_id, 99);
        assert_eq!(install.target_type, "Organization");
        assert_eq!(
            install.account.avatar_url.as_deref(),
            Some("https://x/y.png")
        );

        // And it still serializes to camelCase for the frontend.
        let json = serde_json::to_string(&install).unwrap();
        assert!(json.contains("appId"));
        assert!(json.contains("targetType"));
    }

    /// Signs a JWT with a freshly generated key and verifies it end to end.
    ///
    /// This is the only test that reaches jsonwebtoken's signing path. Without a
    /// crypto backend feature enabled, `encode` resolves to a placeholder
    /// CryptoProvider whose signer factory panics, so GitHub App auth would blow
    /// up at runtime while every other test here still passed — the invalid-key
    /// test fails earlier, inside PEM parsing, and never reaches the signer.
    #[test]
    fn test_generate_jwt_signs_and_verifies_under_rs256() {
        use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
        use aws_lc_rs::rsa::{KeyPair, KeySize};
        use aws_lc_rs::signature::KeyPair as _;
        use jsonwebtoken::{decode, DecodingKey, Validation};

        let keypair = KeyPair::generate(KeySize::Rsa2048).expect("generate RSA key");
        let private_der: Pkcs8V1Der = keypair.as_der().expect("private key DER");
        let public_der: PublicKeyX509Der = keypair.public_key().as_der().expect("public key DER");
        let private_pem = pem::encode(&pem::Pem::new("PRIVATE KEY", private_der.as_ref()));
        let public_pem = pem::encode(&pem::Pem::new("PUBLIC KEY", public_der.as_ref()));

        let token = generate_jwt(12345, &private_pem).expect("generate_jwt must sign");

        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_aud = false;
        validation.set_issuer(&["12345"]);
        let decoded = decode::<serde_json::Value>(
            &token,
            &DecodingKey::from_rsa_pem(public_pem.as_bytes()).expect("public key"),
            &validation,
        )
        .expect("token must verify under RS256");

        assert_eq!(decoded.header.alg, Algorithm::RS256);
        assert_eq!(decoded.claims["iss"], "12345");
        // iat is backdated 60s for clock drift, exp is 10 minutes out.
        let iat = decoded.claims["iat"].as_u64().unwrap();
        let exp = decoded.claims["exp"].as_u64().unwrap();
        assert_eq!(exp - iat, 660);
    }

    #[test]
    fn test_generate_jwt_invalid_key() {
        let result = generate_jwt(12345, "not a valid PEM key");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid RSA"));
    }

    #[test]
    fn test_github_app_state_cache() {
        let mut state = GitHubAppState::new();

        // No cached token initially
        assert!(state.get_cached_token(1).is_none());

        // Cache a token that expires far in the future
        state.cache_token(
            1,
            InstallationToken {
                token: "ghs_test123".to_string(),
                expires_at: "2099-01-01T00:00:00Z".to_string(),
            },
        );

        assert_eq!(state.get_cached_token(1), Some("ghs_test123"));

        // Remove it
        state.remove_cached_token(1);
        assert!(state.get_cached_token(1).is_none());
    }

    #[test]
    fn test_github_app_state_expired_token() {
        let mut state = GitHubAppState::new();

        // Cache an expired token
        state.cache_token(
            1,
            InstallationToken {
                token: "expired".to_string(),
                expires_at: "2020-01-01T00:00:00Z".to_string(),
            },
        );

        // Should not return expired token
        assert!(state.get_cached_token(1).is_none());
    }
}
