---
name: delegate-plugins
description: Create, install, and manage WebOS plugins — sandboxed iframe apps with Delegate SDK access
---

# Delegate Plugins

WebOS plugins are self-contained HTML pages that run inside resizable windows on the Delegate desktop. They communicate with the workspace via a postMessage-based SDK that is inlined directly in the HTML — no external script dependencies.

All API endpoints require: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`

---

## Plugin CRUD

### List installed plugins
```bash
curl -G $DELEGATE_URL/api/plugins \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=WORKSPACE_ID"
```

### Install a plugin
```bash
curl -X POST $DELEGATE_URL/api/plugins \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Plugin",
    "slug": "my-org.my-plugin",
    "description": "What the plugin does",
    "entrypointUrl": "/plugins/my-plugin/index.html",
    "icon": "Puzzle",
    "category": "tools",
    "permissions": ["tasks:read", "storage:read", "storage:write"],
    "workspaceId": "WORKSPACE_ID",
    "defaultWidth": 600,
    "defaultHeight": 400,
    "singleton": true
  }'
```

### Update a plugin
```bash
curl -X PUT $DELEGATE_URL/api/plugins/PLUGIN_ID \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Uninstall a plugin
```bash
curl -X DELETE $DELEGATE_URL/api/plugins/PLUGIN_ID \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

### Plugin storage (key-value, per-plugin, persistent)
```bash
# Write
curl -X PUT $DELEGATE_URL/api/plugins/PLUGIN_ID/storage \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "config", "value": {"theme": "dark"}}'

# Read
curl -G $DELEGATE_URL/api/plugins/PLUGIN_ID/storage \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "key=config"
```

---

## Plugin Development Workflow

1. Create the HTML file at `public/plugins/<slug>/index.html`
2. Install via `POST /api/plugins` with `"entrypointUrl": "/plugins/<slug>/index.html"`
3. The plugin appears in the Plugin Manager and can be opened as a window
4. Use `"source": "dev"` in the install payload to tag development plugins

---

## HTML Template (inline SDK, copy-paste ready)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Plugin Name</title>
  <style>
    /* Delegate dark theme */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      background: #131110; color: #ece9e6;
      padding: 16px; min-height: 100vh;
    }
    .card { background: #1b1917; border: 1px solid #2a2725; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
    .label { font-size: 11px; color: #8d8785; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .metric { font-size: 26px; font-weight: 700; color: #ece9e6; }
    .grid { display: grid; gap: 12px; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
    h1 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #ece9e6; }
    h2 { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: #ece9e6; }
    .loading { display: flex; align-items: center; justify-content: center; height: 100vh; color: #8d8785; font-size: 13px; }
    .error { color: #ef4444; padding: 10px 12px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 8px; font-size: 13px; }
    .btn { background: #1b1917; border: 1px solid #2a2725; color: #8d8785; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.15s; }
    .btn:hover { background: #231f1e; color: #ece9e6; }
    .btn-primary { background: #ff6600; border-color: #ff6600; color: white; }
    .btn-primary:hover { background: #e65c00; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #8d8785; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 10px; border-bottom: 1px solid #2a2725; }
    td { padding: 7px 10px; border-bottom: 1px solid #1f1c1b; color: #ece9e6; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 9999px; font-size: 10px; font-weight: 600; }
    .badge-green { background: rgba(34,197,94,0.12); color: #22c55e; }
    .badge-yellow { background: rgba(250,204,21,0.12); color: #facc15; }
    .badge-red { background: rgba(239,68,68,0.12); color: #ef4444; }
    .badge-blue { background: rgba(59,130,246,0.12); color: #3b82f6; }
    .badge-orange { background: rgba(255,102,0,0.12); color: #ff6600; }
  </style>
</head>
<body>
  <div id="app" class="loading">Loading...</div>
  <script>
    // ── Delegate Plugin SDK (inline) ──────────────────────────────────────────
    const pendingRequests = new Map();
    const eventListeners = new Map();
    let initContext = null, initResolver = null;

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m?.type?.startsWith('delegate:')) return;
      if (m.type === 'delegate:init') {
        initContext = m.payload;
        initResolver?.(initContext);
      } else if (m.type === 'delegate:response') {
        const h = pendingRequests.get(m.requestId);
        if (!h) return;
        pendingRequests.delete(m.requestId);
        m.error
          ? h.reject(new Error(`[${m.error.code}] ${m.error.message}`))
          : h.resolve(m.payload);
      } else if (m.type === 'delegate:event') {
        eventListeners.get(m.action)?.forEach(fn => fn(m.payload));
      }
    });

    window.parent.postMessage({ type: 'delegate:ready' }, '*');

    function request(action, payload) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingRequests.set(id, { resolve, reject });
        window.parent.postMessage({ type: 'delegate:request', requestId: id, action, payload }, '*');
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error('Request timeout'));
          }
        }, 30000);
      });
    }

    const delegate = {
      tasks:    { list: (f) => request('tasks.list', f), get: (id) => request('tasks.get', { id }), create: (d) => request('tasks.create', d), update: (id, d) => request('tasks.update', { id, ...d }) },
      contacts: { list: (f) => request('contacts.list', f), search: (q) => request('contacts.search', { query: q }) },
      meetings: { list: (f) => request('meetings.list', f) },
      knowledge:{ list: (f) => request('knowledge.list', f), create: (d) => request('knowledge.create', d) },
      projects: { list: () => request('projects.list'), get: (id) => request('projects.get', { id }) },
      storage:  { get: (k) => request('storage.get', { key: k }), set: (k, v) => request('storage.set', { key: k, value: v }), delete: (k) => request('storage.delete', { key: k }), list: () => request('storage.list') },
      ui:       { showToast: (m, t) => request('ui.showToast', { message: m, type: t }), setTitle: (t) => request('ui.setTitle', { title: t }), openApp: (id) => request('ui.openApp', { appId: id }), getTheme: () => request('ui.getTheme') },
      ai:       { complete: (p, o) => request('ai.complete', { prompt: p, ...o }) },
      events:   { on: (e, h) => { if (!eventListeners.has(e)) eventListeners.set(e, new Set()); eventListeners.get(e).add(h); }, off: (e, h) => eventListeners.get(e)?.delete(h) },
    };

    function onInit(handler) {
      if (initContext) handler(initContext);
      else initResolver = handler;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Plugin Logic ──
    onInit(async (ctx) => {
      try {
        delegate.ui.setTitle('My Plugin');

        // Fetch data
        const tasks = await delegate.tasks.list();

        // Render
        const app = document.getElementById('app');
        app.className = '';
        app.innerHTML = `
          <h1>My Plugin</h1>
          <div class="grid grid-2">
            <div class="card">
              <div class="label">Total Tasks</div>
              <div class="metric">${tasks.length}</div>
            </div>
          </div>
        `;
      } catch (err) {
        document.getElementById('app').innerHTML =
          '<div class="error">' + err.message + '</div>';
      }
    });
  </script>
</body>
</html>
```

---

## SDK Reference

### Tasks
```javascript
delegate.tasks.list(filter?)                  // filter: { status, priority, projectId }
delegate.tasks.get(id)
delegate.tasks.create({ title, priority, status, projectId, description })
delegate.tasks.update(id, { status, priority, title, description })
```

### Contacts
```javascript
delegate.contacts.list(filter?)
delegate.contacts.search(query)               // Returns matching contacts
```

### Meetings
```javascript
delegate.meetings.list(filter?)
```

### Knowledge
```javascript
delegate.knowledge.list(filter?)
delegate.knowledge.create({ title, content, type })
```

### Projects
```javascript
delegate.projects.list()
delegate.projects.get(id)
```

### Plugin Storage (persistent, scoped to this plugin)
```javascript
await delegate.storage.set('key', value)      // value can be any JSON
await delegate.storage.get('key')             // returns value or null
await delegate.storage.delete('key')
await delegate.storage.list()                 // returns all { key, value } pairs
```

### UI
```javascript
delegate.ui.showToast('Saved!', 'success')    // type: success | error | info
delegate.ui.setTitle('My Plugin – Ready')
delegate.ui.openApp('tasks')                  // Open another WebOS app
const { theme, accent } = await delegate.ui.getTheme()
```

### AI Completion
```javascript
const result = await delegate.ai.complete('Summarize this task list', {
  model: 'claude-3-5-haiku-20241022',  // optional
  maxTokens: 500,                       // optional
});
// result.text — the completion string
```
Note: AI completions are billed to the workspace's AI usage.

### Events
```javascript
delegate.events.on('task.updated', (task) => { /* ... */ });
delegate.events.on('task.created', (task) => { /* ... */ });
delegate.events.on('theme.changed', ({ theme }) => { /* ... */ });
delegate.events.off('task.updated', handler);
```

---

## Permissions

Request only what the plugin uses. Unused permissions are rejected at install time.

| Permission | What it grants |
|------------|---------------|
| `tasks:read` | Read tasks, subtasks, comments |
| `tasks:write` | Create and update tasks |
| `contacts:read` | Read contacts |
| `contacts:write` | Create and update contacts |
| `meetings:read` | Read meetings and action items |
| `meetings:write` | Create and update meetings |
| `knowledge:read` | Read knowledge entries |
| `knowledge:write` | Create knowledge entries |
| `projects:read` | Read projects |
| `projects:write` | Create and update projects |
| `workspace:read` | Read workspace metadata |
| `storage:read` | Read plugin storage |
| `storage:write` | Write plugin storage |
| `events:subscribe` | Subscribe to workspace events |
| `ai:complete` | Call AI completion (billed to workspace) |

---

## Icon Names (Lucide)

Common choices: `Puzzle`, `BarChart3`, `StickyNote`, `Search`, `Bot`, `Zap`, `Globe`, `Terminal`, `Code2`, `Database`, `Brain`, `Activity`, `Layers`, `Settings`, `Star`, `Heart`, `Bell`, `Shield`, `Target`, `Rocket`, `Calendar`, `Mail`, `Users`, `FileText`, `Lightbulb`, `Palette`, `Clock`, `Camera`

---

## Design Guidelines

Use the Delegate dark theme. Do not invent custom color schemes.

| Role | Value |
|------|-------|
| Page background | `#131110` |
| Card background | `#1b1917` |
| Border | `#2a2725` |
| Primary text | `#ece9e6` |
| Secondary text / muted | `#8d8785` |
| Accent (primary action) | `#ff6600` |
| Accent hover | `#e65c00` |
| Success | `#22c55e` |
| Warning | `#facc15` |
| Error | `#ef4444` |

---

## Example Plugin Recipes

### Task Statistics Dashboard
```
permissions: ["tasks:read"]
icon: "BarChart3"
```
Show task counts by status and priority using `.grid-2` / `.grid-3` cards with `.metric` values.

### Contact Directory
```
permissions: ["contacts:read"]
icon: "Users"
```
Render a searchable `<table>` of contacts. Use an `<input>` to filter rows client-side.

### Meeting Prep Checklist
```
permissions: ["meetings:read", "tasks:read", "tasks:write"]
icon: "Calendar"
```
List upcoming meetings. For each, let the user create linked prep tasks via `delegate.tasks.create`.

### Project Progress Tracker
```
permissions: ["projects:read", "tasks:read"]
icon: "Target"
```
Per-project progress bars: count `DONE` tasks vs. total, render as `<div>` width percentage.

### AI Notes Summariser
```
permissions: ["knowledge:read", "ai:complete"]
icon: "Brain"
```
Pull knowledge entries, pipe content through `delegate.ai.complete`, display summary.

---

## Rules

1. **Inline the SDK** — copy the SDK block verbatim. Never load it from an external URL.
2. **Use `onInit`** — all initialization goes inside `onInit(async (ctx) => { ... })`.
3. **Handle errors** — every `await` call must be inside a `try/catch`. Show an `.error` div on failure.
4. **Request minimum permissions** — only list permissions you actually call in code.
5. **No external CDNs** — no `<script src="https://...">`, no remote CSS. Inline everything.
6. **Dark theme only** — use the color table above. Do not use white backgrounds or light text on light backgrounds.
7. **Keep it lean** — no React, Vue, or bundled frameworks. Vanilla JS + the inline SDK only.
