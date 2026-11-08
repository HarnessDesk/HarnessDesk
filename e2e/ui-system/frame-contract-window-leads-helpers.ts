import type { Locator } from '@playwright/test'
import { checkLeadButtons } from './frame-contract-leads-rules'
import { readLeadButtons } from './frame-contract-leads-snapshot'

export { windowBar } from './frame-contract-leads-snapshot'

/** The B6 work leads' half of the lead contract, through the rule the B10 leads run (`frame-contract-leads-rules.ts`). */
export const expectLead = async (bar: Locator, _width: number, settings: boolean, away: boolean) => {
  checkLeadButtons({ ...await readLeadButtons(bar, settings, away), settings }, away)
}
