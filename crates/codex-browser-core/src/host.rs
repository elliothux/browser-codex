use std::rc::Rc;

use async_trait::async_trait;
use serde::Deserialize;
use serde::Serialize;

use crate::approval::HostApprovals;
use crate::client::{ModelClient, ModelTransport};
use crate::errors::CoreResult;
pub type ProcessId = i32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DirEntry {
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileMetadata {
    pub is_dir: bool,
    pub is_file: bool,
    pub len: u64,
}

#[async_trait(?Send)]
pub trait HostFileSystem {
    async fn read_file(&self, path: &str) -> CoreResult<Vec<u8>>;

    async fn write_file(&self, path: &str, contents: Vec<u8>) -> CoreResult<()>;

    async fn read_dir(&self, path: &str) -> CoreResult<Vec<DirEntry>>;

    async fn metadata(&self, path: &str) -> CoreResult<FileMetadata>;

    async fn remove(&self, path: &str, recursive: bool, force: bool) -> CoreResult<()>;

    async fn mkdir(&self, path: &str, recursive: bool) -> CoreResult<()>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecRequest {
    pub cmd: String,
    pub workdir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default = "default_exec_login")]
    pub login: bool,
    pub yield_time_ms: u64,
    pub max_output_tokens: Option<usize>,
    pub tty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_size: Option<TerminalSize>,
}

fn default_exec_login() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputPollOptions {
    pub yield_time_ms: u64,
    pub max_output_tokens: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecOutputSnapshot {
    pub wall_time_ms: u64,
    pub output: Vec<u8>,
    pub process_id: Option<ProcessId>,
    pub exit_code: Option<i32>,
    pub original_token_count: Option<usize>,
}

#[async_trait(?Send)]
pub trait HostExec {
    async fn start(&self, request: ExecRequest) -> CoreResult<ExecOutputSnapshot>;

    async fn write_stdin(
        &self,
        process_id: ProcessId,
        input: String,
        options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot>;

    async fn poll_output(
        &self,
        process_id: ProcessId,
        options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot>;

    async fn kill(&self, process_id: ProcessId) -> CoreResult<()>;

    async fn resize(&self, process_id: ProcessId, size: TerminalSize) -> CoreResult<()>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageEntry {
    pub key: String,
    pub value: Vec<u8>,
}

#[async_trait(?Send)]
pub trait HostStorage {
    async fn get(&self, key: &str) -> CoreResult<Option<Vec<u8>>>;
    async fn put(&self, key: &str, value: Vec<u8>) -> CoreResult<()>;
    async fn delete(&self, key: &str) -> CoreResult<()>;
    async fn scan_prefix(&self, prefix: &str) -> CoreResult<Vec<StorageEntry>>;
}

#[derive(Clone)]
pub struct HostRuntime {
    pub model_client: ModelClient,
    pub fs: Rc<dyn HostFileSystem>,
    pub exec: Rc<dyn HostExec>,
    pub approvals: Rc<dyn HostApprovals>,
    pub storage: Option<Rc<dyn HostStorage>>,
}

impl HostRuntime {
    pub fn new(
        model_transport: Rc<dyn ModelTransport>,
        fs: Rc<dyn HostFileSystem>,
        exec: Rc<dyn HostExec>,
        approvals: Rc<dyn HostApprovals>,
    ) -> Self {
        Self {
            model_client: ModelClient::new(model_transport),
            fs,
            exec,
            approvals,
            storage: None,
        }
    }

    pub fn with_storage(mut self, storage: Rc<dyn HostStorage>) -> Self {
        self.storage = Some(storage);
        self
    }
}
