import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'

export function Button({ variant = 'outline', size = 'md', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const v: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:brightness-110 border border-transparent',
    ghost: 'text-muted hover:text-fg hover:bg-hover border border-transparent',
    outline: 'border border-line-strong text-fg hover:bg-hover',
    danger: 'border border-bad/50 text-bad hover:bg-bad/10',
    subtle: 'bg-raised text-fg hover:bg-hover border border-line',
  }
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none cursor-pointer whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8.5 px-3.5 text-[13px]',
        v[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}

export function IconButton({ className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 cursor-pointer',
        active && 'bg-hover text-fg',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className ?? 'h-4 w-4')} />
}

export function Dot({ color, pulse }: { color: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; pulse?: boolean }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', muted: 'bg-faint', info: 'bg-info' }[color]
  return <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', c, pulse && 'lf-pulse')} />
}

export function Meter({ value, max, tone, className }: { value: number; max: number; tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'info'; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  const c = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', accent: 'bg-accent', info: 'bg-info' }[tone ?? 'accent']
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-line', className)}>
      <div className={cx('h-full rounded-full transition-[width] duration-300', c)} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Re-render every `ms` (for elapsed timers). */
export function useTick(ms: number, enabled = true): number {
  const [t, setT] = useState(Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setT(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms, enabled])
  return t
}

export function Modal({ title, onClose, children, width = 'max-w-2xl', footer }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: string; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl', width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="text-[15px] font-semibold">{title}</div>
          <IconButton onClick={onClose} aria-label="Close">
            ✕
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <div>
        <div className="text-[13.5px]">{label}</div>
        {hint && <div className="text-[12px] text-muted">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  )
}

/** The LocalForge mark: an anvil with an ember spark (same silhouette as the app icon). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="56 50 380 380" className={className ?? 'h-6 w-6'} aria-hidden>
      <path
        d="M70 214C112 196 134 194 166 194L414 194L414 228L396 228L396 256C352 258 338 276 334 314C334 344 352 364 382 374L382 404L168 404L168 374C200 364 218 344 218 314C214 278 200 260 166 256C128 252 100 238 70 214Z"
        fill="currentColor"
      />
      <path d="M360 66l15 39 39 15-39 15-15 39-15-39-39-15 39-15z" fill="var(--lf-accent)" />
    </svg>
  )
}
