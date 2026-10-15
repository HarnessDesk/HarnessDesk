// Vendored from lucide-animated (`bell`); ./index.ts says what changed.

import type { Variants } from 'motion/react'

import { MotionGlyph, type GlyphProps } from './glyph'

const SVG_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: [0, -10, 10, -10, 0] },
}

export const BellGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="bell"
    animate={controls}
    transition={{
      duration: 0.5,
      ease: 'easeInOut',
    }}
    variants={SVG_VARIANTS}
    {...props}
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </MotionGlyph>
)
