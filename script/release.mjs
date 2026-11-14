#!/usr/bin/env node
/**
 * Release tooling: the mechanical, low-risk half of cutting a release.
 *
 * The judgment calls stay manual (or an agent's, reading docs/release.md) —
 * closing the CHANGELOG gap in the project's own voice, opening the PR,
 * waiting for CI, deciding when to publish. This script only does the parts
 * that are pure mechanics and worth getting byte-identical every time:
 * listing what a changelog pass needs to cover, bumping the two versions
 * that matter, pointing the site demo at the new download, computing
 * checksums, re-proving a signed artifact the same way a person reading
 * the release notes would, and booting the app inside each artifact before
 * anything is published.
 *
 * Usage:
 *   node script/release.mjs gap [<since-tag>]
 *     List commits since a tag (default: the latest v* tag) — check each
 *     against CHANGELOG.md's "## Unreleased" section before cutting one.
 *
 *   node script/release.mjs bump <version>
 *     Bump root/package.json and packages/desktop/package.json to <version>,
 *     and point the site demo's download link at the matching arm64 DMG.
 *     Every other packages/*\/package.json stays where it is — see
 *     docs/release.md for why.
 *
 *   node script/release.mjs checksums [<dir>]
 *     Write SHA256SUMS.txt for the .dmg/.zip files in <dir> (default
 *     packages/desktop/release). Run this AFTER stapling — the recipe in
 *     docs/release.md explains why the order matters.
 *
 *   node script/release.mjs verify-artifacts [<dir>]
 *     Check SHA256SUMS.txt, then run `xcrun stapler validate` and
 *     `spctl --assess` on every .dmg in <dir>. Exits non-zero on the first
 *     one that doesn't say "Notarized Developer ID". Each DMG is then mounted
 *     read-only: its app must carry Contents/Resources/ui/index.html and say
 *     the version packages/desktop/package.json says, and its iOS helper is
 *     inspected (see docs/release.md).
 *
 *   node script/release.mjs smoke-artifacts [<dir>] [--allow-skip]
 *     The launch gate. Mount every .dmg in <dir> read-only and run
 *     packages/desktop/script/smoke-packaged.mjs against the HarnessDesk.app
 *     inside it. A DMG this Mac cannot run (x64 without Rosetta on Apple
 *     silicon) is not smoked and is listed as NOT SMOKED; that fails the
 *     command unless --allow-skip is given. Any failed smoke, an interruption,
 *     or no DMG smoked at all always fails it. SIGINT or SIGTERM stops the
 *     smoke and detaches the volume before exiting. verify-artifacts proves
 *     signing; this proves the app starts.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withIosReleaseMount } from './ios-release-mount.mjs'
import { smokeArtifacts, smokeVerdict } from './smoke-artifacts.mjs'
import { verifyAppContents } from './verify-app-contents.mjs'
import { verifyIosArtifact } from './verify-ios-artifact.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+$/

const fail = message => {
  console.error(message)
  process.exit(1)
}

const run = (command, args, opts = {}) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', ...opts })

const gap = sinceArg => {
  const since = sinceArg ?? run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']).trim()
  const commits = run('git', ['log', `${since}..HEAD`, '--format=%h %s']).trim()
  if (commits === '') {
    console.log(`Nothing since ${since}.`)
    return
  }
  const lines = commits.split('\n')
  console.log(`${lines.length} commit(s) since ${since}.`)
  console.log('Check each against CHANGELOG.md\'s "## Unreleased" section — a commit with')
  console.log('no matching entry is the gap the 0.2.2 release found: eight of them had none.\n')
  for (const line of lines) console.log(`  ${line}`)
}

/**
 * Find `pattern` in the file at `path` and replace its whole match with
 * `build(match)`. Fails (before writing anything) if `pattern` isn't found —
 * but a match whose replacement comes out identical to what's already there
 * is success, not failure: `bump` calls this for three separate targets and
 * plans all three before writing any of them, so retrying after fixing one
 * broken target must not re-fail on the two that were already bumped by the
 * first, partial attempt. Testing `next === text` to mean "no match" doesn't
 * survive that retry — an already-correct value makes the replacement a
 * no-op string-for-string, which looks identical to never having matched at
 * all. Matching with the pattern directly (`exec`, not a before/after
 * comparison) keeps those two cases apart.
 */
const planFieldBump = (path, pattern, build) => {
  const text = readFileSync(path, 'utf8')
  const match = pattern.exec(text)
  if (!match) fail(`${path}: expected shape not found — update it by hand.`)
  const next = text.slice(0, match.index) + build(match) + text.slice(match.index + match[0].length)
  return { path, text, next }
}

const applyFieldBump = ({ path, text, next }) => {
  if (next === text) {
    console.log(`${path}: already at the target value`)
    return
  }
  writeFileSync(path, next)
  console.log(`bumped ${path}`)
}

const bump = version => {
  if (!SEMVER.test(version)) fail(`"${version}" doesn't look like X.Y.Z`)

  const versionField = /^(\s*"version":\s*")[^"]+(")/m
  const bumpVersion = match => `${match[1]}${version}${match[2]}`

  // Every target is planned — and, on a bad shape, fail() exits — before any
  // of them are written. A partial write here is exactly the half-applied
  // state a retry can't recover from: two versions bumped, the download URL
  // untouched, no way to tell which run left it that way.
  const plans = [
    planFieldBump(join(root, 'package.json'), versionField, bumpVersion),
    planFieldBump(join(root, 'packages/desktop/package.json'), versionField, bumpVersion),
    planFieldBump(
      join(root, 'packages/ui/site-demo/fake-host.ts'),
      /const DOWNLOAD = 'https:\/\/github\.com\/HarnessDesk\/HarnessDesk\/releases\/download\/v[^']+'/,
      () =>
        `const DOWNLOAD = 'https://github.com/HarnessDesk/HarnessDesk/releases/download/v${version}/HarnessDesk-${version}-arm64.dmg'`,
    ),
  ]
  for (const plan of plans) applyFieldBump(plan)

  console.log('\nStill by hand: CHANGELOG.md ("## Unreleased" -> "## ' + version + ' — <date>" plus an')
  console.log('opening paragraph). Run "node script/release.mjs gap" first to find what it must cover.')
}

const checksums = dirArg => {
  const dir = resolve(root, dirArg ?? 'packages/desktop/release')
  const files = readdirSync(dir).filter(f => /\.(dmg|zip)$/.test(f)).sort()
  if (files.length === 0) fail(`no .dmg/.zip files in ${dir}`)
  const output = run('shasum', ['-a', '256', ...files], { cwd: dir })
  writeFileSync(join(dir, 'SHA256SUMS.txt'), output)
  process.stdout.write(output)
  console.log(`\nwrote ${join(dir, 'SHA256SUMS.txt')}`)
}

/**
 * Run a command, print whatever it wrote (stdout and stderr, interleaved as
 * two blocks rather than by arrival order — good enough for a command that
 * prints one thing), and hand back that text along with the exit status.
 *
 * Not `execFileSync` with `stdio: 'inherit'`: that only lets a caller ask
 * "did it exit non-zero", and `spctl`'s exit status is not the promise this
 * command exists to keep. A wrapper that answers `-v` with a fabricated
 * "accepted" and exits 0, or that answers nothing at all and *also* exits 0
 * (both happen — an empty PATH match, a mocked binary in a test harness),
 * satisfies an exit-code check while satisfying nothing about the artifact.
 * Read the text spctl actually printed.
 */
const runCaptured = (command, args, opts = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...opts })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  return { status: result.status, output }
}

const requireInOutput = (result, needle, onFail) => {
  if (result.status !== 0 || !result.output.includes(needle)) fail(onFail)
}

const verifyArtifacts = dirArg => {
  const dir = resolve(root, dirArg ?? 'packages/desktop/release')
  const dmgs = readdirSync(dir).filter(f => f.endsWith('.dmg')).sort()
  if (dmgs.length === 0) fail(`no .dmg files in ${dir}`)
  const version = JSON.parse(readFileSync(join(root, 'packages/desktop/package.json'), 'utf8')).version

  const shasum = runCaptured('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: dir })
  if (shasum.status !== 0) fail(`\nSHA256SUMS.txt does not match what is on disk in ${dir} — stop here.`)

  for (const dmg of dmgs) {
    console.log(`\n=== ${dmg}`)

    const staple = runCaptured('xcrun', ['stapler', 'validate', dmg], { cwd: dir })
    requireInOutput(
      staple,
      'The validate action worked!',
      `\n${dmg} did not staple-validate — do not publish it.`,
    )

    const spctl = runCaptured(
      'spctl',
      ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', dmg],
      { cwd: dir },
    )
    requireInOutput(
      spctl,
      'source=Notarized Developer ID',
      `\n${dmg}: spctl did not report "Notarized Developer ID" — do not publish it.`,
    )
    const arch = /-arm64\.dmg$/.test(dmg) ? 'arm64' : /-x64\.dmg$/.test(dmg) ? 'x64' : null
    if (!arch) fail(`${dmg}: the artifact name does not identify its architecture.`)
    // One read-only mount per DMG for everything read from inside it: what the
    // bundle holds first (a signature says nothing about that — 0.7.1 was
    // notarized without its interface), then the iOS helper. Errors are thrown,
    // not fail()ed, so the mount's cleanup runs before the process exits.
    const mount = mkdtempSync(join(dir, '.verify-ios-'))
    try {
      withIosReleaseMount(join(dir, dmg), mount, () => {
        const app = join(mount, 'HarnessDesk.app')
        verifyAppContents(app, version)
        console.log(`${dmg}: carries its interface and says version ${version}`)
        verifyIosArtifact(app, arch)
      }, { run })
    } catch (error) {
      fail(`\n${dmg}: ${error instanceof Error ? error.message : String(error)} Do not publish it.`)
    }
  }
}

const smokeArtifactsCommand = async args => {
  const allowSkip = args.includes('--allow-skip')
  const unknown = args.filter(arg => arg.startsWith('--') && arg !== '--allow-skip')
  if (unknown.length > 0) fail(`smoke-artifacts: unknown option ${unknown.join(' ')}`)
  const dir = resolve(root, args.find(arg => !arg.startsWith('--')) ?? 'packages/desktop/release')
  const result = await smokeArtifacts(dir, { run })
  if (result.dmgs.length === 0) fail(`no .dmg files in ${dir}`)
  const { lines, problem, exitCode } = smokeVerdict(result, { allowSkip })
  console.log(`\n=== smoke-artifacts\n${lines.join('\n')}`)
  if (problem) {
    console.error(`\n${problem}`)
    process.exit(exitCode)
  }
}

const [, , command, ...args] = process.argv

switch (command) {
  case 'gap':
    gap(args[0])
    break
  case 'bump':
    if (args[0] == null) fail('usage: node script/release.mjs bump <version>')
    bump(args[0])
    break
  case 'checksums':
    checksums(args[0])
    break
  case 'verify-artifacts':
    verifyArtifacts(args[0])
    break
  case 'smoke-artifacts':
    await smokeArtifactsCommand(args)
    break
  default:
    fail('usage: node script/release.mjs <gap|bump|checksums|verify-artifacts|smoke-artifacts> [args]\nSee docs/release.md for the full recipe.')
}
