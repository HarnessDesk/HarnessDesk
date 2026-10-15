import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime, secretReadOrder, whereSecretLives, type AcpSecretSource, type AcpSecretSpec } from '../src/runtime.js'

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

  it("follows the agent's own home variable to its store, from the agent's environment first", () => {
    // DSH keeps its store under $DSH_HOME when that is set, and a desk that
    // looked only under ~/.dsh asked for a key DSH already had.
    const home = mkdtempSync(join(dir, 'dsh-home-'))
    writeFileSync(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-theirs\n')
    const at = spec([{ path: '${DSH_HOME:-~/.dsh-none-here}/.credentials.yaml', format: 'yaml', label: 'its store' }])
    assert.equal(whereSecretLives(at, () => undefined, { DSH_HOME: home })?.detail, 'its store')
    process.env['DSH_HOME'] = home
    try {
      assert.equal(whereSecretLives(at, () => undefined)?.detail, 'its store', 'or from the launching environment')
    } finally {
      delete process.env['DSH_HOME']
    }
    assert.equal(whereSecretLives(at, () => undefined), null, 'and the fallback when neither sets it')
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

/**
 * Which copy wins is the agent's, and it moves between releases. DeepSeek
 * Harness's `acp` profile took the environment it was launched in ahead of
 * its own `.credentials.yaml` through 0.2.0-rc.2, and took the file ahead of
 * the environment from 0.2.1-alpha.3 — measured by sending the same two
 * different keys to each build and reading which one reached a fake
 * endpoint. HarnessDesk hands its own key over as that environment, so on the
 * newer builds a key in the store silently outranks the one it believes is in
 * use. Presence detection follows the version.
 */
describe('a source the agent reads ahead of its environment', () => {
  const STORE_FIRST_FROM = '0.2.1-alpha.3'
  const storeAndHomeEnv = (store: string, env: string): AcpSecretSource[] => [
    { path: store, format: 'yaml', label: 'its store', outranksEnvFrom: STORE_FIRST_FROM },
    { path: env, format: 'dotenv', label: 'its .env' },
  ]

  it('wins over the key HarnessDesk hands over once the agent is new enough', () => {
    const store = file('store-first.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-in-the-store\n')
    const sources = storeAndHomeEnv(store, join(dir, 'absent.env'))
    const where = whereSecretLives(spec(sources), () => 'sk-from-the-broker', undefined, '0.2.1-alpha.3')
    assert.deepEqual(
      where,
      { kind: 'externalKey', detail: 'its store', storedCopy: true },
      'the agent sends the store key, so that is where the key lives — and the interface still holds a copy it can replace or remove',
    )
  })

  it('does not claim a stored copy when HarnessDesk holds none', () => {
    const store = file('store-first-alone.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-in-the-store\n')
    const sources = storeAndHomeEnv(store, join(dir, 'absent.env'))
    for (const resolve of [undefined, () => undefined]) {
      assert.deepEqual(whereSecretLives(spec(sources), resolve, undefined, '0.2.1-alpha.3'), { kind: 'externalKey', detail: 'its store' })
    }
  })

  it('still loses to the key HarnessDesk hands over on an older agent', () => {
    const store = file('store-after.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-in-the-store\n')
    const sources = storeAndHomeEnv(store, join(dir, 'absent.env'))
    for (const version of ['0.2.0-rc.2', '0.2.1-alpha.2', '0.1.7-rc.2']) {
      const where = whereSecretLives(spec(sources), () => 'sk-from-the-broker', undefined, version)
      assert.deepEqual(where, { kind: 'apiKey', detail: 'API key' }, version)
    }
  })

  it('keeps the old order when the version is not known', () => {
    const store = file('store-unknown.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-in-the-store\n')
    const sources = storeAndHomeEnv(store, join(dir, 'absent.env'))
    for (const version of [undefined, null, 'nightly']) {
      assert.equal(whereSecretLives(spec(sources), () => 'sk-from-the-broker', undefined, version)?.kind, 'apiKey', String(version))
    }
  })

  it('does not hide the key HarnessDesk holds when the store has none', () => {
    const store = file('store-empty.yaml', 'version: 1\nrefs:\n  OPENAI_API_KEY: sk-other\n')
    const sources = storeAndHomeEnv(store, join(dir, 'absent.env'))
    const where = whereSecretLives(spec(sources), () => 'sk-from-the-broker', undefined, '0.2.1-alpha.3')
    assert.deepEqual(where, { kind: 'apiKey', detail: 'API key' })
  })

  it('leaves a file with no such version declared after the environment on every version', () => {
    const dot = file('plain.env', 'DEEPSEEK_API_KEY=sk-in-dotenv\n')
    const sources: AcpSecretSource[] = [{ path: dot, format: 'dotenv', label: 'its .env' }]
    assert.equal(whereSecretLives(spec(sources), () => 'sk-from-the-broker', undefined, '9.9.9')?.kind, 'apiKey')
    assert.equal(whereSecretLives(spec(sources), () => undefined, undefined, '9.9.9')?.detail, 'its .env')
  })

  it('splits the sources by version, keeping the registry order inside each side', () => {
    const sources: AcpSecretSource[] = [
      { path: 'a', format: 'yaml', label: 'a', outranksEnvFrom: '1.2.0' },
      { path: 'b', format: 'dotenv', label: 'b' },
      { path: 'c', format: 'yaml', label: 'c', outranksEnvFrom: '1.0.0' },
    ]
    const labels = (order: ReturnType<typeof secretReadOrder>) => [order.before.map((s) => s.label), order.after.map((s) => s.label)]
    assert.deepEqual(labels(secretReadOrder({ alsoAt: sources }, '1.2.0')), [['a', 'c'], ['b']])
    assert.deepEqual(labels(secretReadOrder({ alsoAt: sources }, '1.1.0')), [['c'], ['a', 'b']])
    assert.deepEqual(labels(secretReadOrder({ alsoAt: sources }, '0.9.0')), [[], ['a', 'b', 'c']])
    assert.deepEqual(labels(secretReadOrder({}, '1.2.0')), [[], []])
  })
})

describe('an agent whose store outranks the key it was handed, through the runtime', () => {
  const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

  const build = (version: string | null, store: string | null, broker: string | null = 'sk-from-the-broker') => {
    const home = mkdtempSync(join(dir, 'runtime-home-'))
    if (store !== null) writeFileSync(join(home, '.credentials.yaml'), store)
    return new AcpRuntime({
      id: 'fake-keyed',
      name: 'Fake Keyed Agent',
      command: process.execPath,
      args: [FAKE],
      env: { DSH_HOME: home },
      resolveLaunch: async () => ({ command: process.execPath, args: [FAKE], version }),
      secrets: [
        {
          env: 'DEEPSEEK_API_KEY',
          label: 'DeepSeek API key',
          alsoAt: [
            {
              path: '${DSH_HOME:-~/.dsh-none-here}/.credentials.yaml',
              format: 'yaml',
              label: 'its own store',
              outranksEnvFrom: '0.2.1-alpha.3',
            },
          ],
        },
      ],
      resolveSecret: () => broker ?? undefined,
    })
  }
  const accountsOf = async (runtime: AcpRuntime) =>
    (await runtime.getAccount()).accounts.map((account) => ({
      kind: account.kind,
      planType: account.planType,
      ...(account.storedCopy ? { storedCopy: true } : {}),
    }))
  const accountOf = async (version: string | null, store: string | null) => {
    const runtime = build(version, store)
    try {
      await runtime.start()
      return await accountsOf(runtime)
    } finally {
      await runtime.dispose()
    }
  }
  const STORE = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-in-the-store\n'

  it('names the store as the account on a build that reads it first, and says the key HarnessDesk holds is still there to manage', async () => {
    assert.deepEqual(await accountOf('0.2.1-alpha.3', STORE), [{ kind: 'externalKey', planType: 'its own store', storedCopy: true }])
  })

  it('names the store without a copy to manage when HarnessDesk holds no key', async () => {
    const runtime = build('0.2.1-alpha.3', STORE, null)
    try {
      await runtime.start()
      assert.deepEqual(await accountsOf(runtime), [{ kind: 'externalKey', planType: 'its own store' }])
    } finally {
      await runtime.dispose()
    }
  })

  it('names the key HarnessDesk holds on a build that reads its environment first', async () => {
    assert.deepEqual(await accountOf('0.2.0-rc.2', STORE), [{ kind: 'apiKey', planType: 'API key' }])
  })

  it('names the key HarnessDesk holds when the store has none, on any build', async () => {
    assert.deepEqual(await accountOf('0.2.1-alpha.3', null), [{ kind: 'apiKey', planType: 'API key' }])
  })

  describe('before the agent has started in this process', () => {
    it('judges by the version the last process ran, so a cold read agrees with the warm one that follows', async () => {
      const runtime = build('0.2.1-alpha.3', STORE)
      try {
        assert.equal(runtime.launchedVersion, null, 'nothing is known about a runtime nobody has restored or launched')
        runtime.restoreObservations({ launchedVersion: '0.2.1-alpha.3' })
        assert.equal(runtime.launchedVersion, '0.2.1-alpha.3')
        assert.deepEqual(await accountsOf(runtime), [{ kind: 'externalKey', planType: 'its own store', storedCopy: true }])
      } finally {
        await runtime.dispose()
      }
    })

    it('judges an older remembered build by the older order', async () => {
      const runtime = build('0.2.1-alpha.3', STORE)
      try {
        runtime.restoreObservations({ launchedVersion: '0.2.0-rc.2' })
        assert.deepEqual(await accountsOf(runtime), [{ kind: 'apiKey', planType: 'API key' }])
      } finally {
        await runtime.dispose()
      }
    })

    it('gives way to the version that actually launched, and hands it on to be remembered', async () => {
      const runtime = build('0.2.0-rc.2', STORE)
      try {
        runtime.restoreObservations({ launchedVersion: '0.2.1-alpha.3' })
        await runtime.start()
        assert.equal(runtime.launchedVersion, '0.2.0-rc.2', 'the process that is running is the one that counts')
        assert.equal(runtime.observations().launchedVersion, '0.2.0-rc.2')
      } finally {
        await runtime.dispose()
      }
    })
  })
})
