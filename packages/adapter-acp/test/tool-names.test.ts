import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toolNameOf } from '../src/runtime.js'

/**
 * What a tool call is called, when the agent will not say.
 *
 * ACP's `title` is the agent's own sentence about its own call and is almost
 * always the right answer. Cursor's is, for its own tools — `Read README.md`,
 * `Edit game.html` — and then it labels every MCP call with the literal word
 * `Mcp`. Recorded live: one turn made twenty MCP calls, nine of them the board
 * and eleven the browser, and the transcript showed twenty identical rows
 * saying nothing. The browser pane, which recognises a browser call by name,
 * reported *Idle* through all of it.
 */

test('keeps the agent’s own title when it has one', () => {
  assert.equal(toolNameOf({ title: 'Read README.md' }), 'Read README.md')
  assert.equal(toolNameOf({ title: 'Edit game.html', rawInput: { toolName: 'edit' } }), 'Edit game.html')
})

test('names an MCP call by the tool it actually called', () => {
  // Cursor's shape, copied from a live run.
  assert.equal(
    toolNameOf({
      title: 'Mcp',
      rawInput: {
        name: 'plugin-plugin-harnessdesk-browser_open',
        toolName: 'browser_open',
        args: { url: 'file:///tmp/game.html' },
      },
    }),
    'browser_open',
  )
})

test('falls back to the namespaced name when there is no bare one', () => {
  assert.equal(
    toolNameOf({ title: 'Mcp', rawInput: { name: 'harnessdesk__claim_work' } }),
    'harnessdesk__claim_work',
  )
})

test('is not fooled by a blank title or a blank name', () => {
  assert.equal(toolNameOf({ title: '   ', rawInput: { toolName: 'list_intents' } }), 'list_intents')
  assert.equal(toolNameOf({ title: 'Mcp', rawInput: { toolName: '  ' } }), 'Mcp')
})

test('says something rather than nothing when there is nothing to go on', () => {
  assert.equal(toolNameOf({ title: 'Mcp' }), 'Mcp')
  assert.equal(toolNameOf({ kind: 'fetch' }), 'fetch')
  assert.equal(toolNameOf({}), 'tool')
  // A raw input that is not an object must not throw on the way past.
  assert.equal(toolNameOf({ rawInput: 'not an object' }), 'tool')
  assert.equal(toolNameOf({ rawInput: null }), 'tool')
})

/**
 * And through the whole life of the call, not only its announcement.
 *
 * The first cut resolved the name where a row was *created* and let the merge
 * copy `update.title` verbatim, so a completion carrying the same generic
 * title put `Mcp` back over `browser_open`. The completed transcript is the
 * one a person reads afterwards, and browser attribution reads the name off
 * the finished row — so the row that mattered most was the one that lost it.
 */
test('a completion does not put the generic title back over a resolved name', () => {
  const started = toolNameOf({
    title: 'Mcp',
    rawInput: { name: 'plugin-plugin-harnessdesk-browser_open', toolName: 'browser_open' },
  })
  assert.equal(started, 'browser_open')
  // The update that finishes it knows nothing new: same generic title, no
  // input of its own. It must not be allowed to rename the call.
  assert.equal(toolNameOf({ title: 'Mcp' }, started), 'browser_open')
  assert.equal(toolNameOf({ title: 'Mcp', rawInput: {} }, started), 'browser_open')
})

test('a real title on the update still wins, because it is the agent’s own words', () => {
  assert.equal(toolNameOf({ title: 'Read README.md' }, 'browser_open'), 'Read README.md')
})

test('an update that finally names the tool improves on a generic name already stored', () => {
  assert.equal(toolNameOf({ title: 'Mcp', rawInput: { toolName: 'browser_key' } }, 'Mcp'), 'browser_key')
})

/**
 * A title that is only the thing the call touched.
 *
 * DeepSeek Harness's bridge titles a read with the path alone — `README.md`,
 * kind `read`, `file_path: README.md` — so the row said a file name with the
 * generic tool glyph and printed the argument again beneath it. ACP's `kind`
 * is the verb the title left out, and it is only put back when the title is
 * nothing but that call's own path or pattern: an agent's own sentence is
 * never rewritten.
 */
test('puts the verb back on a title that is only its own path', () => {
  assert.equal(toolNameOf({ title: 'README.md', kind: 'read', rawInput: { file_path: 'README.md' } }), 'Read README.md')
  assert.equal(toolNameOf({ title: 'src/a.ts', kind: 'edit', rawInput: { path: 'src/a.ts', old_string: 'a' } }), 'Edit src/a.ts')
  assert.equal(toolNameOf({ title: 'TODO', kind: 'search', rawInput: { pattern: 'TODO' } }), 'Search TODO')
})

test('never rewrites a title that already says something', () => {
  assert.equal(toolNameOf({ title: 'Read README.md', kind: 'read', rawInput: { file_path: 'README.md' } }), 'Read README.md')
  assert.equal(toolNameOf({ title: 'Checking the config', kind: 'read', rawInput: { file_path: 'a.json' } }), 'Checking the config')
  // A command is its own title; the row reads it from the arguments.
  assert.equal(toolNameOf({ title: 'ls -a', kind: 'execute', rawInput: { command: 'ls -a' } }), 'ls -a')
  // A plan tool keeps its name; the transcript knows what a plan call is.
  assert.equal(toolNameOf({ title: 'todo_write', kind: 'think', rawInput: { todos: [] } }), 'todo_write')
  // A kind with no verb to lend leaves the title alone.
  assert.equal(toolNameOf({ title: 'notes.md', kind: 'other', rawInput: { file_path: 'notes.md' } }), 'notes.md')
})

test('a later notice repeating the bare title keeps the verb already put back', () => {
  const first = toolNameOf({ title: 'README.md', kind: 'read', rawInput: { file_path: 'README.md' } })
  assert.equal(toolNameOf({ title: 'README.md', kind: 'read' }, first), 'Read README.md')
})
