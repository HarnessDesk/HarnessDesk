#!/usr/bin/env node
/** A populated, disposable desk for native phone verification. No vendor or real account is used. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalId, itemId, sessionId, turnId } from '../../packages/protocol/dist/src/index.js'
import { Host, Logger, StateStore, serve } from '../../packages/server/dist/src/index.js'
import { SessionIndex } from '../../packages/server/dist/src/session-index.js'
import { startPhoneLink } from '../../packages/server/dist/src/phone-link.js'
import { FakeRuntime } from '../../packages/server/dist/test/fixtures/fake-runtime.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function createPhoneSessionRig() {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-sessions-'))
  const project = join(home, 'acme-api')
  await mkdir(project)
  await mkdir(join(home, 'cache'))
  await writeFile(join(home, 'cache/model-pricing.json'), JSON.stringify({ fetchedAt: Date.now(), catalogue: {} }))
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  runtime.info = { ...runtime.info, presentation: { ...runtime.info.presentation, name: 'Demo Agent' } }
  runtime.refusesWhileBusy = true
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  const now = Date.now()
  for (const archived of [false, true]) for (let n = 1; n <= (archived ? 12 : 198); n++) {
    const suffix = String(n).padStart(3, '0')
    const id = sessionId(`${archived ? 'archive' : 'history'}-${suffix}`)
    const title = `${archived ? 'Archived' : 'Phone'} fixture ${suffix}`
    const summary = { runtime: runtime.info.id, id, title, cwd: project, createdAt: now - n * 60_000,
      updatedAt: now - n * 60_000, status: { type: 'notLoaded' }, archived }
    index.upsert(summary, { archived })
    runtime.history.push(summary)
    runtime.minted.set(id, project)
    if (archived) runtime.archived.add(id)
    runtime.stored.set(id, [{ id: turnId(`stored-${id}`), status: 'completed', items: [
      { id: itemId(`question-${id}`), type: 'userMessage', content: [{ type: 'text', text: `Check synthetic session ${suffix}.` }] },
      { id: itemId(`answer-${id}`), type: 'assistantMessage', text: `Session ${suffix} is available from the desk.`, phase: 'final' },
    ] }])
  }
  index.close()
  const logger = new Logger('phone-session-rig', { level: 'error', console: false })
  const state = new StateStore(join(home, 'state.json'))
  await state.setPreferences({ activeRuntime: runtime.info.id, chatsFolder: join(home, 'chats') })
  const host = new Host({ state, logger, catalogRefreshMs: 0, builtinAgents: join(home, 'agents'), libraryHome: join(home, 'person') })
  host.register(runtime)
  const receipts = []
  const timers = new Set()
  const finish = (session, text) => {
    const turn = [...(host.registry.get(runtime.info.id, session.id)?.running ?? [])][0]
    if (turn) {
      const item = { id: itemId(`phone-final-${turn}`), type: 'assistantMessage', text, phase: 'final' }
      runtime.emit({ type: 'item/started', sessionId: session.id, turnId: turn, item })
      runtime.emit({ type: 'item/completed', sessionId: session.id, turnId: turn, item })
    }
    session.finish()
  }
  const originalCall = host.call.bind(host)
  host.call = async (method, params) => {
    if (method === 'workspace/session/start' && params.text === 'PHONE_REFUSE_START') {
      throw new Error('The synthetic desk refused this start.')
    }
    if (method === 'workspace/session/send' && params.text === 'PHONE_REFUSE_REPLY') {
      throw new Error('The synthetic desk refused this reply.')
    }
    if (method === 'workspace/thread/read' && params.id === 'fake:archive-011') {
      throw new Error('Restore this archived session on the desk to read it.')
    }
    const result = await originalCall(method, params)
    if (['workspace/session/start', 'workspace/session/send', 'workspace/stop', 'workspace/approval/decide'].includes(method)) {
      receipts.push({ method, id: params.id ?? result.id ?? params.session, text: params.text, at: Date.now() })
      await writeFile(join(home, 'receipts.json'), JSON.stringify(receipts, null, 2))
    }
    return result
  }
  runtime.onSend = (session, text) => {
    void session.setTitle(text.slice(0, 60))
    if (text === 'PHONE_REFUSE_FIRST_SEND') { session.finish(); throw new Error('Synthetic first-send refusal') }
    if (text.includes('PHONE_APPROVAL')) {
      void session.askPermission(approvalId('phone-fixture-approval'), 'Run the synthetic session check').then(() => finish(session, 'Approval answered.'))
    } else if (!text.includes('PHONE_HOLD')) {
      const timer = setTimeout(() => { timers.delete(timer); finish(session, `PHONE_SESSION_OK: ${text}`) }, 300)
      timers.add(timer)
    }
  }
  await host.start()
  const archivedID = sessionId('archive-010')
  host.registry.upsert(await runtime.readSession(archivedID), null).approvals.set('archived-pending', {
    id: approvalId('archived-pending'), sessionId: archivedID, requestedAt: Date.now(), type: 'command',
    command: 'Run archived synthetic check', cwd: project, actions: [], options: [
      { id: 'deny', label: 'Deny', intent: 'deny' },
      { id: 'once', label: 'Allow once', intent: 'approve' },
      { id: 'session', label: 'Allow this tool for the session', intent: 'approveAlways', grant: 'session-tool' },
    ],
  })
  await host.call('workspace/open', { path: project })
  const server = await serve({ host, logger, uiRoot: join(root, 'packages/ui/dist') })
  const phone = await startPhoneLink(host, logger, { home, name: 'Synthetic phone desk', host: '127.0.0.1', includeLoopback: true })
  phone.control.onChange(() => {
    for (const request of phone.control.state().pending) phone.control.allow(request.id)
  })
  const pairing = phone.service.createPairingCode(3600)
  const connection = { home, url: `${server.url}/?token=${server.token}`, pairingUrl: pairing.url,
    active: 198, archived: 12, phonePort: phone.service.port }
  await writeFile(join(home, 'connection.json'), JSON.stringify(connection), { mode: 0o600 })
  return { host, runtime, phone, server, connection, receipts, async close() {
    for (const timer of timers) clearTimeout(timer)
    await phone.close(); await server.close(); await host.dispose(); await logger.flush()
  } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rig = await createPhoneSessionRig()
  process.stdout.write(`${JSON.stringify(rig.connection)}\n`)
  let closing = false
  const close = async () => { if (closing) return; closing = true; await rig.close(); process.exit(0) }
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
}
