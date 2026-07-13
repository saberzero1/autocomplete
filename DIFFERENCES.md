# Differences from upstream codemirror/autocomplete

This document tracks all modifications made to this fork compared to
[codemirror/autocomplete](https://code.haverbeke.berlin/codemirror/autocomplete).

Upstream base: commit `75a3b6a` (post-v6.20.3, HEAD of `main` as of 2026-07-13).

## Changes

### `src/snippet.ts`

**Recursive descent snippet parser** — Replaced the regex-based `Snippet.parse()` with a character-by-character recursive descent parser that handles the full LSP snippet syntax:

- **Choice nodes** (`${1|choice1,choice2,choice3|}`): Parsed and stored. The first choice is used as default text. All choices are stored in a `SnippetChoices` map (keyed by field index) and accessible on `ActiveSnippet.choices` for UI consumers.
- **Nested placeholders** (`${1:outer ${2:inner}}`): Recursive parsing of placeholder content allows arbitrarily nested fields. Inner fields become independent tabstops with correct ordering.
- **Transform syntax** (`${1/regex/format/flags}`): Parsed and skipped without error. The transform syntax is consumed correctly so it doesn't break the parser, but transforms are not applied at runtime (placeholder is treated as a plain tabstop).
- **Bare tabstops** (`$1`, `$2`): Supported in addition to the braced `${1}` form.
- **Backward compatible**: Simple templates (`${1:default}`, linked mirrors, `$0` final position) produce identical output to the upstream regex parser.

**Choice cycling** — Added `cycleSnippetChoice(dir: 1 | -1): StateCommand` that cycles through choice options for the active snippet field. When the cursor is on a choice field, this command replaces the current text with the next/previous option from the choices list, wrapping around at the boundaries.

**Exported `snippetState`** — The `snippetState` StateField is now exported (was internal-only in upstream) so consumers can check for active snippet status.

**New types**:
- `SnippetChoices`: `Record<number, string[]>` mapping field indices to choice options.
- `activeSnippetChoices`: Module-level variable that preserves choices across `ActiveSnippet` reconstructions (e.g. during `map()` on document changes).

### `src/index.ts`

Added exports:
- `snippetState` (StateField)
- `cycleSnippetChoice` (StateCommand factory)
- `FieldRange` (class — for external range manipulation in dynamic snippets)
- `ActiveSnippet` (class — for type-checking and constructing snippet state)
- `setActive` (StateEffect — for dispatching snippet state changes from ViewPlugins)
- `fieldSelection` (function — for creating cursor selections from field ranges)
