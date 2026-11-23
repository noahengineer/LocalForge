import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ protocol: {} }))
const { localizeGraphHtml } = await import('../src/main/graphProtocol')

describe('localizeGraphHtml', () => {
  it("points graphify's unpkg vis-network at the bundled copy", () => {
    const html = '<head><script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script></head>'
    expect(localizeGraphHtml(html)).toBe('<head><script src="lf-graph://vendor/vis-network.min.js"></script></head>')
  })
  it('leaves other content alone', () => {
    const html = '<script>var x = "https://unpkg.com/other.js"</script>'
    expect(localizeGraphHtml(html)).toBe(html)
  })
})
