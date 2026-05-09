const { IconSend, IconAttach, IconStop, IconBolt, IconKeyboard } = window.Icons;

function Composer({ running, onSend }) {
  const [text, setText] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const ref = React.useRef(null);

  // autosize
  React.useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 180) + 'px';
    }
  }, [text]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) {
        onSend(text);
        setText('');
      }
    }
  };

  return (
    <div style={{ padding: '0 24px 18px' }}>
      <div className={`composer ${focused ? 'focused' : ''} ${running ? 'running' : ''}`}>
        {/* Mode indicator */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px 4px',
          fontSize: 11, color: 'var(--fg-2)',
        }}>
          {running ? (
            <>
              <span style={{
                width: 6, height: 6, borderRadius: 999, background: 'var(--amber)',
                animation: 'pulse-dot 1.6s infinite',
              }} />
              <span><b style={{ color: 'var(--amber)', fontWeight: 600 }}>Interject</b> · message will be delivered to the running agent</span>
            </>
          ) : (
            <>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--fg-3)' }} />
              <span>Compose · agent is idle</span>
            </>
          )}
          <span style={{ flex: 1 }} />
          <span className="kbd subtle">⏎ to send · ⇧⏎ newline</span>
        </div>

        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={running
            ? 'Send guidance to the running agent…'
            : 'Describe a task, or paste an error…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />

        {/* Actions */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 8px 8px 8px',
        }}>
          <button className="action-btn" title="Attach">
            <IconAttach size={14} />
          </button>
          <button className="action-btn" title="Slash commands">
            <IconBolt size={14} />
            <span style={{ fontSize: 11.5 }}>Commands</span>
          </button>
          <span style={{ flex: 1 }} />
          {running && (
            <button className="action-btn danger" title="Stop agent">
              <IconStop size={11} />
              <span style={{ fontSize: 11.5 }}>Stop</span>
            </button>
          )}
          <button
            className="send-btn"
            disabled={!text.trim()}
            onClick={() => {
              if (text.trim()) { onSend(text); setText(''); }
            }}
          >
            <IconSend size={14} />
            <span>{running ? 'Interject' : 'Send'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

window.Composer = Composer;
