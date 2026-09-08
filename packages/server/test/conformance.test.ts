import { describeAdapterConformance } from '@harnessdesk/adapter-testkit'

import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * The host's fake runtime passes the same suite the Codex adapter does. This
 * is what stops the suite from encoding one backend: a rule only Codex meets
 * fails here.
 */
describeAdapterConformance('FakeRuntime', {
  create: () => new FakeRuntime(),
  sessionOptions: { cwd: '/w' },
})
