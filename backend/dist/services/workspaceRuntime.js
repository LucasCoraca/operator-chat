"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceRuntimeFactory = exports.SshWorkspaceRuntime = exports.LocalWorkspaceRuntime = void 0;
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LIMIT = 300;
const MAX_READ_LIMIT = 1000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINAL_TAIL_LINES = 120;
const DEFAULT_TERMINAL_MAX_BYTES = 64 * 1024;
const MAX_TERMINAL_MAX_BYTES = 256 * 1024;
const MAX_READ_LINE_LENGTH = 1000;
function normalizeRelativePath(input) {
    const raw = (input || '.').replaceAll('\\', '/').trim() || '.';
    if (raw.includes('\0')) {
        throw new Error('Path contains a NUL byte');
    }
    if (path_1.default.posix.isAbsolute(raw)) {
        return path_1.default.posix.normalize(raw);
    }
    const normalized = path_1.default.posix.normalize(`/${raw}`);
    if (normalized === '/') {
        return '.';
    }
    const relative = normalized.slice(1);
    if (relative === '..' || relative.startsWith('../')) {
        throw new Error(`Path escapes workspace root: ${input}`);
    }
    return relative;
}
function ensureInsideLocalRoot(root, relativePath) {
    const resolvedRoot = path_1.default.resolve(root);
    const resolvedPath = path_1.default.resolve(resolvedRoot, relativePath === '.' ? '' : relativePath);
    const relative = path_1.default.relative(resolvedRoot, resolvedPath);
    if (relative.startsWith('..') || path_1.default.isAbsolute(relative)) {
        throw new Error(`Path escapes workspace root: ${relativePath}`);
    }
    return resolvedPath;
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function truncateOutput(value) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= MAX_COMMAND_OUTPUT_BYTES) {
        return { value, truncated: false };
    }
    const buffer = Buffer.from(value, 'utf8');
    let start = buffer.length - MAX_COMMAND_OUTPUT_BYTES;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
        start++;
    }
    return {
        value: `[output truncated to last ${MAX_COMMAND_OUTPUT_BYTES} bytes]\n${buffer.subarray(start).toString('utf8')}`,
        truncated: true,
    };
}
function unifiedDiff(filePath, oldContent, newContent) {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const out = [`--- ${filePath}`, `+++ ${filePath}`];
    const max = Math.max(oldLines.length, newLines.length);
    for (let index = 0; index < max; index++) {
        const oldLine = oldLines[index];
        const newLine = newLines[index];
        if (oldLine === newLine) {
            continue;
        }
        if (oldLine !== undefined) {
            out.push(`-${oldLine}`);
        }
        if (newLine !== undefined) {
            out.push(`+${newLine}`);
        }
    }
    return out.join('\n');
}
function replaceExact(content, oldString, newString, replaceAll = false) {
    if (oldString === newString) {
        throw new Error('No changes to apply: oldString and newString are identical.');
    }
    if (!oldString) {
        return newString;
    }
    const first = content.indexOf(oldString);
    if (first === -1) {
        throw new Error('Could not find oldString in the file. It must match exactly.');
    }
    if (replaceAll) {
        return content.replaceAll(oldString, newString);
    }
    if (first !== content.lastIndexOf(oldString)) {
        throw new Error('Found multiple matches for oldString. Provide more surrounding context or set replaceAll.');
    }
    return content.slice(0, first) + newString + content.slice(first + oldString.length);
}
class BaseWorkspaceRuntime {
    async editFile(relativePath, oldString, newString, replaceAll = false) {
        const current = await this.readRawFile(relativePath);
        const next = replaceExact(current, oldString, newString, replaceAll);
        const diff = unifiedDiff(normalizeRelativePath(relativePath), current, next);
        await this.writeFile(relativePath, next);
        return `Edit applied successfully.\n\n${diff}`;
    }
    async applyPatch(patchText) {
        const changes = parsePatch(patchText);
        if (changes.length === 0) {
            throw new Error('Patch has no file changes.');
        }
        const summaries = [];
        for (const change of changes) {
            if (change.type === 'delete') {
                await this.readRawFile(change.path);
                const target = normalizeRelativePath(change.path);
                await this.exec({ command: `rm -f -- ${shellQuote(target)}` });
                summaries.push(`D ${target}`);
                continue;
            }
            const oldContent = change.type === 'add' ? '' : await this.readRawFile(change.path);
            const nextContent = applyPatchChunks(oldContent, change.chunks);
            await this.writeFile(change.path, nextContent);
            summaries.push(`${change.type === 'add' ? 'A' : 'M'} ${normalizeRelativePath(change.path)}`);
        }
        return `Success. Updated the following files:\n${summaries.join('\n')}`;
    }
    async readRawFile(relativePath) {
        return this.readFile(relativePath, { offset: 1, limit: Number.MAX_SAFE_INTEGER });
    }
}
class LocalWorkspaceRuntime extends BaseWorkspaceRuntime {
    sandboxManager;
    sandboxId;
    kind = 'local_sandbox';
    root;
    constructor(sandboxManager, sandboxId) {
        super();
        this.sandboxManager = sandboxManager;
        this.sandboxId = sandboxId;
        const sandbox = sandboxManager.getSandbox(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        this.root = sandbox.basePath;
    }
    async list(relativePath = '.') {
        const normalized = normalizeRelativePath(relativePath);
        const fullPath = ensureInsideLocalRoot(this.root, normalized);
        const entries = await fs_1.default.promises.readdir(fullPath, { withFileTypes: true });
        return entries
            .map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}${entry.isDirectory() ? '/' : ''}`)
            .sort()
            .join('\n') || '(empty directory)';
    }
    async readFile(relativePath, options = {}) {
        const normalized = normalizeRelativePath(relativePath);
        const fullPath = ensureInsideLocalRoot(this.root, normalized);
        const stat = await fs_1.default.promises.stat(fullPath);
        if (stat.isDirectory()) {
            return this.list(normalized);
        }
        const content = await fs_1.default.promises.readFile(fullPath, 'utf8');
        return formatReadOutput(normalized, content, options);
    }
    async readRawFile(relativePath) {
        const normalized = normalizeRelativePath(relativePath);
        const fullPath = ensureInsideLocalRoot(this.root, normalized);
        return fs_1.default.promises.readFile(fullPath, 'utf8');
    }
    async writeFile(relativePath, content) {
        const normalized = normalizeRelativePath(relativePath);
        const fullPath = ensureInsideLocalRoot(this.root, normalized);
        await fs_1.default.promises.mkdir(path_1.default.dirname(fullPath), { recursive: true });
        const tempPath = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
        await fs_1.default.promises.writeFile(tempPath, content, 'utf8');
        await fs_1.default.promises.rename(tempPath, fullPath);
        return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${normalized}`;
    }
    async exec(options) {
        const workdir = ensureInsideLocalRoot(this.root, normalizeRelativePath(options.workdir));
        return runProcess('/bin/sh', ['-lc', options.command], {
            cwd: workdir,
            timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        });
    }
}
exports.LocalWorkspaceRuntime = LocalWorkspaceRuntime;
class SshWorkspaceRuntime extends BaseWorkspaceRuntime {
    config;
    kind = 'ssh_remote';
    root;
    constructor(config) {
        super();
        this.config = config;
        if (!config.enabled || !config.host || !config.username || !config.root) {
            throw new Error('SSH workspace is not fully configured.');
        }
        if (config.host.startsWith('-') ||
            config.username.startsWith('-') ||
            !/^[A-Za-z0-9._-]+$/.test(config.username) ||
            !/^[A-Za-z0-9.-]+$/.test(config.host)) {
            throw new Error('SSH workspace host or username is invalid.');
        }
        if (!config.root.startsWith('/')) {
            throw new Error('SSH workspace root must be an absolute path.');
        }
        this.root = path_1.default.posix.normalize(config.root);
    }
    async list(relativePath = '.') {
        const target = this.remotePath(relativePath);
        const result = await this.execRaw(`if [ ! -d ${shellQuote(target)} ]; then echo "Not a directory: ${target}" >&2; exit 2; fi\n` +
            `find ${shellQuote(target)} -maxdepth 1 -mindepth 1 -printf '%y %f\\n' 2>/dev/null | sort`, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote list failed');
        }
        return result.stdout.trim() || '(empty directory)';
    }
    async readFile(relativePath, options = {}) {
        const target = this.remotePath(relativePath);
        const offset = Math.max(1, Number(options.offset || 1));
        const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Number(options.limit || DEFAULT_READ_LIMIT)));
        const script = `
if [ -d ${shellQuote(target)} ]; then
  echo "__OPERATOR_CHAT_DIRECTORY__"
  find ${shellQuote(target)} -maxdepth 1 -mindepth 1 -printf '%y %f\\n' 2>/dev/null | sort
  exit $?
fi
if [ ! -f ${shellQuote(target)} ]; then
  echo "File not found: ${target}" >&2
  exit 2
fi
if [ -s ${shellQuote(target)} ] && ! LC_ALL=C grep -Iq . ${shellQuote(target)}; then
  echo "Cannot read binary file: ${target}" >&2
  exit 3
fi
awk -v start=${offset} -v limit=${limit} -v max=${MAX_READ_LINE_LENGTH} 'NR >= start && NR < start + limit { line=$0; if (length(line) > max) line=substr(line, 1, max) "..."; print NR ": " line } END { if (NR >= start + limit) print ""; if (NR >= start + limit) print "(Output truncated. Use a larger offset to continue.)" }' ${shellQuote(target)}
`;
        const result = await this.execRaw(script, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote read failed');
        }
        if (result.stdout.startsWith('__OPERATOR_CHAT_DIRECTORY__\n')) {
            return `${normalizeRelativePath(relativePath)}\ndirectory\n\n${result.stdout.replace('__OPERATOR_CHAT_DIRECTORY__\n', '').trimEnd()}`;
        }
        return `${normalizeRelativePath(relativePath)}\nfile\n\n${result.stdout.trimEnd()}`;
    }
    async readRawFile(relativePath) {
        const target = this.remotePath(relativePath);
        const script = `
if [ ! -f ${shellQuote(target)} ]; then
  echo "File not found: ${target}" >&2
  exit 2
fi
if [ -s ${shellQuote(target)} ] && ! LC_ALL=C grep -Iq . ${shellQuote(target)}; then
  echo "Cannot read binary file: ${target}" >&2
  exit 3
fi
base64 < ${shellQuote(target)}
`;
        const result = await this.execRaw(script, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote read failed');
        }
        const compact = result.stdout.replace(/\s+/g, '');
        return Buffer.from(compact, 'base64').toString('utf8');
    }
    async writeFile(relativePath, content) {
        const target = this.remotePath(relativePath);
        const encoded = Buffer.from(content, 'utf8').toString('base64');
        const script = `
mkdir -p -- ${shellQuote(path_1.default.posix.dirname(target))}
tmp=${shellQuote(`${target}.tmp-${process.pid}-${Date.now()}`)}
base64 -d > "$tmp" <<'__OPERATOR_CHAT_EOF__'
${encoded}
__OPERATOR_CHAT_EOF__
mv -- "$tmp" ${shellQuote(target)}
`;
        const result = await this.execRaw(script, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote write failed');
        }
        return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${normalizeRelativePath(relativePath)}`;
    }
    async exec(options) {
        const workdir = this.remotePath(options.workdir || '.');
        return this.execManaged(options.command, workdir, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    }
    async listTerminals() {
        const script = `
base=${shellQuote(this.terminalRoot())}
if [ ! -d "$base" ]; then
  echo "No managed terminals."
  exit 0
fi
for dir in "$base"/*; do
  [ -d "$dir" ] || continue
  id=$(basename "$dir")
  pid=$(cat "$dir/pid" 2>/dev/null || true)
  status="unknown"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    status="running"
  elif [ -f "$dir/exit_code" ]; then
    status="completed:$(cat "$dir/exit_code" 2>/dev/null)"
  fi
  cmd=$(head -c 180 "$dir/command" 2>/dev/null | tr '\\n' ' ')
  updated=$(date -r "$dir" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || true)
  printf '%s\\t%s\\tpid=%s\\t%s\\n  %s\\n' "$id" "$status" "$pid" "$updated" "$cmd"
done
`;
        const result = await this.execRaw(script, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote terminal list failed');
        }
        return result.stdout.trim() || 'No managed terminals.';
    }
    async readTerminal(terminalId, tailLines = DEFAULT_TERMINAL_TAIL_LINES, maxBytes = DEFAULT_TERMINAL_MAX_BYTES) {
        const id = normalizeTerminalId(terminalId);
        const lines = Math.max(1, Math.min(1000, Number(tailLines) || DEFAULT_TERMINAL_TAIL_LINES));
        const bytes = Math.max(1024, Math.min(MAX_TERMINAL_MAX_BYTES, Number(maxBytes) || DEFAULT_TERMINAL_MAX_BYTES));
        const dir = path_1.default.posix.join(this.terminalRoot(), id);
        const script = `
dir=${shellQuote(dir)}
if [ ! -d "$dir" ]; then
  echo "Terminal not found: ${id}" >&2
  exit 2
fi
pid=$(cat "$dir/pid" 2>/dev/null || true)
status="unknown"
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  status="running"
elif [ -f "$dir/exit_code" ]; then
  status="completed with exit code $(cat "$dir/exit_code" 2>/dev/null)"
fi
echo "Terminal: ${id}"
echo "Status: $status"
echo "PID: $pid"
echo
echo "Command:"
cat "$dir/command" 2>/dev/null || true
echo
echo "--- STDOUT (last ${lines} lines, max ${bytes} bytes) ---"
tail -n ${lines} "$dir/stdout" 2>/dev/null | tail -c ${bytes} || true
echo
echo "--- STDERR (last ${lines} lines, max ${bytes} bytes) ---"
tail -n ${lines} "$dir/stderr" 2>/dev/null | tail -c ${bytes} || true
`;
        const result = await this.execRaw(script, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote terminal read failed');
        }
        return result.stdout.trimEnd();
    }
    async killTerminal(terminalId) {
        const id = normalizeTerminalId(terminalId);
        const dir = path_1.default.posix.join(this.terminalRoot(), id);
        const script = `
dir=${shellQuote(dir)}
if [ ! -d "$dir" ]; then
  echo "Terminal not found: ${id}" >&2
  exit 2
fi
pid=$(cat "$dir/pid" 2>/dev/null || true)
if [ -z "$pid" ]; then
  echo "Terminal ${id} has no pid."
  exit 0
fi
if ! kill -0 "$pid" 2>/dev/null; then
  echo "Terminal ${id} is not running."
  exit 0
fi
kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
sleep 1
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
fi
echo "Kill signal sent to terminal ${id} (pid $pid)."
`;
        const result = await this.execRaw(script, DEFAULT_COMMAND_TIMEOUT_MS);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote terminal kill failed');
        }
        return result.stdout.trimEnd();
    }
    remotePath(relativePath) {
        const normalized = normalizeRelativePath(relativePath);
        if (path_1.default.posix.isAbsolute(normalized)) {
            const candidate = path_1.default.posix.normalize(normalized);
            if (candidate !== this.root && !candidate.startsWith(`${this.root}/`)) {
                throw new Error(`Path escapes remote workspace root: ${relativePath}`);
            }
            return candidate;
        }
        return path_1.default.posix.join(this.root, normalized === '.' ? '' : normalized);
    }
    sshArgs(privateKeyPath) {
        const args = [
            '-p',
            String(this.config.port || 22),
            '-o',
            'BatchMode=yes',
            '-o',
            `StrictHostKeyChecking=${this.config.strictHostKeyChecking === false ? 'accept-new' : 'yes'}`,
            '-o',
            'ConnectTimeout=10',
        ];
        const keyPath = privateKeyPath || this.config.privateKeyPath;
        if (keyPath) {
            args.push('-i', keyPath);
        }
        args.push(`${this.config.username}@${this.config.host}`, 'sh', '-lc');
        return args;
    }
    async execRaw(script, timeoutMs) {
        const tempKeyPath = this.config.privateKey ? writeTempPrivateKey(this.config.privateKey) : undefined;
        try {
            return await runProcess('ssh', [...this.sshArgs(tempKeyPath), script], { timeoutMs });
        }
        finally {
            if (tempKeyPath) {
                fs_1.default.rmSync(path_1.default.dirname(tempKeyPath), { recursive: true, force: true });
            }
        }
    }
    terminalRoot() {
        return path_1.default.posix.join(this.root, '.operator-chat', 'terminals');
    }
    async execManaged(command, workdir, timeoutMs) {
        const terminalId = (0, crypto_1.randomUUID)();
        const terminalDir = path_1.default.posix.join(this.terminalRoot(), terminalId);
        const commandBase64 = Buffer.from(command, 'utf8').toString('base64');
        const waitSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        const snapshotLines = DEFAULT_TERMINAL_TAIL_LINES;
        const snapshotBytes = DEFAULT_TERMINAL_MAX_BYTES;
        const script = `
set -u
dir=${shellQuote(terminalDir)}
mkdir -p "$dir"
printf '%s' ${shellQuote(commandBase64)} | base64 -d > "$dir/command"
cat > "$dir/run.sh" <<'__OPERATOR_CHAT_RUNNER__'
#!/bin/sh
cd -- "$1"
shift
exec sh -lc "$1"
__OPERATOR_CHAT_RUNNER__
chmod +x "$dir/run.sh"
setsid "$dir/run.sh" ${shellQuote(workdir)} "$(cat "$dir/command")" > "$dir/stdout" 2> "$dir/stderr" &
pid=$!
printf '%s' "$pid" > "$dir/pid"
start=$(date +%s)
while kill -0 "$pid" 2>/dev/null; do
  now=$(date +%s)
  elapsed=$((now - start))
  if [ "$elapsed" -ge ${waitSeconds} ]; then
    echo "__OPERATOR_CHAT_BACKGROUND__"
    echo "terminalId=${terminalId}"
    echo "pid=$pid"
    echo "status=running"
    echo "--- STDOUT ---"
    tail -n ${snapshotLines} "$dir/stdout" 2>/dev/null | tail -c ${snapshotBytes} || true
    echo "--- STDERR ---"
    tail -n ${snapshotLines} "$dir/stderr" 2>/dev/null | tail -c ${snapshotBytes} || true
    exit 124
  fi
  sleep 1
done
set +e
wait "$pid"
code=$?
set -e
printf '%s' "$code" > "$dir/exit_code"
echo "__OPERATOR_CHAT_COMPLETED__"
echo "terminalId=${terminalId}"
echo "pid=$pid"
echo "exitCode=$code"
echo "--- STDOUT ---"
tail -c ${MAX_COMMAND_OUTPUT_BYTES} "$dir/stdout" 2>/dev/null || true
echo "--- STDERR ---"
tail -c ${MAX_COMMAND_OUTPUT_BYTES} "$dir/stderr" 2>/dev/null || true
exit "$code"
`;
        const started = Date.now();
        const result = await this.execRaw(script, timeoutMs + 15_000);
        const parsed = parseManagedCommandOutput(result.stdout);
        if (parsed) {
            return {
                stdout: parsed.stdout,
                stderr: parsed.stderr,
                exitCode: parsed.status === 'running' ? null : parsed.exitCode,
                timedOut: parsed.status === 'running',
                durationMs: Date.now() - started,
                background: {
                    terminalId,
                    pid: parsed.pid,
                    status: parsed.status,
                },
            };
        }
        return result;
    }
}
exports.SshWorkspaceRuntime = SshWorkspaceRuntime;
class WorkspaceRuntimeFactory {
    sandboxManager;
    constructor(sandboxManager) {
        this.sandboxManager = sandboxManager;
    }
    createRemote(config) {
        if (!config?.ssh?.enabled) {
            throw new Error('Remote workspace is not configured. Configure an SSH host and key in Settings before using agent mode.');
        }
        return new SshWorkspaceRuntime(config.ssh);
    }
    create(context) {
        if (context.workspace?.type === 'ssh_remote' || context.workspace?.ssh?.enabled) {
            if (!context.workspace.ssh) {
                throw new Error('Missing SSH workspace configuration.');
            }
            return new SshWorkspaceRuntime(context.workspace.ssh);
        }
        return new LocalWorkspaceRuntime(this.sandboxManager, context.sandboxId);
    }
}
exports.WorkspaceRuntimeFactory = WorkspaceRuntimeFactory;
function runProcess(command, args, options) {
    const started = Date.now();
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)(command, args, {
            cwd: options.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (process.platform !== 'win32' && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                }
                catch {
                    child.kill('SIGTERM');
                }
            }
            else {
                child.kill('SIGTERM');
            }
            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 3000).unref();
        }, options.timeoutMs);
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            stdout = truncateOutput(stdout).value;
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
            stderr = truncateOutput(stderr).value;
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            const message = error.code === 'ENOENT' && command === 'ssh'
                ? 'SSH client executable was not found in the backend runtime. Install openssh-client in the backend image/host and rebuild/restart the backend container.'
                : error.message;
            resolve({
                stdout,
                stderr: stderr || message,
                exitCode: null,
                timedOut,
                durationMs: Date.now() - started,
            });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exitCode: code,
                timedOut,
                durationMs: Date.now() - started,
            });
        });
    });
}
function normalizeTerminalId(input) {
    const id = String(input || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('Invalid terminal id.');
    }
    return id;
}
function extractManagedSection(output, header, nextHeader) {
    const start = output.indexOf(header);
    if (start === -1) {
        return '';
    }
    const contentStart = start + header.length;
    const end = nextHeader ? output.indexOf(nextHeader, contentStart) : -1;
    return (end === -1 ? output.slice(contentStart) : output.slice(contentStart, end)).replace(/^\n/, '').trimEnd();
}
function parseManagedCommandOutput(output) {
    const marker = output.includes('__OPERATOR_CHAT_BACKGROUND__')
        ? '__OPERATOR_CHAT_BACKGROUND__'
        : output.includes('__OPERATOR_CHAT_COMPLETED__')
            ? '__OPERATOR_CHAT_COMPLETED__'
            : null;
    if (!marker) {
        return null;
    }
    const body = output.slice(output.indexOf(marker) + marker.length);
    const metadata = extractManagedSection(body, '\n', '--- STDOUT ---');
    const stdout = extractManagedSection(body, '--- STDOUT ---', '--- STDERR ---');
    const stderr = extractManagedSection(body, '--- STDERR ---');
    const values = new Map();
    for (const line of metadata.split('\n')) {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1)
            continue;
        values.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
    }
    const exitCodeValue = values.get('exitCode');
    const exitCode = exitCodeValue !== undefined ? Number(exitCodeValue) : null;
    return {
        status: marker === '__OPERATOR_CHAT_BACKGROUND__' ? 'running' : 'completed',
        terminalId: values.get('terminalId') || '',
        pid: values.get('pid') || '',
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        stdout,
        stderr,
    };
}
function writeTempPrivateKey(privateKey) {
    const dir = fs_1.default.mkdtempSync(path_1.default.join('/tmp', 'operator-chat-ssh-'));
    const file = path_1.default.join(dir, 'key');
    fs_1.default.writeFileSync(file, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    fs_1.default.chmodSync(file, 0o600);
    return file;
}
function formatReadOutput(filePath, content, options) {
    const offset = Math.max(1, Number(options.offset || 1));
    const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Number(options.limit || DEFAULT_READ_LIMIT)));
    const lines = content.split('\n');
    const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => {
        const text = line.length > MAX_READ_LINE_LENGTH ? `${line.slice(0, MAX_READ_LINE_LENGTH)}...` : line;
        return `${offset + index}: ${text}`;
    });
    const truncated = offset - 1 + limit < lines.length;
    return [
        filePath,
        'file',
        '',
        selected.join('\n'),
        truncated ? `\n(Output truncated. Use offset=${offset + limit} to continue.)` : '',
    ].join('\n').trimEnd();
}
function parsePatch(patchText) {
    const lines = patchText.replace(/\r\n/g, '\n').split('\n');
    const changes = [];
    let current = null;
    for (const line of lines) {
        if (line.startsWith('*** Add File: ')) {
            current = { type: 'add', path: line.slice('*** Add File: '.length).trim(), chunks: [] };
            changes.push(current);
            continue;
        }
        if (line.startsWith('*** Update File: ')) {
            current = { type: 'update', path: line.slice('*** Update File: '.length).trim(), chunks: [] };
            changes.push(current);
            continue;
        }
        if (line.startsWith('*** Delete File: ')) {
            current = { type: 'delete', path: line.slice('*** Delete File: '.length).trim(), chunks: [] };
            changes.push(current);
            continue;
        }
        if (line === '*** Begin Patch' || line === '*** End Patch' || line.startsWith('@@')) {
            continue;
        }
        if (current) {
            current.chunks.push(line);
        }
    }
    return changes;
}
function applyPatchChunks(oldContent, chunks) {
    const removed = chunks.filter((line) => line.startsWith('-')).map((line) => line.slice(1)).join('\n');
    const added = chunks.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
    if (!removed) {
        return added.endsWith('\n') ? added : `${added}\n`;
    }
    const replacement = added.endsWith('\n') ? added : `${added}\n`;
    return replaceExact(oldContent, removed.endsWith('\n') ? removed : `${removed}\n`, replacement);
}
//# sourceMappingURL=workspaceRuntime.js.map