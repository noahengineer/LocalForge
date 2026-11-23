import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cx } from './ui'

/**
 * A vertical drag handle on the edge of a panel. Dragging resizes it (clamped to min/max);
 * dragging well below the minimum collapses it, and a double-click collapses it too.
 * `side` is where the panel is relative to the handle: 'left' = panel to the left (the handle is
 * its right edge), 'right' = panel to the right.
 */
export function ResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
  onCollapse,
  testId,
}: {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  onResize: (w: number) => void
  onCollapse: () => void
  testId?: string
}) {
  const [dragging, setDragging] = useState(false)
  const latest = useRef({ width, min, max, onResize, onCollapse, side })
  latest.current = { width, min, max, onResize, onCollapse, side }

  const begin = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = latest.current.width
    const rawOf = (x: number) => w0 + (latest.current.side === 'left' ? x - x0 : x0 - x)
    let moved = false
    // Listen on the window (the full-screen overlay below keeps iframes/canvases from taking the
    // events), and always end the drag: on release, cancel, or the window losing focus.
    const move = (ev: PointerEvent) => {
      // The overlay only appears once the pointer really moves, so a double-click still reaches the handle.
      if (!moved) {
        if (Math.abs(ev.clientX - x0) < 3) return
        moved = true
        setDragging(true)
      }
      const { min, max, onResize } = latest.current
      const raw = rawOf(ev.clientX)
      if (raw < min - 80) return
      onResize(Math.round(Math.min(max, Math.max(min, raw))))
    }
    const end = (ev?: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      setDragging(false)
      if (moved && ev && rawOf(ev.clientX) < latest.current.min - 80) {
        // Collapse, but remember the width from before this drag for when it is reopened.
        latest.current.onResize(w0)
        latest.current.onCollapse()
      }
    }
    const cancel = () => end()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to collapse"
        data-testid={testId}
        className={cx('group relative z-20 w-0 shrink-0 cursor-col-resize select-none')}
        onPointerDown={begin}
        onDoubleClick={onCollapse}
      >
        {/* 8px hit area centred on the border line, highlighted on hover/drag */}
        <div className={cx('absolute inset-y-0 -left-1 w-2 transition-colors group-hover:bg-accent/40', dragging && 'bg-accent/60')} />
      </div>
      {/* While dragging, cover iframes/canvases (the noVNC desktop) so they don't swallow the pointer. */}
      {dragging && <div className="fixed inset-0 z-[70] cursor-col-resize" />}
    </>
  )
}
