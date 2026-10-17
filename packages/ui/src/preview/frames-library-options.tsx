import { Frame } from './main'
import { LibraryDestinationFixture } from './library-destination-fixture'
/** Library options share the real page, filters, matrix and import controls. */
export const LibraryOptionFrames = () => <Frame id="library-options" title="Library — cards, chips and matrix"><div className="h-[900px]"><LibraryDestinationFixture /></div></Frame>
