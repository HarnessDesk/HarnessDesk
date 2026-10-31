#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PhoneLinkService, type PhonePolicy } from './index.js'

/**
 * A stand-in desk for connecting a phone before the real host is in the loop: the real encrypted session, the
 * real pairing and device registry, and canned answers. Not shipped, not the product.
 */
const usage = `Usage: phone-link-dev [--port N] [--dir PATH] [--allow] [--tick SECONDS] [--no-loopback]

  --port N         Listen on this port (default: a free one)
  --dir PATH       Keep the desk key and paired phones here (default: a new temporary folder)
  --allow          Allow every phone that shows a valid pairing code, without asking
  --tick SECONDS   Publish a "lead" event this often, to exercise live events and resume
  --no-loopback    Leave 127.0.0.1 out of the pairing code
`
const { values } = parseArgs({ options: {
  port: { type: 'string' }, dir: { type: 'string' }, allow: { type: 'boolean' }, tick: { type: 'string' },
  'no-loopback': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} })
if (values.help) { process.stdout.write(usage); process.exit(0) }

const policy: PhonePolicy = {
  // The host and stand-in use the same tiers; repeat/card JSON is documented in ../lead.md.
  methods: { 'lead/thread/read': 'read', 'lead/settings/read': 'read', 'lead/schedule/read': 'read', 'lead/thread/send': 'run', 'lead/stop': 'run', 'lead/resume': 'run', 'lead/repeat/control': 'run', 'lead/card/decide': 'answer', 'lead/budget/raise': 'answer' },
  topics: { lead: 'read' },
  defaultTiers: ['read', 'run', 'answer'],
}
const dir = values.dir ?? await mkdtemp(join(tmpdir(), 'hd-phone-dev-'))
const service = await PhoneLinkService.start({
  dir, policy, port: values.port === undefined ? 0 : Number(values.port), includeLoopback: values['no-loopback'] !== true,
  call: async (method, params) => ({ stand_in: true, method, params: params ?? null, at: Date.now() }),
  log: (message, fields) => process.stderr.write(`${message} ${fields ? JSON.stringify(fields) : ''}\n`),
})
service.onChange(() => {
  for (const request of service.pending()) {
    process.stderr.write(`waiting: "${request.name}" (${request.deviceId})${values.allow ? ' -> allowing' : ' (run with --allow)'}\n`)
    if (values.allow) service.allow(request.id)
  }
})
const code = service.createPairingCode(3600)
process.stdout.write(`${JSON.stringify({ port: service.port, deskId: service.deskId, deskPub: service.deskPub, dir, lan: code.offer.lan, pairingUrl: code.url, expiresAt: code.expiresAt })}\n`)
if (values.tick) {
  const timer = setInterval(() => service.publish('lead', { tick: service.ring.seq + 1, at: Date.now() }), Number(values.tick) * 1000)
  timer.unref()
}
const stop = async () => { await service.close(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
