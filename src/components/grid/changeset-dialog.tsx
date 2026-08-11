'use client';

/**
 * Preview / apply for pending grid edits (PLAN §6 "Grid editing").
 *
 * "Preview" posts to /api/changeset/preview and shows the EXACT SQL that will
 * run — the server renders it from the same code path the apply uses, so this
 * is not an approximation — together with the rows each statement must touch.
 * That expected count is the safety rail: /api/changeset/apply aborts and rolls
 * the whole transaction back when a statement affects a different number of
 * rows, which is what stops a weak WHERE clause from rewriting someone else's
 * data. The user sees the number here before agreeing to it.
 */

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Clipboard, Play, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiRequestError, api } from '../../lib/api-client';
import type { ChangesetApplyResponse, ChangesetPreviewResponse } from '../../lib/api-types';
import type { Changeset } from '../../lib/results';
import { Badge, Button, Dialog, ErrorBox, Spinner, cn } from '../ui/primitives';

export interface ChangesetDialogProps {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  /** Null when the pending edits cannot form a changeset; `problems` says why. */
  changeset: Changeset | null;
  problems?: string[];
  /** Called with the applied row count so the owner can refetch and reset. */
  onApplied: (applied: number) => void;
}

function errorParts(err: unknown): { message: string; hint?: string; detail?: string } {
  if (err instanceof ApiRequestError) return { message: err.message, hint: err.hint, detail: err.detail };
  if (err instanceof Error) return { message: err.message };
  return { message: 'The request failed.' };
}

export function ChangesetDialog({
  open,
  onClose,
  connectionId,
  changeset,
  problems = [],
  onApplied,
}: ChangesetDialogProps) {
  const [applied, setApplied] = React.useState<ChangesetApplyResponse | null>(null);
  const [copied, setCopied] = React.useState(false);

  const preview = useMutation<ChangesetPreviewResponse, unknown, Changeset>({
    mutationFn: (cs) => api.post<ChangesetPreviewResponse>('/api/changeset/preview', { connectionId, changeset: cs }),
  });

  const apply = useMutation<ChangesetApplyResponse, unknown, Changeset>({
    mutationFn: (cs) => api.post<ChangesetApplyResponse>('/api/changeset/apply', { connectionId, changeset: cs }),
    onSuccess: (result) => {
      setApplied(result);
      toast.success(`Applied ${result.applied} row change${result.applied === 1 ? '' : 's'}.`);
      onApplied(result.applied);
    },
    onError: (err) => toast.error(errorParts(err).message),
  });

  // Re-preview whenever the dialog opens on a different set of edits. Keyed by
  // content, not identity: the grid rebuilds the changeset object every render.
  const key = React.useMemo(() => (changeset ? JSON.stringify(changeset) : ''), [changeset]);
  const previewMutate = preview.mutate;
  const previewReset = preview.reset;
  const applyReset = apply.reset;
  React.useEffect(() => {
    if (!open) return;
    setApplied(null);
    applyReset();
    if (!changeset) {
      previewReset();
      return;
    }
    previewMutate(changeset);
    // `key` stands in for `changeset`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, previewMutate, previewReset, applyReset]);

  if (!open) return null;

  const plan = preview.data;
  const statements = plan?.statements ?? [];
  const expected = plan?.expectedAffected ?? [];
  const totalExpected = expected.reduce((a, b) => a + b, 0);
  const canApply = !!changeset && !!plan && statements.length > 0 && !apply.isPending && applied === null;

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(statements.map((s) => (s.trim().endsWith(';') ? s : `${s};`)).join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={
        <span className="flex items-center gap-2">
          Pending changes
          {changeset && (
            <span className="mono text-[11px] font-normal text-[var(--fg-muted)]">
              {changeset.schema ? `${changeset.schema}.` : ''}
              {changeset.table}
            </span>
          )}
          {statements.length > 0 && (
            <Badge tone="accent">
              {statements.length} statement{statements.length === 1 ? '' : 's'}
            </Badge>
          )}
        </span>
      }
      footer={
        <>
          <Button
            icon={copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
            onClick={copySql}
            disabled={statements.length === 0}
          >
            {copied ? 'Copied' : 'Copy SQL'}
          </Button>
          <Button onClick={onClose}>{applied ? 'Close' : 'Cancel'}</Button>
          {applied === null && (
            <Button
              variant="primary"
              icon={<Play className="size-3.5" />}
              disabled={!canApply}
              loading={apply.isPending}
              onClick={() => changeset && apply.mutate(changeset)}
            >
              Apply {totalExpected > 0 ? `(${totalExpected} row${totalExpected === 1 ? '' : 's'})` : ''}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problems.length > 0 && (
          <div className="rounded border border-[var(--warn)]/40 bg-[var(--warn-bg)] p-2 text-xs text-[var(--warn)]">
            {problems.map((p, i) => (
              <p key={i} className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                {p}
              </p>
            ))}
          </div>
        )}

        {applied && (
          <div className="rounded border border-[var(--ok)]/40 bg-[var(--ok-bg)] p-2 text-xs text-[var(--ok)]">
            Applied {applied.applied} row change{applied.applied === 1 ? '' : 's'} across {applied.statements}{' '}
            statement{applied.statements === 1 ? '' : 's'} in {Math.round(applied.durationMs)} ms.
          </div>
        )}

        {preview.isPending && (
          <div className="flex items-center gap-2 text-[var(--fg-muted)]">
            <Spinner /> Rendering SQL…
          </div>
        )}

        {preview.isError && (
          <ErrorBox
            title="Preview failed"
            message={errorParts(preview.error).message}
            hint={errorParts(preview.error).hint}
          />
        )}

        {apply.isError && (
          <ErrorBox
            title="Apply failed — nothing was committed"
            message={errorParts(apply.error).message}
            hint={errorParts(apply.error).hint}
          />
        )}

        {plan && plan.warnings.length > 0 && (
          <div className="flex flex-col gap-1 rounded border border-[var(--warn)]/40 bg-[var(--warn-bg)] p-2 text-xs text-[var(--warn)]">
            {plan.warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                {w}
              </p>
            ))}
          </div>
        )}

        {statements.length > 0 && (
          <div className="overflow-hidden rounded border border-[var(--border)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--grid-header)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">
              <span>Exactly this SQL will run, in this order, inside one transaction.</span>
              <span>expected rows</span>
            </div>
            <ol className="divide-y divide-[var(--border)]">
              {statements.map((sql, i) => (
                <li key={i} className="flex items-start gap-2 px-2 py-1.5">
                  <span className="mono w-6 shrink-0 text-right text-[var(--fg-subtle)]">{i + 1}</span>
                  <pre className="mono min-w-0 flex-1 whitespace-pre-wrap break-all text-[var(--fg)]">{sql}</pre>
                  <span
                    className={cn(
                      'mono shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                      expected[i] === 1
                        ? 'bg-[var(--bg-active)] text-[var(--fg-muted)]'
                        : 'bg-[var(--warn-bg)] text-[var(--warn)]',
                    )}
                    title="A mismatch here aborts the whole transaction."
                  >
                    {expected[i] ?? '?'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {!preview.isPending && !preview.isError && statements.length === 0 && !applied && (
          <p className="text-[var(--fg-muted)]">There is nothing to apply.</p>
        )}
      </div>
    </Dialog>
  );
}
