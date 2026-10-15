// Vendored from lucide-animated (`gauge`); ./index.ts says what changed.

import { motion, type Transition } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DEFAULT_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 160,
  damping: 17,
  mass: 1,
}

export const GaugeGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="gauge" {...props}>
    <motion.path
      animate={controls}
      d="m12 14 4-4"
      transition={DEFAULT_TRANSITION}
      variants={{
        animate: { translateX: 0.5, translateY: 3, rotate: 72 },
        normal: {
          translateX: 0,
          rotate: 0,
          translateY: 0,
        },
      }}
    />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </Glyph>
)
