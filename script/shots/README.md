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
