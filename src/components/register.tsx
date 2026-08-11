'use client';

/**
 * Feature registration — the wiring between the shell and every feature pane.
 *
 * The shell (components/shell/workspace.tsx) exposes a slot/tab registry so it
 * never has to import feature code directly. Something has to actually call
 * that registry, and it deliberately is not the shell: keeping registration in
 * one module is what stops the shell from depending on Redis, Mongo, the ER
 * diagram and everything else.
 *
 * Imported for its side effect by app/providers.tsx, so it runs once on the
 * client before the workspace first renders.
 */

import { registerTabView, registerWorkspaceSlot, type SlotProps } from './shell/workspace';
import { SchemaTree } from './tree/schema-tree';
import { ResultTabs } from './editor/result-tabs';
import { JobsSlot } from './transfer/jobs-drawer';
import { SqlWorkspace } from './editor/sql-editor';
import { TableTab } from './table-tab';
import { RedisWorkspace } from './redis/redis-workspace';
import { MongoWorkspace } from './mongo/mongo-workspace';
import { ErDiagramTab } from './power/er-diagram';
import { SchemaCompareTab } from './power/schema-compare';

/** The tree takes a connection id; the slot contract passes the active tab too. */
function ObjectTreeSlot({ connectionId }: SlotProps) {
  return <SchemaTree connectionId={connectionId} className="h-full" />;
}

registerWorkspaceSlot('object-tree', ObjectTreeSlot);
registerWorkspaceSlot('results', ResultTabs);
registerWorkspaceSlot('jobs', JobsSlot);

registerTabView('sql', SqlWorkspace);
registerTabView('table', TableTab);
registerTabView('redis', RedisWorkspace);
registerTabView('mongo', MongoWorkspace);
registerTabView('diagram', ErDiagramTab);
registerTabView('compare', SchemaCompareTab);

export {};
