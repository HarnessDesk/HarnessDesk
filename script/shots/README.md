# Scripted Flow scene

## README and site stills

```sh
HD_SHOTS_HOME=/tmp/hd-stills-rig node script/shots/shoot.mjs --release-stills --out /tmp/hd-stills
```

This opt-in take opens `preview.html` headlessly, composing the shipped screens
over public synthetic stores. It needs no agent, account, desktop window or
seeded desk. `--scene teams` (or any name in `stills.mjs`) narrows a take;
`--theme light` or `--theme dark` narrows its themes. It produces each scene at
960 pixels wide and the race also at 1280 pixels wide, with a caption manifest.
Named content, the theme, enabled Start and the embedded browser's loaded page
must be ready before capture. `audit.mjs` checks the parent and every embedded
document before any PNG is saved. Existing referenced images are refused,
except the `flow-light.png` / `flow-dark.png` pair reserved by the stills brief.

```sh
node --test script/shots-stills.test.mjs
```

The compact website set lives in `docs/images/app/site/`. Capture its eleven
scenes in both themes with `shootStills({ app, out, requested })`, naming
`teams-table`, `run-short`, `race-run`, `browser-tile`, `handoff-dialog`,
`start-preview`, `dash-plans`, `dash-hour`, `dash-year`, `dash-spend` and
`dash-agents` (or use `shoot.mjs --release-stills --scene <name>` per scene).
These cameras use device scale factor 2 and crop to the production content's
DOM edge. The two Runs have their own short frozen Flows, without check or
landing rounds. Dashboard ranges, agent totals and local-hour cells derive
from one fictional year with five placeholder accounts. The Browser's
`https://acme.dev/storefront` request is fulfilled locally from
`fixtures/acme-storefront.html`; it never reaches that host. Dates are frozen
at September 30, 2026, with the camera in America/Los_Angeles. A month-end
camera gives the year grid room to name its final month. The manifest records
each crop's logical size and scale. Open every PNG after the automated audit.

## Looping website clips

```sh
node script/shots/shoot.mjs --site-clips --out .lead-out/site-clips
node script/shots/shoot.mjs --site-clips --scene browser --theme dark --out /tmp/hd-clips
node --test script/shots-clips.test.mjs
```

`--out` is required. This headless preview take needs no agent, account, native
window or seeded desk. It records `teams`, `run`, `race`, `browser`, `handoff`,
`library`, `permissions` and `dashboard` in light and dark. Every story lasts
eight seconds at 24 fps. Playwright's clock advances once per frame while the
date stays frozen at September 30, 2026. Device scale is 2, with a 720–960px
camera viewport and a fixed crop measured from the production DOM edges across
the story. The recorder injects the neutral pointer and eases it between real
targets; actual mouse events drive the shipped controls.

The Runs stage the same synthetic round records that make the stills, through
the production Run selector. The Teams camera opens the existing start-preview
fields and Seats in a dialog; it illustrates preparation, without starting
work. The permissions camera uses the existing plugin enable switch beside
Tools and Access: Access rows currently describe grants and are not editable
per grant. Dashboard visits Plans (the account limits), Spend, Activity's
By agent and Year views, using the same fictional year as the stills.
All Browser requests to `acme.dev` are fulfilled from `acme-storefront.html`;
other external requests are blocked.

Every parent and embedded document passes `audit.mjs` before each frame is
written. A mismatching first/last source frame refuses encoding. Existing
assets referenced by README or documentation cannot be overwritten, including
through directory aliases. H.264 video uses `yuv420p`, CRF 24, fast start and no
audio; encoded clips are at most 1600px wide and 1.5 MB. Each take writes
`<scene>-<theme>.mp4`, a first-frame `.webp` and `.jpg`, plus `clips.json` with
the crop size, scale, fps, duration, bytes, caption and loop hashes. `sheet.png`
shows first, middle and last frames for each take. Inspect every poster and the
sheet before publishing; keep generated media outside the committed code.

The supplied ffmpeg build lacks a WebP encoder, so posters use the installed
`cwebp` tool. Defaults are `/opt/homebrew/bin/ffmpeg` and
`/opt/homebrew/bin/cwebp`; override `HD_SHOTS_FFMPEG`, `HD_SHOTS_FFPROBE` and
`HD_SHOTS_CWEBP` for another installation. Clips are recorded serially; on a
shared worker, run the take through the machine-wide gate. For a local Lead
handoff, add `.lead-out/` to `.git/info/exclude` before capturing the set.

## Scripted repair loop

Build the Node packages and renderer, then record a complete repair loop without
opening a desktop window:

```sh
pnpm build
node script/shots/flow.mjs --out /tmp/hd-flow-frames
```

The scene seeds a disposable desk with placeholder accounts using `seed.mjs`.
Its native fake seats run `flow.yml`: write a small change in an isolated lane,
commit with the board tool, run a real host check on that commit, request changes
once, commit a repair, check and approve it, then leave landing to the person.
The review records the candidate the host offered, and the Flow's evidence guards
read the host's actual diff, check and review facts. The person's checkout stays
at its original commit. The scene has no forge and never pushes or merges.

`FAKE_CODEX_FLOW` opts the fake app-server into this behavior. `flow-rig.mjs`
supplies the steps and outcomes, resets their pass state for each take, and seats
the project reviewer on the native fake. The normal fake turns used by adapter
tests are unchanged. Standing prompts finish quietly; only a real card order
can claim, write or answer. A refused tool fails the turn rather than reporting
completion.

The scene explicitly declares no provider independence. It demonstrates the
repair loop on held native seats, rather than claiming to demonstrate the
shipped independent-specialist shape. Permission and independence checks remain
the product's own.

Four milestones are photographed in both themes: the initial writer, the first
review, the repair and the person handoff. Every frame passes the rig's text and
attribute privacy audit before capture. `sequence.json` lists the frames and the
actual round order. The browser, host and disposable desk close on failure too.

The regression runs the same seeded scene and checks its card outcomes, held
ceilings, clean commits and the revisions named by checks and reviews:

```sh
node --test script/shots-flow.test.mjs
```

## Shipped Team template journeys

`templates.mjs` opens the shipped New Team template picker in the real renderer and
starts the built-in **Side by side** and **Write and review** templates against
an in-process Host. The current project is restored from a legacy recent-project
record and shown in the sidebar's project list. New Team currently has no
separate project picker; this journey uses the restored project, with only the
older record's `path`, `name`, `lastOpenedAt` and `id`. The rig never calls
`workspace/open` before starting a Team, which would mask the admission
regression.

Side by side edits the project-prefilled check through **Check each attempt
with**, opens Details to inspect the preview, then starts both writers. They
commit different contents at distinct declared paths in separate lanes, honoring
the board's file ownership gate. The host runs the scripted check
on both revisions; the independent scripted judge records an offered candidate;
the person merges its exact revision through the comparison's Merge dialog,
which answers the referee card. Write and review starts on a preselected feature
branch, visible in the first screen, and keeps the branch its Seat opened on.
It publishes to a disposable local bare remote and a deterministic forge double,
gets a fresh scripted review at that published revision,
merges the published branch into main through the Repository UI, then answers
the person handoff. The Host posts the manual run's closed-round review comment to
the local forge and confirms its returned location through the real publication
adapter. Both Runs settle; final Overview shows Done and the explicit completion
message with no remaining attention or unconfirmed publication.

The pre-existing frozen-branch evidence limitation remains Backlog: switching a
writer's branch after its Seat opens can leave the review bound to the original
branch and stale against the PR. The rig prepares its feature branch before the
Host starts; it does not mutate a running Team or bypass this guard.

Two native adapters use only `fake-codex.mjs`. Their distinct provider metadata
represents two scripted services so the host's independence gate is exercised;
the journey explicitly chooses **Scripted reviewer** through the preview's Agent
control. The scripted writer also advertises its own held publish control: the
Host applies and reads back workspace/user sandbox settings, while the fake
executes only its declared local branch push and `pr_create` through the gated
tool registry. The production adapter advertises held read/edit only; this is
not proof of real provider independence or native publish support. `template-forge.mjs`
answers only its declared local operations, including the one PR's review
comment and its readback, with placeholder identities, and
refuses every other operation. No agent CLI, model endpoint or forge endpoint
is contacted. Camera gates hold the fake writes/reviews and scripted checks at
deterministic milestones; they do not advance the Host's run directly.

The runner asserts visible task, preview, writing, checking, judging/reviewing,
person handoff and final states, and reads the Host's actual lane/check facts.
It photographs the picker, task, preview and each journey phase in both themes,
plus Overview, Timeline, Flow, Board and Chat. Each photograph passes the privacy
audit; `sequence.json` inventories the frames and host-derived round/check facts.
The camera abbreviates synthetic paths and labels of Git revisions read from the
Host's evidence. Merge inputs keep their exact revisions, and the runner verifies
the merged head.
Browser, Host and scratch desk close on failure too. Diagnostic frames are local
only and do not belong in public evidence.

Build the Node packages and renderer through the machine-wide gate first, then
run the browser journey through that gate once:

```sh
node script/shots/templates.mjs --out /tmp/hd-template-frames
```

Focused rig and scripted-agent regressions:

```sh
node --test script/shots-flow.test.mjs script/shots-templates.test.mjs
```

CI runs the same journey as `e2e/ui-system/template-journeys.spec.ts`, building
one renderer in its output folder first, and retains the manifest and both-theme
frames as Playwright attachments. The runner accepts `--ui <renderer>` because
the ordinary preview server does not serve the token-gated host connection used
by these journeys.
