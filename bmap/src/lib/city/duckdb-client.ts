/**
 * Overture Parquet reader via hyparquet + HTTP range requests.
 *
 * DuckDB-Wasm remote reads are unreliable here. Full downloads are impossible
 * (~500 MB per building part). hyparquet issues only the range requests needed
 * for the footer + intersecting row groups, with ZSTD via fzstd.
 *
 * Callers should already prune to a small set of files (via STAC file bboxes);
 * this module focuses on efficient per-file reads.
 */

import { asyncBufferFromUrl, parquetReadObjects, parquetMetadataAsync } from "hyparquet";
import type { AsyncBuffer, Compressors, FileMetaData } from "hyparquet";
import { decompress as zstdDecompress } from "fzstd";

const compressors: Compressors = {
  ZSTD: (data: Uint8Array, _outputSize: number) => zstdDecompress(data),
};

/** Max concurrent parquet file opens (network + WASM memory). */
const READ_CONCURRENCY = 3;

export type OvertureRow = Record<string, unknown>;

export type QueryOvertureOptions = {
  urls: string[];
  byteLengths?: (number | undefined)[];
  columns: string[];
  filter?: Record<string, unknown>;
  rowLimit: number;
};

/**
 * Scan remote Overture GeoParquet files and return matching rows.
 * Geometry columns are decoded from WKB to GeoJSON by hyparquet.
 */
export async function queryOvertureFiles(opts: QueryOvertureOptions): Promise<OvertureRow[]> {
  const { urls, byteLengths, columns, filter, rowLimit } = opts;
  if (urls.length === 0) return [];

  const rows: OvertureRow[] = [];
  let next = 0;

  async function worker() {
    while (rows.length < rowLimit) {
      const i = next++;
      if (i >= urls.length) return;
      try {
        const batch = await readOneFile(
          urls[i],
          byteLengths?.[i],
          columns,
          filter,
          rowLimit - rows.length,
        );
        if (batch.length) rows.push(...batch);
      } catch (err) {
        console.warn(`[overture] skip ${urls[i]}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
  return rows.slice(0, rowLimit);
}

async function readOneFile(
  url: string,
  byteLength: number | undefined,
  columns: string[],
  filter: Record<string, unknown> | undefined,
  remaining: number,
): Promise<OvertureRow[]> {
  if (remaining <= 0) return [];

  const file: AsyncBuffer = await asyncBufferFromUrl({
    url,
    ...(byteLength != null && byteLength > 0 ? { byteLength } : {}),
  });

  let metadata: FileMetaData | undefined;
  try {
    metadata = await parquetMetadataAsync(file, { compressors });
  } catch {
    metadata = undefined;
  }

  const bboxFilter = extractBBoxFilter(filter);
  const rowGroupsToRead =
    metadata && bboxFilter ? selectIntersectingRowGroups(metadata, bboxFilter) : null;

  if (rowGroupsToRead && rowGroupsToRead.length === 0) {
    return [];
  }

  let rowStart = 0;
  let rowEnd: number | undefined;
  if (rowGroupsToRead && metadata) {
    const ranges = rowGroupRowRanges(metadata, rowGroupsToRead);
    if (ranges.length === 0) return [];
    rowStart = ranges[0].start;
    rowEnd = ranges[ranges.length - 1].end;
  }

  const objects = await parquetReadObjects({
    file,
    metadata,
    compressors,
    columns,
    filter: filter as any,
    rowStart,
    rowEnd,
  });

  return objects.slice(0, remaining) as OvertureRow[];
}

type BBoxFilter = { minLon: number; minLat: number; maxLon: number; maxLat: number };

function extractBBoxFilter(filter: Record<string, unknown> | undefined): BBoxFilter | null {
  if (!filter || !("$and" in filter) || !Array.isArray(filter.$and)) return null;
  const parts = filter.$and as Record<string, unknown>[];
  let minLon: number | undefined;
  let minLat: number | undefined;
  let maxLon: number | undefined;
  let maxLat: number | undefined;
  for (const p of parts) {
    if (p["bbox.xmin"] && typeof (p["bbox.xmin"] as any).$lte === "number") {
      maxLon = (p["bbox.xmin"] as any).$lte;
    }
    if (p["bbox.xmax"] && typeof (p["bbox.xmax"] as any).$gte === "number") {
      minLon = (p["bbox.xmax"] as any).$gte;
    }
    if (p["bbox.ymin"] && typeof (p["bbox.ymin"] as any).$lte === "number") {
      maxLat = (p["bbox.ymin"] as any).$lte;
    }
    if (p["bbox.ymax"] && typeof (p["bbox.ymax"] as any).$gte === "number") {
      minLat = (p["bbox.ymax"] as any).$gte;
    }
  }
  if (minLon == null || minLat == null || maxLon == null || maxLat == null) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function selectIntersectingRowGroups(metadata: FileMetaData, bbox: BBoxFilter): number[] {
  const selected: number[] = [];
  for (let gi = 0; gi < metadata.row_groups.length; gi++) {
    const rg = metadata.row_groups[gi];
    const stats = rowGroupBBoxStats(rg);
    if (!stats) {
      selected.push(gi);
      continue;
    }
    if (
      stats.xmax >= bbox.minLon &&
      stats.xmin <= bbox.maxLon &&
      stats.ymax >= bbox.minLat &&
      stats.ymin <= bbox.maxLat
    ) {
      selected.push(gi);
    }
  }
  return selected;
}

function rowGroupBBoxStats(rg: FileMetaData["row_groups"][number]): {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
} | null {
  let xmin: number | undefined;
  let xmax: number | undefined;
  let ymin: number | undefined;
  let ymax: number | undefined;
  for (const col of rg.columns) {
    const path = col.meta_data?.path_in_schema?.join(".") ?? "";
    const st = col.meta_data?.statistics;
    if (!st) continue;
    const min = typeof st.min_value === "number" ? st.min_value : undefined;
    const max = typeof st.max_value === "number" ? st.max_value : undefined;
    if (path === "bbox.xmin" && min != null) xmin = min;
    if (path === "bbox.xmax" && max != null) xmax = max;
    if (path === "bbox.ymin" && min != null) ymin = min;
    if (path === "bbox.ymax" && max != null) ymax = max;
  }
  if (xmin == null || xmax == null || ymin == null || ymax == null) return null;
  return { xmin, xmax, ymin, ymax };
}

function rowGroupRowRanges(
  metadata: FileMetaData,
  groupIndexes: number[],
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (let gi = 0; gi < metadata.row_groups.length; gi++) {
    const n = Number(metadata.row_groups[gi].num_rows);
    if (groupIndexes.includes(gi)) {
      ranges.push({ start: offset, end: offset + n });
    }
    offset += n;
  }
  return ranges;
}
