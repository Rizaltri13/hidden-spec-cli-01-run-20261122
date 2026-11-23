# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rizaltri13/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rizaltri13/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

A make.fun bounty entry for
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
one command-line tool that applies AI-written edits in four formats to a tree
of text files, to one written specification.

## What it does

Models write edits in four formats, and each public applier reads one of
them. `mend` reads all four — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to
one specification (`SPEC.md` in the competition kit), finds the lines an edit
names even when the model drifted their whitespace or indentation, and
changes every file or none (atomic: a failed edit changes nothing, and the
edits after it still run so every failure is reported).

Matching runs at the first of three tiers at which the old lines occur:
exact, trailing whitespace ignored, then leading and trailing whitespace
ignored (with re-indentation of the new lines at the third tier).
`--strict` matches exactly only. `--check` reports what would change
without writing anything.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or `-` / absent for standard input.
`--format` is `auto` (the default, detected from the text), `unified`,
`search-replace`, `v4a` or `json`.

Exit codes: `0` with one line per changed path (`A`/`D`/`M`/`R`) and an
`ok: <n> files` summary; `1` with one `error: <code> <path>` line per
failed edit and a `failed: <k> of <n> edits` summary (nothing is written);
`2` with exactly one line for a usage, missing-patch, format or parse
problem.

## The program

`main.ts` (Node 22, standard library only; nothing is installed before it
runs) is the CLI. `runner.ts` is the kit's trial runner, kept as it is: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

Deterministic: the same check gives the same exit code, stdout and files
every run; no times or randomness reach the output.

## Practice score

100 of 100 practice checks pass (`node check.ts <practice.json>` from the
kit), and 96 of 96 extra edge-case checks written from the sentences of
`SPEC.md` pass, each run twice with identical results.
