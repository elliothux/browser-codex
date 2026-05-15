use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use async_trait::async_trait;
use codex_browser_core::{
    ApplyPatchApprovalRequest, ApprovalDecision, ContentItem, ConversationItem, CoreConfig,
    CoreError, CoreResult, DirEntry, ExecApprovalMode, ExecApprovalRequest, ExecOutputSnapshot,
    ExecRequest, FileMetadata, FunctionCallOutputPayload, History, HostApprovals, HostExec,
    HostFileSystem, HostRuntime, HostStorage, ModelRequestOptions, ModelTransport,
    OutputPollOptions, Prompt, PromptItem, ResponseEnvelope, ResponseEvent, ResponseInputItem,
    ResponseItem, ResponseStream, Session, StorageEntry, TerminalSize, ToolCall, ToolRouter,
    UserInput,
};
use futures::executor::block_on;
use futures::stream;
use pretty_assertions::assert_eq;
use serde_json::json;

#[test]
fn no_tool_assistant_final() {
    let model = Rc::new(ScriptedModel::new(vec![vec![
        ev_created("resp-1"),
        ev_assistant_message("msg-1", "done"),
        ev_completed("resp-1"),
    ]]));
    let host = host_with_model(model.clone());
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("hello"))).unwrap();

    assert_eq!(result.final_message.as_deref(), Some("done"));
    assert_eq!(model.prompts.borrow().len(), 1);
    assert!(
        result
            .events
            .iter()
            .any(|event| matches!(event, codex_browser_core::EventMsg::TurnComplete { .. }))
    );
}

#[test]
fn streamed_assistant_text_delta_is_emitted() {
    let model = Rc::new(ScriptedModel::new(vec![vec![
        ev_created("resp-1"),
        ResponseEvent::OutputItemAdded {
            item: assistant_item("msg-1", ""),
        },
        ResponseEvent::OutputTextDelta {
            delta: "hel".to_string(),
        },
        ResponseEvent::OutputTextDelta {
            delta: "lo".to_string(),
        },
        ev_assistant_message("msg-1", "hello"),
        ev_completed("resp-1"),
    ]]));
    let host = host_with_model(model);
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("stream"))).unwrap();

    let deltas = result
        .events
        .iter()
        .filter_map(|event| match event {
            codex_browser_core::EventMsg::AgentMessageContentDelta { delta } => {
                Some(delta.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(deltas, vec!["hel", "lo"]);
}

#[test]
fn reasoning_deltas_are_emitted() {
    let model = Rc::new(ScriptedModel::new(vec![vec![
        ev_created("resp-1"),
        ResponseEvent::ReasoningTextDelta {
            delta: "think".to_string(),
            content_index: None,
        },
        ev_assistant_message("msg-1", "done"),
        ev_completed("resp-1"),
    ]]));
    let host = host_with_model(model);
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("reason"))).unwrap();

    assert!(result.events.iter().any(|event| matches!(
        event,
        codex_browser_core::EventMsg::ReasoningContentDelta { delta } if delta == "think"
    )));
}

#[test]
fn unsupported_custom_tool_returns_model_visible_error_and_follows_up() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::CustomToolCall {
                    id: Some("item-1".to_string()),
                    status: Some("completed".to_string()),
                    call_id: "call-unsupported".to_string(),
                    name: "unknown_tool".to_string(),
                    input: "payload".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "saw error"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = host_with_model(model.clone());
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("call bad tool"))).unwrap();

    assert_eq!(result.final_message.as_deref(), Some("saw error"));
    assert_eq!(result.tool_outputs.len(), 1);
    assert_eq!(
        result.tool_outputs[0].output_type,
        "custom_tool_call_output"
    );
    assert!(
        result.tool_outputs[0]
            .text
            .as_deref()
            .unwrap()
            .contains("unsupported custom tool call: unknown_tool")
    );
    let second_prompt = &model.prompts.borrow()[1];
    assert!(second_prompt.input.iter().any(|item| matches!(
        item,
        codex_browser_core::PromptItem::Input(ResponseInputItem::CustomToolCallOutput {
            call_id,
            ..
        }) if call_id == "call-unsupported"
    )));
}

#[test]
fn apply_patch_add_update_delete_updates_mock_fs() {
    let patch = "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** Delete File: delete.txt\n*** End Patch";
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::CustomToolCall {
                    id: Some("apply-item".to_string()),
                    status: Some("completed".to_string()),
                    call_id: "apply-1".to_string(),
                    name: "apply_patch".to_string(),
                    input: patch.to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "patched"),
            ev_completed("resp-2"),
        ],
    ]));
    let fs = Rc::new(MemoryFs::new([
        ("/workspace/modify.txt", "line1\nline2\n"),
        ("/workspace/delete.txt", "obsolete\n"),
    ]));
    let host = HostRuntime::new(
        model,
        fs.clone(),
        Rc::new(ScriptedExec::default()),
        Rc::new(ScriptedApprovals::allow()),
    );
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("patch"))).unwrap();

    assert_eq!(
        fs.text("/workspace/modify.txt").as_deref(),
        Some("line1\nchanged\n")
    );
    assert_eq!(
        fs.text("/workspace/nested/new.txt").as_deref(),
        Some("created\n")
    );
    assert!(fs.text("/workspace/delete.txt").is_none());
    assert_eq!(result.tool_outputs[0].success, Some(true));
    assert!(
        result.tool_outputs[0]
            .text
            .as_deref()
            .unwrap()
            .contains("Success. Updated the following files:")
    );
}

#[test]
fn invalid_apply_patch_returns_model_visible_error() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::CustomToolCall {
                    id: Some("apply-item".to_string()),
                    status: Some("completed".to_string()),
                    call_id: "apply-1".to_string(),
                    name: "apply_patch".to_string(),
                    input: "*** Begin Patch\nbad".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "bad patch"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = host_with_model(model);
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("patch"))).unwrap();

    assert_eq!(result.tool_outputs[0].success, Some(false));
    assert!(
        result.tool_outputs[0]
            .text
            .as_deref()
            .unwrap()
            .contains("apply_patch verification failed")
    );
}

#[test]
fn apply_patch_function_payload_is_rejected_like_upstream() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::FunctionCall {
                    id: Some("apply-item".to_string()),
                    name: "apply_patch".to_string(),
                    namespace: None,
                    arguments: "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch"
                        .to_string(),
                    call_id: "apply-1".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "bad patch payload"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = host_with_model(model);
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("patch"))).unwrap();

    assert_eq!(result.tool_outputs[0].output_type, "function_call_output");
    assert_eq!(result.tool_outputs[0].success, Some(false));
    assert!(
        result.tool_outputs[0]
            .text
            .as_deref()
            .unwrap()
            .contains("apply_patch handler received unsupported payload")
    );
}

#[test]
fn response_completed_end_turn_false_continues_sampling() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ev_assistant_message("msg-1", "intermediate"),
            ev_completed_with_end_turn("resp-1", Some(false)),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "final"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = host_with_model(model.clone());
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("continue"))).unwrap();

    assert_eq!(result.final_message.as_deref(), Some("final"));
    assert_eq!(model.prompts.borrow().len(), 2);
}

#[test]
fn response_item_ids_are_not_serialized_back_to_model() {
    let item = ResponseItem::FunctionCall {
        id: Some("fc_123".to_string()),
        name: "exec_command".to_string(),
        namespace: None,
        arguments: "{}".to_string(),
        call_id: "call_123".to_string(),
    };

    let value = serde_json::to_value(item).unwrap();

    assert!(value.get("id").is_none());
    assert_eq!(
        value.get("call_id").and_then(serde_json::Value::as_str),
        Some("call_123")
    );
}

#[test]
fn builtin_tool_surface_matches_upstream_subset_order() {
    let router = ToolRouter::builtin();
    let names = router
        .specs()
        .iter()
        .map(|spec| spec.name().to_string())
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["exec_command", "write_stdin", "apply_patch"]);
    assert!(!names.iter().any(|name| name == "read_file"));
    assert!(!names.iter().any(|name| name == "write_file"));
    assert!(!names.iter().any(|name| name == "list_files"));
}

#[test]
fn prompt_enables_parallel_tool_calls_like_codex_models() {
    let model = Rc::new(ScriptedModel::new(vec![vec![
        ev_created("resp-1"),
        ev_assistant_message("msg-1", "done"),
        ev_completed("resp-1"),
    ]]));
    let host = host_with_model(model.clone());
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    block_on(session.run_turn(text_input("hello"))).unwrap();

    let prompts = model.prompts.borrow();
    assert!(prompts[0].parallel_tool_calls);
}

#[test]
fn prompt_can_disable_parallel_tool_calls_for_model_capability() {
    let model = Rc::new(ScriptedModel::new(vec![vec![
        ev_created("resp-1"),
        ev_assistant_message("msg-1", "done"),
        ev_completed("resp-1"),
    ]]));
    let host = host_with_model(model.clone());
    let config = CoreConfig {
        supports_parallel_tool_calls: false,
        ..Default::default()
    };
    let mut session = Session::new(config, host).unwrap();

    block_on(session.run_turn(text_input("hello"))).unwrap();

    let prompts = model.prompts.borrow();
    assert!(!prompts[0].parallel_tool_calls);
}

#[test]
fn history_for_prompt_normalizes_tool_call_outputs() {
    let history = History::from_items(vec![
        ConversationItem::Input {
            item: ResponseInputItem::FunctionCallOutput {
                call_id: "orphan".to_string(),
                output: FunctionCallOutputPayload::from_text("old", Some(true)),
            },
        },
        ConversationItem::Response {
            item: ResponseItem::FunctionCall {
                id: Some("exec-item".to_string()),
                name: "exec_command".to_string(),
                namespace: None,
                arguments: r#"{"cmd":"true"}"#.to_string(),
                call_id: "exec-1".to_string(),
            },
        },
    ]);

    let prompt = history.for_prompt();

    assert!(!prompt.iter().any(|item| matches!(
        item,
        PromptItem::Input(ResponseInputItem::FunctionCallOutput { call_id, .. })
            if call_id == "orphan"
    )));
    assert!(prompt.iter().any(|item| matches!(
        item,
        PromptItem::Input(ResponseInputItem::FunctionCallOutput { call_id, output })
            if call_id == "exec-1" && output.text() == "aborted"
    )));
}

#[test]
fn tool_search_routing_matches_upstream_client_guard() {
    let client_call = ResponseItem::ToolSearchCall {
        id: Some("tool-search-item".to_string()),
        call_id: Some("tool-search-1".to_string()),
        status: Some("completed".to_string()),
        execution: "client".to_string(),
        arguments: json!({ "query": "exec" }),
    };
    let routed = ToolCall::from_response_item(&client_call).expect("client tool_search routes");
    assert_eq!(routed.name, "tool_search");
    assert_eq!(routed.call_id, "tool-search-1");

    let server_call = ResponseItem::ToolSearchCall {
        id: Some("server-search-item".to_string()),
        call_id: Some("server-search-1".to_string()),
        status: Some("completed".to_string()),
        execution: "server".to_string(),
        arguments: json!({ "query": "exec" }),
    };
    assert!(ToolCall::from_response_item(&server_call).is_none());

    let missing_call_id = ResponseItem::ToolSearchCall {
        id: Some("missing-id-search-item".to_string()),
        call_id: None,
        status: Some("completed".to_string()),
        execution: "client".to_string(),
        arguments: json!({ "query": "exec" }),
    };
    assert!(ToolCall::from_response_item(&missing_call_id).is_none());
}

#[test]
fn tool_search_outputs_are_model_visible_tool_search_items() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::ToolSearchCall {
                    id: Some("tool-search-item".to_string()),
                    call_id: Some("tool-search-1".to_string()),
                    status: Some("completed".to_string()),
                    execution: "client".to_string(),
                    arguments: json!({ "query": "exec" }),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "searched"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = host_with_model(model.clone());
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("find tools"))).unwrap();

    assert_eq!(result.final_message.as_deref(), Some("searched"));
    assert_eq!(result.tool_outputs[0].output_type, "tool_search_output");
    let second_prompt = &model.prompts.borrow()[1];
    assert!(second_prompt.input.iter().any(|item| matches!(
        item,
        codex_browser_core::PromptItem::Input(ResponseInputItem::ToolSearchOutput {
            call_id,
            execution,
            ..
        }) if call_id == "tool-search-1" && execution == "client"
    )));
}

#[test]
fn exec_command_success_output_shape() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::FunctionCall {
                    id: Some("exec-item".to_string()),
                    name: "exec_command".to_string(),
                    namespace: None,
                    arguments: r#"{"cmd":"printf hi","workdir":"/workspace","yield_time_ms":1,"max_output_tokens":20}"#.to_string(),
                    call_id: "exec-1".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "done"),
            ev_completed("resp-2"),
        ],
    ]));
    let exec = Rc::new(ScriptedExec::new(vec![ExecOutputSnapshot {
        wall_time_ms: 7,
        output: b"hi\n".to_vec(),
        process_id: None,
        exit_code: Some(0),
        original_token_count: Some(1),
    }]));
    let host = HostRuntime::new(
        model,
        Rc::new(MemoryFs::default()),
        exec,
        Rc::new(ScriptedApprovals::allow()),
    );
    let config = CoreConfig {
        exec_approval: ExecApprovalMode::Auto,
        ..Default::default()
    };
    let mut session = Session::new(config, host).unwrap();

    let result = block_on(session.run_turn(text_input("exec"))).unwrap();

    let output = result.tool_outputs[0].text.as_deref().unwrap();
    assert!(output.contains("Chunk ID: chunk-exec-1"));
    assert!(output.contains("Wall time: 0.0070 seconds"));
    assert!(output.contains("Process exited with code 0"));
    assert!(output.contains("Original token count: 1"));
    assert!(output.ends_with("Output:\nhi\n"));
}

#[test]
fn exec_command_passes_shell_and_login_to_host_boundary() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::FunctionCall {
                    id: Some("exec-item".to_string()),
                    name: "exec_command".to_string(),
                    namespace: None,
                    arguments: r#"{"cmd":"printf hi","workdir":"/workspace","shell":"/bin/zsh","login":false}"#.to_string(),
                    call_id: "exec-1".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "done"),
            ev_completed("resp-2"),
        ],
    ]));
    let exec = Rc::new(ScriptedExec::new(vec![ExecOutputSnapshot {
        wall_time_ms: 7,
        output: b"hi\n".to_vec(),
        process_id: None,
        exit_code: Some(0),
        original_token_count: Some(1),
    }]));
    let host = HostRuntime::new(
        model,
        Rc::new(MemoryFs::default()),
        exec.clone(),
        Rc::new(ScriptedApprovals::allow()),
    );
    let config = CoreConfig {
        exec_approval: ExecApprovalMode::Auto,
        ..Default::default()
    };
    let mut session = Session::new(config, host).unwrap();

    block_on(session.run_turn(text_input("exec"))).unwrap();

    let requests = exec.requests.borrow();
    assert_eq!(requests[0].shell.as_deref(), Some("/bin/zsh"));
    assert!(!requests[0].login);
}

#[test]
fn exec_command_denied_approval_is_model_visible() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::FunctionCall {
                    id: Some("exec-item".to_string()),
                    name: "exec_command".to_string(),
                    namespace: None,
                    arguments: r#"{"cmd":"rm -rf /workspace"}"#.to_string(),
                    call_id: "exec-1".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "denied"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = HostRuntime::new(
        model,
        Rc::new(MemoryFs::default()),
        Rc::new(ScriptedExec::default()),
        Rc::new(ScriptedApprovals::deny("no")),
    );
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("exec"))).unwrap();

    assert_eq!(result.tool_outputs[0].success, Some(false));
    assert!(
        result.tool_outputs[0]
            .text
            .as_deref()
            .unwrap()
            .contains("denied by approval policy")
    );
}

#[test]
fn early_stream_close_retries_request() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ev_assistant_message("msg-1", "partial"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "done"),
            ev_completed("resp-2"),
        ],
    ]));
    let host = host_with_model(model.clone());
    let mut session = Session::new(CoreConfig::default(), host).unwrap();

    let result = block_on(session.run_turn(text_input("retry"))).unwrap();

    assert_eq!(result.final_message.as_deref(), Some("done"));
    assert_eq!(model.prompts.borrow().len(), 2);
    assert!(model.prompts.borrow()[1].input.iter().any(|item| matches!(
        item,
        PromptItem::Response(ResponseItem::Message { content, .. })
            if content.iter().any(|content| matches!(
                content,
                ContentItem::OutputText { text } if text == "partial"
            ))
    )));
    assert!(result.events.iter().any(|event| matches!(
        event,
        codex_browser_core::EventMsg::StreamError { retry: 1, .. }
    )));
}

#[test]
fn early_stream_close_drains_tool_output_before_retry() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::FunctionCall {
                    id: Some("exec-item".to_string()),
                    name: "exec_command".to_string(),
                    namespace: None,
                    arguments: r#"{"cmd":"printf hi","workdir":"/workspace"}"#.to_string(),
                    call_id: "exec-1".to_string(),
                },
            },
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "done"),
            ev_completed("resp-2"),
        ],
    ]));
    let exec = Rc::new(ScriptedExec::new(vec![ExecOutputSnapshot {
        wall_time_ms: 7,
        output: b"hi\n".to_vec(),
        process_id: None,
        exit_code: Some(0),
        original_token_count: Some(1),
    }]));
    let host = HostRuntime::new(
        model.clone(),
        Rc::new(MemoryFs::default()),
        exec,
        Rc::new(ScriptedApprovals::allow()),
    );
    let config = CoreConfig {
        exec_approval: ExecApprovalMode::Auto,
        ..Default::default()
    };
    let mut session = Session::new(config, host).unwrap();

    let result = block_on(session.run_turn(text_input("exec retry"))).unwrap();

    assert_eq!(result.tool_outputs.len(), 1);
    let prompts = model.prompts.borrow();
    validate_request_body_invariants(&prompts[1]);
    assert!(prompts[1].input.iter().any(|item| matches!(
        item,
        PromptItem::Input(ResponseInputItem::FunctionCallOutput { call_id, output })
            if call_id == "exec-1" && output.text().contains("hi")
    )));
}

#[test]
fn request_invariant_tool_output_pairs_prior_tool_call() {
    let model = Rc::new(ScriptedModel::new(vec![
        vec![
            ev_created("resp-1"),
            ResponseEvent::OutputItemDone {
                item: ResponseItem::FunctionCall {
                    id: Some("exec-item".to_string()),
                    name: "exec_command".to_string(),
                    namespace: None,
                    arguments: r#"{"cmd":"true"}"#.to_string(),
                    call_id: "exec-1".to_string(),
                },
            },
            ev_completed("resp-1"),
        ],
        vec![
            ev_created("resp-2"),
            ev_assistant_message("msg-2", "done"),
            ev_completed("resp-2"),
        ],
    ]));
    let exec = Rc::new(ScriptedExec::new(vec![ExecOutputSnapshot {
        wall_time_ms: 1,
        output: Vec::new(),
        process_id: None,
        exit_code: Some(0),
        original_token_count: Some(0),
    }]));
    let host = HostRuntime::new(
        model.clone(),
        Rc::new(MemoryFs::default()),
        exec,
        Rc::new(ScriptedApprovals::allow()),
    );
    let config = CoreConfig {
        exec_approval: ExecApprovalMode::Auto,
        ..Default::default()
    };
    let mut session = Session::new(config, host).unwrap();

    block_on(session.run_turn(text_input("exec"))).unwrap();

    let prompts = model.prompts.borrow();
    validate_request_body_invariants(&prompts[1]);
}

fn text_input(text: &str) -> Vec<UserInput> {
    vec![UserInput::Text {
        text: text.to_string(),
    }]
}

fn ev_created(id: &str) -> ResponseEvent {
    ResponseEvent::ResponseCreated {
        response: ResponseEnvelope {
            id: Some(id.to_string()),
            usage: None,
            end_turn: None,
        },
    }
}

fn ev_completed(id: &str) -> ResponseEvent {
    ev_completed_with_end_turn(id, None)
}

fn ev_completed_with_end_turn(id: &str, end_turn: Option<bool>) -> ResponseEvent {
    ResponseEvent::ResponseCompleted {
        response: ResponseEnvelope {
            id: Some(id.to_string()),
            usage: None,
            end_turn,
        },
    }
}

fn ev_assistant_message(id: &str, text: &str) -> ResponseEvent {
    ResponseEvent::OutputItemDone {
        item: assistant_item(id, text),
    }
}

fn assistant_item(id: &str, text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: Some(id.to_string()),
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText {
            text: text.to_string(),
        }],
        phase: None,
    }
}

fn host_with_model(model: Rc<ScriptedModel>) -> HostRuntime {
    HostRuntime::new(
        model,
        Rc::new(MemoryFs::default()),
        Rc::new(ScriptedExec::default()),
        Rc::new(ScriptedApprovals::allow()),
    )
}

#[derive(Default)]
struct ScriptedModel {
    prompts: RefCell<Vec<Prompt>>,
    responses: RefCell<VecDeque<Vec<ResponseEvent>>>,
}

impl ScriptedModel {
    fn new(responses: Vec<Vec<ResponseEvent>>) -> Self {
        Self {
            prompts: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.into()),
        }
    }
}

#[async_trait(?Send)]
impl ModelTransport for ScriptedModel {
    async fn stream(
        &self,
        prompt: Prompt,
        _options: ModelRequestOptions,
    ) -> CoreResult<ResponseStream> {
        self.prompts.borrow_mut().push(prompt);
        let events = self
            .responses
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Model("no scripted response".to_string()))?;
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

#[derive(Default)]
struct MemoryFs {
    files: RefCell<BTreeMap<String, Vec<u8>>>,
}

impl MemoryFs {
    fn new<const N: usize>(files: [(&str, &str); N]) -> Self {
        Self {
            files: RefCell::new(
                files
                    .into_iter()
                    .map(|(path, text)| (path.to_string(), text.as_bytes().to_vec()))
                    .collect(),
            ),
        }
    }

    fn text(&self, path: &str) -> Option<String> {
        self.files
            .borrow()
            .get(path)
            .map(|bytes| String::from_utf8_lossy(bytes).to_string())
    }
}

#[async_trait(?Send)]
impl HostFileSystem for MemoryFs {
    async fn read_file(&self, path: &str) -> CoreResult<Vec<u8>> {
        self.files
            .borrow()
            .get(path)
            .cloned()
            .ok_or_else(|| CoreError::FileSystem(format!("{path} not found")))
    }

    async fn write_file(&self, path: &str, contents: Vec<u8>) -> CoreResult<()> {
        self.files.borrow_mut().insert(path.to_string(), contents);
        Ok(())
    }

    async fn read_dir(&self, path: &str) -> CoreResult<Vec<DirEntry>> {
        let prefix = if path.ends_with('/') {
            path.to_string()
        } else {
            format!("{path}/")
        };
        let mut entries = BTreeMap::<String, DirEntry>::new();
        for file in self.files.borrow().keys() {
            if let Some(rest) = file.strip_prefix(&prefix) {
                let name = rest.split('/').next().unwrap();
                let child = format!("{prefix}{name}");
                entries.entry(child.clone()).or_insert_with(|| DirEntry {
                    path: child,
                    is_dir: rest.contains('/'),
                    is_file: !rest.contains('/'),
                });
            }
        }
        Ok(entries.into_values().collect())
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileMetadata> {
        if let Some(bytes) = self.files.borrow().get(path) {
            Ok(FileMetadata {
                is_dir: false,
                is_file: true,
                len: bytes.len() as u64,
            })
        } else {
            let prefix = format!("{path}/");
            let is_dir = self
                .files
                .borrow()
                .keys()
                .any(|key| key.starts_with(&prefix));
            if is_dir {
                Ok(FileMetadata {
                    is_dir: true,
                    is_file: false,
                    len: 0,
                })
            } else {
                Err(CoreError::FileSystem(format!("{path} not found")))
            }
        }
    }

    async fn remove(&self, path: &str, recursive: bool, force: bool) -> CoreResult<()> {
        let mut files = self.files.borrow_mut();
        if files.remove(path).is_some() || force {
            return Ok(());
        }
        if recursive {
            let prefix = format!("{path}/");
            files.retain(|key, _| !key.starts_with(&prefix));
            Ok(())
        } else {
            Err(CoreError::FileSystem(format!("{path} not found")))
        }
    }

    async fn mkdir(&self, _path: &str, _recursive: bool) -> CoreResult<()> {
        Ok(())
    }
}

#[derive(Default)]
struct ScriptedExec {
    snapshots: RefCell<VecDeque<ExecOutputSnapshot>>,
    requests: RefCell<Vec<ExecRequest>>,
}

impl ScriptedExec {
    fn new(snapshots: Vec<ExecOutputSnapshot>) -> Self {
        Self {
            snapshots: RefCell::new(snapshots.into()),
            requests: RefCell::new(Vec::new()),
        }
    }
}

#[async_trait(?Send)]
impl HostExec for ScriptedExec {
    async fn start(&self, request: ExecRequest) -> CoreResult<ExecOutputSnapshot> {
        self.requests.borrow_mut().push(request);
        self.snapshots
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Exec("no scripted exec snapshot".to_string()))
    }

    async fn write_stdin(
        &self,
        _process_id: i32,
        _input: String,
        _options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot> {
        self.snapshots
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Exec("no scripted stdin snapshot".to_string()))
    }

    async fn poll_output(
        &self,
        _process_id: i32,
        _options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot> {
        self.snapshots
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Exec("no scripted poll snapshot".to_string()))
    }

    async fn kill(&self, _process_id: i32) -> CoreResult<()> {
        Ok(())
    }

    async fn resize(&self, _process_id: i32, _size: TerminalSize) -> CoreResult<()> {
        Ok(())
    }
}

struct ScriptedApprovals {
    decision: ApprovalDecision,
}

impl ScriptedApprovals {
    fn allow() -> Self {
        Self {
            decision: ApprovalDecision::approved(),
        }
    }

    fn deny(reason: &str) -> Self {
        Self {
            decision: ApprovalDecision::denied(reason),
        }
    }
}

#[async_trait(?Send)]
impl HostApprovals for ScriptedApprovals {
    async fn approve_exec(&self, _request: ExecApprovalRequest) -> ApprovalDecision {
        self.decision.clone()
    }

    async fn approve_patch(&self, _request: ApplyPatchApprovalRequest) -> ApprovalDecision {
        self.decision.clone()
    }
}

#[allow(dead_code)]
#[derive(Default)]
struct MemoryStorage {
    entries: RefCell<BTreeMap<String, Vec<u8>>>,
}

#[async_trait(?Send)]
impl HostStorage for MemoryStorage {
    async fn get(&self, key: &str) -> CoreResult<Option<Vec<u8>>> {
        Ok(self.entries.borrow().get(key).cloned())
    }

    async fn put(&self, key: &str, value: Vec<u8>) -> CoreResult<()> {
        self.entries.borrow_mut().insert(key.to_string(), value);
        Ok(())
    }

    async fn delete(&self, key: &str) -> CoreResult<()> {
        self.entries.borrow_mut().remove(key);
        Ok(())
    }

    async fn scan_prefix(&self, prefix: &str) -> CoreResult<Vec<StorageEntry>> {
        Ok(self
            .entries
            .borrow()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| StorageEntry {
                key: key.clone(),
                value: value.clone(),
            })
            .collect())
    }
}

fn validate_request_body_invariants(prompt: &Prompt) {
    let mut open_calls = BTreeMap::<String, bool>::new();
    for item in &prompt.input {
        match item {
            codex_browser_core::PromptItem::Response(ResponseItem::FunctionCall {
                call_id,
                ..
            })
            | codex_browser_core::PromptItem::Response(ResponseItem::CustomToolCall {
                call_id,
                ..
            }) => {
                assert!(!call_id.is_empty(), "tool call_id must not be empty");
                open_calls.insert(call_id.clone(), false);
            }
            codex_browser_core::PromptItem::Response(ResponseItem::ToolSearchCall {
                call_id: Some(call_id),
                execution,
                ..
            }) if execution == "client" => {
                assert!(!call_id.is_empty(), "tool call_id must not be empty");
                open_calls.insert(call_id.clone(), false);
            }
            codex_browser_core::PromptItem::Input(ResponseInputItem::FunctionCallOutput {
                call_id,
                ..
            })
            | codex_browser_core::PromptItem::Input(ResponseInputItem::CustomToolCallOutput {
                call_id,
                ..
            })
            | codex_browser_core::PromptItem::Input(ResponseInputItem::ToolSearchOutput {
                call_id,
                ..
            }) => {
                assert!(!call_id.is_empty(), "tool output call_id must not be empty");
                let matched = open_calls
                    .get_mut(call_id)
                    .unwrap_or_else(|| panic!("tool output {call_id} has no prior tool call"));
                assert!(!*matched, "tool output {call_id} was duplicated");
                *matched = true;
            }
            _ => {}
        }
    }
    let unmatched = open_calls
        .into_iter()
        .filter_map(|(call_id, matched)| (!matched).then_some(call_id))
        .collect::<Vec<_>>();
    assert!(unmatched.is_empty(), "unmatched tool calls: {unmatched:?}");
}
