// Opening the image viewer (docs/adr/2386-*). This file is the small part the editor and the public page
// import; the viewer itself (ImageViewer.tsx) is a lazy chunk loaded on the first open. Images are taken
// from what the page already drew: the <img>'s own src (signed, public or external alike), so the viewer
// has no address or permission logic of its own.
import { fileNameFromUrl } from '../../lib/imageZoom'

export type ViewerImage = { src: string; title: string }

/** The image blocks under `root`, in document order (BlockNote's image block, in the editor and in public HTML). */
export const IMAGE_SELECTOR = '[data-content-type="image"] img.bn-visual-media'

export function viewerImage(img: HTMLImageElement): ViewerImage {
  const block = img.closest('.bn-file-block-content-wrapper')
  const caption = block?.querySelector('.bn-file-caption')?.textContent?.trim()
  const src = img.currentSrc || img.src
  return { src, title: caption || img.alt.trim() || fileNameFromUrl(src) }
}

/** The images of `root` with an address, and the index of `img` among them. */
export function galleryOf(root: ParentNode, img: HTMLImageElement): { images: ViewerImage[]; index: number } {
  const all = Array.from(root.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR)).filter((el) => !!(el.currentSrc || el.src))
  if (!all.includes(img)) all.push(img)
  return { images: all.map(viewerImage), index: all.indexOf(img) }
}

let opening = false
let isOpen = false

/**
 * Opens the viewer on `images[index]`. Focus goes back to what had it now (captured before the chunk
 * loads) when the viewer closes.
 */
export function openImageViewer(images: ViewerImage[], index: number): void {
  if (opening || isOpen || images.length === 0) return
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  opening = true
  import('./ImageViewer')
    .then(({ mountImageViewer }) => {
      isOpen = true
      mountImageViewer({
        images,
        index: Math.max(0, Math.min(images.length - 1, index)),
        onClosed: () => {
          isOpen = false
          if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
        },
      })
    })
    .catch(() => {
      // the chunk did not load (offline without it cached): fall back to the image in a new tab
      window.open(images[index]?.src, '_blank', 'noopener,noreferrer')
    })
    .finally(() => {
      opening = false
    })
}

/** Opens the viewer on `img` with the other images of `root`. */
export function openFromImage(root: ParentNode, img: HTMLImageElement): void {
  const { images, index } = galleryOf(root, img)
  openImageViewer(images, index)
}

/** The image block's <img> an event landed on (not its resize handles or caption), if any. */
export function imageTarget(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof HTMLImageElement)) return null
  return target.matches(IMAGE_SELECTOR) ? target : null
}
