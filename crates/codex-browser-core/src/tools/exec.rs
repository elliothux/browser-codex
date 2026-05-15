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
                let reason = decision
                    .reason
                    .unwrap_or_else(|| "command denied".to_string());
                events.push(EventMsg::ExecCommandEnd {
                    call_id: call.call_id.clone(),
                    exit_code: None,
                });
                return Ok(execution(
                    call,
                    format!("exec_command denied by approval policy: {reason}"),
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
        resolve_max_tokens(max_output_tokens),
    ));
    sections.join("\n")
}

const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
const APPROX_BYTES_PER_TOKEN: usize = 4;

fn resolve_max_tokens(max_tokens: Option<usize>) -> usize {
    // Copied from upstream Codex:
    // external/codex/codex-rs/core/src/unified_exec/mod.rs::resolve_max_tokens.
    max_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
}

fn formatted_truncate_text(content: &str, max_tokens: usize) -> String {
    // Copied from upstream Codex:
    // external/codex/codex-rs/utils/output-truncation/src/lib.rs::formatted_truncate_text
    // and utils/string/src/truncate.rs::truncate_middle_with_token_budget.
    if content.len() <= approx_bytes_for_tokens(max_tokens) {
        return content.to_string();
    }

    let total_lines = content.lines().count();
    let result = truncate_middle_with_token_budget(content, max_tokens).0;
    format!("Total output lines: {total_lines}\n\n{result}")
}

fn truncate_middle_with_token_budget(s: &str, max_tokens: usize) -> (String, Option<u64>) {
    if s.is_empty() {
        return (String::new(), None);
    }

    if max_tokens > 0 && s.len() <= approx_bytes_for_tokens(max_tokens) {
        return (s.to_string(), None);
    }

    let truncated = truncate_with_byte_estimate(
        s,
        approx_bytes_for_tokens(max_tokens),
        /*use_tokens*/ true,
    );
    let total_tokens = u64::try_from(approx_token_count(s)).unwrap_or(u64::MAX);

    if truncated == s {
        (truncated, None)
    } else {
        (truncated, Some(total_tokens))
    }
}

fn truncate_with_byte_estimate(s: &str, max_bytes: usize, use_tokens: bool) -> String {
    if s.is_empty() {
        return String::new();
    }

    let total_chars = s.chars().count();

    if max_bytes == 0 {
        return format_truncation_marker(
            use_tokens,
            removed_units(use_tokens, s.len(), total_chars),
        );
    }

    if s.len() <= max_bytes {
        return s.to_string();
    }

    let total_bytes = s.len();
    let (left_budget, right_budget) = split_budget(max_bytes);
    let (removed_chars, left, right) = split_string(s, left_budget, right_budget);
    let marker = format_truncation_marker(
        use_tokens,
        removed_units(
            use_tokens,
            total_bytes.saturating_sub(max_bytes),
            removed_chars,
        ),
    );

    assemble_truncated_output(left, right, &marker)
}

fn approx_token_count(text: &str) -> usize {
    let len = text.len();
    len.saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1)) / APPROX_BYTES_PER_TOKEN
}

fn approx_bytes_for_tokens(tokens: usize) -> usize {
    tokens.saturating_mul(APPROX_BYTES_PER_TOKEN)
}

fn approx_tokens_from_byte_count(bytes: usize) -> u64 {
    let bytes_u64 = bytes as u64;
    bytes_u64.saturating_add((APPROX_BYTES_PER_TOKEN as u64).saturating_sub(1))
        / (APPROX_BYTES_PER_TOKEN as u64)
}

fn split_string(s: &str, beginning_bytes: usize, end_bytes: usize) -> (usize, &str, &str) {
    if s.is_empty() {
        return (0, "", "");
    }

    let len = s.len();
    let tail_start_target = len.saturating_sub(end_bytes);
    let mut prefix_end = 0usize;
    let mut suffix_start = len;
    let mut removed_chars = 0usize;
    let mut suffix_started = false;

    for (idx, ch) in s.char_indices() {
        let char_end = idx + ch.len_utf8();
        if char_end <= beginning_bytes {
            prefix_end = char_end;
            continue;
        }

        if idx >= tail_start_target {
            if !suffix_started {
                suffix_start = idx;
                suffix_started = true;
            }
            continue;
        }

        removed_chars = removed_chars.saturating_add(1);
    }

    if suffix_start < prefix_end {
        suffix_start = prefix_end;
    }

    let before = &s[..prefix_end];
    let after = &s[suffix_start..];

    (removed_chars, before, after)
}

fn split_budget(budget: usize) -> (usize, usize) {
    let left = budget / 2;
    (left, budget - left)
}

fn format_truncation_marker(use_tokens: bool, removed_count: u64) -> String {
    if use_tokens {
        format!("…{removed_count} tokens truncated…")
    } else {
        format!("…{removed_count} chars truncated…")
    }
}

fn removed_units(use_tokens: bool, removed_bytes: usize, removed_chars: usize) -> u64 {
    if use_tokens {
        approx_tokens_from_byte_count(removed_bytes)
    } else {
        u64::try_from(removed_chars).unwrap_or(u64::MAX)
    }
}

fn assemble_truncated_output(prefix: &str, suffix: &str, marker: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + marker.len() + suffix.len() + 1);
    out.push_str(prefix);
    out.push_str(marker);
    out.push_str(suffix);
    out
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
