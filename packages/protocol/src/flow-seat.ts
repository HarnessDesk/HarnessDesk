import type { FlowSeat } from './flow.js'
import { isBoolean, isString, optional, shape, ValidationError, type Validator } from './validate.js'

/** A structured seat shared by Flow wire requests and Lead assignments; model ids may contain `/`. */
export const flowSeatValidator = shape({
  runtime: (value: unknown, path = '') => {
    const runtime = isString(value, path)
    if (runtime.trim() === '') throw new ValidationError(path, 'expected a non-empty string')
    return runtime
  },
  model: optional(isString),
  effort: optional(isString),
  thinking: optional(isBoolean),
}) as Validator<FlowSeat>

/** `cursor=gpt-5.3-codex/xhigh+thinking` — the same grammar the desk's own casts use. */
export const parseSeat = (spec: string): FlowSeat | string => {
  const [core, ...switches] = spec.trim().split('+').map((part) => part.trim())
  if (!core) return 'a seat needs at least an agent, like "cursor" or "cursor=gpt-5.3-codex/xhigh"'
  const [head, effort] = core.split('/')
  const [runtime, model] = (head ?? '').split('=')
  if (!runtime?.trim()) return `"${spec}" does not name an agent before its model`
  const seat: FlowSeat = {
    runtime: runtime.trim(),
    ...(model?.trim() ? { model: model.trim() } : {}),
    ...(effort?.trim() ? { effort: effort.trim() } : {}),
    ...(switches.includes('thinking') ? { thinking: true } : {}),
  }
  const unknown = switches.filter((flag) => flag !== '' && flag !== 'thinking')
  if (unknown.length > 0) {
    return `"+${unknown[0] as string}" is not a switch a seat takes — the only one is +thinking`
  }
  return seat
}

/** How a seat reads back on a page: `cursor=gemini-3.8-flash/high`. */
export const seatSpec = (seat: FlowSeat): string =>
  `${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}${
    seat.thinking ? '+thinking' : ''
  }`
