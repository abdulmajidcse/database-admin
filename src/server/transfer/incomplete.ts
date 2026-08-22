/**
 * The marker a failed directory export leaves behind (PLAN §7.1).
 *
 * A stream destination can be truncated, so a failed archive download is
 * recognisably broken. A directory cannot: the tables written before the failure
 * stay on disk, and a directory of CSVs is exactly what a bundle import
 * consumes — so without a marker, half a database restores as though it were all
 * of it, silently.
 *
 * Lives in its own module so `transfer/import` can honour it without importing
 * `transfer/export`, which drags in every writer and the zip archiver.
 */

/** Dot-prefixed so it sorts out of the way of the exported tables. */
export const INCOMPLETE_MARKER = '.dbadmin-incomplete';
