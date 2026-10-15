// Vendored from lucide-animated (`x`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
  },
}

export const XGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="x" {...props}>
    <motion.path
      animate={controls}
      d="M18 6 6 18"
      variants={PATH_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="m6 6 12 12"
      transition={{ delay: 0.2 }}
      variants={PATH_VARIANTS}
    />
  </Glyph>
)
