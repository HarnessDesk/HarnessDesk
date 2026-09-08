import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { appNameOf, holderOf, isBusyRefusal, sessionStoreOf } from '../src/writer-lock.js'

/**
 * Codex's one-writer rule, and what HarnessDesk has to know about it.
 *
 * A thread may be written by exactly one process at a time, enforced with an
 * `flock` in `$CODEX_HOME/thread-writer-locks`. Every Codex on the machine
 * shares one home — the CLI, the desktop app, and each account here, whose
 * home is that home in symlinks — so the refusal is routine and the only
 * useful response is to say where the conversation actually is.
 */

test('the writer refusal is recognised wherever the agent put it', () => {
  assert.equal(
    isBusyRefusal(new Error('thread 01a04ec8-90f2-70b0 already has an active writer')),
    true,
  )
  // JSON-RPC hides the sentence in `data` and answers with a code word; the
  // adapters carry that through as `details`.
  const withDetails = Object.assign(new Error('Invalid request'), {
    details: 'thread 01a04ec8-90f2-70b0 already has an active writer',
  })
  assert.equal(isBusyRefusal(withDetails), true)

  assert.equal(isBusyRefusal(new Error('no rollout found for thread id 01a04ec8')), false)
  assert.equal(isBusyRefusal('already has an active writer'), false)
})

/**
 * The property the whole account-slot design rests on: a slot's home *is* the
 * agent's home, one symlink away. Built here the way `accounts.ts` builds it,
 * because a store key that failed to see through the links would leave two
 * accounts believing they hold different conversations.
 */
test('two accounts of one Codex name the same conversation store', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'harnessdesk-writer-lock-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const primary = join(base, 'codex')
  const slot = join(base, 'accounts', 'codex-abc123')
  mkdirSync(join(primary, 'sessions'), { recursive: true })
  writeFileSync(join(primary, 'auth.json'), '{}')
  mkdirSync(slot, { recursive: true })
  for (const entry of readdirSync(primary)) {
    if (entry === 'auth.json') continue // the credential is the one private thing
    symlinkSync(join(primary, entry), join(slot, entry))
  }

  assert.equal(sessionStoreOf(slot), sessionStoreOf(primary))
  // And a Codex looking at a genuinely separate home is not a peer of either.
  const elsewhere = join(base, 'other')
  mkdirSync(join(elsewhere, 'sessions'), { recursive: true })
  assert.notEqual(sessionStoreOf(elsewhere), sessionStoreOf(primary))
})

test('a home that has never held a thread still answers, and agrees with itself', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'harnessdesk-writer-lock-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const fresh = join(base, 'fresh')
  mkdirSync(fresh, { recursive: true })

  const answer = sessionStoreOf(fresh)
  assert.equal(answer, sessionStoreOf(fresh))
  assert.equal(answer.endsWith('sessions'), true)
})

test('the holder is named from the application that has the lock open', async () => {
  const calls: string[][] = []
  const run = async (file: string, args: readonly string[]): Promise<string> => {
    calls.push([file, ...args])
    if (file === 'lsof') return '5456\n'
    return '/Applications/ChatGPT.app/Contents/Resources/codex app-server\n'
  }

  assert.equal(await holderOf('/home/.codex', 'thread-1', run), 'the ChatGPT app')
  assert.equal(calls[0]?.[0], 'lsof')
  assert.equal(calls[0]?.[2], '/home/.codex/thread-writer-locks/thread-1.lock')
})

test('an unnameable holder is no holder at all, rather than a guess', async () => {
  const nothingOpen = async (): Promise<string> => ''
  assert.equal(await holderOf('/home/.codex', 'thread-1', nothingOpen), null)

  const refuses = async (): Promise<string> => {
    throw new Error('lsof: command not found')
  }
  assert.equal(await holderOf('/home/.codex', 'thread-1', refuses), null)
})

test('only applications a person would recognise get named', () => {
  assert.equal(appNameOf('/Applications/ChatGPT.app/Contents/Resources/codex app-server'), 'the ChatGPT app')
  assert.equal(appNameOf('/opt/homebrew/bin/codex app-server'), 'the Codex CLI')
  // Our own child is named by the host from its own registry, not from here.
  assert.equal(appNameOf('/usr/local/lib/node_modules/@openai/codex/vendor/bin/something'), null)
  assert.equal(appNameOf('   '), null)
})

test('the packaging formats Linux puts an app in are read too', () => {
  assert.equal(appNameOf('/snap/chatgpt/42/bin/codex app-server'), 'the chatgpt app')
  assert.equal(
    appNameOf('/var/lib/flatpak/app/com.openai.ChatGPT/current/active/files/bin/codex'),
    'the ChatGPT app',
  )
  assert.equal(
    appNameOf('/home/dev/.local/share/flatpak/app/com.openai.ChatGPT/x/y/bin/codex'),
    'the ChatGPT app',
  )
  // An AppImage runs from a mangled temporary mount, so there is no name to
  // read and the caller says "another Codex" rather than inventing one.
  assert.equal(appNameOf('/tmp/.mount_ChatGPqW3f8x/usr/bin/codex app-server'), null)
  // A `snap` that is only a word in the path names nothing.
  assert.equal(appNameOf('/home/dev/snap/notes/thing'), null)
})
