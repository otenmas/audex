import { relative } from "node:path";
import { stat } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { scanFiles } from "../scan.js";
import { AUDIO_EXTS } from "../tagger.js";
import { runWithProgress } from "../progress.js";
import { openLibrary, pruneLibrary, registerLibrary, trackUnchanged, upsertTrack } from "../library.js";
import type { OperationResult, ProgressCallback } from "../types.js";

export async function indexLibrary(
  inputDir: string,
  opts: { force: boolean },
  onProgress?: ProgressCallback,
): Promise<OperationResult> {
  const files = await scanFiles(inputDir, AUDIO_EXTS);
  const db = openLibrary();
  registerLibrary(db, inputDir);

  let indexed = 0;
  let skipped = 0;

  await runWithProgress(
    files,
    async (file) => {
      const info = await stat(file);
      const size = info.size;
      const mtime = Math.floor(info.mtimeMs);

      if (!opts.force && trackUnchanged(db, file, size, mtime)) {
        skipped++;
        return;
      }

      const mm = await parseFile(file).catch(() => null);
      const c = mm?.common;
      const f = mm?.format;

      upsertTrack(db, {
        path: file,
        artist: c?.artist ?? c?.albumartist ?? c?.artists?.[0] ?? null,
        album: c?.album ?? null,
        albumArtist: c?.albumartist ?? null,
        title: c?.title ?? null,
        track: c?.track?.no ?? null,
        disc: c?.disk?.no ?? null,
        totalDiscs: c?.disk?.of ?? null,
        year: c?.year ?? null,
        date: c?.date ?? null,
        originalYear: c?.originalyear ?? null,
        catalogNumber: Array.isArray(c?.catalognumber) ? c.catalognumber[0] ?? null : c?.catalognumber ?? null,
        mbReleaseId: c?.musicbrainz_albumid ?? null,
        codec: f?.codec ?? null,
        bitrate: f?.bitrate ? Math.round(f.bitrate) : null,
        sampleRate: f?.sampleRate ?? null,
        bitDepth: f?.bitsPerSample ?? null,
        genre: c?.genre?.[0] ?? null,
        duration: f?.duration ?? null,
        fileSize: size,
        mtime,
        libraryRoot: inputDir,
      });

      indexed++;
    },
    onProgress,
    (file) => relative(inputDir, file),
  );

  const pruned = pruneLibrary(db, inputDir, files);
  db.close();

  return { ok: true, stats: { indexed, skipped, pruned }, errors: [] };
}
