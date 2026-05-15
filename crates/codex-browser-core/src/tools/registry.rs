// Mirrors upstream Codex tool routing concepts from:
// external/codex/codex-rs/core/src/tools/registry.rs and
// external/codex/codex-rs/tools/src/tool_executor.rs. Divergence: this wasm
// core keeps a small builtin registry and injects runtime capabilities through
// host traits instead of native tool runtimes.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};

use crate::errors::CoreResult;
use crate::events::EventMsg;
use crate::host::HostRuntime;
use crate::models::{FunctionCallOutputPayload, ResponseInputItem, ResponseItem};
use crate::path::WorkspacePathPolicy;
use crate::session::CoreConfig;

use super::apply_patch::apply_patch_tool;
use super::exec::{exec_command_tool, write_stdin_tool};
use super::spec::{FreeformTool, FreeformToolFormat, JsonSchema, ResponsesApiTool, ToolSpec};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ToolPayload {
    Function { arguments: String },
    Custom { input: String },
    ToolSearch { arguments: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCall {
    pub name: String,
    pub call_id: String,
    pub payload: ToolPayload,
}

impl ToolCall {
    pub fn from_response_item(item: &ResponseItem) -> Option<Self> {
        match item {
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => Some(Self {
                name: name.clone(),
                call_id: call_id.clone(),
                payload: ToolPayload::Function {
                    arguments: arguments.clone(),
                },
            }),
            ResponseItem::CustomToolCall {
                name,
                input,
                call_id,
                ..
            } => Some(Self {
                name: name.clone(),
                call_id: call_id.clone(),
                payload: ToolPayload::Custom {
                    input: input.clone(),
                },
            }),
            ResponseItem::ToolSearchCall {
                execution,
                arguments,
                call_id: Some(call_id),
                ..
            } if execution == "client" => Some(Self {
                name: "tool_search".to_string(),
                call_id: call_id.clone(),
                payload: ToolPayload::ToolSearch {
                    arguments: Value::Object(
                        [
                            ("execution".to_string(), Value::String(execution.clone())),
                            ("arguments".to_string(), arguments.clone()),
                        ]
                        .into_iter()
                        .collect(),
                    ),
                },
            }),
            ResponseItem::ToolSearchCall { .. } => None,
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolOutputTrace {
    pub call_id: String,
    #[serde(rename = "type")]
    pub output_type: String,
    pub text: Option<String>,
    pub success: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolExecution {
    pub response_item: ResponseInputItem,
    pub trace: ToolOutputTrace,
    pub events: Vec<EventMsg>,
}

pub struct ToolContext<'a> {
    pub host: &'a HostRuntime,
    pub path_policy: &'a WorkspacePathPolicy,
    pub config: &'a CoreConfig,
}

#[derive(Debug, Default, Clone)]
pub struct ToolRegistry {
    specs: Vec<ToolSpec>,
}

impl ToolRegistry {
    pub fn builtin() -> Self {
        let mut registry = Self::default();
        registry.register(create_exec_command_tool());
        registry.register(create_write_stdin_tool());
        registry.register(ToolSpec::Freeform(FreeformTool {
            name: "apply_patch".to_string(),
            description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.".to_string(),
            format: FreeformToolFormat {
                kind: "grammar".to_string(),
                syntax: "lark".to_string(),
                definition: APPLY_PATCH_GRAMMAR.to_string(),
            },
        }));
        registry
    }

    pub fn register(&mut self, spec: ToolSpec) {
        if let Some(existing) = self
            .specs
            .iter_mut()
            .find(|existing| existing.name() == spec.name())
        {
            *existing = spec;
        } else {
            self.specs.push(spec);
        }
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.specs.iter().any(|spec| spec.name() == name)
    }
}

#[derive(Debug, Clone)]
pub struct ToolRouter {
    registry: ToolRegistry,
}

impl ToolRouter {
    pub fn builtin() -> Self {
        Self {
            registry: ToolRegistry::builtin(),
        }
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.registry.specs()
    }

    pub fn supports_parallel_tool_calls(&self, call: &ToolCall) -> bool {
        // Mirrors upstream Codex:
        // external/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs::supports_parallel_tool_calls.
        // Other current wasm-core tools keep the upstream default exclusive lock.
        self.registry.contains(&call.name) && call.name == "exec_command"
    }

    pub async fn dispatch(
        &self,
        call: &ToolCall,
        ctx: &ToolContext<'_>,
    ) -> CoreResult<ToolExecution> {
        if !self.registry.contains(&call.name) {
            return Ok(error_output(
                call,
                unsupported_tool_call_message(call),
                false,
            ));
        }

        let result = match call.name.as_str() {
            "apply_patch" => apply_patch_tool(call, ctx).await,
            "exec_command" => exec_command_tool(call, ctx).await,
            "write_stdin" => write_stdin_tool(call, ctx).await,
            _ => Ok(error_output(
                call,
                format!("registered tool '{}' has no handler", call.name),
                false,
            )),
        };

        match result {
            Ok(execution) => Ok(execution),
            Err(error) => Ok(error_output(call, error.to_string(), false)),
        }
    }
}

pub fn output_item(
    call: &ToolCall,
    text: impl Into<String>,
    success: Option<bool>,
) -> ResponseInputItem {
    let output = FunctionCallOutputPayload::from_text(text.into(), success);
    match &call.payload {
        ToolPayload::Custom { .. } => ResponseInputItem::CustomToolCallOutput {
            call_id: call.call_id.clone(),
            name: Some(call.name.clone()),
            output,
        },
        ToolPayload::ToolSearch { .. } => {
            // Mirrors upstream Codex:
            // external/codex/codex-rs/core/src/tools/context.rs::ToolSearchOutput::to_response_item
            // and AbortedToolOutput::to_response_item. Divergence: this core has
            // no deferred host tool index yet, so unsupported tool_search calls
            // return an empty client result rather than discovered tools.
            ResponseInputItem::ToolSearchOutput {
                call_id: call.call_id.clone(),
                status: "completed".to_string(),
                execution: "client".to_string(),
                tools: Vec::new(),
            }
        }
        ToolPayload::Function { .. } => ResponseInputItem::FunctionCallOutput {
            call_id: call.call_id.clone(),
            output,
        },
    }
}

pub fn execution(
    call: &ToolCall,
    text: impl Into<String>,
    success: Option<bool>,
    events: Vec<EventMsg>,
) -> ToolExecution {
    let response_item = output_item(call, text.into(), success);
    let output_type = match &call.payload {
        ToolPayload::Custom { .. } => "custom_tool_call_output",
        ToolPayload::Function { .. } => "function_call_output",
        ToolPayload::ToolSearch { .. } => "tool_search_output",
    }
    .to_string();
    let trace = ToolOutputTrace {
        call_id: call.call_id.clone(),
        output_type,
        text: response_item.output_text(),
        success: response_item.success(),
    };
    ToolExecution {
        response_item,
        trace,
        events,
    }
}

pub fn error_output(call: &ToolCall, message: impl Into<String>, success: bool) -> ToolExecution {
    execution(call, message.into(), Some(success), Vec::new())
}

fn unsupported_tool_call_message(call: &ToolCall) -> String {
    // Mirrors upstream Codex:
    // external/codex/codex-rs/core/src/tools/registry.rs::unsupported_tool_call_message.
    match &call.payload {
        ToolPayload::Custom { .. } => format!("unsupported custom tool call: {}", call.name),
        ToolPayload::Function { .. } | ToolPayload::ToolSearch { .. } => {
            format!("unsupported call: {}", call.name)
        }
    }
}

fn s(value: &str) -> String {
    value.to_string()
}

fn create_exec_command_tool() -> ToolSpec {
    // Copied from upstream Codex:
    // external/codex/codex-rs/core/src/tools/handlers/shell_spec.rs::create_exec_command_tool_with_environment_id.
    // Divergence: include_environment_id and exec permission approvals are not
    // exposed; shell/login remain schema-visible and are passed through the host
    // execution boundary.
    let mut properties = BTreeMap::from([
        (
            "cmd".to_string(),
            JsonSchema::string(Some(s("Shell command to execute."))),
        ),
        (
            "workdir".to_string(),
            JsonSchema::string(Some(s(
                "Optional working directory to run the command in; defaults to the turn cwd.",
            ))),
        ),
        (
            "shell".to_string(),
            JsonSchema::string(Some(s(
                "Shell binary to launch. Defaults to the user's default shell.",
            ))),
        ),
        (
            "tty".to_string(),
            JsonSchema::boolean(Some(s(
                "Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.",
            ))),
        ),
        (
            "yield_time_ms".to_string(),
            JsonSchema::number(Some(s(
                "How long to wait (in milliseconds) for output before yielding.",
            ))),
        ),
        (
            "max_output_tokens".to_string(),
            JsonSchema::number(Some(s(
                "Maximum number of tokens to return. Excess output will be truncated.",
            ))),
        ),
        (
            "login".to_string(),
            JsonSchema::boolean(Some(s(
                "Whether to run the shell with -l/-i semantics. Defaults to true.",
            ))),
        ),
    ]);
    properties.extend(create_approval_parameters(false));

    ToolSpec::Function(ResponsesApiTool {
        name: "exec_command".to_string(),
        description:
            "Runs a command in a PTY, returning output or a session ID for ongoing interaction."
                .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec!["cmd".to_string()]),
            Some(false.into()),
        ),
        output_schema: Some(unified_exec_output_schema()),
    })
}

fn create_write_stdin_tool() -> ToolSpec {
    // Copied from upstream Codex:
    // external/codex/codex-rs/core/src/tools/handlers/shell_spec.rs::create_write_stdin_tool.
    let properties = BTreeMap::from([
        (
            "session_id".to_string(),
            JsonSchema::number(Some(s("Identifier of the running unified exec session."))),
        ),
        (
            "chars".to_string(),
            JsonSchema::string(Some(s("Bytes to write to stdin (may be empty to poll)."))),
        ),
        (
            "yield_time_ms".to_string(),
            JsonSchema::number(Some(s(
                "How long to wait (in milliseconds) for output before yielding.",
            ))),
        ),
        (
            "max_output_tokens".to_string(),
            JsonSchema::number(Some(s(
                "Maximum number of tokens to return. Excess output will be truncated.",
            ))),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "write_stdin".to_string(),
        description:
            "Writes characters to an existing unified exec session and returns recent output."
                .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec!["session_id".to_string()]),
            Some(false.into()),
        ),
        output_schema: Some(unified_exec_output_schema()),
    })
}

fn create_approval_parameters(
    exec_permission_approvals_enabled: bool,
) -> BTreeMap<String, JsonSchema> {
    let mut properties = BTreeMap::from([
        (
            "sandbox_permissions".to_string(),
            JsonSchema::string(Some(s(if exec_permission_approvals_enabled {
                "Sandbox permissions for the command. Use \"with_additional_permissions\" to request additional sandboxed filesystem or network permissions (preferred), or \"require_escalated\" to request running without sandbox restrictions; defaults to \"use_default\"."
            } else {
                "Sandbox permissions for the command. Set to \"require_escalated\" to request running without sandbox restrictions; defaults to \"use_default\"."
            }))),
        ),
        (
            "justification".to_string(),
            JsonSchema::string(Some(s(
                r#"Only set if sandbox_permissions is \"require_escalated\".
                    Request approval from the user to run this command outside the sandbox.
                    Phrased as a simple question that summarizes the purpose of the
                    command as it relates to the task at hand - e.g. 'Do you want to
                    fetch and pull the latest version of this git branch?'"#,
            ))),
        ),
        (
            "prefix_rule".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some(s(
                    r#"Only specify when sandbox_permissions is `require_escalated`.
                        Suggest a prefix command pattern that will allow you to fulfill similar requests from the user in the future.
                        Should be a short but reasonable prefix, e.g. [\"git\", \"pull\"] or [\"uv\", \"run\"] or [\"pytest\"]."#,
                )),
            ),
        ),
    ]);

    if exec_permission_approvals_enabled {
        properties.insert(
            "additional_permissions".to_string(),
            permission_profile_schema(),
        );
    }

    properties
}

fn permission_profile_schema() -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([
            ("network".to_string(), network_permissions_schema()),
            ("file_system".to_string(), file_system_permissions_schema()),
        ]),
        None,
        Some(false.into()),
    )
}

fn network_permissions_schema() -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([(
            "enabled".to_string(),
            JsonSchema::boolean(Some(s("Set to true to request network access."))),
        )]),
        None,
        Some(false.into()),
    )
}

fn file_system_permissions_schema() -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([
            (
                "read".to_string(),
                JsonSchema::array(
                    JsonSchema::string(None),
                    Some(s("Absolute paths to grant read access to.")),
                ),
            ),
            (
                "write".to_string(),
                JsonSchema::array(
                    JsonSchema::string(None),
                    Some(s("Absolute paths to grant write access to.")),
                ),
            ),
        ]),
        None,
        Some(false.into()),
    )
}

fn unified_exec_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "chunk_id": {
                "type": "string",
                "description": "Chunk identifier included when the response reports one."
            },
            "wall_time_seconds": {
                "type": "number",
                "description": "Elapsed wall time spent waiting for output in seconds."
            },
            "exit_code": {
                "type": "number",
                "description": "Process exit code when the command finished during this call."
            },
            "session_id": {
                "type": "number",
                "description": "Session identifier to pass to write_stdin when the process is still running."
            },
            "original_token_count": {
                "type": "number",
                "description": "Approximate token count before output truncation."
            },
            "output": {
                "type": "string",
                "description": "Command output text, possibly truncated."
            }
        },
        "required": ["wall_time_seconds", "output"],
        "additionalProperties": false
    })
}

const APPLY_PATCH_GRAMMAR: &str = r#"start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
"#;
