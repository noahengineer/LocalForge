import { protocol } from 'electron'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * lf-graph:// serves a project's graphify map (graphify-out/graph.html) to the Map tab.
 *
 *   lf-graph://project/<projectId>/graph.html   the project's map
 *   lf-graph://vendor/vis-network.min.js         the bundled vis-network graphify's page asks for
 *
 * graph.html is generated from the project's files, which the agent controls, so it is treated as
 * untrusted: it gets its own origin (opaque, the iframe is sandboxed), and a CSP that allows only
 * its inline code and the bundled library: no network, no other files. graphify's page loads
 * vis-network from unpkg.com; that reference is rewritten to the bundled copy so the map works
 * offline and nothing is fetched from the internet.
 */
export const GRAPH_SCHEME = 'lf-graph'

export function registerGraphScheme(): void {
  // Must run before app 'ready'.
  protocol.registerSchemesAsPrivileged([{ scheme: GRAPH_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }])
}

const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${GRAPH_SCHEME}:`,
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
].join('; ')

const VIS_RE = /<script\s+src="https:\/\/unpkg\.com\/vis-network@[^"]*\/standalone\/umd\/vis-network\.min\.js"[^>]*>/g

/** Point graphify's CDN script tag at the bundled copy. */
export function localizeGraphHtml(html: string): string {
  return html.replace(VIS_RE, `<script src="${GRAPH_SCHEME}://vendor/vis-network.min.js">`)
}

/**
 * A collapse button for graphify's side panel (#sidebar). The frame is sandboxed (no storage), so
 * the open/closed state comes from the URL hash (#sidebar=0) and changes are reported to the Map
 * tab with postMessage, which remembers them.
 */
const SIDEBAR_TOGGLE = `
<style>
  body.lf-sb-hidden #sidebar { display: none !important; }
  #lf-sb-toggle { position: fixed; top: 8px; right: 292px; z-index: 10; width: 26px; height: 26px; border-radius: 6px;
    border: 1px solid var(--border, #2a2a4e); background: var(--panel, #1a1a2e); color: var(--text-2, #aaa);
    font: 14px/1 system-ui, sans-serif; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  #lf-sb-toggle:hover { color: var(--text, #e0e0e0); }
  body.lf-sb-hidden #lf-sb-toggle { right: 8px; }
</style>
<button id="lf-sb-toggle" type="button"></button>
<script>
(function () {
  var btn = document.getElementById('lf-sb-toggle');
  function set(hidden, report) {
    document.body.classList.toggle('lf-sb-hidden', hidden);
    btn.textContent = hidden ? '\u2039' : '\u203A';
    btn.title = hidden ? 'Show panel' : 'Hide panel';
    window.dispatchEvent(new Event('resize'));
    if (report) try { parent.postMessage({ lfMapSidebar: !hidden }, '*'); } catch (e) {}
  }
  btn.addEventListener('click', function () { set(!document.body.classList.contains('lf-sb-hidden'), true); });
  set(/[#&]sidebar=0/.test(location.hash), false);
})();
</script>
`

/** graphify's page as LocalForge serves it: bundled library + collapsible side panel. */
export function enhanceGraphHtml(html: string): string {
  const out = localizeGraphHtml(html)
  const i = out.lastIndexOf('</body>')
  return i < 0 ? out + SIDEBAR_TOGGLE : out.slice(0, i) + SIDEBAR_TOGGLE + out.slice(i)
}

export function handleGraphScheme(projectPath: (id: string) => string | null): void {
  const req = createRequire(import.meta.url)
  let visPath: string | null = null
  try {
    visPath = req.resolve('vis-network/standalone/umd/vis-network.min.js')
  } catch {
    visPath = null
  }
  protocol.handle(GRAPH_SCHEME, (request) => {
    const url = new URL(request.url)
    const headers = { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    if (url.host === 'vendor' && url.pathname === '/vis-network.min.js' && visPath) {
      return new Response(readFileSync(visPath), { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } })
    }
    const m = /^\/([A-Za-z0-9_-]+)\/graph\.html$/.exec(url.pathname)
    if (url.host === 'project' && m) {
      const root = projectPath(m[1])
      const file = root ? path.join(root, 'graphify-out', 'graph.html') : null
      // Only a regular file really inside the project (no symlink pointing elsewhere on the host).
      if (root && file && existsSync(file) && lstatSync(file).isFile() && realpathSync(file).startsWith(realpathSync(root) + path.sep)) {
        return new Response(enhanceGraphHtml(readFileSync(file, 'utf8')), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }
    return new Response('Not found', { status: 404, headers })
  })
}
