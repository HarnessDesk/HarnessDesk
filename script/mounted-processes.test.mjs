import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { processesUnder, stopProcessesUnder } from './mounted-processes.mjs'

const MOUNT = '/release/.smoke-Ab12'
const PS = [
  `  101 ${MOUNT}/HarnessDesk.app/Contents/MacOS/HarnessDesk --user-data-dir=/tmp/hd-smoke-profile-x --remote-debugging-port=9271 --use-mock-keychain`,
  `  102 ${MOUNT}/HarnessDesk.app/Contents/Frameworks/HarnessDesk Helper (GPU).app/Contents/MacOS/HarnessDesk Helper (GPU) --type=gpu-process`,
  '  201 /Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk',
  '  202 /Applications/HarnessDesk.app/Contents/Frameworks/HarnessDesk Helper (GPU).app/Contents/MacOS/HarnessDesk Helper (GPU) --type=gpu-process',
  `  203 /release/.smoke-Ab123/HarnessDesk.app/Contents/MacOS/HarnessDesk`,
  `  204 /usr/bin/tail -f ${MOUNT}/HarnessDesk.app/Contents/Resources/app.log`,
  `  205 HarnessDesk ${MOUNT}/HarnessDesk.app`,
  `  300 /usr/local/bin/node script/release.mjs smoke-artifacts`,
  '',
  'garbage line',
].join('\n')

test('only executables under the mount match: never an installed copy, a sibling mount, or an argument naming it', () => {
  assert.deepEqual(processesUnder(MOUNT, PS).map(({ pid }) => pid), [101, 102])
  assert.deepEqual(processesUnder(`${MOUNT}/`, PS).map(({ pid }) => pid), [101, 102], 'a trailing slash changes nothing')
  assert.match(processesUnder(MOUNT, PS)[1].command, /Helper \(GPU\) --type=gpu-process$/, 'a path with spaces is kept whole')
})

test('a bundle prefix matches its own processes and not the installed app of the same name', () => {
  assert.deepEqual(processesUnder(`${MOUNT}/HarnessDesk.app`, PS).map(({ pid }) => pid), [101, 102])
  assert.deepEqual(processesUnder('/Applications/HarnessDesk.app', PS).map(({ pid }) => pid), [201, 202])
})

test('this process is never matched, and the filesystem root is refused', () => {
  assert.deepEqual(processesUnder(MOUNT, PS, { self: 101 }).map(({ pid }) => pid), [102])
  assert.throws(() => processesUnder('/', PS), /filesystem root/)
  assert.throws(() => processesUnder('', PS), /filesystem root/)
})

/** A scripted process table: SIGTERM ends `polite` pids, everything else needs SIGKILL. */
const table = (initial, { polite = [], appears = [] } = {}) => {
  const running = new Map(initial.map((line) => [Number(/^\s*(\d+)/.exec(line)[1]), line]))
  const signals = []
  let polls = 0
  return {
    signals,
    ps: () => {
      if (++polls === 2) for (const line of appears) running.set(Number(/^\s*(\d+)/.exec(line)[1]), line)
      return [...running.values()].join('\n')
    },
    kill: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL' || polite.includes(pid)) running.delete(pid)
    },
    sleep: async () => {},
    log: () => {},
  }
}

test('stopping sends SIGTERM only to processes under the mount, and returns once they are gone', async () => {
  const lines = PS.split('\n').filter((line) => /^\s*\d/.test(line))
  const fake = table(lines, { polite: [101, 102] })
  const stopped = await stopProcessesUnder(MOUNT, fake)
  assert.deepEqual(stopped.map(({ pid }) => pid), [101, 102])
  assert.deepEqual(fake.signals, [[101, 'SIGTERM'], [102, 'SIGTERM']])
})

test('a process that ignores SIGTERM is killed after the timeout, and one that appears meanwhile is stopped too', async () => {
  const fake = table([`  101 ${MOUNT}/HarnessDesk.app/Contents/MacOS/HarnessDesk`], {
    appears: [`  111 ${MOUNT}/HarnessDesk.app/Contents/MacOS/HarnessDesk --relaunched`],
  })
  const stopped = await stopProcessesUnder(MOUNT, { ...fake, timeoutMs: 1000, pollMs: 250 })
  assert.deepEqual(stopped.map(({ pid }) => pid), [101, 111])
  assert.deepEqual(fake.signals, [[101, 'SIGTERM'], [111, 'SIGTERM'], [101, 'SIGKILL'], [111, 'SIGKILL']])
})

test('nothing running under the mount sends no signal at all', async () => {
  const fake = table(['  201 /Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk'])
  assert.deepEqual(await stopProcessesUnder(MOUNT, fake), [])
  assert.deepEqual(fake.signals, [])
})

test('against the real process table: a process run from the folder is stopped, the same binary elsewhere is not', { skip: process.platform !== 'darwin' && 'the release machine is a Mac; ps flags differ elsewhere' }, async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'hd-mounted-')))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  symlinkSync('/bin/sleep', join(folder, 'sleep'))
  const inside = spawn(join(folder, 'sleep'), ['30'], { stdio: 'ignore' })
  const outside = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  t.after(() => { outside.kill('SIGKILL'); inside.kill('SIGKILL') })
  const exited = new Promise((done) => inside.once('exit', done))
  await new Promise((done) => setTimeout(done, 200))
  const stopped = await stopProcessesUnder(folder, { log: () => {}, pollMs: 50 })
  assert.deepEqual(stopped.map(({ pid }) => pid), [inside.pid])
  await exited
  assert.equal(outside.exitCode, null, 'the same binary outside the folder is still running')
})
