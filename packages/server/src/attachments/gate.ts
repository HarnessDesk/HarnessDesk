import { reaches, runtimeId, sessionId, type AttachmentIdentity, type CeilingLevel, type SeatId } from '@harnessdesk/protocol'

import type { Admission, GatedCall } from '../ceilings/gate.js'

/**
 * Exact admission order for one Seat's frozen attachments, and the gate an
 * external MCP call answers to once one is loaded.
 *
 * Nothing here decides trust or ceiling on its own — those are read from the
 * host services `activateBindings` and `McpToolGateway` are given, never from
 * a repository or client field. What lives here is the order those answers
 * are checked in, and the one new rule this phase adds on top of phase 3's
 * gate: an external server's tool is never anything but `merge`, and a call
 * with no live caller is refused outright rather than falling through as
 * unidentified-and-admitted.
 */

export type Candidate = { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly digest: string }
export type Binding = { readonly candidate: Candidate; readonly approved: boolean; readonly supported: boolean; readonly permitted: boolean }

/**
 * The exact, proven admission order: approval, then ceiling, then runtime
 * support — never the other way, and never skipped because an earlier
 * binding in the batch already failed. `load` is called only once a binding
 * clears all three, and its own outcome (a thrown error, or an observed
 * digest that does not match) is a `not-loaded` result too, never an
 * exception that escapes to the caller — a batch never exposes a tool or
 * starts a turn on a mismatched or failed readback.
 */
export async function activateBindings(
  bindings: readonly Binding[],
  load: (candidate: Candidate) => Promise<string>,
): Promise<readonly { candidate: Candidate; status: 'loaded' | 'not-loaded'; reason: string | null }[]> {
  const results: { candidate: Candidate; status: 'loaded' | 'not-loaded'; reason: string | null }[] = []
  for (const binding of bindings) {
    const reason = !binding.approved
      ? 'Review this content before loading it.'
      : !binding.permitted
        ? 'This attachment exceeds the Seat ceiling.'
        : !binding.supported
          ? 'This runtime cannot load this attachment for one Seat.'
          : null
    if (reason) {
      results.push({ candidate: binding.candidate, status: 'not-loaded', reason })
      continue
    }
    try {
      const observed = await load(binding.candidate)
      results.push({
        candidate: binding.candidate,
        status: observed === binding.candidate.digest ? 'loaded' : 'not-loaded',
        reason: observed === binding.candidate.digest ? null : 'The runtime loaded different content; start a new Seat.',
      })
    } catch {
      results.push({ candidate: binding.candidate, status: 'not-loaded', reason: 'Loading failed; review the runtime status and start a new Seat.' })
    }
  }
  return results
}

/**
 * Whether a name is loadable at all here: an external server is unknown
 * unless a trusted, desk-owned manifest already narrows it — never a
 * server's own tool annotations or a repository's declared classification,
 * both of which are exactly the untrusted input this rule exists to ignore.
 */
export const externalMcpCeiling = (server: { readonly trusted: boolean; readonly manifestCeiling?: CeilingLevel }): CeilingLevel =>
  server.trusted && server.manifestCeiling ? server.manifestCeiling : 'merge'

/** One approved server's frozen, opaque gateway identity — never the upstream server's own credentials. */
export interface GatewayServer {
  readonly seat: SeatId
  readonly identity: AttachmentIdentity
  readonly endpoint: string
  readonly ceiling: CeilingLevel
}

/** A live caller: which Seat it may reach, and the exact conversation `admit` resolves to its recorded root — a child included, never inferred from anything the call itself says. */
export interface GatewayCaller {
  readonly seat: SeatId
  readonly runtime: string
  readonly sessionId: string
}

/** What the gateway needs to resolve a call to its root and admit it — phase 3's own gate, reused rather than re-implemented. */
export interface McpGatewayPort {
  /** The frozen server list for a Seat — `null` once the Seat closes or its token is revoked. */
  serversFor(seat: SeatId): readonly GatewayServer[] | null
  /** `null` for an unknown or expired caller token — refused outright, never treated as unidentified-and-admitted. */
  callerOf(token: string): GatewayCaller | null
  admit(call: GatedCall): Promise<Admission>
}

export const EXPIRED_CALLER_REFUSAL = 'This connection is no longer live. Start a new Seat to reach this server.'
export const HIDDEN_TOOL_REFUSAL = 'This tool is not part of what this Seat approved. Discovery does not authorize a call.'

/** One real tool a live listing described, already attributed to the server that answered for it. */
export interface GatewayTool {
  readonly name: string
  readonly server: string
  readonly description: string
  readonly inputSchema: unknown
}

/**
 * The gateway a bridge process reaches instead of the upstream server
 * directly: it authenticates the caller before anything else, filters
 * `tools/list` down to the frozen approved set, and refuses a direct call to
 * a name that set never listed — hidden by filtering is not hidden from the
 * gate. `identify` maps a live child conversation back to its recorded root
 * (never inferred from a name in the call's own arguments); an unresolved
 * child refuses the same as an unknown caller.
 */
export class McpToolGateway {
  constructor(private readonly port: McpGatewayPort) {}

  /**
   * The caller's approved servers' real tools — never invented from the
   * server identity alone. `listTools` is asked once per approved server, in
   * parallel; a server that cannot answer right now (down, slow, refused)
   * simply contributes nothing to this listing rather than failing the whole
   * call, since discovery unavailability is not the security question this
   * gateway exists to answer — `call` below still gates every actual
   * invocation regardless of what a listing did or did not show.
   */
  async list(
    token: string,
    listTools: (server: GatewayServer) => Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]>,
  ): Promise<readonly GatewayTool[]> {
    const caller = this.port.callerOf(token)
    if (!caller) return []
    const servers = this.port.serversFor(caller.seat) ?? []
    const lists = await Promise.all(
      servers.map(async (one): Promise<readonly GatewayTool[]> => {
        try {
          const tools = await listTools(one)
          return tools.map((tool) => ({ name: tool.name, server: one.identity.name, description: tool.description, inputSchema: tool.inputSchema }))
        } catch {
          return []
        }
      }),
    )
    return lists.flat()
  }

  async call(
    token: string,
    serverName: string,
    toolName: string,
    invoke: (server: GatewayServer) => Promise<unknown>,
  ): Promise<{ readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly reason: string }> {
    // Authenticated before anything else: an absent or expired token refuses
    // here, never falling through to phase 3's own unidentified-caller
    // admission, which this one path deliberately closes.
    const caller = this.port.callerOf(token)
    if (!caller) return { ok: false, reason: EXPIRED_CALLER_REFUSAL }
    const servers = this.port.serversFor(caller.seat)
    if (!servers) return { ok: false, reason: EXPIRED_CALLER_REFUSAL }
    const server = servers.find((one) => one.identity.name === serverName)
    // Discovery alone is not authorization: a name filtered out of `list`
    // and a name never in the approved set at all are refused identically.
    if (!server) return { ok: false, reason: HIDDEN_TOOL_REFUSAL }
    // A server that may publish is one the desk cannot prove keeps quiet: a
    // blind review round's embargo holds it back exactly as it holds back the
    // desk's own forge tools, or a reviewer could post (or tell a sibling)
    // through it before the round closes. One held to edit or below cannot.
    const admission = await this.port.admit({
      tool: `${serverName}/${toolName}`,
      needs: server.ceiling,
      scope: { runtime: runtimeId(caller.runtime), sessionId: sessionId(caller.sessionId) },
      publishes: reaches(server.ceiling, 'publish'),
    })
    if (!admission.admitted) return { ok: false, reason: admission.refusal }
    const result = await invoke(server)
    return { ok: true, result }
  }
}
