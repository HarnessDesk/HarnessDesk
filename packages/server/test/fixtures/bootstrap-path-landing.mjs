// The desk's own order: the host is built whole, and the login shell answers a moment later.
// What is asked of the host when it does is the only thing recorded; nothing here starts a runtime.
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: process.env.HD_STATE, console: false, logLevel: 'error', codexBinaryPath: process.env.HD_FAKE,
})
let asked = 0
host.retryNotInstalled = async () => { asked += 1 }
const before = process.env.PATH
try {
  await pathReady
  // The continuation that asks runs after the promise it hangs on.
  await new Promise((resolve) => setTimeout(resolve, 100))
  process.stdout.write(`${JSON.stringify({ asked, changed: process.env.PATH !== before })}\n`)
} finally {
  await host.dispose()
  await extensions.dispose()
}
