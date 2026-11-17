import { mkdir } from 'node:fs/promises'

import type { McpServerSpec } from '@harnessdesk/agent-inventory'
import { runtimeId, sessionId, type RuntimeId, type SeatId, type SessionId } from '@harnessdesk/protocol'

import type { Admission, GatedCall } from '../ceilings/gate.js'
import type { ToolGatewayBackend } from '../tool-gateway.js'
import { mcpIdentityDigest } from './catalog.js'
import { EXPIRED_CALLER_REFUSAL, McpToolGateway, type GatewayServer } from './gate.js'
import type { LiveServer } from './plane.js'
import { callStdioMcpServer, listStdioMcpServerTools } from './transport.js'

/**
 * The tool gateway's two phase-12 verbs, wired to a real host: exactly what
 * `bootstrap.ts` serves on the desk's socket, kept here so a test drives the
 * same wiring rather than a copy of it.
 *
 * A Seat's approved servers are reached through `McpToolGateway` — the
 * caller is authenticated first, every listing and every call is admitted
 * by the host's own ceiling gate (and so held by a blind round's embargo),
 * and only then is the server dialled. The spec dialled is the one the Seat
 * froze, held beside its live grant, and checked once more against the
 * identity a person approved before any process starts; a Seat that is gone
 * has no spec left to dial. Every exchange carries the host's quit signal.
 */

export interface AttachmentGatewayHost {
  readonly attachmentsPlane: { liveServersFor(seat: SeatId): readonly LiveServer[] | null }
  readonly registry: { attachmentSeatOf(runtime: RuntimeId, id: SessionId): SeatId | null }
  readonly ceilingGate: { admit(call: GatedCall): Promise<Admission>; closedFor?(scope: GatedCall['scope']): string | null }
  readonly attachmentSignal: AbortSignal
  /**
   * The folder every server a Seat reaches runs in: host-owned and empty,
   * under machine state. Not the Seat's checkout — a cloned repository's own
   * configuration there (an `.npmrc`, a `.tool-versions`) could change what an
   * approved command resolves to, which the approval never covered.
   */
  readonly attachmentRunDirectory: string
}

export const NO_LONGER_REACHABLE = 'This server is no longer reachable from this Seat; start a new one to apply its attachments.'

export const attachmentGateway = (
  hostOf: () => AttachmentGatewayHost,
  callerOf: (token: string) => { readonly runtime: string; readonly sessionId: string } | undefined,
): Required<Pick<ToolGatewayBackend, 'mcpList' | 'mcpCall'>> => {
  // A getter, because the wiring builds this before the host it serves exists.
  const host = {
    get plane() {
      return hostOf().attachmentsPlane
    },
    get registry() {
      return hostOf().registry
    },
    get gate() {
      return hostOf().ceilingGate
    },
    get signal() {
      return hostOf().attachmentSignal
    },
    get cwd() {
      return hostOf().attachmentRunDirectory
    },
  }
  const gateway = new McpToolGateway({
    serversFor: (seat) =>
      host.plane.liveServersFor(seat)?.map((one) => ({
        seat,
        identity: one.identity,
        endpoint: one.endpoint,
        // Conservative by decision 13: every external server is `merge`
        // until a trusted desk-owned manifest narrows it, which this phase
        // does not yet have.
        ceiling: 'merge' as const,
      })) ?? null,
    callerOf: (token) => {
      const known = callerOf(token)
      if (!known) return null
      const seat = host.registry.attachmentSeatOf(runtimeId(known.runtime), sessionId(known.sessionId))
      if (!seat) return null
      return { seat, runtime: known.runtime, sessionId: known.sessionId }
    },
    admit: (call) => host.gate.admit(call),
    closedFor: (scope) => host.gate.closedFor?.(scope) ?? null,
  })

  /** The exact spec this Seat froze for this server — or nothing, once the Seat is gone or it no longer matches its approval. */
  const specOf = (server: GatewayServer): McpServerSpec => {
    const spec = host.plane.liveServersFor(server.seat)?.find((one) => one.endpoint === server.endpoint)?.spec
    if (!spec || mcpIdentityDigest(spec) !== server.identity.digest) throw new Error(NO_LONGER_REACHABLE)
    return spec
  }

  /** Created on first use, owner-only; the spec is checked before anything starts. */
  const where = async (server: GatewayServer): Promise<{ readonly spec: McpServerSpec; readonly options: { signal: AbortSignal; cwd: string } }> => {
    const spec = specOf(server)
    await mkdir(host.cwd, { recursive: true, mode: 0o700 })
    return { spec, options: { signal: host.signal, cwd: host.cwd } }
  }

  return {
    mcpList: (caller) => {
      const initial = caller ? callerOf(caller) : undefined
      return gateway.list(caller ?? '', async (server) => {
        const { spec, options } = await where(server)
        const callerScope = caller ? callerOf(caller) : undefined
        if (!initial || !callerScope || initial.runtime !== callerScope.runtime || initial.sessionId !== callerScope.sessionId || host.registry.attachmentSeatOf(runtimeId(callerScope.runtime), sessionId(callerScope.sessionId)) !== server.seat) throw new Error(EXPIRED_CALLER_REFUSAL)
        const closed = host.gate.closedFor?.({ runtime: runtimeId(callerScope.runtime), sessionId: sessionId(callerScope.sessionId) })
        if (closed) throw new Error(closed)
        return listStdioMcpServerTools(spec, options)
      })
    },
    mcpCall: (caller, server, tool, args) => {
      const initial = caller ? callerOf(caller) : undefined
      return gateway.call(caller ?? '', server, tool, async (one) => {
        const { spec, options } = await where(one)
        const callerScope = caller ? callerOf(caller) : undefined
        if (!initial || !callerScope || initial.runtime !== callerScope.runtime || initial.sessionId !== callerScope.sessionId || host.registry.attachmentSeatOf(runtimeId(callerScope.runtime), sessionId(callerScope.sessionId)) !== one.seat) throw new Error(EXPIRED_CALLER_REFUSAL)
        const closed = host.gate.closedFor?.({ runtime: runtimeId(callerScope.runtime), sessionId: sessionId(callerScope.sessionId) })
        if (closed) throw new Error(closed)
        return callStdioMcpServer(spec, tool, args, options)
      }).catch(error => {
        if (error instanceof Error && error.message === EXPIRED_CALLER_REFUSAL) return { ok: false as const, reason: EXPIRED_CALLER_REFUSAL }
        throw error
      })
    },
  }
}
