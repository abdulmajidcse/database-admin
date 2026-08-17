'use client';

/**
 * Export (PLAN §7.1 scope levels, §7.2 two engines, §7.4 pipeline, §8.4 remote
 * dumps).
 *
 * The four scopes of §7.1 (current result, table, database, server), eight
 * formats, and two destinations that behave very differently:
 *
 *   - **Download** goes through `downloadExport()`, a form POST rather than
 *     fetch(), so the browser owns the transfer and a multi-gigabyte export is
 *     never buffered in a tab (§7.4).
 *   - **A file inside the export root** creates a JOB and opens the jobs drawer,
 *     because a 50 GB dump cannot live inside an HTTP request (§7.3). Every path
 *     shown is a container path (§10.4) — the picker says which host directory
 *     it maps to.
 *
 * Binary encoding is a first-class, explained control rather than a hidden
 * default: §7.4 names it "the single most common source of silently corrupted
 * dumps", and a choice you can see is a choice you can get right.
 */

import * as React from 'react';
import { toast } from 'sonner';
import { ChevronRight, Database, Download, HardDriveDownload, Server, Table2, Terminal } from 'lucide-react';
import { api, ApiRequestError, downloadExport } from '@/lib/api-client';
import type { ExportFormat, ExportOptions, ExportRequest } from '@/lib/api-types';
import { allTables, type EngineKind } from '@/lib/schema-model';
import { useSchema } from '@/hooks/use-schema';
import { useConnections } from '@/components/shell/connection-sidebar';
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
  Textarea,
  cn,
} from '@/components/ui/primitives';
import { FilePathField } from './file-picker';
import { NativeToolsPanel, missingDumpTools, useNativeTools } from './native-tools-panel';
import { openJobsDrawer } from './jobs-drawer';

type ScopeKind = ExportRequest['source']['kind'];

const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'tsv', label: 'TSV', ext: 'tsv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'ndjson', label: 'NDJSON', ext: 'ndjson' },
  { id: 'xlsx', label: 'Excel (xlsx)', ext: 'xlsx' },
  { id: 'markdown', label: 'Markdown', ext: 'md' },
  { id: 'html', label: 'HTML', ext: 'html' },
  { id: 'sql', label: 'SQL INSERTs / dump', ext: 'sql' },
];

/** Formats with a header row and a delimiter to argue about. */
const DELIMITED: ReadonlySet<ExportFormat> = new Set<ExportFormat>(['csv', 'tsv']);
const HEADERED: ReadonlySet<ExportFormat> = new Set<ExportFormat>(['csv', 'tsv', 'xlsx', 'markdown', 'html']);

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  connectionId: string | null;
  /** Preselects the scope — the grid passes its table, the editor its statement. */
  initialSource?: ExportRequest['source'];
  /** SQL behind the current result set; enables the "current result" scope. */
  sql?: string;
  defaultFormat?: ExportFormat;
}

export function ExportDialog({ open, onClose, connectionId, initialSource, sql, defaultFormat }: ExportDialogProps) {
  const connections = useConnections();
  const connection = React.useMemo(
    () => (connections.data?.connections ?? []).find((c) => c.id === connectionId) ?? null,
    [connections.data, connectionId],
  );
  const engine: EngineKind | null = connection?.engine ?? null;
  const viaSsh = connection?.access.via === 'ssh';

  // --- scope --------------------------------------------------------------
  const [scope, setScope] = React.useState<ScopeKind>('query');
  const [statement, setStatement] = React.useState('');
  const [schemaName, setSchemaName] = React.useState('');
  const [tableName, setTableName] = React.useState('');
  const [where, setWhere] = React.useState('');
  const [database, setDatabase] = React.useState('');
  const [pickedTables, setPickedTables] = React.useState<string[]>([]);
  const [chooseTables, setChooseTables] = React.useState(false);

  // --- format / destination ----------------------------------------------
  const [format, setFormat] = React.useState<ExportFormat>(defaultFormat ?? 'csv');
  const [toFile, setToFile] = React.useState(false);
  const [path, setPath] = React.useState('');
  const [touchedPath, setTouchedPath] = React.useState(false);

  // --- options (§7.4) -----------------------------------------------------
  const [gzip, setGzip] = React.useState(false);
  const [structure, setStructure] = React.useState<ExportOptions['structure']>('both');
  const [binaryEncoding, setBinaryEncoding] = React.useState<ExportOptions['binaryEncoding']>('base64');
  const [nullLiteral, setNullLiteral] = React.useState('');
  const [delimiter, setDelimiter] = React.useState(',');
  const [header, setHeader] = React.useState(true);
  const [batchSize, setBatchSize] = React.useState('1000');

  // --- advanced (§7.2, §7.5, §8.4) ---------------------------------------
  const [advanced, setAdvanced] = React.useState(false);
  const [useNativeTool, setUseNativeTool] = React.useState(false);
  const [remoteSide, setRemoteSide] = React.useState(false);
  const [stripDefiner, setStripDefiner] = React.useState(true);
  const [pgFormat, setPgFormat] = React.useState<'custom' | 'plain'>('custom');

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; hint?: string } | null>(null);

  // Reset to whatever the caller preselected each time the dialog opens.
  //
  // Every field that *identifies the object* is cleared unconditionally, not
  // just reassigned when the caller supplies one. One instance of this dialog
  // serves the tree, the grid, the editor and the palette (see transfer-host),
  // so a partial reset means right-clicking `public.orders` → Export → Cancel,
  // then opening Export from the palette, offers to export `orders` again —
  // with the previous destination path still in the box.
  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setTouchedPath(false);
    setChooseTables(false);
    setPickedTables([]);
    setStatement('');
    setSchemaName('');
    setTableName('');
    setWhere('');
    setDatabase('');
    setPath('');
    setFormat(defaultFormat ?? 'csv');
    // Connection-dependent, so they cannot carry across a change of target.
    setRemoteSide(false);
    setUseNativeTool(false);
    const src = initialSource ?? (sql && sql.trim() !== '' ? ({ kind: 'query', sql } as const) : null);
    if (src) {
      setScope(src.kind);
      if (src.kind === 'query') setStatement(src.sql);
      if (src.kind === 'table') {
        setSchemaName(src.schema ?? '');
        setTableName(src.table);
        setWhere(src.where ?? '');
      }
      if (src.kind === 'database') {
        setDatabase(src.database);
        setPickedTables(src.tables ?? []);
      }
    } else {
      setScope('table');
      setStatement(sql ?? '');
    }
    // Keyed on `open`: edits inside the dialog must survive a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Table lists cost a full introspection, so they are fetched only once the
  // user asks for the picker (§4 "mounting a panel must never introspect").
  const schemaScope = React.useMemo(
    () => (database.trim() !== '' ? { database: database.trim() } : undefined),
    [database],
  );
  const schema = useSchema(connectionId, { scope: schemaScope, enabled: open && chooseTables && scope === 'database' });
  const availableTables = React.useMemo(() => {
    if (!schema.model) return [];
    return allTables(schema.model).map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
  }, [schema.model]);

  const nativeTools = useNativeTools(open && advanced);
  const missingTools = missingDumpTools(engine, nativeTools.data?.tools);

  const source = React.useMemo((): ExportRequest['source'] => {
    switch (scope) {
      case 'query':
        return { kind: 'query', sql: statement };
      case 'table':
        return {
          kind: 'table',
          schema: schemaName.trim() === '' ? undefined : schemaName.trim(),
          table: tableName.trim(),
          where: where.trim() === '' ? undefined : where.trim(),
        };
      case 'database':
        return {
          kind: 'database',
          database: database.trim(),
          tables: pickedTables.length > 0 ? pickedTables : undefined,
        };
      case 'server':
        return { kind: 'server' };
    }
  }, [scope, statement, schemaName, tableName, where, database, pickedTables]);

  const suggestedName = React.useMemo(
    () => suggestFilename(source, format, gzip),
    [source, format, gzip],
  );

  // Keep the destination in step with the format until the user edits it.
  React.useEffect(() => {
    if (!open || !toFile || touchedPath) return;
    setPath(suggestedName);
  }, [open, toFile, touchedPath, suggestedName]);

  const sqlFormat = format === 'sql';
  const delimited = DELIMITED.has(format);
  const headered = HEADERED.has(format);
  const documentEngine = engine === 'mongodb';
  /** An emptied box means "the default for this format", never "no separator". */
  const effectiveDelimiter = delimiter === '' ? (format === 'tsv' ? '\t' : ',') : delimiter;
  const problems = validate({
    connectionId,
    scope,
    statement,
    tableName,
    database,
    toFile,
    path,
    format,
    documentEngine,
    schemaName,
  });

  async function submit(): Promise<void> {
    if (!connectionId || problems.length > 0) return;
    const options: ExportOptions = {
      compression: gzip ? 'gzip' : 'none',
      // Only a SQL dump has a DDL half; the server degrades the rest to `both`.
      structure: sqlFormat ? structure : 'both',
      binaryEncoding,
      nullLiteral,
      // `''` is not nullish, so it would survive the writer's `?? ','` default
      // and configure csv-stringify with a zero-length separator — every row
      // written as `1JohnActive`, a green job, and an unparseable file.
      delimiter: delimited ? effectiveDelimiter : undefined,
      header: headered ? header : undefined,
      batchSize: parsePositive(batchSize),
      // Native delegation and the remote-side dump are job-only: the download
      // path streams through the built-in engine and never calls `nativeDump`,
      // so sending them here would promise fidelity the response cannot give.
      useNativeTool: toFile ? useNativeTool || undefined : undefined,
      remoteSide: toFile ? remoteSide || undefined : undefined,
      stripDefiner: toFile && isMysql(engine) ? stripDefiner : undefined,
      pgFormat: toFile && engine === 'postgres' && sqlFormat ? pgFormat : undefined,
    };

    const request: ExportRequest = {
      connectionId,
      source,
      format,
      destination: toFile ? { kind: 'file', path } : { kind: 'download' },
      options,
    };

    if (!toFile) {
      // A form POST, not fetch(): the transfer belongs to the browser so the
      // export streams straight to disk without ever being buffered (§7.4).
      // It answers into a hidden frame, so a refusal comes back here rather
      // than navigating the app away — but it arrives after this closes.
      downloadExport('/api/export/download', request, (message, hint) => {
        toast.error('The export was refused', { description: hint ? `${message} ${hint}` : message });
      });
      toast.success('Download started', { description: 'The browser will save the file as it streams in.' });
      onClose();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { jobId } = await api.post<{ jobId: string }>('/api/export', request);
      toast.success('Export started', { description: `Writing ${path}` });
      // §7.3: the work outlives this dialog, so hand the user the drawer.
      openJobsDrawer(jobId);
      onClose();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Could not start the export',
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
      title="Export"
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={problems.length > 0}
            icon={toFile ? <HardDriveDownload className="size-3.5" /> : <Download className="size-3.5" />}
            onClick={() => void submit()}
          >
            {toFile ? 'Start export' : 'Download'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* --- scope (§7.1) --- */}
        <Field label="What to export">
          <div className="flex flex-wrap items-center gap-1">
            <ScopeButton
              id="query"
              active={scope}
              onSelect={setScope}
              disabled={!statement && !sql}
              icon={<Terminal className="size-3" />}
              label="Current result"
            />
            <ScopeButton id="table" active={scope} onSelect={setScope} icon={<Table2 className="size-3" />} label={documentEngine ? 'Collection' : 'Table'} />
            <ScopeButton
              id="database"
              active={scope}
              onSelect={setScope}
              icon={<Database className="size-3" />}
              label="Whole database"
            />
            <ScopeButton id="server" active={scope} onSelect={setScope} icon={<Server className="size-3" />} label="Whole server" />
          </div>
        </Field>

        {scope === 'query' && (
          <Field label="Statement" hint="Exactly the rows this statement returns are exported, streamed by cursor.">
            <Textarea
              className="h-20"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}

        {scope === 'table' && (
          <div className="grid grid-cols-3 gap-2">
            <Field label={documentEngine ? 'Database' : 'Schema'} hint={documentEngine ? 'Required for MongoDB.' : 'Optional'}>
              <Input className="mono" value={schemaName} onChange={(e) => setSchemaName(e.target.value)} />
            </Field>
            <Field label={documentEngine ? 'Collection' : 'Table'}>
              <Input className="mono" value={tableName} onChange={(e) => setTableName(e.target.value)} />
            </Field>
            <Field label={documentEngine ? 'Filter (JSON)' : 'WHERE'} hint="Optional; exports a subset.">
              <Input
                className="mono"
                value={where}
                placeholder={documentEngine ? '{ "status": "open" }' : 'created_at >= …'}
                onChange={(e) => setWhere(e.target.value)}
              />
            </Field>
          </div>
        )}

        {scope === 'database' && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Database">
                <Input className="mono" value={database} onChange={(e) => setDatabase(e.target.value)} />
              </Field>
              <Field
                label={documentEngine ? 'Collections' : 'Tables'}
                hint={
                  documentEngine
                    ? 'MongoDB has no schema model to list — every collection is exported.'
                    : 'All tables unless you pick a subset.'
                }
              >
                {/* The picker reads the canonical SchemaModel, which getSchema
                    refuses to build for a document engine — so offering the
                    button on Mongo only ever produces a red error box. */}
                <Button size="sm" disabled={documentEngine} onClick={() => setChooseTables((v) => !v)}>
                  {chooseTables ? 'Hide table list' : `Choose tables${pickedTables.length ? ` (${pickedTables.length})` : ''}`}
                </Button>
              </Field>
            </div>
            {chooseTables && (
              <div className="max-h-40 overflow-y-auto border border-[var(--border)] p-1.5">
                {schema.isPending && (
                  <span className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
                    <Spinner className="size-3" /> Reading the schema…
                  </span>
                )}
                {schema.error && <ErrorBox message={schema.error.message} />}
                {!schema.isPending && !schema.error && availableTables.length === 0 && (
                  <p className="text-[11px] text-[var(--fg-subtle)]">No tables found in this database.</p>
                )}
                <div className="grid grid-cols-3 gap-x-3">
                  {availableTables.map((name) => (
                    <Checkbox
                      key={name}
                      className="text-[11px]"
                      checked={pickedTables.includes(name)}
                      onChange={(e) =>
                        setPickedTables((prev) => (e.target.checked ? [...prev, name] : prev.filter((t) => t !== name)))
                      }
                      label={<span className="mono truncate">{name}</span>}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {scope === 'server' && (
          <p className="border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5 text-[11px] leading-snug text-[var(--fg-muted)]">
            Every database this connection can see, in one archive. On a large server this is a job you start and walk
            away from — pick a file destination so it survives a page reload.
          </p>
        )}

        <Separator />

        {/* --- format + destination --- */}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Format">
            <Select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Destination">
            <div className="flex items-center gap-1">
              <Button size="sm" variant={!toFile ? 'primary' : 'subtle'} className="flex-1" onClick={() => setToFile(false)}>
                Download in the browser
              </Button>
              <Button size="sm" variant={toFile ? 'primary' : 'subtle'} className="flex-1" onClick={() => setToFile(true)}>
                File on the server
              </Button>
            </div>
          </Field>
        </div>

        {toFile ? (
          <Field
            label="Export file"
            hint="A container path inside the export root — Browse shows which host directory that is."
          >
            <FilePathField
              value={path}
              onChange={(p) => {
                setTouchedPath(true);
                setPath(p);
              }}
              root="export"
              mode="save"
              defaultName={suggestedName}
              placeholder={suggestedName}
              pickerTitle="Choose where to write the export"
            />
          </Field>
        ) : (
          <p className="text-[11px] leading-snug text-[var(--fg-subtle)]">
            The file streams straight into your browser&apos;s download — nothing is buffered on the server or in the
            page, so the size of the result does not matter. A dump that runs for hours belongs in a file destination
            instead, because closing the tab cancels a download.
          </p>
        )}

        <Separator />

        {/* --- options (§7.4) --- */}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Content" hint={sqlFormat ? 'Structure means CREATE statements.' : 'SQL format only.'}>
            <Select
              value={structure}
              disabled={!sqlFormat}
              onChange={(e) => setStructure(e.target.value as ExportOptions['structure'])}
            >
              <option value="both">Structure and data</option>
              <option value="structure-only">Structure only</option>
              <option value="data-only">Data only</option>
            </Select>
          </Field>
          <Field label="Compression">
            <Checkbox checked={gzip} onChange={(e) => setGzip(e.target.checked)} label="gzip the stream (.gz)" />
          </Field>
        </div>

        {/* §7.4: the single most common source of silently corrupted dumps. */}
        <Field
          label="Binary encoding"
          hint="How BLOB / bytea / BSON binary values are written into a text format. Pick the one whatever reads this file expects — a mismatch corrupts every binary column silently, and nothing about the file will look wrong."
        >
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={binaryEncoding === 'base64' ? 'primary' : 'subtle'}
              className="flex-1"
              onClick={() => setBinaryEncoding('base64')}
            >
              base64
            </Button>
            <Button
              size="sm"
              variant={binaryEncoding === 'hex' ? 'primary' : 'subtle'}
              className="flex-1"
              onClick={() => setBinaryEncoding('hex')}
            >
              hex
            </Button>
            <span className="ml-2 flex-1 text-[11px] leading-snug text-[var(--fg-subtle)]">
              {binaryEncoding === 'base64'
                ? 'Compact and the safe default for CSV/JSON round-trips through this app.'
                : 'Verbose but readable, and what MySQL/Postgres literals (0x…, \\x…) expect in a SQL dump.'}
            </span>
          </div>
        </Field>

        <div className="grid grid-cols-4 gap-2">
          <Field label="NULL literal" hint="Empty = the format's own null.">
            <Input className="mono" value={nullLiteral} onChange={(e) => setNullLiteral(e.target.value)} placeholder="" />
          </Field>
          <Field
            label="Delimiter"
            hint={!delimited ? 'CSV only.' : delimiter === '' ? `Empty — using ${format === 'tsv' ? 'tab' : 'comma'}.` : undefined}
          >
            <Input
              className="mono"
              value={delimiter}
              disabled={!delimited}
              maxLength={1}
              onChange={(e) => setDelimiter(e.target.value)}
            />
          </Field>
          <Field label="Header row">
            <Checkbox
              checked={header}
              disabled={!headered}
              onChange={(e) => setHeader(e.target.checked)}
              label="Write column names"
            />
          </Field>
          <Field label="Batch size" hint="Rows per fetch / INSERT.">
            <Input
              className="mono"
              inputMode="numeric"
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
        </div>

        {/* --- advanced (§7.2, §7.5, §8.4) --- */}
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="flex items-center gap-1 self-start text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          <ChevronRight className={cn('size-3 transition-transform', advanced && 'rotate-90')} />
          Advanced
          {(useNativeTool || remoteSide) && <Badge tone="accent">on</Badge>}
        </button>

        {advanced && (
          <div className="flex flex-col gap-3 border border-[var(--border)] bg-[var(--bg-subtle)] p-2">
            {!toFile && (
              <p className="border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[11px] leading-snug text-[var(--fg-muted)]">
                These apply to a <strong>file on the server</strong> only. A browser download always streams through the
                built-in engine, so switch the destination to use <code className="mono">mysqldump</code>/
                <code className="mono">pg_dump</code> or a remote-side dump.
              </p>
            )}
            <div className="flex flex-col gap-1">
              <Checkbox
                checked={useNativeTool}
                disabled={!toFile}
                onChange={(e) => setUseNativeTool(e.target.checked)}
                label="Use the bundled native tool (mysqldump / pg_dump / mongodump)"
              />
              <p className="pl-6 text-[11px] leading-snug text-[var(--fg-subtle)]">
                Best fidelity for a full dump — definers, collations, partitions, extensions and routines all survive.
                It cannot do filtered exports or format conversion, so the server falls back to the built-in streaming
                engine whenever the request needs one.
              </p>
              <div className="pl-6">
                <NativeToolsPanel engine={engine} compact />
              </div>
              {useNativeTool && missingTools.length > 0 && (
                <p className="pl-6 text-[11px] text-[var(--warn)]">
                  {missingTools.join(', ')} is not on PATH, so this export will run on the built-in engine anyway.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Checkbox
                checked={remoteSide}
                disabled={!viaSsh || !toFile}
                onChange={(e) => setRemoteSide(e.target.checked)}
                label="Run the dump on the remote host and stream compressed bytes back"
              />
              <p className="pl-6 text-[11px] leading-snug text-[var(--fg-subtle)]">
                {viaSsh ? (
                  <>
                    Instead of pulling every row across the link uncompressed, the dump runs beside the database over
                    SSH (<code className="mono">mysqldump … | gzip -1</code>) and only the compressed bytes travel.
                    Often 5–10× faster on a slow link. The tool has to exist on the remote host; if it does not, the
                    export falls back to running locally.
                  </>
                ) : (
                  <>This connection is direct, so there is no remote host to run the dump on. Add an SSH hop to the connection to enable it.</>
                )}
              </p>
            </div>

            {isMysql(engine) && (
              <div className="flex flex-col gap-1">
                <Checkbox
                  checked={stripDefiner}
                  onChange={(e) => setStripDefiner(e.target.checked)}
                  label="Strip DEFINER clauses"
                />
                <p className="pl-6 text-[11px] leading-snug text-[var(--fg-subtle)]">
                  MySQL embeds <code className="mono">DEFINER=user@host</code> in views, routines and triggers, which
                  fails to restore on any other host. Leave this on unless you are restoring onto the same server.
                </p>
              </div>
            )}

            {engine === 'postgres' && (
              <Field
                label="pg_dump format"
                hint="Custom lets pg_restore do selective and parallel restores; plain is readable SQL. Applies to a SQL dump run through pg_dump."
              >
                <Select
                  value={pgFormat}
                  disabled={!sqlFormat}
                  onChange={(e) => setPgFormat(e.target.value as 'custom' | 'plain')}
                >
                  <option value="custom">Custom (-Fc)</option>
                  <option value="plain">Plain SQL</option>
                </Select>
              </Field>
            )}
          </div>
        )}

        {problems.length > 0 && (
          <ul className="list-inside list-disc text-[11px] text-[var(--warn)]">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        {error && <ErrorBox title="Could not start the export" message={error.message} hint={error.hint} />}
      </div>
    </Dialog>
  );
}

function ScopeButton({
  id,
  active,
  onSelect,
  icon,
  label,
  disabled,
}: {
  id: ScopeKind;
  active: ScopeKind;
  onSelect: (id: ScopeKind) => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant={active === id ? 'primary' : 'subtle'}
      icon={icon}
      disabled={disabled}
      onClick={() => onSelect(id)}
    >
      {label}
    </Button>
  );
}

function isMysql(engine: EngineKind | null): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

function parsePositive(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/** Mirrors the server's own naming so a download and a file export match. */
function suggestFilename(source: ExportRequest['source'], format: ExportFormat, gzip: boolean): string {
  const stem =
    source.kind === 'table'
      ? source.schema
        ? `${source.schema}.${source.table}`
        : source.table
      : source.kind === 'database'
        ? source.database
        : source.kind === 'server'
          ? 'server'
          : 'query';
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'export';
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const ext = FORMATS.find((f) => f.id === format)?.ext ?? 'txt';
  return `${safe}-${stamp}.${ext}${gzip ? '.gz' : ''}`;
}

/**
 * Everything the server would reject, caught here instead — because the
 * download destination is a form POST into a hidden frame, so a 400 surfaces as
 * a toast well after the dialog has closed and claimed success. Each of these
 * mirrors a specific server-side refusal (api/export/build.ts, transfer/export).
 */
function validate(state: {
  connectionId: string | null;
  scope: ScopeKind;
  statement: string;
  tableName: string;
  database: string;
  toFile: boolean;
  path: string;
  format: ExportFormat;
  documentEngine: boolean;
  schemaName: string;
}): string[] {
  const out: string[] = [];
  if (!state.connectionId) out.push('Pick a connection first.');
  if (state.scope === 'query' && state.statement.trim() === '') out.push('There is no statement to export.');
  if (state.scope === 'table' && state.tableName.trim() === '') out.push('Name the table to export.');
  if (state.scope === 'database' && state.database.trim() === '') out.push('Name the database to export.');
  if (state.toFile && state.path.trim() === '') out.push('Choose a destination file.');
  // build.ts refuses a Mongo collection with no database to look it up in.
  if (state.documentEngine && state.scope === 'table' && state.schemaName.trim() === '') {
    out.push('Name the MongoDB database the collection lives in.');
  }
  // runExport refuses this: concatenated JSON arrays are not a JSON document,
  // and neither route ever uses a directory destination.
  if (state.format === 'json' && (state.scope === 'database' || state.scope === 'server')) {
    out.push('A JSON export covers one table or query at a time — use NDJSON for a whole database.');
  }
  return out;
}
