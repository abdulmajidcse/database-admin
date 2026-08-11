'use client';

/**
 * Connection editor (PLAN §4, §8, §10.3).
 *
 * The form is built on the two orthogonal unions the model actually has:
 *
 *   Address — WHERE the database is: tcp host/port, a unix socket, a SQLite file
 *             on disk, or a URI (mongodb+srv://…).
 *   Access  — HOW we reach it: direct, through a chain of SSH hops, or through a
 *             proxy process we spawn.
 *
 * A flat host/port/user/password form cannot express any of the interesting
 * cases, so the two sections are separate and switch independently.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  FileText,
  FolderOpen,
  Network,
  Plug,
  Plus,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import type { ConnectionUpsertRequest, TestConnectionResponse } from '../../lib/api-types';
import {
  addressIsLoopback,
  DEFAULT_PORTS,
  ENGINE_LABELS,
  type Access,
  type Address,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionOptions,
  type EnvTag,
  type SshHop,
  type TlsConfig,
  type TlsVerifyMode,
} from '../../lib/connection';
import type { EngineKind } from '../../lib/schema-model';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  cn,
} from '../ui/primitives';
import { useVaultStatus } from './auth-gate';

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

const ENGINES: EngineKind[] = ['postgres', 'mysql', 'mariadb', 'sqlite', 'redis', 'mongodb'];

/** Which Address variants each engine can actually use. */
const ADDRESS_KINDS: Record<EngineKind, Address['kind'][]> = {
  postgres: ['tcp', 'unix', 'uri'],
  mysql: ['tcp', 'unix', 'uri'],
  mariadb: ['tcp', 'unix', 'uri'],
  sqlite: ['file'],
  redis: ['tcp', 'unix', 'uri'],
  mongodb: ['tcp', 'uri'],
};

const ADDRESS_LABELS: Record<Address['kind'], string> = {
  tcp: 'Host + port',
  unix: 'Unix socket',
  file: 'File',
  uri: 'URI',
};

/** Connection colours are data on the row, not theme styling — CSS names keep them literal-free. */
const COLOR_CHOICES = [
  'tomato',
  'darkorange',
  'goldenrod',
  'mediumseagreen',
  'steelblue',
  'slateblue',
  'orchid',
  'slategray',
];

export function defaultAddressFor(engine: EngineKind, isContainer = false): Address {
  if (engine === 'sqlite') return { kind: 'file', path: '', mode: 'rw' };
  // §10.3: inside a container the useful default is the host bridge, not a
  // loopback address that points back at this very container.
  return { kind: 'tcp', host: isContainer ? 'host.docker.internal' : 'localhost', port: DEFAULT_PORTS[engine] };
}

export function blankConnectionInput(engine: EngineKind = 'postgres', isContainer = false): ConnectionInput {
  return {
    name: '',
    engine,
    address: defaultAddressFor(engine, isContainer),
    access: { via: 'direct' },
    username: '',
    tls: { enabled: false, verify: 'verify-full' },
    options: {},
    readOnly: false,
    envTag: 'dev',
    color: undefined,
    sortOrder: 0,
  };
}

/** Strip the server-owned fields; secrets are write-only and never come back. */
export function connectionToInput(config: ConnectionConfig): ConnectionInput {
  return {
    name: config.name,
    engine: config.engine,
    address: config.address,
    access: config.access,
    username: config.username,
    tls: config.tls ?? { enabled: false, verify: 'verify-full' },
    options: config.options ?? {},
    readOnly: config.readOnly,
    envTag: config.envTag,
    color: config.color,
    sortOrder: config.sortOrder,
  };
}

const EMPTY_TLS: TlsConfig = { enabled: false, verify: 'verify-full' };

function newHop(): SshHop {
  return { host: '', port: 22, username: '', auth: 'agent' };
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export interface ConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  /** Connection being edited; null/undefined creates a new one. */
  connection?: ConnectionConfig | null;
  /** Prefilled values for a duplicate (create mode with a starting point). */
  initial?: ConnectionInput | null;
  onSaved?: (connection: ConnectionConfig) => void;
}

export function ConnectionDialog({ open, onClose, connection, initial, onSaved }: ConnectionDialogProps) {
  const vault = useVaultStatus();
  const isContainer = vault.data?.isContainer ?? false;
  const sqliteRoot = vault.data?.sqliteRoot ?? '/data/sqlite';
  const client = useQueryClient();

  const [input, setInput] = React.useState<ConnectionInput>(() => blankConnectionInput('postgres', isContainer));
  /** undefined = leave the stored secret alone, null = clear it, string = set it. */
  const [password, setPassword] = React.useState<string | null | undefined>(undefined);
  const [sshSecrets, setSshSecrets] = React.useState<(string | null)[]>([]);
  const [testResult, setTestResult] = React.useState<TestConnectionResponse | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [browsing, setBrowsing] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setInput(connection ? connectionToInput(connection) : (initial ?? blankConnectionInput('postgres', isContainer)));
    setPassword(undefined);
    setSshSecrets([]);
    setTestResult(null);
    setSaveError(null);
  }, [open, connection, initial, isContainer]);

  const patch = (p: Partial<ConnectionInput>) => setInput((s) => ({ ...s, ...p }));
  const patchAddress = (p: Partial<Address>) => setInput((s) => ({ ...s, address: { ...s.address, ...p } as Address }));
  const patchOptions = (p: Partial<ConnectionOptions>) =>
    setInput((s) => ({ ...s, options: { ...s.options, ...p } }));
  const patchTls = (p: Partial<TlsConfig>) => setInput((s) => ({ ...s, tls: { ...(s.tls ?? EMPTY_TLS), ...p } }));

  function changeEngine(engine: EngineKind): void {
    setInput((s) => {
      const kinds = ADDRESS_KINDS[engine];
      let address = s.address;
      if (!kinds.includes(address.kind)) {
        address = defaultAddressFor(engine, isContainer);
      } else if (address.kind === 'tcp' && address.port === DEFAULT_PORTS[s.engine]) {
        address = { ...address, port: DEFAULT_PORTS[engine] };
      }
      // A SQLite file is opened by this process; there is nothing to tunnel.
      const access: Access = address.kind === 'file' ? { via: 'direct' } : s.access;
      return { ...s, engine, address, access };
    });
    setTestResult(null);
  }

  function changeAddressKind(kind: Address['kind']): void {
    setInput((s) => {
      if (s.address.kind === kind) return s;
      let address: Address;
      switch (kind) {
        case 'tcp':
          address = { kind: 'tcp', host: isContainer ? 'host.docker.internal' : 'localhost', port: DEFAULT_PORTS[s.engine] };
          break;
        case 'unix':
          address = { kind: 'unix', socketPath: s.engine === 'postgres' ? '/var/run/postgresql/.s.PGSQL.5432' : '/tmp/mysql.sock' };
          break;
        case 'file':
          address = { kind: 'file', path: '', mode: 'rw' };
          break;
        case 'uri':
          address = { kind: 'uri', uri: '' };
          break;
      }
      return { ...s, address, access: address.kind === 'file' ? { via: 'direct' } : s.access };
    });
    setTestResult(null);
  }

  function changeAccess(via: Access['via']): void {
    setInput((s) => {
      if (s.access.via === via) return s;
      const access: Access =
        via === 'direct'
          ? { via: 'direct' }
          : via === 'ssh'
            ? { via: 'ssh', hops: [newHop()] }
            : { via: 'process', argv: [], readyTimeoutMs: 10_000 };
      return { ...s, access };
    });
  }

  const hops = input.access.via === 'ssh' ? input.access.hops : [];
  function setHops(next: SshHop[]): void {
    setInput((s) => (s.access.via === 'ssh' ? { ...s, access: { via: 'ssh', hops: next } } : s));
  }

  const payload = React.useMemo<ConnectionUpsertRequest & { id?: string }>(() => {
    const body: ConnectionInput & { id?: string } = { ...input };
    if (password !== undefined) body.password = password;
    if (sshSecrets.some((s) => s)) body.sshSecrets = sshSecrets;
    if (connection) body.id = connection.id;
    return body;
  }, [input, password, sshSecrets, connection]);

  const problems = validate(input);

  const test = useMutation<TestConnectionResponse>({
    mutationFn: () => api.post<TestConnectionResponse>('/api/connections/test', payload),
    onSuccess: (res) => setTestResult(res),
    onError: (err) => setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  });

  const save = useMutation<ConnectionConfig>({
    mutationFn: () =>
      connection
        ? api.put<ConnectionConfig>(`/api/connections/${connection.id}`, payload)
        : api.post<ConnectionConfig>('/api/connections', payload),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: ['connections'] });
      onSaved?.(saved);
      onClose();
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)),
  });

  const loopbackWarning = isContainer && addressIsLoopback(input.address);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width="lg"
        title={connection ? `Edit connection — ${connection.name}` : 'New connection'}
        footer={
          <>
            <div className="mr-auto flex items-center gap-2">
              <Button
                onClick={() => {
                  setTestResult(null);
                  test.mutate();
                }}
                loading={test.isPending}
                disabled={problems.length > 0}
                icon={<Plug className="size-3.5" />}
              >
                Test connection
              </Button>
              {problems.length > 0 && <span className="text-[11px] text-[var(--fg-subtle)]">{problems[0]}</span>}
            </div>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={problems.length > 0}
              loading={save.isPending}
              onClick={() => {
                setSaveError(null);
                save.mutate();
              }}
            >
              {connection ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {/* --- identity ------------------------------------------------ */}
          <Section title="Connection">
            <div className="grid grid-cols-12 gap-3">
              <Field label="Name" className="col-span-5">
                <Input
                  value={input.name}
                  autoFocus
                  placeholder="Local Postgres"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Engine" className="col-span-3">
                <Select value={input.engine} onChange={(e) => changeEngine(e.target.value as EngineKind)}>
                  {ENGINES.map((e) => (
                    <option key={e} value={e}>
                      {ENGINE_LABELS[e]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Environment" className="col-span-2">
                <Select value={input.envTag} onChange={(e) => patch({ envTag: e.target.value as EnvTag })}>
                  <option value="dev">dev</option>
                  <option value="staging">staging</option>
                  <option value="prod">prod</option>
                </Select>
              </Field>
              <Field label="Colour" className="col-span-2">
                <div className="flex h-7 items-center gap-1">
                  {COLOR_CHOICES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      onClick={() => patch({ color: input.color === c ? undefined : c })}
                      style={{ background: c }}
                      className={cn(
                        'size-3.5 rounded-full border',
                        input.color === c ? 'border-[var(--fg)] ring-1 ring-[var(--fg)]' : 'border-transparent',
                      )}
                    />
                  ))}
                </div>
              </Field>
            </div>
            {input.envTag === 'prod' && (
              <p className="mt-2 text-[11px] text-[var(--warn)]">
                Production connections get a coloured header and a stricter confirm on destructive statements (§9).
              </p>
            )}
          </Section>

          {/* --- address ------------------------------------------------- */}
          <Section
            title="Address"
            description="Where the database is. This is independent of how we reach it."
            right={
              <Segmented
                value={input.address.kind}
                options={ADDRESS_KINDS[input.engine].map((k) => ({ value: k, label: ADDRESS_LABELS[k] }))}
                onChange={(v) => changeAddressKind(v as Address['kind'])}
              />
            }
          >
            {input.address.kind === 'tcp' && (
              <div className="grid grid-cols-12 gap-3">
                <Field label="Host" className="col-span-8">
                  <Input value={input.address.host} onChange={(e) => patchAddress({ host: e.target.value })} />
                </Field>
                <Field label="Port" className="col-span-4">
                  <Input
                    type="number"
                    value={input.address.port}
                    onChange={(e) => patchAddress({ port: Number(e.target.value) })}
                  />
                </Field>
              </div>
            )}

            {input.address.kind === 'unix' && (
              <>
                <Field label="Socket path" hint="Fastest path when the database is on this machine (§8.2).">
                  <Input
                    className="mono"
                    value={input.address.socketPath}
                    onChange={(e) => patchAddress({ socketPath: e.target.value })}
                  />
                </Field>
                {isContainer && (
                  <Note tone="warn" icon={<TriangleAlert className="size-3.5" />}>
                    Docker Desktop on macOS does not proxy a bind-mounted unix socket from the host. Socket connections
                    work only when the app and the database are both on Linux, or both in containers sharing a volume —
                    otherwise use TCP via <code className="mono">host.docker.internal</code> (§10.3).
                  </Note>
                )}
              </>
            )}

            {input.address.kind === 'file' && (
              <>
                <Field
                  label="Database file"
                  hint={`Container path. The browser is confined to ${sqliteRoot}, which your compose file mounts from the host (§10.4).`}
                >
                  <div className="flex gap-2">
                    <Input
                      className="mono"
                      value={input.address.path}
                      placeholder={`${sqliteRoot}/app.db`}
                      onChange={(e) => patchAddress({ path: e.target.value })}
                    />
                    <Button icon={<FolderOpen className="size-3.5" />} onClick={() => setBrowsing(true)}>
                      Browse
                    </Button>
                  </div>
                </Field>
                <div className="mt-2">
                  <Checkbox
                    checked={input.address.mode === 'ro'}
                    onChange={(e) => patchAddress({ mode: e.target.checked ? 'ro' : 'rw' })}
                    label="Open read-only (immutable)"
                  />
                </div>
                <AttachList
                  attach={input.address.attach ?? []}
                  onChange={(attach) => patchAddress({ attach: attach.length ? attach : undefined })}
                />
              </>
            )}

            {input.address.kind === 'uri' && (
              <Field
                label="URI"
                hint="Everything the driver needs in one string — the only way to express mongodb+srv:// seed lists."
              >
                <Input
                  className="mono"
                  value={input.address.uri}
                  placeholder={
                    input.engine === 'mongodb'
                      ? 'mongodb+srv://cluster0.example.mongodb.net'
                      : input.engine === 'redis'
                        ? 'rediss://cache.example.com:6380'
                        : 'postgres://db.example.com:5432/app'
                  }
                  onChange={(e) => patchAddress({ uri: e.target.value })}
                />
              </Field>
            )}

            {loopbackWarning && (
              <Note tone="warn" icon={<TriangleAlert className="size-3.5" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    This app runs in a container, so <code className="mono">localhost</code> is the container itself —
                    not your machine. Use <code className="mono">host.docker.internal</code> for a database on the host,
                    or the service name for one in another container (§10.3).
                  </span>
                  <Button size="xs" onClick={() => patchAddress({ host: 'host.docker.internal' })}>
                    Use host.docker.internal
                  </Button>
                </div>
              </Note>
            )}
          </Section>

          {/* --- credentials --------------------------------------------- */}
          {input.engine !== 'sqlite' && (
            <Section title="Credentials">
              <div className="grid grid-cols-12 gap-3">
                <Field label="Username" className="col-span-6">
                  <Input value={input.username ?? ''} onChange={(e) => patch({ username: e.target.value })} />
                </Field>
                <Field
                  label="Password"
                  className="col-span-6"
                  hint="Encrypted in the vault; it is never sent back to the browser (§9.3)."
                >
                  {password === undefined && connection?.hasPassword ? (
                    <div className="flex h-7 items-center gap-2">
                      <Badge tone="ok">stored</Badge>
                      <Button size="xs" onClick={() => setPassword('')}>
                        Change
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setPassword(null)}>
                        Clear
                      </Button>
                    </div>
                  ) : password === null ? (
                    <div className="flex h-7 items-center gap-2">
                      <Badge tone="warn">will be cleared</Badge>
                      <Button size="xs" variant="ghost" onClick={() => setPassword(undefined)}>
                        Keep stored password
                      </Button>
                    </div>
                  ) : (
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={password ?? ''}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </Section>
          )}

          {/* --- access -------------------------------------------------- */}
          <Section
            title="Access"
            description="How we reach that address. Independent of the address itself (§8.2)."
            right={
              input.address.kind === 'file' ? null : (
                <Segmented
                  value={input.access.via}
                  options={[
                    { value: 'direct', label: 'Direct' },
                    { value: 'ssh', label: 'SSH tunnel' },
                    { value: 'process', label: 'Proxy process' },
                  ]}
                  onChange={(v) => changeAccess(v as Access['via'])}
                />
              )
            }
          >
            {input.address.kind === 'file' ? (
              <p className="text-xs text-[var(--fg-muted)]">
                A SQLite file is opened by this process directly — there is nothing to tunnel. Reach a remote file by
                mounting it, not by forwarding a port (§8.2).
              </p>
            ) : (
              input.access.via === 'direct' && (
                <p className="text-xs text-[var(--fg-muted)]">
                  The driver opens the socket itself. Correct for a database on this machine, on the compose network, or
                  one that is publicly reachable over TLS.
                </p>
              )
            )}

            {input.access.via === 'ssh' && (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-[var(--fg-muted)]">
                  Hops are applied in order: the first is reached from here, each subsequent one through the previous.
                  The database address above is resolved from the <em>last</em> hop.
                </p>
                {hops.map((hop, i) => (
                  <HopEditor
                    key={i}
                    index={i}
                    hop={hop}
                    total={hops.length}
                    secret={sshSecrets[i] ?? ''}
                    onSecret={(value) =>
                      setSshSecrets((s) => {
                        const next = [...s];
                        while (next.length < hops.length) next.push(null);
                        next[i] = value || null;
                        return next;
                      })
                    }
                    onChange={(next) => setHops(hops.map((h, j) => (j === i ? next : h)))}
                    onRemove={() => {
                      setHops(hops.filter((_, j) => j !== i));
                      setSshSecrets((s) => s.filter((_, j) => j !== i));
                    }}
                  />
                ))}
                <div>
                  <Button size="xs" icon={<Plus className="size-3" />} onClick={() => setHops([...hops, newHop()])}>
                    Add hop
                  </Button>
                </div>
              </div>
            )}

            {input.access.via === 'process' && (
              <div className="flex flex-col gap-3">
                <Field
                  label="Command"
                  hint="One argument per line. The process is spawned before connecting and killed with the pool — e.g. cloud_sql_proxy or an AWS SSM session."
                >
                  <Textarea
                    rows={4}
                    value={input.access.argv.join('\n')}
                    placeholder={'cloud-sql-proxy\n--port=5432\nproject:region:instance'}
                    onChange={(e) =>
                      setInput((s) =>
                        s.access.via === 'process'
                          ? { ...s, access: { ...s.access, argv: e.target.value.split('\n').filter((l) => l.trim() !== '') } }
                          : s,
                      )
                    }
                  />
                </Field>
                <div className="grid grid-cols-12 gap-3">
                  <Field
                    label="Ready pattern"
                    className="col-span-8"
                    hint="Regex matched against the process output; we wait for it before dialling."
                  >
                    <Input
                      className="mono"
                      value={input.access.readyPattern ?? ''}
                      placeholder="ready for new connections"
                      onChange={(e) =>
                        setInput((s) =>
                          s.access.via === 'process'
                            ? { ...s, access: { ...s.access, readyPattern: e.target.value || undefined } }
                            : s,
                        )
                      }
                    />
                  </Field>
                  <Field label="Ready timeout (ms)" className="col-span-4">
                    <Input
                      type="number"
                      value={input.access.readyTimeoutMs ?? 10_000}
                      onChange={(e) =>
                        setInput((s) =>
                          s.access.via === 'process'
                            ? { ...s, access: { ...s.access, readyTimeoutMs: Number(e.target.value) } }
                            : s,
                        )
                      }
                    />
                  </Field>
                </div>
              </div>
            )}
          </Section>

          {/* --- TLS ----------------------------------------------------- */}
          {input.engine !== 'sqlite' && (
            <Section title="TLS">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-4">
                  <Checkbox
                    checked={input.tls?.enabled ?? false}
                    onChange={(e) => patchTls({ enabled: e.target.checked })}
                    label="Use TLS"
                  />
                  {input.tls?.enabled && (
                    <Select
                      className="w-52"
                      value={input.tls.verify}
                      onChange={(e) => patchTls({ verify: e.target.value as TlsVerifyMode })}
                    >
                      <option value="verify-full">verify-full — certificate + hostname</option>
                      <option value="require">require — certificate chain only</option>
                      <option value="skip">skip — no verification</option>
                    </Select>
                  )}
                </div>

                {input.tls?.enabled && input.tls.verify === 'skip' && (
                  <Note tone="danger" icon={<ShieldAlert className="size-3.5" />}>
                    The traffic is encrypted but the server is <strong>not authenticated</strong>. Anyone able to
                    intercept this route — a compromised network, a hijacked DNS answer — can present their own
                    certificate, read every query and every password you send, and pass them on. Use this only against a
                    database you can reach no other way, and never for prod (§8.2).
                  </Note>
                )}
                {input.tls?.enabled && input.tls.verify === 'require' && (
                  <p className="text-[11px] text-[var(--fg-muted)]">
                    The chain is checked but the hostname is not, so a valid certificate for any host passes. Prefer
                    verify-full and set a server name override if the certificate uses a different name.
                  </p>
                )}

                {input.tls?.enabled && (
                  <div className="grid grid-cols-12 gap-3">
                    <Field label="CA certificate" className="col-span-6" hint="PEM contents or a container path.">
                      <Textarea
                        rows={2}
                        value={input.tls.caCert ?? ''}
                        onChange={(e) => patchTls({ caCert: e.target.value || undefined })}
                      />
                    </Field>
                    <Field label="Server name override" className="col-span-6">
                      <Input
                        value={input.tls.serverName ?? ''}
                        onChange={(e) => patchTls({ serverName: e.target.value || undefined })}
                      />
                    </Field>
                    <Field label="Client certificate" className="col-span-6">
                      <Textarea
                        rows={2}
                        value={input.tls.clientCert ?? ''}
                        onChange={(e) => patchTls({ clientCert: e.target.value || undefined })}
                      />
                    </Field>
                    <Field label="Client key" className="col-span-6">
                      <Textarea
                        rows={2}
                        value={input.tls.clientKey ?? ''}
                        onChange={(e) => patchTls({ clientKey: e.target.value || undefined })}
                      />
                    </Field>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* --- options ------------------------------------------------- */}
          <Section title="Options">
            <div className="grid grid-cols-12 gap-3">
              {input.engine !== 'sqlite' && input.engine !== 'redis' && (
                <Field label="Database" className="col-span-4">
                  <Input
                    value={input.options.database ?? ''}
                    onChange={(e) => patchOptions({ database: e.target.value || undefined })}
                  />
                </Field>
              )}
              {(input.engine === 'postgres' || input.engine === 'mysql' || input.engine === 'mariadb') && (
                <Field label="Default schema" className="col-span-4">
                  <Input
                    value={input.options.defaultSchema ?? ''}
                    placeholder={input.engine === 'postgres' ? 'public' : ''}
                    onChange={(e) => patchOptions({ defaultSchema: e.target.value || undefined })}
                  />
                </Field>
              )}
              {input.engine === 'redis' && (
                <Field label="Database index" className="col-span-4">
                  <Input
                    type="number"
                    value={input.options.redisDb ?? 0}
                    onChange={(e) => patchOptions({ redisDb: Number(e.target.value) })}
                  />
                </Field>
              )}
              {input.engine === 'mongodb' && (
                <>
                  <Field label="Auth source" className="col-span-4">
                    <Input
                      value={input.options.authSource ?? ''}
                      placeholder="admin"
                      onChange={(e) => patchOptions({ authSource: e.target.value || undefined })}
                    />
                  </Field>
                  <Field label="Replica set" className="col-span-4">
                    <Input
                      value={input.options.replicaSet ?? ''}
                      onChange={(e) => patchOptions({ replicaSet: e.target.value || undefined })}
                    />
                  </Field>
                </>
              )}
              <Field
                label="Pool size"
                className="col-span-4"
                hint={input.engine === 'sqlite' ? 'Ignored: SQLite runs one worker per connection.' : undefined}
              >
                <Input
                  type="number"
                  min={1}
                  disabled={input.engine === 'sqlite'}
                  value={input.options.poolSize ?? ''}
                  placeholder="4"
                  onChange={(e) => patchOptions({ poolSize: e.target.value ? Number(e.target.value) : undefined })}
                />
              </Field>
              <Field label="Connect timeout (ms)" className="col-span-4">
                <Input
                  type="number"
                  value={input.options.connectTimeoutMs ?? ''}
                  placeholder="10000"
                  onChange={(e) =>
                    patchOptions({ connectTimeoutMs: e.target.value ? Number(e.target.value) : undefined })
                  }
                />
              </Field>
              <Field label="Statement timeout (ms)" className="col-span-4" hint="0 disables.">
                <Input
                  type="number"
                  value={input.options.statementTimeoutMs ?? ''}
                  onChange={(e) =>
                    patchOptions({ statementTimeoutMs: e.target.value ? Number(e.target.value) : undefined })
                  }
                />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-5">
              <Checkbox
                checked={input.readOnly}
                onChange={(e) => patch({ readOnly: e.target.checked })}
                label="Read-only connection"
              />
              <Checkbox
                checked={input.options.compress ?? false}
                onChange={(e) => patchOptions({ compress: e.target.checked })}
                label="Protocol compression"
              />
              <span className="text-[11px] text-[var(--fg-subtle)]">
                Compression pays off on remote links and costs CPU on local ones (§8.3).
              </span>
            </div>
          </Section>

          {/* --- results ------------------------------------------------- */}
          {testResult && <TestResultBox result={testResult} />}
          {saveError && <ErrorBox title="Could not save" message={saveError} />}
        </div>
      </Dialog>

      <FileBrowser
        open={browsing}
        root={sqliteRoot}
        onClose={() => setBrowsing(false)}
        onPick={(path) => {
          patchAddress({ path });
          setBrowsing(false);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  right,
  children,
}: {
  title: string;
  description?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-[var(--border)] bg-[var(--bg)] p-3">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">{title}</h3>
          {description && <p className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">{description}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2 py-1 text-[11px] transition-colors',
            value === o.value
              ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
              : 'bg-[var(--bg-panel)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Note({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'danger' | 'ok';
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones = {
    warn: 'border-[var(--warn)]/40 bg-[var(--warn-bg)] text-[var(--warn)]',
    danger: 'border-[var(--danger)]/40 bg-[var(--danger-bg)] text-[var(--danger)]',
    ok: 'border-[var(--ok)]/40 bg-[var(--ok-bg)] text-[var(--ok)]',
  }[tone];
  return (
    <div className={cn('mt-3 flex gap-2 border p-2 text-[11px] leading-relaxed', tones)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="text-[var(--fg)]">{children}</div>
    </div>
  );
}

function HopEditor({
  hop,
  index,
  total,
  secret,
  onChange,
  onSecret,
  onRemove,
}: {
  hop: SshHop;
  index: number;
  total: number;
  secret: string;
  onChange: (hop: SshHop) => void;
  onSecret: (value: string) => void;
  onRemove: () => void;
}) {
  const label = total === 1 ? 'Hop' : index === total - 1 ? `Hop ${index + 1} — target side` : `Hop ${index + 1} — bastion`;
  return (
    <div className="border border-[var(--border)] bg-[var(--bg-subtle)] p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
          <Network className="size-3.5" />
          {label}
        </span>
        <Button size="xs" variant="ghost" onClick={onRemove} aria-label="Remove hop">
          <Trash2 className="size-3" />
        </Button>
      </div>
      <div className="grid grid-cols-12 gap-2">
        <Field label="Host" className="col-span-4">
          <Input value={hop.host} onChange={(e) => onChange({ ...hop, host: e.target.value })} />
        </Field>
        <Field label="Port" className="col-span-2">
          <Input type="number" value={hop.port} onChange={(e) => onChange({ ...hop, port: Number(e.target.value) })} />
        </Field>
        <Field label="User" className="col-span-3">
          <Input value={hop.username} onChange={(e) => onChange({ ...hop, username: e.target.value })} />
        </Field>
        <Field label="Auth" className="col-span-3">
          <Select value={hop.auth} onChange={(e) => onChange({ ...hop, auth: e.target.value as SshHop['auth'] })}>
            <option value="agent">agent</option>
            <option value="key">key file</option>
            <option value="password">password</option>
          </Select>
        </Field>

        {hop.auth === 'key' && (
          <>
            <Field label="Private key path" className="col-span-6" hint="Path inside the container.">
              <Input
                className="mono"
                value={hop.privateKeyPath ?? ''}
                placeholder="/home/node/.ssh/id_ed25519"
                onChange={(e) => onChange({ ...hop, privateKeyPath: e.target.value || undefined })}
              />
            </Field>
            <div className="col-span-6 flex items-end gap-3 pb-1">
              <Checkbox
                checked={hop.keyHasPassphrase ?? false}
                onChange={(e) => onChange({ ...hop, keyHasPassphrase: e.target.checked || undefined })}
                label="Key has a passphrase"
              />
              {hop.keyHasPassphrase && (
                <Input
                  type="password"
                  className="h-7"
                  placeholder="Key passphrase"
                  value={secret}
                  onChange={(e) => onSecret(e.target.value)}
                />
              )}
            </div>
          </>
        )}

        {hop.auth === 'password' && (
          <Field label="Password" className="col-span-6" hint="Stored in the vault, alongside the database password.">
            <Input type="password" value={secret} onChange={(e) => onSecret(e.target.value)} />
          </Field>
        )}

        {hop.auth === 'agent' && (
          <p className="col-span-12 text-[11px] text-[var(--fg-subtle)]">
            Uses the forwarded agent socket. Under Docker Desktop that needs{' '}
            <code className="mono">/run/host-services/ssh-auth.sock</code> mounted with{' '}
            <code className="mono">SSH_AUTH_SOCK</code> pointed at it (§10.3).
          </p>
        )}

        <Field
          label="~/.ssh/config alias"
          className="col-span-6"
          hint="Optional: take the rest of the settings from this Host entry."
        >
          <Input
            value={hop.sshConfigHost ?? ''}
            onChange={(e) => onChange({ ...hop, sshConfigHost: e.target.value || undefined })}
          />
        </Field>
      </div>
    </div>
  );
}

function AttachList({
  attach,
  onChange,
}: {
  attach: { alias: string; path: string }[];
  onChange: (attach: { alias: string; path: string }[]) => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">Attached files</span>
        <Button
          size="xs"
          variant="ghost"
          icon={<Plus className="size-3" />}
          onClick={() => onChange([...attach, { alias: '', path: '' }])}
        >
          Attach
        </Button>
      </div>
      {attach.map((a, i) => (
        <div key={i} className="mb-1 flex items-center gap-2">
          <Input
            className="w-32"
            placeholder="alias"
            value={a.alias}
            onChange={(e) => onChange(attach.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)))}
          />
          <Input
            className="mono"
            placeholder="/data/sqlite/other.db"
            value={a.path}
            onChange={(e) => onChange(attach.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
          />
          <Button size="xs" variant="ghost" onClick={() => onChange(attach.filter((_, j) => j !== i))}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function TestResultBox({ result }: { result: TestConnectionResponse }) {
  if (result.ok && result.info) {
    const info = result.info;
    return (
      <Note tone="ok" icon={<Plug className="size-3.5" />}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Connected — <strong>{info.version}</strong>
            {info.edition ? ` (${info.edition})` : ''}
          </span>
          <span className="text-[var(--fg-muted)]">round trip {info.rttMs.toFixed(1)} ms</span>
          {info.uptimeSeconds !== undefined && (
            <span className="text-[var(--fg-muted)]">uptime {formatDuration(info.uptimeSeconds * 1000)}</span>
          )}
          {Object.entries(info.details ?? {}).map(([k, v]) => (
            <span key={k} className="text-[var(--fg-muted)]">
              {k} {v}
            </span>
          ))}
        </div>
      </Note>
    );
  }
  return <ErrorBox title="Connection failed" message={result.error ?? 'Unknown error'} hint={result.hint} />;
}

// ---------------------------------------------------------------------------
// SQLite file browser — POST /api/files, confined to CONFIG.sqliteRoot (§10.4)
// ---------------------------------------------------------------------------

interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size?: number;
}

interface Listing {
  path: string;
  /** Absolute parent path, or null at the root — there is no "up" past it. */
  parent: string | null;
  hostNote: string | null;
  entries: FileEntry[];
}

function normalizeListing(payload: unknown, requested: string): Listing {
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const base = typeof record.path === 'string' ? record.path : requested;
  const entries: FileEntry[] = [];
  for (const raw of rawEntries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : '';
    if (!name) continue;
    entries.push({
      name,
      path: typeof e.path === 'string' ? e.path : `${base.replace(/\/$/, '')}/${name}`,
      directory: e.isDir === true,
      size: typeof e.size === 'number' ? e.size : typeof e.sizeBytes === 'number' ? e.sizeBytes : undefined,
    });
  }
  entries.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1));
  const root = typeof record.root === 'object' && record.root !== null ? (record.root as Record<string, unknown>) : {};
  return {
    path: base,
    parent: typeof record.parent === 'string' ? record.parent : null,
    // §10.4: a container path means nothing without the host directory it maps to.
    hostNote: typeof root.note === 'string' ? root.note : null,
    entries,
  };
}

function FileBrowser({
  open,
  root,
  onPick,
  onClose,
}: {
  open: boolean;
  root: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = React.useState(root);
  React.useEffect(() => {
    if (open) setPath(root);
  }, [open, root]);

  const listing = useQuery<Listing>({
    queryKey: ['files', path],
    queryFn: async () => normalizeListing(await api.post<unknown>('/api/files', { path, root: 'sqlite' }), path),
    enabled: open,
    retry: false,
  });

  const parent = listing.data?.parent ?? null;

  return (
    <Dialog open={open} onClose={onClose} title="Choose a SQLite file" width="md">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input className="mono" value={path} onChange={(e) => setPath(e.target.value)} />
          <Button onClick={() => void listing.refetch()}>Go</Button>
        </div>
        <p className="text-[11px] text-[var(--fg-subtle)]">
          {listing.data?.hostNote ?? (
            <>
              Container paths, confined to <code className="mono">{root}</code>.
            </>
          )}
        </p>

        <div className="max-h-80 overflow-y-auto border border-[var(--border)]">
          {listing.isPending && (
            <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
              <Spinner /> Reading directory…
            </div>
          )}
          {listing.isError && (
            <div className="p-3">
              <ErrorBox message={listing.error instanceof Error ? listing.error.message : 'Cannot read directory'} />
            </div>
          )}
          {listing.data && (
            <>
              {parent && (
                <Row
                  icon={<ChevronRight className="size-3.5 rotate-180" />}
                  label=".."
                  onClick={() => setPath(parent)}
                />
              )}
              {listing.data.entries.map((e) => (
                <Row
                  key={e.path}
                  icon={e.directory ? <FolderOpen className="size-3.5" /> : <FileText className="size-3.5" />}
                  label={e.name}
                  detail={e.directory ? undefined : formatBytes(e.size)}
                  onClick={() => (e.directory ? setPath(e.path) : onPick(e.path))}
                />
              ))}
              {listing.data.entries.length === 0 && (
                <p className="p-3 text-xs text-[var(--fg-subtle)]">This directory is empty.</p>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Row({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-[var(--bg-hover)]"
    >
      <span className="text-[var(--fg-subtle)]">{icon}</span>
      <span className="mono truncate">{label}</span>
      {detail && <span className="ml-auto text-[10px] text-[var(--fg-subtle)]">{detail}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Validation + formatting
// ---------------------------------------------------------------------------

function validate(input: ConnectionInput): string[] {
  const problems: string[] = [];
  if (!input.name.trim()) problems.push('Give the connection a name.');
  switch (input.address.kind) {
    case 'tcp':
      if (!input.address.host.trim()) problems.push('Host is required.');
      if (!Number.isFinite(input.address.port) || input.address.port <= 0) problems.push('Port must be a number.');
      break;
    case 'unix':
      if (!input.address.socketPath.trim()) problems.push('Socket path is required.');
      break;
    case 'file':
      if (!input.address.path.trim()) problems.push('Choose a database file.');
      break;
    case 'uri':
      if (!input.address.uri.trim()) problems.push('URI is required.');
      break;
  }
  if (input.access.via === 'ssh') {
    if (input.access.hops.length === 0) problems.push('Add at least one SSH hop.');
    input.access.hops.forEach((h, i) => {
      if (!h.host.trim()) problems.push(`SSH hop ${i + 1}: host is required.`);
      if (!h.username.trim()) problems.push(`SSH hop ${i + 1}: user is required.`);
      if (h.auth === 'key' && !h.privateKeyPath?.trim()) problems.push(`SSH hop ${i + 1}: key path is required.`);
    });
  }
  if (input.access.via === 'process' && input.access.argv.length === 0) {
    problems.push('The proxy command is empty.');
  }
  // Mirrors the server's rule, so it fails in the form rather than on save.
  if (input.address.kind === 'file' && input.access.via !== 'direct') {
    problems.push('A SQLite file cannot be reached through a tunnel; use direct access.');
  }
  return problems;
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export { formatBytes, formatDuration };
