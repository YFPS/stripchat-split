import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

/**
 * React ErrorBoundary：捕获子组件渲染异常，防止整个应用白屏。
 * 崩溃信息同时输出到 console 和 localStorage，便于事后排查。
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })

    // 写入 localStorage（主进程可通过 IPC 读取）
    const crashRecord = {
      timestamp: new Date().toISOString(),
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    }

    try {
      const existing = localStorage.getItem('crash-logs')
      const logs = existing ? JSON.parse(existing) : []
      logs.push(crashRecord)
      // 最多保留最近 20 条
      if (logs.length > 20) logs.splice(0, logs.length - 20)
      localStorage.setItem('crash-logs', JSON.stringify(logs))
    } catch {
      // localStorage 满了也无所谓
    }

    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="min-h-screen bg-just-black flex items-center justify-center p-8">
          <div className="max-w-lg w-full bg-off-black border border-surface-25 rounded-card p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-900/30 flex items-center justify-center">
                <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-surface-cream font-mori">应用发生错误</h2>
                <p className="text-sm text-surface-50 font-mori">组件渲染过程中出现异常</p>
              </div>
            </div>

            <div className="bg-just-black rounded-card p-3 mb-4 overflow-auto max-h-48">
              <p className="text-red-400 text-sm font-mono">{this.state.error?.name}: {this.state.error?.message}</p>
              {this.state.error?.stack && (
                <pre className="text-surface-50 text-xs mt-2 whitespace-pre-wrap break-all">
                  {this.state.error.stack.split('\n').slice(1, 6).join('\n')}
                </pre>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={this.handleReset}
                className="btn-ghost-sm font-mori"
              >
                重试
              </button>
              <button
                onClick={() => window.location.reload()}
                className="btn-ghost-sm font-mori"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
