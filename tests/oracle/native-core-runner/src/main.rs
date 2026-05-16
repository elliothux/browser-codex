use std::fs;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_core::shell::get_shell_by_model_provided_path;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::Op;
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::user_input::UserInput;
use core_test_support::responses::ResponsesRequest;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::TestCodex;
use core_test_support::test_codex::test_codex;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OracleCase {
    #[serde(default)]
    initial_files: Vec<CaseFile>,
    user_input: Vec<CaseUserInput>,
    model_responses: Vec<Vec<Value>>,
    #[serde(default)]
    approvals: Option<String>,
    #[serde(default = "default_supports_parallel_tool_calls")]
    supports_parallel_tool_calls: bool,
}

#[derive(Debug, Deserialize)]
struct CaseFile {
    path: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CaseUserInput {
    Text { text: String },
}

#[derive(Debug, Serialize)]
struct CanonicalTrace {
    model_requests: Vec<CanonicalRequest>,
    assistant_messages: Vec<String>,
    event_summaries: Vec<CanonicalEvent>,
    tool_outputs: Vec<CanonicalToolOutput>,
    final_files: Vec<CaseFileSnapshot>,
}

#[derive(Debug, Serialize)]
struct CanonicalRequest {
    input: Vec<Value>,
    tools: Vec<Value>,
    parallel_tool_calls: bool,
}

#[derive(Debug, Serialize)]
struct CanonicalEvent {
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry: Option<usize>,
}

#[derive(Debug, Serialize)]
struct CanonicalToolOutput {
    call_id: String,
    output_type: String,
    success: Option<bool>,
    text: Option<String>,
}

#[derive(Debug, Serialize)]
struct CaseFileSnapshot {
    path: String,
    text: String,
}

fn default_supports_parallel_tool_calls() -> bool {
    true
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: browser-codex-native-core-oracle <case.json>")?;
    let case_json = fs::read_to_string(path).context("read case json")?;
    let case: OracleCase = serde_json::from_str(&case_json).context("parse case json")?;
    let trace = run_case(case).await?;
    println!("{}", serde_json::to_string(&trace)?);
    Ok(())
}

async fn run_case(mut case: OracleCase) -> Result<CanonicalTrace> {
    ensure_supported_case(&case)?;
    install_placeholder_codex_binary_env()?;

    let server = start_mock_server().await;
    // Mirrors upstream model capability selection:
    // external/codex/codex-rs/core/src/session/turn.rs reads
    // turn_context.model_info.supports_parallel_tool_calls into each model
    // request. Divergence: the neutral JSON case only carries the capability
    // bit, so this standalone runner selects an upstream test/fallback model
    // with matching metadata instead of inventing a local request override.
    let model = if case.supports_parallel_tool_calls {
        "gpt-5.4"
    } else {
        "test-model"
    };
    let mut builder = test_codex()
        .with_model(model)
        .with_config(|config| {
            config.include_apply_patch_tool = true;
        })
        .with_user_shell(get_shell_by_model_provided_path(&PathBuf::from("/bin/sh")));
    let test = builder.build(&server).await?;
    write_initial_files(test.cwd_path(), &case.initial_files)?;
    rewrite_model_response_workspace_paths(&mut case.model_responses, test.cwd_path())?;

    let workspace_root = test.cwd_path().to_string_lossy().replace('\\', "/");
    let bodies = case
        .model_responses
        .into_iter()
        .map(sse)
        .collect::<Vec<_>>();
    let response_mock = mount_sse_sequence(&server, bodies).await;

    let submitted_text = single_text_input(case.user_input)?;
    let turn_id = submit_case_turn(&test, submitted_text).await?;
    let events = collect_turn_events(&test, &turn_id, case.approvals.as_deref()).await?;

    let requests = response_mock
        .requests()
        .into_iter()
        .map(|request| {
            canonical_request(
                request.body_json(),
                case.supports_parallel_tool_calls,
                &workspace_root,
            )
        })
        .collect::<Vec<_>>();

    Ok(CanonicalTrace {
        model_requests: requests,
        assistant_messages: assistant_messages(&events),
        event_summaries: event_summaries(&events),
        tool_outputs: tool_outputs_from_requests(&response_mock.requests(), &workspace_root),
        final_files: snapshot_workspace(test.cwd_path())?,
    })
}

fn rewrite_model_response_workspace_paths(responses: &mut [Vec<Value>], root: &Path) -> Result<()> {
    // Mirrors upstream native harness execution through
    // external/codex/codex-rs/core/tests/common/test_codex.rs, but maps the
    // browser case's virtual /workspace cwd to the native temporary cwd before
    // the upstream shell runtime sees the scripted function call.
    let root = root.to_string_lossy().replace('\\', "/");
    for response in responses {
        for event in response {
            let Some(item) = event.get_mut("item") else {
                continue;
            };
            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                continue;
            }
            let Some(arguments) = item.get_mut("arguments") else {
                continue;
            };
            let Some(arguments_text) = arguments.as_str() else {
                continue;
            };
            let mut parsed: Value =
                serde_json::from_str(arguments_text).context("parse function call arguments")?;
            rewrite_workspace_value(&mut parsed, &root);
            *arguments = Value::String(serde_json::to_string(&parsed)?);
        }
    }
    Ok(())
}

fn rewrite_workspace_value(value: &mut Value, root: &str) {
    match value {
        Value::String(text) => {
            if let Some(suffix) = text.strip_prefix("/workspace") {
                *text = format!("{root}{suffix}");
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_workspace_value(item, root);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                rewrite_workspace_value(value, root);
            }
        }
        _ => {}
    }
}

async fn submit_case_turn(test: &TestCodex, prompt: String) -> Result<String> {
    // Mirrors upstream Codex tests that drive the public thread API directly:
    // external/codex/codex-rs/core/tests/suite/items.rs uses Op::UserInput and
    // consumes EventMsg values with codex.next_event().
    // Divergence: the standalone oracle runner serializes the collected turn as
    // a canonical trace for browser wasm comparisons.
    let turn_id = test
        .codex
        .submit(Op::UserInput {
            environments: None,
            items: vec![UserInput::Text {
                text: prompt,
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
        })
        .await
        .context("submit native oracle turn")?;
    Ok(turn_id)
}

async fn collect_turn_events(
    test: &TestCodex,
    turn_id: &str,
    approvals: Option<&str>,
) -> Result<Vec<EventMsg>> {
    let mut events = Vec::new();
    let mut saw_target_turn = false;
    let timeout = std::time::Duration::from_secs(30);

    loop {
        let event = tokio::time::timeout(timeout, test.codex.next_event())
            .await
            .context("timeout waiting for native oracle event")?
            .context("native oracle event stream ended")?
            .msg;
        let is_target_turn_complete = match &event {
            EventMsg::TurnStarted(started) => {
                if started.turn_id == turn_id {
                    saw_target_turn = true;
                }
                false
            }
            EventMsg::ExecApprovalRequest(approval) if saw_target_turn => {
                // Mirrors upstream approval tests:
                // external/codex/codex-rs/core/tests/suite/approvals.rs submits
                // Op::ExecApproval with approval.effective_approval_id().
                // Divergence: the standalone oracle takes the decision from the
                // neutral JSON case so browser conformance can be deterministic.
                let decision = scripted_exec_approval_decision(approvals)?;
                test.codex
                    .submit(Op::ExecApproval {
                        id: approval.effective_approval_id(),
                        turn_id: Some(approval.turn_id.clone()),
                        decision,
                    })
                    .await
                    .context("submit native oracle exec approval decision")?;
                false
            }
            EventMsg::ApplyPatchApprovalRequest(approval) if saw_target_turn => {
                // Mirrors upstream patch approval flow:
                // external/codex/codex-rs/core/tests/suite/request_permissions_tool.rs
                // responds to Op::PatchApproval with the approval id from the
                // ApplyPatchApprovalRequest event. Divergence: the neutral
                // browser cases make patch approval deterministic here.
                test.codex
                    .submit(Op::PatchApproval {
                        id: approval.call_id.clone(),
                        decision: ReviewDecision::Approved,
                    })
                    .await
                    .context("submit native oracle patch approval decision")?;
                false
            }
            EventMsg::TurnComplete(completed) => saw_target_turn && completed.turn_id == turn_id,
            _ => false,
        };
        events.push(event);
        if is_target_turn_complete {
            return Ok(events);
        }
    }
}

fn scripted_exec_approval_decision(script: Option<&str>) -> Result<ReviewDecision> {
    match script {
        Some("deny") => Ok(ReviewDecision::Denied),
        Some("allow") => Ok(ReviewDecision::Approved),
        Some(other) => anyhow::bail!("unsupported native oracle approval script: {other}"),
        None => {
            anyhow::bail!("native oracle received exec approval request without approvals script")
        }
    }
}

fn install_placeholder_codex_binary_env() -> Result<()> {
    let current_exe = std::env::current_exe().context("resolve current oracle executable")?;
    // Upstream test support normally runs as a Cargo integration test and gets
    // CARGO_BIN_EXE_codex from Cargo. This standalone oracle binary does not
    // execute Codex as a subprocess for runtime-neutral cases, but upstream
    // config setup still probes the variable.
    unsafe {
        std::env::set_var("CARGO_BIN_EXE_codex", &current_exe);
        std::env::set_var("CARGO_BIN_EXE_codex-exec", &current_exe);
        // The standalone runner can inherit a macOS/system proxy that routes
        // localhost WireMock traffic away from the upstream test server.
        // Upstream sandboxed subprocess tests select reqwest's no-proxy client
        // path via CODEX_SANDBOX=seatbelt; mirror that behavior here.
        std::env::set_var("CODEX_SANDBOX", "seatbelt");
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        std::env::set_var("no_proxy", "127.0.0.1,localhost");
    }
    Ok(())
}

fn ensure_supported_case(case: &OracleCase) -> Result<()> {
    let mut supported_tool_calls = 0usize;
    for response in &case.model_responses {
        for event in response {
            let Some(item) = event.get("item") else {
                continue;
            };
            let item_type = item.get("type").and_then(Value::as_str);
            let name = item.get("name").and_then(Value::as_str);
            match (item_type, name) {
                (Some("custom_tool_call"), Some("apply_patch")) => supported_tool_calls += 1,
                (Some("custom_tool_call"), _) => {
                    supported_tool_calls += 1;
                }
                (Some("function_call"), Some("exec_command")) => {
                    supported_tool_calls += 1;
                }
                (Some("function_call"), Some(_)) => {
                    supported_tool_calls += 1;
                }
                (Some("tool_search_call"), _) => {
                    anyhow::bail!("native core oracle currently does not support tool_search_call");
                }
                _ => {}
            }
        }
    }
    if supported_tool_calls == 0 {
        anyhow::bail!(
            "native core oracle requires at least one supported tool call; do not use no-tool cases"
        );
    }
    Ok(())
}

fn tool_outputs_from_requests(
    requests: &[ResponsesRequest],
    workspace_root: &str,
) -> Vec<CanonicalToolOutput> {
    requests
        .iter()
        .flat_map(|request| {
            request
                .body_json()
                .get("input")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|item| match item.get("type").and_then(Value::as_str) {
            Some("function_call_output") => Some(CanonicalToolOutput {
                call_id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output_type: "function_call_output".to_string(),
                success: Some(function_tool_output_success(&canonical_output_text(
                    item.get("output"),
                ))),
                text: Some(normalize_workspace_text(
                    &canonical_output_text(item.get("output")),
                    workspace_root,
                )),
            }),
            Some("custom_tool_call_output") => Some(CanonicalToolOutput {
                call_id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output_type: "custom_tool_call_output".to_string(),
                success: Some(custom_tool_output_success(&canonical_output_text(
                    item.get("output"),
                ))),
                text: Some(normalize_workspace_text(
                    &canonical_output_text(item.get("output")),
                    workspace_root,
                )),
            }),
            Some("tool_search_output") => Some(CanonicalToolOutput {
                call_id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output_type: "tool_search_output".to_string(),
                success: Some(true),
                text: Some("[]".to_string()),
            }),
            _ => None,
        })
        .collect()
}

fn canonical_output_text(output: Option<&Value>) -> String {
    match output {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("input_text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn custom_tool_output_success(text: &str) -> bool {
    text.starts_with("Exit code: 0")
        || text.starts_with("Success. Updated the following files:")
        || text.contains("\nSuccess. Updated the following files:")
}

fn function_tool_output_success(text: &str) -> bool {
    !text.starts_with("exec_command failed") && !text.starts_with("unsupported call:")
}

fn single_text_input(inputs: Vec<CaseUserInput>) -> Result<String> {
    let mut texts = inputs
        .into_iter()
        .map(|input| match input {
            CaseUserInput::Text { text } => text,
        })
        .collect::<Vec<_>>();
    if texts.len() != 1 {
        anyhow::bail!("native oracle spike expects exactly one text input");
    }
    Ok(texts.remove(0))
}

fn canonical_request(
    body: Value,
    supports_parallel_tool_calls: bool,
    workspace_root: &str,
) -> CanonicalRequest {
    let input = body
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| canonical_input_item(item, workspace_root))
        .collect();
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(canonical_json)
        .collect();
    CanonicalRequest {
        input,
        tools,
        parallel_tool_calls: body
            .get("parallel_tool_calls")
            .and_then(Value::as_bool)
            .unwrap_or(supports_parallel_tool_calls),
    }
}

fn assistant_messages(events: &[EventMsg]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EventMsg::RawResponseItem(raw) => match &raw.item {
                ResponseItem::Message { role, content, .. } if role == "assistant" => Some(
                    content
                        .iter()
                        .filter_map(|item| match item {
                            ContentItem::OutputText { text } | ContentItem::InputText { text } => {
                                Some(text.as_str())
                            }
                            ContentItem::InputImage { .. } => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn event_summaries(events: &[EventMsg]) -> Vec<CanonicalEvent> {
    events
        .iter()
        .filter_map(|event| match event {
            EventMsg::AgentMessageContentDelta(delta) => Some(CanonicalEvent {
                r#type: "agent_message_content_delta".to_string(),
                delta: Some(delta.delta.clone()),
                retry: None,
            }),
            EventMsg::ReasoningContentDelta(delta) => Some(CanonicalEvent {
                r#type: "reasoning_content_delta".to_string(),
                delta: Some(delta.delta.clone()),
                retry: None,
            }),
            EventMsg::StreamError(error) => Some(CanonicalEvent {
                r#type: "stream_error".to_string(),
                delta: None,
                retry: retry_from_stream_error_message(&error.message),
            }),
            _ => None,
        })
        .collect()
}

fn retry_from_stream_error_message(message: &str) -> Option<usize> {
    message.split_whitespace().find_map(|part| {
        let (retry, _) = part.split_once('/')?;
        retry.parse::<usize>().ok()
    })
}

fn canonical_input_item(item: Value, workspace_root: &str) -> Option<Value> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    match item_type {
        "message" => canonical_message_item(item),
        "reasoning" => Some(json_object(vec![
            ("type", Value::String("reasoning".to_string())),
            (
                "summary",
                item.get("summary").cloned().unwrap_or(Value::Array(vec![])),
            ),
            (
                "content",
                item.get("content").cloned().unwrap_or(Value::Null),
            ),
        ])),
        "function_call" => Some(json_object(vec![
            ("type", Value::String("function_call".to_string())),
            ("name", item.get("name").cloned().unwrap_or(Value::Null)),
            (
                "namespace",
                item.get("namespace").cloned().unwrap_or(Value::Null),
            ),
            (
                "arguments",
                normalize_workspace_json(
                    item.get("arguments").cloned().unwrap_or(Value::Null),
                    workspace_root,
                ),
            ),
            (
                "call_id",
                item.get("call_id").cloned().unwrap_or(Value::Null),
            ),
        ])),
        "custom_tool_call" => Some(json_object(vec![
            ("type", Value::String("custom_tool_call".to_string())),
            (
                "call_id",
                item.get("call_id").cloned().unwrap_or(Value::Null),
            ),
            ("name", item.get("name").cloned().unwrap_or(Value::Null)),
            ("input", item.get("input").cloned().unwrap_or(Value::Null)),
        ])),
        "function_call_output" | "custom_tool_call_output" => Some(json_object(vec![
            ("type", Value::String(item_type.to_string())),
            (
                "call_id",
                item.get("call_id").cloned().unwrap_or(Value::Null),
            ),
            (
                "output",
                Value::String(normalize_workspace_text(
                    &canonical_output_text(item.get("output")),
                    workspace_root,
                )),
            ),
        ])),
        "tool_search_call" => Some(json_object(vec![
            ("type", Value::String("tool_search_call".to_string())),
            (
                "call_id",
                item.get("call_id").cloned().unwrap_or(Value::Null),
            ),
            ("status", item.get("status").cloned().unwrap_or(Value::Null)),
            (
                "execution",
                item.get("execution").cloned().unwrap_or(Value::Null),
            ),
            (
                "arguments",
                item.get("arguments")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
            ),
        ])),
        "tool_search_output" => Some(json_object(vec![
            ("type", Value::String("tool_search_output".to_string())),
            (
                "call_id",
                item.get("call_id").cloned().unwrap_or(Value::Null),
            ),
            ("status", item.get("status").cloned().unwrap_or(Value::Null)),
            (
                "execution",
                item.get("execution").cloned().unwrap_or(Value::Null),
            ),
            (
                "tools",
                item.get("tools").cloned().unwrap_or(Value::Array(vec![])),
            ),
        ])),
        _ => Some(json_object(vec![(
            "type",
            Value::String(item_type.to_string()),
        )])),
    }
}

fn normalize_workspace_json(value: Value, workspace_root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(normalize_workspace_text(&text, workspace_root)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_workspace_json(item, workspace_root))
                .collect(),
        ),
        Value::Object(object) => {
            let normalized = object
                .into_iter()
                .map(|(key, value)| (key, normalize_workspace_json(value, workspace_root)))
                .collect();
            Value::Object(normalized)
        }
        other => other,
    }
}

fn normalize_workspace_text(text: &str, workspace_root: &str) -> String {
    text.replace(workspace_root, "/workspace")
}

fn canonical_message_item(item: Value) -> Option<Value> {
    let role = item.get("role").and_then(Value::as_str)?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let content = item
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(canonical_content_item)
        .collect::<Vec<_>>();
    if role == "user"
        && content.iter().all(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.trim_start().starts_with("<environment_context>"))
        })
    {
        return None;
    }
    Some(json_object(vec![
        ("type", Value::String("message".to_string())),
        ("role", Value::String(role.to_string())),
        ("content", Value::Array(content)),
    ]))
}

fn canonical_content_item(item: Value) -> Option<Value> {
    match item.get("type").and_then(Value::as_str)? {
        "input_text" | "output_text" => Some(json_object(vec![
            ("type", item.get("type").cloned().unwrap_or(Value::Null)),
            ("text", item.get("text").cloned().unwrap_or(Value::Null)),
        ])),
        "input_image" => Some(json_object(vec![
            ("type", Value::String("input_image".to_string())),
            ("detail", item.get("detail").cloned().unwrap_or(Value::Null)),
        ])),
        other => Some(json_object(vec![(
            "type",
            Value::String(other.to_string()),
        )])),
    }
}

fn json_object(entries: Vec<(&str, Value)>) -> Value {
    let mut object = serde_json::Map::new();
    for (key, value) in entries {
        object.insert(key.to_string(), canonical_json(value));
    }
    Value::Object(object)
}

fn write_initial_files(root: &Path, files: &[CaseFile]) -> Result<()> {
    for file in files {
        let path = workspace_path_to_disk(root, &file.path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &file.text)?;
    }
    Ok(())
}

fn snapshot_workspace(root: &Path) -> Result<Vec<CaseFileSnapshot>> {
    let mut files = Vec::new();
    visit_workspace(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn visit_workspace(root: &Path, current: &Path, files: &mut Vec<CaseFileSnapshot>) -> Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            visit_workspace(root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(CaseFileSnapshot {
                path: format!("/workspace/{relative}"),
                text: fs::read_to_string(&path)?,
            });
        }
    }
    Ok(())
}

fn workspace_path_to_disk(root: &Path, workspace_path: &str) -> Result<std::path::PathBuf> {
    let relative = workspace_path
        .strip_prefix("/workspace/")
        .context("initial file path must start with /workspace/")?;
    let path = root.join(relative);
    Ok(path)
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonical_json).collect()),
        Value::Object(object) => {
            let mut ordered = serde_json::Map::new();
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(value) = object.get(&key) {
                    ordered.insert(key, canonical_json(value.clone()));
                }
            }
            Value::Object(ordered)
        }
        other => other,
    }
}
