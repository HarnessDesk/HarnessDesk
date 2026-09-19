import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkEnvironment, runCommand, TAIL_LIMIT } from '../src/evidence/run.js'
import { tempDir } from './scratch.js'

/*
 * The runner an approved check goes through: its status, the end of what it
 * said, an environment of its own, and its process group stopped with it —
 * the group, and nothing wider.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a command exits with its status and the end of what it printed, both streams', async () => {
  const cwd = tempDir('hd-run-')
  assert.deepEqual(await runCommand("printf 'one\\n'; echo two >&2; exit 3", { cwd, timeoutSec: 10 }), {
    exit: 3,
    timedOut: false,
    tail: 'one\ntwo\n',
  })
  assert.equal((await runCommand('true', { cwd, timeoutSec: 10 })).exit, 0)
})

test('a command that runs past its time is stopped, with everything it started', async () => {
  const cwd = tempDir('hd-run-')
  const run = await runCommand('sleep 30 & echo $! > child.pid; wait', { cwd, timeoutSec: 1 })
  assert.equal(run.exit, null)
  assert.equal(run.timedOut, true)
  assert.match(run.tail, /It ran past 1s and was stopped\.$/)
  const child = Number(await readFile(join(cwd, 'child.pid'), 'utf8'))
  assert.equal(alive(child), false, 'the run does not answer until the child it started is gone')
})

test('a child still holding its output after the shell exits does not hold the check open', async () => {
  const cwd = tempDir('hd-run-')
  const started = Date.now()
  const run = await runCommand('sleep 30 & echo $! > child.pid; exit 0', { cwd, timeoutSec: 20 })
  assert.equal(run.exit, 0)
  assert.ok(Date.now() - started < 5_000, 'it answered once the shell was done, not when the child was')
  assert.equal(alive(Number(await readFile(join(cwd, 'child.pid'), 'utf8'))), false, 'the held pipe is closed and its child is gone')
})

test('a command that could not start says why, and has no status', async () => {
  const run = await runCommand('true', { cwd: join(tempDir('hd-run-'), 'not-here'), timeoutSec: 5 })
  assert.equal(run.exit, null)
  assert.equal(run.timedOut, false)
  assert.match(run.tail, /^It did not start: /)
})

test('only the last of a long output is kept, and without its colour codes', async () => {
  const cwd = tempDir('hd-run-')
  const script = "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done; printf '\\033[31mcolour-sentinel\\033[0m\\n'"
  const run = await runCommand(script, { cwd, timeoutSec: 20 })
  assert.equal(run.exit, 0)
  assert.equal(run.tail.length, TAIL_LIMIT)
  assert.ok(run.tail.includes('colour-sentinel'))
  assert.equal(run.tail.includes('\x1b'), false)
})

test('the retained tail has no Unicode C1, string, or incomplete terminal controls', async () => {
  const cwd = tempDir('hd-run-')
  await writeFile(
    join(cwd, 'controls.cjs'),
    "process.stdout.write('left\\u009b31mred\\u009b0m\\x1b]0;title\\x07 right\\x1b[31')\n",
  )
  const run = await runCommand(`${JSON.stringify(process.execPath)} controls.cjs`, { cwd, timeoutSec: 10 })
  assert.equal(run.tail, 'leftred right')
  assert.doesNotMatch(run.tail, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
})

test('a check the desk stops is stopped at once, with everything it started', async () => {
  const cwd = tempDir('hd-run-')
  const stop = new AbortController()
  const running = runCommand('sleep 30 & echo $! > child.pid; wait', { cwd, timeoutSec: 60, signal: stop.signal })
  await new Promise((resolve) => setTimeout(resolve, 300))
  stop.abort()
  const run = await running
  assert.equal(run.exit, null)
  assert.equal(run.timedOut, false)
  assert.match(run.tail, /It was stopped: the desk closed\.$/)
  assert.equal(alive(Number(await readFile(join(cwd, 'child.pid'), 'utf8'))), false, 'the stop does not answer before the child is gone')
})

test("a check's environment is built from a short list of names: nothing else of the desk's reaches it", () => {
  const desk = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/alice',
    LANG: 'en_GB.UTF-8',
    TERM: 'xterm-256color',
    HARNESSDESK_HOME: '/home/alice/.harnessdesk',
    HARNESSDESK_PORT: '4870',
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'gho_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-secret',
    NODE_OPTIONS: '--require /tmp/x.js',
    ELECTRON_RUN_AS_NODE: '1',
    CLAUDECODE: '1',
  }
  assert.deepEqual(checkEnvironment(desk), { TERM: 'dumb', PATH: '/usr/bin:/bin', HOME: '/home/alice', LANG: 'en_GB.UTF-8' })
})

test("the command itself sees only that environment: a secret in the desk's is not there", async (t) => {
  const names = ['HARNESSDESK_HOME', 'HARNESSDESK_CORRELATION', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  for (const name of names) process.env[name] = name === 'NODE_OPTIONS' ? '--no-warnings' : `canary-${name}`
  const run = await runCommand('env', { cwd: tempDir('hd-run-'), timeoutSec: 10 })
  assert.equal(run.exit, 0)
  const seen = new Set(run.tail.split('\n').map((line) => line.split('=')[0]))
  for (const name of names) assert.equal(seen.has(name), false, `${name} reached the check`)
  assert.equal(run.tail.includes('canary-'), false)
  assert.ok(seen.has('PATH') && seen.has('HOME'), 'what a command needs to find its tools is there')
  assert.match(run.tail, /^TERM=dumb$/m)
})

test('a process that leaves the group is not stopped with it: the guarantee is the group, and nothing wider', async (t) => {
  const cwd = tempDir('hd-run-')
  // A daemon: a process in a session of its own, which a group kill does not reach.
  await writeFile(
    join(cwd, 'escape.cjs'),
    `const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' })
require('node:fs').writeFileSync('escaped.pid', String(child.pid))
child.unref()
`,
  )
  const run = await runCommand(`${JSON.stringify(process.execPath)} escape.cjs; sleep 30`, { cwd, timeoutSec: 1 })
  assert.equal(run.timedOut, true)
  const escaped = Number(await readFile(join(cwd, 'escaped.pid'), 'utf8'))
  t.after(() => {
    try {
      process.kill(escaped, 'SIGKILL')
    } catch {
      // Gone already.
    }
  })
  assert.equal(alive(escaped), true, 'this is the documented limit, not a promise: a daemon outlives its check')
})

test('a check asked to start after the desk has begun closing never starts', async () => {
  const cwd = tempDir('hd-run-')
  const stop = new AbortController()
  stop.abort()
  const run = await runCommand('touch started', { cwd, timeoutSec: 10, signal: stop.signal })
  assert.deepEqual(run, { exit: null, timedOut: false, tail: 'It was stopped: the desk closed.' })
  await assert.rejects(readFile(join(cwd, 'started')))
})
