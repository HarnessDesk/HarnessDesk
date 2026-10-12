// The recording build of `@playwright/test`. `script/ui-impact/tsconfig.json` points the specs'
// `@playwright/test` import at this file, so the suite can be recorded without editing a spec:
//
//   UI_IMPACT_DIR=output/ui-impact playwright test -c playwright.ui-system.config.ts --tsconfig script/ui-impact/tsconfig.json
//
// Every test also records which modules its page loaded and in which of them some function ran.
// A worker keeps one entry per spec file and writes them when it ends; `script/ui-impact.mjs merge`
// folds those files, from every shard, into the map a pull request is planned against.
//
// It asks the browser only whether a function ran (best-effort coverage: no call counts, no source
// text, no block ranges), which costs under a tenth of a run; Playwright's own coverage reads every
// script back and cost half as much again.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import * as real from '../../node_modules/@playwright/test/index.mjs'

export * from '../../node_modules/@playwright/test/index.mjs'

type Seen = { tests: number; unclean: number; loaded: Set<string>; ran: Set<string> }
type Script = { url: string; functions: { functionName: string; ranges: { count: number }[] }[] }

const directory = process.env.UI_IMPACT_DIR ?? 'output/ui-impact'

// The dev server adds to every component module a few calls of its own (React Refresh): two named
// functions, and the one anonymous function it queues to register the module's exports. They say
// nothing about the module, so they are not counted.
const ranOwnCode = (script: Script) => {
  const called = script.functions.slice(1).filter(fn => (fn.ranges[0]?.count ?? 0) > 0 && fn.functionName !== '$RefreshReg$' && fn.functionName !== '$RefreshSig$')
  const refreshed = script.functions.some(fn => fn.functionName === '$RefreshReg$')
  const anonymousOnce = called.filter(fn => fn.functionName === '' && fn.ranges[0].count === 1).length
  return called.length - (refreshed && anonymousOnce > 0 ? 1 : 0) > 0
}

export const test = real.test.extend<{ impactRecorder: void }, { impactSink: Map<string, Seen> }>({
  impactSink: [async ({}, use, workerInfo) => {
    const sink = new Map<string, Seen>()
    await use(sink)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, `worker-${process.env.UI_IMPACT_SHARD ?? 'x'}-${workerInfo.workerIndex}-${process.pid}.json`), JSON.stringify(
      Object.fromEntries([...sink].map(([file, seen]) => [file, {
        tests: seen.tests, unclean: seen.unclean, loaded: [...seen.loaded].sort(), ran: [...seen.ran].sort(),
      }])),
    ))
  }, { scope: 'worker', auto: true }],
  impactRecorder: [async ({ page, impactSink }, use, testInfo) => {
    const file = path.relative(process.cwd(), testInfo.file).split(path.sep).join('/')
    const seen = impactSink.get(file) ?? { tests: 0, unclean: 0, loaded: new Set<string>(), ran: new Set<string>() }
    // Anything that stops the browser from answering makes this test's record unusable, and the spec
    // with it: a record that cannot be trusted must not look like a record of a page that ran nothing.
    let failed = false
    const reads: Promise<void>[] = []
    // Each read starts the browser's record afresh, so every read adds to what the test has seen.
    let cdp: Awaited<ReturnType<ReturnType<typeof page.context>['newCDPSession']>> | undefined
    const read = async () => {
      try {
        const { result } = await cdp!.send('Profiler.takePreciseCoverage')
        for (const script of result as Script[]) {
          let key: string
          try {
            const url = new URL(script.url)
            if (!/^https?:$/.test(url.protocol)) continue
            key = decodeURIComponent(url.pathname)
          } catch { continue }
          seen.loaded.add(key)
          if (ranOwnCode(script)) seen.ran.add(key)
        }
      } catch {
        failed = true
      }
    }
    try {
      cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false })
      // A page that is about to be replaced is read first, while its scripts are still alive.
      await cdp.send('Page.enable')
      cdp.on('Page.frameStartedNavigating', () => { reads.push(read()) })
    } catch {
      failed = true
    }
    await use()
    if (cdp && !failed) {
      reads.push(read())
      await Promise.all(reads)
      await cdp.send('Profiler.stopPreciseCoverage').catch(() => undefined)
    }
    seen.tests += 1
    // A test that ended as it was meant to (a failure that was expected, or a skip) taught nothing wrong.
    if (failed || (testInfo.status !== testInfo.expectedStatus && testInfo.status !== 'skipped')) seen.unclean += 1
    impactSink.set(file, seen)
  }, { auto: true }],
})
