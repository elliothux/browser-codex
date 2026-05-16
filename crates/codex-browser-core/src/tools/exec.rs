// Upstream shape: external/codex/codex-rs/core/src/tools/context.rs
// `ExecCommandToolOutput::response_text`, narrowed to host-provided
// ExecOutputSnapshot data.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::approval::ExecApprovalRequest;
use crate::errors::{CoreError, CoreResult};
use crate::events::EventMsg;
use crate::host::{ExecOutputSnapshot, ExecRequest, OutputPollOptions};
use crate::output_truncation::{TruncationPolicy, formatted_truncate_text};
use crate::session::ExecApprovalMode;

use super::registry::{ToolCall, ToolContext, ToolExecution, ToolPayload, execution};

#[derive(Debug, Deserialize)]
struct ExecCommandArgs {
    cmd: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<usize>,
    #[serde(default)]
    tty: Option<bool>,
    #[serde(default)]
    login: Option<bool>,
    #[serde(default)]
    sandbox_permissions: Option<Value>,
    #[serde(default)]
    additional_permissions: Option<Value>,
    #[serde(default)]
    justification: Option<String>,
    #[serde(default)]
    prefix_rule: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct WriteStdinArgs {
    // Mirrors upstream Codex:
    // external/codex/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs::WriteStdinArgs.
    // Divergence: timeout defaults are supplied from CoreConfig so browser hosts
    // can tune polling without native process-manager state.
    session_id: i32,
    #[serde(default)]
    chars: String,
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

pub async fn exec_command_tool(
    call: &ToolCall,
    ctx: &ToolContext<'_>,
) -> CoreResult<ToolExecution> {
    let args: ExecCommandArgs = parse_args(call)?;
    if args.cmd.trim().is_empty() {
        return Ok(execution(
            call,
            "exec_command rejected an empty cmd",
            Some(false),
            Vec::new(),
        ));
    }
    if args.sandbox_permissions.is_some()
        || args.additional_permissions.is_some()
        || args.justification.is_some()
        || args.prefix_rule.is_some()
    {
        return Ok(execution(
            call,
            "exec_command native sandbox permission escalation is unsupported in codex-browser-core",
            Some(false),
            Vec::new(),
        ));
    }

    let workdir = ctx
        .path_policy
        .resolve(args.workdir.as_deref().unwrap_or(ctx.path_policy.root()))?
        .absolute;
    let mut events = vec![EventMsg::ExecCommandBegin {
        call_id: call.call_id.clone(),
        cmd: args.cmd.clone(),
    }];

    match ctx.config.exec_approval {
        ExecApprovalMode::Deny => {
            events.push(EventMsg::ExecCommandEnd {
                call_id: call.call_id.clone(),
                exit_code: None,
            });
            return Ok(execution(
                call,
                "exec_command denied by policy",
                Some(false),
                events,
            ));
        }
        ExecApprovalMode::Ask => {
            let request = ExecApprovalRequest {
                call_id: call.call_id.clone(),
                cmd: args.cmd.clone(),
                workdir: workdir.clone(),
            };
            events.push(EventMsg::ExecApprovalRequest {
                request: request.clone(),
            });
            let decision = ctx.host.approvals.approve_exec(request).await;
            if !decision.approved {
                events.push(EventMsg::ExecCommandEnd {
                    call_id: call.call_id.clone(),
                    exit_code: None,
                });
                return Ok(execution(
                    call,
                    format_exec_rejected_output(&args),
                    Some(false),
                    events,
                ));
            }
        }
        ExecApprovalMode::Auto => {}
    }

    let request = ExecRequest {
        cmd: args.cmd,
        workdir,
        shell: args.shell,
        // Mirrors upstream Codex:
        // external/codex/codex-rs/core/src/tools/handlers/unified_exec.rs::get_command.
        // The Codex-model tool config allows login shells by default; browser
        // hosts can decide how to realize this boundary in their process layer.
        login: args.login.unwrap_or(true),
        yield_time_ms: args
            .yield_time_ms
            .unwrap_or(ctx.config.default_yield_time_ms),
        max_output_tokens: args.max_output_tokens,
        tty: args.tty.unwrap_or(false),
        terminal_size: None,
    };
    let max_output_tokens = request.max_output_tokens;
    let snapshot = ctx.host.exec.start(request).await?;
    let text = format_exec_output(&call.call_id, &snapshot, max_output_tokens);
    if !snapshot.output.is_empty() {
        events.push(EventMsg::ExecCommandOutputDelta {
            call_id: call.call_id.clone(),
            chunk: String::from_utf8_lossy(&snapshot.output).to_string(),
        });
    }
    events.push(EventMsg::ExecCommandEnd {
        call_id: call.call_id.clone(),
        exit_code: snapshot.exit_code,
    });
    Ok(execution(call, text, Some(true), events))
}

pub async fn write_stdin_tool(call: &ToolCall, ctx: &ToolContext<'_>) -> CoreResult<ToolExecution> {
    let args: WriteStdinArgs = parse_args(call)?;
    let options = OutputPollOptions {
        yield_time_ms: args
            .yield_time_ms
            .unwrap_or(ctx.config.default_yield_time_ms),
        max_output_tokens: args.max_output_tokens,
    };
    let snapshot = if args.chars.is_empty() {
        ctx.host.exec.poll_output(args.session_id, options).await?
    } else {
        ctx.host
            .exec
            .write_stdin(args.session_id, args.chars, options)
            .await?
    };
    let text = format_exec_output(&call.call_id, &snapshot, args.max_output_tokens);
    let events = vec![EventMsg::ExecCommandOutputDelta {
        call_id: call.call_id.clone(),
        chunk: String::from_utf8_lossy(&snapshot.output).to_string(),
    }];
    Ok(execution(call, text, Some(true), events))
}

fn parse_args<T: for<'de> Deserialize<'de>>(call: &ToolCall) -> CoreResult<T> {
    match &call.payload {
        ToolPayload::Function { arguments } => {
            serde_json::from_str(arguments).map_err(|error| CoreError::InvalidToolArguments {
                tool: call.name.clone(),
                message: error.to_string(),
            })
        }
        ToolPayload::Custom { .. } | ToolPayload::ToolSearch { .. } => Err(CoreError::Tool(
            "exec tools must be called as function tools".to_string(),
        )),
    }
}

fn format_exec_output(
    call_id: &str,
    snapshot: &ExecOutputSnapshot,
    max_output_tokens: Option<usize>,
) -> String {
    let mut sections = Vec::new();
    sections.push(format!("Chunk ID: chunk-{call_id}"));
    let wall_time = Duration::from_millis(snapshot.wall_time_ms);
    sections.push(format!("Wall time: {:.4} seconds", wall_time.as_secs_f64()));
    if let Some(exit_code) = snapshot.exit_code {
        sections.push(format!("Process exited with code {exit_code}"));
    }
    if let Some(process_id) = snapshot.process_id {
        sections.push(format!("Process running with session ID {process_id}"));
    }
    let output = String::from_utf8_lossy(&snapshot.output).to_string();
    if let Some(original_token_count) = snapshot.original_token_count {
        sections.push(format!("Original token count: {original_token_count}"));
    }
    sections.push("Output:".to_string());
    sections.push(formatted_truncate_text(
        &output,
        TruncationPolicy::Tokens(resolve_max_tokens(max_output_tokens)),
    ));
    sections.join("\n")
}

fn format_exec_rejected_output(args: &ExecCommandArgs) -> String {
    // Mirrors upstream Codex:
    // external/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs
    // formats FunctionCallError::RespondToModel as
    // `exec_command failed for `{command_for_display}`: {err:?}`.
    // Divergence: browser approval rejection happens before HostExec, so this
    // host-boundary path synthesizes the same model-visible error shape.
    let shell = args.shell.as_deref().unwrap_or("/bin/sh");
    let flag = if args.login.unwrap_or(true) {
        "-lc"
    } else {
        "-c"
    };
    let command_for_display = shlex_join([shell, flag, args.cmd.as_str()]);
    format!(
        "exec_command failed for `{command_for_display}`: CreateProcess {{ message: \"Rejected(\\\"rejected by user\\\")\" }}"
    )
}

fn shlex_join<const N: usize>(parts: [&str; N]) -> String {
    parts
        .into_iter()
        .map(shlex_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn shlex_quote(part: &str) -> String {
    if part.is_empty() {
        return "''".to_string();
    }
    if part
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-' | '.' | ':' | '='))
    {
        return part.to_string();
    }
    format!("'{}'", part.replace('\'', "'\"'\"'"))
}

const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;

fn resolve_max_tokens(max_tokens: Option<usize>) -> usize {
    // Copied from upstream Codex:
    // external/codex/codex-rs/core/src/unified_exec/mod.rs::resolve_max_tokens.
    max_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_unified_exec_shape() {
        let snapshot = ExecOutputSnapshot {
            wall_time_ms: 12,
            output: b"hello\n".to_vec(),
            process_id: None,
            exit_code: Some(0),
            original_token_count: Some(1),
        };
        let text = format_exec_output("call-1", &snapshot, None);
        assert!(text.contains("Chunk ID: chunk-call-1"));
        assert!(text.contains("Process exited with code 0"));
        assert!(text.ends_with("Output:\nhello\n"));
    }

    #[test]
    fn truncates_unified_exec_output_like_upstream() {
        let snapshot = ExecOutputSnapshot {
            wall_time_ms: 1,
            output: b"0123456789abcdef\n".to_vec(),
            process_id: None,
            exit_code: Some(0),
            original_token_count: Some(5),
        };
        let text = format_exec_output("call-1", &snapshot, Some(2));
        assert!(text.contains("Original token count: 5"));
        assert!(text.contains("Total output lines: 1\n\n"));
        assert!(text.contains("…"));
    }
}
