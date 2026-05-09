const { IconTools, IconBolt, IconBrain, IconSettings, IconCheck } = window.Icons;

function Rail({ tokensPerSec, totalTokens, reasoning, onReasoningChange }) {
  const [toolsOn, setToolsOn] = React.useState({
    shell: true, read: true, write: true, search: true, web: false, browser: false,
  });
  const enabledCount = Object.values(toolsOn).filter(Boolean).length;

  const card = {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.005))',
    border: '1px solid var(--line)',
    borderRadius: 12, padding: '12px 13px', marginBottom: 10,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
  };
  const cardTitle = {
    fontSize: 10, fontWeight: 600, color: 'var(--fg-3)',
    letterSpacing: 0.08 + 'em', textTransform: 'uppercase',
    marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7,
    fontFamily: 'var(--font-mono)',
  };

  return (
    <aside style={{
      width: 272, padding: '14px 12px', background: 'transparent',
      borderLeft: '1px solid var(--line)', overflowY: 'auto',
    }}>
      {/* Run status */}
      <div style={{ ...card, background: 'linear-gradient(180deg, var(--amber-soft), transparent 80%)', borderColor: 'var(--amber-line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 999,
            background: 'var(--amber)',
            boxShadow: '0 0 10px color-mix(in oklch, var(--amber) 60%, transparent)',
            animation: 'pulse-dot 1.6s ease-out infinite',
          }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-0)', letterSpacing: '-0.01em' }}>Agent running</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 10, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>step&nbsp;6/8</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-1)', marginTop: 6, lineHeight: 1.5 }}>
          Cleaning up old <span className="mono" style={{ color: 'var(--fg-2)', fontSize: 11.5 }}>dev</span> processes before retry.
        </div>
        <div style={{
          marginTop: 12, height: 4, borderRadius: 999,
          background: 'rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative',
        }}>
          <div style={{
            position: 'absolute', inset: 0, width: '70%',
            background: 'linear-gradient(90deg, transparent, var(--amber), transparent)',
            backgroundSize: '200% 100%',
            animation: 'shimmer 2s linear infinite',
          }} />
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: '70%', background: 'color-mix(in oklch, var(--amber) 60%, transparent)',
          }} />
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
          <button className="rail-action danger">Interrupt</button>
          <button className="rail-action">Pause</button>
        </div>
      </div>

      {/* Reasoning */}
      <div style={card}>
        <div style={cardTitle}><IconBrain size={11} /> Reasoning</div>
        <div className="seg" role="tablist">
          {['Low', 'Medium', 'High'].map(level => (
            <button
              key={level}
              className={`seg-item ${reasoning === level.toLowerCase() ? 'on' : ''}`}
              onClick={() => onReasoningChange(level.toLowerCase())}
            >
              {level}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 8, lineHeight: 1.4 }}>
          More thinking before each action. Slower but more reliable on ambiguous tasks.
        </div>
      </div>

      {/* Tools */}
      <div style={card}>
        <div style={cardTitle}>
          <IconTools size={11} />
          <span>Tools</span>
          <span style={{ flex: 1 }} />
          <span style={{
            fontSize: 10, color: 'var(--accent)', fontWeight: 600,
            letterSpacing: 0,
          }}>{enabledCount}/{Object.keys(toolsOn).length}</span>
        </div>
        {Object.entries(toolsOn).map(([k, v]) => (
          <label key={k} className="tool-row">
            <input
              type="checkbox" checked={v}
              onChange={() => setToolsOn(s => ({ ...s, [k]: !v }))}
            />
            <span className="checkbox" data-on={v}>
              {v && <IconCheck size={10} />}
            </span>
            <span style={{ flex: 1, color: v ? 'var(--fg-1)' : 'var(--fg-3)' }}>{k}</span>
            <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              {{ shell: '⌘1', read: '⌘2', write: '⌘3', search: '⌘4' }[k] || ''}
            </span>
          </label>
        ))}
      </div>

      {/* Telemetry */}
      <div style={card}>
        <div style={cardTitle}><IconBolt size={11} /> Telemetry</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Stat label="Tokens/s" value={tokensPerSec} />
          <Stat label="Tokens" value={totalTokens.toLocaleString()} />
          <Stat label="Steps" value="6" />
          <Stat label="Cost" value="$0.04" />
        </div>
      </div>

      {/* Environment */}
      <div style={card}>
        <div style={cardTitle}><IconSettings size={11} /> Environment</div>
        <div style={envRow}><span style={envKey}>Sandbox</span><span style={envVal}>node-20</span></div>
        <div style={envRow}><span style={envKey}>Model</span><span style={envVal}>claude-haiku-4-5</span></div>
        <div style={envRow}><span style={envKey}>Branch</span><span style={envVal}>main · clean</span></div>
        <div style={envRow}><span style={envKey}>Memory</span><span style={envVal}>3 notes</span></div>
      </div>
    </aside>
  );
}

const envRow = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11.5 };
const envKey = { color: 'var(--fg-3)' };
const envVal = { color: 'var(--fg-1)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 };

function Stat({ label, value }) {
  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))',
      border: '1px solid var(--line)',
      borderRadius: 8, padding: '8px 10px',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
    }}>
      <div style={{ fontSize: 9.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--fg-0)', fontVariantNumeric: 'tabular-nums', marginTop: 2, letterSpacing: '-0.018em' }}>{value}</div>
    </div>
  );
}

window.Rail = Rail;
