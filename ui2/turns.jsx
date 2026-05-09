// Conversation turn components.
const { IconCheck, IconAlert, IconClock, IconTerminal, IconBrain, IconRewind, IconCopy, IconChevronD, IconBolt } = window.Icons;

const turnStyles = {
  turn: { padding: '14px 0', borderTop: '1px solid var(--line)' },
  turnFirst: { padding: '14px 0' },
  meta: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: 'var(--fg-2)', marginBottom: 8,
    letterSpacing: 0.2,
  },
  metaIcon: {
    width: 22, height: 22, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))',
    border: '1px solid var(--line)',
    color: 'var(--fg-1)', flexShrink: 0,
  },
  metaSpacer: { flex: 1 },
  metaTime: { color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' },
};

// ----- USER TURN -----
function UserTurn({ turn, first }) {
  return (
    <div style={{ ...turnStyles.turn, ...(first ? turnStyles.turnFirst : {}) }}>
      <div style={turnStyles.meta}>
        <div style={{ ...turnStyles.metaIcon, background: 'var(--accent-soft)', borderColor: 'var(--accent-line)', color: 'var(--accent)' }}>
          <span style={{ fontSize: 10, fontWeight: 600, fontFamily: 'Inter' }}>OP</span>
        </div>
        <span style={{ color: 'var(--fg-1)', fontWeight: 500 }}>You</span>
        <span style={turnStyles.metaSpacer} />
        <span style={turnStyles.metaTime}>{turn.at}</span>
      </div>
      <div style={{
        color: 'var(--fg-0)', fontSize: 13.5, lineHeight: 1.6,
        paddingLeft: 26, maxWidth: 720,
      }}>
        {turn.body}
      </div>
    </div>
  );
}

// ----- THOUGHT TURN -----
function ThoughtTurn({ turn, showThoughts }) {
  const [open, setOpen] = React.useState(true);
  if (!showThoughts) {
    return (
      <div style={turnStyles.turn}>
        <div style={turnStyles.meta}>
          <div style={turnStyles.metaIcon}><IconBrain size={11} /></div>
          <span style={{ color: 'var(--fg-2)' }}>Reasoning hidden</span>
          <span style={turnStyles.metaSpacer} />
          <span style={turnStyles.metaTime}>{turn.at}</span>
        </div>
      </div>
    );
  }
  return (
    <div style={turnStyles.turn}>
      <div style={turnStyles.meta} onClick={() => setOpen(!open)}>
        <div style={turnStyles.metaIcon}><IconBrain size={11} /></div>
        <span style={{ color: 'var(--fg-1)', fontWeight: 500 }}>Reasoning</span>
        <span style={{ color: 'var(--fg-3)' }}>· {turn.body.split(' ').length} words</span>
        <span style={turnStyles.metaSpacer} />
        <span style={turnStyles.metaTime}>{turn.at}</span>
      </div>
      {open && (
        <div style={{
          paddingLeft: 26, maxWidth: 720,
          color: 'var(--fg-1)', fontSize: 13, lineHeight: 1.65,
          fontStyle: 'italic', opacity: 0.85,
        }}>
          {turn.body}
        </div>
      )}
    </div>
  );
}

// ----- TOOL TURN -----
const lineColor = {
  log:  'var(--fg-1)',
  ok:   '#7fd6a8',
  err:  '#f08a8a',
  meta: 'var(--fg-3)',
  rule: 'transparent',
};

function ToolTurn({ turn }) {
  const [open, setOpen] = React.useState(true);
  const statusInfo = {
    ok:      { color: 'var(--accent)',  bg: 'var(--accent-soft)',   border: 'var(--accent-line)',  label: 'ok',      icon: <IconCheck size={11} /> },
    fail:    { color: 'var(--rose)',    bg: 'var(--rose-soft)',     border: 'rgba(231,110,110,0.3)', label: 'failed', icon: <IconAlert size={11} /> },
    running: { color: 'var(--amber)',   bg: 'var(--amber-soft)',    border: 'rgba(227,179,65,0.3)', label: 'running', icon: <IconClock size={11} /> },
  }[turn.status];

  return (
    <div style={turnStyles.turn}>
      <div style={turnStyles.meta}>
        <div style={turnStyles.metaIcon}><IconTerminal size={11} /></div>
        <span style={{ color: 'var(--fg-1)', fontWeight: 500 }}>Tool</span>
        <span style={{ color: 'var(--fg-3)' }}>· {turn.name}</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 7px', borderRadius: 999,
          background: statusInfo.bg, border: `1px solid ${statusInfo.border}`,
          color: statusInfo.color, fontSize: 10, fontWeight: 500,
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          {statusInfo.icon}{statusInfo.label}
        </span>
        {turn.duration && (
          <span style={{ color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>· {turn.duration}</span>
        )}
        <span style={turnStyles.metaSpacer} />
        <button className="icon-btn" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          <span style={{ display: 'inline-block', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
            <IconChevronD size={12} />
          </span>
        </button>
        <button className="icon-btn" title="Rewind to here"><IconRewind size={12} /></button>
        <button className="icon-btn" title="Copy command"><IconCopy size={12} /></button>
      </div>

      <div style={{ paddingLeft: 30 }}>
        <div className="mono" style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.005))',
          border: '1px solid var(--line)',
          borderRadius: 10, overflow: 'hidden',
          fontSize: 12, lineHeight: 1.65,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
        }}>
          {/* Command line */}
          <div style={{
            padding: '8px 12px',
            display: 'flex', alignItems: 'flex-start', gap: 8,
            borderBottom: open ? '1px solid var(--line)' : 'none',
            background: 'rgba(255,255,255,0.015)',
          }}>
            <span style={{ color: 'var(--accent)', userSelect: 'none' }}>$</span>
            <span style={{
              color: 'var(--fg-0)', wordBreak: 'break-all',
              flex: 1,
            }}>
              {turn.cmd}
            </span>
          </div>

          {/* Output */}
          {open && (
            <div style={{ padding: '10px 12px 10px 26px' }}>
              {turn.output.map((ln, i) => {
                if (ln.kind === 'rule') {
                  return <div key={i} style={{ height: 1, background: 'var(--line)', margin: '6px 0' }} />;
                }
                return (
                  <div key={i} style={{
                    color: lineColor[ln.kind] || 'var(--fg-1)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {ln.text}
                  </div>
                );
              })}
              {turn.status === 'running' && (
                <div style={{ marginTop: 6, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="cursor-blink" style={{
                    display: 'inline-block', width: 8, height: 14,
                    background: 'var(--amber)', animation: 'blink 1s step-end infinite',
                    verticalAlign: 'middle',
                  }} />
                  <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>running…</span>
                </div>
              )}
              {turn.truncated && (
                <button style={{
                  marginTop: 8, padding: '4px 10px',
                  background: 'var(--bg-2)', border: '1px solid var(--line)',
                  borderRadius: 6, color: 'var(--fg-1)', fontSize: 11,
                  cursor: 'pointer', fontFamily: 'Inter',
                }}>
                  Show full output ({turn.truncated})
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.Turns = { UserTurn, ThoughtTurn, ToolTurn };
