/**
 * Abuse reports on shared games (SPEC §5 — public content moderation).
 *
 * A report is filed from the public play page (anonymous allowed) and read only by an admin (§4.10).
 * Two backends behind one small interface, same as the project store: Supabase's `play_reports` in
 * production, a local JSON table in dev — so the moderation queue is exercisable before any vendor
 * account exists.
 *
 * Spam control is deliberately cheap and best-effort: a short per-share cooldown held in process
 * memory. It is NOT a security control (a multi-instance deploy has one window per instance, and a
 * determined abuser rotates ids) — it just stops a stuck "Report" button or a bored kid from filling
 * the table in one sitting. The real backstop is that the queue is admin-curated and a share can be
 * unpublished in one click.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { isSupabaseConfigured, createAdminClient } from '~/lib/.server/supabase/client';

const logger = createScopedLogger('share.reports');

export interface PlayReport {
  id: string;
  projectId: string;
  shareId: string;
  reason?: string;
  reporterId?: string;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: string;
}

export interface FileReportInput {
  projectId: string;
  shareId: string;
  reason?: string;
  reporterId?: string;
}

/** Best-effort per-share cooldown. Cleared on restart; that is fine for what it defends against. */
const COOLDOWN_MS = 10_000;
const lastReportAt = new Map<string, number>();

function withinCooldown(shareId: string, now: number): boolean {
  const last = lastReportAt.get(shareId);

  if (last !== undefined && now - last < COOLDOWN_MS) {
    return true;
  }

  lastReportAt.set(shareId, now);

  return false;
}

export async function fileReport(input: FileReportInput, context?: unknown, now = Date.now()): Promise<void> {
  if (withinCooldown(input.shareId, now)) {
    logger.debug(`Report for ${input.shareId} dropped (cooldown).`);
    return;
  }

  if (isSupabaseConfigured(context)) {
    const db = await createAdminClient(context);
    const { error } = await db.from('play_reports').insert({
      project_id: input.projectId,
      share_id: input.shareId,
      reason: input.reason ?? null,
      reporter_id: input.reporterId ?? null,
    });

    if (error) {
      logger.error(`Failed to file report: ${error.message}`);
    }

    return;
  }

  await fsFileReport(input);
}

export async function listOpenReports(context?: unknown, limit = 100): Promise<PlayReport[]> {
  if (isSupabaseConfigured(context)) {
    const db = await createAdminClient(context);
    const { data } = await db
      .from('play_reports')
      .select()
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);

    return (data ?? []).map(rowToReport);
  }

  const rows = await fsAllReports();

  return rows
    .filter((r) => r.status === 'open')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export async function resolveReport(id: string, status: 'actioned' | 'dismissed', context?: unknown): Promise<void> {
  if (isSupabaseConfigured(context)) {
    const db = await createAdminClient(context);
    await db.from('play_reports').update({ status }).eq('id', id);

    return;
  }

  await fsResolveReport(id, status);
}

/*
 * --------------------------------------------------------------------------------------------
 * Filesystem backend
 * ------------------------------------------------------------------------------------------
 */

function reportsDir(): string {
  return path.join(platformDataDir(), 'play_reports');
}

function newId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `rpt_${stamp}_${Math.random().toString(36).slice(2, 10)}`;
}

async function fsFileReport(input: FileReportInput): Promise<void> {
  const dir = reportsDir();
  await fs.mkdir(dir, { recursive: true });

  const report: PlayReport = {
    id: newId(),
    projectId: input.projectId,
    shareId: input.shareId,
    reason: input.reason,
    reporterId: input.reporterId,
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, `${report.id}.json`), JSON.stringify(report, null, 2), 'utf8');
}

async function fsAllReports(): Promise<PlayReport[]> {
  let names: string[];

  try {
    names = await fs.readdir(reportsDir());
  } catch {
    return [];
  }

  const rows: PlayReport[] = [];

  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      rows.push(JSON.parse(await fs.readFile(path.join(reportsDir(), name), 'utf8')) as PlayReport);
    } catch {
      // Skip an unreadable row rather than fail the whole queue.
    }
  }

  return rows;
}

async function fsResolveReport(id: string, status: 'actioned' | 'dismissed'): Promise<void> {
  const file = path.join(reportsDir(), `${id}.json`);

  try {
    const report = JSON.parse(await fs.readFile(file, 'utf8')) as PlayReport;
    report.status = status;
    await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    // Already gone.
  }
}

function rowToReport(row: Record<string, any>): PlayReport {
  return {
    id: row.id,
    projectId: row.project_id,
    shareId: row.share_id,
    reason: row.reason ?? undefined,
    reporterId: row.reporter_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}
