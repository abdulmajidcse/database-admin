import { createSqliteConnector } from '../../src/server/db/connectors/sqlite/index';
import type { ConnectorContext } from '../../src/server/db/types';
import { randomUUID } from 'node:crypto';

const file = '/tmp/dbadmin-sqlite-smoke.db';
const address = { kind: 'file' as const, path: file, mode: 'rw' as const };
const ctx: ConnectorContext = {
  config: {
    id: randomUUID(), name: 'smoke', engine: 'sqlite', address,
    access: { via: 'direct' }, hasPassword: false, options: {},
    readOnly: false, envTag: 'dev', sortOrder: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  },
  resolved: { address, original: address, tunneled: false, release: async () => {} },
};

const c = createSqliteConnector(ctx);
await c.open();
console.log('ping:', JSON.stringify(await c.ping()));

await c.query(`CREATE TABLE IF NOT EXISTS t (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC, blob BLOB, mixed
)`, {});
await c.query(`DELETE FROM t`, {});
await c.query(`INSERT INTO t VALUES (1,'ada',19.99,X'DEADBEEF','a string')`, {});
await c.query(`INSERT INTO t VALUES (2,'grace',NULL,NULL,42)`, {});

const rs = await c.query('SELECT * FROM t ORDER BY id', {});
console.log('columns:', rs.columns.map(x => `${x.name}:${x.base}${x.dynamicType?'(dyn)':''}`).join(', '));
console.log('rows:', JSON.stringify(rs.rows));
console.log('editTarget:', JSON.stringify(rs.editTarget), '| readOnlyReason:', rs.readOnlyReason ?? 'none');

const model = await c.introspect({});
const ns = model.namespaces[0];
const tbl = ns.tables.find(t => t.name === 't');
console.log('introspect: ns=%s tables=%d roundTrips=%s', ns.name, ns.tables.length, model.roundTrips);
console.log('table t: pk=%j cols=%j', tbl?.primaryKey, tbl?.columns.map(x=>`${x.name}:${x.type.raw}->${x.type.base}`));

const nodes = await c.listNodes({ segments: [] });
console.log('tree root:', nodes.map(n=>`${n.kind}:${n.label}`).join(', '));

await c.close();
console.log('OK');
