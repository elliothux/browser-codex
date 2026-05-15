// Mirrors upstream Codex model-visible history behavior from:
// external/codex/codex-rs/core/src/context_manager and
// external/codex/codex-rs/core/src/session/turn.rs::run_sampling_request.
// Divergence: this MVP keeps only the ordered Responses items needed for
// browser conformance cases; compaction, rollback, and persistence are outside
// this wasm core subset.

use serde::Deserialize;
use serde::Serialize;

use std::collections::HashSet;

use crate::models::{
    ContentItem, FunctionCallOutputBody, FunctionCallOutputContentItem, FunctionCallOutputPayload,
    PromptItem, ResponseInputItem, ResponseItem,
};

const IMAGE_CONTENT_OMITTED_PLACEHOLDER: &str =
    "image content omitted because you do not support image input";

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct History {
    items: Vec<ConversationItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationItem {
    Input { item: ResponseInputItem },
    Response { item: ResponseItem },
}

impl History {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_items(items: Vec<ConversationItem>) -> Self {
        Self { items }
    }

    pub fn push_input(&mut self, item: ResponseInputItem) {
        self.items.push(ConversationItem::Input { item });
    }

    pub fn push_response(&mut self, item: ResponseItem) {
        self.items.push(ConversationItem::Response { item });
    }

    pub fn items(&self) -> &[ConversationItem] {
        &self.items
    }

    pub fn into_items(self) -> Vec<ConversationItem> {
        self.items
    }

    pub fn for_prompt(&self) -> Vec<PromptItem> {
        self.for_prompt_with_output_limit(usize::MAX)
    }

    pub fn for_prompt_with_output_limit(&self, max_output_bytes: usize) -> Vec<PromptItem> {
        // Mirrors upstream Codex:
        // external/codex/codex-rs/core/src/context_manager/history.rs::for_prompt
        // and context_manager/normalize.rs::{ensure_call_outputs_present,remove_orphan_outputs,strip_images_when_unsupported}.
        // Divergence: this wasm core has no model-info modality registry yet, so
        // restored image content is normalized for a text-only model.
        let mut items = self
            .items
            .iter()
            .map(|item| match item {
                ConversationItem::Input { item } => PromptItem::Input(item.clone()),
                ConversationItem::Response { item } => PromptItem::Response(item.clone()),
            })
            .collect::<Vec<_>>();
        ensure_call_outputs_present(&mut items);
        remove_orphan_outputs(&mut items);
        strip_images_when_unsupported(&mut items);
        truncate_function_outputs(&mut items, max_output_bytes);
        items
    }
}

fn ensure_call_outputs_present(items: &mut Vec<PromptItem>) {
    let mut missing_outputs_to_insert = Vec::<(usize, PromptItem)>::new();
    for (idx, item) in items.iter().enumerate() {
        match item {
            PromptItem::Response(ResponseItem::FunctionCall { call_id, .. })
                if !has_function_output(items, call_id) =>
            {
                missing_outputs_to_insert.push((
                    idx,
                    PromptItem::Input(ResponseInputItem::FunctionCallOutput {
                        call_id: call_id.clone(),
                        output: FunctionCallOutputPayload::from_text("aborted", None),
                    }),
                ));
            }
            PromptItem::Response(ResponseItem::ToolSearchCall {
                call_id: Some(call_id),
                ..
            }) if !has_tool_search_output(items, call_id) => {
                missing_outputs_to_insert.push((
                    idx,
                    PromptItem::Input(ResponseInputItem::ToolSearchOutput {
                        call_id: call_id.clone(),
                        status: "completed".to_string(),
                        execution: "client".to_string(),
                        tools: Vec::new(),
                    }),
                ));
            }
            PromptItem::Response(ResponseItem::CustomToolCall { call_id, .. })
                if !has_custom_output(items, call_id) =>
            {
                missing_outputs_to_insert.push((
                    idx,
                    PromptItem::Input(ResponseInputItem::CustomToolCallOutput {
                        call_id: call_id.clone(),
                        name: None,
                        output: FunctionCallOutputPayload::from_text("aborted", None),
                    }),
                ));
            }
            _ => {}
        }
    }

    for (idx, output_item) in missing_outputs_to_insert.into_iter().rev() {
        items.insert(idx + 1, output_item);
    }
}

fn remove_orphan_outputs(items: &mut Vec<PromptItem>) {
    let function_call_ids = items
        .iter()
        .filter_map(function_call_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let custom_tool_call_ids = items
        .iter()
        .filter_map(custom_tool_call_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let tool_search_call_ids = items
        .iter()
        .filter_map(tool_search_call_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();

    items.retain(|item| match item {
        PromptItem::Input(ResponseInputItem::FunctionCallOutput { call_id, .. })
        | PromptItem::Response(ResponseItem::FunctionCallOutput { call_id, .. }) => {
            function_call_ids.contains(call_id)
        }
        PromptItem::Input(ResponseInputItem::CustomToolCallOutput { call_id, .. })
        | PromptItem::Response(ResponseItem::CustomToolCallOutput { call_id, .. }) => {
            custom_tool_call_ids.contains(call_id)
        }
        PromptItem::Input(ResponseInputItem::ToolSearchOutput { call_id, .. }) => {
            tool_search_call_ids.contains(call_id)
        }
        PromptItem::Response(ResponseItem::ToolSearchOutput { execution, .. })
            if execution == "server" =>
        {
            true
        }
        PromptItem::Response(ResponseItem::ToolSearchOutput {
            call_id: Some(call_id),
            ..
        }) => tool_search_call_ids.contains(call_id),
        PromptItem::Response(ResponseItem::ToolSearchOutput { call_id: None, .. }) => true,
        _ => true,
    });
}

fn strip_images_when_unsupported(items: &mut [PromptItem]) {
    for item in items {
        match item {
            PromptItem::Input(ResponseInputItem::Message { content, .. })
            | PromptItem::Response(ResponseItem::Message { content, .. }) => {
                for content_item in content {
                    if matches!(content_item, ContentItem::InputImage { .. }) {
                        *content_item = ContentItem::InputText {
                            text: IMAGE_CONTENT_OMITTED_PLACEHOLDER.to_string(),
                        };
                    }
                }
            }
            PromptItem::Input(ResponseInputItem::FunctionCallOutput { output, .. })
            | PromptItem::Input(ResponseInputItem::CustomToolCallOutput { output, .. })
            | PromptItem::Response(ResponseItem::FunctionCallOutput { output, .. })
            | PromptItem::Response(ResponseItem::CustomToolCallOutput { output, .. }) => {
                replace_output_images(output);
            }
            _ => {}
        }
    }
}

fn truncate_function_outputs(items: &mut [PromptItem], max_output_bytes: usize) {
    if max_output_bytes == usize::MAX {
        return;
    }
    for item in items {
        match item {
            PromptItem::Input(ResponseInputItem::FunctionCallOutput { output, .. })
            | PromptItem::Input(ResponseInputItem::CustomToolCallOutput { output, .. })
            | PromptItem::Response(ResponseItem::FunctionCallOutput { output, .. })
            | PromptItem::Response(ResponseItem::CustomToolCallOutput { output, .. }) => {
                truncate_output_payload(output, max_output_bytes);
            }
            _ => {}
        }
    }
}

fn replace_output_images(output: &mut FunctionCallOutputPayload) {
    if let FunctionCallOutputBody::ContentItems(items) = &mut output.body {
        for item in items {
            if matches!(item, FunctionCallOutputContentItem::InputImage { .. }) {
                *item = FunctionCallOutputContentItem::InputText {
                    text: IMAGE_CONTENT_OMITTED_PLACEHOLDER.to_string(),
                };
            }
        }
    }
}

fn truncate_output_payload(output: &mut FunctionCallOutputPayload, max_output_bytes: usize) {
    match &mut output.body {
        FunctionCallOutputBody::Text(text) => {
            truncate_text_in_place(text, max_output_bytes);
        }
        FunctionCallOutputBody::ContentItems(items) => {
            for item in items {
                if let FunctionCallOutputContentItem::InputText { text } = item {
                    truncate_text_in_place(text, max_output_bytes);
                }
            }
        }
    }
}

fn truncate_text_in_place(text: &mut String, max_output_bytes: usize) {
    if text.len() <= max_output_bytes {
        return;
    }
    let mut end = max_output_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n[... output truncated ...]");
}

fn function_call_id(item: &PromptItem) -> Option<&str> {
    match item {
        PromptItem::Response(ResponseItem::FunctionCall { call_id, .. }) => Some(call_id),
        _ => None,
    }
}

fn custom_tool_call_id(item: &PromptItem) -> Option<&str> {
    match item {
        PromptItem::Response(ResponseItem::CustomToolCall { call_id, .. }) => Some(call_id),
        _ => None,
    }
}

fn tool_search_call_id(item: &PromptItem) -> Option<&str> {
    match item {
        PromptItem::Response(ResponseItem::ToolSearchCall {
            call_id: Some(call_id),
            ..
        }) => Some(call_id),
        _ => None,
    }
}

fn has_function_output(items: &[PromptItem], call_id: &str) -> bool {
    items.iter().any(|item| match item {
        PromptItem::Input(ResponseInputItem::FunctionCallOutput {
            call_id: existing, ..
        })
        | PromptItem::Response(ResponseItem::FunctionCallOutput {
            call_id: existing, ..
        }) => existing == call_id,
        _ => false,
    })
}

fn has_custom_output(items: &[PromptItem], call_id: &str) -> bool {
    items.iter().any(|item| match item {
        PromptItem::Input(ResponseInputItem::CustomToolCallOutput {
            call_id: existing, ..
        })
        | PromptItem::Response(ResponseItem::CustomToolCallOutput {
            call_id: existing, ..
        }) => existing == call_id,
        _ => false,
    })
}

fn has_tool_search_output(items: &[PromptItem], call_id: &str) -> bool {
    items.iter().any(|item| match item {
        PromptItem::Input(ResponseInputItem::ToolSearchOutput {
            call_id: existing, ..
        }) => existing == call_id,
        PromptItem::Response(ResponseItem::ToolSearchOutput {
            call_id: Some(existing),
            ..
        }) => existing == call_id,
        _ => false,
    })
}
