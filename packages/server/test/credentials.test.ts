import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CredentialBroker } from '../src/credentials.js'
import { credentialMethods } from '../src/methods/credentials.js'

const ENDPOINT = { kind: 'endpoint' } as const

/**
 * The broker's one promise: values go in and never come back out through any
 * describable surface. `resolve` exists for the gateway and is tested as such.
 */

test('references out, values never; the file is private to the user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  const path = join(dir, 'credentials.json')
  const broker = new CredentialBroker(path)
  try {
    const ref = await broker.store('Anthropic', 'super-secret-value', ENDPOINT)
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
    const ref = await broker.store('key', 'plaintext-marker', ENDPOINT)
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
    await assert.rejects(broker.store('  ', 'x', ENDPOINT), /needs a name/)
    await assert.rejects(broker.store('name', '', ENDPOINT), /protects nothing/)
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
  const route = await broker.store('Acme proxy key', 'sk-route', ENDPOINT)
  /* The collision, spelled out: a user names an endpoint after the shape of
     an agent secret, and the dialog appends ` key`. */
  const lookalike = await broker.store('agent:codex:OPENAI_API_KEY key', 'sk-route-2', ENDPOINT)

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
  // Written the way `put` wrote it before it carried the agent: no mark at all.
  const name = CredentialBroker.secretName('claude', 'ANTHROPIC_API_KEY')
  await writeFile(path, JSON.stringify({ cred_old: { name, createdAt: 1, blob: Buffer.from('sk-old').toString('base64') } }))
  assert.equal((await new CredentialBroker(path).describe())[0]?.agent, 'claude')
})

test('a key whose writer is on record is not read by its name', async (t) => {
  /* The lookalike again, without the ` key` the dialog appends: a name with
     the exact shape of an agent's secret. The name is all there is to go on
     for an entry older than the record; this one's writer is on record. */
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const broker = new CredentialBroker(join(dir, 'credentials.json'))
  const ref = await broker.store('agent:codex:OPENAI_API_KEY', 'sk-route', ENDPOINT)
  const one = (await broker.describe()).find((entry) => entry.ref === ref)
  assert.equal(one?.writer, 'endpoint')
  assert.equal(one?.agent, null)
})

test('each key is listed as its writer said, and a writer this host does not know is nobody’s', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'credentials.json')
  const blob = Buffer.from('sk').toString('base64')
  /* Two entries this host never writes: one older than the record, as a
     user's store holds them, and one a newer host wrote with a kind this one
     has never heard of. */
  await writeFile(
    path,
    JSON.stringify({
      cred_legacy: { name: 'Old proxy key', createdAt: 1, blob },
      cred_newer: { name: 'Plugin key', createdAt: 1, blob, writer: 'plugin' },
    }),
  )
  const broker = new CredentialBroker(path)
  await broker.store('Acme proxy key', 'sk-route', ENDPOINT)
  const live = await broker.store('Acme gateway key', 'sk-gw', { kind: 'gateway' })
  await broker.store('Gone gateway key', 'sk-gw-2', { kind: 'gateway' })
  await broker.put(CredentialBroker.secretName('codex', 'OPENAI_API_KEY'), 'sk-agent', 'codex')
  const ctx = {
    credentials: broker,
    accounts: { gatewayCredentials: () => [{ ref: live, name: 'Acme gateway' }] },
  }
  const listed = await credentialMethods['credentials/list'](ctx as never)
  const owner = (name: string) => listed.find((one) => one.name === name)?.owner

  assert.deepEqual(owner('Acme proxy key'), { kind: 'endpoint' })
  assert.deepEqual(owner('Old proxy key'), { kind: 'endpoint' }, 'read as it was before the record')
  assert.deepEqual(owner('Acme gateway key'), { kind: 'gateway', of: 'Acme gateway' })
  assert.deepEqual(owner(CredentialBroker.secretName('codex', 'OPENAI_API_KEY')), { kind: 'agent', of: 'codex' })
  assert.equal(owner('Plugin key'), null)
  assert.equal(owner('Gone gateway key'), null)
})

test('concurrent store calls under cold start do not lose entries or fail with ENOENT (#305)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-concurrent-'))
  try {
    const path = join(dir, 'credentials.json')
    const broker = new CredentialBroker(path)

    // Control: sequential storage works
    const controlRef = await broker.store('control-key', 'control-val', ENDPOINT)
    assert.match(controlRef, /^cred_/)

    // Cold-start concurrency test: new broker instance on fresh path
    const coldPath = join(dir, 'cold-credentials.json')
    const coldBroker = new CredentialBroker(coldPath)

    const [ref1, ref2] = await Promise.all([
      coldBroker.store('key1', 'val1', ENDPOINT),
      coldBroker.store('key2', 'val2', ENDPOINT),
    ])

    const described = await coldBroker.describe()
    assert.equal(described.length, 2, 'both credentials are retained in memory and on disk')
    assert.equal(await coldBroker.resolve(ref1), 'val1')
    assert.equal(await coldBroker.resolve(ref2), 'val2')

    // Reload from disk to verify both made it to file
    const fresh = new CredentialBroker(coldPath)
    const freshDescribed = await fresh.describe()
    assert.equal(freshDescribed.length, 2, 'both credentials are persisted on disk')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent store calls on cold start without single-flight load lose map entries in memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-load-race-'))
  try {
    const path = join(dir, 'credentials.json')
    // Pre-populate with existing file so readFile takes an asynchronous tick
    await writeFile(path, JSON.stringify({ cred_existing: { name: 'existing', createdAt: 1, blob: Buffer.from('val').toString('base64') } }))

    const broker = new CredentialBroker(path)
    const [ref1, ref2] = await Promise.all([
      broker.store('key1', 'val1', ENDPOINT),
      broker.store('key2', 'val2', ENDPOINT),
    ])

    const described = await broker.describe()
    assert.equal(described.length, 3, 'both new entries plus existing are retained')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent put calls under cold start replace existing cleanly without loss (#305)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-creds-put-'))
  try {
    const path = join(dir, 'credentials.json')
    const broker = new CredentialBroker(path)

    await Promise.all([
      broker.put('agent:codex:KEY1', 'val1', 'codex'),
      broker.put('agent:codex:KEY2', 'val2', 'codex'),
    ])

    const described = await broker.describe()
    assert.equal(described.length, 2)
    assert.ok(described.some((d) => d.name === 'agent:codex:KEY1'))
    assert.ok(described.some((d) => d.name === 'agent:codex:KEY2'))

    const fresh = new CredentialBroker(path)
    assert.equal((await fresh.describe()).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})



