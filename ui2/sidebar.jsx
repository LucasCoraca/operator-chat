const { IconPlus, IconSearch, IconChat, IconCheck, IconAlert, IconClock, IconTasks, IconAgents, IconMemory, IconLogo } = window.Icons;

const statusPip = {
  running: { color: 'var(--amber)',  pulse: true },
  idle:    { color: 'var(--fg-3)',   pulse: false },
  done:    { color: 'var(--accent)', pulse: false },
  failed:  { color: 'var(--rose)',   pulse: false },
};

function Sidebar({ activeId, onSelect, collapsed }) {
  const [query, setQuery] = React.useState('');
  const tasks = window.AppData.tasks;
  const filtered = query
    ? tasks.filter(t => t.title.toLowerCase().includes(query.toLowerCase()))
    : tasks;

  if (collapsed) {
    return (
      <aside style={{
        width: 56, background: 'var(--bg-1)', borderRight: '1px solid var(--line)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '12px 0', gap: 6,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'grid', placeItems: 'center', marginBottom: 4,
        }}>
          <IconLogo size={18} />
        </div>
        <button className="rail-btn" title="New task"><IconPlus size={16} /></button>
        <button className="rail-btn" title="Tasks"><IconTasks size={16} /></button>
        <button className="rail-btn" title="Agents"><IconAgents size={16} /></button>
        <button className="rail-btn" title="Search"><IconSearch size={16} /></button>
        <div style={{ flex: 1 }} />
        <button className="rail-btn" title="Memory"><IconMemory size={16} /></button>
      </aside>
    );
  }

  return (
    <aside style={{
      width: 272, background: 'var(--bg-1)', borderRight: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Brand */}
      <div style={{
        padding: '14px 14px 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--line)',
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'linear-gradient(180deg, var(--accent-soft), transparent)',
          color: 'var(--accent)',
          border: '1px solid var(--accent-line)',
          display: 'grid', placeItems: 'center',
          boxShadow: '0 0 12px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <IconLogo size={15} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-0)', letterSpacing: '-0.012em' }}>
            Operator <span className="serif" style={{ color: 'var(--fg-2)', fontWeight: 400, marginLeft: 2 }}>studio</span>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-3)', letterSpacing: '0.04em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>workspace · sandbox</div>
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button className="quick-action primary">
          <IconPlus size={14} />
          <span>New task</span>
          <span className="kbd">⌘N</span>
        </button>
        <button className="quick-action">
          <IconTasks size={14} />
          <span>All tasks</span>
        </button>
        <button className="quick-action">
          <IconAgents size={14} />
          <span>Agents</span>
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 10px 8px' }}>
        <div className="search-input">
          <IconSearch size={13} />
          <input
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="kbd subtle">⌘K</span>
        </div>
      </div>

      {/* Task list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px 12px' }}>
        <div style={{
          padding: '6px 8px 4px', fontSize: 10, fontWeight: 600,
          color: 'var(--fg-3)', letterSpacing: 0.6, textTransform: 'uppercase',
        }}>
          Today
        </div>
        {filtered.map(t => {
          const st = statusPip[t.status];
          const isActive = t.id === activeId;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={`task-item ${isActive ? 'active' : ''}`}
            >
              <span style={{ position: 'relative', flexShrink: 0, marginTop: 4 }}>
                <span style={{
                  display: 'block', width: 8, height: 8, borderRadius: 999,
                  background: st.color,
                  animation: st.pulse ? 'pulse-dot 1.6s ease-out infinite' : 'none',
                }} />
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12.5, fontWeight: isActive ? 600 : 500,
                  color: isActive ? 'var(--fg-0)' : 'var(--fg-1)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {t.title}
                  {t.unread && (
                    <span style={{
                      width: 6, height: 6, borderRadius: 999,
                      background: 'var(--accent)', flexShrink: 0,
                    }} />
                  )}
                </span>
                <span style={{
                  display: 'block', fontSize: 11.5, color: 'var(--fg-2)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginTop: 1,
                }}>
                  {t.preview}
                </span>
              </span>
              <span style={{
                fontSize: 10.5, color: 'var(--fg-3)', flexShrink: 0,
                alignSelf: 'flex-start', marginTop: 4, fontVariantNumeric: 'tabular-nums',
              }}>
                {t.updated}
              </span>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 12px', borderTop: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 9,
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 999,
          background: 'linear-gradient(135deg, oklch(0.45 0.04 260), oklch(0.32 0.05 280))',
          fontSize: 10, fontWeight: 600, color: 'var(--fg-0)',
          display: 'grid', placeItems: 'center',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
          letterSpacing: '0.04em',
        }}>
          AC
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg-0)', letterSpacing: '-0.005em' }}>Alex Chen</div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>4,210 / 10k tok</div>
        </div>
        <button className="icon-btn" title="Memory"><IconMemory size={13} /></button>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
