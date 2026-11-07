//! Commit command handlers

mod amend_create;
mod history;
#[cfg(test)]
#[path = "commit/commit_tests.rs"]
mod test_suite;

pub use amend_create::*;
pub use history::*;

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Parse an ISO 8601 date string into a git2::Time
///
/// Supports formats like:
/// - "2024-01-15T10:30:00Z"
/// - "2024-01-15T10:30:00+05:00"
/// - "2024-01-15T10:30:00-03:00"
/// - Unix timestamp as string (e.g., "1705312200")
fn parse_iso8601_to_git_time(date_str: &str) -> std::result::Result<git2::Time, GitnadoError> {
    // Try parsing as unix timestamp first
    if let Ok(ts) = date_str.parse::<i64>() {
        return Ok(git2::Time::new(ts, 0));
    }

    // Try parsing ISO 8601 format
    // Format: YYYY-MM-DDTHH:MM:SS[Z|+HH:MM|-HH:MM]
    let (datetime_str, offset_minutes) = if let Some(stripped) = date_str.strip_suffix('Z') {
        (stripped, 0i32)
    } else if date_str.len() > 6 {
        // Check for +HH:MM or -HH:MM suffix
        let last6 = &date_str[date_str.len() - 6..];
        if (last6.starts_with('+') || last6.starts_with('-')) && last6.chars().nth(3) == Some(':') {
            let sign = if last6.starts_with('+') { 1 } else { -1 };
            let hours: i32 = last6[1..3].parse().map_err(|_| {
                GitnadoError::OperationFailed(format!("Invalid timezone offset in: {}", date_str))
            })?;
            let mins: i32 = last6[4..6].parse().map_err(|_| {
                GitnadoError::OperationFailed(format!("Invalid timezone offset in: {}", date_str))
            })?;
            (&date_str[..date_str.len() - 6], sign * (hours * 60 + mins))
        } else {
            (date_str, 0)
        }
    } else {
        (date_str, 0)
    };

    // Parse datetime: YYYY-MM-DDTHH:MM:SS
    let parts: Vec<&str> = datetime_str.split('T').collect();
    if parts.len() != 2 {
        return Err(GitnadoError::OperationFailed(format!(
            "Invalid ISO 8601 date format: {}. Expected YYYY-MM-DDTHH:MM:SS[Z|+HH:MM]",
            date_str
        )));
    }

    let date_parts: Vec<&str> = parts[0].split('-').collect();
    let time_parts: Vec<&str> = parts[1].split(':').collect();

    if date_parts.len() != 3 || time_parts.len() < 2 {
        return Err(GitnadoError::OperationFailed(format!(
            "Invalid ISO 8601 date format: {}. Expected YYYY-MM-DDTHH:MM:SS[Z|+HH:MM]",
            date_str
        )));
    }

    let year: i32 = date_parts[0].parse().map_err(|_| {
        GitnadoError::OperationFailed(format!("Invalid year in date: {}", date_str))
    })?;
    let month: u32 = date_parts[1].parse().map_err(|_| {
        GitnadoError::OperationFailed(format!("Invalid month in date: {}", date_str))
    })?;
    let day: u32 = date_parts[2]
        .parse()
        .map_err(|_| GitnadoError::OperationFailed(format!("Invalid day in date: {}", date_str)))?;
    let hour: u32 = time_parts[0].parse().map_err(|_| {
        GitnadoError::OperationFailed(format!("Invalid hour in date: {}", date_str))
    })?;
    let minute: u32 = time_parts[1].parse().map_err(|_| {
        GitnadoError::OperationFailed(format!("Invalid minute in date: {}", date_str))
    })?;
    let second: u32 = if time_parts.len() >= 3 {
        // Handle fractional seconds by taking only the integer part
        let sec_str = time_parts[2].split('.').next().unwrap_or("0");
        sec_str.parse().map_err(|_| {
            GitnadoError::OperationFailed(format!("Invalid second in date: {}", date_str))
        })?
    } else {
        0
    };

    // Convert to Unix timestamp
    // Simple calculation - days from epoch
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[m as usize] as i64;
        if m == 2 && is_leap_year(year) {
            days += 1;
        }
    }
    days += (day as i64) - 1;

    let timestamp = days * 86400 + (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64);

    // Adjust for timezone offset (offset is in minutes from UTC)
    let adjusted_timestamp = timestamp - (offset_minutes as i64) * 60;

    Ok(git2::Time::new(adjusted_timestamp, offset_minutes))
}

/// Check if a year is a leap year
fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Build a git2::Signature with an optional custom date
///
/// If `date_str` is provided, creates a signature with the given name/email but
/// with the specified date. Otherwise returns the original signature as-is.
fn signature_with_date<'a>(
    name: &str,
    email: &str,
    date_str: Option<&str>,
) -> std::result::Result<git2::Signature<'a>, GitnadoError> {
    match date_str {
        Some(ds) => {
            let time = parse_iso8601_to_git_time(ds)?;
            Ok(git2::Signature::new(name, email, &time)?)
        }
        None => Ok(git2::Signature::now(name, email)?),
    }
}

/// Check if a commit should be signed based on explicit parameter or repo config
pub(crate) fn should_sign_commit(path: &str, sign_commit: Option<bool>) -> Result<bool> {
    match sign_commit {
        Some(sign) => Ok(sign),
        None => {
            // Check repository config for commit.gpgsign
            let repo = git2::Repository::open(Path::new(path))?;
            let config = repo.config()?;
            Ok(config.get_bool("commit.gpgsign").unwrap_or(false))
        }
    }
}

/// Whether HEAD has already been published to its upstream.
///
/// Amending rewrites HEAD. When the commit being rewritten is already on the
/// remote, that rewrites PUBLISHED history: the branch and its upstream
/// diverge, the next push is rejected, and the only way forward is a force
/// push — which discards whatever anyone else based on that commit. None of
/// the amend surfaces said so, so this is what lets them ask first.
///
/// True only when the branch has an upstream AND that upstream contains HEAD.
/// A branch with no upstream, an unborn HEAD, a detached HEAD, or an upstream
/// that does not yet have this commit are all safe to amend, and all answer
/// false — the check must never invent a warning for an ordinary local commit.
#[command]
pub async fn is_head_published(path: String) -> Result<bool> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;

        let Ok(head) = repo.head() else {
            return Ok(false); // Unborn HEAD: nothing to amend yet.
        };
        if repo.head_detached().unwrap_or(false) {
            return Ok(false); // No upstream to diverge from.
        }
        let Some(head_oid) = head.target() else {
            return Ok(false);
        };
        let Ok(branch_name) = head.shorthand() else {
            return Ok(false);
        };

        let Ok(branch) = repo.find_branch(branch_name, git2::BranchType::Local) else {
            return Ok(false);
        };
        // An upstream that is configured but pruned resolves to Err here, and that
        // is the right answer: with no remote-tracking ref there is nothing local
        // that can show the commit was published.
        let Ok(upstream) = branch.upstream() else {
            return Ok(false);
        };
        let Some(upstream_oid) = upstream.get().target() else {
            return Ok(false);
        };

        if upstream_oid == head_oid {
            return Ok(true);
        }
        // The upstream having moved PAST head still means head is published.
        Ok(repo
            .graph_descendant_of(upstream_oid, head_oid)
            .unwrap_or(false))
    })
    .await
}

/// Get the full commit message for a commit
#[command]
pub async fn get_commit_message(path: String, oid: String) -> Result<String> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;
        let oid = git2::Oid::from_str(&oid)?;
        let commit = repo
            .find_commit(oid)
            .map_err(|_| GitnadoError::CommitNotFound(oid.to_string()))?;

        Ok(commit.message().ok().unwrap_or("").to_string())
    })
    .await
}
