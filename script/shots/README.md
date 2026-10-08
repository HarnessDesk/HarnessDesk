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
