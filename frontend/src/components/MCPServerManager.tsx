import { useState, useEffect } from 'react';

interface MCPServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

type MCPTransportType = 'sse' | 'streamable-http' | 'websocket';

interface MCPServerFormData {
  name: string;
  url: string;
  apiKey: string;
  transportType: MCPTransportType;
}

export function MCPServerManager() {
  const [servers, setServers] = useState<MCPServerStatus[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState<MCPServerFormData>({
    name: '',
    url: '',
    apiKey: '',
    transportType: 'sse',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadServers = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/mcp/servers', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setServers(data);
      }
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const handleAddServer = async () => {
    if (!formData.name || !formData.url) {
      setError('Server name and URL are required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = localStorage.getItem('token');

      const res = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: formData.name,
          url: formData.url,
          apiKey: formData.apiKey,
          transportType: formData.transportType,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setShowAddForm(false);
        setFormData({ name: '', url: '', apiKey: '', transportType: 'sse' });
        await loadServers();
      } else {
        setError(data.error || 'Failed to add server');
      }
    } catch (err) {
      setError('Failed to add server');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveServer = async (name: string) => {
    if (!confirm(`Are you sure you want to remove the MCP server "${name}"?`)) {
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        await loadServers();
      }
    } catch (err) {
      console.error('Failed to remove MCP server:', err);
    }
  };

  const handleReconnect = async (name: string) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/reconnect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        await loadServers();
      }
    } catch (err) {
      console.error('Failed to reconnect MCP server:', err);
    }
  };

  return (
    <div className="space-y-4">
      {/* Server List */}
      {servers.length > 0 && (
        <div className="space-y-2">
          {servers.map((server) => (
            <div
              key={server.name}
              className="rounded-[var(--radius)] hairline studio-card p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--fg-0)]">
                      {server.name}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        server.connected
                          ? 'border-accent-line bg-accent-soft text-[var(--accent)]'
                          : 'border-rose-line bg-rose-soft text-rose'
                      }`}
                    >
                      {server.connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  {server.tools.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {server.tools.map((tool) => (
                        <span
                          key={tool}
                          className="inline-flex items-center rounded-full hairline-strong bg-[rgba(255,255,255,.03)] px-2 py-0.5 text-[10px] text-[var(--fg-2)]"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                  {server.error && (
                    <p className="mt-1 text-xs text-rose">{server.error}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleReconnect(server.name)}
                    className="rounded-[var(--radius-sm)] p-1.5 text-[var(--fg-3)] transition-colors hover:bg-[rgba(255,255,255,.03)] hover:text-[var(--fg-0)]"
                    title="Reconnect"
                  >
                    <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleRemoveServer(server.name)}
                    className="rounded-[var(--radius-sm)] p-1.5 text-[var(--fg-3)] transition-colors hover:bg-rose-soft hover:text-rose"
                    title="Remove"
                  >
                    <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {servers.length === 0 && !showAddForm && (
        <div className="rounded-[var(--radius)] border border-dashed hairline bg-[rgba(255,255,255,.02)] px-4 py-6 text-center">
          <p className="text-sm text-[var(--fg-3)]">No MCP servers configured</p>
        </div>
      )}

      {/* Add Server Form */}
      {showAddForm ? (
        <div className="rounded-[var(--radius)] hairline studio-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-[var(--fg-0)]">Add MCP Server</h4>
            <button
              onClick={() => {
                setShowAddForm(false);
                setError(null);
              }}
              className="rounded-[var(--radius-sm)] p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
            >
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-soft border border-rose-line px-3 py-2 text-sm text-rose">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs text-[var(--fg-2)] mb-1">Server Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., my-mcp-server"
              className="w-full bg-[rgba(255,255,255,.025)] border border-[var(--line)] text-[var(--fg-0)] rounded-[var(--radius-sm)] px-3 py-2 focus:outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)] text-sm placeholder:text-[var(--fg-0)]/40"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--fg-2)] mb-1">Server URL</label>
            <input
              type="text"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              placeholder="https://mcp-server.example.com/sse"
              className="w-full bg-[rgba(255,255,255,.025)] border border-[var(--line)] text-[var(--fg-0)] rounded-[var(--radius-sm)] px-3 py-2 focus:outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)] text-sm placeholder:text-[var(--fg-0)]/40"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--fg-2)] mb-1">Transport Type</label>
            <select
              value={formData.transportType}
              onChange={(e) => setFormData({ ...formData, transportType: e.target.value as MCPTransportType })}
              className="w-full bg-[rgba(255,255,255,.025)] border border-[var(--line)] text-[var(--fg-0)] rounded-[var(--radius-sm)] px-3 py-2 focus:outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)] text-sm"
            >
              <option value="sse">SSE (Server-Sent Events)</option>
              <option value="streamable-http">Streamable HTTP</option>
              <option value="websocket">WebSocket</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-[var(--fg-2)] mb-1">API Key (optional)</label>
            <input
              type="password"
              value={formData.apiKey}
              onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
              placeholder="Enter your API key"
              className="w-full bg-[rgba(255,255,255,.025)] border border-[var(--line)] text-[var(--fg-0)] rounded-[var(--radius-sm)] px-3 py-2 focus:outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)] text-sm placeholder:text-[var(--fg-0)]/40"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => {
                setShowAddForm(false);
                setError(null);
              }}
              className="px-3 py-1.5 text-sm rounded-[var(--radius-sm)] hairline text-[var(--fg-2)] hover:text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAddServer}
              disabled={loading}
              className="px-3 py-1.5 text-sm rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent)]/80 transition-colors disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Server'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full flex items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed hairline bg-[rgba(255,255,255,.02)] px-4 py-3 text-sm text-[var(--fg-2)] transition-colors hover:bg-[var(--bg-elev)] hover:text-[var(--fg-1)]"
        >
          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add MCP Server
        </button>
      )}
    </div>
  );
}
