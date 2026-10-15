// Vendored from lucide-animated (`server`); ./index.ts says what changed.

import { motion, type Transition, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const SWAP: Transition = { duration: 0.9, ease: 'easeInOut', repeat: 1, times: [0, 0.35, 0.65, 1] }

const TOP_RECT_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: { y: [0, 12, 12, 0], transition: SWAP },
}

const BOTTOM_RECT_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: { y: [0, -12, -12, 0], transition: SWAP },
}

// The slabs trade places past the 24 unit box, so the frame must not clip them.
export const ServerGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="server" overflow="visible" {...props}>
    <motion.g animate={controls} initial="normal" variants={TOP_RECT_VARIANTS}>
      <rect height="8" rx="2" ry="2" width="20" x="2" y="2" />
      <line x1="6" x2="10" y1="6" y2="6" />
    </motion.g>
    <motion.g animate={controls} initial="normal" variants={BOTTOM_RECT_VARIANTS}>
      <rect height="8" rx="2" ry="2" width="20" x="2" y="14" />
      <line x1="6" x2="10" y1="18" y2="18" />
    </motion.g>
  </Glyph>
)
