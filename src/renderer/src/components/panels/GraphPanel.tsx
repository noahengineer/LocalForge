import { useCallback, useEffect, useState } from 'react'
import { Network, RefreshCw } from 'lucide-react'
import { api, errMsg } from '../../api'
import { toast, useStore } from '../../store'
import { timeAgo } from '../../format'
import { Button, Spinner } from '../ui'

/**
 * The project's graphify map (graphify-out/graph.html), shown in a sandboxed frame served by the
 * lf-graph:// protocol (see src/main/graphProtocol.ts). "Update map" runs `graphify update .` in the
 * sandbox: it parses the code (no AI, no tokens) and rewrites graph.html.
 */
export function GraphPanel({ projectId }: { projectId: string }) {
  const sandboxReady = useStore((s) => s.sandbox[projectId]?.state === 'running')
  const [info, setInfo] = useState<{ exists: boolean; builtAt: number | null; url: string } | null>(null)
  const [building, setBuilding] = useState(false)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(() => {
    void api
      .graphInfo(projectId)
      .then(setInfo)
      .catch((e) => toast('error', errMsg(e)))
  }, [projectId])
  useEffect(load, [load])

  const build = async () => {
    setBuilding(true)
    try {
      const r = await api.buildGraph(projectId)
      if (!r.ok) toast('error', r.message)
      load()
      setNonce((n) => n + 1)
    } finally {
      setBuilding(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graph-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-[12.5px] text-muted">
        <Network className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {info?.exists ? `Code map · updated ${info.builtAt ? timeAgo(info.builtAt) : ''}` : 'Code map'}
        </span>
        <Button size="sm" variant="ghost" disabled={building || !sandboxReady} onClick={() => void build()} title={sandboxReady ? 'Re-read the code and redraw the map (no AI needed)' : 'Waiting for the sandbox'} data-testid="graph-build">
          {building ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1">{info?.exists ? 'Update map' : 'Build map'}</span>
        </Button>
      </div>
      {info?.exists ? (
        <iframe
          key={`${info.builtAt}-${nonce}`}
          src={`${info.url}?v=${info.builtAt ?? 0}-${nonce}`}
          title="Code map"
          sandbox="allow-scripts"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          data-testid="graph-frame"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-muted">
          <Network className="h-8 w-8 text-faint" />
          {info === null ? (
            <Spinner />
          ) : (
            <>
              <div>No map yet. graphify reads the project's code and draws how files, classes and functions connect.</div>
              <Button disabled={building || !sandboxReady} onClick={() => void build()}>
                {building ? <Spinner className="h-3 w-3" /> : 'Build map'}
              </Button>
              {!sandboxReady && <div className="text-[12px] text-faint">Waiting for the sandbox to start…</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
