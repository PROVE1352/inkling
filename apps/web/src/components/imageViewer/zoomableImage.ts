// BlockNote's image block with a "View larger" button in its corner (docs/adr/2386-*). Config, parsing,
// HTML export and the drawing of the image are BlockNote's own functions (0.51.4, unchanged); the
// render only adds one button inside the image wrapper when the block shows an image. The button is
// part of the node view from the start (nothing is inserted into the editor's DOM afterwards), shown on
// hover, on a selected image, on keyboard focus and always on touch screens (index.css).
import { createBlockSpec, createImageBlockConfig, imageParse, imageRender, imageToExternalHTML } from '@blocknote/core'
import { t } from '../../i18n'
import { openFromImage } from './openImageViewer'

const ZOOM_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/></svg>'

function zoomButton(wrapper: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'nd-img-zoom'
  btn.contentEditable = 'false'
  btn.tabIndex = -1
  btn.dataset.imageZoom = ''
  const label = t('imageViewer.open')
  btn.setAttribute('aria-label', label)
  btn.title = label
  btn.innerHTML = ZOOM_ICON
  // ProseMirror must not take a press on the button as a click or a drag on the block
  const stop = (e: Event) => e.stopPropagation()
  btn.addEventListener('pointerdown', stop)
  btn.addEventListener('mousedown', stop)
  btn.addEventListener('touchstart', stop, { passive: true })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const img = wrapper.querySelector('img')
    if (!img || !img.src) return
    openFromImage(btn.closest('.bn-container') ?? document, img)
  })
  return btn
}

export const createZoomableImageSpec = createBlockSpec(createImageBlockConfig, (config) => ({
  meta: { fileBlockAccept: ['image/*'] },
  parse: imageParse(config),
  render: (block, editor) => {
    const out = imageRender(config)(block, editor)
    const wrapper = out.dom.querySelector<HTMLElement>('.bn-visual-media-wrapper')
    if (wrapper) wrapper.appendChild(zoomButton(wrapper))
    return out
  },
  toExternalHTML: imageToExternalHTML(config),
  runsBefore: ['file'],
}))
