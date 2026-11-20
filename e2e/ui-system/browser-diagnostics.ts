// Private diagnostic-branch proposal only. Not built, tested or applied.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession, ConsoleMessage, Page, TestInfo } from '@playwright/test'

const PREFIX = 'HD_COVERAGE_DIAGNOSTIC '
const SEGMENT_BYTES = 4 * 1024 * 1024
const RECORD_BYTES = 64 * 1024

/** Own files only: two 4MiB segments, atomic small metadata and immutable baselines. */
const journal = (directory: string, stem: string) => {
  let enabled = true, bytes = 0, sequence = 0, rotations = 0, clipped = 0, discardedSegments = 0
  const current = join(directory, stem + '.current.ndjson')
  const previous = join(directory, stem + '.previous.ndjson')
  const metadata = join(directory, stem + '.metadata.json')
  const disable = (where: string, error: unknown) => {
    if (!enabled) return
    enabled = false
    // A broken diagnostic must never replace the original test failure.
    const text = String(error)
    const errorClipped = text.length > 2048
    if (errorClipped) clipped++
    const failure = { kind: 'browser-diagnostic-disabled', stem, where, error: text.slice(0, 2048), errorClipped, rotations, clipped, sequence }
    try { process.stderr.write(JSON.stringify(failure) + '\n') } catch {}
    try { writeFileSync(metadata + '.writing', JSON.stringify({ ...failure, disabled: true, segmentBytes: SEGMENT_BYTES, maxSegments: 2 }) + '\n'); renameSync(metadata + '.writing', metadata) } catch {}
  }
  const meta = () => {
    writeFileSync(metadata + '.writing', JSON.stringify({ version: 1, segmentBytes: SEGMENT_BYTES, maxSegments: 2,
      maxRecordBytes: RECORD_BYTES, rotations, discardedSegments, clippedRecords: clipped, sequence, currentBytes: bytes }) + '\n')
    renameSync(metadata + '.writing', metadata)
  }
  const raw = (kind: string, data: unknown, currentCase: string) => {
    const text = JSON.stringify({ sequence: ++sequence, wallMs: Date.now(), nodeMonoMs: performance.now(), kind, currentCase, data }) + '\n'
    appendFileSync(current, text); bytes += Buffer.byteLength(text)
  }
  const write = (kind: string, data: unknown, currentCase = '') => {
    if (!enabled) return
    try {
      const candidateBytes = Buffer.byteLength(JSON.stringify({ kind, data, currentCase })) + 256
      if (candidateBytes > RECORD_BYTES) {
        clipped++
        data = { originalKind: kind, originalBytes: candidateBytes, recordLimit: RECORD_BYTES }
        kind = 'diagnostic-record-clipped'
      }
      if (bytes + Math.min(candidateBytes, RECORD_BYTES) > SEGMENT_BYTES) {
        if (rotations > 0) discardedSegments++
        rmSync(previous, { force: true })
        renameSync(current, previous)
        writeFileSync(current, '', { flag: 'wx' })
        bytes = 0; rotations++
        raw('diagnostic-rotation', { rotations, discardedSegments, clippedRecords: clipped }, currentCase)
      }
      raw(kind, data, currentCase); meta()
    } catch (error) { disable('journal', error) }
  }
  const immutable = (name: string, data: unknown) => {
    if (!enabled) return false
    try {
      const text = JSON.stringify(data, null, 2) + '\n'
      if (Buffer.byteLength(text) > RECORD_BYTES) throw new Error('Immutable baseline exceeds explicit 64KiB limit; baseline not clipped')
      writeFileSync(join(directory, stem + '.' + name + '.json'), text, { flag: 'wx' })
      return true
    } catch (error) { disable('immutable-' + name, error); return false }
  }
  try { mkdirSync(directory, { recursive: true }); writeFileSync(current, '', { flag: 'wx' }); meta() }
  catch (error) { disable('initialize', error) }
  return { write, immutable, disable, get enabled() { return enabled } }
}

export const startCatalogueDiagnostics = async (page: Page, browser: Browser, info: TestInfo) => {
  if (process.env.HD_BROWSER_DIAGNOSTICS !== '1') return undefined
  const directory = join(dirname(info.project.outputDir), 'diagnostics', `worker-${info.workerIndex}`)
  const stem = `catalogue-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  const sink = journal(directory, stem)
  let stopped = false, currentCase = info.titlePath.join(' > ')
  let timer: ReturnType<typeof setInterval> | undefined
  let browserCdp: CDPSession | undefined, pageCdp: CDPSession | undefined
  let sampleNow = () => {}
  const write = (kind: string, data: unknown) => { if (!stopped) sink.write(kind, data, currentCase) }
  const read = (file: string) => {
    try { return { value: readFileSync(file, 'utf8').trim() } }
    catch (error) { return { unavailable: error instanceof Error ? error.message : String(error) } }
  }
  const starts = new Map<number, string>()
  const ownedStatus = (pid: number) => {
    // Kernel metadata only: no environ, command lines, account or credential reads.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (!startTicks) return { pid, unavailable: 'start time missing' }
      const earlier = starts.get(pid)
      if (earlier && earlier !== startTicks) return { pid, unavailable: 'PID reused; no longer this browser process' }
      starts.set(pid, startTicks)
      const fields = Object.fromEntries(readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')
        .map(line => line.split(':', 2)).filter(([name]) => ['Name', 'State', 'PPid', 'VmRSS', 'VmHWM', 'VmSize', 'Threads'].includes(name!)))
      return { pid, startTicks, fields }
    } catch (error) { return { pid, unavailable: error instanceof Error ? error.message : String(error) } }
  }
  const cgroupDirectories = new Set(['/sys/fs/cgroup'])
  if (process.platform === 'linux') {
    const own = read('/proc/self/cgroup')
    if ('value' in own && own.value) {
      const relative = own.value.split('\n').find(line => line.startsWith('0::'))?.slice(3)
      if (relative) {
        const path = resolve('/sys/fs/cgroup', '.' + relative)
        if (path === '/sys/fs/cgroup' || path.startsWith('/sys/fs/cgroup' + sep)) cgroupDirectories.add(path)
      }
    }
  }
  const cgroups = () => process.platform !== 'linux' ? { unavailable: 'Linux cgroups unavailable on this platform' }
    : [...cgroupDirectories].map(directory => ({ directory, values: Object.fromEntries(
      ['memory.current', 'memory.max', 'memory.events', 'memory.events.local', 'memory.pressure']
        .map(name => [name, read(join(directory, name))]),
    ) }))
  const onConsole = (message: ConsoleMessage) => {
    const text = message.text()
    if (text.startsWith(PREFIX)) {
      try { write('sweep-progress', JSON.parse(text.slice(PREFIX.length))) }
      catch (error) { sink.disable('progress-parse', error) }
    } else if (message.type() === 'error') write('console-error', { text, location: message.location() })
  }
  const onPageError = (error: Error) => write('page-error', { message: error.message, stack: error.stack })
  const onCrash = () => { write('page-crash', {}); sampleNow() }
  const onClose = () => write('page-close', {})
  const onDisconnected = () => write('browser-disconnected', {})
  const cleanup = () => {
    try {
      if (timer) clearInterval(timer)
      page.off('console', onConsole); page.off('pageerror', onPageError); page.off('crash', onCrash); page.off('close', onClose)
      browser.off('disconnected', onDisconnected)
      void pageCdp?.detach().catch(() => {})
      void browserCdp?.detach().catch(() => {})
    } catch (error) { sink.disable('cleanup', error) }
  }
  try {
    if (!sink.immutable('startup', { version: 1, wallMs: Date.now(), nodeMonoMs: performance.now(), pid: process.pid,
      node: process.version, chrome: browser.version(), playwright: info.config.version, platform: process.platform,
      availableParallelism: availableParallelism(), workerIndex: info.workerIndex, parallelIndex: info.parallelIndex,
      testFile: info.file, workers: info.config.workers, retries: info.project.retries, configuredTestTimeout: info.project.timeout,
      viewport: page.viewportSize(), colorScheme: info.project.use.colorScheme, reducedMotion: info.project.use.reducedMotion,
      sourceSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      cgroupMembership: read('/proc/self/cgroup'), cgroups: cgroups() })) return undefined
    page.on('console', onConsole); page.on('pageerror', onPageError); page.on('crash', onCrash); page.on('close', onClose)
    browser.on('disconnected', onDisconnected)
    browserCdp = await browser.newBrowserCDPSession()
    pageCdp = await page.context().newCDPSession(page)
    browserCdp.on('Target.targetCrashed', event => { write('target-crashed', event); sampleNow() })
    browserCdp.on('Target.targetDestroyed', event => write('target-destroyed', event))
    pageCdp.on('Inspector.targetCrashed', event => write('inspector-target-crashed', event))
    const setup = await Promise.allSettled([
      browserCdp.send('Target.setDiscoverTargets', { discover: true }), pageCdp.send('Inspector.enable'), pageCdp.send('Performance.enable'),
    ])
    setup.forEach((result, index) => { if (result.status === 'rejected') write('cdp-setup-unavailable', { index, error: String(result.reason) }) })
    const initial = await Promise.allSettled([browserCdp.send('Browser.getVersion'), browserCdp.send('SystemInfo.getProcessInfo'), pageCdp.send('Performance.getMetrics')] as const)
    if (!sink.immutable('cdp-baseline', { wallMs: Date.now(), results: initial.map(result => result.status === 'fulfilled' ? result : { status: 'rejected', reason: String(result.reason) }), cgroups: cgroups() })) { cleanup(); return undefined }
    const known = new Set<number>()
    if (initial[1]?.status === 'fulfilled') for (const process of initial[1].value.processInfo) known.add(process.id)
    let processPendingAt: number | null = null, metricsPendingAt: number | null = null
    const sample = () => {
      if (stopped || !sink.enabled) return
      try {
        // OS reads continue while renderer metrics or browser-CDP requests are pending.
        write('os-sample', { processes: [...known].map(ownedStatus), cgroups: cgroups(), processPendingAt, metricsPendingAt })
        if (processPendingAt === null && browserCdp) {
          processPendingAt = performance.now()
          void browserCdp.send('SystemInfo.getProcessInfo').then(result => {
            for (const process of result.processInfo) known.add(process.id)
            write('browser-processes', result.processInfo)
          }).catch(error => write('process-info-unavailable', String(error))).finally(() => { processPendingAt = null })
        }
        if (metricsPendingAt === null && pageCdp) {
          metricsPendingAt = performance.now()
          void pageCdp.send('Performance.getMetrics').then(result => write('page-metrics', result.metrics))
            .catch(error => write('page-metrics-unavailable', String(error))).finally(() => { metricsPendingAt = null })
        }
      } catch (error) { sink.disable('sampler', error) }
    }
    sampleNow = sample; sample()
    timer = setInterval(sample, 2000); timer.unref()
    return {
      caseStarted(next: TestInfo) {
        try { currentCase = next.titlePath.join(' > '); write('case-start', { beforeEachTimeout: next.timeout, workerIndex: next.workerIndex, parallelIndex: next.parallelIndex }); sample() }
        catch (error) { sink.disable('case-metadata', error) }
      },
      stop() { write('stop', {}); stopped = true; cleanup() },
    }
  } catch (error) { write('setup-failed', String(error)); sink.disable('setup', error); stopped = true; cleanup(); return undefined }
}
