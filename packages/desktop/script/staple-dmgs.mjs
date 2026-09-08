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
 *   pnpm run dist:notarized            # build, notarize, and staple
 *   node script/staple-dmgs.mjs        # stapling alone, over release/
 *   node script/staple-dmgs.mjs <dir>  # ... or over some other directory
 *
 * The directory is resolved from this file, not from the working directory, so
 * the second form works from the workspace root as well as from here.
 *
 * Credentials come from the environment — APPLE_ID with
 * APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or an App Store Connect API
 * key — and are never printed.
 *
 * The signing identity comes from the keychain, and on CI that is a keychain
 * the release workflow makes for the job. electron-builder imports CSC_LINK
 * into a keychain of its own and destroys it when the build finishes
 * (`app-builder-lib` does `disposeOnBuildFinish(() => removeKeychain(...))`),
 * so nothing it imported is still there by the time this runs.
 *
 * Everything above was reasoning until 2026-09-08, when `dist:notarized` was
 * run end to end against Apple's real notary service. Both DMGs were signed
 * here, submitted, and came back Accepted; `stapler validate` then found a
 * ticket on each file, `spctl` answered `source=Notarized Developer ID`, and
 * `latest-mac.yml` matched the sha512 and the byte count of the stapled images
 * afterwards. Ten minutes for the whole chain.
 *
 * That is the offline case proved rather than argued: a ticket on the file is
 * what makes a first launch work on a machine that cannot reach Apple, and
 * before this pass existed there was none on any DMG we shipped.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  apiKeyIsUsable,
  developerIdIdentity,
  keychainIdentities,
  notarizationCredentials,
} from './preflight-notarize.mjs'

/**
 * Every tool run here says what matters on stderr: `codesign` and `spctl`
 * write their verdict there whether they pass or fail, and `notarytool` writes
 * Apple's rejection and the log request UUID there. So both streams reach the
 * log, and a non-zero exit throws — a failed step still fails the release,
 * with Apple's own reason still on the log rather than
 * `Command failed: xcrun notarytool ...` and nothing else.
 *
 * Inherited rather than piped, because nothing here reads the output back and
 * a pipe holds it: `notarytool submit --wait` is ten minutes during which a
 * piped run prints nothing at all, so a release log cannot be told apart from
 * a hung one until it ends.
 */
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? `on signal ${result.signal}`}`)
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

/* ------------------------------------------------------------------ *
 * The manifest rewrite.
 * ------------------------------------------------------------------ */

const ENTRY = /^(\s*)-(\s+)/

/** A scalar as written, with the quotes YAML may have put around it removed. */
const unquote = (value) => {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === "'" || quote === '"') && trimmed.length > 1 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Where `key` is set within `[from, to)`, and what it is set to. */
const findKey = (lines, from, to, key) => {
  const pattern = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`)
  for (let index = from; index < to; index += 1) {
    const match = pattern.exec(lines[index])
    if (match) return { index, value: unquote(match[1]) }
  }
  return null
}

/**
 * Rewrite one key's value in place, keeping everything to the left of it — the
 * indentation, a leading `- `, the key itself. A function replacement rather
 * than `$1`, because a value is data and `$&` in data is not a placeholder.
 */
const setKey = (lines, index, key, value) => {
  const pattern = new RegExp(`^(\\s*(?:-\\s+)?${key}:\\s*).*$`)
  lines[index] = lines[index].replace(pattern, (_, head) => `${head}${value}`)
}

/** The line ranges of the entries under a top-level `key:` sequence. */
const sequenceEntries = (lines, key) => {
  const head = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line))
  if (head === -1) return []

  // The sequence runs to the first line that is neither blank nor indented.
  let end = head + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1

  // An entry begins at each `-` written at the sequence's own indentation;
  // anything indented further belongs to the entry above it. The indentation
  // is taken from the first `-` anywhere in the sequence rather than from the
  // line straight after `files:`, which is not always one: a blank line or a
  // comment there used to make the whole sequence unreadable, and a rewrite
  // that reads structure in order to stop caring about formatting should not
  // then fail on a formatting choice electron-builder is free to make.
  const starts = []
  let indent
  for (let index = head + 1; index < end; index += 1) {
    const found = ENTRY.exec(lines[index])?.[1]
    if (found === undefined) continue
    if (indent === undefined) indent = found
    if (found === indent) starts.push(index)
  }
  return starts.map((from, i) => ({ from, to: starts[i + 1] ?? end }))
}

/** The indentation a sibling key of an entry's first key is written at. */
const siblingIndent = (head) => {
  const match = ENTRY.exec(head)
  return match ? ' '.repeat(match[1].length + 1 + match[2].length) : '    '
}

/**
 * Point `latest-mac.yml` at the bytes that now exist: for each `{ url, sha512,
 * size }` given, rewrite that file's row.
 *
 * Structural rather than a regex over `url` → `sha512` → `size` in that order
 * with that spacing. The manifest is electron-builder's output, and the shape
 * of it is not a promise anyone made us; a rewrite that reads the sequence and
 * finds the keys does not care which order they come in, whether a row carries
 * a `blockMapSize` beside them, or how deep the indentation goes.
 *
 * `missing` names the files that have no row to repair. The caller decides
 * what that means — it means the release, and it is fatal — but this function
 * only reports, so a test can ask it the question without catching an exit.
 */
export const repairManifest = (manifest, files) => {
  const lines = manifest.split('\n')
  const missing = []
  const repaired = new Set()

  for (const file of files) {
    // Recomputed per file: inserting a missing `size:` shifts every line
    // beneath it, and stale ranges are how a rewrite lands in the wrong row.
    const entries = sequenceEntries(lines, 'files')
    const entry = entries.find(
      ({ from, to }) => findKey(lines, from, to, 'url')?.value === file.url,
    )
    const hash = entry && findKey(lines, entry.from, entry.to, 'sha512')
    if (!entry || !hash) {
      missing.push(file.url)
      continue
    }

    setKey(lines, hash.index, 'sha512', file.sha512)
    const size = findKey(lines, entry.from, entry.to, 'size')
    if (size) setKey(lines, size.index, 'size', String(file.size))
    else lines.splice(hash.index + 1, 0, `${siblingIndent(lines[entry.from])}size: ${file.size}`)
    repaired.add(file.url)
  }

  // The top-level `path` and `sha512` are the same information again, kept for
  // electron-updater 1.x. electron-builder sorts the zip to the front of the
  // sequence on macOS and copies the first row up here, so they normally
  // describe a file this script never touches — but a build configured without
  // a zip target would put a DMG there, and stapling would leave it as stale
  // as the row below. Repaired when it is one of ours, left alone when it is
  // not, rather than assumed either way.
  const path = lines.findIndex((line) => /^path:\s/.test(line))
  const top = lines.findIndex((line) => /^sha512:\s/.test(line))
  if (path !== -1 && top !== -1) {
    const url = unquote(/^path:\s*(.*)$/.exec(lines[path])[1])
    const file = repaired.has(url) && files.find((candidate) => candidate.url === url)
    if (file) setKey(lines, top, 'sha512', file.sha512)
  }

  return { manifest: lines.join('\n'), missing }
}

/* ------------------------------------------------------------------ *
 * The pass itself.
 * ------------------------------------------------------------------ */

/**
 * The directory to work over: the argument if one was given, else `release/`
 * beside this script.
 *
 * From this file rather than from the working directory. `'release'` on its
 * own is only a directory when the pass is run from `packages/desktop`; run
 * from the workspace root it is nothing, and the whole thing died on an ENOENT
 * that named neither what was looked for nor where.
 */
export const releaseDirectory = (argv) =>
  argv[2] ? resolve(argv[2]) : fileURLToPath(new URL('../release', import.meta.url))

const main = () => {
  const release = releaseDirectory(process.argv)

  let names
  try {
    names = readdirSync(release)
  } catch {
    console.error(`No release directory at ${release}.`)
    console.error('Build one first — `pnpm run dist:notarized` from packages/desktop.')
    process.exit(1)
  }

  const dmgs = names.filter((name) => name.endsWith('.dmg'))
  if (dmgs.length === 0) {
    console.error(`No DMGs in ${release}. Nothing to staple.`)
    process.exit(1)
  }

  // Idempotent on purpose: a DMG that already validates is left alone, so a
  // re-run after a partial failure does not spend ten minutes and a
  // notarization slot re-doing the ones that already worked. The manifest is
  // still repaired below either way.
  const targets = dmgs.map((name) => {
    const path = join(release, name)
    return { name, path, stapled: isStapled(path) }
  })

  // Whichever credential the environment carries — the same resolver
  // `preflight-notarize.mjs` checks with, so a build that passed preflight
  // cannot fail here for want of a flag this script did not know about.
  const credentials = notarizationCredentials(process.env)

  // Everything this pass needs, asked before it touches a file. Only when
  // something actually needs signing: a re-run over DMGs that already validate
  // wants neither an identity nor a credential.
  //
  // Both used to be asked later, and the second of them after the first
  // `codesign` — which rewrites the DMG in place, so a missing credential left
  // a signed, unnotarized, half-processed disk image behind on the way out.
  if (targets.some((target) => !target.stapled)) {
    // Rather than inside `codesign`, which answers a missing identity with one
    // line about no identity found and no hint as to why there is none on a
    // machine that just built a signed app. There is none because
    // electron-builder deleted the keychain it made from CSC_LINK when the
    // build finished. Skipped where the keychain cannot be read at all — that
    // is not macOS, and the `xcrun` calls below will say so far more clearly.
    if (developerIdIdentity(keychainIdentities()) === 'absent') {
      console.error('\nNo "Developer ID Application" identity in the keychain.')
      console.error('electron-builder imports CSC_LINK into a keychain of its own and destroys')
      console.error('it when the build finishes, so a certificate passed to the build alone is')
      console.error('already gone by now. Import it into a keychain that outlives the build —')
      console.error('the release workflow does this in its "Import signing certificate" step.')
      process.exit(1)
    }

    if (credentials.kind === null) {
      console.error('\nNo notarization credentials in the environment.')
      console.error('Set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,')
      console.error('or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.')
      process.exit(1)
    }

    // Having a credential is not the same as being able to use it. Run under
    // `dist:notarized` the preflight has already asked this, but this script
    // is also run on its own, and there `notarytool` was the first thing to
    // notice — one `codesign --force` too late to leave the DMG alone.
    if (!apiKeyIsUsable(process.env)) {
      console.error('\nAPPLE_API_KEY does not name a file that exists.')
      console.error('`notarytool --key` reads the .p8 off disk; a key held as text')
      console.error('has to be written to a file first, and the variable set to its path.')
      process.exit(1)
    }
  }

  // Read now, repaired at the end. `latest-mac.yml` is as much a precondition
  // as the identity and the credentials: without it there is nothing to point
  // at the new bytes, and the release is over whether that is discovered now
  // or in half an hour. It used to be discovered in half an hour — after every
  // DMG had been signed, submitted, waited on and stapled — which is a long
  // way to travel to fail on a file that was missing before any of it started.
  const manifestPath = join(release, 'latest-mac.yml')
  let manifest
  try {
    manifest = readFileSync(manifestPath, 'utf8')
  } catch {
    // Fail closed. `latest-mac.yml` is the file electron-updater fetches and
    // the workflow publishes it; a release without it is one the updater
    // cannot read. Returning success here would ship exactly that, quietly.
    console.error(`\n${manifestPath} is missing. There is nothing to repair,`)
    console.error('and a release without it is one electron-updater cannot read.')
    process.exit(1)
  }

  // And the rows in it, asked with the very lookup that will do the repair so
  // the two cannot come to disagree about what a row is. A stray DMG left in
  // `release/` by an earlier build has none, which is fatal — and used to be
  // fatal only after every disk image had been signed, submitted, waited on
  // and stapled. The values here are placeholders; only `missing` is read.
  const rowless = repairManifest(
    manifest,
    targets.map(({ name }) => ({ url: name, sha512: '', size: 0 })),
  ).missing
  if (rowless.length > 0) {
    for (const url of rowless) console.error(`\n  ${url}: no row in latest-mac.yml.`)
    console.error('  Every DMG here has to be one the manifest describes, or the release')
    console.error('  would carry stale hashes for the ones it does not.')
    process.exit(1)
  }

  for (const { name, path, stapled } of targets) {
    console.log(`\n=== ${name}`)

    if (stapled) {
      console.log('- already stapled, skipping sign/notarize')
      run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', path])
      continue
    }

    // Prefix match: there is one Developer ID Application identity on a
    // release machine, and naming the team in CI would hard-code it here.
    console.log('- signing')
    run('codesign', ['--force', '--sign', 'Developer ID Application', '--timestamp', path])

    console.log(`- notarizing (${credentials.kind})`)
    run('xcrun', ['notarytool', 'submit', path, ...credentials.args, '--wait', '--timeout', '30m'])

    console.log('- stapling')
    run('xcrun', ['stapler', 'staple', path])

    // The proof, not the hope: a staple that did not take fails the release
    // here rather than on a stranger's laptop.
    run('xcrun', ['stapler', 'validate', path])
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', path])
  }

  // Repair the manifest: only the DMG rows moved, but they moved on every DMG.
  console.log('\n=== repairing latest-mac.yml DMG hashes')
  const files = targets.map(({ name, path }) => ({
    url: name,
    sha512: sha512(path),
    size: statSync(path).size,
  }))
  const repair = repairManifest(manifest, files)
  if (repair.missing.length > 0) {
    // Unreachable by the check above, which asked the same question of the
    // same manifest before any of this ran. Kept because it is the one
    // guarding the write: a DMG whose row cannot be found keeps the hash it
    // had before stapling, and writing anyway publishes a manifest that
    // disagrees with the bytes.
    for (const url of repair.missing) console.error(`  ${url}: no row in latest-mac.yml.`)
    console.error('  The manifest cannot be repaired, so the release would carry stale hashes.')
    process.exit(1)
  }
  for (const { url, size } of files) console.log(`  ${url}: size ${size}`)
  writeFileSync(manifestPath, repair.manifest)
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
  for (const { name } of targets) {
    const blockmap = join(release, `${name}.blockmap`)
    try {
      rmSync(blockmap)
      console.log(`removed ${name}.blockmap — stapling invalidated it`)
    } catch {
      // Never written, or already gone. Either way there is nothing stale.
    }
  }
}

// Runnable and importable: the test imports `repairManifest`, the script entry
// runs the pass.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
