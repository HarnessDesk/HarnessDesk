import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type RuntimeProcess, type RuntimeProcesses } from '@harnessdesk/protocol'

import { plainTerminalText, Terminals } from '../src/terminals.js'

/**
 * The "Last terminal output" chip's two halves: raw TTY bytes become
 * readable text, and "last" means whichever terminal printed most recently
 * — not whichever was opened last.
 */

/** A process whose output the test writes by hand. */
const fakeProcesses = (): { processes: RuntimeProcesses; print: (index: number, text: string) => void } => {
  const outputs: ((stream: 'stdout' | 'stderr', data: Uint8Array) => void)[] = []
  const processes: RuntimeProcesses = {
    spawn: () => {
      const index = outputs.length
      outputs.push(() => {})
      const process: RuntimeProcess = {
        write: async () => {},
        resize: async () => {},
        kill: async () => {},
        onOutput: (listener) => {
          outputs[index] = listener
          return () => {}
        },
        onExit: () => () => {},
      }
      return Promise.resolve(process)
    },
  }
  return { processes, print: (index, text) => outputs[index]!('stdout', Buffer.from(text)) }
}

test('escape sequences strip and a carriage return keeps only what it left behind', () => {
  // A PTY's line endings are \r\n; a lone \r mid-line is an overwrite.
  const raw = '\u001b]0;my title\u0007\u001b[32mgreen\u001b[0m line\r\nprogress 10%\rprogress 90%\rdone\r\n\n\n\n\ntail'
  assert.equal(plainTerminalText(raw), 'green line\ndone\n\ntail')
})

/**
 * A carriage return with nothing after it has overwritten nothing.
 *
 * The overwrite rule keeps what follows the last `\r` on a line, which is
 * right for a bar that redrew itself and wrong for one that has not been
 * redrawn yet: a line *ending* in `\r` has its last carriage return at the
 * final index, the slice takes nothing, and a whole line of real output
 * disappears. The cursor moved; the line stayed. Progress bars and status
 * messages are the commonest shape, and they are exactly the output somebody
 * opens a terminal to watch.
 */
test('a line ending in a carriage return keeps its text, because nothing overwrote it', () => {
  assert.equal(plainTerminalText('Building… 40%\r'), 'Building… 40%')
  // The cursor came back twice and still typed nothing.
  assert.equal(plainTerminalText('Building… 40%\r\r'), 'Building… 40%')
  // Mid-line returns still overwrite, and a trailing one still does not.
  assert.equal(plainTerminalText('10%\r90%\r'), '90%')
  // A line that is only a carriage return is an empty line, as it was.
  assert.equal(plainTerminalText('\r'), '')
})

test('a trailing carriage return on one line does not eat the lines around it', () => {
  /* The `\r\n` fold runs first, so the last line is the only one that can
     end in a bare `\r` — but a file written by something that is not a PTY
     can carry them anywhere, and none of those lines should vanish either. */
  assert.equal(plainTerminalText('first\rsecond\nthird\r\nfourth\r'), 'second\nthird\nfourth')
})

/**
 * The same rule, at the level a reader actually meets it.
 *
 * `lastOutput` re-runs `plainTerminalText` over the whole concatenated
 * scrollback each time it is asked, so the transform above is the transform
 * here — but that is a fact about the current implementation, and the chip
 * that shows a terminal to an agent reads it *between* writes. A bar sitting
 * at a bare `\r` waiting for its next frame is the ordinary state of a
 * terminal somebody is watching, and it used to read as nothing at all.
 *
 * Raised in review as implied rather than pinned, which it was.
 */
test('a terminal read between frames shows the bar, and the next frame replaces it', async () => {
  const { processes, print } = fakeProcesses()
  const terminals = new Terminals(() => {})
  await terminals.open({
    runtime: runtimeId('fake'),
    processes,
    cwd: '/build',
    size: { cols: 80, rows: 24 },
  })

  // The frame has been drawn and the cursor sent home; nothing has overwritten
  // it yet. This is the moment the chip used to report as empty.
  print(0, 'Building… 40%\r')
  assert.equal(terminals.lastOutput()?.text, 'Building… 40%')

  // The next frame lands on the same line and wins, as the overwrite rule says.
  print(0, 'Building… 80%\r')
  assert.equal(terminals.lastOutput()?.text, 'Building… 80%')

  // And once the line is finished, the bar is history and the line below is
  // its own.
  print(0, 'Building… done\r\nlinking\n')
  assert.equal(terminals.lastOutput()?.text, 'Building… done\nlinking\n')
  await terminals.dispose()
})

test('lastOutput is the most recently printing terminal, and null before any prints', async () => {
  const { processes, print } = fakeProcesses()
  const terminals = new Terminals(() => {})
  const size = { cols: 80, rows: 24 }
  await terminals.open({ runtime: runtimeId('fake'), processes, cwd: '/first', size })
  await terminals.open({ runtime: runtimeId('fake'), processes, cwd: '/second', size })

  assert.equal(terminals.lastOutput(), null, 'nothing has printed yet')

  print(1, 'from the second\n')
  // A later print from the *first* terminal makes it the last one, even
  // though it was opened first.
  await new Promise((resolve) => setTimeout(resolve, 5))
  print(0, '\u001b[31mnpm ERR!\u001b[0m missing script: bild\r\n')

  const last = terminals.lastOutput()
  assert.equal(last?.cwd, '/first')
  assert.equal(last?.text, 'npm ERR! missing script: bild\n')
  await terminals.dispose()
})

test('the terminal chip rides the sync snapshot, and resolving with no terminal says what to do', async (t) => {
  const { Client, start, stop } = await import('./fixtures/harness.js')
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  await client.until(() => client.notifications.length > 0)
  const sync = client.notifications[0] as { method?: string; params?: { contributions?: { id: string; label?: string; chip?: unknown }[] } }
  const chip = sync.params?.contributions?.find((entry) => entry.id === 'host:terminal:last-output')
  assert.ok(chip, 'the host contributes the terminal chip without any plugin host attached')
  assert.equal(chip?.label, 'Last terminal output')
  assert.ok(chip?.chip, 'declared as a chip, so it never rides every turn')

  await assert.rejects(
    () => client.call('context/resolve', { id: 'host:terminal:last-output' }),
    /No terminal has printed anything yet/,
  )
})

test('a runtime that goes away takes its shells with it', async () => {
  // #74: detachAll marked its terminals exited and killed nothing, and a
  // terminal marked exited is one close() no longer kills.
  let kills = 0
  const processes: RuntimeProcesses = {
    spawn: () =>
      Promise.resolve({
        write: async () => {},
        resize: async () => {},
        kill: async () => {
          kills += 1
        },
        onOutput: () => () => {},
        onExit: () => () => {},
      }),
  }
  const terminals = new Terminals(() => {})
  const size = { cols: 80, rows: 24 }
  await terminals.open({ runtime: runtimeId('fake'), processes, cwd: '/w', size })
  await terminals.open({ runtime: runtimeId('other'), processes, cwd: '/w', size })
  terminals.detachAll(runtimeId('fake'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(kills, 1, "the runtime's own shell, and only it")
  await terminals.dispose()
  assert.equal(kills, 2, 'dispose then kills the one still running, and not the dead one again')
})
