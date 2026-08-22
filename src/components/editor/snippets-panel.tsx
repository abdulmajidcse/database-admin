'use client';

/**
 * Snippet management (docs/roadmap.md M10).
 *
 * /api/snippets shipped with no caller, so the completion source always had an
 * empty list and the feature the README described could not be used. This is
 * the missing half.
 *
 * Modelled on saved-queries.tsx: one list, edit in place, POST upserts so "new"
 * and "save" are the same call.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';

import { api } from '@/lib/api-client';
import { ENGINE_LABELS, workspaceModeFor } from '@/lib/connection';
import type { EngineKind } from '@/lib/schema-model';
import { Button, Dialog, EmptyState, Field, Input, cn } from '@/components/ui/primitives';
import type { EditorSnippet } from './completion';

interface SnippetRow extends EditorSnippet {
  id: string;
}

const SNIPPETS_KEY = ['snippets'] as const;

/**
 * Snippets are SQL, so Redis and MongoDB are not offered. Derived from
 * workspaceModeFor rather than hardcoded, so adding an engine does not leave a
 * second list to remember.
 */
const SQL_ENGINES = (Object.keys(ENGINE_LABELS) as EngineKind[]).filter(
  (e) => workspaceModeFor(e) === 'sql',
);

export function SnippetsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const list = useQuery<{ snippets: SnippetRow[] }>({
    queryKey: SNIPPETS_KEY,
    queryFn: () => api.get<{ snippets: SnippetRow[] }>('/api/snippets'),
    enabled: open,
  });

  const [draft, setDraft] = React.useState<Partial<SnippetRow> | null>(null);

  const save = useMutation({
    mutationFn: (s: Partial<SnippetRow>) => api.post<SnippetRow>('/api/snippets', s),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: SNIPPETS_KEY });
      setDraft(null);
      toast.success('Snippet saved');
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : 'Could not save it.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/snippets?id=${encodeURIComponent(id)}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: SNIPPETS_KEY }),
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : 'Could not delete it.'),
  });

  const rows = list.data?.snippets ?? [];

  return (
    <Dialog open={open} onClose={onClose} title="Snippets" width="lg">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-[var(--fg-muted)]">
          Type a prefix in the editor to insert one. <code>{'${1:name}'}</code> becomes a tab stop.
        </p>
        <Button
          size="xs"
          icon={<Plus className="size-3.5" />}
          onClick={() => setDraft({ prefix: '', label: '', body: '', engines: [] })}
        >
          New
        </Button>
      </div>

      {rows.length === 0 && !draft && (
        <EmptyState title="No snippets yet" description="Create one and it completes by prefix." />
      )}

      <ul className="mb-3 max-h-[40vh] overflow-y-auto">
        {rows.map((s) => (
          <li
            key={s.id}
            className="flex items-center gap-2 border-b border-[var(--border)] py-1 last:border-0"
          >
            <code className="mono w-24 shrink-0 text-[11px]">{s.prefix}</code>
            <span className="flex-1 truncate text-xs text-[var(--fg-muted)]">
              {s.label || s.body.split('\n')[0]}
            </span>
            <span className="text-[10px] text-[var(--fg-subtle)]">
              {s.engines.length === 0 ? 'all engines' : s.engines.join(', ')}
            </span>
            <Button size="xs" variant="ghost" onClick={() => setDraft(s)}>
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={<Trash2 className="size-3.5" />}
              onClick={() => remove.mutate(s.id)}
              title="Delete this snippet"
            />
          </li>
        ))}
      </ul>

      {draft && (
        <form
          className="flex flex-col gap-2 border-t border-[var(--border)] pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft);
          }}
        >
          <Field label="Prefix">
            <Input
              autoFocus
              value={draft.prefix ?? ''}
              onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
              placeholder="sel"
            />
          </Field>
          <Field label="Description">
            <Input
              value={draft.label ?? ''}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="Select the first rows of a table"
            />
          </Field>
          <Field label="Body">
            <textarea
              value={draft.body ?? ''}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={5}
              className="mono w-full rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[12px] outline-none focus:border-[var(--accent)]"
              placeholder={'SELECT *\nFROM ${1:table}\nLIMIT ${2:100};'}
            />
          </Field>
          <Field label="Engines (none ticked means every engine)">
            <div className="flex flex-wrap gap-2">
              {SQL_ENGINES.map((engine) => {
                const on = (draft.engines ?? []).includes(engine);
                return (
                  <button
                    key={engine}
                    type="button"
                    className={cn(
                      'rounded border px-2 py-0.5 text-[11px]',
                      on
                        ? 'border-[var(--accent)] text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--fg-muted)]',
                    )}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        engines: on
                          ? (draft.engines ?? []).filter((x) => x !== engine)
                          : [...(draft.engines ?? []), engine],
                      })
                    }
                  >
                    {ENGINE_LABELS[engine]}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)} type="button">
              Cancel
            </Button>
            <Button size="xs" type="submit" disabled={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
