---
name: delegate-notion
description: Search pages, create/update pages, and create database entries via the workspace Notion integration
---

# Notion Integration

Access the workspace's connected Notion via the Delegate integration proxy. Credentials stay
server-side — send intent plus `taskId` (or `workspaceId`) and Delegate resolves the stored token.

All requests require:
```
-H "Authorization: Bearer $DELEGATE_API_TOKEN"
-H "Content-Type: application/json"
```

**Important**: Notion actions are project-scoped. The task's project must have a Notion database
connection configured in Settings → Connections. Pass `taskId` so the proxy can resolve the allowed
databases for that project. Actions will fail with a clear error if no Notion connection exists.

---

## Search Pages

Search pages (and optionally databases) visible to the workspace integration. Results are
automatically filtered to databases connected to the task's project.

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/notion/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "query": "project plan"
  }'
```

Optional parameters:
- `query` — search string (empty string returns all results)
- `filter` — Notion filter object, e.g. `{"property":"object","value":"page"}`

---

## Get Page

Fetch a single page by its Notion page ID. Does not require a project database connection.

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/notion/get-page" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "pageId": "PAGE_ID"
  }'
```

---

## Create Page

Create a new page as a child of an existing page or as a row in a connected database.

**Under a parent page:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/notion/create-page" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "parentId": "PARENT_PAGE_ID",
    "parentType": "page",
    "title": "Meeting Notes — 2026-03-29",
    "content": "Summary of discussion..."
  }'
```

**As a row in a connected database:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/notion/create-page" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "parentId": "DATABASE_ID",
    "parentType": "database",
    "properties": {
      "Name": { "title": [{ "text": { "content": "New Row Title" } }] },
      "Status": { "select": { "name": "In Progress" } }
    },
    "content": "Optional page body text"
  }'
```

Parameters:
- `parentId` — Notion page ID or database ID
- `parentType` — `"page"` (default) or `"database"`
- `title` — Page title (used when `parentType` is `"page"` or properties omit the title)
- `properties` — Notion property map (required for database rows; optional for pages)
- `content` — Body text or Notion block array

---

## Create Database Entry

Add a row directly to a connected Notion database with full property control.
The `databaseId` must be one of the databases connected to the task's project.

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/notion/create-database-entry" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "databaseId": "DATABASE_ID",
    "properties": {
      "Name":   { "title":  [{ "text": { "content": "Sprint task" } }] },
      "Status": { "select": { "name": "Todo" } },
      "Due":    { "date":   { "start": "2026-04-15" } },
      "Owner":  { "people": [{ "id": "NOTION_USER_ID" }] }
    }
  }'
```

Parameters:
- `databaseId` — must be connected to the task's project
- `properties` — full Notion property map for the new row

---

## Update Page

Update properties or archive an existing page.

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/notion/update-page" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "pageId": "PAGE_ID",
    "properties": {
      "Status": { "select": { "name": "Done" } }
    }
  }'
```

Archive a page:
```bash
  -d '{
    "taskId": "TASK_ID",
    "pageId": "PAGE_ID",
    "archived": true
  }'
```

Parameters:
- `pageId` — Notion page (or database row) ID
- `properties` — Notion property map to update (partial update — omitted fields unchanged)
- `archived` — `true` to archive (soft-delete) the page

---

## Notes

- **Action names use hyphens**: `create-page`, `update-page`, `get-page`, `create-database-entry`
  (not underscores — this is intentional and differs from other providers).
- **Database scoping**: `create-page` with `parentType: "database"` and `create-database-entry`
  both enforce that the target database is connected to the task's project. You will get an
  error listing the allowed database IDs if the target is not connected.
- **query_database** is not currently implemented. To read rows from a database, use `search`
  with a `filter` scoped to the database's pages.
- `taskId` is the recommended context resolver. Pass `workspaceId` only when there is no task.
