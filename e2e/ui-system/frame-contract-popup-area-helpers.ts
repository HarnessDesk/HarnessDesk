import { popupContractDestinations } from './frame-contract-helpers'
const areas = {"work":[1,2,3,4,5],"teams":[6,7,8,9,10],"left":[11,12,21],"menus":[0,13,14,15,19,20],"info":[16,17,18],"settings":[22,23,24,25,26],"pages":[27,28,29,30,31,32,33]} as const
export const popupAreaOffsets = (area: keyof typeof areas) => Array.from({ length: Math.ceil(popupContractDestinations.length / 5) }, (_, i) => i).filter(i => (areas[area] as readonly number[]).includes(i) || (area === 'pages' && i > 33)).map(i => i * 5)
/** An area's destinations, in the wall's order. */
export const popupAreaDestinations = (area: keyof typeof areas) => popupAreaOffsets(area).flatMap(offset => popupContractDestinations.slice(offset, offset + 5))
