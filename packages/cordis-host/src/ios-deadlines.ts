import { IOS_ENGINE_BOUNDS_MS } from './ios-timeouts.js'
import { iosInteractionTimeoutMs } from './ios-validation.js'

const IPC_MARGIN_MS = 5_000

/** A complete engine operation plus delivery margin; only validated input can add variable work. */
export function iosCallTimeoutMs(call: { readonly method: string; readonly args: readonly unknown[] }): number {
  if (!call || !Array.isArray(call.args)) throw new Error('Malformed simulator capability request.')
  if (!Object.hasOwn(IOS_ENGINE_BOUNDS_MS, call.method)) throw new Error('Unknown simulator capability operation.')
  const bound = call.method === 'interact' ? iosInteractionTimeoutMs(call.args[0]) : IOS_ENGINE_BOUNDS_MS[call.method as keyof typeof IOS_ENGINE_BOUNDS_MS]
  return bound + IPC_MARGIN_MS
}

/** Let the parent report expiry and abort its engine before the child's own request expires. */
export const iosReplyTimeoutMs = (call: Parameters<typeof iosCallTimeoutMs>[0]): number => iosCallTimeoutMs(call) + IPC_MARGIN_MS
