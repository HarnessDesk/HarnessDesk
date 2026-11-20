/** Test-only receipts around the publication walk's existing awaits. */
export function publicationStages(signal: AbortSignal, receipt: (phase: string) => void) {
  let current = 'setup'
  const phase = (name: string) => { current = name; receipt(name) }
  // Like the template-claims receipts, this must be synchronous: a cancelled
  // test may never unwind the await. A blocked event loop still delays it.
  const onAbort = () => receipt(`abort:${current}`)
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    async run<T>(name: string, action: () => Promise<T>): Promise<T> {
      phase(`${name}:begin`)
      const result = await action()
      phase(`${name}:end`)
      return result
    },
    dispose() { signal.removeEventListener('abort', onAbort) },
  }
}
