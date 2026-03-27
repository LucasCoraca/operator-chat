# Tool Authoring Guide

This project does not yet load external tool addons. Today, a "new tool" means adding a new built-in entry to [backend/src/tools/index.ts](/home/lucas/Documents/chatinterface/backend/src/tools/index.ts).

This guide explains the exact contract the runtime expects and how approvals, tool selection, and sandbox policies interact with a tool implementation.

## The Tool Interface

The current tool type is:

```ts
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
  policy: ToolExecutionPolicy;
  execute: (args: Record<string, any>, sandboxId: string) => Promise<string>;
}
```

Every tool must return a `string`. That string becomes the observation the agent sees next.

That matters because:
- the model reasons over plain-text observations
- the frontend renders tool results from the string you return
- errors should usually be returned as readable text instead of thrown

## Where to Add a Tool

Add the tool inside `registerBuiltInTools()` in [backend/src/tools/index.ts](/home/lucas/Documents/chatinterface/backend/src/tools/index.ts).

Pattern:

```ts
this.tools.set('my_tool', {
  name: 'my_tool',
  description: 'What it does and when the model should use it.',
  parameters: {
    input: { type: 'string', description: 'Description of the argument' },
  },
  policy: {
    requiresApproval: false,
    supportsAutoApprove: true,
    capabilities: [],
    sandboxPolicy: 'none',
    riskLevel: 'low',
  },
  execute: async (args, sandboxId) => {
    const input = args.input as string;
    if (!input) {
      return 'Error: No input provided';
    }

    return `Processed: ${input}`;
  },
});
```

## Parameter Definitions

`parameters` are used in three places:
- they are shown to the model in the agent system prompt
- they are exposed through `GET /api/tools`
- they are converted into tool definitions by `getToolDefinitions()`

Keep them:
- small
- explicit
- easy for the model to satisfy

Prefer:

```ts
parameters: {
  url: { type: 'string', description: 'The full URL including https://' },
}
```

Avoid vague fields like:

```ts
parameters: {
  data: { type: 'string', description: 'Stuff to use somehow' },
}
```

## Policy Metadata

Every tool declares a `policy`.

```ts
export interface ToolExecutionPolicy {
  requiresApproval: boolean;
  supportsAutoApprove: boolean;
  capabilities: ToolCapability[];
  sandboxPolicy: ToolSandboxPolicy;
  riskLevel: 'low' | 'medium' | 'high';
}
```

### `requiresApproval`

If `true`, the agent pauses before execution unless approval is bypassed by:
- chat-level `alwaysApprove`
- per-tool `autoApprove`

Use `true` for tools that:
- write files
- delete files
- run code
- browse arbitrary sites
- perform network or process actions with side effects

### `supportsAutoApprove`

If `true`, the user can choose "Always approve" for that tool in a chat.

Set this to `false` for high-risk tools where repeated silent execution would be unsafe. In the current codebase, `file_delete` is the clearest example.

### `capabilities`

Current capability tags:

- `filesystem`
- `network`
- `process`
- `browser`
- `read_chat`
- `write_chat`

These tags are metadata today. They drive UI labels and policy description. They are the right place to encode the tool's intent even if hard enforcement is still limited.

### `sandboxPolicy`

Current sandbox policy values:

- `none`
- `chat_fs_only`
- `isolated_process`
- `browser_isolated`

Choose the smallest honest scope:

- `none`
  For pure in-memory tools like `calculator`.
- `chat_fs_only`
  For tools that should only touch the current chat sandbox.
- `isolated_process`
  For subprocess/code execution like `python_execute`.
- `browser_isolated`
  For browser/network page inspection tools like `browser_visit`.

### `riskLevel`

Use:
- `low` for read-only or pure tools
- `medium` for tools with bounded side effects
- `high` for destructive or code-execution tools

This value is shown in the UI and should match reality.

## How Approval Actually Works

Approval is enforced in [backend/src/agent/ReActAgent.ts](/home/lucas/Documents/chatinterface/backend/src/agent/ReActAgent.ts).

Flow:
1. The model emits a `<tool_call>`.
2. The agent looks up the tool policy.
3. If `requiresApproval` is false, execution proceeds.
4. If `requiresApproval` is true, execution pauses unless bypassed.
5. The backend emits `tool-approval-required`.
6. The user may deny, approve once, or approve and remember.
7. If approved, the tool executes.
8. If denied, the denial becomes an observation and the model continues.

As a tool author, you do not implement approval handling yourself. You only declare honest policy metadata.

## Tool Preferences and Availability

The tool picker in the UI is driven by `GET /api/tools`, which returns the registry entries.

Per chat, the backend stores:

```ts
type ChatToolPreference = {
  enabled: boolean;
  autoApprove: boolean;
};
```

This means:
- a tool can exist globally but be disabled in one chat
- a tool can require approval globally but be remembered as auto-approved for one chat

Your tool should not try to inspect that state itself. The registry and agent already do it.

## Writing Good Tool Descriptions

The description is part of the model prompt. It should tell the model:
- what the tool does
- when to use it
- what not to use it for if that matters

Good:

```ts
description: 'Visit a website and extract its content. First call without startChar/endChar to get page structure, then read only the relevant section.'
```

Bad:

```ts
description: 'Website tool.'
```

## Returning Results

The agent consumes your return value as plain text. Good return values are:
- readable
- direct
- structured enough for the model to reason over

Prefer:

```ts
return `Contents of ${dirPath || '/'}:\n${items.join('\n')}`;
```

Instead of:

```ts
return JSON.stringify(items);
```

Return errors as text unless the failure should abort the whole turn:

```ts
return `Error reading file: ${error}`;
```

That lets the model recover and choose a different action.

## Sandbox Rules

Tool authors are responsible for using the sandbox correctly.

For filesystem work:
- always operate relative to `sandboxId`
- use [backend/src/services/sandboxManager.ts](/home/lucas/Documents/chatinterface/backend/src/services/sandboxManager.ts)
- do not access arbitrary host paths

For subprocess work:
- use the chat sandbox as `cwd`
- pass only the environment variables you actually need
- use timeouts

The current system is not a full container runtime. Be conservative.

## Example: Read-Only Tool

```ts
this.tools.set('word_count', {
  name: 'word_count',
  description: 'Count words in a text string. Use this for lightweight text analysis.',
  parameters: {
    text: { type: 'string', description: 'The text to analyze' },
  },
  policy: {
    requiresApproval: false,
    supportsAutoApprove: true,
    capabilities: [],
    sandboxPolicy: 'none',
    riskLevel: 'low',
  },
  execute: async (args) => {
    const text = args.text as string;
    if (!text) {
      return 'Error: No text provided';
    }

    const count = text.trim().split(/\s+/).filter(Boolean).length;
    return `Word count: ${count}`;
  },
});
```

## Example: Sandbox File Writer

```ts
this.tools.set('append_file', {
  name: 'append_file',
  description: 'Append text to a file in the chat sandbox.',
  parameters: {
    path: { type: 'string', description: 'Path relative to sandbox root' },
    content: { type: 'string', description: 'Text to append' },
  },
  policy: {
    requiresApproval: true,
    supportsAutoApprove: true,
    capabilities: ['filesystem'],
    sandboxPolicy: 'chat_fs_only',
    riskLevel: 'medium',
  },
  execute: async (args, sandboxId) => {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath) {
      return 'Error: No file path provided';
    }

    const existing = await this.sandboxManager.readFileAsync(sandboxId, filePath).catch(() => '');
    this.sandboxManager.writeFile(sandboxId, filePath, `${existing}${content}`);
    return `Appended ${content.length} bytes to ${filePath}`;
  },
});
```

## Checklist Before Adding a Tool

- Pick a unique `name`.
- Write a description the model can actually follow.
- Keep parameter names and descriptions precise.
- Set honest policy metadata.
- Use the sandbox manager for filesystem access.
- Add timeouts for subprocess or network work.
- Return readable text observations.
- Return recoverable errors as strings.
- Run a backend build after the change.

## Testing a New Tool

Minimum checks:
- `GET /api/tools` returns the tool
- the tool appears in the frontend tool picker
- the tool can be enabled and disabled per chat
- approval prompts appear only when expected
- denied execution returns a useful observation
- successful execution returns a useful observation

Build command:

```bash
cd backend
npm run build
```

If the tool affects frontend rendering or approval UI, also run:

```bash
cd frontend
npm run build
```

## Future Addon System

There has been discussion about turning tools into addons/plugins. That is not implemented yet.

If and when that happens, the safest migration path is:
1. keep the existing `Tool` contract
2. move each built-in tool into its own module
3. add a loader on top
4. preserve the current policy and approval model

Until then, treat this document as the source of truth for adding built-in tools to the current system.
