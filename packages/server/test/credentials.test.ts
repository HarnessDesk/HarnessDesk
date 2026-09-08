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
