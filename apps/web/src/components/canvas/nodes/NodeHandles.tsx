import { Handle, Position } from '@xyflow/react'
import type { Side } from '../types'

// Connection points on all four sides. Each side has both a source and a target handle, so edges can go either way.
// Handle id = side name → mapped to fromSide/toSide in onConnect.
const SIDES: { side: Side; position: Position }[] = [
  { side: 'top', position: Position.Top },
  { side: 'right', position: Position.Right },
  { side: 'bottom', position: Position.Bottom },
  { side: 'left', position: Position.Left },
]

const dotClass =
  '!h-2 !w-2 !border !border-app !bg-sub opacity-0 transition-opacity group-hover:opacity-100'

export function NodeHandles() {
  return (
    <>
      {SIDES.map(({ side, position }) => (
        <div key={side}>
          <Handle
            type="target"
            id={side}
            position={position}
            className={dotClass}
          />
          <Handle
            type="source"
            id={side}
            position={position}
            className={dotClass}
          />
        </div>
      ))}
    </>
  )
}
