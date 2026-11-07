// Canvas domain types (value shape of Y.Map 'cnodes' / 'cedges')
// Separate from React Flow nodes/edges: this is the plain-object schema stored in Yjs.

export type CanvasNodeType = 'text' | 'page' | 'link' | 'image'
export type Side = 'top' | 'right' | 'bottom' | 'left'

// color: '1'–'6' (JSON Canvas preset) or '#rrggbb'
export interface CanvasNode {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  color?: string
  /** type='text' */
  text?: string
  /** type='page' — target page id */
  pageId?: string
  /** type='link' — external URL / type='image' — uploaded file path (/files/<id>) */
  url?: string
  /** type='image' — original file name (for alt text and export captions) */
  name?: string
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: Side
  toSide?: Side
  label?: string
  color?: string
}

// React Flow custom node data payload
export interface RFNodeData extends Record<string, unknown> {
  text?: string
  pageId?: string
  url?: string
  name?: string
  color?: string
}
