#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { parseArgs } from 'node:util'

/**
 * Standalone entry point.
 *
 * The desktop shell embeds the host in-process instead; this exists for
 * development and for running HarnessDesk headless against a browser.
 */

const usage = `Usage: harnessdesk-host [options]

Run the headless host and serve the browser interface.

Options:
  -h, --help             Print this usage and exit
  --port <number>        Listen on this port (default: HARNESSDESK_PORT or 0)
  --ui <directory>       Serve this UI directory
  --log-level <level>    Log level (debug or info; default: info)
  --codex-binary <path>  Use this runtime binary
`

let values: Record<string, string | boolean | undefined>
try {
  values = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' },
    port: { type: 'string' }, ui: { type: 'string' },
    'log-level': { type: 'string' }, 'codex-binary': { type: 'string' },
  } }).values
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`)
  process.exit(2)
}
if (values['help']) {
  process.stdout.write(usage)
  process.exit(0)
}
const flag = (name: string): string | undefined => typeof values[name] === 'string' ? values[name] : undefined

// Usage and invalid arguments exit before loading anything that can open a home.
const { createDefaultHost, loadBuiltinPlugins } = await import('./bootstrap.js')
const { recordCrash } = await import('./crash.js')
const { openClientDoor } = await import('./client-door.js')
const { defaultStateDir } = await import('./state.js')
const { serve } = await import('./server.js')

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = flag('ui') ?? resolve(here, '../../../ui/dist')

// Crashes are captured to disk before anything else can go wrong: the
// diagnostics bundle ships them, and nothing is sent anywhere by itself —
// telemetry stays opt-in and local until there is an endpoint worth trusting.
process.on('uncaughtException', (error) => {
  try {
    recordCrash('uncaughtException', error)
  } finally {
    process.exit(1)
  }
})
process.on('unhandledRejection', (reason) => {
  recordCrash('unhandledRejection', reason)
})

const { host, logger, extensions } = createDefaultHost({
  logLevel: (flag('log-level') as 'debug' | 'info' | undefined) ?? 'info',
  // For exercising the no-Codex first run without uninstalling anything.
  codexBinaryPath: flag('codex-binary') ?? null,
})

await loadBuiltinPlugins(extensions)
await host.start()

const running = await serve({
  host,
  logger,
  port: Number(flag('port') ?? process.env['HARNESSDESK_PORT'] ?? 0),
  uiRoot,
})

const clientDoor = await openClientDoor({
  host, logger, home: defaultStateDir(),
  hostVersion: (await host.call('host/hello', { clientVersion: 'host' })).hostVersion,
})

process.stdout.write(`\nHarnessDesk host ready\n  ${running.url}/?token=${running.token}\n\n`)

const shutdown = async (signal: string): Promise<void> => {
  logger.info('shutting down', { signal })
  await clientDoor?.close()
  await running.close()
  await host.dispose()
  await extensions.dispose()
  await logger.flush()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
