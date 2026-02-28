import React from 'react';

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error('[app-error-boundary] runtime crash', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen w-full bg-slate-50 dark:bg-brand-950 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-red-200 dark:border-red-900/30 bg-white dark:bg-brand-900 p-5 sm:p-6 shadow-xl">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-red-600 dark:text-red-300">Runtime Error</p>
          <h1 className="mt-2 text-lg sm:text-xl font-black text-brand-900 dark:text-slate-100">App crashed while rendering</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 break-words">
            {this.state.errorMessage || 'Unknown error'}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="h-9 px-3 rounded-lg border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200"
            >
              Reload App
            </button>
          </div>
        </div>
      </div>
    );
  }
}
