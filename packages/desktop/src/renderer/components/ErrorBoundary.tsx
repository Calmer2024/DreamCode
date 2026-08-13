import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("DreamCode renderer failed", error, info);
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="recovery-screen" role="alert">
        <div>
          <span className="empty-kicker">DreamCode 需要恢复</span>
          <h1>界面遇到了意外问题</h1>
          <p>重新加载应用可以安全地恢复界面，已保存的会话不会丢失。</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      </main>
    );
  }
}
