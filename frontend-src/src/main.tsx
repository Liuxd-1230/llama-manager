import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted variable fonts: Newsreader/Inter/Plex carry the latin voices,
// Noto Serif/Sans SC ship unicode-range slices so browsers fetch only the
// CJK ranges actually rendered.
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/noto-serif-sc'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import App from './App'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
