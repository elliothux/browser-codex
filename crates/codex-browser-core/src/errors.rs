use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CoreError {
    #[error("model error: {0}")]
    Model(String),
    #[error("stream closed before response.completed")]
    StreamClosed,
    #[error("turn was cancelled")]
    Cancelled,
    #[error("tool error: {0}")]
    Tool(String),
    #[error("invalid tool arguments for {tool}: {message}")]
    InvalidToolArguments { tool: String, message: String },
    #[error("unsupported tool: {0}")]
    UnsupportedTool(String),
    #[error("path escapes workspace: {0}")]
    PathOutsideWorkspace(String),
    #[error("path is invalid: {0}")]
    InvalidPath(String),
    #[error("filesystem error: {0}")]
    FileSystem(String),
    #[error("exec error: {0}")]
    Exec(String),
    #[error("approval denied: {0}")]
    ApprovalDenied(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error.to_string())
    }
}
