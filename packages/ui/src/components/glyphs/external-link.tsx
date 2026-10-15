// Vendored from lucide-animated (`external-link`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const ARROW_VARIANTS: Variants = {
  normal: {
    scale: 1,
    translateX: 0,
    translateY: 0,
  },
  animate: {
    scale: [1, 0.92, 1],
    translateX: [0, 2, 0],
    translateY: [0, -2, 0],
    originX: 1,
    originY: 0,
    transition: {
      duration: 0.5,
      ease: 'easeInOut',
    },
  },
}

export const ExternalLinkGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="external-link" {...props}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <motion.g animate={controls} variants={ARROW_VARIANTS}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </motion.g>
  </Glyph>
)
