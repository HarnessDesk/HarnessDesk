import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { mergePermissions, PluginCapabilityHost } from '../src/index.js'

/**
 * The host serves a confined plugin's `ctx.http` and `ctx.android`
 * (docs/plugin-isolation.md, layer 4). The signal it is handed is the plugin
 * process's lifetime: when the plugin stops, work it started in the host
 * stops with it, rather than finishing for a plugin that is gone.
 */

const within = async <T>(ms: number, work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${ms}ms`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

test('an HTTP request the host makes for a plugin ends when the plugin stops', async (t) => {
  let closed = false
  let arrived: () => void = () => {}
  const reached = new Promise<void>((resolve) => { arrived = resolve })
  // Answers nothing: the request would run to its 20 s timeout.
  const server = createServer((request: IncomingMessage) => {
    request.socket.on('close', () => { closed = true })
    arrived()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const port = (server.address() as { port: number }).port

  const stopped = new AbortController()
  const host = new PluginCapabilityHost('p', mergePermissions({ network: { hosts: ['127.0.0.1'] } }), () => ({ signal: stopped.signal }))
  const call = host.serve({ kind: 'http', url: `http://127.0.0.1:${port}/`, init: { method: 'POST', body: 'x', timeoutMs: 20_000 } }, undefined)
  await reached
  stopped.abort()
  await within(2_000, assert.rejects(call))
  await within(2_000, (async () => { while (!closed) await new Promise((resolve) => setTimeout(resolve, 20)) })())
})

test('an Android command the host runs for a plugin ends when the plugin stops', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hd-adb-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // An adb that would take a minute to list the devices.
  const adb = join(directory, 'adb')
  await writeFile(adb, '#!/bin/sh\nexec sleep 60\n')
  await chmod(adb, 0o755)
  const previous = process.env['HARNESSDESK_ADB']
  process.env['HARNESSDESK_ADB'] = adb
  t.after(() => {
    if (previous === undefined) delete process.env['HARNESSDESK_ADB']
    else process.env['HARNESSDESK_ADB'] = previous
  })

  const stopped = new AbortController()
  const host = new PluginCapabilityHost('p', mergePermissions({ android: true }), () => ({ signal: stopped.signal }))
  const call = host.serve({ kind: 'android', method: 'devices', args: [] }, { enterCheckout: false })
  await new Promise((resolve) => setTimeout(resolve, 200))
  stopped.abort()
  await within(2_000, assert.rejects(call))
})
