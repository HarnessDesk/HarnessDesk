# Third-Party Notices

HarnessDesk is an independent project. It is not affiliated with, endorsed by, or
sponsored by OpenAI, DeepSeek, Anthropic, or Zed Industries. Its runtime,
protocol, host, renderer and design system are its own; what follows is
everything it builds on.

Licence texts for components whose code is reproduced here are in `licenses/`.
Name and mark usage is covered by [TRADEMARKS.md](TRADEMARKS.md).

## Code reproduced in this repository

**DeepSeek Harness — MIT** (`licenses/MIT-deepseek-harness.txt`). Four built-in
plugins — search, task list, checkpoints and guardrails — are new
implementations of ideas that appear upstream, written against this project's
own plugin API. Its extension kernel, Cordis, is listed below as the dependency
it is.

**OpenAI Codex protocol types — Apache-2.0** (`licenses/Apache-2.0.txt`), from
https://github.com/openai/codex. `packages/codex/src/generated/` is unmodified
output of `codex app-server generate-ts`, with the producing version in
`VERSION.json`. It is type-only and excluded from the packaged app. The Codex
binary is neither bundled nor modified; HarnessDesk launches the one already on
the machine, and its authentication stays in `~/.codex`.

**Geist — SIL OFL 1.1** (`licenses/OFL-1.1-geist.txt`), Copyright 2024 The Geist
Project Authors. Two woff2 files in `packages/ui/src/assets/fonts/`, unmodified
as served, subset to latin and latin-ext; the served version is in
`VERSION.json` beside them.

**shadcn/ui — MIT** (`licenses/MIT-shadcn.txt`), Copyright (c) 2023 shadcn.
shadcn distributes components as source to copy rather than as a package, so
most files under `packages/ui/src/design/ui` began as its code. Each says in its
own header whether it is vendored — and what was changed — or written to its
shape.

**Lucide — ISC** (`licenses/ISC-lucide.txt`), Copyright (c) 2026 Lucide Icons and
Contributors. Icon paths, unmodified, inlined at build time. Part of the set
derives from Feather (MIT, Copyright (c) 2013-present Cole Bemis); the vendored
licence text carries that notice.

**Lobe Icons — MIT** (`licenses/MIT-lobe-icons.txt`), Copyright (c) 2023 LobeHub.
Vendor marks, inlined at build time, unmodified except for size and colour. The
logos are their owners' trademarks, used to identify those products only.

## Modifications, as Apache-2.0 §4(b) asks

`packages/claude-acp` builds on Zed's Claude Code bridge rather than
reimplementing it, and changes it in four ways: `HarnessDeskClaudeAgent` extends
`ClaudeAcpAgent` to forward session controls, models and usage the base bridge
does not surface; two constants it defines but does not export are reproduced
rather than deep-imported, noted at the site; `main.ts` follows the shape of the
upstream entry point with this package's agent in place of its own; and the
client it notifies is wrapped so a `session/load` replay is filtered the way the
base bridge already filters a live turn.

The Agent Client Protocol itself (https://agentclientprotocol.com) is a published
specification; `packages/transport-acp` and `packages/cursor-acp` implement it
independently and vendor no schema.

## Packages used as dependencies

Published packages, none vendored or modified. Each ships its own licence inside
the packaged app.

| Package | Licence | Used for |
| --- | --- | --- |
| `@deepseek-ai/cordis` | MIT | The extension kernel — plugin lifecycle, injection, isolation, hot reload. Wrapped by `packages/cordis-host`; nothing above it imports Cordis, which `pnpm layering` enforces |
| `@zed-industries/claude-code-acp` | Apache-2.0 | Running Claude Code as an ACP agent |
| `@agentclientprotocol/sdk` | Apache-2.0 | The ACP client surface |
| `lucide-react` | ISC | The icon set |
| `@lobehub/icons-static-svg` | MIT | Vendor and agent marks |
| `react`, `react-dom` | MIT | The renderer |
| `electron` | MIT | The macOS shell |
| `@xterm/xterm`, `@xterm/addon-fit` | MIT | The terminal pane |
| `ws` | MIT | The host's WebSocket transport |
| `marked` | MIT | Markdown parsing |
| `shiki` | MIT | Syntax highlighting |
| `@base-ui/react` | MIT | The primitives behind the vendored components |
| `radix-ui` | MIT | The primitives for components not yet on Base UI |
| `tailwindcss` | MIT | The utility layer those components are written in |
| `class-variance-authority` | Apache-2.0 | Variant maps in those components |
| `clsx`, `tailwind-merge` | MIT | Their `cn` class helper |
| `sonner` | MIT | Toasts |
