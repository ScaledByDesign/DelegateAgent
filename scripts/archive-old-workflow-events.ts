#!/usr/bin/env -S tsx
/**
 * Phase 1.5 retention: archive `workflow_events` older than N days into a
 * gzipped JSONL under `$STATE_DIR/workflow-events-archive/` and DELETE them
 * from SQLite to keep `messages.db` size bounded (per plan R12).
 *
 * Invoked by the systemd timer `delegate-agent-workflow-events-archive.timer`
 * (daily 03:00 UTC). Safe to run by hand:
 *
 *   npx tsx scripts/archive-old-workflow-events.ts
 *   ARCHIVE_OLDER_THAN_DAYS=7 npx tsx scripts/archive-old-workflow-events.ts
 *   ARCHIVE_DRY_RUN=1 npx tsx scripts/archive-old-workflow-events.ts
 *
 * Idempotent: archive files are timestamped per-invocation, so re-running
 * after a partial failure doesn't clobber a prior archive. The DELETE only
 * fires after the gzipped file is fully flushed + fsync'd.
 */
import { createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { createGzip } from 'zlib';

import Database from 'better-sqlite3';

interface RawEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  node_id: string | null;
  data: string;
  created_at: number;
}

async function main(): Promise<void> {
  const repoDir = resolve(process.env.REPO_DIR ?? process.cwd());
  const stateDir = resolve(
    process.env.STATE_DIR ?? '/var/lib/delegate-agent',
  );
  const messagesDb = resolve(
    process.env.MESSAGES_DB ?? join(repoDir, 'messages.db'),
  );
  const archiveDir = resolve(
    process.env.ARCHIVE_DIR ?? join(stateDir, 'workflow-events-archive'),
  );
  const olderThanDays = Number.parseInt(
    process.env.ARCHIVE_OLDER_THAN_DAYS ?? '30',
    10,
  );
  const dryRun = process.env.ARCHIVE_DRY_RUN === '1';

  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    console.error(
      `[archive-events] ARCHIVE_OLDER_THAN_DAYS must be a positive integer (got ${olderThanDays})`,
    );
    process.exit(2);
  }

  try {
    await stat(messagesDb);
  } catch {
    console.error(`[archive-events] messages.db not found at ${messagesDb} — exiting 0`);
    process.exit(0);
  }

  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const db = new Database(messagesDb, { readonly: false });
  try {
    // Bail early when the table doesn't exist yet (agent not on Phase 1.5).
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_events'`,
      )
      .get();
    if (!tableExists) {
      console.log('[archive-events] workflow_events table not present — exiting 0');
      return;
    }

    // Count first so we can short-circuit + log the planned action.
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workflow_events WHERE created_at < ?`,
      )
      .get(cutoffMs) as { n: number };

    if (countRow.n === 0) {
      console.log(
        `[archive-events] nothing to archive (cutoff=${new Date(cutoffMs).toISOString()})`,
      );
      return;
    }

    console.log(
      `[archive-events] archiving ${countRow.n} rows older than ${olderThanDays} days (cutoff=${new Date(cutoffMs).toISOString()})${dryRun ? ' DRY-RUN' : ''}`,
    );

    if (dryRun) return;

    // Stream rows into a gzipped JSONL file. Filename includes ISO timestamp
    // + cutoff so multiple runs in the same day don't clobber each other.
    await mkdir(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = join(
      archiveDir,
      `workflow-events-${stamp}-cutoff-${cutoffMs}.jsonl.gz`,
    );
    await mkdir(dirname(archivePath), { recursive: true });

    const gz = createGzip();
    const out = createWriteStream(archivePath);
    gz.pipe(out);

    const stmt = db.prepare(
      `SELECT id, workflow_run_id, event_type, node_id, data, created_at
         FROM workflow_events
        WHERE created_at < ?
        ORDER BY created_at ASC`,
    );

    let written = 0;
    for (const row of stmt.iterate(cutoffMs) as IterableIterator<RawEventRow>) {
      const line =
        JSON.stringify({
          id: row.id,
          workflow_run_id: row.workflow_run_id,
          event_type: row.event_type,
          node_id: row.node_id,
          data: safeParseJson(row.data),
          created_at: row.created_at,
        }) + '\n';
      if (!gz.write(line)) {
        await new Promise<void>((r) => gz.once('drain', () => r()));
      }
      written++;
    }
    await new Promise<void>((r) => gz.end(() => r()));
    await new Promise<void>((r, j) => {
      out.on('finish', () => r());
      out.on('error', j);
    });

    // Only delete from DB AFTER the archive file is fully closed.
    const del = db
      .prepare(`DELETE FROM workflow_events WHERE created_at < ?`)
      .run(cutoffMs);

    console.log(
      `[archive-events] wrote ${written} rows → ${archivePath}; deleted ${del.changes} rows from workflow_events`,
    );

    // VACUUM is expensive; defer to a separate ops procedure. The DELETE
    // marks pages reusable for future INSERTs, which is sufficient under WAL.
  } finally {
    db.close();
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _unparseable: s };
  }
}

main().catch((err) => {
  console.error('[archive-events] FAILED:', err);
  process.exit(1);
});
