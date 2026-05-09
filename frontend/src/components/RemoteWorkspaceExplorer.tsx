import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import * as authService from '../services/auth';

interface FileSystemItem {
  path: string;
  name: string;
  isDirectory: boolean;
  isProtected: boolean;
  size?: number;
  modifiedAt?: string | null;
  createdAt?: string | null;
  gitStatus?: string | null;
}

const codeKeywords = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
  'import', 'in', 'interface', 'let', 'new', 'null', 'return', 'static', 'switch', 'this',
  'throw', 'true', 'try', 'type', 'undefined', 'var', 'while',
]);

function formatBytes(size?: number) {
  const value = Number(size || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string | null) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toLocaleString();
}

function gitStatusLabel(status?: string | null) {
  if (!status) return null;
  const normalized = status.replace(/_/g, ' ');
  if (status.includes('??')) return 'untracked';
  if (status.includes('M')) return 'modified';
  if (status.includes('A')) return 'added';
  if (status.includes('D')) return 'deleted';
  if (status.includes('R')) return 'renamed';
  return normalized.trim() || null;
}

function gitStatusClass(status?: string | null) {
  if (!status) return '';
  if (status.includes('??')) return 'border-blue-line bg-blue-soft text-blue';
  if (status.includes('M')) return 'border-amber-line bg-amber-soft text-amber';
  if (status.includes('A')) return 'border-accent-line bg-accent-soft text-[var(--accent)]';
  if (status.includes('D')) return 'border-rose-line bg-rose-soft text-rose';
  return 'border-[var(--line)] bg-[rgba(255,255,255,.02)] text-[var(--fg-1)]';
}

function languageFromPath(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return 'text';
  const map: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'React',
    ts: 'TypeScript',
    tsx: 'React TS',
    json: 'JSON',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    md: 'Markdown',
    py: 'Python',
    sh: 'Shell',
    yml: 'YAML',
    yaml: 'YAML',
  };
  return map[ext] || ext.toUpperCase();
}

function tokenClass(token: string) {
  if (/^\/\/|^#|^\/\*/.test(token)) return 'text-[var(--fg-3)]';
  if (/^(['"`]).*\1$/.test(token)) return 'text-[var(--accent)]';
  if (/^\d+(\.\d+)?$/.test(token)) return 'text-amber';
  if (codeKeywords.has(token)) return 'text-blue';
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return 'text-violet';
  return 'text-[var(--fg-1)]';
}

function renderHighlightedLine(line: string, lineIndex: number) {
  const parts = line.split(/(\/\/.*|#.*|\/\*.*\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g);
  return (
    <div key={lineIndex} className="table-row">
      <span className="table-cell select-none pr-4 text-right text-[var(--fg-0)]/40">{lineIndex + 1}</span>
      <span className="table-cell whitespace-pre pr-4">
        {parts.map((part, index) => part ? (
          <span key={`${lineIndex}-${index}`} className={tokenClass(part)}>{part}</span>
        ) : null)}
      </span>
    </div>
  );
}

async function readJsonResponse(res: Response) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.startsWith('<!doctype') || text.startsWith('<html')
      ? 'Remote workspace API route was not found.'
      : text.slice(0, 240));
  }
}

interface RemoteWorkspaceExplorerProps {
  socket?: Socket | null;
}

function RemoteWorkspaceExplorer({ socket }: RemoteWorkspaceExplorerProps = {}) {
  const [files, setFiles] = useState<FileSystemItem[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<FileSystemItem | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sortedFiles = useMemo(() => [...files].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  }), [files]);

  const loadFiles = async (path: string = '') => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/remote-workspace/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
      const res = await fetch(url, { headers: authService.getAuthHeader() });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load remote files');
      }
      setFiles(Array.isArray(data) ? data : []);
    } catch (err) {
      setFiles([]);
      setError(err instanceof Error ? err.message : 'Failed to load remote files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles(currentPath);
  }, []);

  // Live refresh: when the SSH agent runs write/edit/shell, the backend emits
  // `remote-workspace-changed`. We refresh the *current* folder view (debounced
  // so a burst of writes coalesces into a single reload).
  const currentPathRef = useRef(currentPath);
  useEffect(() => { currentPathRef.current = currentPath; }, [currentPath]);
  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadFiles(currentPathRef.current);
      }, 250);
    };
    socket.on('remote-workspace-changed', onChange);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off('remote-workspace-changed', onChange);
    };
  }, [socket]);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
    setSelectedItem(null);
    setFileContent('');
    setDraftContent('');
    setIsEditing(false);
    loadFiles(path);
  };

  const handleItemClick = async (item: FileSystemItem) => {
    if (item.isDirectory) {
      navigateTo(item.path);
      return;
    }

    setError(null);
    setIsEditing(false);
    try {
      const res = await fetch(`/api/remote-workspace/file?path=${encodeURIComponent(item.path)}`, {
        headers: authService.getAuthHeader(),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load remote file');
      }
      setSelectedFile(item.path);
      setSelectedItem(item);
      setFileContent(data.content || '');
      setDraftContent(data.content || '');
    } catch (err) {
      setSelectedFile(item.path);
      setSelectedItem(item);
      setFileContent('');
      setDraftContent('');
      setError(err instanceof Error ? err.message : 'Failed to load remote file');
    }
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/remote-workspace/files', {
        method: 'POST',
        headers: {
          ...authService.getAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: selectedFile, content: draftContent }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save remote file');
      }
      setFileContent(draftContent);
      setIsEditing(false);
      await loadFiles(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save remote file');
    } finally {
      setSaving(false);
    }
  };

  const goUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    navigateTo(parts.join('/'));
  };

  const fileActions = selectedFile && (
    <div className="flex shrink-0 items-center gap-2">
      {isEditing ? (
        <>
          <button
            type="button"
            onClick={() => {
              setDraftContent(fileContent);
              setIsEditing(false);
            }}
            className="rounded-[var(--radius-sm)] hairline px-2 py-1 text-xs text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveFile}
            disabled={saving}
            className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="rounded-[var(--radius-sm)] hairline px-2 py-1 text-xs text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]"
        >
          Edit
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="border-b hairline bg-[var(--bg-1)] p-3">
        <div className="flex items-center gap-2">
      <button
              onClick={goUp}
              disabled={!currentPath}
              className="rounded-[var(--radius-sm)] hairline bg-[var(--bg-elev)] px-2 py-1 text-sm text-[var(--fg-1)] transition-colors hover:bg-[rgba(255,255,255,.06)] disabled:opacity-50"
              aria-label="Go up"
            >
              ↑
            </button>
            <button
              onClick={() => loadFiles(currentPath)}
              className="rounded-[var(--radius-sm)] hairline bg-[var(--bg-elev)] px-2 py-1 text-sm text-[var(--fg-1)] transition-colors hover:bg-[rgba(255,255,255,.06)]"
             aria-label="Refresh remote workspace"
           >
             ↻
           </button>
           <span className="min-w-0 flex-1 truncate mono text-sm text-[var(--fg-3)]">
             {currentPath || '/'}
           </span>
         </div>
       </div>

       {selectedFile && (
         <div className="flex items-start justify-between gap-2 border-b hairline bg-[var(--bg-1)] p-2">
           <div className="min-w-0 flex-1">
             <div className="truncate mono text-sm text-[var(--fg-1)]">{selectedFile}</div>
             <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--fg-0)]/40">
               <span>{languageFromPath(selectedFile)}</span>
               {selectedItem && <span>{formatBytes(selectedItem.size)}</span>}
             </div>
           </div>
           {fileActions}
         </div>
       )}

       {error && (
         <div className="border-b border-rose-line bg-rose-soft px-3 py-2 text-xs leading-5 text-rose">
           {error}
         </div>
       )}

       <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-0)]">
         <div className="min-h-[240px] flex-1 overflow-auto border-b hairline">
           {loading ? (
             <p className="py-4 text-center text-sm text-[var(--fg-0)]/40">Loading remote files...</p>
           ) : sortedFiles.length === 0 ? (
             <p className="py-4 text-center text-sm text-[var(--fg-0)]/40">No files found.</p>
           ) : (
             <div className="min-w-[680px]">
               <div className="grid grid-cols-[minmax(220px,1fr)_90px_160px_160px_90px] gap-3 border-b hairline px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-[var(--fg-0)]/40">
                 <span>Name</span>
                 <span>Size</span>
                 <span>Created</span>
                 <span>Modified</span>
                 <span>Git</span>
               </div>
               {sortedFiles.map((item) => {
                 const statusLabel = gitStatusLabel(item.gitStatus);
                 return (
                   <button
                     key={item.path}
                     type="button"
                     onClick={() => handleItemClick(item)}
                     className={`grid w-full grid-cols-[minmax(220px,1fr)_90px_160px_160px_90px] gap-3 border-b hairline px-3 py-2 text-left text-xs transition-colors ${
                        selectedFile === item.path
                          ? 'bg-[var(--accent-soft)]'
                          : 'hover:bg-[rgba(255,255,255,.06)]'
                      }`}
                   >
                     <span className="flex min-w-0 items-center gap-2">
                       <span className={item.isDirectory ? 'text-blue' : 'text-[var(--fg-3)]'}>{item.isDirectory ? 'dir' : 'file'}</span>
                       <span className="truncate mono text-[var(--fg-0)]">{item.name || item.path}</span>
                     </span>
                     <span className="mono text-[var(--fg-3)]">{item.isDirectory ? '-' : formatBytes(item.size)}</span>
                     <span className="truncate text-[var(--fg-3)]">{formatDate(item.createdAt)}</span>
                     <span className="truncate text-[var(--fg-3)]">{formatDate(item.modifiedAt)}</span>
                     <span>
                       {statusLabel && (
                         <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${gitStatusClass(item.gitStatus)}`}>
                           {statusLabel}
                         </span>
                       )}
                     </span>
                   </button>
                 );
               })}
             </div>
           )}
         </div>

         <div className="flex min-h-[360px] flex-1 flex-col bg-[var(--bg-0)]">
           {selectedFile ? (
             <>
               <div className="border-b hairline bg-[var(--bg-1)] p-2">
                 <div className="min-w-0 flex-1">
                   <div className="truncate mono text-sm text-[var(--fg-1)]">{selectedFile}</div>
                   <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--fg-0)]/40">
                     <span>{languageFromPath(selectedFile)}</span>
                     {selectedItem && <span>{formatBytes(selectedItem.size)}</span>}
                   </div>
                 </div>
               </div>

               {isEditing ? (
                 <div className="min-h-0 flex-1 overflow-auto p-3 mono text-xs leading-5">
                   <textarea
                     value={draftContent}
                     onChange={(event) => setDraftContent(event.target.value)}
                     spellCheck={false}
                     className="min-h-full w-full resize-none overflow-auto whitespace-pre bg-transparent mono text-xs leading-5 text-[var(--fg-0)] outline-none caret-[var(--accent)] selection:bg-[var(--accent)]/20"
                   />
                 </div>
               ) : (
                 <div className="min-h-0 flex-1 overflow-auto p-3 mono text-xs leading-5">
                   <div className="table min-w-full">
                     {(fileContent || '').split('\n').map(renderHighlightedLine)}
                   </div>
                 </div>
               )}
             </>
           ) : (
             <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-[var(--fg-0)]/40">
               Select a file to preview or edit it.
             </div>
           )}
         </div>
       </div>
     </div>
   );
}

export default RemoteWorkspaceExplorer;
