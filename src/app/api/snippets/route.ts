/**
 * /api/snippets — live templates for the SQL editor (docs/roadmap.md M10).
 *
 * Shaped like /api/saved: GET lists, POST upserts so "new" and "edit" are one
 * call, and DELETE takes the id as a query parameter. Owner-scoped in the repo,
 * so nothing here has to remember to filter.
 */

import { snippetsRepo } from '@/server/store/db';
import {
  asRecord,
  badRequest,
  handle,
  optionalString,
  readJson,
  requireString,
} from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface SnippetWire {
  id: string;
  prefix: string;
  label: string;
  body: string;
  engines: string[];
  updated_at: number;
}

export async function GET(): Promise<Response> {
  return handle(() => ({ snippets: snippetsRepo.list().map(toWire) }));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const prefix = requireString(body, 'prefix').trim();
    // The prefix is what you type to summon the snippet, so it has to be one
    // word — a prefix with a space could never be matched by the completer.
    if (prefix === '') throw badRequest('"prefix" cannot be blank.');
    if (/\s/.test(prefix)) throw badRequest('"prefix" cannot contain whitespace.');

    const text = requireString(body, 'body');
    if (text.trim() === '') throw badRequest('"body" cannot be blank.');

    const engines = Array.isArray(body.engines)
      ? body.engines.filter((e): e is string => typeof e === 'string')
      : [];

    const id = snippetsRepo.upsert({
      id: nonEmpty(optionalString(body, 'id')),
      prefix,
      label: optionalString(body, 'label') ?? '',
      body: text,
      engines,
    });

    const saved = snippetsRepo.list().map(toWire).find((s) => s.id === id);
    if (!saved) throw new Error('The snippet was written but could not be read back.');
    return saved;
  });
}

export async function DELETE(req: Request): Promise<Response> {
  return handle(() => {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) throw badRequest('An "id" is required.');
    snippetsRepo.remove(id);
    return { ok: true };
  });
}

function toWire(row: Record<string, unknown>): SnippetWire {
  const engines = typeof row.engines === 'string' && row.engines !== '' ? row.engines.split(',') : [];
  return {
    id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
    prefix: typeof row.prefix === 'string' ? row.prefix : '',
    label: typeof row.label === 'string' ? row.label : '',
    body: typeof row.body === 'string' ? row.body : '',
    engines,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : 0,
  };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v : undefined;
}
