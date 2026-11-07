import { AsyncLocalStorage } from 'node:async_hooks'
const invocations = new AsyncLocalStorage<Readonly<Record<string, string>>>()
const callers = new AsyncLocalStorage<string>()
const signals = new AsyncLocalStorage<AbortSignal>()
export const currentIosInvocation = (): string => {
  const caller = callers.getStore()
  const value = caller === undefined ? undefined : invocations.getStore()?.[caller]
  if (!value) throw new Error('Simulator control requires a live host invocation.')
  return value
}
export const withIosInvocation = <T>(value: Readonly<Record<string, string>> | undefined, run: () => T): T => value === undefined ? run() : invocations.run(value, run)
export const withIosCaller = <T>(caller: string, run: () => T): T => callers.run(caller, run)
export const currentIosInputSignal = (): AbortSignal | undefined => signals.getStore()
export const withIosInputSignal = <T>(signal: AbortSignal, run: () => T): T => signals.run(signal, run)
