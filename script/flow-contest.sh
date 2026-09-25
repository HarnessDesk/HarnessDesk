#!/usr/bin/env bash
# Mechanical contest: decide between two isolated attempts by exit status
# alone, never an agent's own prose. `mechanical-contest.yml` is a *custom
# starting point* — CONTEST_CMD below is the one line a person is expected to
# replace with their own repository's real check; kept here as a working
# default so the shape runs unmodified.
#
# A check's own environment is a short, fixed allowlist (PATH, HOME and the
# like — see evidence/run.ts) and never carries a caller's variables, so
# CONTEST_CMD has to be edited in this file, not set outside it.
#
# Reads the two subjects' own checkouts from the bounded
# HARNESSDESK_FLOW_CONTEXT JSON (never an arbitrary environment map, and never
# $PWD — the aggregate command runs once in the Goal's own checkout, so each
# attempt's own worktree has to be named explicitly) and runs CONTEST_CMD in
# each.
#
# Exit 0: the first attempt alone passed — mechanical-contest.yml reads this
#         as `first`.
# Exit 1: the second attempt alone passed — reads as `second`.
# Exit 2: both passed — a draw a person breaks, reads as `draw`.
# Anything else (3, here): neither passed, or the context could not be read
#         — mechanical-contest.yml's `otherwise: no-contest`.
set -u

CONTEST_CMD="pnpm verify"

if [ -z "${HARNESSDESK_FLOW_CONTEXT:-}" ]; then
  echo "flow-contest: HARNESSDESK_FLOW_CONTEXT is not set" >&2
  exit 3
fi

read_cwd() {
  node -e '
    let context
    try { context = JSON.parse(process.env.HARNESSDESK_FLOW_CONTEXT || "") } catch { process.exit(1) }
    const subject = context && context.subjects && context.subjects[Number(process.argv[1])]
    if (!subject || typeof subject.cwd !== "string" || !subject.cwd) process.exit(1)
    process.stdout.write(subject.cwd)
  ' "$1"
}

first_cwd=$(read_cwd 0) || { echo "flow-contest: no first attempt in the context" >&2; exit 3; }
second_cwd=$(read_cwd 1) || { echo "flow-contest: no second attempt in the context" >&2; exit 3; }

passes() {
  (cd "$1" 2>/dev/null && eval "$CONTEST_CMD") >/dev/null 2>&1
}

first_ok=0
second_ok=0
passes "$first_cwd" && first_ok=1
passes "$second_cwd" && second_ok=1

if [ "$first_ok" = 1 ] && [ "$second_ok" = 1 ]; then
  exit 2
elif [ "$first_ok" = 1 ]; then
  exit 0
elif [ "$second_ok" = 1 ]; then
  exit 1
else
  exit 3
fi
