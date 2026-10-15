// Vendored from lucide-animated (`chevrons-down-up`); ./index.ts says what changed.

import { motion, type Transition } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DEFAULT_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 250,
  damping: 25,
}

export const ChevronsDownUpGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="chevrons-down-up" {...props}>
    <motion.path
      animate={controls}
      d="m7 20 5-5 5 5"
      initial="normal"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { translateY: '0%' },
        animate: { translateY: '-2px' },
      }}
    />
    <motion.path
      animate={controls}
      d="m7 4 5 5 5-5"
      initial="normal"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { translateY: '0%' },
        animate: { translateY: '2px' },
      }}
    />
  </Glyph>
)
