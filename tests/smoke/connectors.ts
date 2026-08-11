import { randomUUID } from 'node:crypto';
import type { ConnectorContext, SqlConnector, KeyValueConnector, DocumentConnector } from '../../src/server/db/types';
import type { Address, ConnectionConfig } from '../../src/lib/connection';
import type { EngineKind } from '../../src/lib/schema-model';

function ctx(engine: EngineKind, host: string, port: number, user?: string, pass?: string, db?: string): ConnectorContext {
  const address: Address = { kind: 'tcp', host, port };
  const config: ConnectionConfig = {
    id: randomUUID(), name: `smoke-${engine}`, engine, address, access: { via: 'direct' },
    username: user, hasPassword: !!pass, options: { database: db, connectTimeoutMs: 15000 },
    readOnly: false, envTag: 'dev', sortOrder: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };
  return { config, resolved: { address, original: address, tunneled: false, release: async () => {} }, password: pass };
}

async function sql(label: string, make: (c: ConnectorContext) => SqlConnector, c: ConnectorContext, torture: string) {
  const conn = make(c);
  try {
    await conn.open();
    const info = await conn.ping();
    console.log(`\n### ${label}  v${info.version}  rtt=${info.rttMs.toFixed(1)}ms`);
    const rs = await conn.query(torture, {});
    console.log('  cols:', rs.columns.map(x => `${x.name}:${x.base}`).join(', '));
    console.log('  row :', JSON.stringify(rs.rows[0]));
    const m = await conn.introspect({});
    const tot = m.namespaces.reduce((a, n) => a + n.tables.length, 0);
    console.log(`  introspect: namespaces=${m.namespaces.length} tables=${tot} roundTrips=${m.roundTrips}`);
    const big = m.namespaces.flatMap(n => n.tables).find(t => t.name === 'events');
    if (big) console.log(`  events: cols=${big.columns.length} pk=${JSON.stringify(big.primaryKey)} idx=${big.indexes.length} fks=${big.foreignKeys.length}`);
    const nodes = await conn.listNodes({ segments: [] });
    console.log('  tree:', nodes.slice(0, 6).map(n => `${n.kind}:${n.label}`).join(', '));
  } catch (e) { console.log(`  !! ${label} FAILED:`, (e as Error).message); }
  finally { try { await conn.close(); } catch {} }
}

const PG_TORTURE = `SELECT big, exact, when_tz, blob, arr, doc, nasty_text, empty_vs_null FROM shop.type_torture WHERE id=1`;
const MY_TORTURE = `SELECT big, big_unsigned, exact, when_dt, blob_col, doc, nasty_text, empty_vs_null FROM type_torture WHERE id=1`;

const { createPostgresConnector } = await import('../../src/server/db/connectors/postgres/index');
await sql('POSTGRES', createPostgresConnector, ctx('postgres','postgres',5432,'dbadmin','dbadmin','sample'), PG_TORTURE);

const { createMysqlConnector } = await import('../../src/server/db/connectors/mysql/index');
await sql('MYSQL', createMysqlConnector, ctx('mysql','mysql',3306,'root','dbadmin','sample'), MY_TORTURE);
await sql('MARIADB', createMysqlConnector, ctx('mariadb','mariadb',3306,'root','dbadmin','sample'), 'SELECT 1 AS one');

const { createRedisConnector } = await import('../../src/server/db/connectors/redis/index');
const r = createRedisConnector(ctx('redis','redis',6379)) as KeyValueConnector;
try {
  await r.open();
  const i = await r.ping();
  console.log(`\n### REDIS v${i.version} rtt=${i.rttMs.toFixed(1)}ms`);
  await r.writeKey('smoke:str', { type: 'string', value: 'héllo ☃' });
  await r.writeKey('smoke:hash', { type: 'hash', fields: [{ field: 'a', value: '1' }, { field: 'b', value: '2' }], total: 2 });
  const scan = await r.scanKeys({ cursor: '0', match: 'smoke:*', count: 100 });
  console.log('  scan:', scan.keys.map(k => `${k.key}(${k.type},ttl=${k.ttlMs})`).join(', '));
  console.log('  read str :', JSON.stringify(await r.readKey('smoke:str')));
  console.log('  read hash:', JSON.stringify(await r.readKey('smoke:hash')));
  await r.deleteKeys(['smoke:str', 'smoke:hash']);
} catch (e) { console.log('  !! REDIS FAILED:', (e as Error).message); } finally { try { await r.close(); } catch {} }

const { createMongoConnector } = await import('../../src/server/db/connectors/mongo/index');
const mg = createMongoConnector(ctx('mongodb','mongo',27017,'dbadmin','dbadmin','sample')) as DocumentConnector;
try {
  await mg.open();
  const i = await mg.ping();
  console.log(`\n### MONGODB v${i.version} rtt=${i.rttMs.toFixed(1)}ms`);
  const ns = { database: 'sample', collection: 'smoke' };
  await mg.insert(ns, [{ n: 1, txt: 'héllo ☃', nested: { a: [1, 2, 3] }, when: new Date('2026-06-01T00:00:00Z') }]);
  const found = await mg.find(ns, {}, { limit: 5 });
  console.log('  cols:', found.columns.map(c => c.name).join(', '));
  console.log('  row :', JSON.stringify(found.rows[0]));
  console.log('  dbs :', (await mg.listDatabases()).map(d => d.name).join(', '));
  await mg.deleteDocs(ns, []);
} catch (e) { console.log('  !! MONGO FAILED:', (e as Error).message); } finally { try { await mg.close(); } catch {} }
console.log('\ndone');
