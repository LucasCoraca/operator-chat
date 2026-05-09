// Mock data for the agent console.

const tasks = [
  { id: 't1', title: 'Set up logistics-app dev env', status: 'running', preview: 'Generating JWT_SECRET and restarting backend…', updated: 'now', unread: true },
  { id: 't2', title: 'Debug auth flow on driver-app', status: 'idle', preview: 'Awaiting your decision on token refresh strategy.', updated: '4m' },
  { id: 't3', title: 'Generate seed data for orders table', status: 'done', preview: 'Wrote 240 rows · 3 fixtures committed.', updated: '12m' },
  { id: 't4', title: 'Profile cold-start latency on /dispatch', status: 'failed', preview: 'Could not bind port 3001 — see logs.', updated: '38m' },
  { id: 't5', title: 'Refactor courier matching scoring', status: 'done', preview: 'Reduced p95 from 410ms to 180ms.', updated: '1h' },
  { id: 't6', title: 'Write tests for pricing surge logic', status: 'idle', preview: '4 of 7 cases drafted.', updated: '2h' },
  { id: 't7', title: 'Migrate logging to OpenTelemetry', status: 'done', preview: 'Spans flowing to collector.', updated: '3h' },
  { id: 't8', title: 'Investigate stale cache on map tiles', status: 'idle', preview: 'Reproducing on staging…', updated: 'Yesterday' },
  { id: 't9', title: 'Quick story about a courier robot', status: 'done', preview: 'Drafted, 320 words.', updated: 'Yesterday' },
];

// The active conversation. Each turn is one of:
//   user      — operator message
//   thought   — agent reasoning
//   tool      — tool/shell invocation with output
//   system    — system reminder
const conversation = [
  {
    type: 'user',
    at: '14:02',
    body: 'Please create a logistics-app dev script that boots the backend, admin dashboard, driver app, and customer app in one go. It should be safe to re-run.',
  },
  {
    type: 'thought',
    at: '14:02',
    body: 'I\'ll write a script that kills any existing processes on the target ports, verifies the toolchain, then starts each service in the right order. The backend needs to be healthy before the apps come up.',
  },
  {
    type: 'tool',
    name: 'shell',
    cmd: 'lsof -ti:3000,3001,5173,8081 | xargs -r kill -9',
    status: 'ok',
    duration: '0.3s',
    output: [
      { kind: 'log', text: 'No processes on target ports' },
    ],
  },
  {
    type: 'tool',
    name: 'shell',
    cmd: 'cd /home/operator/projects/logistics-app && ./scripts/dev.sh',
    status: 'fail',
    duration: '12.4s',
    truncated: '4 more lines',
    output: [
      { kind: 'meta', text: '[showing last 15 of 19 lines]' },
      { kind: 'ok',   text: '✓ Node.js v20.20.2 found' },
      { kind: 'ok',   text: '✓ npm 10.8.2 found' },
      { kind: 'ok',   text: '✓ backend dependencies already installed' },
      { kind: 'ok',   text: '✓ admin-dashboard dependencies already installed' },
      { kind: 'ok',   text: '✓ driver-app dependencies already installed' },
      { kind: 'ok',   text: '✓ customer-app dependencies already installed' },
      { kind: 'rule', text: '' },
      { kind: 'log',  text: 'Starting Backend (port 3000)…' },
      { kind: 'rule', text: '' },
      { kind: 'log',  text: '  Backend PID: 1499' },
      { kind: 'log',  text: '' },
      { kind: 'log',  text: 'Waiting for backend to be healthy…' },
      { kind: 'log',  text: 'DONE WAITING' },
      { kind: 'err',  text: 'FATAL: JWT_SECRET environment variable must be set to a secure random value (not the default).' },
    ],
  },
  {
    type: 'thought',
    at: '14:03',
    body: 'The backend rejects the default JWT_SECRET. I\'ll update the script to generate a cryptographically random secret on first run and persist it to a gitignored .env.local — then re-run cleanly.',
  },
  {
    type: 'tool',
    name: 'shell',
    cmd: 'pkill -f "node src/index.js"; pkill -f "vite"; pkill -f "expo start"',
    status: 'running',
    duration: null,
    output: [
      { kind: 'log', text: 'Cleaning up dev processes…' },
    ],
  },
];

window.AppData = { tasks, conversation };
