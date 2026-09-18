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
 * checksums, and re-proving a signed artifact the same way a person reading
 * the release notes would.
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
 *     one that doesn't say "Notarized Developer ID".
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const bumpVersionField = (path, version) => {
  const text = readFileSync(path, 'utf8')
  const next = text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`)
  if (next === text) fail(`${path}: no "version" field matched in the expected shape — bump it by hand.`)
  writeFileSync(path, next)
  console.log(`bumped ${path}`)
}

const bump = version => {
  if (!SEMVER.test(version)) fail(`"${version}" doesn't look like X.Y.Z`)

  bumpVersionField(join(root, 'package.json'), version)
  bumpVersionField(join(root, 'packages/desktop/package.json'), version)

  const fakeHost = join(root, 'packages/ui/site-demo/fake-host.ts')
  const text = readFileSync(fakeHost, 'utf8')
  const next = text.replace(
    /const DOWNLOAD = 'https:\/\/github\.com\/HarnessDesk\/HarnessDesk\/releases\/download\/v[^']+'/,
    `const DOWNLOAD = 'https://github.com/HarnessDesk/HarnessDesk/releases/download/v${version}/HarnessDesk-${version}-arm64.dmg'`,
  )
  if (next === text) fail(`${fakeHost}: DOWNLOAD constant not found in the expected shape — update it by hand.`)
  writeFileSync(fakeHost, next)
  console.log(`bumped ${fakeHost}`)

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

const verifyArtifacts = dirArg => {
  const dir = resolve(root, dirArg ?? 'packages/desktop/release')
  const dmgs = readdirSync(dir).filter(f => f.endsWith('.dmg')).sort()
  if (dmgs.length === 0) fail(`no .dmg files in ${dir}`)

  try {
    run('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: dir, stdio: 'inherit' })
  } catch {
    fail(`\nSHA256SUMS.txt does not match what is on disk in ${dir} — stop here.`)
  }

  for (const dmg of dmgs) {
    console.log(`\n=== ${dmg}`)
    try {
      run('xcrun', ['stapler', 'validate', dmg], { cwd: dir, stdio: 'inherit' })
      run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', dmg], {
        cwd: dir,
        stdio: 'inherit',
      })
    } catch {
      fail(`\n${dmg} failed staple/notarization verification — do not publish it.`)
    }
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
  default:
    fail('usage: node script/release.mjs <gap|bump|checksums|verify-artifacts> [args]\nSee docs/release.md for the full recipe.')
}
