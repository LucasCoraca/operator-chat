import React, { Component as ReactComponent, useContext, useEffect, useRef, useState } from 'react';
import { Renderer } from '@openuidev/react-lang';
import type { ActionEvent } from '@openuidev/react-lang';
import { ThemeProvider } from '@openuidev/react-ui';
import { extendedLibrary } from '../openui/customComponents';
import { UIStreamingContext } from '../openui/streamingContext';
import { UISendToAssistantContext } from '../openui/uiActionContext';
import '@openuidev/react-ui/defaults.css';
import '@openuidev/react-ui/components.css';
import './uirenderer-overrides.css';

// Re-exported so existing importers (ChatInterface) keep working; the context
// itself lives in ../openui/streamingContext to avoid a circular import with
// customComponents (which also needs it).
export { UIStreamingContext };

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

/** Max re-render rate while streaming (~6.5 fps). */
const STREAM_THROTTLE_MS = 150;

export function UIRenderer({ response }: UIRendererProps) {
  const isStreaming = useContext(UIStreamingContext);
  const sendToAssistant = useContext(UISendToAssistantContext);

  // OpenUI buttons fire host-facing actions. We must handle them or clicks do
  // nothing: open_url opens a link; continue_conversation (the default for a
  // button with no explicit action, i.e. @ToAssistant) sends its message back
  // to the assistant. State actions (set/reset/run) are handled internally by
  // the Renderer and never reach here. Ignore clicks while streaming.
  const handleAction = (event: ActionEvent) => {
    if (event.type === 'open_url') {
      const url = typeof event.params?.url === 'string' ? event.params.url : undefined;
      if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (event.type === 'continue_conversation') {
      if (isStreaming || !sendToAssistant) return;
      const fromParams = typeof event.params?.message === 'string' ? event.params.message : '';
      let message = (fromParams || event.humanFriendlyMessage || '').trim();
      // Form submits carry the entered field values; include them so the
      // assistant sees what the user typed/selected, not just the button label.
      const fields = event.formState
        ? Object.entries(event.formState).filter(([, v]) => v != null && v !== '')
        : [];
      if (fields.length) {
        const summary = fields
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join('\n');
        message = message ? `${message}\n\n${summary}` : summary;
      }
      if (message) sendToAssistant(message);
    }
  };

  // The OpenUI Renderer re-parses and re-renders the WHOLE program (including
  // heavy SVG charts) on every change to `response`. During streaming that's a
  // change per token — dozens of full re-renders per second of chart-heavy DOM,
  // which can overwhelm the GPU compositor and crash the browser (notably on
  // Wayland/NVIDIA WebRender). So while streaming we throttle the text fed to
  // the Renderer to ~6.5 fps; once streaming ends we flush the final text
  // immediately so nothing is dropped.
  const [rendered, setRendered] = useState(response);
  const latest = useRef(response);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = response;

  useEffect(() => {
    if (!isStreaming) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setRendered(response); // flush final, complete program at once
      return;
    }
    // Streaming: coalesce rapid updates into one render per throttle window.
    if (timer.current) return; // a flush is already scheduled; it'll pick up latest
    timer.current = setTimeout(() => {
      timer.current = null;
      setRendered(latest.current);
    }, STREAM_THROTTLE_MS);
  }, [response, isStreaming]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // OpenUI re-parses on every chunk, so partial input transiently produces
  // validation errors (mid-token cuts, not-yet-defined references) that resolve
  // as more tokens arrive. Only surface errors once the reply has finished
  // streaming, and log the actual messages rather than a bare array.
  const handleError = (errors: unknown) => {
    if (isStreaming) return;
    const list = Array.isArray(errors) ? errors : errors == null ? [] : [errors];
    if (list.length === 0) return; // renderer reported no actual errors
    const messages = list.map((e: any) => e?.message ?? e?.hint ?? String(e));
    console.warn('OpenUI render error:', messages);
  };

  return (
    <div className="openui-render-root my-3 bg-transparent">
      <ErrorBoundary resetKey={rendered}>
        <ThemeProvider mode="dark">
          <Renderer
            response={rendered}
            library={extendedLibrary}
            isStreaming={isStreaming}
            onAction={handleAction}
            onError={handleError}
          />
        </ThemeProvider>
      </ErrorBoundary>
    </div>
  );
}
