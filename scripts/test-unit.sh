#!/usr/bin/env bash
set -euo pipefail

cargo test -p codex-browser-core
cargo check -p codex-browser-core --target wasm32-unknown-unknown
