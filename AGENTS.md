# Working in this repository

Read `docs/architecture.md` first — `docs/interface.md` if the work is
user-facing — and `docs/decisions.md` for why a surface is the way it is, which
is the fastest way to find the reasoning behind one before changing it.
`CHANGELOG.md` says what has already shipped.
Then take the work from the issue or the request that brought you here.

Maintainers also keep private working files in the root checkout — `PLAN.md` and
`docs/built.md` under `internal/` (gitignored, and a worktree does not carry
them). They are working files, not a contract you need: nothing in this
repository depends on them, and a contributor never has to find them. Where it
matters, their conclusions are written down in `docs/`, and the choices behind
them in `docs/decisions.md`.

## The rules that matter

1. **Codex types never escape `packages/adapter-codex`, and Cordis never escapes
   `packages/cordis-host`.** `pnpm layering` enforces both. They are what keep a
   second runtime and a second extension kernel adapters rather than rewrites.
2. **The renderer never speaks to `codex app-server`.** It talks to the host over
   a token-gated loopback WebSocket, and the host owns the process. A wire
   method is three edits in a fixed order — declare it in
   `packages/protocol/src/wire.ts`, validate its params in
   `packages/protocol/src/wire-validators.ts`, answer it in
   `packages/server/src/methods/<domain>.ts` — and the compiler refuses a missing
   third edit, in the domain file itself (`satisfies MethodsUnder<…>`) and again
   in the table `packages/server/src/methods/index.ts` assembles. A handler
   reaches the host only through `HostContext`; when it needs something that is
   not there, add it to the context first, named for what it does.
3. **The agent owns its own world.** Auth, MCP servers, skills and history
   belong to Codex, Claude Code or Cursor and live in their directories;
   HarnessDesk reads through rather than shadowing. The one exception is
   earned: the host keeps its own transcript, because Cursor keeps nothing
   readable and ACP replay is lossy.
4. **The Codex protocol is generated, not transcribed.** Run
   `pnpm codex:protocol` to refresh, `pnpm codex:drift` to check. The one
   hand-maintained file is `packages/codex/src/methods.ts`, which is the explicit
   record of what we depend on.
5. **Agent output is untrusted.** Anything rendered from a transcript goes
   through `packages/ui/src/lib/sanitize.ts`.
6. **Plugins get capabilities, never primitives.** A plugin receives `ctx.fs`,
   `ctx.http`, and `ctx.shell`, which consult the permission gate at the point of
   use. Built-in plugins are held to their manifests too — that is the only way
   the model stays exercised.
7. **Parity is measured, not claimed.** Run the task, on the real surface, and
   record what the sitting showed — a claim about what an agent can do here is
   worth exactly what the recording behind it is worth. Findings become plan
   items with that evidence attached, never an assertion in a document.
8. **The UI never names a runtime.** Every string about an agent comes from
   `RuntimeInfo.presentation`, which the adapter fills in. Gate on
   `runtime.capabilities`, never on which backend is running (`runtime.id === '…'`).
   A brand name in rendered UI text or a backend id check fails `pnpm layering`.
9. **A row's second line is earned, not default.** That small grey line under
   a menu label costs height on every screen forever, and a menu where every
   row explains itself has explained nothing. Three things earn a visible
   `hint`: a consequence the label cannot carry ("files are left as they
   are"), a fact that varies (a path, a count, the reason a row is refused),
   and a name that carries no meaning of its own (a model's codename).
   Everything else — a paraphrase of the verb, a description of a view one
   click away, a shortcut worth knowing later — goes in `title`, which is the
   same string on hover. A sentence identical on every row of a group belongs
   to the group, as one `MenuNote`. A line only some rows can fill is a ragged
   edge, not a column. And an earned line has to arrive whole: `nowrap` plus an
   ellipsis on a sentence means it is either not earned or not laid out — names
   and paths truncate, sentences wrap. Best of all, ask whether it is a sentence
   at all: a state, mode, kind or plan that fits in a word belongs in a chip on
   the label's own line, costing no row height. Settings pages are the exception for a
   control's own description; a definition of something already chosen is not
   one. `docs/design.md`.
10. **Type comes from the scale, not from the component.** Four sizes carry the
   whole interface and 14px is the default answer; ink has three levels and
   the faintest one is for facts, not for text. `docs/design.md`
   is the guideline, `packages/ui/src/design/tokens.css` the tokens. A raw
   `font-size` in a component is how an app ends up with ten sizes.
11. **Build a screen out of the design system, never beside it.** Import from
    `packages/ui/src/design` — `Btn`, `Row`, `Rows`, `Toggle`, `Chip`,
    `Dialog`, `ConfirmDialog`, `Banner`. Read `docs/design-system.md` first;
    it is generated from the source, so it cannot be out of date. The rules,
    every one of them enforced by `node script/design-audit.mjs --strict`:
    - Never import another screen's `*.module.css`. If two screens need the
      same thing, it belongs in `design/primitives`.
    - Never write a literal where a token exists — a raw radius, colour or
      spacing step will not follow a theme or a redesign. That includes a
      literal hidden behind a custom property.
    - Never define an `--hd-*` token in a screen. The prefix is the app's
      vocabulary; defining one beside the screen that wants it forks the
      source of truth, and the generated doc and the token snapshot will both
      miss it. A component's own private property is fine — just not under
      `--hd-`. **A foundation is the exception and the whole point**: a
      `tokens.<name>.css` of overrides applied last in the cascade is how a
      redesign or a user's theme happens *without* editing the system it
      varies. Redefining `--hd-*` is that file's entire job.
    - Never hand-roll an overlay. `Dialog` already answers where the buttons
      go, what Escape does, what a click outside does, and where focus
      returns. Four surfaces are deliberately not dialogs — Approvals, the
      command palette, Sign in, AppWindow — and that number is a ceiling you
      may raise on purpose.
    - Never draw an icon in place. It belongs in `components/Icons.tsx`, or
      `BrandIcons.tsx` for a brand mark, and is imported from there. A chart,
      a sparkline or an illustration is **not** an icon and does not go there.

    Every one of these has a legitimate exception, and the audit's failure
    message names it. Where a rule and a real need collide, the move is to
    raise the baseline deliberately — `node script/design-audit.mjs
    --baseline`, with the reason in the commit — never to hide the value
    somewhere the check cannot see.

    Two component idioms exist, and the number is a ceiling. `design/ui/`
    is the shadcn layer — vendored component source over Tailwind
    utilities that resolve to the `--hd-` tokens (styles/shadcn.css is the
    bridge) — and it is the idiom for **new and rebuilt surfaces**.
    `design/primitives/Kit.tsx` remains the settings-surface primitives
    for everything not yet rebuilt. A surface's *controls* use one idiom,
    not a mixture; page furniture (`PageHead`, `Rows`) may stay Kit while
    a page's controls move. What was always forbidden still is: a THIRD
    spelling, or a screen answering "what is a button here" for itself.
    The two Buttons never disagree about what a button *is*, because both
    read the `--hd-btn-*` component tokens — a foundation restyles both at
    once, and `design/ui/button.test.tsx` pins that coupling.

    Look at what you changed: `pnpm design` renders every primitive from the
    real code, in both themes, under a switchable foundation.

12. **Change the system before the screen.** These asks all look like screen
    work and are not: the first edit belongs in the layer named here, and the
    screen follows it. The other order is how a system ends up documenting an
    app that no longer matches it.

    | the ask | change this first | then |
    |---|---|---|
    | Restyle notifications / banners | `design/primitives/Banner.tsx` | screens inherit it |
    | Any palette, shape or density change | `design/tokens.css` | nothing else should need editing |
    | A different look wholesale | a **foundation** — a token overlay, the mechanism `pnpm design` already switches | screens are untouched |
    | New shadcn-idiom UI | `design/ui/` — vendor via `pnpm dlx shadcn@latest add`, then apply the folder's three rules (its index.ts names them) | the screen composes it |
    | Themes, including a user's own | a palette/accent/corners sheet keyed on `body[data-hd-*]` (styles/shadcn-themes.css is the pattern), plus persistence | Settings › Appearance reads and writes those |
    | Fonts | the `--hd-font-*` tokens | a settings surface reads and writes those |
    | A new dialog, sheet or confirm | `design/primitives/Dialog.tsx`, if it lacks what you need | then the screen |
    | Rebuild Agent settings / plugin pages / login | nothing — they are already `Kit` consumers | build with `Row`, `Rows`, `Btn`, `Input` |

    One has no seam yet, so building one is the first commit rather than a
    detour: **icons** (`Icons.tsx` is a flat façade over lucide, with no token
    and no board).

    Where this table and the audit disagree, the audit is right — it reads the
    code and this is prose. Its failure messages name the file to edit.

## Before you commit

```bash
pnpm verify
```

It validates the lockfile with `pnpm install --frozen-lockfile`, runs the build,
every test suite (Node packages, gate scripts, UI and desktop), the UI typecheck,
the layering rule, the tracked-secrets scan, the third-party notices check, the
design-system gates, interface drift, the recorded-claims link and the Codex
protocol drift check.

CI deliberately excludes the Codex protocol drift check, which needs a real
`codex` binary the runner lacks. The local gate and CI are held to the same
commands by `script/check-verify-drift.mjs`, though seven checks are currently
queued in `PENDING_IN_CI` waiting on a workflow update, and GitHub Actions runs
have been blocked by account payment failures since 2026-08-30 — making
`pnpm verify` the only active barrier protecting `main`. Run it **unpiped**:
`pnpm verify | tail` reports the exit status of `tail`, which has hidden a red
run before now.

## Writing plugins

`docs/extending.md` is the authoring guide. Built-in plugins live in
`packages/plugins` and use exactly the same API, manifest, and permission gate as
a third-party plugin — keeping them on that path is what stops the extension API
from rotting.

## Testing conventions

- TypeScript Node packages use `node:test` and compile to `dist/test`. The
  runners glob what was built, and `tsc -b` never deletes an output whose
  source is gone, so the build ends with `script/prune-dist.mjs`: a deleted
  test leaves `dist` on the next build instead of running on against code
  that has moved. The desktop package and gate scripts run `node:test`
  directly against source `.mjs`.
- The UI uses Vitest with jsdom.
- Agent tests (Codex, ACP, Claude Code, Cursor) run against scripted fake
  services and peers, never real vendor endpoints: the suite must not need
  credentials, network, or credits.
- Fixtures are synthesised from observed shapes. Do not record real user sessions
  into the repository — they contain the user's source code.
