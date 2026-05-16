use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use async_trait::async_trait;
use futures::stream;
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_futures::spawn_local;

use crate::approval::{
    ApplyPatchApprovalRequest, ApprovalDecision, ExecApprovalRequest, HostApprovals,
};
use crate::client::{ModelTransport, ResponseStream};
use crate::errors::{CoreError, CoreResult};
use crate::events::EventMsg;
use crate::host::{
    DirEntry, ExecOutputSnapshot, ExecRequest, FileMetadata, HostExec, HostFileSystem, HostRuntime,
    OutputPollOptions, TerminalSize,
};
use crate::models::{
    ModelRequestOptions, Prompt, ResponseEnvelope, ResponseEvent, ResponseItem, UserInput,
};
use crate::session::{
    CancellationToken, CoreConfig, ExecApprovalMode, Session, SessionSnapshot, TurnEventSink,
};
use crate::trace::FileSnapshotEntry;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = globalThis, js_name = __browserCodexFetch)]
    fn browser_codex_fetch_with_str_and_init(input: &str, init: &JsValue) -> js_sys::Promise;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmCase {
    #[serde(default)]
    initial_files: Vec<CaseFile>,
    user_input: Vec<UserInput>,
    model_responses: Vec<Vec<ResponseEvent>>,
    #[serde(default)]
    exec: Vec<ExecOutputSnapshot>,
    #[serde(default)]
    approvals: ApprovalScript,
    #[serde(default)]
    exec_approval: Option<ExecApprovalMode>,
    #[serde(default)]
    supports_parallel_tool_calls: Option<bool>,
    #[serde(default)]
    require_patch_approval: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmLiveRun {
    provider: ProviderConfig,
    #[serde(default)]
    initial_files: Vec<CaseFile>,
    user_input: Vec<UserInput>,
    #[serde(default)]
    approvals: ApprovalScript,
    #[serde(default)]
    exec_approval: Option<ExecApprovalMode>,
    #[serde(default)]
    supports_parallel_tool_calls: Option<bool>,
    #[serde(default)]
    require_patch_approval: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmHostTurn {
    provider: ProviderConfig,
    #[serde(default)]
    session: Option<SessionSnapshot>,
    user_input: Vec<UserInput>,
    #[serde(default)]
    exec_approval: Option<ExecApprovalMode>,
    #[serde(default)]
    supports_parallel_tool_calls: Option<bool>,
    #[serde(default)]
    require_patch_approval: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    base_url: String,
    api_key: String,
    model: String,
    #[serde(default)]
    tool_compatibility: ProviderToolCompatibility,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ProviderToolCompatibility {
    #[default]
    Upstream,
    ApplyPatchFunction,
}

#[derive(Debug, Deserialize)]
struct CaseFile {
    path: String,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostTurnOutput {
    assistant_text: Option<String>,
    session: SessionSnapshot,
    trace: crate::trace::AgentTrace,
    events: Vec<EventMsg>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ApprovalScript {
    #[default]
    Allow,
    Deny,
}

#[wasm_bindgen]
pub async fn run_case_json(case_json: String) -> Result<String, JsValue> {
    run_case_json_inner(case_json)
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub async fn run_live_json(run_json: String) -> Result<String, JsValue> {
    run_live_json_inner(run_json)
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub async fn run_host_turn_json(run_json: String, host: JsValue) -> Result<String, JsValue> {
    run_host_turn_json_inner(run_json, host)
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn run_host_turn_stream_json(run_json: String, host: JsValue) -> Result<JsValue, JsValue> {
    // Browser streaming adapter for upstream Codex event emission:
    // external/codex/codex-rs/core/src/codex.rs emits EventMsg values while a
    // turn is still running. Divergence: wasm exposes those values through a
    // ReadableStream object and uses stream cancellation as the cancellation
    // token instead of Tokio AbortHandle.
    let source = Object::new();
    let cancellation_token = CancellationToken::new();

    let start_token = cancellation_token.clone();
    let start_run_json = run_json.clone();
    let start_host = host.clone();
    let start = Closure::<dyn FnMut(JsValue)>::new(move |controller| {
        let sink = JsReadableStreamSink::new(controller);
        let run_json = start_run_json.clone();
        let host = start_host.clone();
        let token = start_token.clone();
        spawn_local(async move {
            let result =
                run_host_turn_stream_json_inner(run_json, host, sink.clone(), token.clone()).await;
            match result {
                Ok(output) => {
                    let _ = sink.enqueue_json(&json!({
                        "type": "done",
                        "output": serde_json::from_str::<Value>(&output)
                            .unwrap_or_else(|_| Value::String(output)),
                    }));
                    let _ = sink.close();
                }
                Err(CoreError::Cancelled) => {
                    let _ = sink.enqueue_json(&json!({ "type": "cancelled" }));
                    let _ = sink.close();
                }
                Err(error) => {
                    let _ = sink.error(&error.to_string());
                }
            }
        });
    });
    Reflect::set(&source, &JsValue::from_str("start"), start.as_ref())
        .map_err(|error| JsValue::from_str(&js_value_to_string(error)))?;
    start.forget();

    let cancel = Closure::<dyn FnMut(JsValue)>::new(move |_reason| {
        cancellation_token.cancel();
    });
    Reflect::set(&source, &JsValue::from_str("cancel"), cancel.as_ref())
        .map_err(|error| JsValue::from_str(&js_value_to_string(error)))?;
    cancel.forget();

    new_readable_stream(source.as_ref())
}

async fn run_case_json_inner(case_json: String) -> CoreResult<String> {
    let case: WasmCase = serde_json::from_str(&case_json)?;
    let fs = Rc::new(MemoryFs::new(case.initial_files));
    let model = Rc::new(ScriptedModel::new(case.model_responses));
    let exec = Rc::new(ScriptedExec::new(case.exec));
    let approvals = Rc::new(ScriptedApprovals::new(case.approvals));
    let host = HostRuntime::new(model, fs.clone(), exec.clone(), approvals.clone());

    let mut config = CoreConfig {
        require_patch_approval: case.require_patch_approval,
        ..CoreConfig::default()
    };
    if let Some(exec_approval) = case.exec_approval {
        config.exec_approval = exec_approval;
    }
    if let Some(supports_parallel_tool_calls) = case.supports_parallel_tool_calls {
        config.supports_parallel_tool_calls = supports_parallel_tool_calls;
    }

    let mut session = Session::new(config, host)?;
    let mut result = session.run_turn(case.user_input).await?;
    result.trace.final_files = fs.snapshot_text();
    result.trace.tool_outputs = result.tool_outputs.clone();
    result.trace.exec = exec.trace();
    result.trace.approvals = approvals.trace();
    serde_json::to_string(&result.trace).map_err(CoreError::from)
}

async fn run_live_json_inner(run_json: String) -> CoreResult<String> {
    let run: WasmLiveRun = serde_json::from_str(&run_json)?;
    let fs = Rc::new(MemoryFs::new(run.initial_files));
    let model = Rc::new(LiveResponsesModel::new(run.provider));
    let exec = Rc::new(ScriptedExec::new(Vec::new()));
    let approvals = Rc::new(ScriptedApprovals::new(run.approvals));
    let host = HostRuntime::new(model, fs.clone(), exec.clone(), approvals.clone());

    let mut config = CoreConfig {
        require_patch_approval: run.require_patch_approval,
        exec_approval: ExecApprovalMode::Deny,
        ..CoreConfig::default()
    };
    if let Some(exec_approval) = run.exec_approval {
        config.exec_approval = exec_approval;
    }
    if let Some(supports_parallel_tool_calls) = run.supports_parallel_tool_calls {
        config.supports_parallel_tool_calls = supports_parallel_tool_calls;
    }

    let mut session = Session::new(config, host)?;
    let mut result = session.run_turn(run.user_input).await?;
    result.trace.final_files = fs.snapshot_text();
    result.trace.tool_outputs = result.tool_outputs.clone();
    result.trace.exec = exec.trace();
    result.trace.approvals = approvals.trace();
    serde_json::to_string(&result.trace).map_err(CoreError::from)
}

async fn run_host_turn_json_inner(run_json: String, host: JsValue) -> CoreResult<String> {
    // Mirrors upstream Codex host/runtime split:
    // external/codex/codex-rs/core/src/session/handlers.rs creates a Session
    // over injected services. Divergence: browser filesystem, process, and
    // approval services cross the wasm boundary as JS host callbacks.
    let run: WasmHostTurn = serde_json::from_str(&run_json)?;
    let fs = Rc::new(JsHostFileSystem::new(required_child(&host, "fs")?));
    let exec = Rc::new(JsHostExec::new(required_child(&host, "exec")?));
    let approvals = Rc::new(JsHostApprovals::new(required_child(&host, "approvals")?));
    let model = Rc::new(LiveResponsesModel::new(run.provider));
    let host_runtime = HostRuntime::new(model, fs.clone(), exec, approvals);

    let mut config = CoreConfig {
        require_patch_approval: run.require_patch_approval,
        exec_approval: ExecApprovalMode::Ask,
        ..CoreConfig::default()
    };
    if let Some(exec_approval) = run.exec_approval {
        config.exec_approval = exec_approval;
    }
    if let Some(supports_parallel_tool_calls) = run.supports_parallel_tool_calls {
        config.supports_parallel_tool_calls = supports_parallel_tool_calls;
    }

    let mut session = match run.session {
        Some(snapshot) => Session::from_snapshot(config, host_runtime, snapshot)?,
        None => Session::new(config, host_runtime)?,
    };
    let mut result = session.run_turn(run.user_input).await?;
    result.trace.final_files = fs.snapshot_text().await?;
    result.trace.tool_outputs = result.tool_outputs.clone();
    let output = HostTurnOutput {
        assistant_text: result.final_message,
        session: session.snapshot(),
        trace: result.trace,
        events: result.events,
    };
    serde_json::to_string(&output).map_err(CoreError::from)
}

async fn run_host_turn_stream_json_inner(
    run_json: String,
    host: JsValue,
    event_sink: JsReadableStreamSink,
    cancellation_token: CancellationToken,
) -> CoreResult<String> {
    // Mirrors run_host_turn_json_inner; only event delivery/cancellation differ.
    let run: WasmHostTurn = serde_json::from_str(&run_json)?;
    let fs = Rc::new(JsHostFileSystem::new(required_child(&host, "fs")?));
    let exec = Rc::new(JsHostExec::new(required_child(&host, "exec")?));
    let approvals = Rc::new(JsHostApprovals::new(required_child(&host, "approvals")?));
    let model = Rc::new(LiveResponsesModel::new(run.provider));
    let host_runtime = HostRuntime::new(model, fs.clone(), exec, approvals);

    let mut config = CoreConfig {
        require_patch_approval: run.require_patch_approval,
        exec_approval: ExecApprovalMode::Ask,
        ..CoreConfig::default()
    };
    if let Some(exec_approval) = run.exec_approval {
        config.exec_approval = exec_approval;
    }
    if let Some(supports_parallel_tool_calls) = run.supports_parallel_tool_calls {
        config.supports_parallel_tool_calls = supports_parallel_tool_calls;
    }

    let mut session = match run.session {
        Some(snapshot) => Session::from_snapshot(config, host_runtime, snapshot)?,
        None => Session::new(config, host_runtime)?,
    };
    let mut result = session
        .run_turn_with_event_sink(run.user_input, Some(&event_sink), &cancellation_token)
        .await?;
    result.trace.final_files = fs.snapshot_text().await?;
    result.trace.tool_outputs = result.tool_outputs.clone();
    let output = HostTurnOutput {
        assistant_text: result.final_message,
        session: session.snapshot(),
        trace: result.trace,
        events: result.events,
    };
    serde_json::to_string(&output).map_err(CoreError::from)
}

#[derive(Clone)]
struct JsReadableStreamSink {
    controller: JsValue,
}

impl JsReadableStreamSink {
    fn new(controller: JsValue) -> Self {
        Self { controller }
    }

    fn enqueue_json(&self, value: &Value) -> CoreResult<()> {
        let serialized = serde_json::to_string(value)?;
        let chunk = js_sys::JSON::parse(&serialized)
            .map_err(|error| CoreError::Serialization(js_value_to_string(error)))?;
        call_sync_method(&self.controller, "enqueue", vec![chunk])?;
        Ok(())
    }

    fn close(&self) -> CoreResult<()> {
        call_sync_method(&self.controller, "close", Vec::new())?;
        Ok(())
    }

    fn error(&self, message: &str) -> CoreResult<()> {
        call_sync_method(&self.controller, "error", vec![JsValue::from_str(message)])?;
        Ok(())
    }
}

impl TurnEventSink for JsReadableStreamSink {
    fn on_event(&self, event: &EventMsg) -> CoreResult<()> {
        self.enqueue_json(&json!({ "type": "event", "event": event }))
    }
}

struct JsHostFileSystem {
    target: JsValue,
}

impl JsHostFileSystem {
    fn new(target: JsValue) -> Self {
        Self { target }
    }

    async fn snapshot_text(&self) -> CoreResult<Vec<FileSnapshotEntry>> {
        call_json_method(&self.target, "snapshotText", Vec::new()).await
    }
}

#[async_trait(?Send)]
impl HostFileSystem for JsHostFileSystem {
    async fn read_file(&self, path: &str) -> CoreResult<Vec<u8>> {
        let value = call_js_method(&self.target, "readFile", vec![JsValue::from_str(path)])
            .await
            .map_err(|error| CoreError::FileSystem(error.to_string()))?;
        js_value_to_bytes(value)
    }

    async fn write_file(&self, path: &str, contents: Vec<u8>) -> CoreResult<()> {
        let bytes = Uint8Array::from(contents.as_slice());
        call_js_method(
            &self.target,
            "writeFile",
            vec![JsValue::from_str(path), bytes.into()],
        )
        .await
        .map_err(|error| CoreError::FileSystem(error.to_string()))?;
        Ok(())
    }

    async fn read_dir(&self, path: &str) -> CoreResult<Vec<DirEntry>> {
        call_json_method(&self.target, "readDir", vec![JsValue::from_str(path)])
            .await
            .map_err(|error| CoreError::FileSystem(error.to_string()))
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileMetadata> {
        call_json_method(&self.target, "metadata", vec![JsValue::from_str(path)])
            .await
            .map_err(|error| CoreError::FileSystem(error.to_string()))
    }

    async fn remove(&self, path: &str, recursive: bool, force: bool) -> CoreResult<()> {
        call_js_method(
            &self.target,
            "remove",
            vec![
                JsValue::from_str(path),
                JsValue::from_bool(recursive),
                JsValue::from_bool(force),
            ],
        )
        .await
        .map_err(|error| CoreError::FileSystem(error.to_string()))?;
        Ok(())
    }

    async fn mkdir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        call_js_method(
            &self.target,
            "mkdir",
            vec![JsValue::from_str(path), JsValue::from_bool(recursive)],
        )
        .await
        .map_err(|error| CoreError::FileSystem(error.to_string()))?;
        Ok(())
    }
}

struct JsHostExec {
    target: JsValue,
}

impl JsHostExec {
    fn new(target: JsValue) -> Self {
        Self { target }
    }
}

#[async_trait(?Send)]
impl HostExec for JsHostExec {
    async fn start(&self, request: ExecRequest) -> CoreResult<ExecOutputSnapshot> {
        call_json_method(&self.target, "start", vec![serde_to_js_value(&request)?])
            .await
            .map_err(|error| CoreError::Exec(error.to_string()))
    }

    async fn write_stdin(
        &self,
        process_id: i32,
        input: String,
        options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot> {
        call_json_method(
            &self.target,
            "writeStdin",
            vec![
                JsValue::from_f64(process_id as f64),
                JsValue::from_str(&input),
                serde_to_js_value(&options)?,
            ],
        )
        .await
        .map_err(|error| CoreError::Exec(error.to_string()))
    }

    async fn poll_output(
        &self,
        process_id: i32,
        options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot> {
        call_json_method(
            &self.target,
            "pollOutput",
            vec![
                JsValue::from_f64(process_id as f64),
                serde_to_js_value(&options)?,
            ],
        )
        .await
        .map_err(|error| CoreError::Exec(error.to_string()))
    }

    async fn kill(&self, process_id: i32) -> CoreResult<()> {
        call_js_method(
            &self.target,
            "kill",
            vec![JsValue::from_f64(process_id as f64)],
        )
        .await
        .map_err(|error| CoreError::Exec(error.to_string()))?;
        Ok(())
    }

    async fn resize(&self, process_id: i32, size: TerminalSize) -> CoreResult<()> {
        call_js_method(
            &self.target,
            "resize",
            vec![
                JsValue::from_f64(process_id as f64),
                serde_to_js_value(&size)?,
            ],
        )
        .await
        .map_err(|error| CoreError::Exec(error.to_string()))?;
        Ok(())
    }
}

struct JsHostApprovals {
    target: JsValue,
}

impl JsHostApprovals {
    fn new(target: JsValue) -> Self {
        Self { target }
    }
}

#[async_trait(?Send)]
impl HostApprovals for JsHostApprovals {
    async fn approve_exec(&self, request: ExecApprovalRequest) -> ApprovalDecision {
        let value = match serde_to_js_value(&request) {
            Ok(value) => value,
            Err(error) => return ApprovalDecision::denied(error.to_string()),
        };
        call_json_method(&self.target, "approveExec", vec![value])
            .await
            .unwrap_or_else(|error| ApprovalDecision::denied(error.to_string()))
    }

    async fn approve_patch(&self, request: ApplyPatchApprovalRequest) -> ApprovalDecision {
        let value = match serde_to_js_value(&request) {
            Ok(value) => value,
            Err(error) => return ApprovalDecision::denied(error.to_string()),
        };
        call_json_method(&self.target, "approvePatch", vec![value])
            .await
            .unwrap_or_else(|error| ApprovalDecision::denied(error.to_string()))
    }
}

fn required_child(target: &JsValue, name: &str) -> CoreResult<JsValue> {
    let value = Reflect::get(target, &JsValue::from_str(name))
        .map_err(|error| CoreError::Serialization(js_value_to_string(error)))?;
    if value.is_undefined() || value.is_null() {
        return Err(CoreError::Serialization(format!(
            "host object is missing '{name}'"
        )));
    }
    Ok(value)
}

async fn call_json_method<T: DeserializeOwned>(
    target: &JsValue,
    name: &str,
    args: Vec<JsValue>,
) -> CoreResult<T> {
    let value = call_js_method(target, name, args).await?;
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| CoreError::Serialization(error.to_string()))
}

async fn call_js_method(target: &JsValue, name: &str, args: Vec<JsValue>) -> CoreResult<JsValue> {
    let method = Reflect::get(target, &JsValue::from_str(name))
        .map_err(|error| CoreError::Serialization(js_value_to_string(error)))?
        .dyn_into::<Function>()
        .map_err(|_| CoreError::Serialization(format!("host method '{name}' is not a function")))?;
    let js_args = Array::new();
    for arg in args {
        js_args.push(&arg);
    }
    let value = method
        .apply(target, &js_args)
        .map_err(|error| CoreError::Serialization(js_value_to_string(error)))?;
    JsFuture::from(Promise::resolve(&value))
        .await
        .map_err(|error| CoreError::Serialization(js_value_to_string(error)))
}

fn call_sync_method(target: &JsValue, name: &str, args: Vec<JsValue>) -> CoreResult<JsValue> {
    let method = Reflect::get(target, &JsValue::from_str(name))
        .map_err(|error| CoreError::Serialization(js_value_to_string(error)))?
        .dyn_into::<Function>()
        .map_err(|_| CoreError::Serialization(format!("host method '{name}' is not a function")))?;
    let js_args = Array::new();
    for arg in args {
        js_args.push(&arg);
    }
    method
        .apply(target, &js_args)
        .map_err(|error| CoreError::Serialization(js_value_to_string(error)))
}

fn new_readable_stream(source: &JsValue) -> Result<JsValue, JsValue> {
    let constructor = Function::new_with_args("source", "return new ReadableStream(source);");
    constructor
        .call1(&JsValue::NULL, source)
        .map_err(|error| JsValue::from_str(&js_value_to_string(error)))
}

fn serde_to_js_value<T: Serialize>(value: &T) -> CoreResult<JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|error| CoreError::Serialization(error.to_string()))
}

fn js_value_to_bytes(value: JsValue) -> CoreResult<Vec<u8>> {
    if let Some(text) = value.as_string() {
        return Ok(text.into_bytes());
    }
    if value.is_instance_of::<Uint8Array>() {
        return Ok(Uint8Array::new(&value).to_vec());
    }
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| CoreError::Serialization(error.to_string()))
}

struct ScriptedModel {
    responses: RefCell<VecDeque<Vec<ResponseEvent>>>,
}

impl ScriptedModel {
    fn new(responses: Vec<Vec<ResponseEvent>>) -> Self {
        Self {
            responses: RefCell::new(responses.into()),
        }
    }
}

#[async_trait(?Send)]
impl ModelTransport for ScriptedModel {
    async fn stream(
        &self,
        _prompt: Prompt,
        _options: ModelRequestOptions,
    ) -> CoreResult<ResponseStream> {
        let events = self
            .responses
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Model("no scripted model response".to_string()))?;
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

struct LiveResponsesModel {
    provider: ProviderConfig,
}

impl LiveResponsesModel {
    fn new(provider: ProviderConfig) -> Self {
        Self { provider }
    }
}

#[derive(Serialize)]
struct ResponsesRequest<'a> {
    model: &'a str,
    instructions: &'a str,
    input: Value,
    tools: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'a str>,
    parallel_tool_calls: bool,
    stream: bool,
}

#[async_trait(?Send)]
impl ModelTransport for LiveResponsesModel {
    async fn stream(
        &self,
        prompt: Prompt,
        options: ModelRequestOptions,
    ) -> CoreResult<ResponseStream> {
        // Browser live smoke adapter for upstream Codex's native client path:
        // external/codex/codex-rs/core/src/client.rs::ModelClientSession::stream.
        // Divergence: this adapter uses the runtime-installed browser fetch
        // boundary so WebContainer's fetch interception does not affect model
        // transport. Conformance tests must use scripted upstream-shaped
        // `ResponseEvent`s, not this provider adapter.
        let request = ResponsesRequest {
            model: &self.provider.model,
            instructions: &prompt.instructions,
            input: provider_prompt_input(&prompt, self.provider.tool_compatibility)?,
            tools: provider_tools(&prompt, self.provider.tool_compatibility)?,
            tool_choice: options.tool_choice.as_deref(),
            parallel_tool_calls: prompt.parallel_tool_calls,
            stream: false,
        };
        let body = serde_json::to_string(&request)?;
        let response_value = post_json(
            &responses_url(&self.provider.base_url),
            &self.provider.api_key,
            &body,
        )
        .await?;
        let events = response_value_to_events(response_value, self.provider.tool_compatibility)?;
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

fn provider_prompt_input(
    prompt: &Prompt,
    compatibility: ProviderToolCompatibility,
) -> CoreResult<Value> {
    let mut input = serde_json::to_value(&prompt.input)?;
    if compatibility == ProviderToolCompatibility::ApplyPatchFunction {
        rewrite_apply_patch_prompt_items(&mut input);
    }
    Ok(input)
}

fn provider_tools(prompt: &Prompt, compatibility: ProviderToolCompatibility) -> CoreResult<Value> {
    let mut tools = serde_json::to_value(&prompt.tools)?;
    if compatibility == ProviderToolCompatibility::ApplyPatchFunction {
        rewrite_apply_patch_tool_specs(&mut tools);
    }
    Ok(tools)
}

fn rewrite_apply_patch_tool_specs(tools: &mut Value) {
    // Provider compatibility fallback for OpenAI-compatible Responses APIs that
    // reject upstream custom/freeform tools. Upstream conformance still uses
    // external/codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs as a
    // custom tool; only this live provider adapter rewrites the wire shape.
    let Some(items) = tools.as_array_mut() else {
        return;
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("custom")
            && item.get("name").and_then(Value::as_str) == Some("apply_patch")
        {
            *item = json!({
                "type": "function",
                "name": "apply_patch",
                "description": "Use the apply_patch tool to edit files. Provide the full patch text in the patch field using the upstream apply_patch grammar.",
                "strict": false,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "patch": {
                            "type": "string",
                            "description": "Full apply_patch patch text."
                        }
                    },
                    "required": ["patch"],
                    "additionalProperties": false
                }
            });
        }
    }
}

fn rewrite_apply_patch_prompt_items(input: &mut Value) {
    let Some(items) = input.as_array_mut() else {
        return;
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("custom_tool_call")
            && item.get("name").and_then(Value::as_str) == Some("apply_patch")
        {
            let Some(call_id) = item.get("call_id").cloned() else {
                continue;
            };
            let Some(input_text) = item.get("input").and_then(Value::as_str) else {
                continue;
            };
            let mut replacement = Map::new();
            replacement.insert(
                "type".to_string(),
                Value::String("function_call".to_string()),
            );
            if let Some(id) = item.get("id").cloned() {
                replacement.insert("id".to_string(), id);
            }
            replacement.insert("call_id".to_string(), call_id);
            replacement.insert("name".to_string(), Value::String("apply_patch".to_string()));
            replacement.insert(
                "arguments".to_string(),
                Value::String(json!({ "patch": input_text }).to_string()),
            );
            *item = Value::Object(replacement);
        } else if item.get("type").and_then(Value::as_str) == Some("custom_tool_call_output")
            && item.get("name").and_then(Value::as_str) == Some("apply_patch")
        {
            if let Some(object) = item.as_object_mut() {
                object.insert(
                    "type".to_string(),
                    Value::String("function_call_output".to_string()),
                );
                object.remove("name");
            }
        }
    }
}

async fn post_json(url: &str, api_key: &str, body: &str) -> CoreResult<Value> {
    let init = Object::new();
    Reflect::set(
        &init,
        &JsValue::from_str("method"),
        &JsValue::from_str("POST"),
    )
    .map_err(|error| CoreError::Model(js_value_to_string(error)))?;
    Reflect::set(&init, &JsValue::from_str("body"), &JsValue::from_str(body))
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?;

    let headers = Object::new();
    Reflect::set(
        &headers,
        &JsValue::from_str("Authorization"),
        &JsValue::from_str(&format!("Bearer {api_key}")),
    )
    .map_err(|error| CoreError::Model(js_value_to_string(error)))?;
    Reflect::set(
        &headers,
        &JsValue::from_str("Content-Type"),
        &JsValue::from_str("application/json"),
    )
    .map_err(|error| CoreError::Model(js_value_to_string(error)))?;
    Reflect::set(&init, &JsValue::from_str("headers"), headers.as_ref())
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?;

    let response_js = JsFuture::from(browser_codex_fetch_with_str_and_init(url, init.as_ref()))
        .await
        .map_err(|error| {
            CoreError::Model(format!("fetch failed: {}", js_value_to_string(error)))
        })?;
    let status = js_response_status(&response_js)?;
    let body_js = JsFuture::from(js_response_json(&response_js)?)
        .await
        .map_err(|error| {
            CoreError::Model(format!(
                "invalid JSON response: {}",
                js_value_to_string(error)
            ))
        })?;
    let body_value = js_value_to_json(&body_js)?;

    if !js_response_ok(&response_js)? {
        return Err(CoreError::Model(model_error_message(status, &body_value)));
    }

    Ok(body_value)
}

fn js_response_ok(value: &JsValue) -> CoreResult<bool> {
    Reflect::get(value, &JsValue::from_str("ok"))
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?
        .as_bool()
        .ok_or_else(|| CoreError::Model("fetch did not return a Response".to_string()))
}

fn js_response_status(value: &JsValue) -> CoreResult<u16> {
    let status = Reflect::get(value, &JsValue::from_str("status"))
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?
        .as_f64()
        .ok_or_else(|| CoreError::Model("fetch did not return a Response".to_string()))?;
    Ok(status as u16)
}

fn js_response_json(value: &JsValue) -> CoreResult<Promise> {
    let json = Reflect::get(value, &JsValue::from_str("json"))
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?
        .dyn_into::<Function>()
        .map_err(|_| CoreError::Model("fetch did not return a Response".to_string()))?;
    json.call0(value)
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?
        .dyn_into::<Promise>()
        .map_err(|_| CoreError::Model("Response.json() did not return a Promise".to_string()))
}

fn response_value_to_events(
    response: Value,
    compatibility: ProviderToolCompatibility,
) -> CoreResult<Vec<ResponseEvent>> {
    let response_id = response
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("live-response")
        .to_string();
    let envelope = ResponseEnvelope {
        id: Some(response_id),
        usage: response.get("usage").cloned(),
        end_turn: response.get("end_turn").and_then(Value::as_bool),
    };
    let mut events = vec![ResponseEvent::ResponseCreated {
        response: envelope.clone(),
    }];

    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            let mut item = item.clone();
            if compatibility == ProviderToolCompatibility::ApplyPatchFunction {
                rewrite_provider_apply_patch_function_call(&mut item)?;
            }
            let parsed =
                serde_json::from_value::<ResponseItem>(item).unwrap_or(ResponseItem::Other);
            events.push(ResponseEvent::OutputItemDone { item: parsed });
        }
    } else if let Some(text) = response.get("output_text").and_then(Value::as_str) {
        events.push(ResponseEvent::OutputItemDone {
            item: assistant_message_item("live-message", text),
        });
    }

    if events.len() == 1 {
        return Err(CoreError::Model(
            "response did not include output items".to_string(),
        ));
    }

    events.push(ResponseEvent::ResponseCompleted { response: envelope });
    Ok(events)
}

fn rewrite_provider_apply_patch_function_call(item: &mut Value) -> CoreResult<()> {
    if item.get("type").and_then(Value::as_str) != Some("function_call")
        || item.get("name").and_then(Value::as_str) != Some("apply_patch")
    {
        return Ok(());
    }
    let call_id = item
        .get("call_id")
        .cloned()
        .ok_or_else(|| CoreError::Model("apply_patch function call missing call_id".to_string()))?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CoreError::Model("apply_patch function call missing arguments".to_string())
        })?;
    let input = apply_patch_function_arguments(arguments)?;
    let mut replacement = Map::new();
    replacement.insert(
        "type".to_string(),
        Value::String("custom_tool_call".to_string()),
    );
    if let Some(id) = item.get("id").cloned() {
        replacement.insert("id".to_string(), id);
    }
    replacement.insert("status".to_string(), Value::String("completed".to_string()));
    replacement.insert("call_id".to_string(), call_id);
    replacement.insert("name".to_string(), Value::String("apply_patch".to_string()));
    replacement.insert("input".to_string(), Value::String(input));
    *item = Value::Object(replacement);
    Ok(())
}

fn apply_patch_function_arguments(arguments: &str) -> CoreResult<String> {
    let value = serde_json::from_str::<Value>(arguments).map_err(|error| {
        CoreError::Model(format!(
            "apply_patch function arguments must be JSON: {error}"
        ))
    })?;
    value
        .get("patch")
        .or_else(|| value.get("input"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            CoreError::Model(
                "apply_patch function arguments must include a string patch field".to_string(),
            )
        })
}

fn assistant_message_item(id: &str, text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: Some(id.to_string()),
        role: "assistant".to_string(),
        content: vec![crate::models::ContentItem::OutputText {
            text: text.to_string(),
        }],
        phase: None,
    }
}

fn responses_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/responses") {
        base.to_string()
    } else {
        format!("{base}/responses")
    }
}

fn js_value_to_json(value: &JsValue) -> CoreResult<Value> {
    let stringified = js_sys::JSON::stringify(value)
        .map_err(|error| CoreError::Model(js_value_to_string(error)))?
        .as_string()
        .ok_or_else(|| CoreError::Model("failed to stringify JS value".to_string()))?;
    serde_json::from_str(&stringified).map_err(CoreError::from)
}

fn js_value_to_string(value: JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            js_sys::JSON::stringify(&value)
                .ok()
                .and_then(|text| text.as_string())
        })
        .unwrap_or_else(|| "unknown JavaScript error".to_string())
}

fn model_error_message(status: u16, body: &Value) -> String {
    if let Some(message) = body
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        return format!("model request failed ({status}): {message}");
    }
    if let Some(message) = body.get("message").and_then(Value::as_str) {
        return format!("model request failed ({status}): {message}");
    }
    format!("model request failed ({status})")
}

#[derive(Default)]
struct MemoryFs {
    files: RefCell<BTreeMap<String, Vec<u8>>>,
}

impl MemoryFs {
    fn new(files: Vec<CaseFile>) -> Self {
        Self {
            files: RefCell::new(
                files
                    .into_iter()
                    .map(|file| (file.path, file.text.into_bytes()))
                    .collect(),
            ),
        }
    }

    fn snapshot_text(&self) -> Vec<FileSnapshotEntry> {
        self.files
            .borrow()
            .iter()
            .map(|(path, contents)| FileSnapshotEntry {
                path: path.clone(),
                text: String::from_utf8_lossy(contents).to_string(),
            })
            .collect()
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
                let name = rest.split('/').next().unwrap_or(rest);
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
        if let Some(contents) = self.files.borrow().get(path) {
            Ok(FileMetadata {
                is_dir: false,
                is_file: true,
                len: contents.len() as u64,
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

struct ScriptedExec {
    snapshots: RefCell<VecDeque<ExecOutputSnapshot>>,
    trace: RefCell<Vec<Value>>,
}

impl ScriptedExec {
    fn new(snapshots: Vec<ExecOutputSnapshot>) -> Self {
        Self {
            snapshots: RefCell::new(snapshots.into()),
            trace: RefCell::new(Vec::new()),
        }
    }

    fn trace(&self) -> Vec<Value> {
        self.trace.borrow().clone()
    }
}

#[async_trait(?Send)]
impl HostExec for ScriptedExec {
    async fn start(&self, request: ExecRequest) -> CoreResult<ExecOutputSnapshot> {
        // Scripted host boundary for conformance traces. Mirrors the upstream
        // test harness capture style in
        // external/codex/codex-rs/core/tests/common/responses.rs while keeping
        // process execution injected instead of mocking Codex tool behavior.
        self.trace
            .borrow_mut()
            .push(json!({ "type": "exec_command", "request": request }));
        self.snapshots
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Exec("no scripted exec snapshot".to_string()))
    }

    async fn write_stdin(
        &self,
        process_id: i32,
        input: String,
        options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot> {
        self.trace.borrow_mut().push(json!({
            "type": "write_stdin",
            "process_id": process_id,
            "input": input,
            "options": options,
        }));
        self.snapshots
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Exec("no scripted stdin snapshot".to_string()))
    }

    async fn poll_output(
        &self,
        process_id: i32,
        options: OutputPollOptions,
    ) -> CoreResult<ExecOutputSnapshot> {
        self.trace.borrow_mut().push(json!({
            "type": "poll_output",
            "process_id": process_id,
            "options": options,
        }));
        self.snapshots
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| CoreError::Exec("no scripted poll snapshot".to_string()))
    }

    async fn kill(&self, process_id: i32) -> CoreResult<()> {
        self.trace
            .borrow_mut()
            .push(json!({ "type": "kill", "process_id": process_id }));
        Ok(())
    }

    async fn resize(&self, process_id: i32, size: TerminalSize) -> CoreResult<()> {
        self.trace.borrow_mut().push(json!({
            "type": "resize",
            "process_id": process_id,
            "size": size,
        }));
        Ok(())
    }
}

struct ScriptedApprovals {
    decision: ApprovalDecision,
    trace: RefCell<Vec<Value>>,
}

impl ScriptedApprovals {
    fn new(script: ApprovalScript) -> Self {
        let decision = match script {
            ApprovalScript::Allow => ApprovalDecision::approved(),
            ApprovalScript::Deny => ApprovalDecision::denied("scripted denial"),
        };
        Self {
            decision,
            trace: RefCell::new(Vec::new()),
        }
    }

    fn trace(&self) -> Vec<Value> {
        self.trace.borrow().clone()
    }
}

#[async_trait(?Send)]
impl HostApprovals for ScriptedApprovals {
    async fn approve_exec(&self, request: ExecApprovalRequest) -> ApprovalDecision {
        let decision = self.decision.clone();
        self.trace.borrow_mut().push(json!({
            "type": "exec",
            "request": request,
            "decision": decision.clone(),
        }));
        decision
    }

    async fn approve_patch(&self, request: ApplyPatchApprovalRequest) -> ApprovalDecision {
        let decision = self.decision.clone();
        self.trace.borrow_mut().push(json!({
            "type": "apply_patch",
            "request": request,
            "decision": decision.clone(),
        }));
        decision
    }
}
