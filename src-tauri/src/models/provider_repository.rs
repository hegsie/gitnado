//! Repository listings returned by a hosting provider account.
//!
//! GitHub, GitLab, Bitbucket and Azure DevOps each describe a repository with a
//! different payload. The clone dialog's account picker shows one list whatever
//! the provider is, so every provider's listing command normalises into these
//! two types instead of leaking four shapes into the UI.

use serde::{Deserialize, Serialize};

/// One repository owned by (or shared with) a connected account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRepository {
    /// Provider-assigned id, stringified so GitHub's u64 and Bitbucket's UUID
    /// share one field. Used only as a list key.
    pub id: String,
    /// Short repository name ("leviathan").
    pub name: String,
    /// Owner / namespace / workspace / project the repository lives under.
    pub owner: String,
    /// "owner/name" as the provider spells it, for display and filtering.
    pub full_name: String,
    pub description: Option<String>,
    /// True when the provider reports the repository as non-public. GitLab's
    /// "internal" visibility counts as non-public here.
    pub is_private: bool,
    /// HTTPS clone URL — what the clone dialog fills in.
    pub clone_url: String,
    /// Browser URL, when the provider returns one.
    pub web_url: Option<String>,
    pub default_branch: Option<String>,
    /// ISO-8601 timestamp of the last push/activity, when the provider reports
    /// one. Azure DevOps does not, so it stays `None` there.
    pub last_pushed_at: Option<String>,
}

/// One page of an account's repository listing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRepositoryPage {
    pub repositories: Vec<ProviderRepository>,
    /// Page number to request for the next batch, or `None` when the listing is
    /// exhausted. Pages are 1-based for every provider here.
    pub next_page: Option<u32>,
}
