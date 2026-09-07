//! File encoding detection and conversion command handlers
//! Detect file encodings, BOMs, line endings, and convert between encodings

use std::fs;
use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Information about a file's encoding
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEncodingInfo {
    /// Relative path of the file
    pub file_path: String,
    /// Detected encoding name (e.g., "UTF-8", "UTF-16LE", "Shift_JIS")
    pub encoding: String,
    /// Detection confidence from 0.0 to 1.0
    pub confidence: f64,
    /// Whether the file has a byte order mark
    pub has_bom: bool,
    /// Line ending style: "LF", "CRLF", "CR", or "Mixed"
    pub line_ending: String,
    /// Whether the file appears to be binary
    pub is_binary: bool,
}

/// Result of a file encoding conversion
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertEncodingResult {
    pub success: bool,
    pub source_encoding: String,
    pub target_encoding: String,
    pub bytes_written: usize,
}

/// Byte order mark signatures
const BOM_UTF8: &[u8] = &[0xEF, 0xBB, 0xBF];
const BOM_UTF16_LE: &[u8] = &[0xFF, 0xFE];
const BOM_UTF16_BE: &[u8] = &[0xFE, 0xFF];
const BOM_UTF32_LE: &[u8] = &[0xFF, 0xFE, 0x00, 0x00];
const BOM_UTF32_BE: &[u8] = &[0x00, 0x00, 0xFE, 0xFF];

/// Detect a BOM at the start of the data and return encoding name + BOM length
fn detect_bom(data: &[u8]) -> Option<(&'static str, usize)> {
    // Check UTF-32 before UTF-16 since UTF-32LE starts with FF FE too
    if data.len() >= 4 && data[..4] == *BOM_UTF32_BE {
        return Some(("UTF-32BE", 4));
    }
    if data.len() >= 4 && data[..4] == *BOM_UTF32_LE {
        return Some(("UTF-32LE", 4));
    }
    if data.len() >= 3 && data[..3] == *BOM_UTF8 {
        return Some(("UTF-8", 3));
    }
    if data.len() >= 2 && data[..2] == *BOM_UTF16_BE {
        return Some(("UTF-16BE", 2));
    }
    if data.len() >= 2 && data[..2] == *BOM_UTF16_LE {
        return Some(("UTF-16LE", 2));
    }
    None
}

/// Check if data appears to be binary (contains null bytes or many non-text bytes)
fn is_binary_data(data: &[u8]) -> bool {
    if data.is_empty() {
        return false;
    }

    // Sample the first 8KB for binary detection
    let sample_size = data.len().min(8192);
    let sample = &data[..sample_size];

    // Count null bytes and non-text control characters
    let mut null_count = 0;
    let mut control_count = 0;

    for &byte in sample {
        if byte == 0 {
            null_count += 1;
        } else if byte < 8 || (byte > 13 && byte < 32 && byte != 27) {
            // Control chars except tab(9), LF(10), VT(11), FF(12), CR(13), ESC(27)
            control_count += 1;
        }
    }

    // If more than 0 null bytes in the first chunk, likely binary
    // (unless it's UTF-16/32 which we check separately)
    if null_count > 0 {
        // Could be UTF-16/32 with null bytes as part of encoding
        // Check if it looks like UTF-16
        if detect_bom(data).is_some() {
            return false;
        }
        // Check for consistent null byte patterns (UTF-16-like)
        let even_nulls = sample.iter().step_by(2).filter(|&&b| b == 0).count();
        let odd_nulls = sample
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|&&b| b == 0)
            .count();
        let half_len = sample_size / 2;
        // If close to half the bytes at even or odd positions are null, it's UTF-16
        // Use 40% threshold to avoid false positives from binary files with scattered nulls
        if half_len > 0 && (even_nulls > half_len * 2 / 5 || odd_nulls > half_len * 2 / 5) {
            return false;
        }
        return true;
    }

    // If more than 10% control characters, likely binary
    let threshold = sample_size / 10;
    control_count > threshold
}

/// Detect line endings in text data
fn detect_line_endings(data: &[u8]) -> String {
    let mut has_crlf = false;
    let mut has_lf = false;
    let mut has_cr = false;

    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' {
            if i + 1 < data.len() && data[i + 1] == b'\n' {
                has_crlf = true;
                i += 2;
                continue;
            } else {
                has_cr = true;
            }
        } else if data[i] == b'\n' {
            has_lf = true;
        }
        i += 1;
    }

    match (has_crlf, has_lf, has_cr) {
        (true, false, false) => "CRLF".to_string(),
        (false, true, false) => "LF".to_string(),
        (false, false, true) => "CR".to_string(),
        (false, false, false) => "LF".to_string(), // No line endings found, default
        _ => "Mixed".to_string(),
    }
}

/// Detect encoding using heuristics.
/// Returns (encoding_name, confidence).
fn detect_encoding_heuristic(data: &[u8]) -> (String, f64) {
    if data.is_empty() {
        return ("UTF-8".to_string(), 1.0);
    }

    // Check BOM first
    if let Some((encoding, _bom_len)) = detect_bom(data) {
        return (encoding.to_string(), 1.0);
    }

    // Try UTF-8 validation
    let content_to_check = if data.len() > 65536 {
        &data[..65536]
    } else {
        data
    };

    if std::str::from_utf8(content_to_check).is_ok() {
        // Valid UTF-8
        // Check if it's pure ASCII
        let is_ascii = content_to_check.iter().all(|&b| b < 128);
        if is_ascii {
            return ("ASCII".to_string(), 1.0);
        }
        return ("UTF-8".to_string(), 0.95);
    }

    // Not valid UTF-8, try to detect other encodings
    // Use chardetng for encoding detection. chardetng 1.0 dropped the
    // reliability signal that `guess_assess` used to return, so we report a
    // single mid-confidence value.
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(content_to_check, true);
    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);

    (encoding.name().to_string().to_uppercase(), 0.7)
}

/// Detect the encoding of a file
#[command]
pub async fn detect_file_encoding(
    path: String,
    #[allow(non_snake_case)] filePath: String,
) -> Result<FileEncodingInfo> {
    let repo_path = Path::new(&path);
    let full_path = if Path::new(&filePath).is_absolute() {
        filePath.clone().into()
    } else {
        repo_path.join(&filePath)
    };

    if !full_path.exists() {
        return Err(GitnadoError::InvalidPath(
            full_path.to_string_lossy().to_string(),
        ));
    }

    if full_path.is_dir() {
        return Err(GitnadoError::OperationFailed(
            "Cannot detect encoding of a directory".to_string(),
        ));
    }

    let data = fs::read(&full_path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read file: {}", e)))?;

    let is_binary = is_binary_data(&data);
    let has_bom = detect_bom(&data).is_some();

    let (encoding, confidence) = if is_binary {
        ("binary".to_string(), 1.0)
    } else {
        detect_encoding_heuristic(&data)
    };

    let line_ending = if is_binary {
        "N/A".to_string()
    } else {
        // For BOM-based encodings, skip the BOM when detecting line endings
        let skip = detect_bom(&data).map(|(_, len)| len).unwrap_or(0);
        detect_line_endings(&data[skip..])
    };

    Ok(FileEncodingInfo {
        file_path: filePath,
        encoding,
        confidence,
        has_bom,
        line_ending,
        is_binary,
    })
}

/// Convert a file from its current encoding to a target encoding
#[command]
pub async fn convert_file_encoding(
    path: String,
    #[allow(non_snake_case)] filePath: String,
    #[allow(non_snake_case)] targetEncoding: String,
) -> Result<ConvertEncodingResult> {
    let repo_path = Path::new(&path);
    let full_path = if Path::new(&filePath).is_absolute() {
        filePath.clone().into()
    } else {
        repo_path.join(&filePath)
    };

    if !full_path.exists() {
        return Err(GitnadoError::InvalidPath(
            full_path.to_string_lossy().to_string(),
        ));
    }

    let data = fs::read(&full_path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read file: {}", e)))?;

    if is_binary_data(&data) {
        return Err(GitnadoError::OperationFailed(
            "Cannot convert encoding of binary file".to_string(),
        ));
    }

    // Detect source encoding
    let (source_encoding_name, _confidence) = detect_encoding_heuristic(&data);

    // Skip BOM if present
    let bom_len = detect_bom(&data).map(|(_, len)| len).unwrap_or(0);
    let content_data = &data[bom_len..];

    // Decode the source content into a Rust string. encoding_rs can decode
    // FROM UTF-16 but not UTF-32, so UTF-32 sources are decoded manually to
    // avoid the for_label() fallback silently treating them as UTF-8 (mojibake).
    let source_upper = source_encoding_name.to_uppercase();
    let decoded: std::borrow::Cow<str> = if source_upper == "UTF-32LE" || source_upper == "UTF-32BE"
    {
        let le = source_upper == "UTF-32LE";
        let mut s = String::new();
        for chunk in content_data.chunks(4) {
            if chunk.len() < 4 {
                break;
            }
            let cp = if le {
                u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
            } else {
                u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
            };
            s.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
        }
        std::borrow::Cow::Owned(s)
    } else {
        let source_encoding = encoding_rs::Encoding::for_label(source_encoding_name.as_bytes())
            .unwrap_or(encoding_rs::UTF_8);
        let (decoded, _, had_errors) = source_encoding.decode(content_data);
        if had_errors {
            tracing::warn!(
                "Encountered errors decoding file from {}",
                source_encoding_name
            );
        }
        decoded
    };

    // Encode to the target encoding. encoding_rs::encode() maps UTF-16/UTF-32
    // targets back to UTF-8 (it cannot emit those units), so those must be
    // handled manually; otherwise we would write UTF-8 bytes behind a UTF-16
    // BOM and corrupt the file.
    let target_norm = targetEncoding.to_lowercase().replace('_', "-");
    let (body, target_name): (Vec<u8>, String) = match target_norm.as_str() {
        "utf-16" | "utf16" | "utf-16le" | "utf16le" => {
            let bytes = decoded
                .encode_utf16()
                .flat_map(|u| u.to_le_bytes())
                .collect();
            (bytes, "UTF-16LE".to_string())
        }
        "utf-16be" | "utf16be" => {
            let bytes = decoded
                .encode_utf16()
                .flat_map(|u| u.to_be_bytes())
                .collect();
            (bytes, "UTF-16BE".to_string())
        }
        "utf-32" | "utf32" | "utf-32le" | "utf32le" | "utf-32be" | "utf32be" => {
            return Err(GitnadoError::OperationFailed(
                "UTF-32 encoding is not supported. Please choose UTF-8, UTF-16LE, or UTF-16BE."
                    .to_string(),
            ));
        }
        _ => {
            let target_enc =
                encoding_rs::Encoding::for_label(target_norm.as_bytes()).ok_or_else(|| {
                    GitnadoError::OperationFailed(format!(
                        "Unsupported target encoding: {}",
                        targetEncoding
                    ))
                })?;
            let (encoded, _, had_encode_errors) = target_enc.encode(&decoded);
            if had_encode_errors {
                tracing::warn!("Encountered errors encoding file to {}", target_enc.name());
            }
            (encoded.into_owned(), target_enc.name().to_string())
        }
    };

    // Build output with optional BOM
    let mut output = Vec::new();
    let target_name_upper = target_name.to_uppercase();

    // Add BOM for UTF encodings if appropriate
    if target_name_upper.contains("UTF-8") {
        // UTF-8 BOM is optional; we add it if the source had a BOM
        if detect_bom(&data).is_some() {
            output.extend_from_slice(BOM_UTF8);
        }
    } else if target_name_upper.contains("UTF-16LE") {
        output.extend_from_slice(BOM_UTF16_LE);
    } else if target_name_upper.contains("UTF-16BE") {
        output.extend_from_slice(BOM_UTF16_BE);
    }

    output.extend_from_slice(&body);

    let bytes_written = output.len();

    // Write the file
    fs::write(&full_path, &output).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to write converted file: {}", e))
    })?;

    Ok(ConvertEncodingResult {
        success: true,
        source_encoding: source_encoding_name,
        target_encoding: target_name,
        bytes_written,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_detect_bom_utf8() {
        let data = [0xEF, 0xBB, 0xBF, b'h', b'e', b'l', b'l', b'o'];
        let result = detect_bom(&data);
        assert!(result.is_some());
        let (encoding, len) = result.unwrap();
        assert_eq!(encoding, "UTF-8");
        assert_eq!(len, 3);
    }

    #[test]
    fn test_detect_bom_utf16le() {
        let data = [0xFF, 0xFE, b'h', 0x00];
        let result = detect_bom(&data);
        assert!(result.is_some());
        let (encoding, len) = result.unwrap();
        assert_eq!(encoding, "UTF-16LE");
        assert_eq!(len, 2);
    }

    #[test]
    fn test_detect_bom_utf16be() {
        let data = [0xFE, 0xFF, 0x00, b'h'];
        let result = detect_bom(&data);
        assert!(result.is_some());
        let (encoding, len) = result.unwrap();
        assert_eq!(encoding, "UTF-16BE");
        assert_eq!(len, 2);
    }

    #[test]
    fn test_detect_bom_utf32le() {
        let data = [0xFF, 0xFE, 0x00, 0x00, b'h', 0x00, 0x00, 0x00];
        let result = detect_bom(&data);
        assert!(result.is_some());
        let (encoding, len) = result.unwrap();
        assert_eq!(encoding, "UTF-32LE");
        assert_eq!(len, 4);
    }

    #[test]
    fn test_detect_bom_utf32be() {
        let data = [0x00, 0x00, 0xFE, 0xFF, 0x00, 0x00, 0x00, b'h'];
        let result = detect_bom(&data);
        assert!(result.is_some());
        let (encoding, len) = result.unwrap();
        assert_eq!(encoding, "UTF-32BE");
        assert_eq!(len, 4);
    }

    #[test]
    fn test_detect_bom_none() {
        let data = b"Hello, world!";
        let result = detect_bom(data);
        assert!(result.is_none());
    }

    #[test]
    fn test_is_binary_data_text() {
        let data = b"Hello, this is a plain text file.\nWith multiple lines.\n";
        assert!(!is_binary_data(data));
    }

    #[test]
    fn test_is_binary_data_with_nulls() {
        // The UTF-16LE-looking buffer this used to build was never asserted
        // on; the case under test is interspersed nulls.
        let binary_data = b"Some text\x00\x00\x00more binary\x00data";
        assert!(is_binary_data(binary_data));
    }

    #[test]
    fn test_is_binary_data_empty() {
        assert!(!is_binary_data(&[]));
    }

    #[test]
    fn test_detect_line_endings_lf() {
        let data = b"line 1\nline 2\nline 3\n";
        assert_eq!(detect_line_endings(data), "LF");
    }

    #[test]
    fn test_detect_line_endings_crlf() {
        let data = b"line 1\r\nline 2\r\nline 3\r\n";
        assert_eq!(detect_line_endings(data), "CRLF");
    }

    #[test]
    fn test_detect_line_endings_cr() {
        let data = b"line 1\rline 2\rline 3\r";
        assert_eq!(detect_line_endings(data), "CR");
    }

    #[test]
    fn test_detect_line_endings_mixed() {
        let data = b"line 1\r\nline 2\nline 3\r";
        assert_eq!(detect_line_endings(data), "Mixed");
    }

    #[test]
    fn test_detect_line_endings_none() {
        let data = b"no line endings here";
        assert_eq!(detect_line_endings(data), "LF");
    }

    #[test]
    fn test_detect_encoding_ascii() {
        let data = b"Hello, ASCII text!";
        let (encoding, confidence) = detect_encoding_heuristic(data);
        assert_eq!(encoding, "ASCII");
        assert_eq!(confidence, 1.0);
    }

    #[test]
    fn test_detect_encoding_utf8() {
        // UTF-8 encoded string with non-ASCII characters
        let data = "Hello, w\u{00F6}rld! \u{00E9}\u{00E8}\u{00EA}".as_bytes();
        let (encoding, confidence) = detect_encoding_heuristic(data);
        assert_eq!(encoding, "UTF-8");
        assert!(confidence > 0.8);
    }

    #[test]
    fn test_detect_encoding_utf8_bom() {
        let mut data = vec![0xEF, 0xBB, 0xBF];
        data.extend_from_slice(b"Hello, world!");
        let (encoding, confidence) = detect_encoding_heuristic(&data);
        assert_eq!(encoding, "UTF-8");
        assert_eq!(confidence, 1.0);
    }

    #[test]
    fn test_detect_encoding_empty() {
        let (encoding, confidence) = detect_encoding_heuristic(&[]);
        assert_eq!(encoding, "UTF-8");
        assert_eq!(confidence, 1.0);
    }

    #[tokio::test]
    async fn test_detect_file_encoding_utf8() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("test.txt", "Hello, world!\nSecond line\n");

        let result = detect_file_encoding(repo.path_str(), "test.txt".to_string()).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.file_path, "test.txt");
        assert!(info.encoding == "ASCII" || info.encoding == "UTF-8");
        assert!(!info.has_bom);
        assert_eq!(info.line_ending, "LF");
        assert!(!info.is_binary);
    }

    #[tokio::test]
    async fn test_detect_file_encoding_utf8_with_bom() {
        let repo = TestRepo::with_initial_commit();

        // Write a file with UTF-8 BOM
        let mut content = vec![0xEF, 0xBB, 0xBF];
        content.extend_from_slice(b"Hello with BOM\n");
        let file_path = repo.path.join("bom_test.txt");
        fs::write(&file_path, &content).unwrap();

        let result = detect_file_encoding(repo.path_str(), "bom_test.txt".to_string()).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.encoding, "UTF-8");
        assert!(info.has_bom);
        assert!(!info.is_binary);
    }

    #[tokio::test]
    async fn test_detect_file_encoding_crlf() {
        let repo = TestRepo::with_initial_commit();

        // Write a file with CRLF line endings
        let content = b"line 1\r\nline 2\r\nline 3\r\n";
        let file_path = repo.path.join("crlf_test.txt");
        fs::write(&file_path, content).unwrap();

        let result = detect_file_encoding(repo.path_str(), "crlf_test.txt".to_string()).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.line_ending, "CRLF");
        assert!(!info.is_binary);
    }

    #[tokio::test]
    async fn test_detect_file_encoding_binary() {
        let repo = TestRepo::with_initial_commit();

        // Write a binary file (PNG-like header)
        let content: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x5C, 0x72, 0xA8, 0x66,
        ];
        let file_path = repo.path.join("test.png");
        fs::write(&file_path, &content).unwrap();

        let result = detect_file_encoding(repo.path_str(), "test.png".to_string()).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert!(info.is_binary);
        assert_eq!(info.encoding, "binary");
    }

    #[tokio::test]
    async fn test_detect_file_encoding_nonexistent() {
        let repo = TestRepo::with_initial_commit();
        let result = detect_file_encoding(repo.path_str(), "nonexistent.txt".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_detect_file_encoding_directory() {
        let repo = TestRepo::with_initial_commit();
        // Create a subdirectory
        fs::create_dir_all(repo.path.join("subdir")).unwrap();

        let result = detect_file_encoding(repo.path_str(), "subdir".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_convert_file_encoding_utf8_to_utf8() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("convert_test.txt", "Hello, world!\n");

        let result = convert_file_encoding(
            repo.path_str(),
            "convert_test.txt".to_string(),
            "utf-8".to_string(),
        )
        .await;
        assert!(result.is_ok());
        let conv = result.unwrap();
        assert!(conv.success);
        assert!(conv.bytes_written > 0);
    }

    #[tokio::test]
    async fn test_convert_file_encoding_invalid_target() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("convert_test.txt", "Hello, world!\n");

        let result = convert_file_encoding(
            repo.path_str(),
            "convert_test.txt".to_string(),
            "not-a-real-encoding".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_convert_file_encoding_nonexistent() {
        let repo = TestRepo::with_initial_commit();
        let result = convert_file_encoding(
            repo.path_str(),
            "nonexistent.txt".to_string(),
            "utf-8".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_convert_binary_file_fails() {
        let repo = TestRepo::with_initial_commit();

        // Write a binary file
        let content: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x5C, 0x72, 0xA8, 0x66,
        ];
        let file_path = repo.path.join("binary.bin");
        fs::write(&file_path, &content).unwrap();

        let result = convert_file_encoding(
            repo.path_str(),
            "binary.bin".to_string(),
            "utf-8".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_convert_preserves_content() {
        let repo = TestRepo::with_initial_commit();
        let original_text = "Hello, world!\nLine two\nLine three\n";
        repo.create_file("preserve_test.txt", original_text);

        // Convert UTF-8 to windows-1252 and back
        let result = convert_file_encoding(
            repo.path_str(),
            "preserve_test.txt".to_string(),
            "windows-1252".to_string(),
        )
        .await;
        assert!(result.is_ok());

        // Convert back to UTF-8
        let result = convert_file_encoding(
            repo.path_str(),
            "preserve_test.txt".to_string(),
            "utf-8".to_string(),
        )
        .await;
        assert!(result.is_ok());

        // Read and verify content is preserved
        let content = fs::read_to_string(repo.path.join("preserve_test.txt")).unwrap();
        assert_eq!(content, original_text);
    }

    /// Finding 59: converting to UTF-16LE must emit real UTF-16 code units,
    /// not UTF-8 bytes behind a UTF-16 BOM.
    #[tokio::test]
    async fn test_convert_to_utf16le_produces_valid_utf16() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("u16.txt", "hello");

        let result = convert_file_encoding(
            repo.path_str(),
            "u16.txt".to_string(),
            "utf-16le".to_string(),
        )
        .await;
        assert!(result.is_ok(), "utf-16le conversion should succeed");

        let bytes = fs::read(repo.path.join("u16.txt")).unwrap();
        // Expect BOM FF FE followed by 2-byte little-endian code units.
        assert_eq!(
            bytes,
            vec![0xFF, 0xFE, b'h', 0x00, b'e', 0x00, b'l', 0x00, b'l', 0x00, b'o', 0x00,],
            "UTF-16LE output must be BOM + 2-byte LE units, got {:?}",
            bytes
        );
    }

    /// Finding 59: converting to UTF-16BE must emit big-endian code units.
    #[tokio::test]
    async fn test_convert_to_utf16be_produces_valid_utf16() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("u16be.txt", "Ab");

        let result = convert_file_encoding(
            repo.path_str(),
            "u16be.txt".to_string(),
            "utf-16be".to_string(),
        )
        .await;
        assert!(result.is_ok());

        let bytes = fs::read(repo.path.join("u16be.txt")).unwrap();
        assert_eq!(bytes, vec![0xFE, 0xFF, 0x00, b'A', 0x00, b'b']);
    }

    /// Finding 59: UTF-16 output must round-trip back through detection as UTF-16.
    #[tokio::test]
    async fn test_convert_to_utf16le_detected_as_utf16() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("rt.txt", "roundtrip");

        convert_file_encoding(
            repo.path_str(),
            "rt.txt".to_string(),
            "utf-16le".to_string(),
        )
        .await
        .unwrap();

        let info = detect_file_encoding(repo.path_str(), "rt.txt".to_string())
            .await
            .unwrap();
        assert_eq!(info.encoding, "UTF-16LE");
        assert!(info.has_bom);
    }

    /// Finding 59: UTF-32 targets can't be emitted correctly, so refuse cleanly.
    #[tokio::test]
    async fn test_convert_to_utf32_is_refused() {
        let repo = TestRepo::with_initial_commit();
        let original = "keep me safe";
        repo.create_file("u32.txt", original);

        let result = convert_file_encoding(
            repo.path_str(),
            "u32.txt".to_string(),
            "utf-32le".to_string(),
        )
        .await;
        assert!(result.is_err(), "UTF-32 target must be refused");

        // The original file must be left untouched (no corruption / data loss).
        let after = fs::read_to_string(repo.path.join("u32.txt")).unwrap();
        assert_eq!(after, original);
    }

    #[tokio::test]
    async fn test_detect_file_encoding_utf8_multibyte() {
        let repo = TestRepo::with_initial_commit();
        // Write UTF-8 content with multibyte characters
        repo.create_file("unicode.txt", "Caf\u{00E9} \u{00FC}ber \u{00E4}lles\n");

        let result = detect_file_encoding(repo.path_str(), "unicode.txt".to_string()).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.encoding, "UTF-8");
        assert!(!info.is_binary);
        assert!(!info.has_bom);
    }

    #[tokio::test]
    async fn test_detect_file_encoding_empty_file() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("empty.txt", "");

        let result = detect_file_encoding(repo.path_str(), "empty.txt".to_string()).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.encoding, "UTF-8");
        assert!(!info.is_binary);
    }
}
