// Vendored from lucide-animated (`compass`); ./index.ts says what changed.

import { motion } from 'motion/react'
import { Glyph, type GlyphProps } from './glyph'

export const CompassGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="compass" {...props}>
    <circle cx="12" cy="12" r="10" />
    <motion.polygon
      animate={controls}
      points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"
      transition={{ type: 'spring', stiffness: 120, damping: 15 }}
      variants={{ normal: { rotate: 0 }, animate: { rotate: 360 } }}
    />
  </Glyph>
)
