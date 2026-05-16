// Upstream: external/codex/codex-rs/apply-patch/src/parser.rs and
// external/codex/codex-rs/apply-patch/src/seek_sequence.rs, trimmed to the
// wasm core's host filesystem boundary.

use std::fmt;

use serde::Serialize;

use crate::approval::ApplyPatchApprovalRequest;
use crate::errors::{CoreError, CoreResult};
use crate::events::EventMsg;

use super::registry::{ToolCall, ToolContext, ToolExecution, ToolPayload, error_output, execution};

const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
const END_PATCH_MARKER: &str = "*** End Patch";
const ADD_FILE_MARKER: &str = "*** Add File: ";
const DELETE_FILE_MARKER: &str = "*** Delete File: ";
const UPDATE_FILE_MARKER: &str = "*** Update File: ";
const MOVE_TO_MARKER: &str = "*** Move to: ";
const ENVIRONMENT_ID_MARKER: &str = "*** Environment ID: ";
const EOF_MARKER: &str = "*** End of File";
const CHANGE_CONTEXT_MARKER: &str = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    InvalidPatchError(String),
    InvalidHunkError { message: String, line_number: usize },
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPatchError(message) => write!(f, "invalid patch: {message}"),
            Self::InvalidHunkError {
                message,
                line_number,
            } => write!(f, "invalid hunk at line {line_number}, {message}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPatchArgs {
    pub patch: String,
    pub environment_id: Option<String>,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hunk {
    AddFile {
        path: String,
        contents: String,
    },
    DeleteFile {
        path: String,
    },
    UpdateFile {
        path: String,
        move_path: Option<String>,
        chunks: Vec<UpdateFileChunk>,
    },
}

impl Hunk {
    fn display_path(&self) -> &str {
        match self {
            Self::AddFile { path, .. } | Self::DeleteFile { path } => path,
            Self::UpdateFile {
                path,
                move_path: None,
                ..
            } => path,
            Self::UpdateFile {
                move_path: Some(path),
                ..
            } => path,
        }
    }

    fn source_path(&self) -> &str {
        match self {
            Self::AddFile { path, .. }
            | Self::DeleteFile { path }
            | Self::UpdateFile { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateFileChunk {
    pub change_context: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub is_end_of_file: bool,
}

#[derive(Debug, Default, Serialize)]
struct AffectedPaths {
    added: Vec<String>,
    modified: Vec<String>,
    deleted: Vec<String>,
}

pub async fn apply_patch_tool(call: &ToolCall, ctx: &ToolContext<'_>) -> CoreResult<ToolExecution> {
    // Mirrors upstream Codex:
    // external/codex/codex-rs/core/src/tools/handlers/apply_patch.rs::ApplyPatchHandler::handle.
    // Divergence: `codex-apply-patch` currently pulls native Tokio/mio through
    // `codex-exec-server`, so this crate keeps a wasm-local raw-copy parser and
    // applies hunks through `HostFileSystem`.
    let ToolPayload::Custom { input } = &call.payload else {
        return Ok(error_output(
            call,
            "apply_patch handler received unsupported payload",
            false,
        ));
    };
    let input = input.as_str();

    let args = match parse_patch(input) {
        Ok(args) => args,
        Err(error) => {
            return Ok(error_output(
                call,
                format!("apply_patch verification failed: {error}"),
                false,
            ));
        }
    };
    if args.environment_id.is_some() {
        return Ok(error_output(
            call,
            "apply_patch environment selection is unavailable for this turn",
            false,
        ));
    }

    let mut affected_absolute = Vec::new();
    for hunk in &args.hunks {
        affected_absolute.push(
            ctx.path_policy
                .resolve(hunk.source_path())
                .map_err(|error| CoreError::Tool(error.to_string()))?
                .absolute,
        );
        if let Hunk::UpdateFile {
            move_path: Some(move_path),
            ..
        } = hunk
        {
            affected_absolute.push(
                ctx.path_policy
                    .resolve(move_path)
                    .map_err(|error| CoreError::Tool(error.to_string()))?
                    .absolute,
            );
        }
    }
    affected_absolute.sort();
    affected_absolute.dedup();

    let mut events = vec![EventMsg::PatchApplyBegin {
        call_id: call.call_id.clone(),
    }];

    if ctx.config.require_patch_approval {
        let request = ApplyPatchApprovalRequest {
            call_id: call.call_id.clone(),
            workdir: ctx.path_policy.root().to_string(),
            affected_paths: affected_absolute,
        };
        events.push(EventMsg::ApplyPatchApprovalRequest {
            request: request.clone(),
        });
        let decision = ctx.host.approvals.approve_patch(request).await;
        if !decision.approved {
            let reason = decision
                .reason
                .unwrap_or_else(|| "patch denied".to_string());
            events.push(EventMsg::PatchApplyEnd {
                call_id: call.call_id.clone(),
                success: false,
            });
            return Ok(execution(
                call,
                format!("apply_patch denied by approval policy: {reason}"),
                Some(false),
                events,
            ));
        }
    }

    match apply_hunks(&args.hunks, ctx).await {
        Ok(summary) => {
            events.push(EventMsg::TurnDiff {
                unified_diff: args.patch,
            });
            events.push(EventMsg::PatchApplyEnd {
                call_id: call.call_id.clone(),
                success: true,
            });
            Ok(execution(
                call,
                format_success_output(&print_summary(&summary)),
                Some(true),
                events,
            ))
        }
        Err(error) => {
            events.push(EventMsg::PatchApplyEnd {
                call_id: call.call_id.clone(),
                success: false,
            });
            Ok(execution(call, error.to_string(), Some(false), events))
        }
    }
}

pub fn parse_patch(patch: &str) -> Result<ApplyPatchArgs, ParseError> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    let (patch_lines, hunk_lines) = check_patch_boundaries_lenient(&lines)?;
    let (environment_id, mut remaining_lines, mut line_number) =
        parse_environment_id_preamble(hunk_lines)?;
    let mut hunks = Vec::new();
    while !remaining_lines.is_empty() {
        let (hunk, hunk_lines) = parse_one_hunk(remaining_lines, line_number)?;
        hunks.push(hunk);
        line_number += hunk_lines;
        remaining_lines = &remaining_lines[hunk_lines..];
    }
    Ok(ApplyPatchArgs {
        patch: patch_lines.join("\n"),
        environment_id,
        hunks,
    })
}

fn parse_environment_id_preamble<'a>(
    hunk_lines: &'a [&'a str],
) -> Result<(Option<String>, &'a [&'a str], usize), ParseError> {
    let Some(first_line) = hunk_lines.first() else {
        return Ok((None, hunk_lines, 2));
    };
    let Some(environment_id) = first_line.trim_start().strip_prefix(ENVIRONMENT_ID_MARKER) else {
        return Ok((None, hunk_lines, 2));
    };
    let environment_id = environment_id.trim();
    if environment_id.is_empty() {
        return Err(ParseError::InvalidPatchError(
            "apply_patch environment_id cannot be empty".to_string(),
        ));
    }
    Ok((Some(environment_id.to_string()), &hunk_lines[1..], 3))
}

fn check_patch_boundaries_lenient<'a>(
    original_lines: &'a [&'a str],
) -> Result<(&'a [&'a str], &'a [&'a str]), ParseError> {
    let original_parse_error = match check_patch_boundaries_strict(original_lines) {
        Ok(lines) => return Ok(lines),
        Err(error) => error,
    };

    match original_lines {
        [first, .., last]
            if matches!(*first, "<<EOF" | "<<'EOF'" | "<<\"EOF\"")
                && last.ends_with("EOF")
                && original_lines.len() >= 4 =>
        {
            let inner_lines = &original_lines[1..original_lines.len() - 1];
            check_patch_boundaries_strict(inner_lines)
        }
        _ => Err(original_parse_error),
    }
}

fn check_patch_boundaries_strict<'a>(
    lines: &'a [&'a str],
) -> Result<(&'a [&'a str], &'a [&'a str]), ParseError> {
    let (first_line, last_line) = match lines {
        [] => (None, None),
        [first] => (Some(first), Some(first)),
        [first, .., last] => (Some(first), Some(last)),
    };
    check_start_and_end_lines_strict(first_line, last_line)?;
    Ok((lines, &lines[1..lines.len() - 1]))
}

fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError> {
    let first_line = first_line.map(|line| line.trim());
    let last_line = last_line.map(|line| line.trim());

    match (first_line, last_line) {
        (Some(first), Some(last)) if first == BEGIN_PATCH_MARKER && last == END_PATCH_MARKER => {
            Ok(())
        }
        (Some(first), _) if first != BEGIN_PATCH_MARKER => Err(ParseError::InvalidPatchError(
            "The first line of the patch must be '*** Begin Patch'".to_string(),
        )),
        _ => Err(ParseError::InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string(),
        )),
    }
}

fn parse_one_hunk(lines: &[&str], line_number: usize) -> Result<(Hunk, usize), ParseError> {
    let first_line = lines[0].trim();
    if let Some(path) = first_line.strip_prefix(ADD_FILE_MARKER) {
        let mut contents = String::new();
        let mut parsed_lines = 1;
        for add_line in &lines[1..] {
            if let Some(line_to_add) = add_line.strip_prefix('+') {
                contents.push_str(line_to_add);
                contents.push('\n');
                parsed_lines += 1;
            } else {
                break;
            }
        }
        Ok((
            Hunk::AddFile {
                path: path.to_string(),
                contents,
            },
            parsed_lines,
        ))
    } else if let Some(path) = first_line.strip_prefix(DELETE_FILE_MARKER) {
        Ok((
            Hunk::DeleteFile {
                path: path.to_string(),
            },
            1,
        ))
    } else if let Some(path) = first_line.strip_prefix(UPDATE_FILE_MARKER) {
        let mut remaining_lines = &lines[1..];
        let mut parsed_lines = 1;
        let move_path = remaining_lines
            .first()
            .and_then(|line| line.strip_prefix(MOVE_TO_MARKER));

        if move_path.is_some() {
            remaining_lines = &remaining_lines[1..];
            parsed_lines += 1;
        }

        let mut chunks = Vec::new();
        while !remaining_lines.is_empty() {
            if remaining_lines[0].trim().is_empty() {
                parsed_lines += 1;
                remaining_lines = &remaining_lines[1..];
                continue;
            }
            if remaining_lines[0].starts_with('*') {
                break;
            }
            let (chunk, chunk_lines) = parse_update_file_chunk(
                remaining_lines,
                line_number + parsed_lines,
                chunks.is_empty(),
            )?;
            chunks.push(chunk);
            parsed_lines += chunk_lines;
            remaining_lines = &remaining_lines[chunk_lines..];
        }

        if chunks.is_empty() {
            return Err(ParseError::InvalidHunkError {
                message: format!("Update file hunk for path '{path}' is empty"),
                line_number,
            });
        }

        Ok((
            Hunk::UpdateFile {
                path: path.to_string(),
                move_path: move_path.map(str::to_string),
                chunks,
            },
            parsed_lines,
        ))
    } else {
        Err(ParseError::InvalidHunkError {
            message: format!(
                "'{first_line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
            ),
            line_number,
        })
    }
}

fn parse_update_file_chunk(
    lines: &[&str],
    line_number: usize,
    allow_missing_context: bool,
) -> Result<(UpdateFileChunk, usize), ParseError> {
    if lines.is_empty() {
        return Err(ParseError::InvalidHunkError {
            message: "Update hunk does not contain any lines".to_string(),
            line_number,
        });
    }
    let (change_context, start_index) = if lines[0] == EMPTY_CHANGE_CONTEXT_MARKER {
        (None, 1)
    } else if let Some(context) = lines[0].strip_prefix(CHANGE_CONTEXT_MARKER) {
        (Some(context.to_string()), 1)
    } else if allow_missing_context {
        (None, 0)
    } else {
        return Err(ParseError::InvalidHunkError {
            message: format!(
                "Expected update hunk to start with a @@ context marker, got: '{}'",
                lines[0]
            ),
            line_number,
        });
    };

    if start_index >= lines.len() {
        return Err(ParseError::InvalidHunkError {
            message: "Update hunk does not contain any lines".to_string(),
            line_number: line_number + 1,
        });
    }

    let mut chunk = UpdateFileChunk {
        change_context,
        old_lines: Vec::new(),
        new_lines: Vec::new(),
        is_end_of_file: false,
    };
    let mut parsed_lines = 0;
    for line in &lines[start_index..] {
        match *line {
            EOF_MARKER => {
                if parsed_lines == 0 {
                    return Err(ParseError::InvalidHunkError {
                        message: "Update hunk does not contain any lines".to_string(),
                        line_number: line_number + 1,
                    });
                }
                chunk.is_end_of_file = true;
                parsed_lines += 1;
                break;
            }
            line_contents => match line_contents.chars().next() {
                None => {
                    chunk.old_lines.push(String::new());
                    chunk.new_lines.push(String::new());
                    parsed_lines += 1;
                }
                Some(' ') => {
                    chunk.old_lines.push(line_contents[1..].to_string());
                    chunk.new_lines.push(line_contents[1..].to_string());
                    parsed_lines += 1;
                }
                Some('+') => {
                    chunk.new_lines.push(line_contents[1..].to_string());
                    parsed_lines += 1;
                }
                Some('-') => {
                    chunk.old_lines.push(line_contents[1..].to_string());
                    parsed_lines += 1;
                }
                _ => {
                    if parsed_lines == 0 {
                        return Err(ParseError::InvalidHunkError {
                            message: format!(
                                "Unexpected line found in update hunk: '{line_contents}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                            ),
                            line_number: line_number + 1,
                        });
                    }
                    break;
                }
            },
        }
    }

    Ok((chunk, parsed_lines + start_index))
}

async fn apply_hunks(hunks: &[Hunk], ctx: &ToolContext<'_>) -> CoreResult<AffectedPaths> {
    if hunks.is_empty() {
        return Err(CoreError::Tool("No files were modified.".to_string()));
    }

    let mut affected = AffectedPaths::default();
    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let resolved = ctx.path_policy.resolve(path)?;
                mkdir_parent(&resolved.absolute, ctx).await;
                ctx.host
                    .fs
                    .write_file(&resolved.absolute, contents.clone().into_bytes())
                    .await?;
                affected.added.push(hunk.display_path().to_string());
            }
            Hunk::DeleteFile { path } => {
                let resolved = ctx.path_policy.resolve(path)?;
                ctx.host.fs.remove(&resolved.absolute, false, false).await?;
                affected.deleted.push(hunk.display_path().to_string());
            }
            Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            } => {
                let source = ctx.path_policy.resolve(path)?;
                let old = ctx.host.fs.read_file(&source.absolute).await?;
                let old = String::from_utf8(old).map_err(|_| {
                    CoreError::Tool(format!("{} is not valid UTF-8", source.absolute))
                })?;
                let new = apply_update_chunks(path, &old, chunks)?;
                if let Some(move_path) = move_path {
                    let dest = ctx.path_policy.resolve(move_path)?;
                    mkdir_parent(&dest.absolute, ctx).await;
                    ctx.host
                        .fs
                        .write_file(&dest.absolute, new.into_bytes())
                        .await?;
                    ctx.host.fs.remove(&source.absolute, false, false).await?;
                } else {
                    ctx.host
                        .fs
                        .write_file(&source.absolute, new.into_bytes())
                        .await?;
                }
                affected.modified.push(hunk.display_path().to_string());
            }
        }
    }
    Ok(affected)
}

fn apply_update_chunks(path: &str, source: &str, chunks: &[UpdateFileChunk]) -> CoreResult<String> {
    let lines = split_lines(source);
    let replacements = compute_replacements(&lines, path, chunks)?;
    let new_lines = apply_replacements(lines, &replacements);
    Ok(join_lines(&new_lines))
}

fn compute_replacements(
    original_lines: &[String],
    path: &str,
    chunks: &[UpdateFileChunk],
) -> CoreResult<Vec<(usize, usize, Vec<String>)>> {
    // Copied from upstream Codex:
    // external/codex/codex-rs/apply-patch/src/lib.rs::compute_replacements.
    // Divergence: errors are converted into CoreError for the wasm-local
    // HostFileSystem adapter; matching/replacement semantics stay aligned.
    let mut replacements = Vec::new();
    let mut line_index = 0;
    for chunk in chunks {
        if let Some(context) = &chunk.change_context {
            match seek_sequence(
                original_lines,
                std::slice::from_ref(context),
                line_index,
                false,
            ) {
                Some(index) => line_index = index + 1,
                None => {
                    return Err(CoreError::Tool(format!(
                        "Failed to find context '{context}' in {path}"
                    )));
                }
            }
        }

        if chunk.old_lines.is_empty() {
            let insertion_index = if original_lines.last().is_some_and(String::is_empty) {
                original_lines.len() - 1
            } else {
                original_lines.len()
            };
            replacements.push((insertion_index, 0, chunk.new_lines.clone()));
            continue;
        }

        let mut pattern = chunk.old_lines.as_slice();
        let mut found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        let mut new_slice = chunk.new_lines.as_slice();

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
            found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        }

        if let Some(start_index) = found {
            replacements.push((start_index, pattern.len(), new_slice.to_vec()));
            line_index = start_index + pattern.len();
        } else {
            return Err(CoreError::Tool(format!(
                "Failed to find expected lines in {path}:\n{}",
                chunk.old_lines.join("\n")
            )));
        }
    }
    replacements.sort_by_key(|(index, _, _)| *index);
    Ok(replacements)
}

fn apply_replacements(
    mut lines: Vec<String>,
    replacements: &[(usize, usize, Vec<String>)],
) -> Vec<String> {
    // Copied from upstream Codex:
    // external/codex/codex-rs/apply-patch/src/lib.rs::apply_replacements.
    for (start_index, old_len, new_segment) in replacements.iter().rev() {
        for _ in 0..*old_len {
            if *start_index < lines.len() {
                lines.remove(*start_index);
            }
        }
        for (offset, new_line) in new_segment.iter().enumerate() {
            lines.insert(*start_index + offset, new_line.clone());
        }
    }
    lines
}

fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.strip_suffix('\n')
            .unwrap_or(text)
            .split('\n')
            .map(str::to_string)
            .collect()
    }
}

fn join_lines(lines: &[String]) -> String {
    let mut lines = lines.to_vec();
    if !lines.last().is_some_and(String::is_empty) {
        lines.push(String::new());
    }
    lines.join("\n")
}

fn seek_sequence(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    // Copied from upstream Codex:
    // external/codex/codex-rs/apply-patch/src/seek_sequence.rs::seek_sequence.
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }
    let search_start = if eof && lines.len() >= pattern.len() {
        lines.len() - pattern.len()
    } else {
        start
    };
    for i in search_start..=lines.len().saturating_sub(pattern.len()) {
        if lines[i..i + pattern.len()] == *pattern {
            return Some(i);
        }
    }
    for i in search_start..=lines.len().saturating_sub(pattern.len()) {
        if pattern
            .iter()
            .enumerate()
            .all(|(offset, pat)| lines[i + offset].trim_end() == pat.trim_end())
        {
            return Some(i);
        }
    }
    for i in search_start..=lines.len().saturating_sub(pattern.len()) {
        if pattern
            .iter()
            .enumerate()
            .all(|(offset, pat)| lines[i + offset].trim() == pat.trim())
        {
            return Some(i);
        }
    }
    fn normalize(s: &str) -> String {
        s.trim()
            .chars()
            .map(|c| match c {
                '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
                | '\u{2212}' => '-',
                '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
                '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
                '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
                | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
                | '\u{3000}' => ' ',
                other => other,
            })
            .collect()
    }
    (search_start..=lines.len().saturating_sub(pattern.len())).find(|&i| {
        pattern
            .iter()
            .enumerate()
            .all(|(offset, pat)| normalize(&lines[i + offset]) == normalize(pat))
    })
}

async fn mkdir_parent(path: &str, ctx: &ToolContext<'_>) {
    if let Some((parent, _)) = path.rsplit_once('/')
        && !parent.is_empty()
        && parent != ctx.path_policy.root()
    {
        let _ = ctx.host.fs.mkdir(parent, true).await;
    }
}

fn print_summary(affected: &AffectedPaths) -> String {
    let mut out = String::from("Success. Updated the following files:\n");
    for path in &affected.added {
        out.push_str(&format!("A {path}\n"));
    }
    for path in &affected.modified {
        out.push_str(&format!("M {path}\n"));
    }
    for path in &affected.deleted {
        out.push_str(&format!("D {path}\n"));
    }
    out
}

fn format_success_output(summary: &str) -> String {
    // Mirrors upstream Codex:
    // external/codex/codex-rs/core/src/tools/handlers/apply_patch.rs::intercept_apply_patch
    // returns freeform apply_patch success through ApplyPatchRuntime unified exec
    // output. Divergence: the wasm host applies patches in-process, so the wall
    // time is a deterministic placeholder normalized by conformance tests.
    format!("Exit code: 0\nWall time: 0.0000 seconds\nOutput:\n{summary}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_add_update_delete() {
        let patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** Update File: b.txt\n@@\n-old\n+new\n*** Delete File: c.txt\n*** End Patch";
        let parsed = parse_patch(patch).unwrap();
        assert_eq!(parsed.hunks.len(), 3);
    }

    #[test]
    fn applies_update_chunk() {
        let chunks = vec![UpdateFileChunk {
            change_context: None,
            old_lines: vec!["old".to_string()],
            new_lines: vec!["new".to_string()],
            is_end_of_file: false,
        }];
        assert_eq!(
            apply_update_chunks("file.txt", "old\n", &chunks).unwrap(),
            "new\n"
        );
    }
}
