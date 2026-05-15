//! Wasm-safe model client boundary mirroring upstream Codex's
//! `ModelClient` / `ModelClientSession` split.

use std::pin::Pin;
use std::rc::Rc;

use async_trait::async_trait;
use futures::Stream;

use crate::errors::CoreResult;
use crate::models::{ModelRequestOptions, Prompt, ResponseEvent};

pub type ResponseStream = Pin<Box<dyn Stream<Item = CoreResult<ResponseEvent>>>>;

#[async_trait(?Send)]
pub trait ModelTransport {
    async fn stream(
        &self,
        prompt: Prompt,
        options: ModelRequestOptions,
    ) -> CoreResult<ResponseStream>;
}

#[derive(Clone)]
pub struct ModelClient {
    transport: Rc<dyn ModelTransport>,
}

impl ModelClient {
    pub fn new(transport: Rc<dyn ModelTransport>) -> Self {
        Self { transport }
    }

    pub fn new_session(&self) -> ModelClientSession {
        ModelClientSession {
            client: self.clone(),
        }
    }
}

pub struct ModelClientSession {
    client: ModelClient,
}

impl ModelClientSession {
    pub async fn stream(
        &mut self,
        prompt: &Prompt,
        options: ModelRequestOptions,
    ) -> CoreResult<ResponseStream> {
        self.client.transport.stream(prompt.clone(), options).await
    }
}
