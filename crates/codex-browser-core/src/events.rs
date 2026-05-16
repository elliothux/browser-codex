use serde::Deserialize;
use serde::Serialize;

use crate::approval::{ApplyPatchApprovalRequest, ExecApprovalRequest};
use crate::models::ResponseItem;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub msg: EventMsg,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventMsg {
    TurnStarted {
        turn_id: String,
    },
    TurnComplete {
        turn_id: String,
    },
    TurnCancelled {
        turn_id: String,
    },
    ItemStarted {
        item_type: String,
    },
    ItemCompleted {
        item: ResponseItem,
    },
    AgentMessageContentDelta {
        delta: String,
    },
    ReasoningContentDelta {
        delta: String,
    },
    ExecCommandBegin {
        call_id: String,
        cmd: String,
    },
    ExecCommandEnd {
        call_id: String,
        exit_code: Option<i32>,
    },
    ExecCommandOutputDelta {
        call_id: String,
        chunk: String,
    },
    ExecApprovalRequest {
        request: ExecApprovalRequest,
    },
    ApplyPatchApprovalRequest {
        request: ApplyPatchApprovalRequest,
    },
    PatchApplyBegin {
        call_id: String,
    },
    PatchApplyEnd {
        call_id: String,
        success: bool,
    },
    TurnDiff {
        unified_diff: String,
    },
    StreamError {
        message: String,
        retry: usize,
    },
    Error {
        message: String,
    },
}

pub type CoreEvent = EventMsg;
