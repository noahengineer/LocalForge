import { useState } from 'react'
import type { LlmRequestStats, MessageStats } from '@shared/stats'
import { cx } from '../ui'
import { fmtInt, fmtMs, fmtTps } from '../../format'

function Item({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span title={title} className="whitespace-nowrap">
      <span className="text-faint">{label} </span>
      <span className="tabular-nums text-muted">{value}</span>
    </span>
  )
}

/** Stats under an assistant message. Click to expand llama-server's raw timings. */
export function StatsFooter({ stats, requests, mode }: { stats: MessageStats; requests: LlmRequestStats[]; mode: 'compact' | 'detailed' }) {
  const [open, setOpen] = useState(false)
  const items =
    mode === 'compact'
      ? [
          <Item key="o" label="out" value={fmtInt(stats.outputTokens)} />,
          <Item key="g" label="" value={`${fmtTps(stats.genPerSecond)} t/s`} title="Generation speed (llama-server predicted_per_second)" />,
          <Item key="t" label="" value={fmtMs(stats.totalMs)} />,
        ]
      : [
          <Item key="p" label="prompt" value={`${fmtInt(stats.promptTokens)}${stats.cachedTokens ? ` (${fmtInt(stats.cachedTokens)} cached)` : ''}`} title="Prompt tokens in context (cached tokens were reused from the KV cache)" />,
          <Item key="r" label="thinking" value={fmtInt(stats.reasoningTokens)} />,
          <Item key="o" label="output" value={fmtInt(stats.outputTokens)} title="Generated tokens, including thinking" />,
          <Item key="pp" label="pp" value={`${fmtTps(stats.promptPerSecond)} t/s`} title="Prompt processing speed (llama-server prompt_per_second)" />,
          <Item key="g" label="gen" value={`${fmtTps(stats.genPerSecond)} t/s`} title="Generation speed (llama-server predicted_per_second)" />,
          <Item key="ttft" label="TTFT" value={fmtMs(stats.ttftMs)} title="Time to first token" />,
          <Item key="t" label="total" value={fmtMs(stats.totalMs)} />,
        ]
  return (
    <div className="mt-1" data-testid="stats-footer">
      <button
        className={cx('flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-1 py-0.5 text-left text-[11.5px] hover:bg-hover/60', open && 'bg-hover/60')}
        onClick={() => setOpen(!open)}
        title="Click for llama-server's raw timings"
      >
        {items}
      </button>
      {open && (
        <div className="selectable mt-1.5 overflow-x-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[11.5px]" data-testid="raw-timings">
          {requests.map((r) => (
            <div key={r.id} className="mb-2 last:mb-0">
              <div className="mb-1 text-faint">
                {r.id} · {r.kind} · {r.phase} · started {new Date(r.startedAt).toLocaleTimeString()}
                {r.finishReason ? ` · finish ${r.finishReason}` : ''}
              </div>
              <table className="border-collapse">
                <tbody>
                  {Object.entries({
                    ...(r.timings ?? {}),
                    usage_prompt_tokens: r.usage?.prompt_tokens,
                    usage_completion_tokens: r.usage?.completion_tokens,
                    usage_cached_tokens: r.usage?.prompt_tokens_details?.cached_tokens,
                    reasoning_tokens_counted: r.reasoningTokens,
                    content_tokens_counted: r.contentTokens,
                    tool_call_tokens_counted: r.toolTokens,
                    tool_calls: r.toolCalls,
                    ttft_ms: r.firstTokenAt ? r.firstTokenAt - r.startedAt : null,
                    thinking_ms: r.reasoningStartAt && r.reasoningEndAt ? r.reasoningEndAt - r.reasoningStartAt : null,
                    wall_ms: r.endedAt ? r.endedAt - r.startedAt : null,
                  })
                    .filter(([, v]) => v !== undefined && v !== null)
                    .map(([k, v]) => (
                      <tr key={k}>
                        <td className="pr-4 text-faint">{k}</td>
                        <td className="tabular-nums">{typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
