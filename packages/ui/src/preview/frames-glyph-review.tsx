import { createRoot } from 'react-dom/client'

import { BellIcon, BrainIcon, FetchIcon, SettingsIcon, SummaryIcon } from '../components/Icons'
import { Button } from '../design'

/** Headless review fixture, mounted from preview.html; no account or host. */
export const mountGlyphReview = () => {
  document.getElementById('root')!.hidden = true
  const fixture = document.createElement('main')
  document.body.appendChild(fixture)
  createRoot(fixture).render(
    <div className="grid gap-4 p-4">
      <section data-case="motion" className="flex items-center gap-4 p-4">
        <Button aria-label="Motion preference"><SettingsIcon size={24} />Motion preference</Button>
      </section>
      <section data-case="brain-stroke" className="flex items-center gap-4 p-4">
        <Button aria-label="Brain stroke options"><BrainIcon size={24} strokeWidth={1.5} /><BrainIcon size={16} strokeWidth={2} absoluteStrokeWidth nonScalingStroke />Brain stroke options</Button>
      </section>
      <section data-case="summary-stroke" className="flex items-center gap-4 p-4">
        <Button aria-label="Summary stroke options"><SummaryIcon size={24} strokeWidth={1.5} /><SummaryIcon size={16} strokeWidth={2} absoluteStrokeWidth nonScalingStroke />Summary stroke options</Button>
      </section>
      <section data-case="fetch" className="flex items-center gap-4 p-4">
        <Button aria-label="Fetch"><FetchIcon size={24} />Fetch</Button>
      </section>
      <section data-case="disabled" className="flex items-center gap-4 p-4">
        <div role="tab" aria-disabled="true" className="flex items-center gap-2"><SettingsIcon size={24} />Disabled tab</div>
      </section>
      <section data-case="nested" className="flex items-center gap-4 p-4">
        <div role="tab" aria-label="Parent row" className="flex items-center gap-4">
          <BellIcon size={24} />Parent row
          <Button aria-label="Nested settings"><SettingsIcon size={24} />Nested settings</Button>
        </div>
      </section>
      <section data-case="stroke" className="flex items-center gap-4 p-4">
        <Button aria-label="Stroke options"><SettingsIcon size={12} strokeWidth={2} absoluteStrokeWidth nonScalingStroke />Stroke options</Button>
      </section>
    </div>,
  )
}
