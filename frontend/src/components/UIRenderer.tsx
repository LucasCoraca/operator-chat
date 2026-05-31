import React, { Component as ReactComponent, useContext } from 'react';
import { Renderer } from '@openuidev/react-lang';
import { openuiLibrary, ThemeProvider } from '@openuidev/react-ui';
import '@openuidev/react-ui/defaults.css';
import '@openuidev/react-ui/components.css';
import './uirenderer-overrides.css';

/**
 * True while the assistant message currently containing this renderer is still
 * streaming. ChatInterface provides `true` only around the in-flight reply so
 * the OpenUI renderer reveals progressively; finalized messages render at once.
 */
export const UIStreamingContext = React.createContext(false);

interface UIRendererProps {
  /** Raw OpenUI Lang source emitted by the model (the contents of a ```ui fence). */
  response: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render crashes from the OpenUI Renderer (e.g. the model passed a
 * component node where a string was expected). `resetKey` is the current
 * response text: when it changes (more tokens stream in, or the user retries),
 * the boundary clears its error and re-attempts rendering, so a transient crash
 * on partial/invalid input does not permanently break the block.
 */
class ErrorBoundary extends ReactComponent<{ children: React.ReactNode; resetKey: string }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--rose, #f87171)' }}>
          <span className="font-semibold">Visualization error: </span>
          {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export function UIRenderer({ response }: UIRendererProps) {
  const isStreaming = useContext(UIStreamingContext);

  // OpenUI re-parses on every streamed chunk, so partial input transiently
  // produces validation errors (mid-token cuts, not-yet-defined references)
  // that resolve as more tokens arrive. Only surface errors once the reply has
  // finished streaming, and log the actual messages rather than a bare array.
  const handleError = (errors: unknown) => {
    if (isStreaming) return;
    const list = Array.isArray(errors) ? errors : errors == null ? [] : [errors];
    if (list.length === 0) return; // renderer reported no actual errors
    const messages = list.map((e: any) => e?.message ?? e?.hint ?? String(e));
    console.warn('OpenUI render error:', messages);
  };

  return (
    <div className="openui-render-root my-3 bg-transparent">
      <ErrorBoundary resetKey={response}>
        <ThemeProvider mode="dark">
          <Renderer
            response={response}
            library={openuiLibrary}
            isStreaming={isStreaming}
            onError={handleError}
          />
        </ThemeProvider>
      </ErrorBoundary>
    </div>
  );
}
