// Mirrors upstream Codex sampling flow:
// external/codex/codex-rs/core/src/session/turn.rs::run_sampling_request and
// ::try_run_sampling_request. Divergence: this wasm core omits native session
// services, telemetry, compaction, mailbox, and Tokio cancellation, and injects
// runtime capabilities through host traits.

use std::cell::Cell;
use std::rc::Rc;

use futures::StreamExt;
use futures::future::join_all;
use serde::Deserialize;
use serde::Serialize;

use crate::client::ModelClientSession;
use crate::errors::{CoreError, CoreResult};
use crate::events::EventMsg;
use crate::history::History;
use crate::host::HostRuntime;
use crate::models::{
    ContentItem, ModelRequestOptions, Prompt, ResponseEvent, ResponseInputItem, ResponseItem,
    UserInput,
};
use crate::path::WorkspacePathPolicy;
use crate::tools::{ToolCall, ToolContext, ToolOutputTrace, ToolRouter};
use crate::trace::AgentTrace;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreConfig {
    pub workspace_root: String,
    pub base_instructions: String,
    pub model: Option<String>,
    pub max_sampling_retries: usize,
    pub max_tool_iterations: usize,
    #[serde(default = "default_supports_parallel_tool_calls")]
    pub supports_parallel_tool_calls: bool,
    pub require_patch_approval: bool,
    pub exec_approval: ExecApprovalMode,
    pub max_file_read_bytes: usize,
    pub default_yield_time_ms: u64,
}

fn default_supports_parallel_tool_calls() -> bool {
    true
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            workspace_root: "/workspace".to_string(),
            base_instructions: "You are Codex, a coding agent.".to_string(),
            model: None,
            max_sampling_retries: 1,
            max_tool_iterations: 16,
            supports_parallel_tool_calls: true,
            require_patch_approval: false,
            exec_approval: ExecApprovalMode::Ask,
            max_file_read_bytes: 512 * 1024,
            default_yield_time_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecApprovalMode {
    Auto,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnResult {
    pub events: Vec<EventMsg>,
    pub tool_outputs: Vec<ToolOutputTrace>,
    pub final_message: Option<String>,
    pub trace: AgentTrace,
}

#[derive(Clone, Default)]
pub struct CancellationToken {
    cancelled: Rc<Cell<bool>>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.set(true);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.get()
    }
}

pub trait TurnEventSink {
    fn on_event(&self, event: &EventMsg) -> CoreResult<()>;
}

pub struct Session {
    session_id: String,
    thread_id: String,
    config: CoreConfig,
    history: History,
    host: HostRuntime,
    path_policy: WorkspacePathPolicy,
    next_id: u64,
}

struct TurnRuntime<'a> {
    router: &'a ToolRouter,
    event_sink: Option<&'a dyn TurnEventSink>,
    cancellation_token: &'a CancellationToken,
    turn_id: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub thread_id: String,
    pub history: History,
    pub next_id: u64,
}

impl Session {
    pub fn new(config: CoreConfig, host: HostRuntime) -> CoreResult<Self> {
        let path_policy = WorkspacePathPolicy::new(config.workspace_root.clone())?;
        Ok(Self {
            session_id: "session-1".to_string(),
            thread_id: "thread-1".to_string(),
            config,
            history: History::new(),
            host,
            path_policy,
            next_id: 1,
        })
    }

    pub fn from_snapshot(
        config: CoreConfig,
        host: HostRuntime,
        snapshot: SessionSnapshot,
    ) -> CoreResult<Self> {
        let path_policy = WorkspacePathPolicy::new(config.workspace_root.clone())?;
        Ok(Self {
            session_id: snapshot.session_id,
            thread_id: snapshot.thread_id,
            config,
            history: snapshot.history,
            host,
            path_policy,
            next_id: snapshot.next_id.max(1),
        })
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            history: self.history.clone(),
            next_id: self.next_id,
        }
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub async fn run_turn(&mut self, input: Vec<UserInput>) -> CoreResult<TurnResult> {
        self.run_turn_with_event_sink(input, None, &CancellationToken::new())
            .await
    }

    pub async fn run_turn_with_event_sink(
        &mut self,
        input: Vec<UserInput>,
        event_sink: Option<&dyn TurnEventSink>,
        cancellation_token: &CancellationToken,
    ) -> CoreResult<TurnResult> {
        let turn_id = self.next_id("turn");
        let mut events = Vec::new();
        emit(
            &mut events,
            event_sink,
            EventMsg::TurnStarted {
                turn_id: turn_id.clone(),
            },
        )?;
        let mut trace = AgentTrace::default();
        let mut tool_outputs = Vec::new();

        self.check_cancelled(&turn_id, &mut events, event_sink, cancellation_token)?;

        let user_content = input
            .into_iter()
            .map(UserInput::into_content_item)
            .collect::<Vec<_>>();
        self.history.push_input(ResponseInputItem::Message {
            role: "user".to_string(),
            content: user_content,
            phase: None,
        });

        let router = ToolRouter::builtin();
        let runtime = TurnRuntime {
            router: &router,
            event_sink,
            cancellation_token,
            turn_id: &turn_id,
        };
        let mut final_message = None;
        let mut client_session = self.host.model_client.new_session();

        for _ in 0..self.config.max_tool_iterations {
            self.check_cancelled(&turn_id, &mut events, event_sink, cancellation_token)?;
            let sampling = self
                .sample_with_retry(
                    &runtime,
                    &mut events,
                    &mut client_session,
                    &mut trace,
                    &mut tool_outputs,
                )
                .await?;

            final_message = sampling.final_message.or(final_message);

            if sampling.tool_calls.is_empty() && !sampling.needs_follow_up {
                emit(
                    &mut events,
                    event_sink,
                    EventMsg::TurnComplete {
                        turn_id: turn_id.clone(),
                    },
                )?;
                trace.events = events.clone();
                trace.tool_outputs = tool_outputs.clone();
                return Ok(TurnResult {
                    events,
                    tool_outputs,
                    final_message,
                    trace,
                });
            }

            self.dispatch_and_record_tool_calls(
                runtime.router,
                sampling.tool_calls,
                &mut events,
                runtime.event_sink,
                &mut tool_outputs,
            )
            .await?;
        }

        Err(CoreError::Model(format!(
            "tool loop exceeded {} iterations",
            self.config.max_tool_iterations
        )))
    }

    fn build_prompt(&self, router: &ToolRouter) -> Prompt {
        Prompt {
            instructions: self.config.base_instructions.clone(),
            input: self
                .history
                .for_prompt_with_output_limit(self.config.max_file_read_bytes),
            tools: router.specs(),
            // Mirrors upstream Codex:
            // external/codex/codex-rs/core/src/session/turn.rs::build_prompt.
            // Divergence: model metadata is injected through CoreConfig because
            // the wasm core does not own upstream's native model registry.
            parallel_tool_calls: self.config.supports_parallel_tool_calls,
        }
    }

    async fn dispatch_and_record_tool_calls(
        &mut self,
        router: &ToolRouter,
        calls: Vec<ToolCall>,
        events: &mut Vec<EventMsg>,
        event_sink: Option<&dyn TurnEventSink>,
        tool_outputs: &mut Vec<ToolOutputTrace>,
    ) -> CoreResult<()> {
        let executions = self.dispatch_tool_calls(router, calls).await?;
        for execution in executions {
            for event in execution.events {
                emit(events, event_sink, event)?;
            }
            self.history.push_input(execution.response_item);
            tool_outputs.push(execution.trace);
        }
        Ok(())
    }

    async fn dispatch_tool_calls(
        &self,
        router: &ToolRouter,
        calls: Vec<ToolCall>,
    ) -> CoreResult<Vec<crate::tools::ToolExecution>> {
        // Mirrors upstream Codex:
        // external/codex/codex-rs/core/src/tools/parallel.rs::ToolCallRuntime.
        // Divergence: wasm execution remains single-threaded and host traits are
        // !Send, so concurrent-capable tools are batched with futures::join_all
        // while exclusive tools flush pending parallel work before running.
        let mut executions = Vec::with_capacity(calls.len());
        let mut parallel_batch = Vec::new();

        for call in calls {
            if router.supports_parallel_tool_calls(&call) {
                parallel_batch.push(call);
                continue;
            }

            if !parallel_batch.is_empty() {
                executions.extend(
                    self.dispatch_parallel_batch(router, &parallel_batch)
                        .await?,
                );
                parallel_batch.clear();
            }
            executions.push(self.dispatch_one_tool(router, &call).await?);
        }

        if !parallel_batch.is_empty() {
            executions.extend(
                self.dispatch_parallel_batch(router, &parallel_batch)
                    .await?,
            );
        }

        Ok(executions)
    }

    async fn dispatch_parallel_batch(
        &self,
        router: &ToolRouter,
        calls: &[ToolCall],
    ) -> CoreResult<Vec<crate::tools::ToolExecution>> {
        let ctx = ToolContext {
            host: &self.host,
            path_policy: &self.path_policy,
            config: &self.config,
        };
        let results = join_all(calls.iter().map(|call| router.dispatch(call, &ctx))).await;
        results.into_iter().collect()
    }

    async fn dispatch_one_tool(
        &self,
        router: &ToolRouter,
        call: &ToolCall,
    ) -> CoreResult<crate::tools::ToolExecution> {
        let ctx = ToolContext {
            host: &self.host,
            path_policy: &self.path_policy,
            config: &self.config,
        };
        router.dispatch(call, &ctx).await
    }

    async fn sample_with_retry(
        &mut self,
        runtime: &TurnRuntime<'_>,
        events: &mut Vec<EventMsg>,
        client_session: &mut ModelClientSession,
        trace: &mut AgentTrace,
        tool_outputs: &mut Vec<ToolOutputTrace>,
    ) -> CoreResult<SamplingOutput> {
        for attempt in 0..=self.config.max_sampling_retries {
            let prompt = self.build_prompt(runtime.router);
            trace.model_requests.push(prompt.clone());
            let output = self
                .run_sampling_request(
                    prompt,
                    events,
                    runtime.event_sink,
                    runtime.cancellation_token,
                    runtime.turn_id,
                    client_session,
                )
                .await?;

            if output.completed {
                return Ok(output);
            }

            self.dispatch_and_record_tool_calls(
                runtime.router,
                output.tool_calls,
                events,
                runtime.event_sink,
                tool_outputs,
            )
            .await?;

            if attempt < self.config.max_sampling_retries {
                emit(
                    events,
                    runtime.event_sink,
                    EventMsg::StreamError {
                        message: "model stream closed before response.completed".to_string(),
                        retry: attempt + 1,
                    },
                )?;
            } else {
                return Err(CoreError::StreamClosed);
            }
        }
        Err(CoreError::StreamClosed)
    }

    async fn run_sampling_request(
        &mut self,
        prompt: Prompt,
        events: &mut Vec<EventMsg>,
        event_sink: Option<&dyn TurnEventSink>,
        cancellation_token: &CancellationToken,
        turn_id: &str,
        client_session: &mut ModelClientSession,
    ) -> CoreResult<SamplingOutput> {
        let options = ModelRequestOptions {
            model: self.config.model.clone(),
            tool_choice: Some("auto".to_string()),
        };
        let mut stream = client_session.stream(&prompt, options).await?;
        let mut output = SamplingOutput::default();

        while let Some(event) = stream.next().await {
            self.check_cancelled(turn_id, events, event_sink, cancellation_token)?;
            match event? {
                ResponseEvent::ResponseCreated { .. } => {}
                ResponseEvent::OutputItemAdded { item } => {
                    emit(
                        events,
                        event_sink,
                        EventMsg::ItemStarted {
                            item_type: item_type(&item).to_string(),
                        },
                    )?;
                }
                ResponseEvent::OutputTextDelta { delta } => {
                    emit(
                        events,
                        event_sink,
                        EventMsg::AgentMessageContentDelta { delta },
                    )?;
                }
                ResponseEvent::ReasoningTextDelta { delta, .. }
                | ResponseEvent::ReasoningSummaryTextDelta { delta, .. } => {
                    emit(
                        events,
                        event_sink,
                        EventMsg::ReasoningContentDelta { delta },
                    )?;
                }
                ResponseEvent::OutputItemDone { item } => {
                    if let Some(call) = ToolCall::from_response_item(&item) {
                        output.tool_calls.push(call);
                    }
                    if let ResponseItem::Message { content, .. } = &item {
                        output.final_message = Some(output_text(content));
                    }
                    emit(
                        events,
                        event_sink,
                        EventMsg::ItemCompleted { item: item.clone() },
                    )?;
                    self.history.push_response(item);
                }
                ResponseEvent::ResponseCompleted { response } => {
                    output.needs_follow_up |= response.end_turn == Some(false);
                    output.completed = true;
                    break;
                }
                ResponseEvent::ToolCallInputDelta { .. } => {
                    // Upstream feeds these deltas into ToolArgumentDiffConsumer
                    // for progressive UI updates. The MVP wasm core records the
                    // completed tool call item only; final tool execution still
                    // follows OutputItemDone, preserving model-visible behavior.
                }
                ResponseEvent::ResponseFailed { error } => {
                    return Err(CoreError::Model(
                        error
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "response.failed".to_string()),
                    ));
                }
            }
        }

        Ok(output)
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let id = self.next_id;
        self.next_id += 1;
        format!("{prefix}-{id}")
    }

    fn check_cancelled(
        &self,
        turn_id: &str,
        events: &mut Vec<EventMsg>,
        event_sink: Option<&dyn TurnEventSink>,
        cancellation_token: &CancellationToken,
    ) -> CoreResult<()> {
        if !cancellation_token.is_cancelled() {
            return Ok(());
        }
        emit(
            events,
            event_sink,
            EventMsg::TurnCancelled {
                turn_id: turn_id.to_string(),
            },
        )?;
        Err(CoreError::Cancelled)
    }
}

#[derive(Debug, Default)]
struct SamplingOutput {
    tool_calls: Vec<ToolCall>,
    final_message: Option<String>,
    needs_follow_up: bool,
    completed: bool,
}

fn item_type(item: &ResponseItem) -> &'static str {
    match item {
        ResponseItem::Message { .. } => "message",
        ResponseItem::Reasoning { .. } => "reasoning",
        ResponseItem::FunctionCall { .. } => "function_call",
        ResponseItem::CustomToolCall { .. } => "custom_tool_call",
        ResponseItem::ToolSearchCall { .. } => "tool_search_call",
        ResponseItem::FunctionCallOutput { .. } => "function_call_output",
        ResponseItem::CustomToolCallOutput { .. } => "custom_tool_call_output",
        ResponseItem::ToolSearchOutput { .. } => "tool_search_output",
        ResponseItem::Other => "other",
    }
}

fn output_text(content: &[ContentItem]) -> String {
    content
        .iter()
        .filter_map(|item| match item {
            ContentItem::OutputText { text } | ContentItem::InputText { text } => {
                Some(text.as_str())
            }
            ContentItem::InputImage { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn emit(
    events: &mut Vec<EventMsg>,
    event_sink: Option<&dyn TurnEventSink>,
    event: EventMsg,
) -> CoreResult<()> {
    if let Some(event_sink) = event_sink {
        event_sink.on_event(&event)?;
    }
    events.push(event);
    Ok(())
}
