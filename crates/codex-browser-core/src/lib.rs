//! Wasm-compatible Codex agent core.
//!
//! This crate intentionally keeps browser/runtime concerns behind host traits.
//! The public wire shapes mirror upstream Codex naming where the wasm boundary
//! needs to preserve Codex behavior, but native integrations are not linked in.

pub mod approval;
pub mod client;
pub mod errors;
pub mod events;
pub mod history;
pub mod host;
pub mod models;
pub mod path;
pub mod session;
pub mod tools;
pub mod trace;

#[cfg(target_arch = "wasm32")]
mod wasm_case;

pub use approval::{
    ApplyPatchApprovalRequest, ApprovalDecision, ExecApprovalRequest, HostApprovals,
};
pub use client::{ModelClient, ModelClientSession, ModelTransport, ResponseStream};
pub use errors::{CoreError, CoreResult};
pub use events::{CoreEvent, Event, EventMsg};
pub use history::{ConversationItem, History};
pub use host::{
    DirEntry, ExecOutputSnapshot, ExecRequest, FileMetadata, HostExec, HostFileSystem, HostRuntime,
    HostStorage, OutputPollOptions, ProcessId, StorageEntry, TerminalSize,
};
pub use models::{
    ContentItem, FunctionCallOutputBody, FunctionCallOutputContentItem, FunctionCallOutputPayload,
    MessagePhase, ModelRequestOptions, Prompt, PromptItem, ReasoningItemContent,
    ReasoningItemReasoningSummary, ResponseEnvelope, ResponseEvent, ResponseInputItem,
    ResponseItem, UserInput,
};
pub use path::{ResolvedPath, WorkspacePathPolicy};
pub use session::{CoreConfig, ExecApprovalMode, Session, SessionSnapshot, TurnResult};
pub use tools::{ToolCall, ToolOutputTrace, ToolPayload, ToolRegistry, ToolRouter, ToolSpec};

#[cfg(target_arch = "wasm32")]
pub use wasm_case::{run_case_json, run_live_json};
