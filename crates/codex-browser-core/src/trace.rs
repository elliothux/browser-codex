use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::events::EventMsg;
use crate::models::Prompt;
use crate::tools::ToolOutputTrace;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentTrace {
    pub model_requests: Vec<Prompt>,
    pub events: Vec<EventMsg>,
    pub tool_outputs: Vec<ToolOutputTrace>,
    pub final_files: Vec<FileSnapshotEntry>,
    #[serde(default)]
    pub approvals: Vec<Value>,
    #[serde(default)]
    pub exec: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileSnapshotEntry {
    pub path: String,
    pub text: String,
}
