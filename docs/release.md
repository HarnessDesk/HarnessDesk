# Cutting a release

A release is cut **by hand, on a Mac that holds the signing identity** — not
by `.github/workflows/release.yml`. That workflow exists, is
`workflow_dispatch`-only, and **has run once**:
[run 34928000550](https://github.com/HarnessDesk/HarnessDesk/actions/runs/34928000550)
(2026-09-15) got through checkout, build, and choosing a signing identity,
then correctly refused at *Build signed app* — `A publishing run needs
MAC_CERTIFICATE_P12. Refusing to publish an unsigned build.` The repository
still carries none of the Actions secrets that command needs
(`gh api repos/HarnessDesk/HarnessDesk/actions/secrets` reports
`total_count: 0`), so today it is **dormant, not decommissioned**: a second
publish path with its own generated-notes, runner-only version flow, one
`MAC_CERTIFICATE_P12` secret away from reactivating and disagreeing with
everything below. Don't add that secret without first reconciling the two
paths — until then, this document is the one that actually runs, and the
recipe below is manual because that workflow's own guard keeps it from
being anything else.

It works locally because the login keychain holds the Developer ID
Application identity and the notarization credentials sit in the
environment. `node script/release.mjs` does the mechanical half of what
follows; the rest is judgment, done here in order.

Before starting, confirm the signing side is actually ready:

```
node packages/desktop/script/preflight-notarize.mjs
```

It prints one line and never reveals a value. If it refuses, stop — nothing
below will get further than the first `-c.mac.notarize=true`.

---

## 1. Close the CHANGELOG gap

```
node script/release.mjs gap
```

lists every commit since the last `v*` tag. `CHANGELOG.md`'s `## Unreleased`
section is the view for someone deciding whether to update — check each
commit against it. Not every commit earns a line (a refactor, a build-config
tidy, or a documentation move is real work and not news to a person weighing
an upgrade), but a genuine user-facing change with no matching bullet is a
gap, and gaps are common: the 0.2.2 release found eight commits with no entry
at all, including a whole redesign and three real bug fixes. Nobody writes
the changelog line at merge time by default here — closing this gap is
release work, every time, not a one-off cleanup.

Write entries in the project's own voice: specific, present-tense, naming
what a person will actually see change, not what the commit refactored to
get there. Read a few recent entries in `CHANGELOG.md` before writing new
ones — the voice is part of what ships.

Rename the section and add an opening paragraph once the gap is closed:

```diff
-## Unreleased
+## 0.2.3 — 2026-09-24
+
+One sentence naming the headline change, then what it took to get there.
```

Do **not** leave a fresh empty `## Unreleased` header behind — one only
reappears once the next commit actually lands after this release.

## 2. Bump the versions

```
node script/release.mjs bump <version>
```

bumps exactly two `package.json` files — the root and
`packages/desktop/package.json` — and rewrites the `DOWNLOAD` constant in
`packages/ui/site-demo/fake-host.ts` to point at the new arm64 DMG.

Nothing else moves. Every other `packages/*/package.json` stays at whatever
it says by convention and is not the app's version; neither is `store.ts`'s
`clientVersion` (the wire protocol's own version) nor `claude-acp`'s
`VERSION` (the bridge's). Bumping those would be changing a different
number that happens to look similar.

## 3. Verify, PR, merge

```
TMPDIR=/tmp pnpm verify
```

bare, unpiped — piping through `tail`/`grep` hides a red exit status, which
has shipped a red `verify` before. A short `TMPDIR` avoids a real trap: the
default can produce a unix socket path in a test fixture that overruns
macOS's 104-byte `sun_path` limit and crashes the runtime rather than failing
the test cleanly.

Open the PR, wait for CI, and squash-merge once it is green. A single failed
job that reproduces the exact "document default font-size" signature this
codebase has fought before (the measured number matches the browser's
default rather than the app's own, with the element's box sized correctly
either way) is worth one re-run before treating it as real — CI here has
shown that flake more than once on a cold runner. Anything else, treat as
real.

**Prove the merge changed nothing**, so the build below doesn't have to wait
on CI to finish before it can start:

```
git rev-parse <branch-sha>^{tree}
git rev-parse origin/main^{tree}
```

Equal trees mean the squash merge changed no bytes — what CI is checking and
what you're about to build and sign are the same tree.

## 4. Build, sign, and notarize

```
pnpm --dir packages/desktop run dist:notarized
```

runs the preflight check, `electron-builder --mac --publish never
-c.mac.notarize=true` for both `arm64` and `x64`, then staples each DMG.
Roughly 20–30 minutes end to end, two notarization round trips with Apple.
No password prompt: the identity and credentials are already in the
keychain, found by `preflight-notarize.mjs` before the build starts.

Use `pnpm --dir`, not `cd packages/desktop &&` — the next two steps run
`node script/release.mjs ...` from the repository root, and a plain `cd`
here leaves the shell in `packages/desktop` for whatever runs next: the
`script/release.mjs` in step 5 resolves one `packages/desktop` too deep
(`MODULE_NOT_FOUND`), and so does every upload path in step 6.

Stapling invalidates the DMGs' own blockmaps, and the script deletes them —
only the `.zip.blockmap` files (which the in-app updater reads) survive.
`latest-mac.yml` is repaired afterward to match the stapled bytes.

## 5. Checksum, then verify what you're about to ship

```
node script/release.mjs checksums
node script/release.mjs verify-artifacts
```

`checksums` must run **after** stapling — a checksum taken before would
describe bytes that no longer exist. `verify-artifacts` re-runs the same
three checks a downloader is told to run in the release notes
(`shasum -c`, `xcrun stapler validate`, `spctl --assess`) and fails loudly on
the first artifact that doesn't say `Notarized Developer ID`. Don't skip
this because the build log said `notarization successful` — this is the
independent check a person clicking the DMG will actually run.

## 6. Write the release notes and publish

Hand-written, not `generate_release_notes: true` — a machine list of commit
titles is not the same document as `CHANGELOG.md`'s curated summary, and the
two have drifted before. Read a recent release
([v0.2.0](https://github.com/HarnessDesk/HarnessDesk/releases/tag/v0.2.0) is
a good template) for the shape: an opening paragraph shared with the
CHANGELOG entry, a downloads table, five or six highlighted changes (not the
full list — that's what the CHANGELOG link is for), and the verification
block from step 5.

```
gh release create v<version> \
  --target <the merge commit> \
  --title "HarnessDesk <version>" \
  --notes-file <notes.md> \
  packages/desktop/release/HarnessDesk-<version>-arm64.dmg \
  packages/desktop/release/HarnessDesk-<version>-x64.dmg \
  packages/desktop/release/HarnessDesk-<version>-arm64.zip \
  packages/desktop/release/HarnessDesk-<version>-x64.zip \
  packages/desktop/release/HarnessDesk-<version>-arm64.zip.blockmap \
  packages/desktop/release/HarnessDesk-<version>-x64.zip.blockmap \
  packages/desktop/release/latest-mac.yml \
  packages/desktop/release/SHA256SUMS.txt
```

`--target` is the merge commit, not a branch — the tag this command creates
is what a clone actually gets. No separate `git tag` step: `gh release
create` cuts the tag at publish time, at exactly that commit.

**Never paste the raw `dist:notarized` build log anywhere public.** It
prints the signing identity's organization name in the `electron-builder`
"signing" line, and that name should not appear in a PR, an issue, or a
release note.

---

## What NOT to script

Steps 1, 3, and 6 stay manual (or an agent's, reading this document) on
purpose. A changelog entry written to satisfy a template reads like one;
deciding a CI failure is a known flake instead of a real regression is
exactly the judgment a blind retry-on-red policy would remove; and release
notes generated from commit titles are a different, worse document than the
one `CHANGELOG.md` already curated. `script/release.mjs` automates the parts
that are pure mechanics and worth getting byte-identical every run —
nothing more.
