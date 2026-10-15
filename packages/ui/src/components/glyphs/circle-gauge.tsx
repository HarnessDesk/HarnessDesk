// Vendored from lucide-animated (`circle-gauge`); ./index.ts says what changed.

import type { Variants } from 'motion/react'

import { MotionGlyph, type GlyphProps } from './glyph'

const CIRCLE_GAUGE_VARIANTS: Variants = {
  normal: {
    rotate: 0,
  },
  animate: {
    rotate: 72,
  },
}

export const CircleGaugeGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="circle-gauge"
    animate={controls}
    initial="normal"
    variants={CIRCLE_GAUGE_VARIANTS}
    {...props}
  >
    <path d="M15.6 2.7a10 10 0 1 0 5.7 5.7" />
    <circle cx="12" cy="12" r="2" />
    <path d="M13.4 10.6 19 5" />
  </MotionGlyph>
)
