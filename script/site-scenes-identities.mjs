import assert from 'node:assert/strict'

/** Scan the emitted code as well as fixtures: a build rewrite must not hide identities. */
export const assertSiteIdentities = code => {
  // Lezer serializes numeric parser tables as printable ASCII. Their packed
  // integers can accidentally resemble addresses; they are not identity text.
  const readable = code.replace(/\b(?:states|stateData|goto|tokenData):"(?:[^"\\]|\\.)*"/g, '')
  const addresses = [...new Set(readable.match(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi) ?? [])]
  for (const address of addresses) {
    const domain = address.split('@')[1].toLowerCase()
    assert.ok(domain === 'example.com' || domain === 'acme.dev' ||
      address === 'shane@harnessdesk.app' || address === 'olivia@harnessdesk.app',
    `Unexpected site identity: ${address}`)
  }
  return addresses
}
