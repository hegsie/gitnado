//! Shared HTTP client construction, security gate validation, and response
//! error mapping for Git hosting provider integrations (GitHub, GitLab,
//! Bitbucket, Azure DevOps).

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

use crate::error::{GitnadoError, Result};

/// Default User-Agent header sent on outbound provider HTTP requests when
/// a request does not override it.
pub const DEFAULT_PROVIDER_USER_AGENT: &str = "Gitnado/1.0";

/// Default timeout (in seconds) for outbound provider HTTP requests.
pub const DEFAULT_PROVIDER_TIMEOUT_SECS: u64 = 30;

/// Enforce offline mode and the remote host allowlist for an outbound URL.
pub fn ensure_url_allowed(url: &str) -> Result<()> {
    crate::services::security::guard_url(url)
}

/// Construct a configured `reqwest::Client` with the standard provider
/// timeout (`DEFAULT_PROVIDER_TIMEOUT_SECS`) and user agent
/// (`DEFAULT_PROVIDER_USER_AGENT`).
pub fn build_provider_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_PROVIDER_TIMEOUT_SECS))
        .user_agent(DEFAULT_PROVIDER_USER_AGENT)
        .build()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to build HTTP client: {}", e)))
}

/// Validate `url` against the security gate and build a provider HTTP client.
pub fn build_guarded_provider_http_client(url: &str) -> Result<reqwest::Client> {
    ensure_url_allowed(url)?;
    build_provider_http_client()
}

/// Build an HTTP `Basic <base64(username:password)>` `Authorization` header value.
pub fn basic_auth_header(username: &str, password: &str) -> String {
    let credentials = format!("{}:{}", username, password);
    format!("Basic {}", BASE64.encode(credentials.as_bytes()))
}

/// Build an HTTP `Bearer <token>` `Authorization` header value.
pub fn bearer_auth_header(token: &str) -> String {
    format!("Bearer {}", token)
}

/// Extract a human-readable rate-limit hint from standard provider response
/// headers (`retry-after`, `x-ratelimit-remaining` / `x-ratelimit-reset`,
/// `ratelimit-remaining` / `ratelimit-reset`) when the request was throttled.
pub fn extract_rate_limit_hint(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> Option<String> {
    if status != reqwest::StatusCode::TOO_MANY_REQUESTS && status != reqwest::StatusCode::FORBIDDEN
    {
        return None;
    }

    if let Some(retry_after) = headers.get("retry-after").and_then(|v| v.to_str().ok()) {
        let trimmed = retry_after.trim();
        if !trimmed.is_empty() {
            return Some(format!("rate limit exceeded (retry after {}s)", trimmed));
        }
    }

    let remaining = headers
        .get("x-ratelimit-remaining")
        .or_else(|| headers.get("ratelimit-remaining"))
        .and_then(|v| v.to_str().ok())
        .map(str::trim);

    if remaining == Some("0") {
        if let Some(reset) = headers
            .get("x-ratelimit-reset")
            .or_else(|| headers.get("ratelimit-reset"))
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(format!("rate limit exhausted (resets at {})", reset));
        }
        return Some("rate limit exhausted".to_string());
    }

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Some("rate limit exceeded".to_string());
    }

    None
}

/// Map a non-2xx provider API response status and body into the standard
/// `<Provider> API error <status>: <body>` error. When the response body is
/// empty and rate-limit headers indicate throttling, the rate-limit hint is
/// used as the detail message.
pub fn map_provider_api_error_with_headers(
    provider_label: &str,
    status: reqwest::StatusCode,
    headers: Option<&reqwest::header::HeaderMap>,
    body: &str,
) -> GitnadoError {
    if body.trim().is_empty() {
        if let Some(hdrs) = headers {
            if let Some(hint) = extract_rate_limit_hint(status, hdrs) {
                return GitnadoError::OperationFailed(format!(
                    "{} API error {}: {}",
                    provider_label, status, hint
                ));
            }
        }
    }
    GitnadoError::OperationFailed(format!("{} API error {}: {}", provider_label, status, body))
}

/// Map a non-2xx provider API response status and body into
/// `GitnadoError::OperationFailed("<Provider> API error <status>: <body>")`.
pub fn map_provider_api_error(
    provider_label: &str,
    status: reqwest::StatusCode,
    body: &str,
) -> GitnadoError {
    map_provider_api_error_with_headers(provider_label, status, None, body)
}

/// Map a failed repository/project listing response into `AuthenticationRequired`
/// on 401 (and optionally 203 Non-Authoritative Information for Azure DevOps
/// sign-in redirects) or a standard provider API error otherwise.
pub fn map_repository_list_api_error(
    provider_label: &str,
    status: reqwest::StatusCode,
    body: &str,
    treat_203_as_auth_required: bool,
) -> GitnadoError {
    if status == reqwest::StatusCode::UNAUTHORIZED
        || (treat_203_as_auth_required
            && status == reqwest::StatusCode::NON_AUTHORITATIVE_INFORMATION)
    {
        return GitnadoError::AuthenticationRequired;
    }
    map_provider_api_error(provider_label, status, body)
}

/// Ensure a provider HTTP response has a 2xx status, or consume the body and
/// return the formatted `<Provider> API error <status>: <body>` error.
pub async fn check_provider_response(
    response: reqwest::Response,
    provider_label: &str,
) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.text().await.unwrap_or_default();
    Err(map_provider_api_error_with_headers(
        provider_label,
        status,
        Some(&headers),
        &body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::security::test_support::{self, no_policy};
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn test_constants() {
        assert_eq!(DEFAULT_PROVIDER_USER_AGENT, "Gitnado/1.0");
        assert_eq!(DEFAULT_PROVIDER_TIMEOUT_SECS, 30);
    }

    #[test]
    fn test_build_provider_http_client_succeeds() {
        let client = build_provider_http_client();
        assert!(client.is_ok());
    }

    #[test]
    fn test_ensure_url_allowed_respects_security_policy() {
        {
            let _guard = no_policy();
            assert!(ensure_url_allowed("https://api.github.com").is_ok());
        }
        {
            let _guard = test_support::offline();
            let err = ensure_url_allowed("https://api.github.com")
                .expect_err("offline mode must block outbound URLs");
            assert!(matches!(err, GitnadoError::NetworkBlocked(_)));
        }
        {
            let _guard = test_support::allowlist(&["gitlab.example.com"]);
            assert!(ensure_url_allowed("https://gitlab.example.com/api/v4/user").is_ok());
            let blocked = ensure_url_allowed("https://api.github.com")
                .expect_err("non-allowlisted host must be blocked");
            assert!(matches!(blocked, GitnadoError::NetworkBlocked(_)));
        }
    }

    #[test]
    fn test_build_guarded_provider_http_client_blocks_when_offline() {
        let _guard = test_support::offline();
        let err = build_guarded_provider_http_client("https://api.bitbucket.org/2.0")
            .expect_err("offline mode must block guarded client creation");
        assert!(matches!(err, GitnadoError::NetworkBlocked(_)));
    }

    #[test]
    fn test_auth_header_builders() {
        assert_eq!(bearer_auth_header("tok_123"), "Bearer tok_123");
        assert_eq!(
            basic_auth_header("alice", "secret"),
            "Basic YWxpY2U6c2VjcmV0"
        );
        assert_eq!(basic_auth_header("", "pat_token"), "Basic OnBhdF90b2tlbg==");
    }

    #[test]
    fn test_extract_rate_limit_hint() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("45"));
        assert_eq!(
            extract_rate_limit_hint(reqwest::StatusCode::TOO_MANY_REQUESTS, &headers).as_deref(),
            Some("rate limit exceeded (retry after 45s)")
        );

        let mut gh_headers = HeaderMap::new();
        gh_headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        gh_headers.insert("x-ratelimit-reset", HeaderValue::from_static("1700000000"));
        assert_eq!(
            extract_rate_limit_hint(reqwest::StatusCode::FORBIDDEN, &gh_headers).as_deref(),
            Some("rate limit exhausted (resets at 1700000000)")
        );

        let empty_headers = HeaderMap::new();
        assert_eq!(
            extract_rate_limit_hint(reqwest::StatusCode::BAD_REQUEST, &empty_headers),
            None
        );
    }

    #[test]
    fn test_map_provider_api_error_preserves_format_and_uses_rate_limit_fallback() {
        let err = map_provider_api_error("GitHub", reqwest::StatusCode::NOT_FOUND, "Not Found");
        assert_eq!(
            err.to_string(),
            "Operation failed: GitHub API error 404 Not Found: Not Found"
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        let throttled = map_provider_api_error_with_headers(
            "GitHub",
            reqwest::StatusCode::FORBIDDEN,
            Some(&headers),
            "",
        );
        assert!(throttled.to_string().contains("rate limit exhausted"));
    }

    #[test]
    fn test_map_repository_list_api_error() {
        let gh_unauth = map_repository_list_api_error(
            "GitHub",
            reqwest::StatusCode::UNAUTHORIZED,
            "Bad credentials",
            false,
        );
        assert!(matches!(gh_unauth, GitnadoError::AuthenticationRequired));

        let gh_203 = map_repository_list_api_error(
            "GitHub",
            reqwest::StatusCode::NON_AUTHORITATIVE_INFORMATION,
            "body",
            false,
        );
        assert!(matches!(gh_203, GitnadoError::OperationFailed(_)));

        let ado_203 = map_repository_list_api_error(
            "Azure DevOps",
            reqwest::StatusCode::NON_AUTHORITATIVE_INFORMATION,
            "<html>sign in</html>",
            true,
        );
        assert!(matches!(ado_203, GitnadoError::AuthenticationRequired));
    }
}
