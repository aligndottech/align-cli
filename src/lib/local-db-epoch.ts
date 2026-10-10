import type { DatabaseSync } from 'node:sqlite';

/**
 * A per-connection counter that goes up whenever a decision is deleted or re-id'd, or an
 * embedding is deleted or replaced. A holder of a COPY of the graph's embeddings (the ingest
 * matrix) remembers the value it built at and rebuilds when it moves, so staleness is
 * impossible by construction: it does not depend on the holder knowing which code paths
 * delete rows. Kept beside the connection and not in the schema, so it costs no migration.
 *
 * Every writer of those changes calls bumpRowSetEpoch: deleteDecisionWithDependents,
 * absorbLoser, the open-time duplicate collapse, dropAll and setEmbedding over an existing
 * row. local-db-row-set-epoch.test.ts has one test per path.
 */
const epochs = new WeakMap<DatabaseSync, number>();

export function rowSetEpoch(db: DatabaseSync): number {
  return epochs.get(db) ?? 0;
}

export function bumpRowSetEpoch(db: DatabaseSync): void {
  epochs.set(db, rowSetEpoch(db) + 1);
}
