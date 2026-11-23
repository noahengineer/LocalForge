import { useState } from 'react'
import { HelpCircle, ShieldQuestion } from 'lucide-react'
import type { PermissionRequest, QuestionRequest } from '@shared/api'
import { api, errMsg } from '../../api'
import { toast } from '../../store'
import { DiffView } from '../DiffView'
import { Button, cx } from '../ui'

export function PermissionCard({ projectId, req }: { projectId: string; req: PermissionRequest }) {
  const [busy, setBusy] = useState(false)
  const md = req.metadata as Record<string, any>
  const reply = async (r: 'once' | 'always' | 'reject') => {
    setBusy(true)
    try {
      await api.replyPermission(projectId, req.id, r)
    } catch (e) {
      toast('error', errMsg(e))
      setBusy(false)
    }
  }
  return (
    <div className="mb-3 rounded-xl border border-warn/40 bg-panel p-3.5" data-testid="permission-card">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <ShieldQuestion className="h-4 w-4 text-warn" />
        The agent wants to use <span className="font-mono text-accent">{req.permission}</span>
      </div>
      {req.patterns.length > 0 && <div className="mb-2 font-mono text-[12px] text-muted">{req.patterns.join(', ')}</div>}
      {typeof md.command === 'string' && <pre className="mb-2 rounded-md bg-code p-2 font-mono text-[12px]">$ {md.command}</pre>}
      {typeof md.diff === 'string' && (
        <div className="mb-2 max-h-64 overflow-auto">
          <DiffView diff={md.diff} maxLines={120} />
        </div>
      )}
      {typeof md.url === 'string' && <div className="mb-2 font-mono text-[12px] text-info">{md.url}</div>}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void reply('once')}>
          Allow once
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void reply('always')}>
          Always allow
        </Button>
        <Button variant="danger" size="sm" disabled={busy} onClick={() => void reply('reject')}>
          Deny
        </Button>
      </div>
    </div>
  )
}

export function QuestionCard({ projectId, req }: { projectId: string; req: QuestionRequest }) {
  const [answers, setAnswers] = useState<string[][]>(req.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(req.questions.map(() => ''))
  const [busy, setBusy] = useState(false)
  const toggle = (qi: number, label: string, multiple?: boolean) =>
    setAnswers((a) => a.map((x, i) => (i !== qi ? x : multiple ? (x.includes(label) ? x.filter((y) => y !== label) : [...x, label]) : [label])))
  const submit = async () => {
    setBusy(true)
    try {
      const final = answers.map((a, i) => (custom[i].trim() ? [...a, custom[i].trim()] : a))
      await api.replyQuestion(projectId, req.id, final)
    } catch (e) {
      toast('error', errMsg(e))
      setBusy(false)
    }
  }
  return (
    <div className="mb-3 rounded-xl border border-plan/40 bg-panel p-3.5" data-testid="question-card">
      {req.questions.map((q, qi) => (
        <div key={qi} className="mb-3">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
            <HelpCircle className="h-4 w-4 text-plan" />
            {q.header && <span className="text-plan">{q.header}</span>}
          </div>
          <div className="mb-2 text-[13.5px]">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {(q.options ?? []).map((o) => (
              <button
                key={o.label}
                title={o.description}
                onClick={() => toggle(qi, o.label, q.multiple)}
                className={cx(
                  'rounded-lg border px-2.5 py-1 text-[12.5px]',
                  answers[qi].includes(o.label) ? 'border-plan bg-plan/15 text-fg' : 'border-line text-muted hover:text-fg',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <input
            value={custom[qi]}
            onChange={(e) => setCustom((c) => c.map((x, i) => (i === qi ? e.target.value : x)))}
            placeholder="Or type your own answer…"
            className="mt-2 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-line-strong"
          />
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          Answer
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void api.rejectQuestion(projectId, req.id).catch((e) => toast('error', errMsg(e)))}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
