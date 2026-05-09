const { IconChevronD, IconChevronR, IconCopy } = window.Icons;

// File-type glyph (small colored pill) — stays consistent across tree + viewer
function FileGlyph({ type }) {
  const map = {
    sh:   { c: '#e3b341', label: 'sh' },
    js:   { c: '#f0d56a', label: 'js' },
    ts:   { c: '#5e9bff', label: 'ts' },
    json: { c: '#9a8cf2', label: '{}' },
    env:  { c: '#7fd6a8', label: '$' },
    md:   { c: '#b6bcc4', label: 'md' },
    log:  { c: '#e76e6e', label: '≡' },
    html: { c: '#ff9b6e', label: '<>' },
    conf: { c: '#7c838d', label: 'cf' },
  };
  const m = map[type] || { c: '#7c838d', label: '·' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 16, height: 16, borderRadius: 4,
      background: `${m.c}22`, color: m.c,
      fontSize: 8.5, fontWeight: 700,
      fontFamily: 'JetBrains Mono, monospace',
      flexShrink: 0,
    }}>{m.label}</span>
  );
}

// Folder icon
function FolderIcon({ open }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#a89b6e', flexShrink: 0 }}>
      {open
        ? <path d="M2 5.5C2 4.67 2.67 4 3.5 4h2.4l1.2 1.2H12.5c.83 0 1.5.67 1.5 1.5v.4H2V5.5zM2 7.1h12l-1.2 4.4c-.18.6-.73 1-1.35 1H4.55c-.62 0-1.17-.4-1.35-1L2 7.1z" />
        : <path d="M2 5.5C2 4.67 2.67 4 3.5 4h2.4l1.2 1.2H12.5c.83 0 1.5.67 1.5 1.5v5.3c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5V5.5z" />}
    </svg>
  );
}

// Change indicator (M/A/D/!)
function ChangeBadge({ change }) {
  if (!change) return null;
  const map = {
    M: { c: 'var(--amber)',  bg: 'rgba(227,179,65,0.14)' },
    A: { c: 'var(--accent)', bg: 'var(--accent-soft)' },
    D: { c: 'var(--rose)',   bg: 'var(--rose-soft)' },
    '!': { c: 'var(--rose)', bg: 'var(--rose-soft)' },
  };
  const s = map[change] || map.M;
  return (
    <span style={{
      width: 14, height: 14, borderRadius: 3,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: s.bg, color: s.c,
      fontSize: 9, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
      flexShrink: 0,
    }}>{change}</span>
  );
}

// One row in the tree
function TreeNode({ node, depth, selectedPath, onSelect, path }) {
  const [open, setOpen] = React.useState(node.open || false);
  const fullPath = `${path}/${node.name}`;
  const selected = selectedPath === fullPath;

  if (node.type === 'dir') {
    return (
      <>
        <button
          className={`tree-row ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen(!open)}
        >
          <span className="caret">
            {open ? <IconChevronD size={10} /> : <IconChevronR size={10} />}
          </span>
          <FolderIcon open={open} />
          <span className="name">{node.name}</span>
          {node.readonly && <span className="badge ro">RO</span>}
        </button>
        {open && (node.children || []).map((child, i) => (
          <TreeNode
            key={i} node={child} depth={depth + 1}
            selectedPath={selectedPath} onSelect={onSelect}
            path={fullPath}
          />
        ))}
      </>
    );
  }

  return (
    <button
      className={`tree-row ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => onSelect(fullPath, node)}
    >
      <span className="caret" />
      <FileGlyph type={node.type} />
      <span className="name">{node.name}</span>
      {node.hot && <span className="hot-dot" title="Active" />}
      <span className="size">{node.size}</span>
      <ChangeBadge change={node.change} />
    </button>
  );
}

// File preview pane
function FilePreview({ file, fullPath }) {
  const sample = (file && window.AppData.files.samples[file.name])
    || window.AppData.files.samples._default;
  const tokenColor = { c: 'var(--fg-3)', k: '#9a8cf2', t: 'var(--fg-1)', e: '#f08a8a', w: 'var(--amber)' };

  if (!file) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 6,
        color: 'var(--fg-3)', fontSize: 12,
        padding: 20, textAlign: 'center',
      }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--bg-2)', display: 'grid', placeItems: 'center' }}>
          <FileGlyph type="md" />
        </div>
        <div>Select a file to preview</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>or drag one into chat to attach</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--bg-1)',
      }}>
        <FileGlyph type={file.type} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-0)' }}>{file.name}</span>
        <span style={{ fontSize: 10.5, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>{file.size}</span>
        {file.readonly && <span className="badge ro">RO</span>}
        <ChangeBadge change={file.change} />
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Copy contents"><IconCopy size={12} /></button>
      </div>
      <div className="mono" style={{
        flex: 1, overflow: 'auto', padding: '8px 0',
        background: 'var(--bg-1)',
        fontSize: 11.5, lineHeight: 1.7,
      }}>
        {sample.lines.map((ln, i) => (
          <div key={i} style={{ display: 'flex', paddingRight: 12 }}>
            <span style={{
              width: 30, flexShrink: 0, textAlign: 'right',
              color: 'var(--fg-3)', userSelect: 'none', paddingRight: 8,
              fontVariantNumeric: 'tabular-nums', fontSize: 10.5,
            }}>{i + 1}</span>
            <span style={{ color: tokenColor[ln[1]] || 'var(--fg-1)', whiteSpace: 'pre-wrap' }}>
              {ln[0] || '\u00A0'}
            </span>
          </div>
        ))}
      </div>
      <div style={{
        padding: '6px 12px', borderTop: '1px solid var(--line)',
        fontSize: 10.5, color: 'var(--fg-3)', display: 'flex', gap: 12,
        background: 'var(--bg-1)',
      }}>
        <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullPath}</span>
        <span>{sample.lang}</span>
        <span>UTF-8</span>
        <span>LF</span>
      </div>
    </div>
  );
}

function FilesPanel({ source, onSourceChange, onClose }) {
  const tree = window.AppData.files[source];
  const [selectedPath, setSelectedPath] = React.useState(
    source === 'sandbox' ? '~/projects/logistics-app/scripts/dev.sh' : null
  );
  const [selectedFile, setSelectedFile] = React.useState(
    source === 'sandbox' ? { name: 'dev.sh', type: 'sh', size: '2.1K', change: 'M' } : null
  );

  // reset selection when source changes
  React.useEffect(() => {
    if (source === 'sandbox') {
      setSelectedPath('~/projects/logistics-app/scripts/dev.sh');
      setSelectedFile({ name: 'dev.sh', type: 'sh', size: '2.1K', change: 'M' });
    } else {
      setSelectedPath('/var/www/logistics/logs/error.log');
      setSelectedFile({ name: 'error.log', type: 'log', size: '128K', readonly: true, change: '!' });
    }
  }, [source]);

  return (
    <div style={{
      width: 340, flexShrink: 0,
      background: 'var(--bg-0)',
      borderRight: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column',
      minHeight: 0,
    }}>
      {/* Tabs */}
      <div style={{
        padding: '8px 10px',
        borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <div className="env-tabs" style={{ flex: 1 }}>
          <button
            className={`env-tab ${source === 'sandbox' ? 'active' : ''}`}
            onClick={() => onSourceChange('sandbox')}
            style={{ flex: 1 }}
          >
            <span style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 999,
              background: 'var(--accent)', marginRight: 6, verticalAlign: 1,
            }} />
            Sandbox
          </button>
          <button
            className={`env-tab ${source === 'remote' ? 'active' : ''}`}
            onClick={() => onSourceChange('remote')}
            style={{ flex: 1 }}
          >
            <span style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 999,
              background: '#5e9bff', marginRight: 6, verticalAlign: 1,
            }} />
            Remote
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close files">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Connection bar */}
      <div style={{
        padding: '7px 12px',
        background: source === 'remote' ? 'rgba(94,155,255,0.05)' : 'transparent',
        borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 999,
          background: source === 'remote' ? '#5e9bff' : 'var(--accent)',
        }} />
        <span className="mono" style={{
          color: 'var(--fg-1)', flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {source === 'remote' ? 'ssh://' : ''}{tree.host}
        </span>
        <span style={{ color: 'var(--fg-3)' }}>{tree.status}</span>
      </div>

      {/* Tree */}
      <div style={{
        maxHeight: '40%', overflowY: 'auto',
        padding: '6px 4px',
        borderBottom: '1px solid var(--line)',
      }}>
        <div style={{
          padding: '4px 12px 6px', fontSize: 10,
          color: 'var(--fg-3)', letterSpacing: 0.6, textTransform: 'uppercase',
          fontWeight: 600,
        }}>
          {tree.root}
        </div>
        {tree.nodes.map((n, i) => (
          <TreeNode
            key={i + source} node={n} depth={0}
            path={tree.root}
            selectedPath={selectedPath}
            onSelect={(p, f) => { setSelectedPath(p); setSelectedFile(f); }}
          />
        ))}
      </div>

      {/* Preview */}
      <FilePreview file={selectedFile} fullPath={selectedPath} />
    </div>
  );
}

window.FilesPanel = FilesPanel;
