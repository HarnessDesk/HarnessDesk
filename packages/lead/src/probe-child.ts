import { connect } from 'node:net'
import { LEAD_PROBE_PREFIX } from './runtime.js'

/** Started with the Lead child's exact flags; reports what a loopback connect to the prober's port gets.
 * A permission model that blocks the network refuses it with ERR_ACCESS_DENIED before any packet leaves. */
const report = (outcome: string) => {
  process.stdout.write(`${LEAD_PROBE_PREFIX}${JSON.stringify({ version: process.version, outcome })}\n`, () => process.exit(0))
}
try {
  const socket = connect({ host: '127.0.0.1', port: Number(process.argv[2]) })
  socket.once('connect', () => { socket.destroy(); report('connected') })
  socket.once('error', (error: NodeJS.ErrnoException) => report(error.code ?? 'error'))
} catch (error) { report((error as NodeJS.ErrnoException).code ?? 'error') }
