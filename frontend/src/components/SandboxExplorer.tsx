import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as authService from '../services/auth';

interface FileSystemItem {
  path: string;
  isDirectory: boolean;
  isProtected: boolean;
}

interface SandboxExplorerProps {
  sandboxId: string;
}

function SandboxExplorer({ sandboxId }: SandboxExplorerProps) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileSystemItem[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const loadFiles = async (path: string = '') => {
    try {
      const url = `/api/sandbox/${sandboxId}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
      const res = await fetch(url, { headers: authService.getAuthHeader() });
      const data = await res.json();
      setFiles(data);
    } catch (error) {
      console.error('Failed to load files:', error);
    }
  };

  useEffect(() => {
    loadFiles(currentPath);
  }, [sandboxId]);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
    setFileContent('');
    loadFiles(path);
  };

  const handleItemClick = async (item: FileSystemItem) => {
    if (item.isDirectory) {
      navigateTo(item.path);
    } else {
      try {
        const res = await fetch(`/api/sandbox/${sandboxId}/files/${encodeURIComponent(item.path)}`, {
          headers: authService.getAuthHeader()
        });
        const data = await res.json();
        setSelectedFile(item.path);
        setFileContent(data.content);
        setIsEditing(false);
      } catch (error) {
        console.error('Failed to load file:', error);
      }
    }
  };

  const handleSave = async () => {
    if (!selectedFile) return;

    try {
      await fetch(`/api/sandbox/${sandboxId}/files`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...authService.getAuthHeader()
        },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

  const handleDelete = async (path: string) => {
    if (!confirm(t('sandbox.deleteConfirm', { path }))) return;

    try {
      await fetch(`/api/sandbox/${sandboxId}/files/${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: authService.getAuthHeader()
      });
      loadFiles(currentPath);
      if (selectedFile === path) {
        setSelectedFile(null);
        setFileContent('');
      }
    } catch (error) {
      console.error('Failed to delete file:', error);
    }
  };

  const handleDownload = async (path: string) => {
    try {
      const fileName = path.split('/').pop() || 'file';
      const url = `/api/sandbox/${sandboxId}/download/${encodeURIComponent(path)}`;
      
      const res = await fetch(url, { headers: authService.getAuthHeader() });
      const blob = await res.blob();
      
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('Failed to download file:', error);
    }
  };

  const goUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    navigateTo(parts.join('/'));
  };

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-white/5 bg-[#111111] p-3">
        <div className="flex items-center gap-2">
            <button
              onClick={goUp}
              disabled={!currentPath}
              className="rounded-lg border border-white/5 bg-[#27272a] px-2 py-1 text-sm text-zinc-300 transition-colors hover:bg-[#3f3f46] disabled:opacity-50"
              aria-label={t('sandbox.goUp')}
            >
            ↑
          </button>
          <span className="text-sm text-zinc-500 flex-1 truncate font-mono">
            {currentPath || '/'}
          </span>
        </div>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto bg-[#141415] p-2">
        {files.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-4">{t('sandbox.emptyDirectory')}</p>
        ) : (
          <div className="space-y-1">
            {files.map((item) => {
              const fileName = item.path.split('/').pop() || item.path;
              return (
                <div
                  key={item.path}
                  onClick={() => handleItemClick(item)}
                  className={`group flex items-center justify-between rounded-lg border px-2 py-1.5 transition-colors ${
                    selectedFile === item.path
                      ? 'border-brand/30 bg-brand/20'
                      : 'border-transparent hover:bg-[#27272a]'
                  }`}
                >
                  <div className="flex items-center gap-2 overflow-hidden flex-1">
                    <span className="text-zinc-500">{item.isDirectory ? '📁' : '📄'}</span>
                    <span className="text-sm text-zinc-300 truncate font-mono">{fileName}</span>
                    {item.isProtected && (
                      <span className="text-xs text-yellow-500" title={t('sandbox.protectedFile')}>🔒</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {!item.isDirectory && !item.isProtected && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(item.path);
                        }}
                        className="text-zinc-600 hover:text-brand transition p-1 rounded hover:bg-[#27272a]"
                        title={t('sandbox.downloadFile')}
                      >
                        ⬇️
                      </button>
                    )}
                    {!item.isProtected && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(item.path);
                        }}
                        className="text-zinc-600 hover:text-red-400 transition p-1 rounded hover:bg-[#27272a]"
                        title={t('sandbox.deleteFile')}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* File Editor */}
      {selectedFile && (
        <div className="border-t border-white/5 flex-1 flex flex-col min-h-[200px] bg-[#0d0d0d]">
          <div className="flex items-center justify-between border-b border-white/5 bg-[#1a1a1a] p-2">
            <span className="text-sm text-zinc-400 truncate font-mono">{selectedFile}</span>
            {isEditing ? (
              <button
                onClick={handleSave}
                className="px-3 py-1 bg-brand hover:bg-brand-dark rounded-lg text-sm transition-colors text-white shadow-md shadow-brand/20"
              >
                {t('sandbox.save')}
              </button>
            ) : (
              <button
                onClick={() => setIsEditing(true)}
                className="px-3 py-1 bg-[#27272a] hover:bg-[#3f3f46] rounded-lg text-sm transition-colors border border-white/10 text-zinc-300"
              >
                {t('sandbox.edit')}
              </button>
            )}
          </div>
          <textarea
            value={fileContent}
            onChange={(e) => setFileContent(e.target.value)}
            disabled={!isEditing}
            className="flex-1 bg-[#0d0d0d] text-zinc-300 p-3 text-sm font-mono focus:outline-none resize-none disabled:opacity-50"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

export default SandboxExplorer;
