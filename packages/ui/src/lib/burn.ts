import type { BurnStatus } from '@harnessdesk/protocol'
export { burn, FORECAST_NEEDS_ELAPSED, MARGIN_BAND, type BurnView, type BurnStatus } from '@harnessdesk/protocol'

/**
 * The word the badge wears.
 *
 * One meaning per word, matching `PaceBadge`'s margin: room above the even
 * burn is "to spare", below it is "overspending". ("Over pace" meant the
 * first on the badge and the second here.) Not the tone: overspending is a
 * fact about the rate, and whether that is *bad* depends on how much is left and
 * how long is left, which the card decides.
 */
export const burnWord = (status: BurnStatus): string => {
  switch (status) {
    case 'fresh':
      return 'full'
    case 'conserving':
      return 'to spare'
    case 'onPace':
      return 'on pace'
    case 'overPace':
      return 'overspending'
    case 'spent':
      return 'spent'
  }
}
