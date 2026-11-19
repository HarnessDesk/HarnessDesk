import { join } from 'node:path'
import { CredentialBroker } from '../../src/credentials.js'
import { intakeDesk } from './intake-host.js'
import { Clocks } from './intake-forge.js'

const [dir, stateDir, mode] = process.argv.slice(2)
if (!dir || !stateDir) throw new Error('synthetic fixture arguments missing')
const repo = { dir, git: async () => '' }
const clocks = new Clocks(1800000000000)
const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
const transport = { async send() { process.send?.('after-dispatch'); return await new Promise<never>(() => {}) } }
const d = await intakeDesk({ repo, stateDir, clocks, lead: true, characterizationTransport: transport,
  ...(mode === 'before-proof' ? { mentions: { assess: async () => { process.send?.('before-proof'); return await new Promise<never>(() => {}) } } } : {}), characterizationSeed: async home => {
  await new CredentialBroker(join(home, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
} })
d.forge.users.set('a-teammate', { id: 31 })
const preview = await d.host.call('trigger/preview', { root: dir, id: 'ask' })
await d.host.call('trigger/arm', { root: dir, id: 'ask', token: preview.token! })
await d.host.call('trigger/mode', { root: dir, id: 'ask', mode: 'act' })
await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
const at = clocks.wall + 1000
d.forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
clocks.advance(60000)
await d.host.intakePlane.tick()
