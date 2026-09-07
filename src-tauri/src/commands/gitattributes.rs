//! Gitattributes management command handlers
//! Add and manage .gitattributes entries from the UI

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// A single attribute entry (e.g., `text`, `-diff`, `merge=union`, `!export-ignore`)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeEntry {
    pub name: String,
    pub value: AttributeValue,
}

/// The value of an attribute
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttributeValue {
    /// Attribute is set (e.g., `text`)
    Set,
    /// Attribute is unset (e.g., `-text`)
    Unset,
    /// Attribute has a value (e.g., `diff=lfs`)
    Value(String),
    /// Attribute is unspecified (e.g., `!text`)
    Unspecified,
}

/// A parsed line from a .gitattributes file
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAttribute {
    pub pattern: String,
    pub attributes: Vec<AttributeEntry>,
    pub line_number: u32,
    pub raw_line: String,
}

/// A common git attribute with description
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonAttribute {
    pub name: String,
    pub description: String,
    pub example: String,
}

/// Parse a single attribute token into an AttributeEntry
fn parse_attribute_token(token: &str) -> AttributeEntry {
    if let Some(name) = token.strip_prefix('-') {
        AttributeEntry {
            name: name.to_string(),
            value: AttributeValue::Unset,
        }
    } else if let Some(name) = token.strip_prefix('!') {
        AttributeEntry {
            name: name.to_string(),
            value: AttributeValue::Unspecified,
        }
    } else if let Some((name, val)) = token.split_once('=') {
        AttributeEntry {
            name: name.to_string(),
            value: AttributeValue::Value(val.to_string()),
        }
    } else {
        AttributeEntry {
            name: token.to_string(),
            value: AttributeValue::Set,
        }
    }
}

/// Render a pattern back into a .gitattributes line, quoting when it needs it.
///
/// The inverse of `split_pattern_and_rest`. The parser unescapes quoted
/// patterns per gitattributes(5), so `"foo bar.txt" text` reads back as the
/// pattern `foo bar.txt` — but both writers emitted the pattern verbatim. Round
/// tripping one through an edit wrote `foo bar.txt text`, which git then reads
/// as the pattern `foo` with attributes `bar.txt text`: the rule silently stops
/// matching the file it was written for and starts matching something else.
///
/// Quoted when the pattern contains whitespace or a character that would change
/// how the line parses; left bare otherwise, so ordinary patterns keep the plain
/// form a human would write.
fn format_pattern(pattern: &str) -> String {
    let needs_quotes = pattern.is_empty()
        || pattern
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\\')
        || pattern.starts_with('#');

    if !needs_quotes {
        return pattern.to_string();
    }

    let mut out = String::with_capacity(pattern.len() + 2);
    out.push('"');
    for c in pattern.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Refuse a pattern that is empty or nothing but whitespace.
///
/// `format_pattern` renders one as `""`, and `parse_gitattributes` then drops
/// the line again because the pattern it reads back is empty. The write would
/// report success, the entry would be missing from the list the caller renders,
/// and the junk line would sit in `.gitattributes` with no way to reach it from
/// the UI. There is also nothing such a pattern could usefully match.
fn ensure_pattern_usable(pattern: &str) -> Result<()> {
    if pattern.trim().is_empty() {
        return Err(GitnadoError::OperationFailed(
            "A .gitattributes pattern cannot be empty.".to_string(),
        ));
    }
    Ok(())
}

/// Split a trimmed .gitattributes line into its pattern and the remainder
/// (the attribute list).
///
/// Per gitattributes(5), a pattern containing whitespace may be wrapped in
/// double quotes, with C-style escapes (`\"`, `\\`, `\n`, `\t`, octal `\nnn`)
/// inside. Otherwise the pattern is the first whitespace-delimited token.
fn split_pattern_and_rest(trimmed: &str) -> (String, &str) {
    if let Some(after_quote) = trimmed.strip_prefix('"') {
        let bytes = after_quote.as_bytes();
        let mut out: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'"' => {
                    // Closing quote: everything after it is the attribute list.
                    let rest = &after_quote[i + 1..];
                    return (String::from_utf8_lossy(&out).into_owned(), rest);
                }
                b'\\' => {
                    i += 1;
                    if i >= bytes.len() {
                        break;
                    }
                    match bytes[i] {
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        c @ b'0'..=b'7' => {
                            // Up to three octal digits.
                            let mut val = (c - b'0') as u32;
                            let mut digits = 1;
                            while digits < 3
                                && i + 1 < bytes.len()
                                && (b'0'..=b'7').contains(&bytes[i + 1])
                            {
                                i += 1;
                                val = val * 8 + (bytes[i] - b'0') as u32;
                                digits += 1;
                            }
                            out.push(val as u8);
                        }
                        other => out.push(other),
                    }
                    i += 1;
                }
                b => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        // Malformed (no closing quote): fall through to the unquoted split below.
    }

    match trimmed.split_once(char::is_whitespace) {
        Some((pattern, rest)) => (pattern.to_string(), rest),
        None => (trimmed.to_string(), ""),
    }
}

/// Parse the entire .gitattributes content into structured entries
fn parse_gitattributes(content: &str) -> Vec<GitAttribute> {
    let mut entries = Vec::new();

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();

        // Skip comments and empty lines
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Split line into pattern and attributes. The pattern may be quoted if it
        // contains whitespace, so it is not simply the first whitespace token.
        let (pattern, rest) = split_pattern_and_rest(trimmed);
        if pattern.is_empty() {
            continue;
        }

        let attributes: Vec<AttributeEntry> =
            rest.split_whitespace().map(parse_attribute_token).collect();

        entries.push(GitAttribute {
            pattern,
            attributes,
            line_number: (i + 1) as u32,
            raw_line: line.to_string(),
        });
    }

    entries
}

/// Get the contents of the .gitattributes file
#[command]
pub async fn get_gitattributes(path: String) -> Result<Vec<GitAttribute>> {
    let attrs_path = Path::new(&path).join(".gitattributes");

    if !attrs_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&attrs_path)?;
    Ok(parse_gitattributes(&content))
}

/// Add a new entry to .gitattributes
#[command]
pub async fn add_gitattribute(
    path: String,
    pattern: String,
    attributes: String,
) -> Result<Vec<GitAttribute>> {
    ensure_pattern_usable(&pattern)?;

    let attrs_path = Path::new(&path).join(".gitattributes");

    let mut content = if attrs_path.exists() {
        std::fs::read_to_string(&attrs_path)?
    } else {
        String::new()
    };

    // Ensure file ends with newline
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }

    // Append the new line
    content.push_str(&format!("{} {}\n", format_pattern(&pattern), attributes));

    std::fs::write(&attrs_path, &content)?;
    Ok(parse_gitattributes(&content))
}

/// Remove a line from .gitattributes by line number (1-based)
#[command]
pub async fn remove_gitattribute(path: String, line_number: u32) -> Result<Vec<GitAttribute>> {
    let attrs_path = Path::new(&path).join(".gitattributes");

    if !attrs_path.exists() {
        return Err(GitnadoError::OperationFailed(
            ".gitattributes file does not exist".to_string(),
        ));
    }

    let content = std::fs::read_to_string(&attrs_path)?;
    let lines: Vec<&str> = content.lines().collect();

    if line_number == 0 || line_number as usize > lines.len() {
        return Err(GitnadoError::OperationFailed(format!(
            "Invalid line number: {}",
            line_number
        )));
    }

    let new_lines: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != (line_number as usize - 1))
        .map(|(_, line)| *line)
        .collect();

    let mut result = new_lines.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }

    std::fs::write(&attrs_path, &result)?;
    Ok(parse_gitattributes(&result))
}

/// Update a line in .gitattributes by line number (1-based)
#[command]
pub async fn update_gitattribute(
    path: String,
    line_number: u32,
    pattern: String,
    attributes: String,
) -> Result<Vec<GitAttribute>> {
    ensure_pattern_usable(&pattern)?;

    let attrs_path = Path::new(&path).join(".gitattributes");

    if !attrs_path.exists() {
        return Err(GitnadoError::OperationFailed(
            ".gitattributes file does not exist".to_string(),
        ));
    }

    let content = std::fs::read_to_string(&attrs_path)?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    if line_number == 0 || line_number as usize > lines.len() {
        return Err(GitnadoError::OperationFailed(format!(
            "Invalid line number: {}",
            line_number
        )));
    }

    lines[(line_number as usize) - 1] = format!("{} {}", format_pattern(&pattern), attributes);

    let mut result = lines.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }

    std::fs::write(&attrs_path, &result)?;
    Ok(parse_gitattributes(&result))
}

/// Get a list of common git attributes with descriptions
#[command]
pub async fn get_common_attributes() -> Result<Vec<CommonAttribute>> {
    Ok(vec![
        CommonAttribute {
            name: "text".to_string(),
            description: "Text file line ending handling".to_string(),
            example: "*.txt text".to_string(),
        },
        CommonAttribute {
            name: "binary".to_string(),
            description: "Binary file (no diff, no merge)".to_string(),
            example: "*.png binary".to_string(),
        },
        CommonAttribute {
            name: "diff".to_string(),
            description: "Diff driver to use".to_string(),
            example: "*.md diff=markdown".to_string(),
        },
        CommonAttribute {
            name: "merge".to_string(),
            description: "Merge driver to use".to_string(),
            example: "*.lock merge=ours".to_string(),
        },
        CommonAttribute {
            name: "filter".to_string(),
            description: "Content filter (clean/smudge)".to_string(),
            example: "*.large filter=lfs".to_string(),
        },
        CommonAttribute {
            name: "eol".to_string(),
            description: "Line ending style (lf, crlf)".to_string(),
            example: "*.sh eol=lf".to_string(),
        },
        CommonAttribute {
            name: "linguist-language".to_string(),
            description: "Override GitHub language detection".to_string(),
            example: "*.js linguist-language=TypeScript".to_string(),
        },
        CommonAttribute {
            name: "export-ignore".to_string(),
            description: "Exclude from archive".to_string(),
            example: ".gitignore export-ignore".to_string(),
        },
        CommonAttribute {
            name: "export-subst".to_string(),
            description: "Keyword substitution in archive".to_string(),
            example: "VERSION export-subst".to_string(),
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_parse_attribute_token_set() {
        let entry = parse_attribute_token("text");
        assert_eq!(entry.name, "text");
        assert!(matches!(entry.value, AttributeValue::Set));
    }

    #[test]
    fn test_parse_attribute_token_unset() {
        let entry = parse_attribute_token("-diff");
        assert_eq!(entry.name, "diff");
        assert!(matches!(entry.value, AttributeValue::Unset));
    }

    #[test]
    fn test_parse_attribute_token_value() {
        let entry = parse_attribute_token("merge=union");
        assert_eq!(entry.name, "merge");
        match &entry.value {
            AttributeValue::Value(v) => assert_eq!(v, "union"),
            _ => panic!("Expected Value variant"),
        }
    }

    #[test]
    fn test_parse_attribute_token_unspecified() {
        let entry = parse_attribute_token("!export-ignore");
        assert_eq!(entry.name, "export-ignore");
        assert!(matches!(entry.value, AttributeValue::Unspecified));
    }

    #[test]
    fn test_parse_gitattributes_basic() {
        let content = "*.txt text\n*.png binary\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "*.txt");
        assert_eq!(entries[0].attributes.len(), 1);
        assert_eq!(entries[0].attributes[0].name, "text");
        assert_eq!(entries[0].line_number, 1);
        assert_eq!(entries[1].pattern, "*.png");
        assert_eq!(entries[1].line_number, 2);
    }

    #[test]
    fn test_parse_gitattributes_skips_comments_and_empty() {
        let content = "# Header comment\n\n*.txt text\n# Another comment\n*.bin binary\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "*.txt");
        assert_eq!(entries[0].line_number, 3);
        assert_eq!(entries[1].pattern, "*.bin");
        assert_eq!(entries[1].line_number, 5);
    }

    #[test]
    fn test_parse_gitattributes_multiple_attrs() {
        let content = "*.cs text diff=csharp eol=crlf\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].attributes.len(), 3);
        assert_eq!(entries[0].attributes[0].name, "text");
        assert!(matches!(
            entries[0].attributes[0].value,
            AttributeValue::Set
        ));
        assert_eq!(entries[0].attributes[1].name, "diff");
        match &entries[0].attributes[1].value {
            AttributeValue::Value(v) => assert_eq!(v, "csharp"),
            _ => panic!("Expected Value"),
        }
        assert_eq!(entries[0].attributes[2].name, "eol");
        match &entries[0].attributes[2].value {
            AttributeValue::Value(v) => assert_eq!(v, "crlf"),
            _ => panic!("Expected Value"),
        }
    }

    #[test]
    fn test_parse_gitattributes_mixed_attributes() {
        let content = "*.dat -diff -merge binary !export-ignore\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].attributes.len(), 4);
        assert!(matches!(
            entries[0].attributes[0].value,
            AttributeValue::Unset
        ));
        assert!(matches!(
            entries[0].attributes[1].value,
            AttributeValue::Unset
        ));
        assert!(matches!(
            entries[0].attributes[2].value,
            AttributeValue::Set
        ));
        assert!(matches!(
            entries[0].attributes[3].value,
            AttributeValue::Unspecified
        ));
    }

    // Regression (finding 93): a quoted pattern containing whitespace must be
    // parsed as a single pattern with C-style unescaping, per gitattributes(5).
    // Canonical git: `"foo bar.txt" text` assigns `text` to the file `foo bar.txt`.
    #[test]
    fn test_parse_gitattributes_quoted_pattern_with_space() {
        let content = "\"foo bar.txt\" text\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pattern, "foo bar.txt");
        assert_eq!(entries[0].attributes.len(), 1);
        assert_eq!(entries[0].attributes[0].name, "text");
        assert!(matches!(
            entries[0].attributes[0].value,
            AttributeValue::Set
        ));
    }

    #[test]
    fn test_parse_gitattributes_quoted_pattern_multiple_attrs() {
        let content = "\"my dir/file name.psd\" filter=lfs diff=lfs -text\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pattern, "my dir/file name.psd");
        assert_eq!(entries[0].attributes.len(), 3);
        assert_eq!(entries[0].attributes[0].name, "filter");
        assert_eq!(entries[0].attributes[2].name, "text");
        assert!(matches!(
            entries[0].attributes[2].value,
            AttributeValue::Unset
        ));
    }

    #[test]
    fn test_parse_gitattributes_quoted_pattern_octal_escape() {
        // git writes non-ASCII bytes as octal escapes inside quotes; "caf\303\251"
        // is the UTF-8 encoding of "café".
        let content = "\"caf\\303\\251.log\" text\n";
        let entries = parse_gitattributes(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pattern, "café.log");
        assert_eq!(entries[0].attributes.len(), 1);
        assert_eq!(entries[0].attributes[0].name, "text");
    }

    #[tokio::test]
    async fn test_get_gitattributes_no_file() {
        let repo = TestRepo::with_initial_commit();
        let result = get_gitattributes(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_gitattributes_with_entries() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(
            ".gitattributes",
            "# Auto detect text files\n* text=auto\n*.png binary\n",
        );

        let result = get_gitattributes(repo.path_str()).await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].pattern, "*");
        assert_eq!(result[1].pattern, "*.png");
    }

    #[tokio::test]
    async fn test_add_gitattribute_creates_file() {
        let repo = TestRepo::with_initial_commit();

        let result =
            add_gitattribute(repo.path_str(), "*.txt".to_string(), "text".to_string()).await;
        assert!(result.is_ok());

        let attrs_path = repo.path.join(".gitattributes");
        assert!(attrs_path.exists());

        let content = std::fs::read_to_string(&attrs_path).unwrap();
        assert!(content.contains("*.txt text"));
    }

    #[tokio::test]
    async fn test_add_gitattribute_appends() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n");

        let result =
            add_gitattribute(repo.path_str(), "*.png".to_string(), "binary".to_string()).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "*.txt");
        assert_eq!(entries[1].pattern, "*.png");
    }

    #[tokio::test]
    async fn test_remove_gitattribute() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n*.png binary\n*.sh eol=lf\n");

        let result = remove_gitattribute(repo.path_str(), 2).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "*.txt");
        assert_eq!(entries[1].pattern, "*.sh");
    }

    #[tokio::test]
    async fn test_remove_gitattribute_invalid_line() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n");

        let result = remove_gitattribute(repo.path_str(), 0).await;
        assert!(result.is_err());

        let result = remove_gitattribute(repo.path_str(), 99).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_gitattribute_no_file() {
        let repo = TestRepo::with_initial_commit();
        let result = remove_gitattribute(repo.path_str(), 1).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_update_gitattribute() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n*.png binary\n");

        let result = update_gitattribute(
            repo.path_str(),
            1,
            "*.md".to_string(),
            "text diff=markdown".to_string(),
        )
        .await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "*.md");
        assert_eq!(entries[0].attributes.len(), 2);
        assert_eq!(entries[1].pattern, "*.png");
    }

    /// A pattern with whitespace must survive being written and read back.
    ///
    /// The parser unescapes quoted patterns per gitattributes(5), so
    /// `"foo bar.txt" text` reads back as `foo bar.txt`. Both writers emitted
    /// the pattern verbatim, so editing that entry wrote `foo bar.txt text` —
    /// which git reads as the pattern `foo` with attributes `bar.txt text`. The
    /// rule silently stops matching the file it was written for and starts
    /// matching something else entirely.
    #[tokio::test]
    async fn test_add_gitattribute_round_trips_a_pattern_with_spaces() {
        let repo = TestRepo::with_initial_commit();

        let entries = add_gitattribute(
            repo.path_str(),
            "foo bar.txt".to_string(),
            "text".to_string(),
        )
        .await
        .expect("adding must succeed");

        assert_eq!(
            entries[0].pattern, "foo bar.txt",
            "the pattern must read back as written, not split at the space"
        );

        // And it is quoted on disk, which is what makes that true.
        let on_disk = std::fs::read_to_string(repo.path.join(".gitattributes")).unwrap();
        assert!(
            on_disk.contains(r#""foo bar.txt" text"#),
            "the pattern must be quoted on disk, got: {}",
            on_disk.trim()
        );
    }

    /// Editing an existing quoted entry must not unquote it.
    #[tokio::test]
    async fn test_update_gitattribute_round_trips_a_pattern_with_spaces() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "\"foo bar.txt\" text\n");

        let entries = update_gitattribute(
            repo.path_str(),
            1,
            "foo bar.txt".to_string(),
            "text diff=markdown".to_string(),
        )
        .await
        .expect("updating must succeed");

        assert_eq!(
            entries[0].pattern, "foo bar.txt",
            "editing the attributes must not corrupt the pattern"
        );
        assert_eq!(entries[0].attributes.len(), 2);
    }

    /// An ordinary pattern stays bare — quoting everything would be noise.
    #[tokio::test]
    async fn test_add_gitattribute_leaves_a_plain_pattern_unquoted() {
        let repo = TestRepo::with_initial_commit();

        add_gitattribute(repo.path_str(), "*.txt".to_string(), "text".to_string())
            .await
            .unwrap();

        let on_disk = std::fs::read_to_string(repo.path.join(".gitattributes")).unwrap();
        assert!(
            on_disk.contains("*.txt text"),
            "a plain pattern needs no quotes, got: {}",
            on_disk.trim()
        );
        assert!(!on_disk.contains('"'), "and must not gain any");
    }

    /// Quotes and backslashes in a pattern are escaped, not passed through.
    #[test]
    fn test_format_pattern_escapes_what_would_break_the_line() {
        assert_eq!(format_pattern("*.txt"), "*.txt");
        assert_eq!(format_pattern("foo bar.txt"), r#""foo bar.txt""#);
        assert_eq!(format_pattern(r#"say"hi""#), r#""say\"hi\"""#);
        assert_eq!(format_pattern(r"back\slash"), r#""back\\slash""#);
        // A leading # would otherwise turn the line into a comment.
        assert_eq!(format_pattern("#notacomment"), r##""#notacomment""##);
    }

    /// An empty pattern would be written as `""` and then dropped by the parser,
    /// so the caller would be told the write succeeded while the entry never
    /// appears and an unreachable line accumulates in the file.
    #[tokio::test]
    async fn test_add_gitattribute_refuses_an_empty_pattern() {
        let repo = TestRepo::with_initial_commit();

        let result = add_gitattribute(repo.path_str(), String::new(), "text".to_string()).await;

        assert!(result.is_err(), "an empty pattern must be refused");
        assert!(
            !repo.path.join(".gitattributes").exists(),
            "a refused add must not create the file"
        );
    }

    #[tokio::test]
    async fn test_add_gitattribute_refuses_a_whitespace_only_pattern() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n");

        let result = add_gitattribute(repo.path_str(), "   ".to_string(), "text".to_string()).await;

        assert!(result.is_err(), "a whitespace-only pattern must be refused");
        let on_disk = std::fs::read_to_string(repo.path.join(".gitattributes")).unwrap();
        assert_eq!(on_disk, "*.txt text\n", "a refused add must write nothing");
    }

    #[tokio::test]
    async fn test_update_gitattribute_refuses_an_empty_pattern() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n");

        let result =
            update_gitattribute(repo.path_str(), 1, String::new(), "text".to_string()).await;

        assert!(result.is_err(), "an empty pattern must be refused");
        let on_disk = std::fs::read_to_string(repo.path.join(".gitattributes")).unwrap();
        assert_eq!(
            on_disk, "*.txt text\n",
            "a refused update must leave the existing entry intact"
        );
    }

    #[tokio::test]
    async fn test_update_gitattribute_invalid_line() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitattributes", "*.txt text\n");

        let result =
            update_gitattribute(repo.path_str(), 0, "*.md".to_string(), "text".to_string()).await;
        assert!(result.is_err());

        let result =
            update_gitattribute(repo.path_str(), 99, "*.md".to_string(), "text".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_update_gitattribute_no_file() {
        let repo = TestRepo::with_initial_commit();
        let result =
            update_gitattribute(repo.path_str(), 1, "*.md".to_string(), "text".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_common_attributes() {
        let result = get_common_attributes().await;
        assert!(result.is_ok());
        let attrs = result.unwrap();
        assert!(!attrs.is_empty());
        assert!(attrs.iter().any(|a| a.name == "text"));
        assert!(attrs.iter().any(|a| a.name == "binary"));
        assert!(attrs.iter().any(|a| a.name == "eol"));
        assert!(attrs.iter().any(|a| a.name == "diff"));
        assert!(attrs.iter().any(|a| a.name == "merge"));
        assert!(attrs.iter().any(|a| a.name == "filter"));
        assert!(attrs.iter().any(|a| a.name == "linguist-language"));
        assert!(attrs.iter().any(|a| a.name == "export-ignore"));
        assert!(attrs.iter().any(|a| a.name == "export-subst"));
    }

    /// Pins the JSON `AttributeValue` actually puts on the wire.
    ///
    /// The enum carries no `tag`, so serde serialises it externally tagged:
    /// the unit variants become the bare strings `"set"` / `"unset"` /
    /// `"unspecified"`, never `{"type":"set"}`. The TypeScript `AttributeValue`
    /// union in `src/services/git.service.ts` is written against exactly this
    /// shape, and the .gitignore/.gitattributes dialog renders its chips from
    /// it — changing the representation here silently blanks every chip, so
    /// this test exists to make that change fail loudly instead.
    #[test]
    fn attribute_value_unit_variants_serialize_as_bare_strings() {
        use serde_json::json;

        assert_eq!(
            serde_json::to_value(AttributeValue::Set).unwrap(),
            json!("set")
        );
        assert_eq!(
            serde_json::to_value(AttributeValue::Unset).unwrap(),
            json!("unset")
        );
        assert_eq!(
            serde_json::to_value(AttributeValue::Unspecified).unwrap(),
            json!("unspecified")
        );
    }

    /// Companion to the test above: the valued variant is an object keyed by
    /// the camelCased variant name, i.e. `{"value": "union"}`.
    #[test]
    fn attribute_value_valued_variant_serializes_as_value_object() {
        use serde_json::json;

        assert_eq!(
            serde_json::to_value(AttributeValue::Value("union".to_string())).unwrap(),
            json!({ "value": "union" })
        );
    }
}
