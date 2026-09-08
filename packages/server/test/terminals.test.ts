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
