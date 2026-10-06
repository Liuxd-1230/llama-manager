import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// Last-resort boundary around the whole shell: an uncaught render error must
// show a recovery screen instead of an empty document.
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("App crashed:", error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 520, textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
          <AlertTriangle size={34} color="var(--red)" />
          <h1 style={{ fontSize: 18, margin: 0 }}>界面遇到错误</h1>
          <p style={{ color: 'var(--text-3)', fontSize: 13, margin: 0, wordBreak: 'break-all' }}>{this.state.error.message}</p>
          <button
            onClick={() => { this.setState({ error: null }); location.reload() }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 10,
              border: '1px solid var(--line)', background: 'var(--accent)', color: '#fff', cursor: 'pointer', font: 'inherit', fontSize: 13.5 }}>
            <RotateCcw size={14} />重新加载
          </button>
        </div>
      </div>
    }
    return this.props.children
  }
}
