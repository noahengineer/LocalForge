import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * A popup that opens above an anchor button, drawn in a portal on top of everything (so side
 * panels can't cover it) and kept inside the window. Closes on outside click or Esc.
 */
export function Popover({
  anchor,
  width,
  onClose,
  children,
  testId,
}: {
  anchor: RefObject<HTMLElement | null>
  width: number
  onClose: () => void
  children: ReactNode
  testId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const w = Math.min(width, window.innerWidth - 16)
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), bottom: window.innerHeight - r.top + 6 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, width])
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  if (!pos) return null
  return createPortal(
    <div
      ref={ref}
      data-testid={testId}
      style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, width: Math.min(width, window.innerWidth - 16) }}
      className="z-[55] rounded-xl border border-line bg-raised shadow-xl"
    >
      {children}
    </div>,
    document.body,
  )
}
