import { fileURLToPath } from 'node:url'

import { describeAdapterConformance } from '@harnessdesk/adapter-testkit'

import { CodexRuntime } from '../src/index.js'

/**
 * The shared conformance suite, against the scripted app-server. Nothing in
 * this file is Codex-specific except how the runtime is constructed — which is
 * the point: the suite must pass for any adapter, so it cannot encode one.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

describeAdapterConformance('CodexRuntime', {
  create: () => new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-conformance' }),
  sessionOptions: { cwd: '/w' },
  // Codex can flip only some features while running; `memories` is one of them.
  runtimeToggle: 'feature.memories',
})
