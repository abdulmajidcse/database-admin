'use client';

/**
 * The expanded cell viewer (PLAN §6).
 *
 * A 4 KB JSON document, a 200-line log message and a PNG all arrive in the same
 * one-line cell; this is where they become readable. The mode is chosen from
 * the value itself — a tagged `bytes` cell whose first bytes sniff as an image
 * is shown as an image, JSON is pretty-printed and collapsible, everything else
 * binary gets a hex dump with an ASCII gutter.
 */

import * as React from 'react';
import { Braces, Check, Clipboard, Image as ImageIcon, ScrollText, WrapText } from 'lucide-react';
import type { ColumnMeta } from '../../lib/results';
import { base64ToBytes, cellToText, isTagged, type Cell } from '../../lib/wire';
import { Badge, Button, Dialog, Tabs, cn, type TabItem } from '../ui/primitives';

type ViewerMode = 'image' | 'json' | 'text' | 'hex';

/** Magic-number sniff. Only the four formats a browser will certainly render. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === '' || !/^[[{]/.test(trimmed)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 16 bytes per line, offset + hex + printable ASCII. */
function hexDump(bytes: Uint8Array, limit: number): string {
  const end = Math.min(bytes.length, limit);
  const lines: string[] = [];
  for (let off = 0; off < end; off += 16) {
    const slice = bytes.subarray(off, Math.min(off + 16, end));
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        hex += slice[i].toString(16).padStart(2, '0') + (i === 7 ? '  ' : ' ');
        ascii += slice[i] >= 0x20 && slice[i] < 0x7f ? String.fromCharCode(slice[i]) : '.';
      } else {
        hex += i === 7 ? '    ' : '   ';
        ascii += ' ';
      }
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON tree
// ---------------------------------------------------------------------------

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  // Two levels open is the useful default: the shape is visible, a big document
  // does not explode into thousands of lines.
  const [open, setOpen] = React.useState(depth < 2);

  const label = name === undefined ? null : <span className="text-[var(--accent)]">{name}: </span>;

  if (value === null) return <div style={{ paddingLeft: depth * 12 }}>{label}<span className="null-cell">null</span></div>;
  if (typeof value === 'string') {
    return (
      <div style={{ paddingLeft: depth * 12 }} className="whitespace-pre-wrap break-all">
        {label}
        <span className="text-[var(--ok)]">&quot;{value}&quot;</span>
      </div>
    );
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return (
      <div style={{ paddingLeft: depth * 12 }}>
        {label}
        <span className="text-[var(--warn)]">{String(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}'];

  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-left hover:bg-[var(--bg-hover)]"
      >
        {label}
        <span className="text-[var(--fg-muted)]">
          {openBrace}
          {open ? '' : ` … ${entries.length} `}
          {open ? '' : closeBrace}
        </span>
        {!open && <span className="ml-1 text-[10px] text-[var(--fg-subtle)]">{isArray ? 'items' : 'keys'}</span>}
      </button>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode key={k} name={isArray ? undefined : k} value={v} depth={depth + 1} />
          ))}
          <div className="text-[var(--fg-muted)]">{closeBrace}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export interface CellViewerProps {
  open: boolean;
  onClose: () => void;
  cell: Cell;
  column?: ColumnMeta;
  /** e.g. "users.payload — row 42". */
  title?: string;
  editable?: boolean;
  /** Receives the edited text (base64 for binary), same shape the editor uses. */
  onSave?: (text: string) => void;
}

const HEX_LIMIT = 64 * 1024;

export function CellViewer({ open, onClose, cell, column, title, editable, onSave }: CellViewerProps) {
  const bytes = React.useMemo(() => {
    if (cell !== null && isTagged(cell) && cell.$t === 'bytes') {
      try {
        return base64ToBytes(cell.v);
      } catch {
        return null;
      }
    }
    return null;
  }, [cell]);

  const raw = React.useMemo(() => cellToText(cell, 'base64') ?? '', [cell]);
  const imageMime = React.useMemo(() => (bytes ? sniffImage(bytes) : null), [bytes]);
  const json = React.useMemo(() => (bytes ? { ok: false as const } : parseJson(raw)), [bytes, raw]);

  const modes = React.useMemo(() => {
    const list: ViewerMode[] = [];
    if (imageMime) list.push('image');
    if (json.ok) list.push('json');
    list.push('text');
    if (bytes) list.push('hex');
    return list;
  }, [imageMime, json.ok, bytes]);

  const [mode, setMode] = React.useState<ViewerMode>(modes[0]);
  const [wrap, setWrap] = React.useState(true);
  const [draft, setDraft] = React.useState(raw);
  const [copied, setCopied] = React.useState(false);

  // The dialog is reused for whatever cell the grid points at next.
  const [seen, setSeen] = React.useState<Cell>(cell);
  if (seen !== cell) {
    setSeen(cell);
    setDraft(raw);
    setMode(modes[0]);
  }

  if (!open) return null;

  const label: Record<ViewerMode, React.ReactNode> = {
    image: (
      <span className="flex items-center gap-1">
        <ImageIcon className="size-3" />
        Image
      </span>
    ),
    json: (
      <span className="flex items-center gap-1">
        <Braces className="size-3" />
        JSON
      </span>
    ),
    text: (
      <span className="flex items-center gap-1">
        <ScrollText className="size-3" />
        {bytes ? 'Base64' : 'Text'}
      </span>
    ),
    hex: <span>Hex</span>,
  };

  const tabs: TabItem[] = modes.map((m) => ({ id: m, label: label[m] }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mode === 'hex' && bytes ? hexDump(bytes, HEX_LIMIT) : raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const size = bytes ? `${bytes.length} bytes` : `${raw.length} chars`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={
        <span className="flex items-center gap-2">
          {title ?? column?.name ?? 'Value'}
          {column && <Badge>{column.typeName}</Badge>}
          {cell === null && <Badge tone="neutral">NULL</Badge>}
          <span className="text-[11px] font-normal text-[var(--fg-subtle)]">{size}</span>
        </span>
      }
      footer={
        <>
          <Button icon={copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {editable && onSave && (
            <Button
              variant="primary"
              onClick={() => {
                onSave(draft);
                onClose();
              }}
              disabled={draft === raw}
            >
              Set value
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="flex h-[60vh] flex-col gap-2">
        <Tabs
          items={tabs}
          active={mode}
          onSelect={(id) => setMode(id as ViewerMode)}
          right={
            mode === 'text' && (
              <Button
                size="xs"
                variant={wrap ? 'subtle' : 'ghost'}
                icon={<WrapText className="size-3" />}
                onClick={() => setWrap((w) => !w)}
              >
                Wrap
              </Button>
            )
          }
        />

        <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--border)] bg-[var(--bg)]">
          {mode === 'image' && imageMime && (
            <div className="flex h-full items-center justify-center p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI from the row, not an asset */}
              <img
                src={`data:${imageMime};base64,${isTagged(cell) ? cell.v : ''}`}
                alt={column?.name ?? 'cell value'}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}

          {mode === 'json' && json.ok && (
            <div className="mono p-2 leading-relaxed">
              <JsonNode value={json.value} depth={0} />
            </div>
          )}

          {mode === 'text' &&
            (editable && onSave ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className={cn(
                  'mono h-full w-full resize-none bg-transparent p-2 text-[var(--fg)] outline-none',
                  wrap ? 'whitespace-pre-wrap' : 'whitespace-pre',
                )}
              />
            ) : cell === null ? (
              <div className="null-cell p-2">NULL</div>
            ) : (
              <pre className={cn('mono p-2 text-[var(--fg)]', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                {raw}
              </pre>
            ))}

          {mode === 'hex' && bytes && (
            <pre className="mono whitespace-pre p-2 text-[var(--fg-muted)]">
              {hexDump(bytes, HEX_LIMIT)}
              {bytes.length > HEX_LIMIT ? `\n… ${bytes.length - HEX_LIMIT} more bytes` : ''}
            </pre>
          )}
        </div>
      </div>
    </Dialog>
  );
}
