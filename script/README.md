# `script/`

Everything here is plain Node with no build step — run any of it with
`node script/<name>.mjs`. Several take `--help`-ish flags documented in their
own header comment, which is the authority; this page exists so you know they
are here at all.

## The gate

`pnpm verify` is the pre-commit gate and CI runs the same list — that equality
is itself checked, by the last row.

| | |
| --- | --- |
| [`verify.mjs`](verify.mjs) | Typecheck, tests, and every check below. **Run it unpiped** — through a pipe the exit code is the pipe's, not the gate's. |
| [`check-layering.mjs`](check-layering.mjs) | The layering rules: what may import what. |
| [`check-secrets.mjs`](check-secrets.mjs) | No secret may be tracked by git. |
| [`check-notices.mjs`](check-notices.mjs) | Every licence `THIRD_PARTY_NOTICES.md` claims is the licence that shipped. |
| [`check-claims.mjs`](check-claims.mjs) | Every recorded claim still names a test that exists. |
| [`check-design-tokens.mjs`](check-design-tokens.mjs) | The token layer still resolves to the values it resolved to last time. |
| [`check-interface-drift.mjs`](check-interface-drift.mjs) | Desk must be the app, to the pixel. |
| [`design-audit.mjs`](design-audit.mjs) | Where the interface has stepped outside its own system. A **sum** against a baseline, so a merge can break it when neither branch did. |
| [`design-doc.mjs`](design-doc.mjs) | Writes `docs/design-system.md` from the source; `--check` fails when it is stale. |
| [`generate-codex-protocol.mjs`](generate-codex-protocol.mjs) | Regenerates the vendored Codex app-server types. Needs a real `codex` binary, so CI does not run it. |
| [`check-verify-drift.mjs`](check-verify-drift.mjs) | The gate and `ci.yml` must run the same commands. Both its parsers are unit-tested in `gates.test.mjs`, because both have been silently wrong before. |

## Generators, run by hand

Nothing runs these for you. They write files that are committed, so the moment
to run one is when its input changed.

| | |
| --- | --- |
| [`agent-marks.mjs`](agent-marks.mjs) | The agent logo strip in the README, in both themes, from the same icon set the app draws from. |
| [`diagram-export.mjs`](diagram-export.mjs) | Flattens a rendered Archify diagram to PNG in both themes — see [`../docs/diagrams/README.md`](../docs/diagrams/README.md). |
| [`social-preview.mjs`](social-preview.mjs) | The 1280×640 card GitHub shows when a link to the repo is shared. One image, dark — Open Graph has no light/dark mechanism. |
| [`build-icons.mjs`](build-icons.mjs) · [`cut-avatars.mjs`](cut-avatars.mjs) · [`vendor-fonts.mjs`](vendor-fonts.mjs) | App icons, avatar parts, and the self-hosted font files. |
| [`copy-fixtures.mjs`](copy-fixtures.mjs) | Copies non-TypeScript test fixtures into `dist/`. Part of `build`, not a thing to run alone. |
| [`prune-dist.mjs`](prune-dist.mjs) | Removes from `dist/` whatever the compiler built from a source that is gone, since `tsc -b` never does and the test glob would go on running a deleted test. Fails when an output the compiler writes is missing (`tsc -b` will not put back one deleted from under a source it has built), and when a package the build no longer compiles still holds compiled tests. The last step of `build:node`. |

## Measuring the interface

Read the app rather than describe it. `design-sections.mjs`, `design-tokens.mjs`
and `design-usage.mjs` are libraries the audit and the doc generator share, not
commands.

| | |
| --- | --- |
| [`design-inventory.mjs`](design-inventory.mjs) | What the app actually looks like, counted out of the shipped stylesheets. |
| [`brands.mjs`](brands.mjs) | The brand list, read out of the interface's own source. |

## Driving real agents

These launch the real app against real agents and cost real tokens. Each opens
its own throwaway desk rather than borrowing yours — none of them will touch
the desk you work in.

[`lib/desk.mjs`](lib/desk.mjs) is what they are all built on: launching a desk
of its own, seating agents, driving rooms, and a CDP client. It is a library,
not a command. Everything that has to talk to a running HarnessDesk imports it
rather than growing a second copy — the screenshots, the README's GIF, the
architecture diagram and the social card all go through it.

| | |
| --- | --- |
| [`dsh-compare.mjs`](dsh-compare.mjs) | The same task twice — DeepSeek Harness over its own ACP server, and through HarnessDesk. |
| [`shots/`](shots) | Screenshots and the README's GIF, off the real app against a seeded desk that is nobody's. |
| [`probe/`](probe) | One-off probes kept because reproducing them was the expensive part. |

## Tests

`gates.test.mjs` — run by `pnpm verify` and by CI under
`node --test "script/*.test.mjs"`. `prune-dist.test.mjs` runs under the same
glob: that step deletes files, so each of its tests pairs a removal with
something that must stay, and one of them drives the real compiler.

They test the **parsers**, which is where these scripts go wrong: a check that
reads its input incorrectly passes loudly and proves nothing. Two of them have
done exactly that — a comment quoting a `run(` call counted as a step that did
not exist, and a block-comment regex ate the middle of a test glob and with it
every command after it. A gate whose parser has no test is a gate that can be
green for months while reading half its input.

Anything imported by a test guards its own entry point
(`const isMain = process.argv[1] != null && …`), so importing a check never
runs it. A gate that exits during an import kills the test file with no failing
test named, which is the least useful way a suite can go red.
