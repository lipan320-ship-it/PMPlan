use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFingerprint {
    pub modified_ns: i128,
    pub size: u64,
    pub content_hash: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectFileError {
    #[error("project path must use the .json extension")]
    InvalidExtension,
    #[error("project file could not be read: {0}")]
    Read(#[from] io::Error),
    #[error("project file is not valid UTF-8: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("project file changed outside PMPlan")]
    ExternalChange,
    #[error("project file could not be written: {0}")]
    Write(String),
}

pub fn normalize_project_path(path: &Path) -> Result<PathBuf, ProjectFileError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err(ProjectFileError::InvalidExtension);
    }

    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let normalized = fs::canonicalize(&absolute).unwrap_or(absolute);
    let display_path = normalized.to_string_lossy();
    if let Some(stripped) = display_path.strip_prefix("\\\\?\\") {
        Ok(PathBuf::from(stripped))
    } else {
        Ok(normalized)
    }
}

pub fn read_project_file(path: &Path) -> Result<(String, FileFingerprint), ProjectFileError> {
    let bytes = fs::read(path)?;
    let fingerprint = fingerprint_for_bytes(path, &bytes)?;
    let content = String::from_utf8(bytes)?;
    Ok((
        content.trim_start_matches('\u{feff}').to_owned(),
        fingerprint,
    ))
}

pub fn fingerprint_for_path(path: &Path) -> Result<FileFingerprint, ProjectFileError> {
    let bytes = fs::read(path)?;
    fingerprint_for_bytes(path, &bytes)
}

pub fn write_project_file(
    path: &Path,
    content: &str,
    expected: Option<&FileFingerprint>,
) -> Result<FileFingerprint, ProjectFileError> {
    if let Some(expected) = expected {
        let current = fingerprint_for_path(path).map_err(|error| match error {
            ProjectFileError::Read(_) => ProjectFileError::ExternalChange,
            other => other,
        })?;
        if &current != expected {
            return Err(ProjectFileError::ExternalChange);
        }
    }

    let parent = path.parent().ok_or_else(|| {
        ProjectFileError::Write("project path has no parent directory".to_owned())
    })?;
    fs::create_dir_all(parent)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let temp_path = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("project"),
        std::process::id(),
        stamp
    ));
    let bytes = format!("\u{feff}{content}").into_bytes();

    let write_result = (|| -> Result<FileFingerprint, ProjectFileError> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);

        if let Err(error) = fs::rename(&temp_path, path) {
            // Windows does not replace an existing file with rename. The
            // fallback keeps the operation in the target directory and is
            // used only when the platform cannot perform replacement rename.
            if path.exists() {
                fs::remove_file(path)?;
                fs::rename(&temp_path, path)?;
            } else {
                return Err(ProjectFileError::Write(error.to_string()));
            }
        }
        fingerprint_for_path(path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn fingerprint_for_bytes(path: &Path, bytes: &[u8]) -> Result<FileFingerprint, ProjectFileError> {
    let metadata = fs::metadata(path)?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as i128)
        .unwrap_or_default();
    Ok(FileFingerprint {
        modified_ns,
        size: bytes.len() as u64,
        content_hash: fnv1a_hex(bytes),
    })
}

fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn reads_bom_and_rejects_external_changes() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("plan.json");
        fs::write(&path, "\u{feff}{\"version\":\"1.0\"}").expect("write source");

        let (content, fingerprint) = read_project_file(&path).expect("read project");
        assert_eq!(content, "{\"version\":\"1.0\"}");

        fs::write(&path, "{\"version\":\"1.1\"}").expect("change source");
        let error = write_project_file(&path, "{}", Some(&fingerprint))
            .expect_err("changed source must be rejected");
        assert!(matches!(error, ProjectFileError::ExternalChange));
    }

    #[test]
    fn atomically_writes_json_in_the_target_directory() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("nested").join("plan.json");
        let fingerprint = write_project_file(&path, "{\"tasks\":[]}", None).expect("write project");
        let (content, reread) = read_project_file(&path).expect("read project");
        assert_eq!(content, "{\"tasks\":[]}");
        assert_eq!(fingerprint, reread);
        assert!(directory
            .path()
            .join("nested")
            .read_dir()
            .expect("read target")
            .all(|entry| entry
                .expect("directory entry")
                .path()
                .extension()
                .and_then(|value| value.to_str())
                != Some("tmp")));
    }
}
