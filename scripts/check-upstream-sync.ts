import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { upstreamOracleSyncChecks } from "../tests/oracle/upstreamOracle";

const repoRoot = resolve(import.meta.dirname, "..");

const checks = [
  checkRawStringConst({
    localPath: "crates/codex-browser-core/src/tools/registry.rs",
    localConst: "APPLY_PATCH_GRAMMAR",
    upstreamPath:
      "external/codex/codex-rs/core/src/tools/handlers/apply_patch.lark",
    upstreamLabel:
      "external/codex/codex-rs/core/src/tools/handlers/apply_patch.lark",
  }),
  checkNumericConst({
    localPath: "crates/codex-browser-core/src/tools/exec.rs",
    localConst: "DEFAULT_MAX_OUTPUT_TOKENS",
    upstreamPath: "external/codex/codex-rs/core/src/unified_exec/mod.rs",
    upstreamConst: "DEFAULT_MAX_OUTPUT_TOKENS",
  }),
  checkNumericConst({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localConst: "APPROX_BYTES_PER_TOKEN",
    upstreamPath: "external/codex/codex-rs/utils/string/src/truncate.rs",
    upstreamConst: "APPROX_BYTES_PER_TOKEN",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "formatted_truncate_text",
    upstreamPath: "external/codex/codex-rs/utils/output-truncation/src/lib.rs",
    upstreamFn: "formatted_truncate_text",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "truncate_text",
    upstreamPath: "external/codex/codex-rs/utils/output-truncation/src/lib.rs",
    upstreamFn: "truncate_text",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "truncate_function_output_items_with_policy",
    upstreamPath: "external/codex/codex-rs/utils/output-truncation/src/lib.rs",
    upstreamFn: "truncate_function_output_items_with_policy",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "truncate_middle_chars",
    upstreamPath: "external/codex/codex-rs/utils/string/src/truncate.rs",
    upstreamFn: "truncate_middle_chars",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "truncate_middle_with_token_budget",
    upstreamPath: "external/codex/codex-rs/utils/string/src/truncate.rs",
    upstreamFn: "truncate_middle_with_token_budget",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "truncate_with_byte_estimate",
    upstreamPath: "external/codex/codex-rs/utils/string/src/truncate.rs",
    upstreamFn: "truncate_with_byte_estimate",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "split_string",
    upstreamPath: "external/codex/codex-rs/utils/string/src/truncate.rs",
    upstreamFn: "split_string",
  }),
  checkFunctionBody({
    localPath: "crates/codex-browser-core/src/output_truncation.rs",
    localFn: "format_truncation_marker",
    upstreamPath: "external/codex/codex-rs/utils/string/src/truncate.rs",
    upstreamFn: "format_truncation_marker",
  }),
  checkTsOracleTruncationGoldens(),
];

const failures = checks.filter((check) => !check.ok);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message);
  }
  process.exit(1);
}

console.log(`upstream sync checks passed (${checks.length})`);

type CheckResult = {
  ok: boolean;
  message: string;
};

function checkRawStringConst(input: {
  localPath: string;
  localConst: string;
  upstreamPath: string;
  upstreamLabel: string;
}): CheckResult {
  const local = read(input.localPath);
  const upstream = read(input.upstreamPath).trim();
  const localValue = rawStringConst(local, input.localConst).trim();
  if (localValue === upstream) {
    return { ok: true, message: "" };
  }
  return {
    ok: false,
    message: `${input.localConst} drifted from ${input.upstreamLabel}`,
  };
}

function checkNumericConst(input: {
  localPath: string;
  localConst: string;
  upstreamPath: string;
  upstreamConst: string;
}): CheckResult {
  const local = numericConst(read(input.localPath), input.localConst);
  const upstream = numericConst(read(input.upstreamPath), input.upstreamConst);
  if (local === upstream) {
    return { ok: true, message: "" };
  }
  return {
    ok: false,
    message: `${input.localConst}=${local} drifted from ${input.upstreamPath}::${input.upstreamConst}=${upstream}`,
  };
}

function checkFunctionBody(input: {
  localPath: string;
  localFn: string;
  upstreamPath: string;
  upstreamFn: string;
}): CheckResult {
  const local = normalizeRustBody(
    functionBody(read(input.localPath), input.localFn),
  );
  const upstream = normalizeRustBody(
    functionBody(read(input.upstreamPath), input.upstreamFn),
  );
  if (local === upstream) {
    return { ok: true, message: "" };
  }
  return {
    ok: false,
    message: `${input.localPath}::${input.localFn} drifted from ${input.upstreamPath}::${input.upstreamFn}`,
  };
}

function checkTsOracleTruncationGoldens(): CheckResult {
  const cases = [
    {
      content: "example output",
      maxTokens: 1,
      expected: "Total output lines: 1\n\nex…3 tokens truncated…ut",
    },
    {
      content:
        "this is an example of a long output that should be truncated\nalso some other line",
      maxTokens: 10,
      expected:
        "Total output lines: 2\n\nthis is an example o…11 tokens truncated…also some other line",
    },
  ];
  for (const current of cases) {
    const actual = upstreamOracleSyncChecks.formattedTruncateText(
      current.content,
      current.maxTokens,
    );
    if (actual !== current.expected) {
      return {
        ok: false,
        message: `tests/oracle/upstreamOracle.ts formattedTruncateText golden drift for maxTokens=${current.maxTokens}\nexpected: ${JSON.stringify(current.expected)}\nactual:   ${JSON.stringify(actual)}`,
      };
    }
  }
  return { ok: true, message: "" };
}

function rawStringConst(source: string, name: string) {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*:\\s*&str\\s*=\\s*r#"(.*?)"#;`, "s"),
  );
  if (match === null) {
    throw new Error(`missing raw string const ${name}`);
  }
  return match[1]!;
}

function numericConst(source: string, name: string) {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*:\\s*usize\\s*=\\s*([0-9_]+);`),
  );
  if (match === null) {
    throw new Error(`missing numeric const ${name}`);
  }
  return Number(match[1]!.replaceAll("_", ""));
}

function functionBody(source: string, name: string) {
  const signature = new RegExp(
    `(?:pub(?:\\([^)]*\\))?\\s+)?fn\\s+${name}\\s*\\(`,
  );
  const match = signature.exec(source);
  if (match === null) {
    throw new Error(`missing function ${name}`);
  }
  const open = source.indexOf("{", match.index);
  if (open === -1) {
    throw new Error(`missing function body for ${name}`);
  }

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unterminated function body for ${name}`);
}

function normalizeRustBody(body: string) {
  return body.replace(/\r\n/g, "\n").trim();
}

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}
