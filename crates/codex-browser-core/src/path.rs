use serde::Deserialize;
use serde::Serialize;

use crate::errors::{CoreError, CoreResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePathPolicy {
    root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedPath {
    pub absolute: String,
    pub relative: String,
}

impl WorkspacePathPolicy {
    pub fn new(root: impl Into<String>) -> CoreResult<Self> {
        let root = normalize_absolute(&root.into())?;
        if root == "/" {
            return Err(CoreError::InvalidPath(
                "workspace root must not be filesystem root".to_string(),
            ));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn resolve(&self, path: &str) -> CoreResult<ResolvedPath> {
        if path.trim().is_empty() {
            return Err(CoreError::InvalidPath("empty path".to_string()));
        }

        let absolute_candidate = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("{}/{}", self.root, path)
        };
        let absolute = normalize_absolute(&absolute_candidate)?;
        if absolute != self.root && !absolute.starts_with(&format!("{}/", self.root)) {
            return Err(CoreError::PathOutsideWorkspace(path.to_string()));
        }
        let relative = absolute
            .strip_prefix(&self.root)
            .unwrap_or("")
            .strip_prefix('/')
            .unwrap_or("")
            .to_string();
        Ok(ResolvedPath { absolute, relative })
    }
}

impl Default for WorkspacePathPolicy {
    fn default() -> Self {
        Self {
            root: "/workspace".to_string(),
        }
    }
}

fn normalize_absolute(path: &str) -> CoreResult<String> {
    if !path.starts_with('/') {
        return Err(CoreError::InvalidPath(format!(
            "expected absolute path, got {path}"
        )));
    }

    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(CoreError::PathOutsideWorkspace(path.to_string()));
                }
            }
            part => parts.push(part),
        }
    }

    if parts.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(format!("/{}", parts.join("/")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_paths_inside_workspace() {
        let policy = WorkspacePathPolicy::default();
        assert_eq!(
            policy.resolve("src/lib.rs").unwrap().absolute,
            "/workspace/src/lib.rs"
        );
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let policy = WorkspacePathPolicy::default();
        assert!(matches!(
            policy.resolve("/tmp/outside"),
            Err(CoreError::PathOutsideWorkspace(_))
        ));
    }

    #[test]
    fn rejects_parent_escape() {
        let policy = WorkspacePathPolicy::default();
        assert!(matches!(
            policy.resolve("../outside"),
            Err(CoreError::PathOutsideWorkspace(_))
        ));
    }
}
