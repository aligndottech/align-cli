import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NewLink } from './local-db.js';

/**
 * The one writer of a `decision_links` insert, shared by local-db.ts and local-ref-links.ts so the
 * ON CONFLICT clause exists once.
 *
 * `detectorVersion` (schema v12) is which detector wrote the edge. Omitted means 'v0'; the v1
 * detector passes 'v1'; an exact reference match passes 'ref'. A conflict on the triple keeps the
 * stored version (same relation, nothing re-typed), with one exception: an exact reference match
 * upgrades a guessed edge on the same triple to 'ref', because the pair is now known to be linked.
 * Nothing downgrades a 'ref' edge.
 */
export function insertLinkRow(db: DatabaseSync, link: NewLink): void {
  db.prepare(
    `INSERT INTO decision_links (id, source_id, target_id, relation, confidence, detector_version) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, relation)
       DO UPDATE SET confidence = MAX(confidence, excluded.confidence),
         detector_version = CASE WHEN excluded.detector_version = 'ref' THEN 'ref' ELSE detector_version END`
  ).run(link.id ?? randomUUID(), link.sourceId, link.targetId, link.relation, link.confidence, link.detectorVersion ?? 'v0');
}
