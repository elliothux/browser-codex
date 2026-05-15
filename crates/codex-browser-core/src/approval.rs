use async_trait::async_trait;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalDecision {
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ApprovalDecision {
    pub fn approved() -> Self {
        Self {
            approved: true,
            reason: None,
        }
    }

    pub fn denied(reason: impl Into<String>) -> Self {
        Self {
            approved: false,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecApprovalRequest {
    pub call_id: String,
    pub cmd: String,
    pub workdir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApplyPatchApprovalRequest {
    pub call_id: String,
    pub workdir: String,
    pub affected_paths: Vec<String>,
}

#[async_trait(?Send)]
pub trait HostApprovals {
    async fn approve_exec(&self, request: ExecApprovalRequest) -> ApprovalDecision;

    async fn approve_patch(&self, request: ApplyPatchApprovalRequest) -> ApprovalDecision;
}
