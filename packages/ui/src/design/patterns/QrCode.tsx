import { encode } from 'uqr'

/**
 * A code a phone scans, drawn from the text it carries.
 *
 * Data geometry, not an icon: dark modules on a light ground whatever the
 * theme, because a scanner reads that and nothing else, so it takes no token
 * for its ink. The size is an attribute, so no screen decides it.
 */
const QUIET = 2

export const QrCode = ({ text, label, size = 176 }: {
  readonly text: string
  readonly label: string
  readonly size?: number
}) => {
  const matrix = encode(text, { ecc: 'M', border: 0 }).data, side = matrix.length + QUIET * 2
  const path = matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + QUIET} ${y + QUIET}h1v1h-1z`] : [])).join('')
  return <svg role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} width={size} height={size} shapeRendering="crispEdges">
    <rect width={side} height={side} fill="white" /><path d={path} fill="black" />
  </svg>
}
