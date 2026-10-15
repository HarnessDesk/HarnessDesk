import type { Page } from '@playwright/test'

/** The supported standalone RunView still renders original records; retain its geometry proof alongside the compact app story. */
export const addStandaloneRunRecords = async (page: Page): Promise<void> => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React import was not found')
    await route.fulfill({ response, body: `${source}
      import recordReact from ${JSON.stringify(reactUrl)};
      import { RunView as OriginalRunRecords } from '/src/components/RunView.tsx';
      import { runFixture as originalFixture, runTeamStore as originalStore } from '/src/preview/run-view-fixture.ts';
      import { runTimeline as originalTimeline } from '/src/lib/run-timeline.ts';
      import { StoreProvider as OriginalStore } from '/src/state/context.tsx';
      const originalHost = document.createElement('div'); document.body.append(originalHost);
      const oh = recordReact.createElement;
      function OriginalRecordFixture({ narrow }) {
        const [selected, select] = recordReact.useState(null), input = recordReact.useMemo(() => originalFixture('attempts'), []);
        return oh('section', { id: narrow ? 'run-retained-narrow' : 'run-retained-attempts', style: { display: 'flex', flexDirection: 'column', height: '576px', ...(narrow ? { width: '384px' } : {}) } },
          oh(OriginalRunRecords, { number: 1, model: originalTimeline(input), execution: input.execution, selectedRow: selected, onSelect: select }));
      }
      createRoot(originalHost).render(oh(OriginalStore, { store: originalStore() }, oh(recordReact.Fragment, null,
        oh(OriginalRecordFixture, { narrow: false }), oh(OriginalRecordFixture, { narrow: true }))));
    ` })
  })
}
