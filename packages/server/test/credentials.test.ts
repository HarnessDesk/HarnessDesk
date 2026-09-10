import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CredentialBroker } from '../src/credentials.js'

/**
 * The broker's one promise: values go in and never come back out through any
 * describable surface. `resolve` exists for the gateway and is tested as such.
 */

test('references out, values never; the file is private to the user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  const path = join(dir, 'credentials.json')
  const broker = new CredentialBroker(path)
  try {
    const ref = await broker.store('Anthropic', 'super-secret-value')
    assert.match(ref, /^cred_[0-9a-f]+$/)

    const described = await broker.describe()
    assert.equal(described.length, 1)
    assert.equal(described[0]!.name, 'Anthropic')
    // The whole describable surface, serialised, contains no value.
    assert.ok(!JSON.stringify(described).includes('super-secret-value'))

    const mode = (await stat(path)).mode & 0o777
    assert.equal(mode, 0o600, 'the store is readable by its owner alone')

    // resolve() — the gateway's path — returns the value…
    assert.equal(await broker.resolve(ref), 'super-secret-value')

    await broker.delete(ref)
    assert.equal((await broker.describe()).length, 0)
    await assert.rejects(broker.resolve(ref), /no longer exists/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a cipher protects the bytes at rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  const path = join(dir, 'credentials.json')
  const broker = new CredentialBroker(path, {
    protection: 'test cipher',
    encrypt: (value) => Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0x5f)),
    decrypt: (blob) => Buffer.from([...blob].map((byte) => byte ^ 0x5f)).toString('utf8'),
  })
  try {
    const ref = await broker.store('key', 'plaintext-marker')
    const raw = await readFile(path, 'utf8')
    assert.ok(!raw.includes('plaintext-marker'), 'the value is not stored as typed')
    assert.ok(!Buffer.from(raw).includes(Buffer.from('plaintext-marker').toString('base64')))
    assert.equal(await broker.resolve(ref), 'plaintext-marker')
    assert.equal(broker.protection, 'test cipher')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('empty names and empty values are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  const broker = new CredentialBroker(join(dir, 'credentials.json'))
  try {
    await assert.rejects(broker.store('  ', 'x'), /needs a name/)
    await assert.rejects(broker.store('name', ''), /protects nothing/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Two unrelated kinds of secret in one store, told apart by what was recorded
 * rather than by what the name looks like.
 *
 * A key a *route* refers to is removed with the route, or by hand from
 * Settings. A key an *agent* signs in with is cleared from that agent's own
 * page, through `runtime/apiKey/clear`, which also reloads the runtime's
 * secrets — so listing one beside the other, as an orphan with a Remove, is
 * an invitation to break an agent's sign-in. The first attempt read the kind
 * back out of the name; review pointed out that a route a user calls
 * `agent:codex:OPENAI_API_KEY` is stored as `…KEY key` and read as the
 * agent's own.
 */
test('a secret says which agent it signs in, and a route key never claims to', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const broker = new CredentialBroker(join(dir, 'credentials.json'))

  await broker.put(CredentialBroker.secretName('codex', 'OPENAI_API_KEY'), 'sk-agent', 'codex')
  const route = await broker.store('Acme proxy key', 'sk-route')
  /* The collision, spelled out: a user names an endpoint after the shape of
     an agent secret, and the dialog appends ` key`. */
  const lookalike = await broker.store('agent:codex:OPENAI_API_KEY key', 'sk-route-2')

  const listed = await broker.describe()
  const by = (ref: string) => listed.find((one) => one.ref === ref)
  assert.equal(by(route)?.agent, null)
  assert.equal(by(lookalike)?.agent, null, 'a route key is a route key whatever it is called')
  assert.equal(
    listed.find((one) => one.name === CredentialBroker.secretName('codex', 'OPENAI_API_KEY'))?.agent,
    'codex',
  )
})

test('a secret stored before the kind was recorded is still read as the agent’s', async (t) => {
  /* The migration, and the direction it has to fail in: without the fallback
     every key already on a user's disk would read as a route's on the first
     launch after this change — which is the reading that puts a Remove beside
     an agent's credentials. */
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'credentials.json')
  const broker = new CredentialBroker(path)
  // Written the way `put` wrote it before it carried the agent.
  await broker.store(CredentialBroker.secretName('claude', 'ANTHROPIC_API_KEY'), 'sk-old')
  assert.equal((await broker.describe())[0]?.agent, 'claude')
})
