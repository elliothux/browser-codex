#!/usr/bin/env bash
set -euo pipefail

(
  cd crates/codex-browser-core
  wasm-pack build --target web --out-dir ../../pkg/codex-browser-core
)
bun run web:wasm
if [ ! -d node_modules/@playwright/test ]; then
  bun install --frozen-lockfile
fi
bunx playwright test tests/wasm "$@"
