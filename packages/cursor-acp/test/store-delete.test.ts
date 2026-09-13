import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { chatPath, trashChat, workspaceKey } from '../src/index.js'

/**
 * The one write this bridge makes to Cursor's store, and the limits on it.
 *
 * Everything else in `store.ts` is read-only on purpose — a bridge that
 * edited another app's records would break the moment that app changed them.
 * Removing a whole chat folder is not an edit: the folder is opaque to this
 * module whatever version wrote it, and it goes to the Trash rather than
 * away, so nothing here can lose work that cannot be dragged back.
 */

const makeChat = (home: string, cwd: string, chatId: string): string => {
  const dir = join(home, '.cursor', 'chats', workspaceKey(cwd), chatId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))
  return dir
}

test('a chat is found by id across every workspace bucket', () => {
  const home = tempDir('cursor-store-')
  const wanted = makeChat(home, '/repo/one', 'chat-a')
  makeChat(home, '/repo/two', 'chat-b')

  // Cursor files chats under the md5 of the folder they ran in, and that does
  // not run backwards — so a delete carrying only an id has to look in each.
  assert.equal(chatPath('chat-a', home), wanted)
  assert.notEqual(chatPath('chat-b', home), null)

  // Nothing stored, and nothing pretending to be an id, reach nothing.
  assert.equal(chatPath('chat-c', home), null)
  assert.equal(chatPath('../../..', home), null)
  assert.equal(chatPath('', home), null)
})

test('a deleted chat goes to the Trash, not away', () => {
  const home = tempDir('cursor-trash-')
  const dir = makeChat(home, '/repo/one', 'chat-a')

  assert.equal(trashChat(dir, home), true)
  assert.equal(existsSync(dir), false)
  assert.deepEqual(readdirSync(join(home, '.Trash')), ['chat-a'])
  assert.equal(chatPath('chat-a', home), null)

  // A second chat of the same id from another workspace does not land on top
  // of the first one sitting in the Trash.
  const again = makeChat(home, '/repo/two', 'chat-a')
  assert.equal(trashChat(again, home), true)
  assert.deepEqual(readdirSync(join(home, '.Trash')).sort(), ['chat-a', 'chat-a 2'])

  // A folder that is not there is false, not a throw.
  assert.equal(trashChat(join(home, 'nowhere'), home), false)
})

test('trashChat does not overwrite a broken symlink in the Trash (#316)', () => {
  const home = tempDir('cursor-trash-broken-symlink-')
  const trashDir = join(home, '.Trash')
  mkdirSync(trashDir, { recursive: true })

  // Control: normal file in Trash triggers numbered suffix
  const controlChat = makeChat(home, '/repo/control', 'chat-control')
  writeFileSync(join(trashDir, 'chat-control'), 'occupied')
  assert.equal(trashChat(controlChat, home), true)
  assert.deepEqual(readdirSync(trashDir).sort(), ['chat-control', 'chat-control 2'])

  // Place a broken symlink named 'chat-broken' into the Trash pointing to a non-existent target
  const brokenLinkPath = join(trashDir, 'chat-broken')
  symlinkSync(join(home, 'nonexistent-target'), brokenLinkPath)
  assert.equal(lstatSync(brokenLinkPath).isSymbolicLink(), true)

  const chatDir = makeChat(home, '/repo/test', 'chat-broken')
  assert.equal(trashChat(chatDir, home), true)

  // The broken symlink must not be overwritten; the trashed chat should become 'chat-broken 2'
  assert.equal(lstatSync(brokenLinkPath).isSymbolicLink(), true, 'control: original broken symlink still exists')
  assert.deepEqual(readdirSync(trashDir).sort(), ['chat-broken', 'chat-broken 2', 'chat-control', 'chat-control 2'])
})
