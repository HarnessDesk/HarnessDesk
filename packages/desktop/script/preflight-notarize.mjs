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

/**
 * The problems, from names alone. `identities` is the output of
 * `security find-identity -v -p codesigning`; null means the keychain could
 * not be asked (not macOS, or `security` failed) and the check is skipped
 * with a note rather than failed.
 */
export const preflightProblems = ({ env, identities }) => {
  const problems = []

  const hasApiKey = Boolean(env['APPLE_API_KEY'] && env['APPLE_API_KEY_ID'] && env['APPLE_API_ISSUER'])
  const hasAppleId = Boolean(
    env['APPLE_ID'] && env['APPLE_APP_SPECIFIC_PASSWORD'] && env['APPLE_TEAM_ID'],
  )
  if (!hasApiKey && !hasAppleId) {
    problems.push(
      'No notarization credentials. Set either APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.',
    )
  }

  const linked = Boolean(env['CSC_LINK'])
  if (linked && !env['CSC_KEY_PASSWORD']) {
    problems.push('CSC_LINK is set but CSC_KEY_PASSWORD is not; the certificate cannot be opened.')
  }
  if (!linked && identities !== null && !identities.includes('Developer ID Application')) {
    problems.push(
      'No "Developer ID Application" identity in the keychain, and no CSC_LINK. Signing would fall back to ad-hoc, which notarization rejects.',
    )
  }

  return problems
}

const main = () => {
  let identities = null
  try {
    identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    })
  } catch {
    // Not macOS, or `security` refused — electron-builder will say its piece.
  }

  const problems = preflightProblems({ env: process.env, identities })
  if (problems.length === 0) {
    console.log('Notarization preflight: credentials and signing identity look present.')
    return
  }
  console.error('A notarized release cannot be built yet:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\ninternal/docs/releasing.md walks through every value.')
  process.exit(1)
}

// Runnable and importable: the test imports `preflightProblems`, the script
// entry runs the checks.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main()
