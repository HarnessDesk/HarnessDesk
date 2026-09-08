#!/usr/bin/env node
/**
 * What a notarized release needs, checked before electron-builder spends ten
 * minutes finding out the hard way.
 *
 * `dist:notarized` runs this first. It never sees a secret's value — only
 * which names are set — and it prints every missing piece at once rather than
 * failing on the first, because the person fixing this is copying names into
 * a shell one screen away.
 *
 * The checks mirror what `dist:notarized` will do with the same environment —
 * the whole chain, not just the build: electron-builder signs and notarizes
 * the `.app`, and then `staple-dmgs.mjs` signs, submits and staples each DMG.
 * Both need a Developer ID Application identity and one of the two credential
 * routes, and the second needs the identity in the *keychain*.
 */

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * The keychain's codesigning identities as `security` prints them, or null
 * where the keychain could not be asked at all — not macOS, or `security`
 * refused. Null is "unknown", never "none".
 */
export const keychainIdentities = () => {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    })
  } catch {
    // Not macOS, or `security` refused — electron-builder will say its piece.
    return null
  }
}

/**
 * Whether a Developer ID Application identity is there to sign with, over the
 * output above. Three answers rather than two, because "the keychain could not
 * be read" is not "the certificate is missing": one is a check to skip, the
 * other is a release that cannot be signed. `staple-dmgs.mjs` asks the same
 * question of the same output, so a build electron-builder can sign is one
 * stapling can sign too.
 */
export const developerIdIdentity = (identities) => {
  if (identities === null) return 'unknown'
  return identities.includes('Developer ID Application') ? 'present' : 'absent'
}

/**
 * Which notarization credentials the environment actually carries, and the
 * `notarytool` arguments that use them.
 *
 * One definition, because two were a trap: this script accepted an App Store
 * Connect API key while `staple-dmgs.mjs` passed `--apple-id` unconditionally,
 * so a maintainer who took the advice printed below got a green preflight, a
 * notarized `.app`, and a failure at the DMG a minute later. Whatever passes
 * here is what stapling is handed.
 *
 * The API key is preferred where both are set: `notarytool` takes the password
 * as a command-line argument, so an app-specific password is readable from
 * `ps` for the length of the build. That preference is this script's alone —
 * electron-builder reads `APPLE_ID` first — so `preflightProblems` refuses a
 * chain where both routes are configured rather than let the two disagree.
 */
const apiKeyComplete = (env) =>
  Boolean(env['APPLE_API_KEY'] && env['APPLE_API_KEY_ID'] && env['APPLE_API_ISSUER'])

const appleIdComplete = (env) =>
  Boolean(env['APPLE_ID'] && env['APPLE_APP_SPECIFIC_PASSWORD'] && env['APPLE_TEAM_ID'])

export const notarizationCredentials = (env) => {
  if (apiKeyComplete(env)) {
    return {
      kind: 'api-key',
      args: [
        '--key', env['APPLE_API_KEY'],
        '--key-id', env['APPLE_API_KEY_ID'],
        '--issuer', env['APPLE_API_ISSUER'],
      ],
    }
  }
  if (appleIdComplete(env)) {
    return {
      kind: 'apple-id',
      args: [
        '--apple-id', env['APPLE_ID'],
        '--password', env['APPLE_APP_SPECIFIC_PASSWORD'],
        '--team-id', env['APPLE_TEAM_ID'],
      ],
    }
  }
  return { kind: null, args: [] }
}

/**
 * Whether a path names a file that is really there. Exported because two
 * scripts ask it of the same environment variable, and `existsSync` is not the
 * question: `notarytool --key` given a directory fails the way it fails on a
 * key that is not there at all.
 */
export const isRealFile = (path) => {
  try {
    return Boolean(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Whether the API-key route, if that is the route, names a key file that
 * exists. `notarytool --key` takes a path — "File system path to the private
 * key", in its own help — so a secret holding the .p8's text satisfies every
 * check that only asks whether the name is set and fails at submission.
 *
 * `staple-dmgs.mjs` asks this too, and asks it before it signs anything: by
 * the time `notarytool` rejects the path, `codesign --force` has already
 * rewritten the disk image.
 */
export const apiKeyIsUsable = (env, isFile = isRealFile) =>
  notarizationCredentials(env).kind !== 'api-key' || isFile(env['APPLE_API_KEY'])

export const preflightProblems = ({ env, identities, isFile = () => true }) => {
  const problems = []

  const credentials = notarizationCredentials(env)
  if (credentials.kind === null) {
    problems.push(
      'No notarization credentials. Set either APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.',
    )
  }

  // The value is never printed: if it is wrong, it is wrong because it is the
  // private key itself.
  if (!apiKeyIsUsable(env, isFile)) {
    problems.push(
      'APPLE_API_KEY must be the path to the App Store Connect .p8 key file, and nothing exists at the path it holds. `notarytool --key` reads a file; a secret carrying the key text fails at submission. Write it to a file first and point APPLE_API_KEY at that.',
    )
  }

  // electron-builder never reaches the API key with a partly-set Apple ID
  // route: it tests `appleId || appleIdPassword` and then throws for whichever
  // of the *three* is missing — `MacTargetHelper.js` throws on the team id at
  // line 230, which the first version of this check did not know about, so
  // APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD without APPLE_TEAM_ID still
  // passed here and still died in the build. The trigger is the first two
  // only, because that is what electron-builder tests: APPLE_TEAM_ID alone —
  // which this workflow sets — never enters that branch.
  if ((env['APPLE_ID'] || env['APPLE_APP_SPECIFIC_PASSWORD']) && !appleIdComplete(env)) {
    problems.push(
      'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID have to be set together or not at all. electron-builder throws for whichever is missing as soon as it sees either of the first two, before it looks at an API key at all, so a complete API key does not rescue a partly-set Apple ID.',
    )
  }

  // Both complete is not two chances, it is two answers. electron-builder
  // takes the Apple ID for the `.app`; this script takes the API key for the
  // DMGs. Both notarize, and the halves of one release go up signed off by
  // different credentials — which is the sort of thing nobody discovers
  // deliberately. One route, chosen here rather than twice by accident.
  if (apiKeyComplete(env) && appleIdComplete(env)) {
    problems.push(
      'Both notarization routes are configured. electron-builder notarizes the .app with APPLE_ID while stapling notarizes the DMGs with the API key, so one release would go out under two credentials. Set one route and unset the other; the API key is the better one to keep.',
    )
  }

  if (env['CSC_LINK'] && !env['CSC_KEY_PASSWORD']) {
    problems.push('CSC_LINK is set but CSC_KEY_PASSWORD is not; the certificate cannot be opened.')
  }

  // Asked whatever CSC_LINK says, because the chain does not end at the build
  // any more. electron-builder imports CSC_LINK into a keychain of its own and
  // destroys it when the build finishes; `staple-dmgs.mjs` runs next and signs
  // each DMG with a plain `codesign` out of the keychain. CSC_LINK alone got a
  // green preflight, a fifteen-minute build, and a failure at the first DMG.
  if (developerIdIdentity(identities) === 'absent') {
    problems.push(
      'No "Developer ID Application" identity in the keychain. CSC_LINK does not stand in for it: electron-builder imports that into a keychain of its own and destroys it when the build ends, and the DMG stapling that follows signs out of the keychain.',
    )
  }

  return problems
}

const main = () => {
  const problems = preflightProblems({
    env: process.env,
    identities: keychainIdentities(),
    isFile: isRealFile,
  })
  if (problems.length === 0) {
    console.log('Notarization preflight: credentials and signing identity look present.')
    return
  }
  console.error('A notarized release cannot be built yet:\n')
  for (const problem of problems) console.error(`  - ${problem}`)

  // Only when there is no credential at all. Printed against a certificate
  // problem it reads as "your credentials were not recognised" to someone
  // whose credentials are fine, and sends them to regenerate a working one.
  if (notarizationCredentials(process.env).kind === null) {
    console.error(
      '\nApp-specific passwords are made at appleid.apple.com under Sign-In and Security;',
    )
    console.error(
      'App Store Connect API keys at appstoreconnect.apple.com under Users and Access →',
    )
    console.error(
      'Integrations. Prefer the API key: notarytool takes the password as an argument, so',
    )
    console.error('an app-specific password is readable from `ps` for the length of the build.')
  }
  process.exit(1)
}

// Runnable and importable: the test imports `preflightProblems`, the script
// entry runs the checks. Compared as full URLs — matching on the basename
// alone would also fire for any other file of the same name.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
