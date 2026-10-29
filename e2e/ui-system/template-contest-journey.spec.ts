import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { TEMPLATE_TASK } from '../../script/shots/template-rig.mjs'

const run = promisify(execFile)

// Each independent mode keeps its own child deadline and disposable rig.
for (const checkMode of ['skipped', 'declared'] as const) test(`Mechanical contest finishes ${TEMPLATE_TASK} with ${checkMode} project checks through New Team`, async ({}, info) => {
  test.setTimeout(180_000)
  const cwd = resolve(import.meta.dirname, '../..')
  const out = info.outputPath('contest-frames')
  const ui = info.outputPath('renderer')
  await run('pnpm', ['--filter', '@harnessdesk/ui', 'exec', 'vite', 'build', '--outDir', ui, '--emptyOutDir'], {
    cwd, timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  const childStarted = performance.now()
  try {
    await run(process.execPath, ['script/shots/templates.mjs', '--contest', '--contest-mode', checkMode, '--out', out, '--ui', ui], {
      cwd, timeout: 120_000, maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    const failure = (error ?? {}) as { code?: string | number; signal?: string; killed?: boolean }
    await info.attach('contest-process-failure', { contentType: 'application/json', body: JSON.stringify({
      checkMode, elapsedMs: Math.round(performance.now() - childStarted),
      code: failure.code ?? null, signal: failure.signal ?? null, killed: failure.killed ?? null,
    }) })
    throw error
  }
  const sequence = JSON.parse(await readFile(resolve(out, 'sequence.json'), 'utf8')) as {
    frames: string[]
    evidence: { template: string; checkMode: string; checks: { command: string; exitCode: number }[]; rounds: string[]; settledSidebar: boolean }[]
  }
  expect(sequence.evidence.map(one => one.template)).toEqual(['mechanical-contest'])
  expect(sequence.evidence.map(one => one.checkMode)).toEqual([checkMode])
  expect(sequence.evidence[0]?.checks).toHaveLength(checkMode === 'declared' ? 2 : 0)
  expect(sequence.evidence[0]?.checks.every(one => one.command === 'pnpm test' && one.exitCode === 0)).toBe(true)
  expect(sequence.evidence[0]?.rounds).toEqual(checkMode === 'declared' ? ['competitor', 'verify', 'referee'] : ['competitor', 'referee'])
  expect(sequence.evidence.every(one => one.settledSidebar)).toBe(true)
  expect(sequence.frames).toHaveLength(8)
  expect(sequence.frames.every(frame => frame.startsWith(`mechanical-contest-${checkMode}-`))).toBe(true)
  await info.attach('contest-journey-evidence', { path: resolve(out, 'sequence.json'), contentType: 'application/json' })
  for (const frame of sequence.frames) await info.attach(frame, { path: resolve(out, frame), contentType: 'image/png' })
})
