import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from '@playwright/test'
import { TEMPLATE_TASK } from '../../script/shots/template-rig.mjs'

const run = promisify(execFile)

test(`the shipped Team templates finish ${TEMPLATE_TASK} through the visible UI`, async ({}, info) => {
  test.setTimeout(300_000)
  const cwd = resolve(import.meta.dirname, '../..')
  const out = info.outputPath('template-frames')
  const ui = info.outputPath('renderer')
  // The server-facing browser job compiles Node packages only. Build exactly
  // this renderer in the test’s output folder, once, before opening the Host.
  await run('pnpm', ['--filter', '@harnessdesk/ui', 'exec', 'vite', 'build', '--outDir', ui, '--emptyOutDir'], {
    cwd, timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  await run(process.execPath, ['script/shots/templates.mjs', '--out', out, '--ui', ui], {
    cwd, timeout: 210_000, maxBuffer: 1024 * 1024,
  })
  const sequence = JSON.parse(await readFile(resolve(out, 'sequence.json'), 'utf8')) as { frames: string[] }
  await info.attach('template-journey-evidence', { path: resolve(out, 'sequence.json'), contentType: 'application/json' })
  for (const frame of sequence.frames) await info.attach(frame, { path: resolve(out, frame), contentType: 'image/png' })
})
