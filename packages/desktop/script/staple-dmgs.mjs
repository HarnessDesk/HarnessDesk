#!/usr/bin/env node
/**
 * The half of notarization electron-builder does not do: the DMGs.
 *
 * electron-builder notarizes the `.app`, staples the ticket to it, and *then*
 * builds a DMG around the stapled app. The DMG that comes out is a container
 * Apple has never seen: it carries no signature of its own and no ticket, so
 * `stapler staple` on it answers "Record not found" — there is no ticket to
 * fetch, because nothing was ever submitted under that hash.
 *
 * It still installs, because Gatekeeper falls back to an online check of the
 * app inside. It fails on a machine that is offline or behind a firewall that
 * cannot reach Apple, which is exactly the first-run moment a release cannot
 * afford to get wrong. So each DMG is signed, submitted and stapled here.
 *
 * Then the manifest is repaired. `latest-mac.yml` is written during the build
 * with the hashes the DMGs had *before* any of this, and signing and stapling
 * both rewrite the file. Left alone the manifest advertises hashes that no
 * longer match the bytes being served. electron-updater takes the `.zip` on
 * macOS and would not notice, which is precisely why this rots quietly.
 *
 *   node script/staple-dmgs.mjs        # from packages/desktop
 *
 * Credentials come from the environment — APPLE_ID with
 * APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID — and are never printed.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RELEASE = 'release'

// stderr is merged rather than piped separately: `codesign` and `spctl` say
// everything worth reading there, and a release log that swallows the
// assessment is a log that cannot be checked afterwards.
const run = (command, args, { quiet = false } = {}) => {
  const out = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!quiet && out) process.stdout.write(out)
  return out
}

/**
 * Same, but for `codesign` and `spctl`, which write their verdict to stderr
 * whether they pass or fail. Both streams are printed either way; a non-zero
 * exit still throws, so a failed assessment still fails the release.
 */
const runShowingStderr = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}`)
  }
}

/** Base64 SHA-512, the encoding `latest-mac.yml` uses. */
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')

/** Whether this file already carries a ticket. Non-zero exit means it does not. */
const isStapled = (path) => {
  try {
    execFileSync('xcrun', ['stapler', 'validate', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const main = () => {
  const dmgs = readdirSync(RELEASE).filter((f) => f.endsWith('.dmg'))
  if (dmgs.length === 0) {
    console.error('No DMGs in release/. Nothing to staple.')
    process.exit(1)
  }

  for (const name of dmgs) {
    const path = join(RELEASE, name)
    console.log(`\n=== ${name}`)

    // Idempotent on purpose: a DMG that already validates is left alone, so
    // a re-run after a partial failure does not spend ten minutes and a
    // notarization slot re-doing the ones that already worked. The manifest
    // is still repaired below either way.
    if (isStapled(path)) {
      console.log('- already stapled, skipping sign/notarize')
      runShowingStderr('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', path])
      continue
    }

    // Prefix match: there is one Developer ID Application identity on a
    // release machine, and naming the team in CI would hard-code it here.
    console.log('- signing')
    runShowingStderr('codesign', ['--force', '--sign', 'Developer ID Application', '--timestamp', path])

    console.log('- notarizing')
    run('xcrun', [
      'notarytool',
      'submit',
      path,
      '--apple-id',
      process.env['APPLE_ID'] ?? '',
      '--password',
      process.env['APPLE_APP_SPECIFIC_PASSWORD'] ?? '',
      '--team-id',
      process.env['APPLE_TEAM_ID'] ?? '',
      '--wait',
      '--timeout',
      '30m',
    ])

    console.log('- stapling')
    run('xcrun', ['stapler', 'staple', path])

    // The proof, not the hope: a staple that did not take fails the release
    // here rather than on a stranger's laptop.
    run('xcrun', ['stapler', 'validate', path])
    runShowingStderr('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', path])
  }

  // Repair the manifest: only the DMG rows moved, but they moved on every DMG.
  const manifestPath = join(RELEASE, 'latest-mac.yml')
  let manifest
  try {
    manifest = readFileSync(manifestPath, 'utf8')
  } catch {
    // Fail closed. `latest-mac.yml` is the file electron-updater fetches and
    // the workflow publishes it; a release without it is one the updater
    // cannot read. Returning success here would ship exactly that, quietly.
    console.error('\nrelease/latest-mac.yml is missing. The DMGs are stapled, but')
    console.error('the manifest that describes them is not there to repair.')
    process.exit(1)
  }

  console.log('\n=== repairing latest-mac.yml DMG hashes')
  for (const name of dmgs) {
    const path = join(RELEASE, name)
    const hash = sha512(path)
    const size = statSync(path).size
    // The row for this file: its url line, then the sha512 and size beneath.
    const row = new RegExp(
      `(- url: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+sha512: )[^\\n]+(\\n\\s+size: )\\d+`,
    )
    if (!row.test(manifest)) {
      // Also fail closed: a DMG whose row cannot be found keeps the hash it
      // had before stapling, and a green exit publishes a manifest that
      // disagrees with the bytes. Regex drift shows up here first.
      console.error(`  ${name}: no url/sha512/size row in latest-mac.yml.`)
      console.error('  The manifest cannot be repaired, so the release would carry stale hashes.')
      process.exit(1)
    }
    manifest = manifest.replace(row, `$1${hash}$2${size}`)
    console.log(`  ${name}: size ${size}`)
  }
  writeFileSync(manifestPath, manifest)
  console.log('\nlatest-mac.yml now matches the stapled DMGs.')

  /*
   * The DMG blockmaps describe the file as it was before any of this. They are
   * written during packaging, and stapling adds roughly 11KB to each DMG, so
   * every chunk boundary and the total size in them are now wrong. There is no
   * way to repair one from here — the blockmap is electron-builder's own
   * format, produced by its packaging step — so the choice is to ship a file
   * that lies or to ship no file at all.
   *
   * Nothing loses a feature by their absence: electron-updater takes the
   * `.zip` on macOS, and those are untouched by this script, so their
   * blockmaps stay valid and differential updates keep working. A DMG is a
   * thing a person downloads once, by hand.
   */
  for (const name of dmgs) {
    const blockmap = join(RELEASE, `${name}.blockmap`)
    try {
      rmSync(blockmap)
      console.log(`removed ${name}.blockmap — stapling invalidated it`)
    } catch {
      // Never written, or already gone. Either way there is nothing stale.
    }
  }
}

main()
