import assert from 'node:assert/strict'
import { test } from 'node:test'

import { notarizationCredentials, preflightProblems } from './preflight-notarize.mjs'

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

test('an incomplete credential set does not count', () => {
  const problems = preflightProblems({
    env: { APPLE_ID: 'x@y.z', APPLE_TEAM_ID: 'TEAM01' },
    identities: IDENTITY,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /APPLE_APP_SPECIFIC_PASSWORD/)
})

test('CSC_LINK stands in for the keychain but needs its password', () => {
  const base = { APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' }
  assert.deepEqual(
    preflightProblems({
      env: { ...base, CSC_LINK: 'file.p12', CSC_KEY_PASSWORD: 'p' },
      identities: '0 valid identities found',
    }),
    [],
  )
  const problems = preflightProblems({
    env: { ...base, CSC_LINK: 'file.p12' },
    identities: '0 valid identities found',
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /CSC_KEY_PASSWORD/)
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
