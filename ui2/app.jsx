const { IconExit, IconSettings, IconChevronD, IconLogo } = window.Icons;
const { UserTurn, ThoughtTurn, ToolTurn } = window.Turns;
const { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "comfortable",
  "accent": "#34c08a",
  "showThoughts": true,
  "sidebar": "expanded",
  "rail": true
}/*EDITMODE-END*/;

// Viewport hook → 'mobile' | 'tablet' | 'desktop'
function useViewport() {
  const get = () => {
    const w = window.innerWidth;
    if (w < 720)  return 'mobile';
    if (w < 1180) return 'tablet';
    return 'desktop';
  };
  const [vp, setVp] = React.useState(get);
  React.useEffect(() => {
    const onR = () => setVp(get());
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  return vp;
}

function MenuIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 5h10M3 8h10M3 11h10" />
    </svg>
  );
}
function FilesIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5.5C2 4.67 2.67 4 3.5 4h2.4l1.2 1.2H12.5c.83 0 1.5.67 1.5 1.5v5.3c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5V5.5z" />
    </svg>
  );
}
function MoreIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const vp = useViewport();
  const [activeId, setActiveId] = React.useState('t1');
  const [reasoning, setReasoning] = React.useState('medium');
  const [running, setRunning] = React.useState(true);
  const [filesSource, setFilesSource] = React.useState(null);

  // Overlay state for tablet/mobile
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [railOpen, setRailOpen] = React.useState(false);

  // Close overlays when viewport changes
  React.useEffect(() => {
    setSidebarOpen(false);
    setRailOpen(false);
  }, [vp]);

  // Lock body scroll when an overlay is open
  React.useEffect(() => {
    const anyOverlay = (vp !== 'desktop' && (sidebarOpen || railOpen)) ||
                       (vp === 'mobile' && filesSource);
    document.body.style.overflow = anyOverlay ? 'hidden' : '';
  }, [vp, sidebarOpen, railOpen, filesSource]);

  React.useEffect(() => {
    document.documentElement.style.setProperty('--accent', t.accent);
    const rgb = hexToRgb(t.accent);
    if (rgb) {
      document.documentElement.style.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`);
      document.documentElement.style.setProperty('--accent-line', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)`);
    }
  }, [t.accent]);

  const conv = window.AppData.conversation;
  const threadRef = React.useRef(null);
  React.useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, []);

  const isMobile = vp === 'mobile';
  const isTablet = vp === 'tablet';
  const isDesktop = vp === 'desktop';

  // Sidebar visible inline only on desktop. Tablet/mobile = overlay.
  const sidebarInline = isDesktop;
  // Files panel inline on desktop+tablet (when source set). Mobile = overlay.
  const filesInline = filesSource && !isMobile;
  // Rail inline only on desktop. Tablet/mobile = overlay sheet.
  const railInline = t.rail && isDesktop;

  // On mobile, use rail collapsed by default for the (rare) case it's inline.
  const sidebarCollapsedDesktop = t.sidebar === 'collapsed';

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-0)', position: 'relative' }}>
      {sidebarInline && (
        <window.Sidebar
          activeId={activeId}
          onSelect={setActiveId}
          collapsed={sidebarCollapsedDesktop}
        />
      )}

      {filesInline && (
        <window.FilesPanel
          source={filesSource}
          onSourceChange={setFilesSource}
          onClose={() => setFilesSource(null)}
        />
      )}

      {/* Main column */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header className="app-header">
          {!isDesktop && (
            <button className="icon-btn" onClick={() => setSidebarOpen(true)} title="Tasks" aria-label="Open tasks">
              <MenuIcon size={16} />
            </button>
          )}

          {/* Breadcrumb / title */}
          <div className="hd-title">
            {isDesktop && <>
              <span style={{ color: 'var(--fg-3)' }}>Tasks</span>
              <span style={{ color: 'var(--fg-3)' }}>/</span>
            </>}
            <span className="hd-title-name">Set up logistics-app dev env</span>
            <button className="icon-btn hd-only-desktop" style={{ marginLeft: 2 }}>
              <IconChevronD size={11} />
            </button>
          </div>

          {!isMobile && (
            <span className="status-pill running">
              <span className="dot" />
              {isTablet ? 'Running' : 'Running · 14:03 → now'}
            </span>
          )}

          <span style={{ flex: 1 }} />

          {!isMobile ? (
            <div className="env-tabs" title="Browse files">
              <button
                className={`env-tab ${filesSource === 'sandbox' ? 'active' : ''}`}
                onClick={() => setFilesSource(filesSource === 'sandbox' ? null : 'sandbox')}
              >
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', marginRight: 6, verticalAlign: 1 }} />
                Sandbox
              </button>
              <button
                className={`env-tab ${filesSource === 'remote' ? 'active' : ''}`}
                onClick={() => setFilesSource(filesSource === 'remote' ? null : 'remote')}
              >
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: '#5e9bff', marginRight: 6, verticalAlign: 1 }} />
                Remote
              </button>
            </div>
          ) : (
            <button
              className={`icon-btn ${filesSource ? 'on' : ''}`}
              onClick={() => setFilesSource(filesSource ? null : 'sandbox')}
              title="Files"
              aria-label="Files"
            >
              <FilesIcon size={15} />
            </button>
          )}

          {!isDesktop && t.rail && (
            <button
              className="icon-btn"
              onClick={() => setRailOpen(true)}
              title="Run details"
              aria-label="Run details"
            >
              <MoreIcon size={16} />
            </button>
          )}

          {isDesktop && <button className="icon-btn" title="Settings"><IconSettings size={14} /></button>}
          {isDesktop && <button className="icon-btn" title="Leave task"><IconExit size={14} /></button>}
        </header>

        {/* Mobile running banner (replaces header status pill) */}
        {isMobile && running && (
          <div className="mobile-running-bar">
            <span className="dot" />
            <span style={{ flex: 1 }}>Agent running · step 6 of ~8</span>
            <button className="rail-action danger" style={{ flex: 'none', padding: '3px 8px', fontSize: 11 }}>Stop</button>
          </div>
        )}

        {/* Thread + composer */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div ref={threadRef} className="thread-scroll">
            <div className="thread-inner">
              <div className="task-header">
                <div className="task-pill"><span style={{ width: 5, height: 5, borderRadius: 999, background: 'currentColor' }} />Task · in&nbsp;progress</div>
                <h1 className="task-title">
                  Set up <em>logistics-app</em> dev environment
                </h1>
                <div className="task-meta">
                  <span>Started 14:02</span>
                  <span className="dot-sep">·</span>
                  <span>6 steps</span>
                  <span className="dot-sep">·</span>
                  <span className="mono" style={{ fontSize: 11.5 }}>4,210 tok</span>
                  <span className="dot-sep">·</span>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-1)' }}>node-20</span>
                </div>
              </div>

              {conv.map((turn, i) => {
                const props = { turn, first: i === 0 };
                if (turn.type === 'user')    return <UserTurn key={i} {...props} />;
                if (turn.type === 'thought') return <ThoughtTurn key={i} {...props} showThoughts={t.showThoughts} />;
                if (turn.type === 'tool')    return <ToolTurn key={i} {...props} />;
                return null;
              })}

              {running && (
                <div className="working-row" style={{
                  marginTop: 16, padding: '11px 14px',
                  background: 'linear-gradient(90deg, var(--amber-soft), transparent 70%)',
                  border: '1px solid var(--amber-line)',
                  borderRadius: 12,
                  display: 'flex', alignItems: 'center', gap: 11,
                  animation: 'fade-up 0.3s ease',
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 999, background: 'var(--amber)',
                    boxShadow: '0 0 10px color-mix(in oklch, var(--amber) 60%, transparent)',
                    animation: 'pulse-dot 1.6s infinite', flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12.5, color: 'var(--fg-1)', minWidth: 0, flex: 1, letterSpacing: '-0.005em' }}>
                    Working <span className="serif" style={{ color: 'var(--amber)' }}>— patching</span> <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>scripts/dev.sh</span>
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>15&nbsp;tok/s</span>
                </div>
              )}
            </div>
          </div>

          <window.Composer
            running={running}
            onSend={(msg) => console.log('send:', msg)}
          />
        </div>
      </main>

      {railInline && (
        <window.Rail
          tokensPerSec={15}
          totalTokens={4210}
          reasoning={reasoning}
          onReasoningChange={setReasoning}
        />
      )}

      {/* Sidebar overlay (tablet + mobile) */}
      {!sidebarInline && sidebarOpen && (
        <Overlay onClose={() => setSidebarOpen(false)} side="left" width={isMobile ? '100%' : 320}>
          <window.Sidebar
            activeId={activeId}
            onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }}
            collapsed={false}
          />
        </Overlay>
      )}

      {/* Files overlay on mobile */}
      {isMobile && filesSource && (
        <Overlay onClose={() => setFilesSource(null)} side="right" width="100%">
          <window.FilesPanel
            source={filesSource}
            onSourceChange={setFilesSource}
            onClose={() => setFilesSource(null)}
          />
        </Overlay>
      )}

      {/* Rail bottom-sheet on tablet/mobile */}
      {!railInline && railOpen && t.rail && (
        <Overlay onClose={() => setRailOpen(false)} side="right" width={isMobile ? '100%' : 320}>
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-0)' }}>
            <div style={{
              padding: '10px 14px', borderBottom: '1px solid var(--line)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Run details</span>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" onClick={() => setRailOpen(false)} aria-label="Close">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <window.Rail
                tokensPerSec={15}
                totalTokens={4210}
                reasoning={reasoning}
                onReasoningChange={setReasoning}
              />
            </div>
          </div>
        </Overlay>
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio
            label="Density" value={t.density}
            onChange={(v) => setTweak('density', v)}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
          />
          <TweakRadio
            label="Sidebar" value={t.sidebar}
            onChange={(v) => setTweak('sidebar', v)}
            options={[{ value: 'expanded', label: 'Expanded' }, { value: 'collapsed', label: 'Rail only' }]}
          />
          <TweakToggle
            label="Right rail" value={t.rail}
            onChange={(v) => setTweak('rail', v)}
          />
        </TweakSection>
        <TweakSection title="Behavior">
          <TweakToggle
            label="Show reasoning" value={t.showThoughts}
            onChange={(v) => setTweak('showThoughts', v)}
          />
        </TweakSection>
        <TweakSection title="Theme">
          <TweakColor
            label="Accent" value={t.accent}
            onChange={(v) => setTweak('accent', v)}
            options={['#34c08a', '#5e9bff', '#9a8cf2', '#e3b341']}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

function Overlay({ children, onClose, side = 'left', width = 320 }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay-root">
      <div className="overlay-backdrop" onClick={onClose} />
      <div
        className={`overlay-panel ${side}`}
        style={{ width, maxWidth: '100vw' }}
      >
        {children}
      </div>
    </div>
  );
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : null;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
