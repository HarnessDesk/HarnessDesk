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
 * The checks mirror what electron-builder itself will do with the same
 * environment: sign with a Developer ID Application identity from the
 * keychain (or CSC_LINK), then notarize through notarytool with either an
 * App Store Connect API key or an Apple ID + app-specific password.
 */

import { execFileSync } from 'node:child_process'
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
 * `ps` for the length of the build.
 */
export const notarizationCredentials = (env) => {
  if (env['APPLE_API_KEY'] && env['APPLE_API_KEY_ID'] && env['APPLE_API_ISSUER']) {
    return {
      kind: 'api-key',
      args: [
        '--key', env['APPLE_API_KEY'],
        '--key-id', env['APPLE_API_KEY_ID'],
        '--issuer', env['APPLE_API_ISSUER'],
      ],
    }
  }
  if (env['APPLE_ID'] && env['APPLE_APP_SPECIFIC_PASSWORD'] && env['APPLE_TEAM_ID']) {
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

export const preflightProblems = ({ env, identities }) => {
  const problems = []

  if (notarizationCredentials(env).kind === null) {
    problems.push(
      'No notarization credentials. Set either APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.',
    )
  }

  const linked = Boolean(env['CSC_LINK'])
  if (linked && !env['CSC_KEY_PASSWORD']) {
    problems.push('CSC_LINK is set but CSC_KEY_PASSWORD is not; the certificate cannot be opened.')
  }
  if (!linked && developerIdIdentity(identities) === 'absent') {
    problems.push(
      'No "Developer ID Application" identity in the keychain, and no CSC_LINK. Signing would fall back to ad-hoc, which notarization rejects.',
    )
  }

  return problems
}

const main = () => {
  const problems = preflightProblems({ env: process.env, identities: keychainIdentities() })
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
