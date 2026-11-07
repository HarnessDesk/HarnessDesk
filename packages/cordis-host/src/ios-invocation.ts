import { AsyncLocalStorage } from 'node:async_hooks'
import type { IosInvocationAuthority } from '@harnessdesk/protocol'
const invocations = new AsyncLocalStorage<Readonly<Record<string, IosInvocationAuthority>>>()
const callers = new AsyncLocalStorage<string>()
const signals = new AsyncLocalStorage<AbortSignal>()
export const currentIosInvocation = (): string => {
  const caller = callers.getStore()
  const value = caller === undefined ? undefined : invocations.getStore()?.[caller]
  if (typeof value === 'object' && value !== null && typeof value.refused === 'string') throw new Error(value.refused)
  if (typeof value !== 'string' || !value) throw new Error('Simulator control requires a live host invocation.')
  return value
}
export const withIosInvocation = <T>(value: Readonly<Record<string, IosInvocationAuthority>> | undefined, run: () => T): T => value === undefined ? run() : invocations.run(value, run)
export const withIosCaller = <T>(caller: string, run: () => T): T => callers.run(caller, run)
export const currentIosInputSignal = (): AbortSignal | undefined => signals.getStore()
export const withIosInputSignal = <T>(signal: AbortSignal, run: () => T): T => signals.run(signal, run)
