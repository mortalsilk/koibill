import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State { error: Error | null }

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('koibill renderer failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <main className="app-recovery" role="alert">
      <div className="empty-mark">K</div>
      <p className="eyebrow">Renderer recovery</p>
      <h1>koibill hit an unexpected problem</h1>
      <p>Your saved workspace remains on disk. Reload the interface to restore it.</p>
      <details><summary>Technical details</summary><pre>{this.state.error.message}</pre></details>
      <div>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
        <button className="primary-button" onClick={() => window.location.reload()}>Reload koibill</button>
      </div>
    </main>
  }
}
