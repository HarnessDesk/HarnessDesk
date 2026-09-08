import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  developerIdIdentity,
  notarizationCredentials,
  preflightProblems,
} from './preflight-notarize.mjs'

/**
 * The release preflight's judgement. What matters: every missing piece is
 * named in one pass, either credential route satisfies it, and an unreadable
 * keychain is a skipped check, not a failed one.
 */

const IDENTITY = '  1) ABC123 "Developer ID Application: Someone (TEAM01)"\n     1 valid identities found'

test('an empty environment names both gaps at once', () => {
  const problems = preflightProblems({ env: {}, identities: '0 valid identities found' })
  assert.equal(problems.length, 2)
  assert.match(problems[0], /APPLE_ID/)
  assert.match(problems[1], /Developer ID Application/)
})

test('either credential route satisfies notarization', () => {
  const appleId = {
    APPLE_ID: 'x@y.z',
    APPLE_APP_SPECIFIC_PASSWORD: 'p',
    APPLE_TEAM_ID: 'TEAM01',
  }
  const apiKey = { APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }
  assert.deepEqual(preflightProblems({ env: appleId, identities: IDENTITY }), [])
  assert.deepEqual(preflightProblems({ env: apiKey, identities: IDENTITY }), [])
})

test('an incomplete credential set does not count, and is named twice over', () => {
  const problems = preflightProblems({
    env: { APPLE_ID: 'x@y.z', APPLE_TEAM_ID: 'TEAM01' },
    identities: IDENTITY,
  })
  // Two, because a half-set Apple ID pair is two separate things wrong: it is
  // not a usable credential here, and it is a hard error inside
  // electron-builder before it looks at anything else.
  assert.equal(problems.length, 2)
  assert.match(problems[0], /APPLE_APP_SPECIFIC_PASSWORD/)
  assert.match(problems[1], /set together or not at all/)
})

/*
 * Where this script and electron-builder disagree. electron-builder reads
 * `APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD` before it looks at an API key at
 * all, and throws if only one of them is there. This script prefers the API
 * key — for a good reason, `notarytool` puts a password in argv — so the two
 * read the same environment and reach different answers, and both cases below
 * were a green preflight followed by a failure the preflight was for.
 */

test('a stray APPLE_ID is not rescued by a complete API key', () => {
  const problems = preflightProblems({
    env: {
      APPLE_ID: 'x@y.z',
      APPLE_API_KEY: '/k.p8',
      APPLE_API_KEY_ID: 'K1',
      APPLE_API_ISSUER: 'I1',
    },
    identities: IDENTITY,
  })
  // The resolver is perfectly happy: it falls through to the key.
  assert.equal(notarizationCredentials({ APPLE_ID: 'x@y.z', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }).kind, 'api-key')
  // electron-builder is not, and says so by throwing. So this does too.
  assert.equal(problems.length, 1)
  assert.match(problems[0], /APPLE_TEAM_ID have to be set together/)
})

test('and neither is a pair missing only the team id', () => {
  // The first version of the check above compared APPLE_ID against
  // APPLE_APP_SPECIFIC_PASSWORD and stopped there, so a pair with no
  // APPLE_TEAM_ID read as consistent and passed. electron-builder throws for
  // that one too — `MacTargetHelper.js:230` — after the same trigger.
  const problems = preflightProblems({
    env: {
      APPLE_ID: 'x@y.z',
      APPLE_APP_SPECIFIC_PASSWORD: 'p',
      APPLE_API_KEY: '/k.p8',
      APPLE_API_KEY_ID: 'K1',
      APPLE_API_ISSUER: 'I1',
    },
    identities: IDENTITY,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /APPLE_TEAM_ID/)
})

test('APPLE_TEAM_ID on its own is not a partly-set Apple ID route', () => {
  // electron-builder tests `appleId || appleIdPassword` — a team id alone
  // never enters that branch, and this workflow sets one either way.
  const env = { APPLE_TEAM_ID: 'TEAM01', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }
  assert.deepEqual(preflightProblems({ env, identities: IDENTITY }), [])
})

test('two complete routes are two answers, not two chances', () => {
  const problems = preflightProblems({
    env: {
      APPLE_ID: 'x@y.z',
      APPLE_APP_SPECIFIC_PASSWORD: 'p',
      APPLE_TEAM_ID: 'TEAM01',
      APPLE_API_KEY: '/k.p8',
      APPLE_API_KEY_ID: 'K1',
      APPLE_API_ISSUER: 'I1',
    },
    identities: IDENTITY,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /one release would go out under two credentials/)
})

test('a directory is not a key file', () => {
  const env = { APPLE_API_KEY: '/some/dir', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }
  // What `isFile` is for: `existsSync` says yes to a directory, and
  // `notarytool --key` given one fails exactly as it does on a missing file.
  const problems = preflightProblems({ env, identities: IDENTITY, isFile: () => false })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must be the path/)
})

test('CSC_LINK still needs its password', () => {
  const base = { APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }
  const problems = preflightProblems({
    env: { ...base, CSC_LINK: 'file.p12' },
    identities: IDENTITY,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /CSC_KEY_PASSWORD/)
})

/*
 * And does *not* stand in for the keychain, which is what this file said until
 * `dist:notarized` grew a third command. The chain is preflight, then
 * electron-builder, then `staple-dmgs.mjs` — and stapling signs each DMG with
 * a plain `codesign` out of the keychain. electron-builder imports CSC_LINK
 * into a keychain of its own and destroys it when the build finishes, so
 * CSC_LINK on its own bought a green preflight, a fifteen-minute build, and a
 * failure at the first DMG: the exact ten-minutes-late failure this script is
 * here to move to the front.
 */

test('CSC_LINK does not excuse an empty keychain, because stapling follows the build', () => {
  const problems = preflightProblems({
    env: {
      APPLE_API_KEY: '/k.p8',
      APPLE_API_KEY_ID: 'K1',
      APPLE_API_ISSUER: 'I1',
      CSC_LINK: 'file.p12',
      CSC_KEY_PASSWORD: 'p',
    },
    identities: '0 valid identities found',
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Developer ID Application/)
  assert.match(problems[0], /stapling/)
})

test('the three answers about a signing identity', () => {
  assert.equal(developerIdIdentity(IDENTITY), 'present')
  assert.equal(developerIdIdentity('0 valid identities found'), 'absent')
  // Not "absent". A keychain that could not be read is a check to skip, and
  // reading it as a missing certificate would fail every non-macOS run.
  assert.equal(developerIdIdentity(null), 'unknown')
})

/*
 * `notarytool --key` takes a path: "File system path to the private key", in
 * the tool's own help. A secret holding the .p8's text — the obvious way to
 * put a key in a secret, and how the certificate beside it is stored — passes
 * every check that asks only whether the name is set, and fails at submission.
 */

test('an API key that is not a file is caught before the build, not after it', () => {
  // Shaped like the thing it stands for, so the assertion below means what it
  // says: a header with nothing behind it.
  const key = '-----BEGIN PRIVATE KEY-----' // hd-secrets-ok
  const env = { APPLE_API_KEY: key, APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }
  const problems = preflightProblems({ env, identities: IDENTITY, isFile: () => false })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /APPLE_API_KEY must be the path/)
  // Never the value: if it is wrong, it is wrong because it is the key itself.
  assert.ok(!problems[0].includes(key))
  assert.deepEqual(preflightProblems({ env, identities: IDENTITY, isFile: () => true }), [])
})

test('the Apple ID route is not asked for a file that does not apply to it', () => {
  const env = { APPLE_ID: 'x@y.z', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'TEAM01' }
  assert.deepEqual(preflightProblems({ env, identities: IDENTITY, isFile: () => false }), [])
})

test('an unaskable keychain skips the identity check rather than failing it', () => {
  const env = { APPLE_ID: 'x@y.z', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'TEAM01' }
  assert.deepEqual(preflightProblems({ env, identities: null }), [])
})

/*
 * The resolver `staple-dmgs.mjs` shares. These pin the trap that produced it:
 * preflight accepted an API key while stapling passed `--apple-id`, so taking
 * the advice preflight printed bought a green check and a failure one step
 * later. The two now read the same environment through the same function.
 */

test('an API key becomes notarytool key arguments', () => {
  const { kind, args } = notarizationCredentials({
    APPLE_API_KEY: '/k.p8',
    APPLE_API_KEY_ID: 'K1',
    APPLE_API_ISSUER: 'I1',
  })
  assert.equal(kind, 'api-key')
  assert.deepEqual(args, ['--key', '/k.p8', '--key-id', 'K1', '--issuer', 'I1'])
})

test('an Apple ID becomes notarytool password arguments', () => {
  const { kind, args } = notarizationCredentials({
    APPLE_ID: 'x@y.z',
    APPLE_APP_SPECIFIC_PASSWORD: 'p',
    APPLE_TEAM_ID: 'TEAM01',
  })
  assert.equal(kind, 'apple-id')
  assert.deepEqual(args, ['--apple-id', 'x@y.z', '--password', 'p', '--team-id', 'TEAM01'])
})

test('the API key wins where both are set, and never mixes flags', () => {
  const { kind, args } = notarizationCredentials({
    APPLE_ID: 'x@y.z',
    APPLE_APP_SPECIFIC_PASSWORD: 'p',
    APPLE_TEAM_ID: 'TEAM01',
    APPLE_API_KEY: '/k.p8',
    APPLE_API_KEY_ID: 'K1',
    APPLE_API_ISSUER: 'I1',
  })
  assert.equal(kind, 'api-key')
  assert.ok(!args.includes('--password'))
  assert.ok(!args.includes('--apple-id'))
})

test('nothing resolves to nothing, so no empty flags are ever sent', () => {
  const { kind, args } = notarizationCredentials({ APPLE_ID: 'x@y.z' })
  assert.equal(kind, null)
  assert.deepEqual(args, [])
})

test('whatever preflight accepts, stapling can also use', () => {
  const IDENTITY_OK = IDENTITY
  for (const env of [
    { APPLE_ID: 'x@y.z', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'TEAM01' },
    { APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' },
  ]) {
    assert.deepEqual(preflightProblems({ env, identities: IDENTITY_OK }), [])
    assert.notEqual(notarizationCredentials(env).kind, null)
  }
})
