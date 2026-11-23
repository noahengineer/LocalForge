import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { useStore } from './store'

// Read-only handle for automated UI tests (Playwright): lets them inspect live stats state.
;(window as unknown as { __lf: unknown }).__lf = { getState: () => useStore.getState() }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
