import { useRef, useState } from 'react'
import { Popover } from '../Popover'
import { Brain } from 'lucide-react'
import { updateSettings, useStore } from '../../store'
import { cx } from '../ui'

const LABEL: Record<string, string> = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const label = (v: string) => LABEL[v] ?? v

/**
 * Reasoning-effort pill + slider in the composer. Steps are "Off" plus the levels the loaded
 * model's template accepts (from llama-server); without levels it is just Off / On. Applied per
 * request by the stats proxy, so a change takes effect on the next message.
 */
export function EffortControl() {
  const llama = useStore((s) => s.llama)
  const effort = useStore((s) => s.settings?.llama.reasoningEffort ?? '')
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const levels = llama?.reasoningLevels ?? null
  const steps = levels ? ['none', ...levels] : ['none', '']
  const fallback = levels ? (llama?.reasoningDefault && levels.includes(llama.reasoningDefault) ? llama.reasoningDefault : levels[levels.length - 1]) : ''
  // '' (model default) and saved levels the current model doesn't have sit on the default step.
  const effective = effort === 'none' ? 'none' : effort && steps.includes(effort) ? effort : fallback
  const idx = Math.max(0, steps.indexOf(effective))
  const name = (v: string) => (v === '' ? 'On' : label(v))
  const isDefault = effort === '' || (effort !== 'none' && !steps.includes(effort))
  // API models decide their own thinking; this setting only reaches the local model.
  const usingApi = useStore((s) => !!s.settings?.api.active)
  if (usingApi) return null

  return (
    <div className="relative shrink-0">
      <button
        ref={btn}
        onClick={() => setOpen((o) => !o)}
        data-testid="effort-pill"
        data-effort={effective || 'default'}
        title="Reasoning effort: how long the model thinks before answering"
        className={cx(
          'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12.5px] transition-colors',
          open ? 'border-line-strong text-fg' : 'border-line text-muted hover:text-fg',
          effective === 'none' && 'text-faint',
        )}
      >
        <Brain className="h-3.5 w-3.5" />
        {name(effective)}
      </button>
      {open && (
        <Popover anchor={btn} width={288} onClose={() => setOpen(false)} testId="effort-popover">
          <div className="p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium">Reasoning effort</span>
            <span className="text-[12px] text-muted">
              {name(effective)}
              {isDefault && effective !== 'none' ? ' (default)' : ''}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={steps.length - 1}
            step={1}
            value={idx}
            onChange={(e) => void updateSettings({ llama: { reasoningEffort: steps[Number(e.target.value)] } })}
            className="w-full accent-accent"
            data-testid="effort-slider"
          />
          <div className="mt-1 flex justify-between text-[10.5px] text-faint">
            {steps.map((s, i) => (
              <button
                key={s || 'on'}
                className={cx('whitespace-nowrap hover:text-fg', i === idx && 'text-fg')}
                onClick={() => void updateSettings({ llama: { reasoningEffort: s } })}
              >
                {name(s)}
              </button>
            ))}
          </div>
          <div className="mt-2.5 text-[11.5px] leading-snug text-faint">
            {levels ? 'Less thinking answers faster; more is more careful. Off skips thinking.' : llama?.up ? 'This model has no effort levels, only thinking on or off.' : 'llama-server is not running.'} Applies from your next message.
          </div>
          {!isDefault && effort !== 'none' && (
            <button className="mt-1.5 text-[11.5px] text-muted underline-offset-2 hover:underline" onClick={() => void updateSettings({ llama: { reasoningEffort: '' } })}>
              Use the model's default
            </button>
          )}
          </div>
        </Popover>
      )}
    </div>
  )
}
