import { useEffect, useState } from 'react';
import * as authService from '../services/auth';

interface FileSystemItem {
  path: string;
  isDirectory: boolean;
  isProtected: boolean;
}

function RemoteWorkspaceExplorer() {
  const [files, setFiles] = useState<FileSystemItem[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadFiles = async (path: string = '') => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/remote-workspace/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
      const res = await fetch(url, { headers: authService.getAuthHeader() });
      const data = await res.json();
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

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
    setFileContent('');
    loadFiles(path);
  };

  const handleItemClick = async (item: FileSystemItem) => {
    if (item.isDirectory) {
      navigateTo(item.path);
      return;
    }

    setError(null);
    try {
      const res = await fetch(`/api/remote-workspace/files/${encodeURIComponent(item.path)}`, {
        headers: authService.getAuthHeader(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load remote file');
      }
      setSelectedFile(item.path);
      setFileContent(data.content || '');
    } catch (err) {
      setSelectedFile(item.path);
      setFileContent('');
      setError(err instanceof Error ? err.message : 'Failed to load remote file');
    }
  };

  const goUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    navigateTo(parts.join('/'));
  };

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="border-b border-white/5 bg-[#111111] p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={goUp}
            disabled={!currentPath}
            className="rounded-lg border border-white/5 bg-[#27272a] px-2 py-1 text-sm text-zinc-300 transition-colors hover:bg-[#3f3f46] disabled:opacity-50"
            aria-label="Go up"
          >
            ↑
          </button>
          <button
            onClick={() => loadFiles(currentPath)}
            className="rounded-lg border border-white/5 bg-[#27272a] px-2 py-1 text-sm text-zinc-300 transition-colors hover:bg-[#3f3f46]"
            aria-label="Refresh remote workspace"
          >
            ↻
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-500">
            {currentPath || '/'}
          </span>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-[#141415] p-2">
        {loading ? (
          <p className="py-4 text-center text-sm text-zinc-600">Loading remote files...</p>
        ) : files.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-600">No files found.</p>
        ) : (
          <div className="space-y-1">
            {files.map((item) => {
              const fileName = item.path.split('/').pop() || item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => handleItemClick(item)}
                  className={`flex w-full items-center justify-between rounded-lg border px-2 py-1.5 text-left transition-colors ${
                    selectedFile === item.path
                      ? 'border-brand/30 bg-brand/20'
                      : 'border-transparent hover:bg-[#27272a]'
                  }`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="text-zinc-500">{item.isDirectory ? '📁' : '📄'}</span>
                    <span className="truncate font-mono text-sm text-zinc-300">{fileName}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedFile && (
        <div className="flex min-h-[240px] flex-1 flex-col border-t border-white/5 bg-[#0d0d0d]">
          <div className="flex items-center justify-between border-b border-white/5 bg-[#1a1a1a] p-2">
            <span className="truncate font-mono text-sm text-zinc-400">{selectedFile}</span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
              read only
            </span>
          </div>
          <pre className="flex-1 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-zinc-300">
            {fileContent}
          </pre>
        </div>
      )}
    </div>
  );
}

export default RemoteWorkspaceExplorer;
