'use client';

/**
 * Import wizard (PLAN §7.4 "CSV import wizard" + import knobs, §7.5 restores).
 *
 * Three screens, in the order the decisions actually depend on each other:
 *
 *   1. **Source** — pick a file (a container path, §10.4), then POST
 *      /api/csv/preview. The sniffed delimiter/quote/encoding/BOM/header are
 *      shown as EDITABLE controls next to 50 real rows, because the sniffer is a
 *      guess and a wrong encoding turns the whole wizard into garbage.
 *   2. **Mapping** — per-column target, type, explicit date format, NULL literal
 *      and trim (see ./csv-mapping).
 *   3. **Options** — on-conflict, truncate, FK checks, batch size, transaction,
 *      continue-on-error, and the DRY RUN, which is deliberately the loudest
 *      control on the screen and is on by default: validating a file costs a
 *      minute, and finding out afterwards that half of it landed costs an hour.
 *
 * The import itself is always a job (§7.3) — the route answers `{ jobId }` and
 * this dialog hands the user straight to the drawer.
 */

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, FileInput, FlaskConical, TriangleAlert, Upload } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import type { ColumnMapping, CsvPreviewResponse, ImportOptions } from '@/lib/api-types';
import { allTables } from '@/lib/schema-model';
import { useSchema } from '@/hooks/use-schema';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorBox,
  Field,
  Input,
  Select,
  Separator,
  Spinner,
  cn,
} from '@/components/ui/primitives';
import { FilePathField, baseName } from './file-picker';
import { CsvMapping, buildMappings } from './csv-mapping';
import { openJobsDrawer } from './jobs-drawer';

type SourceKind = 'csv' | 'json' | 'ndjson' | 'xlsx' | 'sql' | 'dump' | 'bundle';
type Step = 'source' | 'mapping' | 'options';

const SOURCE_KINDS: { id: SourceKind; label: string }[] = [
  { id: 'csv', label: 'CSV / TSV / delimited text' },
  { id: 'json', label: 'JSON array' },
  { id: 'ndjson', label: 'NDJSON (one document per line)' },
  { id: 'xlsx', label: 'Excel workbook (.xlsx) — first sheet' },
  { id: 'sql', label: 'SQL script' },
  { id: 'dump', label: 'Database dump (pg_dump / mysqldump)' },
  { id: 'bundle', label: 'Folder of CSVs — one table per file' },
];

/** Encodings /api/csv/preview accepts; a sniffed value outside this list is kept. */
const ENCODINGS = ['utf8', 'utf16le', 'utf16be', 'latin1'];

const DELIMITER_PRESETS: { value: string; label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
  { value: ' ', label: 'Space' },
];

/** Row sources need a target table; a script carries its own targets. */
function isScript(kind: SourceKind): boolean {
  return kind === 'sql' || kind === 'dump';
}

/**
 * Sources that name their own tables, so the wizard must not ask for one: a
 * script names them in its SQL, a bundle takes one per file from the filenames.
 * Both also skip the mapping step — a bundle derives a mapping per file, since a
 * single mapping could only ever fit one of the files in it.
 */
function namesOwnTargets(kind: SourceKind): boolean {
  return isScript(kind) || kind === 'bundle';
}

/**
 * Sources the wizard maps in the browser, which needs /api/csv/preview to have
 * read the file first — so only CSV.
 *
 * XLSX has a header row and fixed columns and could be mapped the same way, but
 * the preview endpoint does not read workbooks, so it takes the server-side
 * path that JSON and NDJSON already use: deriveMapping() reads the first sheet
 * and maps header to column by name. Worth revisiting if column mapping for
 * spreadsheets turns out to matter; it needs a preview endpoint, not a change
 * here.
 */
function hasMapping(kind: SourceKind): boolean {
  return kind === 'csv';
}

function kindFromPath(path: string): SourceKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx';
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'ndjson';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.sql') || lower.endsWith('.sql.gz')) return 'sql';
  if (/\.(dump|backup|bak|pgdump|custom)(\.gz)?$/.test(lower)) return 'dump';
  return 'csv';
}

/** `orders-2026-08-10.csv` → `orders`, a sane default table name. */
function tableFromPath(path: string): string {
  const name = baseName(path).replace(/\.(gz|zst)$/i, '');
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  connectionId: string | null;
  initialPath?: string;
  initialTarget?: { schema?: string; table: string };
}

export function ImportDialog({ open, onClose, connectionId, initialPath, initialTarget }: ImportDialogProps) {
  const [step, setStep] = React.useState<Step>('source');
  const [path, setPath] = React.useState('');
  const [kind, setKind] = React.useState<SourceKind>('csv');
  const [kindTouched, setKindTouched] = React.useState(false);

  // Dialect: what the user changed. Everything else comes from the sniffer, so
  // an edited delimiter survives a re-preview but an untouched one keeps
  // tracking the detection.
  const [edits, setEdits] = React.useState<{
    delimiter?: string;
    quote?: string;
    encoding?: string;
    hasHeader?: boolean;
  }>({});
  const [customDelimiter, setCustomDelimiter] = React.useState(false);
  const [nullLiteral, setNullLiteral] = React.useState('');
  const [trim, setTrim] = React.useState(true);

  const [schemaName, setSchemaName] = React.useState('');
  const [tableName, setTableName] = React.useState('');
  const [tableTouched, setTableTouched] = React.useState(false);
  const [createTable, setCreateTable] = React.useState(false);

  const [mapping, setMapping] = React.useState<ColumnMapping[]>([]);
  /** Once the user has touched the mapping, only a new column shape may rewrite it. */
  const [mappingTouched, setMappingTouched] = React.useState(false);
  const shapeRef = React.useRef('');

  const [onConflict, setOnConflict] = React.useState<ImportOptions['onConflict']>('insert');
  const [keyColumns, setKeyColumns] = React.useState('');
  const [truncateFirst, setTruncateFirst] = React.useState(false);
  const [disableForeignKeys, setDisableForeignKeys] = React.useState(false);
  const [batchSize, setBatchSize] = React.useState('1000');
  const [wrapInTransaction, setWrapInTransaction] = React.useState(true);
  const [continueOnError, setContinueOnError] = React.useState(false);
  const [useFastPath, setUseFastPath] = React.useState(true);
  // §7.4: dry run first, by default. Turning it off is a deliberate act.
  const [dryRun, setDryRun] = React.useState(true);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; hint?: string } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setStep('source');
    setError(null);
    setBusy(false);
    setEdits({});
    setCustomDelimiter(false);
    setMapping([]);
    setMappingTouched(false);
    shapeRef.current = '';
    setKindTouched(false);
    setTableTouched(!!initialTarget);
    setPath(initialPath ?? '');
    setKind(initialPath ? kindFromPath(initialPath) : 'csv');
    setSchemaName(initialTarget?.schema ?? '');
    setTableName(initialTarget?.table ?? (initialPath ? tableFromPath(initialPath) : ''));
    // Keyed on `open` so typing inside the wizard is never reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Picking a file re-derives the two things that follow from its name, unless
  // the user has already overridden them.
  const onPathChange = React.useCallback(
    (next: string) => {
      setPath(next);
      if (!kindTouched) setKind(kindFromPath(next));
      if (!tableTouched) setTableName(tableFromPath(next));
    },
    [kindTouched, tableTouched],
  );

  // --- preview (§7.4 "sniff delimiter, encoding and BOM; preview 50 rows") ---
  // The NULL literal is part of the preview's query key, so an undebounced one
  // would re-read the file on every keystroke.
  const debouncedNullLiteral = useDebounced(nullLiteral, 300);
  const dialectBody = React.useMemo(() => {
    const d: Record<string, unknown> = {};
    if (edits.delimiter && edits.delimiter.length === 1) d.delimiter = edits.delimiter;
    if (edits.quote && edits.quote.length === 1) d.quote = edits.quote;
    if (edits.encoding) d.encoding = edits.encoding;
    if (edits.hasHeader !== undefined) d.hasHeader = edits.hasHeader;
    // Both of these ride along on the import (see `csv` in submit), and the
    // server infers each column's type under them. Leaving them out here types
    // the preview by different rules than the load: a file writing missing
    // numbers as `NA` reads as text without the literal and as an integer with
    // it — and the mapping is seeded from whichever answer the preview gave.
    if (debouncedNullLiteral !== '') d.nullLiteral = debouncedNullLiteral;
    d.trim = trim;
    return d;
  }, [edits, debouncedNullLiteral, trim]);

  const preview = useQuery<CsvPreviewResponse>({
    queryKey: ['csv-preview', path, JSON.stringify(dialectBody ?? {})],
    queryFn: () => api.post<CsvPreviewResponse>('/api/csv/preview', { path: path.trim(), dialect: dialectBody }),
    enabled: open && kind === 'csv' && path.trim() !== '',
    retry: false,
    staleTime: 30_000,
  });

  const detected = preview.data?.dialect;
  const headers = React.useMemo(() => preview.data?.headers ?? [], [preview.data]);
  const headerKey = headers.join('\u0000');

  // Target columns are only worth an introspection once the user is on the
  // mapping screen and the table already exists.
  const schemaScope = React.useMemo(
    () => (schemaName.trim() !== '' ? { namespaces: [schemaName.trim()] } : undefined),
    [schemaName],
  );
  const schema = useSchema(connectionId, {
    scope: schemaScope,
    enabled: open && step === 'mapping' && !createTable && tableName.trim() !== '',
  });
  const targetColumns = React.useMemo(() => {
    if (!schema.model || createTable) return undefined;
    const wanted = tableName.trim();
    const match = allTables(schema.model).find(
      (t) => t.name === wanted && (schemaName.trim() === '' || t.schema === schemaName.trim()),
    );
    return match?.columns.map((c) => c.name);
  }, [schema.model, createTable, tableName, schemaName]);

  // Rebuild the mapping when the source columns change — a new delimiter means
  // new columns, and a stale mapping would silently write to the wrong ones —
  // and re-match when the target column list finally lands. Hand edits survive
  // both unless the column shape itself changed.
  const targetKey = (targetColumns ?? []).join(',');
  // A NULL-literal or trim change re-infers the types without changing the
  // headers, so `headerKey` alone would never notice — and the mapping would
  // keep the types inferred under the old rules.
  const typesKey = (preview.data?.inferredTypes ?? []).join(',');
  React.useEffect(() => {
    if (headers.length === 0) return;
    const shapeChanged = shapeRef.current !== headerKey;
    shapeRef.current = headerKey;
    if (!shapeChanged && mappingTouched) return;
    setMapping(
      buildMappings({ headers, inferredTypes: preview.data?.inferredTypes, targetColumns, nullLiteral, trim }),
    );
    if (shapeChanged) setMappingTouched(false);
    // `headerKey`/`targetKey`/`typesKey` stand in for the arrays; nullLiteral
    // and trim are read but not depended on — they only ever reach here through
    // a re-inferred `typesKey`, so a default change cannot discard hand edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerKey, targetKey, typesKey]);

  const script = isScript(kind);
  /** Drives the step list and the "which table?" fields, not the wording. */
  const selfTargeting = namesOwnTargets(kind);
  const problems = validate({ connectionId, path, kind, tableName });
  const canAdvance = problems.length === 0;

  // A CSV whose every column is unmapped starts a job that throws NO_MAPPING the
  // moment it runs — which is exactly what a headerless file does, since the
  // synthetic `column_1…column_N` headers match no real column name. It blocks
  // submission only, never the Next button: the mapping screen is where it gets
  // fixed, so stranding the user on step 1 would be worse than useless.
  /** Both of these key a row before writing it; neither can guess the key. */
  const needsKeys = onConflict === 'upsert' || onConflict === 'replace';
  const unmapped = hasMapping(kind) && mapping.length > 0 && mapping.every((m) => m.targetColumn === null);
  const submitProblems = unmapped
    ? [...problems, 'Map at least one column to a target column — nothing would be written.']
    : problems;
  const canSubmit = submitProblems.length === 0;

  const steps: Step[] = selfTargeting ? ['source', 'options'] : ['source', 'mapping', 'options'];
  const stepIndex = Math.max(0, steps.indexOf(step));
  // Shown from the mapping screen on, so the warning appears on the screen that
  // can fix it as well as on the one that blocks on it.
  const shownProblems = step === 'source' ? problems : submitProblems;

  async function submit(): Promise<void> {
    if (!connectionId || submitProblems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const db = schemaName.trim();
      const body = {
        connectionId,
        source: { kind, path: path.trim() },
        // A restore reads only `target.schema` (it becomes the target database),
        // but /api/import validates `target.table` as a non-empty string for any
        // target it is given — so the database name is repeated rather than
        // sending an empty field that would be rejected before the job starts.
        target: script
          ? db === ''
            ? undefined
            : { schema: db, table: db }
          : kind === 'bundle'
            ? // No table name: each file in the folder supplies its own, and
              // sending one here would apply it to every file.
              { schema: db === '' ? undefined : db, table: '', createTable }
            : {
                schema: db === '' ? undefined : db,
                table: tableName.trim(),
                createTable,
              },
        // `sourceName` must be a non-empty string server-side; a headerless or
        // blank column still needs a stable name, and `sourceIndex` is what the
        // loader actually matches on.
        mapping:
          hasMapping(kind) && mapping.length > 0
            ? mapping.map((m) => ({ ...m, sourceName: m.sourceName || `column_${m.sourceIndex + 1}` }))
            : undefined,
        options: {
          onConflict,
          truncateFirst,
          disableForeignKeys,
          batchSize: Number(batchSize) >= 1 ? Math.floor(Number(batchSize)) : 1000,
          wrapInTransaction,
          continueOnError,
          dryRun,
          useFastPath,
        } satisfies ImportOptions,
        csv:
          hasMapping(kind)
            ? {
                ...(edits.delimiter && edits.delimiter.length === 1 ? { delimiter: edits.delimiter } : {}),
                ...(edits.quote && edits.quote.length === 1 ? { quote: edits.quote } : {}),
                ...(edits.encoding ? { encoding: edits.encoding } : {}),
                ...(edits.hasHeader !== undefined ? { hasHeader: edits.hasHeader } : {}),
                ...(nullLiteral !== '' ? { nullLiteral } : {}),
                trim,
              }
            : undefined,
        // The upsert key: without it the server cannot tell an update from an
        // insert, so it is asked for rather than guessed.
        // Never for a bundle: these name columns in ONE table, and the server
        // would apply them as the conflict key for every file in the folder.
        keyColumns:
          kind !== 'bundle' && needsKeys && keyColumns.trim() !== ''
            ? keyColumns
                .split(',')
                .map((c) => c.trim())
                .filter((c) => c !== '')
            : undefined,
      };

      const { jobId } = await api.post<{ jobId: string }>('/api/import', body);
      toast.success(dryRun ? 'Dry run started' : script ? 'Restore started' : 'Import started', {
        description: dryRun ? 'Nothing will be written — watch the job log for bad rows.' : baseName(path),
      });
      openJobsDrawer(jobId);
      onClose();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Could not start the import',
        hint: err instanceof ApiRequestError ? err.hint : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={script ? 'Restore from a script or dump' : 'Import data'}
      width="xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--fg-subtle)]">
            Step {stepIndex + 1} of {steps.length}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          {stepIndex > 0 && (
            <Button icon={<ChevronLeft className="size-3.5" />} onClick={() => setStep(steps[stepIndex - 1])}>
              Back
            </Button>
          )}
          {stepIndex < steps.length - 1 ? (
            <Button
              variant="primary"
              disabled={!canAdvance}
              icon={<ChevronRight className="size-3.5" />}
              onClick={() => setStep(steps[stepIndex + 1])}
            >
              Next
            </Button>
          ) : (
            <Button
              variant={dryRun ? 'default' : 'primary'}
              loading={busy}
              disabled={!canSubmit}
              icon={dryRun ? <FlaskConical className="size-3.5" /> : <Upload className="size-3.5" />}
              onClick={() => void submit()}
            >
              {dryRun ? 'Run dry run' : script ? 'Restore' : 'Import'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {step === 'source' && (
          <>
            <Field
              label={kind === 'bundle' ? 'Folder' : 'File'}
              hint="Container paths, confined to the export and SQLite directories — Browse shows the host directory each maps to."
            >
              <FilePathField
                value={path}
                onChange={onPathChange}
                root="export"
                roots={['export', 'sqlite']}
                mode={kind === 'bundle' ? 'directory' : 'open'}
                placeholder={kind === 'bundle' ? '/data/exports/my-database' : '/data/exports/orders.csv'}
                pickerTitle={kind === 'bundle' ? 'Choose a folder of CSVs' : 'Choose a file to import'}
              />
            </Field>

            <div className="grid grid-cols-3 gap-2">
              <Field label="File type">
                <Select
                  value={kind}
                  onChange={(e) => {
                    setKindTouched(true);
                    setKind(e.target.value as SourceKind);
                  }}
                >
                  {SOURCE_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {!selfTargeting && (
                <>
                  <Field label="Target schema" hint="Optional">
                    <Input className="mono" value={schemaName} onChange={(e) => setSchemaName(e.target.value)} />
                  </Field>
                  <Field label="Target table">
                    <Input
                      className="mono"
                      value={tableName}
                      onChange={(e) => {
                        setTableTouched(true);
                        setTableName(e.target.value);
                      }}
                    />
                  </Field>
                </>
              )}
              {selfTargeting && (
                <Field
                  label={script ? 'Target database' : 'Target schema'}
                  hint={
                    script
                      ? 'Optional — the script may name its own.'
                      : 'Optional — each file loads into the table its name gives.'
                  }
                >
                  <Input className="mono" value={schemaName} onChange={(e) => setSchemaName(e.target.value)} />
                </Field>
              )}
            </div>

            {kind === 'bundle' && (
              <p className="border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5 text-[11px] leading-snug text-[var(--fg-muted)]">
                Every <code className="mono">.csv</code> and <code className="mono">.tsv</code> in the folder is loaded
                into the table its filename names — <code className="mono">users.csv</code> into{' '}
                <code className="mono">users</code> — each with its own sniffed dialect and its own derived mapping.
                Files load in name order. A downloaded <code className="mono">.zip</code> has to be unpacked into the
                import root first.
              </p>
            )}

            {!script && (
              <Checkbox
                checked={createTable}
                onChange={(e) => setCreateTable(e.target.checked)}
                label={
                  kind === 'bundle'
                    ? 'Create each table if it does not exist (types are inferred per file)'
                    : 'Create the table if it does not exist (types come from the mapping screen)'
                }
              />
            )}

            {kind === 'csv' && path.trim() !== '' && (
              <>
                <Separator />
                <div className="flex items-center gap-2">
                  <FileInput className="size-3.5 text-[var(--fg-subtle)]" />
                  <span className="text-xs font-medium">Detected dialect</span>
                  {preview.isFetching && <Spinner className="size-3" />}
                  {detected?.bom && <Badge tone="warn">BOM</Badge>}
                  {detected && <Badge>{detected.hasHeader ? 'header row' : 'no header'}</Badge>}
                  <span className="ml-auto text-[11px] text-[var(--fg-subtle)]">
                    A guess. Fix anything that looks wrong — the preview re-reads the file.
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  <Field label="Delimiter">
                    <div className="flex items-center gap-1">
                      <Select
                        value={
                          customDelimiter
                            ? '__custom__'
                            : DELIMITER_PRESETS.some((p) => p.value === (edits.delimiter ?? detected?.delimiter))
                              ? (edits.delimiter ?? detected?.delimiter ?? ',')
                              : '__custom__'
                        }
                        onChange={(e) => {
                          if (e.target.value === '__custom__') {
                            setCustomDelimiter(true);
                            return;
                          }
                          setCustomDelimiter(false);
                          setEdits((p) => ({ ...p, delimiter: e.target.value }));
                        }}
                      >
                        {DELIMITER_PRESETS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                        <option value="__custom__">Custom…</option>
                      </Select>
                      {(customDelimiter ||
                        !DELIMITER_PRESETS.some((p) => p.value === (edits.delimiter ?? detected?.delimiter))) && (
                        <Input
                          className="mono w-12"
                          maxLength={1}
                          value={edits.delimiter ?? detected?.delimiter ?? ''}
                          onChange={(e) => setEdits((p) => ({ ...p, delimiter: e.target.value }))}
                        />
                      )}
                    </div>
                  </Field>
                  <Field label="Quote character">
                    <Input
                      className="mono"
                      maxLength={1}
                      value={edits.quote ?? detected?.quote ?? '"'}
                      onChange={(e) => setEdits((p) => ({ ...p, quote: e.target.value }))}
                    />
                  </Field>
                  <Field label="Encoding" hint={detected?.bom ? 'A BOM was found and is skipped.' : undefined}>
                    <Select
                      value={edits.encoding ?? detected?.encoding ?? 'utf8'}
                      onChange={(e) => setEdits((p) => ({ ...p, encoding: e.target.value }))}
                    >
                      {ENCODINGS.map((enc) => (
                        <option key={enc} value={enc}>
                          {enc}
                        </option>
                      ))}
                      {detected && !ENCODINGS.includes(detected.encoding) && (
                        <option value={detected.encoding}>{detected.encoding} (detected)</option>
                      )}
                    </Select>
                  </Field>
                  <Field label="First row">
                    <Checkbox
                      checked={edits.hasHeader ?? detected?.hasHeader ?? true}
                      onChange={(e) => setEdits((p) => ({ ...p, hasHeader: e.target.checked }))}
                      label="is a header row"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  <Field label="Default NULL literal" hint="Per-column overrides live on the mapping screen.">
                    <Input
                      className="mono"
                      value={nullLiteral}
                      placeholder="empty field = NULL"
                      onChange={(e) => setNullLiteral(e.target.value)}
                    />
                  </Field>
                  <Field label="Whitespace">
                    <Checkbox checked={trim} onChange={(e) => setTrim(e.target.checked)} label="Trim every value" />
                  </Field>
                </div>

                {preview.error && (
                  <ErrorBox
                    title="Could not read that file"
                    message={preview.error instanceof Error ? preview.error.message : 'Unknown error'}
                    hint={preview.error instanceof ApiRequestError ? preview.error.hint : undefined}
                  />
                )}

                {preview.data && <PreviewTable preview={preview.data} />}
              </>
            )}

            {(kind === 'json' || kind === 'ndjson') && path.trim() !== '' && (
              <p className="border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5 text-[11px] leading-snug text-[var(--fg-muted)]">
                Documents are streamed straight into the table and their keys are matched to column names, so there is
                no dialect to sniff and no mapping screen. Use the options step to choose the conflict strategy and a
                dry run.
              </p>
            )}

            {script && path.trim() !== '' && (
              <p className="border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5 text-[11px] leading-snug text-[var(--fg-muted)]">
                This runs as a <span className="font-medium">restore</span>: a real dump is handed to{' '}
                <code className="mono">pg_restore</code> / <code className="mono">mysql</code> when the matching client
                is available, and to the built-in script runner otherwise. Statements are executed in the file&apos;s own
                order.
              </p>
            )}
          </>
        )}

        {step === 'mapping' && (
          <>
            {kind === 'csv' && preview.data ? (
              <>
                {schema.isPending && (
                  <span className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
                    <Spinner className="size-3" /> Reading the target table&apos;s columns…
                  </span>
                )}
                {!createTable && !schema.isPending && targetColumns === undefined && (
                  <p className="flex items-center gap-1.5 text-[11px] text-[var(--warn)]">
                    <TriangleAlert className="size-3" />
                    {tableName.trim()} was not found in the schema. Map to column names by hand, or turn on &ldquo;create
                    the table&rdquo; on the previous step.
                  </p>
                )}
                <CsvMapping
                  headers={preview.data.headers}
                  rows={preview.data.rows}
                  inferredTypes={preview.data.inferredTypes}
                  value={mapping}
                  onChange={(next) => {
                    setMappingTouched(true);
                    setMapping(next);
                  }}
                  targetColumns={targetColumns}
                  creatingTable={createTable}
                />
              </>
            ) : (
              <p className="text-xs text-[var(--fg-muted)]">
                Pick a CSV file on the previous step to map its columns.
              </p>
            )}
          </>
        )}

        {step === 'options' && (
          <>
            {/* §7.4: the dry run is the most valuable knob here, so it is the
                first and loudest thing on the screen. */}
            <div
              className={cn(
                'flex items-start gap-2 border p-2',
                dryRun ? 'border-[var(--accent)] bg-[var(--selection)]' : 'border-[var(--warn)] bg-[var(--warn-bg)]',
              )}
            >
              <FlaskConical className={cn('mt-0.5 size-4 shrink-0', dryRun ? 'text-[var(--accent)]' : 'text-[var(--warn)]')} />
              <div className="flex flex-col gap-0.5">
                <Checkbox
                  checked={dryRun}
                  onChange={(e) => setDryRun(e.target.checked)}
                  label={<span className="text-[13px] font-semibold">Dry run — validate without writing</span>}
                />
                <p className="text-[11px] leading-snug text-[var(--fg-muted)]">
                  {dryRun
                    ? 'Every row is parsed, coerced and checked against the target, and bad rows are listed in the job log. Nothing is inserted, nothing is truncated, no transaction is committed.'
                    : 'This will write to the database. Run it as a dry run first unless you already have.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field
                label="On conflict"
                hint="What to do when a row collides with an existing key."
              >
                <Select
                  value={onConflict}
                  onChange={(e) => setOnConflict(e.target.value as ImportOptions['onConflict'])}
                >
                  <option value="insert">Insert — fail on a duplicate</option>
                  <option value="upsert">Upsert — update the existing row</option>
                  <option value="replace">Replace — delete then insert the row</option>
                  <option value="ignore">Ignore — skip the duplicate</option>
                </Select>
              </Field>
              {/* `replace` needs a key exactly as much as `upsert` does — it is
                  a delete keyed on the row followed by an insert — and the
                  server's only fallback is the primary key. Leaving the box
                  disabled here made "replace into a table with no primary key"
                  unreachable from the UI: the job could only ever fail. */}
              <Field
                label="Key columns"
                hint={
                  needsKeys
                    ? 'Comma-separated. Defaults to the primary key.'
                    : 'Upsert and replace only.'
                }
              >
                <Input
                  className="mono"
                  disabled={!needsKeys}
                  value={keyColumns}
                  placeholder="id"
                  onChange={(e) => setKeyColumns(e.target.value)}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Checkbox
                  checked={truncateFirst}
                  onChange={(e) => setTruncateFirst(e.target.checked)}
                  label="Truncate the table before loading"
                />
                <Checkbox
                  checked={disableForeignKeys}
                  onChange={(e) => setDisableForeignKeys(e.target.checked)}
                  label="Disable foreign-key checks during the load"
                />
                <Checkbox
                  checked={wrapInTransaction}
                  onChange={(e) => setWrapInTransaction(e.target.checked)}
                  label="Wrap the whole load in one transaction"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Checkbox
                  checked={continueOnError}
                  onChange={(e) => setContinueOnError(e.target.checked)}
                  label="Continue on error and collect a report"
                />
                <Checkbox
                  checked={useFastPath}
                  onChange={(e) => setUseFastPath(e.target.checked)}
                  label="Use the engine's bulk-load fast path"
                />
                <Field label="Batch size" className="mt-1">
                  <Input
                    className="mono"
                    inputMode="numeric"
                    value={batchSize}
                    onChange={(e) => setBatchSize(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
              </div>
            </div>

            <ul className="list-inside list-disc text-[11px] leading-snug text-[var(--fg-subtle)]">
              <li>
                The fast path is <code className="mono">COPY FROM STDIN</code> on Postgres,{' '}
                <code className="mono">LOAD DATA</code> on MySQL, one prepared-statement transaction on SQLite and an
                unordered <code className="mono">bulkWrite</code> on MongoDB — 50–100× faster than row-by-row inserts.
              </li>
              <li>
                Truncate and &ldquo;continue on error&rdquo; disagree with a single transaction: with one transaction a
                failed row rolls the whole load back, which is usually what you want for a first import.
              </li>
              {disableForeignKeys && (
                <li className="text-[var(--warn)]">
                  Disabling FK checks can leave orphan rows behind if the file is inconsistent. On Postgres this needs
                  superuser; the server falls back to deferring constraints instead.
                </li>
              )}
            </ul>
          </>
        )}

        {shownProblems.length > 0 && (
          <ul className="list-inside list-disc text-[11px] text-[var(--warn)]">
            {shownProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        {error && <ErrorBox title="Could not start the import" message={error.message} hint={error.hint} />}
      </div>
    </Dialog>
  );
}

/** The 50-row window §7.4 asks for, with the sniffed type under each header. */
function PreviewTable({ preview }: { preview: CsvPreviewResponse }) {
  return (
    <div className="max-h-64 overflow-auto border border-[var(--border)]">
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 bg-[var(--grid-header)]">
          <tr>
            <th className="w-10 border-r border-[var(--border)] px-2 py-1 text-right text-[10px] font-medium text-[var(--fg-subtle)]">
              #
            </th>
            {preview.headers.map((h, i) => (
              <th key={`${h}-${i}`} className="px-2 py-1 text-left font-medium">
                <span className="mono block truncate">{h}</span>
                <span className="block text-[10px] font-normal lowercase text-[var(--fg-subtle)]">
                  {preview.inferredTypes[i] ?? 'text'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, r) => (
            <tr key={r} className="border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]">
              <td className="border-r border-[var(--border)] px-2 py-0.5 text-right text-[10px] tabular-nums text-[var(--fg-subtle)]">
                {r + 1}
              </td>
              {preview.headers.map((_, c) => (
                <td key={c} className="mono max-w-64 truncate px-2 py-0.5" title={row[c] ?? ''}>
                  {row[c] === undefined || row[c] === '' ? <span className="null-cell">empty</span> : row[c]}
                </td>
              ))}
            </tr>
          ))}
          {preview.rows.length === 0 && (
            <tr>
              <td className="px-2 py-2 text-[11px] text-[var(--fg-subtle)]" colSpan={preview.headers.length + 1}>
                The file has no data rows under this dialect.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Trailing-edge debounce, so a fast typist costs one preview instead of six. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** A path naming a data file, so not the folder a bundle import reads. */
const DATA_FILE = /\.(csv|tsv|json|ndjson|sql|dump|backup|bak|pgdump|custom|xlsx|zip|gz|zst)$/i;

function validate(state: { connectionId: string | null; path: string; kind: SourceKind; tableName: string }): string[] {
  const out: string[] = [];
  if (!state.connectionId) out.push('Pick a connection first.');
  const path = state.path.trim();
  if (path === '') out.push(state.kind === 'bundle' ? 'Choose a folder to import.' : 'Choose a file to import.');
  // A bundle names a table per file, so an empty box is correct there.
  if (!namesOwnTargets(state.kind) && state.tableName.trim() === '') out.push('Name the target table.');
  // Switching the File type does not revisit a path already chosen, so a file
  // picked as CSV survives into a bundle import — where it reaches the server,
  // starts a job, and dies with ENOTDIR from readdir in the drawer. Nothing
  // before this point looks at the path's shape.
  if (state.kind === 'bundle' && path !== '' && DATA_FILE.test(path)) {
    out.push(`A folder of CSVs is needed here, but "${path}" names a file.`);
  }
  return out;
}
