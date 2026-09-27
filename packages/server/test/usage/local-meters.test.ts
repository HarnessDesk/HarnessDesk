import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { localUsageFor, ownCli } from '../../src/bootstrap.js'
import { knownAgent } from '../../src/installs/known-agents.js'
import { tempDir } from '../scratch.js'

/**
 * Which agent rows earn a local usage meter.
 *
 * The rule is that the meter follows the *CLI* a row drives, never the row's
 * id — the id is the user's to choose, and two people can name the same
 * agent differently. What that misses, if only the row's own fields are
 * read, is the commonest row of all: an agent whose CLI speaks ACP itself
 * has no `executable` and no `account`, so its `command` is the only thing
 * naming the CLI, and reading which agent that is, is the knowledge table's
 * job. Gemini and GitHub Copilot each had a meter written for them that
 * nothing reached, and reported as unmetered.
 */

const row = (fields: Partial<AcpAgentConfig> & { id: string }): AcpAgentConfig =>
  ({ name: fields.id, command: fields.id, ...fields }) as AcpAgentConfig

const knowledge = (id: string) => {
  const known = knownAgent(id)
  assert.ok(known, `${id} is not in the knowledge table`)
  return known
}

test('a direct-CLI row is metered through the knowledge table, not through fields it has none of', () => {
  const copilot = row({
    id: 'github-copilot-cli',
    command: '/opt/homebrew/bin/copilot',
    args: ['--acp'],
  })
  assert.equal(localUsageFor(copilot, knowledge('github-copilot-cli'))?.meter?.id, 'copilot-account')

  // The same hole, for the same reason, on the agent next to it.
  const gemini = row({ id: 'gemini', command: 'gemini', args: ['--acp'] })
  assert.equal(localUsageFor(gemini, knowledge('gemini'))?.meter?.id, 'gemini-account')
  assert.equal(localUsageFor(gemini, knowledge('gemini'))?.corpus, 'gemini')

  // The knowledge wins over the program's own name: a wrapper that the table
  // knows to be Gemini is metered as Gemini, whatever it is called.
  const wrapped = row({ id: 'gemini', command: '/usr/local/bin/my-gemini-wrapper' })
  assert.equal(localUsageFor(wrapped, knowledge('gemini'))?.meter?.id, 'gemini-account')
})

test('a row the table has no entry for is named by the program it runs', () => {
  // Amp's registry download runs its adapter by path.
  const amp = row({ id: 'amp-acp', command: '/home/dev/.harnessdesk/acp-agents/amp-acp/0.9.0/amp-acp' })
  assert.equal(localUsageFor(amp)?.meter?.id, 'amp-account')
  // Qwen Code's runs through npx: the package is the program.
  const qwen = row({ id: 'qwen-code', command: 'npx', args: ['-y', '@qwen-code/qwen-code@0.24.0', '--acp'] })
  assert.equal(ownCli(qwen), 'qwen-code')
  assert.equal(localUsageFor(qwen)?.corpus, 'qwen')
  // An unscoped package, with the version pinned the way the registry pins it.
  assert.equal(ownCli(row({ id: 'cline', command: 'npx', args: ['-y', 'cline@3.0.61', '--acp'] })), 'cline')
  assert.equal(ownCli(row({ id: 'x', command: 'pnpm', args: ['dlx', '@scope/tool', '--acp'] })), 'tool')
  // A runner with nothing to run names nothing.
  assert.equal(ownCli(row({ id: 'x', command: 'npx', args: ['--yes'] })), null)
})

test("a bridge row still answers from its own fields, and the knowledge cannot disagree", () => {
  const claude = row({
    id: 'anthropic',
    command: process.execPath,
    executable: { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
  })
  const bound = localUsageFor(claude, knowledge('claude-code'))
  assert.equal(bound?.corpus, 'claude')
  // Named by the row alone, the way it always was.
  assert.equal(localUsageFor(claude)?.corpus, 'claude')

  const cursor = row({
    id: 'cursor',
    command: process.execPath,
    account: { status: { command: 'cursor-agent', args: ['status'] } },
  })
  assert.equal(localUsageFor(cursor, knowledge('cursor'))?.meter?.id, localUsageFor(cursor)?.meter?.id)
  assert.ok(localUsageFor(cursor)?.meter)
})

test('Antigravity is metered by the agy CLI beside its ACP server', () => {
  // The registry download names the server by its file, `agy_acp_server.par`;
  // the knowledge table names it by the command, and that is what binds.
  const antigravity = row({
    id: 'antigravity-acp',
    command: '/home/dev/.harnessdesk/acp-agents/antigravity-acp/1.1.1/agy_acp_server.par',
  })
  // Unrecognised without the knowledge table, this row has no corpus of its
  // own — but the desk's own transcript still counts its turns, and it still
  // gains OpenRouter's dormant meter (bound to every row with none stronger;
  // see the OpenRouter tests below), which asks for nothing and answers null
  // since this row carries no OpenRouter key of its own.
  const unrecognised = localUsageFor(antigravity)
  assert.equal(unrecognised?.deskTurns, true)
  assert.equal(unrecognised?.corpus, undefined)
  assert.equal(unrecognised?.meter?.id, 'openrouter-key')
  assert.equal(localUsageFor(antigravity, knowledge('antigravity-acp'))?.meter?.id, 'antigravity-account')
  // No transcripts of its own for the ledger: its turns are counted from its store.
  assert.equal(localUsageFor(antigravity, knowledge('antigravity-acp'))?.corpus, undefined)
  assert.equal(localUsageFor(antigravity, knowledge('antigravity-acp'))?.deskTurns, true)
})

test('an agent whose spend is on disk gets its records, and one with neither gets nothing', () => {
  // OpenCode offers an API key no balance, but prices every session itself —
  // its own records stand, and OpenRouter's dormant meter fills the gap
  // where nothing else answered (silent without a key of its own).
  const opencode = localUsageFor(row({ id: 'opencode', command: 'opencode' }), knowledge('opencode'))
  assert.equal(opencode?.meter?.id, 'openrouter-key')
  assert.equal(opencode?.corpus, 'opencode')
  // Cline has both: a balance on its account and its sessions' cost on disk.
  const cline = localUsageFor(row({ id: 'cline', command: 'npx', args: ['-y', 'cline@3.0.61', '--acp'] }), knowledge('cline'))
  assert.equal(cline?.meter?.id, 'cline-account')
  assert.equal(cline?.corpus, 'cline')
  // A hand-written row for something the desk has never heard of: no corpus,
  // but its turns still come from the desk's own transcript, and it still
  // gains OpenRouter's dormant meter.
  const mine = localUsageFor(row({ id: 'mine', command: '/usr/local/bin/mine' }))
  assert.equal(mine?.deskTurns, true)
  assert.equal(mine?.corpus, undefined)
  assert.equal(mine?.meter?.id, 'openrouter-key')
})

test('a moved Gemini home moves the sign-in and the spend together, so one card is one account', () => {
  // `GEMINI_CLI_HOME` stands in for the home folder. Read the sign-in from the
  // desk's home and the chat logs from the moved one, and the card shows one
  // account's quota beside another's spend (#772, review round 1).
  const moved = localUsageFor(
    row({ id: 'gemini-work', command: 'gemini', args: ['--acp'], env: { GEMINI_CLI_HOME: '/work/second-account' } }),
    knowledge('gemini'),
  )
  assert.deepEqual(moved?.meter?.watchPaths(), ['/work/second-account/.gemini/oauth_creds.json'])
  assert.equal(moved?.root, '/work/second-account/.gemini/tmp')

  // Unmoved, both fall back to the same home as each other.
  const home = process.env['HOME'] ?? ''
  const plain = localUsageFor(row({ id: 'gemini', command: 'gemini', args: ['--acp'] }), knowledge('gemini'))
  if (!process.env['GEMINI_CLI_HOME']) {
    assert.deepEqual(plain?.meter?.watchPaths(), [`${home}/.gemini/oauth_creds.json`])
    assert.equal(plain?.root, `${home}/.gemini/tmp`)
  }
})

test('an Amp row with its own PATH is asked with that PATH, not the host process’s', async () => {
  // The row can carry a second Amp account through its own PATH (and HOME,
  // for the installer fallback); the meter has to find and run *that* amp,
  // not whatever the host process already had (#772, review round 4).
  const dir = tempDir('hd-amp-bind-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const script = join(bin, 'amp')
  // Amp's own $, not the shell's $1 (the script's first argument, "usage").
  writeFileSync(script, ['#!/bin/sh', 'echo "**Individual credits:** \\$10 remaining"', 'echo "Signed in as row@example.com"', ''].join('\n'))
  chmodSync(script, 0o755)

  const amp = localUsageFor(row({ id: 'amp-acp', command: 'amp-acp', env: { PATH: bin } }))
  const reading = await amp?.meter?.read()
  assert.equal(reading?.account, 'row@example.com', 'the row’s own amp answered, not the host’s PATH')
  assert.equal(reading?.credits?.remaining, 10)
})

test('a Cline row with --data-dir still lets CLINE_DB_DATA_DIR name the database on its own', () => {
  // The two flags name different things — settings and account state versus
  // the database alone — and a row can set one without the other, the way
  // corpusRoot already honours CLINE_DB_DATA_DIR ahead of the data folder
  // when there is no override (#772, review round 4).
  const moved = localUsageFor(
    row({
      id: 'cline-work',
      command: 'cline',
      args: ['--acp', '--data-dir', '/work/second-cline'],
      env: { CLINE_DB_DATA_DIR: '/work/second-cline-db' },
    }),
    knowledge('cline'),
  )
  assert.deepEqual(moved?.meter?.watchPaths(), ['/work/second-cline/settings/providers.json'], 'settings still follow --data-dir')
  assert.equal(moved?.root, '/work/second-cline-db/sessions.db', 'the database follows CLINE_DB_DATA_DIR, not the override')
})

test('a Cline row moved with --data-dir is read from there, sign-in and spend together', () => {
  // --data-dir is Cline's real mechanism for a second account; unlike Gemini
  // it has no environment variable for it (known-agents.ts), so the row's
  // own args are the only place a moved account is named (#772, review round 3).
  const moved = localUsageFor(
    row({ id: 'cline-work', command: 'cline', args: ['--acp', '--data-dir', '/work/second-cline'] }),
    knowledge('cline'),
  )
  assert.deepEqual(moved?.meter?.watchPaths(), ['/work/second-cline/settings/providers.json'])
  assert.equal(moved?.root, '/work/second-cline/db/sessions.db')

  // A relative --data-dir resolves against the row's own cwd, as Cline itself resolves it.
  const relative = localUsageFor(
    row({ id: 'cline-rel', command: 'cline', args: ['--acp', '--data-dir', 'second'], cwd: '/work/base' }),
    knowledge('cline'),
  )
  assert.equal(relative?.root, '/work/base/second/db/sessions.db')

  // Unmoved, it falls back to the environment-based default as before.
  const plain = localUsageFor(row({ id: 'cline', command: 'cline', args: ['--acp'] }), knowledge('cline'))
  assert.ok(plain?.root?.endsWith('/.cline/data/db/sessions.db'), plain?.root)
})

test('a row isolated with a bare HOME moves every fallback that would otherwise read the desk’s own account', () => {
  // HOME is the ordinary way to isolate an agent — ahead of any bespoke
  // variable — and it is what the row’s own process resolves homedir() to.
  // Reading its files by hand has to agree, or a row running as one account
  // is metered as whichever account the desk itself is signed in as (#772,
  // review round 5).
  const isolated = '/accounts/two'

  const gemini = localUsageFor(row({ id: 'gemini', command: 'gemini', args: ['--acp'], env: { HOME: isolated } }), knowledge('gemini'))
  assert.deepEqual(gemini?.meter?.watchPaths(), [`${isolated}/.gemini/oauth_creds.json`])
  assert.equal(gemini?.root, `${isolated}/.gemini/tmp`)

  const cline = localUsageFor(row({ id: 'cline', command: 'cline', args: ['--acp'], env: { HOME: isolated } }), knowledge('cline'))
  assert.deepEqual(cline?.meter?.watchPaths(), [`${isolated}/.cline/data/settings/providers.json`])
  assert.equal(cline?.root, `${isolated}/.cline/data/db/sessions.db`)

  // `--data-dir ~/…`: the row’s own HOME, not the desk’s, is what `~` expands to.
  const clineTilde = localUsageFor(
    row({ id: 'cline-tilde', command: 'cline', args: ['--acp', '--data-dir', '~/moved'], env: { HOME: isolated } }),
    knowledge('cline'),
  )
  assert.equal(clineTilde?.root, `${isolated}/moved/db/sessions.db`)

  // Qwen has no knowledge-table entry; it binds by the program it runs.
  const qwen = localUsageFor(row({ id: 'qwen-code', command: 'qwen-code', env: { HOME: isolated } }))
  assert.equal(qwen?.root, `${isolated}/.qwen/projects`)

  const opencode = localUsageFor(row({ id: 'opencode', command: 'opencode', env: { HOME: isolated } }), knowledge('opencode'))
  assert.equal(opencode?.root, `${isolated}/.local/share/opencode/opencode.db`)
})

const DSH_SECRETS = [
  {
    env: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek API key',
    alsoAt: [
      { path: '${DSH_HOME:-~/.dsh}/.credentials.yaml', format: 'yaml' as const, label: "DeepSeek's own store (.credentials.yaml in its home)" },
      { path: '${DSH_HOME:-~/.dsh}/.env', format: 'dotenv' as const, label: '.env in its home' },
    ],
  },
]

test('DeepSeek Harness is bound to its balance by runtime, and the desk’s own stored key is asked fresh on every read, ahead of the row’s own environment', async () => {
  const dsh = row({
    id: 'dsh',
    command: 'dsh',
    args: ['--profile', 'acp'],
    env: { DEEPSEEK_API_KEY: 'sk-row-key' },
    secrets: DSH_SECRETS,
  })
  const bound = localUsageFor(dsh, knowledge('dsh'))
  assert.equal(bound?.meter?.id, 'deepseek-balance')
  assert.equal(bound?.deskTurns, true, 'no corpus of its own yet; its turns are the desk’s own transcript')
  // The registry's own alsoAt list reaches the meter through the wiring —
  // never a path hard-coded in the meter itself.
  assert.deepEqual(bound?.meter?.watchPaths(), [
    join(homedir(), '.dsh', '.credentials.yaml'),
    join(homedir(), '.dsh', '.env'),
  ])

  // The broker's own stored copy is asked with the same name the desk would
  // use to launch the agent — `agent:<id>:<env>` — ahead of the row's plain
  // environment. Never at bind time: only when a read actually asks — the
  // meter's own `fetch` is whatever the global was at construction, so the
  // fake is installed first.
  const originalFetch = globalThis.fetch
  let authSeen: string | null = null
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    authSeen = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1' }] }), { status: 200 })
  }) as typeof globalThis.fetch
  try {
    const seen: [string, string][] = []
    const withBroker = localUsageFor(dsh, knowledge('dsh'), (agentId, envName) => {
      seen.push([agentId, envName])
      return 'sk-broker-key'
    })
    assert.ok(withBroker?.meter)
    assert.deepEqual(seen, [], 'constructing the binding never itself asks the broker')
    await withBroker?.meter?.read()
    assert.deepEqual(seen, [['dsh', 'DEEPSEEK_API_KEY']])
    assert.equal(authSeen, 'Bearer sk-broker-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenRouter is bound to every row with no stronger meter of its own, whether or not it has a key yet', () => {
  // A row with no other meter at all — the "mine" row from above, now
  // carrying an OpenRouter key — gains one.
  const mine = row({ id: 'mine', command: '/usr/local/bin/mine', env: { OPENROUTER_API_KEY: 'sk-or-v1-row-key' } })
  const bound = localUsageFor(mine)
  assert.equal(bound?.meter?.id, 'openrouter-key')
  assert.equal(bound?.deskTurns, true)

  // Without a key of its own, the same meter is still bound — dormant, so a
  // key stored in the broker later is honoured on the very next read rather
  // than needing this binding to be rebuilt.
  const keyless = localUsageFor(row({ id: 'mine', command: '/usr/local/bin/mine' }))
  assert.equal(keyless?.deskTurns, true)
  assert.equal(keyless?.corpus, undefined)
  assert.equal(keyless?.meter?.id, 'openrouter-key')

  // A row that already has its own account balance keeps it: Cline's own
  // wallet is a different account's money than whatever key its own model
  // calls might use.
  const cline = localUsageFor(
    row({ id: 'cline', command: 'npx', args: ['-y', 'cline@3.0.61', '--acp'], env: { OPENROUTER_API_KEY: 'sk-or-v1-ignored' } }),
    knowledge('cline'),
  )
  assert.equal(cline?.meter?.id, 'cline-account')

  // OpenCode has no meter of its own today (only a corpus): the OpenRouter
  // key fills exactly that gap without disturbing its records.
  const opencode = localUsageFor(row({ id: 'opencode', command: 'opencode', env: { OPENROUTER_API_KEY: 'sk-or-v1-oc' } }), knowledge('opencode'))
  assert.equal(opencode?.meter?.id, 'openrouter-key')
  assert.equal(opencode?.corpus, 'opencode', 'its own records are untouched')

  // The desk's own stored copy of the key is asked too, the same way as DSH's.
  const viaBroker = localUsageFor(row({ id: 'mine', command: '/usr/local/bin/mine' }), undefined, (_agentId, envName) =>
    envName === 'OPENROUTER_API_KEY' ? 'sk-or-v1-broker' : undefined,
  )
  assert.equal(viaBroker?.meter?.id, 'openrouter-key')
})

test('HarnessDesk’s own shell environment is never consulted for OpenRouter — a row with no key of its own sends nothing, however the desk itself was started', async () => {
  const originalEnv = process.env['OPENROUTER_API_KEY']
  process.env['OPENROUTER_API_KEY'] = 'sk-or-v1-desk-shell-key' // hd-secrets-ok: a shape-only fixture value, never a real credential
  try {
    const bound = localUsageFor(row({ id: 'mine', command: '/usr/local/bin/mine' }))
    // Still bound — the meter is dormant rather than absent (see the test
    // above) — but its key function never reads the desk's own environment.
    assert.equal(bound?.meter?.id, 'openrouter-key')

    const originalFetch = globalThis.fetch
    let requested = false
    globalThis.fetch = (async () => {
      requested = true
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const reading = await bound?.meter?.read()
      assert.equal(reading, null, 'no key of its own — silence')
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(requested, false, 'the desk’s own shell key is never sent for a row that never asked for it')
  } finally {
    if (originalEnv === undefined) delete process.env['OPENROUTER_API_KEY']
    else process.env['OPENROUTER_API_KEY'] = originalEnv
  }
})
