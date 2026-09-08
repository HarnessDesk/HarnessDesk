import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { whereSecretLives, type AcpSecretSpec } from '../src/runtime.js'

/**
 * One key, several places it can be.
 *
 * DeepSeek Harness reads `DEEPSEEK_API_KEY` from its environment, from
 * `~/.dsh/.credentials.yaml` (what its own Models page writes), and from two
 * `.env` files. HarnessDesk holds its own copy and injects it at spawn, which
 * wins — but an agent that already has one elsewhere is not "not signed in",
 * and saying so sent a user to paste a key they did not need. So the question
 * this answers is *whether* and *from where*, never *what*.
 */

const dir = mkdtempSync(join(tmpdir(), 'hd-secrets-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const spec = (alsoAt: AcpSecretSpec['alsoAt']): AcpSecretSpec => ({
  env: 'DEEPSEEK_API_KEY',
  label: 'DeepSeek API key',
  ...(alsoAt ? { alsoAt } : {}),
})

describe('whereSecretLives', () => {
  it('reports nothing when the key is nowhere', () => {
    assert.equal(whereSecretLives(spec(undefined), () => undefined), null)
  })

  it('prefers the broker, and calls it ours', () => {
    const where = whereSecretLives(spec(undefined), () => 'sk-value')
    assert.deepEqual(where, { kind: 'apiKey', detail: 'API key' })
  })

  it('finds one in the launching environment and marks it not ours', () => {
    process.env['DEEPSEEK_API_KEY'] = 'sk-inherited'
    try {
      const where = whereSecretLives(spec(undefined), () => undefined)
      assert.equal(where?.kind, 'externalKey')
      assert.match(where?.detail ?? '', /DEEPSEEK_API_KEY/)
    } finally {
      delete process.env['DEEPSEEK_API_KEY']
    }
  })

  it("finds one in the agent's own YAML store, and names that store", () => {
    const path = file('creds.yaml', 'OPENAI_API_KEY: sk-other\nDEEPSEEK_API_KEY: sk-theirs\n')
    const where = whereSecretLives(
      spec([{ path, format: 'yaml', label: "DeepSeek Harness's own store" }]),
      () => undefined,
    )
    assert.deepEqual(where, { kind: 'externalKey', detail: "DeepSeek Harness's own store" })
  })

  it("reads the one-line flow mapping DSH's own writer produces", () => {
    const path = file('flow.yaml', '{ DEEPSEEK_API_KEY: sk-theirs }\n')
    const where = whereSecretLives(
      spec([{ path, format: 'yaml', label: "DeepSeek Harness's own store" }]),
      () => undefined,
    )
    assert.equal(where?.kind, 'externalKey')
  })

  it('finds one in a dotenv, export prefix and quotes included', () => {
    const path = file('dot.env', 'export DEEPSEEK_API_KEY="sk-theirs"\n')
    const where = whereSecretLives(
      spec([{ path, format: 'dotenv', label: '~/.dsh/.env' }]),
      () => undefined,
    )
    assert.equal(where?.kind, 'externalKey')
  })

  it('does not count a commented-out or empty entry as a key', () => {
    const commented = file('commented.yaml', '# DEEPSEEK_API_KEY: sk-old\n')
    const empty = file('empty.yaml', 'DEEPSEEK_API_KEY:\n')
    const quoted = file('quoted.env', 'DEEPSEEK_API_KEY=""\n')
    for (const [path, format] of [
      [commented, 'yaml'],
      [empty, 'yaml'],
      [quoted, 'dotenv'],
    ] as const) {
      assert.equal(
        whereSecretLives(spec([{ path, format, label: 'somewhere' }]), () => undefined),
        null,
        path,
      )
    }
  })

  it('takes the sources in the order the registry lists them', () => {
    const first = file('first.yaml', 'DEEPSEEK_API_KEY: sk-a\n')
    const second = file('second.yaml', 'DEEPSEEK_API_KEY: sk-b\n')
    const where = whereSecretLives(
      spec([
        { path: first, format: 'yaml', label: 'first' },
        { path: second, format: 'yaml', label: 'second' },
      ]),
      () => undefined,
    )
    assert.equal(where?.detail, 'first')
  })

  it('treats a missing file as a missing key, not an error', () => {
    assert.equal(
      whereSecretLives(
        spec([{ path: join(dir, 'nope.yaml'), format: 'yaml', label: 'gone' }]),
        () => undefined,
      ),
      null,
    )
  })
})
