import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import { readTheme, resolveTheme } from './lib/theme'

// Before the first render, so a dark desktop never sees a light flash. App
// takes over from here, including following the system when it changes.
document.documentElement.dataset.theme = resolveTheme(readTheme())

// Not named `container`: Tailwind's content scanner matches bare words and
// would emit its .container component class into the bundle.
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root was not found in the document.')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
