import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

type Preview = {
  store: import('../../packages/ui/src/state/store').AppStore & { patch(partial: object): void }
  sessionKey: import('@harnessdesk/protocol').SessionKey
}

for (const theme of ['light', 'dark'] as const) {
  for (const [kind, reason] of [
    ['refused', 'The running turn has ended.'],
    ['transport', 'The connection to HarnessDesk was lost.'],
    ['timeout', 'The request timed out.'],
  ] as const) {
    test(`a ${kind} steer keeps its message, chips and one local reason in ${theme}`, async ({ page }) => {
      await page.goto('/preview.html')
      await page.waitForFunction(() => '__hdPreview' in window)
      await page.evaluate(async ({ theme, reason }) => {
        const storeModule = '/src/state/store.ts'
        const draftsModule = '/src/state/drafts.ts'
        const { AppStore } = await import(/* @vite-ignore */ storeModule)
        const { draftsOf } = await import(/* @vite-ignore */ draftsModule)
        const { store, sessionKey } = (window as unknown as { __hdPreview: Preview }).__hdPreview
        const actual = new AppStore('ws://localhost:0/')
        actual.transport.request = async () => { throw new Error(reason) }
        store.steer = async (...args) => {
          const accepted = await actual.steer(...args)
          store.patch({ notices: actual.getSnapshot().notices })
          return accepted
        }
        store.addRecoverableDraft = (key, draft) => {
          draftsOf(store).addRecoverable(key, draft)
          store.patch({ recoverableDrafts: new Map([[key, draftsOf(store).recoverable(key)]]) })
        }
        store.restoreRecoverableDraft = (key, id) => {
          const restored = draftsOf(store).restore(key, id)
          store.patch({ recoverableDrafts: new Map([[key, draftsOf(store).recoverable(key)]]) })
          return restored
        }
        const snapshot = store.getSnapshot()
        const session = snapshot.sessions.get(sessionKey)!
        store.patch({
          theme,
          workspace: { ...snapshot.workspace, path: '/preview/project', name: 'project' },
          history: snapshot.history.map(entry => entry.id === session.id && entry.runtime === session.runtime
            ? { ...entry, cwd: '/preview/project' } : entry),
          workbench: { ...snapshot.workbench, focus: null, main: { ...snapshot.workbench.main, focused: 'preview' } },
          sessions: new Map(snapshot.sessions).set(sessionKey, {
            ...session, cwd: '/preview/project', status: { type: 'active' },
            turns: [{ ...session.turns.at(-1)!, status: 'inProgress', items: [] }],
          }),
          runtimes: snapshot.runtimes.map(runtime => ({
            ...runtime, capabilities: { ...runtime.capabilities, steer: true },
          })),
          notices: [], agentNotices: [], queues: new Map(), recoverableDrafts: new Map(),
        })
        await new Promise<void>(resolve => {
          let received = false
          const detail = {
            text: 'Please check the worktree tests before opening the pull request.',
            attachments: [{ kind: 'file', name: 'spec.md', path: '/preview/spec.md' }],
            onReceived: () => { received = true; resolve() },
          }
          const handoff = () => {
            window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail }))
            if (!received) requestAnimationFrame(handoff)
          }
          requestAnimationFrame(handoff)
        })
        await document.fonts.ready
      }, { theme, reason })
      const frame = page.locator('[data-frame-id="conversation-composer"]')
      const textbox = frame.locator('textarea')
      await expect(textbox).toHaveValue('Please check the worktree tests before opening the pull request.')
      await textbox.press('Meta+Enter')
      const notice = frame.locator('[data-slot="composer-notice"]')
      await expect(notice).toHaveCount(1)
      await expect(notice).toContainText(reason)
      expect(await page.evaluate(() => (window as unknown as { __hdPreview: Preview }).__hdPreview.store.getSnapshot().notices.length)).toBe(0)
      await expect(textbox).toHaveValue('')
      await textbox.fill('Also check the documentation.')
      expect(await notice.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      if (process.env['STEER_FRAMES_DIR']) {
        mkdirSync(process.env['STEER_FRAMES_DIR'], { recursive: true })
        // The export is this whole conversation, so stage only that frame:
        // other catalogue examples deliberately exercise private-path shapes.
        await page.evaluate(() => {
          for (const frame of document.querySelectorAll('[data-frame-id]')) {
            if (frame.getAttribute('data-frame-id') !== 'conversation-composer') frame.remove()
          }
        })
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await frame.screenshot({ path: join(process.env['STEER_FRAMES_DIR'], `${kind}-after-${theme}.png`) })
      }
      await notice.getByRole('button', { name: 'Restore' }).click()
      await expect(textbox).toHaveValue('Please check the worktree tests before opening the pull request.')
      await expect(frame).toContainText('spec.md')
      await expect(notice).toContainText('Restore it to swap with the current draft.')
      await notice.getByRole('button', { name: 'Restore' }).click()
      await expect(textbox).toHaveValue('Also check the documentation.')
    })
  }
}
