#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { createDefaultHost, loadBuiltinPlugins } from './bootstrap.js'
import { recordCrash } from './crash.js'
import { serve } from './server.js'

/**
 * Standalone entry point.
 *
 * The desktop shell embeds the host in-process instead; this exists for
 * development and for running HarnessDesk headless against a browser.
 */

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

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

process.stdout.write(`\nHarnessDesk host ready\n  ${running.url}/?token=${running.token}\n\n`)

const shutdown = async (signal: string): Promise<void> => {
  logger.info('shutting down', { signal })
  await running.close()
  await host.dispose()
  await extensions.dispose()
  await logger.flush()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
