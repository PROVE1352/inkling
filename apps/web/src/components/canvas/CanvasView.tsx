import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type OnNodeDrag,
  type OnNodesDelete,
  type OnEdgesDelete,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useDroppable } from '@dnd-kit/core'
import type { UserDTO } from '@inkling/shared'
import { filterUploadable, useFileDropZone } from '../../lib/fileDrop'
import { uploadFile } from '../../api'
import { t } from '../../i18n'
import { toast } from '../../lib/toast'
import { useTheme } from '../../lib/theme'
import { setActiveCanvas } from '../../lib/activeCanvas'
import { CANVAS_DROP_ID } from '../dnd/AppDnd'
import type { CollabState } from '../CollabEditor'
import { useCanvasDoc, LOCAL_ORIGIN } from './useCanvasDoc'
import { resolveColor } from './canvasColors'
import { CanvasContext } from './canvasContext'
import { Toolbar } from './Toolbar'
import { TextNode } from './nodes/TextNode'
import { PageNode } from './nodes/PageNode'
import { LinkNode } from './nodes/LinkNode'
import { ImageNode } from './nodes/ImageNode'
import type { CanvasNode, CanvasEdge, RFNodeData, Side } from './types'

// nodeTypes is a module-scope constant: React Flow warns if it is recreated on every render.
const nodeTypes: NodeTypes = {
  text: TextNode,
  page: PageNode,
  link: LinkNode,
  image: ImageNode,
}

const DEFAULT_SIZE: Record<CanvasNode['type'], { width: number; height: number }> = {
  text: { width: 200, height: 110 },
  page: { width: 240, height: 52 },
  link: { width: 240, height: 52 },
  image: { width: 280, height: 200 },
}

// Max side length of image cards placed on the canvas — the original aspect ratio is kept.
const IMAGE_MAX_SIDE = 320

/** Size the card from the file's actual pixel dimensions. Falls back to the default size on failure. */
async function imageCardSize(file: File): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    bitmap.close()
    if (!width || !height) return DEFAULT_SIZE.image
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height))
    return {
      width: Math.max(60, Math.round(width * scale)),
      height: Math.max(60, Math.round(height * scale)),
    }
  } catch {
    return DEFAULT_SIZE.image
  }
}

// ---- Y ↔ React Flow conversion ----
function toRFNode(n: CanvasNode): Node {
  const data: RFNodeData = {
    text: n.text,
    pageId: n.pageId,
    url: n.url,
    color: n.color,
  }
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    data,
  }
}

function toRFEdge(e: CanvasEdge): Edge {
  const stroke = resolveColor(e.color)
  return {
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    sourceHandle: e.fromSide ?? null,
    targetHandle: e.toSide ?? null,
    label: e.label,
    style: stroke ? { stroke } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
  }
}

function withColor<T extends { color?: string }>(base: T, color?: string): T {
  const next = { ...base }
  if (color) next.color = color
  else delete next.color
  return next
}

function newId(): string {
  return crypto.randomUUID()
}

// ---------------------------------------------------------------------------

type CanvasViewProps = {
  pageId: string
  wsId: string
  me: UserDTO
  onCollabChange?: (state: CollabState) => void
}

// Outer: wraps in ReactFlowProvider so CanvasInner can use useReactFlow.
export function CanvasView(props: CanvasViewProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({ pageId, wsId, me, onCollabChange }: CanvasViewProps) {
  const { resolved } = useTheme()
  const reactFlow = useReactFlow()
  const { doc, cnodes, cedges, status, synced, users } = useCanvasDoc(pageId, me)

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])

  const wrapperRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<Set<string>>(new Set())
  const firstFitRef = useRef(false)

  // Drop zone for sidebar pages dragged onto the canvas (AppDnd's canvas-drop target).
  const { setNodeRef: setCanvasDropRef, isOver: isDropOver } = useDroppable({
    id: CANVAS_DROP_ID,
  })
  const setWrapperRef = useCallback(
    (el: HTMLDivElement | null) => {
      wrapperRef.current = el
      setCanvasDropRef(el)
    },
    [setCanvasDropRef],
  )

  // Pass collab state up to the top bar (connection dot / online users)
  useEffect(() => {
    onCollabChange?.({ status, synced, users })
  }, [status, synced, users, onCollabChange])

  // ---- Remote changes → rebuild RF state (preserving local selection and in-drag positions) ----
  const rebuild = useCallback(() => {
    const yNodes: CanvasNode[] = []
    cnodes.forEach((v) => yNodes.push(v as CanvasNode))
    const yEdges: CanvasEdge[] = []
    cedges.forEach((v) => yEdges.push(v as CanvasEdge))

    setNodes((prev) => {
      const sel = new Map(prev.map((n) => [n.id, n.selected]))
      const pos = new Map(prev.map((n) => [n.id, n.position]))
      return yNodes.map((n) => {
        const rf = toRFNode(n)
        rf.selected = sel.get(n.id) ?? false
        // Nodes being dragged (not committed yet) keep their on-screen position
        if (draggingRef.current.has(n.id)) {
          const p = pos.get(n.id)
          if (p) rf.position = p
        }
        return rf
      })
    })
    setEdges((prev) => {
      const sel = new Map(prev.map((e) => [e.id, e.selected]))
      return yEdges.map((e) => {
        const rf = toRFEdge(e)
        rf.selected = sel.get(e.id) ?? false
        return rf
      })
    })

    if (!firstFitRef.current && yNodes.length > 0) {
      firstFitRef.current = true
      requestAnimationFrame(() => reactFlow.fitView({ padding: 0.2, duration: 200 }))
    }
  }, [cnodes, cedges, reactFlow])

  useEffect(() => {
    // origin LOCAL means our own echo → ignore. Only remote/initial sync is applied.
    const obs = (_e: Y.YMapEvent<unknown>, tx: Y.Transaction) => {
      if (tx.origin === LOCAL_ORIGIN) return
      rebuild()
    }
    cnodes.observe(obs)
    cedges.observe(obs)
    rebuild() // run once up front in case we are already synced (local persistence)
    return () => {
      cnodes.unobserve(obs)
      cedges.unobserve(obs)
    }
  }, [cnodes, cedges, rebuild])

  // ---- Local → Y commits (LOCAL_ORIGIN; local RF state is synced immediately too) ----
  const commitNodePatch = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      let updated: CanvasNode | undefined
      doc.transact(() => {
        const cur = cnodes.get(id) as CanvasNode | undefined
        if (!cur) return
        updated = { ...cur, ...patch }
        cnodes.set(id, updated)
      }, LOCAL_ORIGIN)
      if (updated) {
        const u = updated
        setNodes((nds) =>
          nds.map((n) => (n.id === id ? { ...toRFNode(u), selected: n.selected } : n)),
        )
      }
    },
    [doc, cnodes],
  )

  const addNode = useCallback(
    (node: CanvasNode) => {
      doc.transact(() => cnodes.set(node.id, node), LOCAL_ORIGIN)
      setNodes((nds) => [...nds, toRFNode(node)])
    },
    [doc, cnodes],
  )

  const commitText = useCallback(
    (id: string, text: string) => commitNodePatch(id, { text }),
    [commitNodePatch],
  )

  // ---- Placement coordinates for new nodes ----
  const centerPos = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return reactFlow.screenToFlowPosition({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    })
  }, [reactFlow])

  const makeNode = (
    type: CanvasNode['type'],
    pos: { x: number; y: number },
    extra: Partial<CanvasNode>,
  ): CanvasNode => ({
    id: newId(),
    type,
    x: pos.x,
    y: pos.y,
    width: DEFAULT_SIZE[type].width,
    height: DEFAULT_SIZE[type].height,
    ...extra,
  })

  const addText = useCallback(
    () => addNode(makeNode('text', centerPos(), { text: '' })),
    [addNode, centerPos],
  )
  const addPage = useCallback(
    (pid: string) => addNode(makeNode('page', centerPos(), { pageId: pid })),
    [addNode, centerPos],
  )
  const addLink = useCallback(
    (url: string) => addNode(makeNode('link', centerPos(), { url })),
    [addNode, centerPos],
  )

  // Sidebar page dropped onto the canvas → add a page card at that screen (client) position.
  // Builds the node directly so it does not depend on makeNode (not memoized).
  const addPageAt = useCallback(
    (pid: string, client: { x: number; y: number }) => {
      const pos = reactFlow.screenToFlowPosition(client)
      addNode({
        id: newId(),
        type: 'page',
        x: pos.x,
        y: pos.y,
        width: DEFAULT_SIZE.page.width,
        height: DEFAULT_SIZE.page.height,
        pageId: pid,
      })
    },
    [reactFlow, addNode],
  )

  // Dropping OS image files onto the canvas creates image cards at that spot.
  // Nodes are created only after the upload finishes (no placeholder, unlike the document body), hence the progress toast.
  const dropImages = useCallback(
    async (files: File[], client: { x: number; y: number }) => {
      const images = filterUploadable(files, true)
      if (images.length === 0) return
      const pos = reactFlow.screenToFlowPosition(client)
      let offset = 0
      for (const file of images) {
        try {
          const [url, size] = await Promise.all([
            uploadFile(wsId, file, pageId),
            imageCardSize(file),
          ])
          addNode({
            id: newId(),
            type: 'image',
            x: pos.x + offset,
            y: pos.y + offset,
            width: size.width,
            height: size.height,
            url,
            name: file.name,
          })
          offset += 24
        } catch {
          toast({ message: t('canvas.uploadFailed', { name: file.name }) })
        }
      }
    },
    [reactFlow, wsId, pageId, addNode],
  )
  const fileDropActive = useFileDropZone(wrapperRef, (files, point) => {
    void dropImages(files, point)
  })

  // Register so AppDnd's (the app-level DndContext) canvas-drop handler can call it.
  useEffect(() => {
    setActiveCanvas({
      addPageNodeAt: (pid, client) => {
        if (pid === pageId) return // dropping a canvas onto itself → no-op
        addPageAt(pid, client)
      },
    })
    return () => setActiveCanvas(null)
  }, [pageId, addPageAt])

  // ---- RF event handlers ----
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes((nds) => applyNodeChanges(changes, nds))
      for (const ch of changes) {
        if (ch.type === 'position' && ch.dragging) draggingRef.current.add(ch.id)
        // Resize ended → commit the size
        if (ch.type === 'dimensions' && ch.resizing === false && ch.dimensions) {
          commitNodePatch(ch.id, {
            width: ch.dimensions.width,
            height: ch.dimensions.height,
          })
        }
      }
    },
    [commitNodePatch],
  )

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_e, node) => {
      draggingRef.current.delete(node.id)
      commitNodePatch(node.id, { x: node.position.x, y: node.position.y })
    },
    [commitNodePatch],
  )

  const onConnect: OnConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return
      const edge: CanvasEdge = {
        id: newId(),
        fromNode: c.source,
        toNode: c.target,
        fromSide: (c.sourceHandle ?? undefined) as Side | undefined,
        toSide: (c.targetHandle ?? undefined) as Side | undefined,
      }
      doc.transact(() => cedges.set(edge.id, edge), LOCAL_ORIGIN)
      setEdges((eds) => [...eds, toRFEdge(edge)])
    },
    [doc, cedges],
  )

  const onNodesDelete: OnNodesDelete = useCallback(
    (deleted) => {
      const ids = new Set(deleted.map((n) => n.id))
      doc.transact(() => {
        for (const id of ids) cnodes.delete(id)
        // Clean up connected edges too
        const orphan: string[] = []
        cedges.forEach((v, k) => {
          const e = v as CanvasEdge
          if (ids.has(e.fromNode) || ids.has(e.toNode)) orphan.push(k)
        })
        for (const k of orphan) cedges.delete(k)
      }, LOCAL_ORIGIN)
    },
    [doc, cnodes, cedges],
  )

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (deleted) => {
      doc.transact(() => {
        for (const e of deleted) cedges.delete(e.id)
      }, LOCAL_ORIGIN)
    },
    [doc, cedges],
  )

  // ---- Toolbar: apply color / delete selection ----
  const setColor = useCallback(
    (color?: string) => {
      const nSel = nodes.filter((n) => n.selected).map((n) => n.id)
      const eSel = edges.filter((e) => e.selected).map((e) => e.id)
      doc.transact(() => {
        for (const id of nSel) {
          const cur = cnodes.get(id) as CanvasNode | undefined
          if (cur) cnodes.set(id, withColor(cur, color))
        }
        for (const id of eSel) {
          const cur = cedges.get(id) as CanvasEdge | undefined
          if (cur) cedges.set(id, withColor(cur, color))
        }
      }, LOCAL_ORIGIN)
      setNodes((nds) =>
        nds.map((n) =>
          n.selected
            ? { ...toRFNode(cnodes.get(n.id) as CanvasNode), selected: true }
            : n,
        ),
      )
      setEdges((eds) =>
        eds.map((e) =>
          e.selected
            ? { ...toRFEdge(cedges.get(e.id) as CanvasEdge), selected: true }
            : e,
        ),
      )
    },
    [nodes, edges, doc, cnodes, cedges],
  )

  const deleteSelected = useCallback(() => {
    const nSel = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
    const eSel = new Set(edges.filter((e) => e.selected).map((e) => e.id))
    if (nSel.size === 0 && eSel.size === 0) return
    setNodes((nds) => nds.filter((n) => !nSel.has(n.id)))
    setEdges((eds) =>
      eds.filter(
        (e) => !eSel.has(e.id) && !nSel.has(e.source) && !nSel.has(e.target),
      ),
    )
    doc.transact(() => {
      for (const id of nSel) cnodes.delete(id)
      const drop = new Set(eSel)
      cedges.forEach((v, k) => {
        const e = v as CanvasEdge
        if (nSel.has(e.fromNode) || nSel.has(e.toNode)) drop.add(k)
      })
      for (const k of drop) cedges.delete(k)
    }, LOCAL_ORIGIN)
  }, [nodes, edges, doc, cnodes, cedges])

  // Double-click on empty canvas → new text card at that position
  const onWrapperDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('react-flow__pane')) return
    const pos = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode(makeNode('text', pos, { text: '' }))
  }

  const selectionCount =
    nodes.filter((n) => n.selected).length + edges.filter((e) => e.selected).length

  return (
    <CanvasContext.Provider value={{ wsId, commitText }}>
      <div
        ref={setWrapperRef}
        className="relative h-full w-full"
        onDoubleClick={onWrapperDoubleClick}
      >
        {!synced && (
          <div className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full border border-line bg-app/90 px-3 py-1 text-xs text-sub shadow-sm backdrop-blur">
            {t('canvas.connecting')}
          </div>
        )}
        {fileDropActive && (
          <div className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2 rounded-full border border-accent/40 bg-app/90 px-3 py-1 text-xs text-accent shadow-sm backdrop-blur">
            {t('canvas.dropImageHint')}
          </div>
        )}
        {(isDropOver || fileDropActive) && (
          <div className="pointer-events-none absolute inset-0 z-30 rounded-md ring-2 ring-inset ring-accent/40" />
        )}
        <Toolbar
          wsId={wsId}
          currentPageId={pageId}
          selectionCount={selectionCount}
          onAddText={addText}
          onAddPage={addPage}
          onAddLink={addLink}
          onSetColor={setColor}
          onDelete={deleteSelected}
        />
        <ReactFlow
          ariaLabelConfig={{
            'controls.ariaLabel': t('canvas.a11yControls'),
            'controls.zoomIn.ariaLabel': t('canvas.a11yZoomIn'),
            'controls.zoomOut.ariaLabel': t('canvas.a11yZoomOut'),
            'controls.fitView.ariaLabel': t('canvas.a11yFitView'),
            'controls.interactive.ariaLabel': t('canvas.a11yInteractive'),
            'minimap.ariaLabel': t('canvas.a11yMinimap'),
          }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          colorMode={resolved}
          deleteKeyCode={['Delete', 'Backspace']}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              resolveColor((n.data as RFNodeData).color) ?? 'var(--color-sub)'
            }
          />
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  )
}
