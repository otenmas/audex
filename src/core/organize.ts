import { basename, dirname, extname, join, relative } from "node:path";
import { access, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { openLibrary, isLibraryIndexed, queryTracks, registerLibrary, trackUnchanged, upsertTrack, pruneLibrary } from "../library.js";
import { scanFiles } from "../scan.js";
import { AUDIO_EXTS } from "../tagger.js";
import { runWithProgress } from "../progress.js";
import type { LibraryTrack } from "../library.js";
import type { OperationResult, ProgressCallback } from "../types.js";

function sanitize(s: string): string {
  return s.replace(/[/\\]/g, "_").replace(/[<>:"|?*]/g, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim() || "_";
}

const LOSSY_EXTS = new Set([".mp3", ".ogg", ".opus", ".aac", ".wma"]);

function isLossless(codec: string | null, ext: string): boolean {
  if (LOSSY_EXTS.has(ext)) return false;
  if (ext === ".m4a" || ext === ".mp4") {
    return codec != null && /alac|pcm/i.test(codec);
  }
  return true;
}

function formatKhz(sampleRate: number | null): string | null {
  if (!sampleRate) return null;
  const khz = sampleRate / 1000;
  const str = Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
  return `${str}kHz`;
}

function nearestStandardKbps(kbps: number): number {
  const standards = [96, 128, 160, 192, 224, 256, 320];
  for (const s of standards) {
    if (Math.abs(s - kbps) / s <= 0.03) return s;
  }
  return Math.round(kbps);
}

interface AlbumInfo {
  artist: string;
  album: string;
  date: string;
  format: string;
  quality: string;
  khz: string | null;
  catalog: string | null;
  multiDisc: boolean;
}

function buildAlbumInfo(tracks: LibraryTrack[]): AlbumInfo {
  const first = tracks[0];
  const artist = first.albumArtist ?? first.artist ?? "Unknown Artist";
  const album = first.album ?? "Unknown Album";
  const rawDate = first.originalYear
    ? String(first.originalYear)
    : first.date ?? (first.year ? String(first.year) : "0000");
  const yearMatch = /(\d{4})/.exec(rawDate);
  const date = yearMatch ? yearMatch[1] : "0000";
  const catalog = first.catalogNumber || null;
  const multiDisc = tracks.some((t) => (t.totalDiscs ?? 0) > 1 || (t.disc ?? 0) > 1);

  const ext = extname(first.path).toLowerCase();
  const format = ext.replace(".", "").toUpperCase();

  const rates = new Map<number, number>();
  for (const t of tracks) {
    if (t.sampleRate) rates.set(t.sampleRate, (rates.get(t.sampleRate) ?? 0) + 1);
  }
  const topRate = [...rates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const khz = formatKhz(topRate);

  let quality: string;
  if (isLossless(first.codec, ext)) {
    quality = first.bitDepth ? `${first.bitDepth}bit` : "lossless";
  } else {
    const bitrates = tracks.map((t) => t.bitrate).filter((b): b is number => b != null && b > 0);
    const avg = bitrates.length ? bitrates.reduce((a, b) => a + b, 0) / bitrates.length : 0;
    quality = avg ? `${nearestStandardKbps(avg / 1000)}kbps` : "unknown";
  }

  return { artist, album, date, format, quality, khz, catalog, multiDisc };
}

function buildAlbumDirName(info: AlbumInfo): string {
  const parts = [sanitize(info.date), sanitize(info.artist), sanitize(info.album)];
  const bracket = [info.format, info.quality, info.khz].filter(Boolean).join(" - ");
  let name = `${parts.join(" - ")} [${bracket}]`;
  if (info.catalog) name += ` {${sanitize(info.catalog)}}`;
  return name;
}

function buildTrackFileName(info: AlbumInfo, track: LibraryTrack, originalPath: string): string {
  const ext = extname(originalPath).toLowerCase();
  const title = sanitize(track.title ?? basename(originalPath, ext));
  const trackNum = String(track.track ?? 0).padStart(2, "0");
  const num = info.multiDisc ? `${track.disc ?? 1}.${trackNum}` : trackNum;
  return `${num} - ${title}${ext}`;
}

async function buildTargetPath(
  outDir: string,
  albumDirName: string,
  fileName: string,
  originalPath: string,
  force: boolean,
): Promise<string | null> {
  const candidate = join(outDir, albumDirName, fileName);

  if (candidate === originalPath) return candidate;

  try {
    await access(candidate);
    return force ? candidate : null;
  } catch {
    // file does not exist — candidate is free
  }

  return candidate;
}

async function indexDir(
  db: ReturnType<typeof openLibrary>,
  dir: string,
  force: boolean,
): Promise<void> {
  const files = await scanFiles(dir, AUDIO_EXTS);

  await runWithProgress(
    files,
    async (file) => {
      const info = await stat(file);
      const size = info.size;
      const mtime = Math.floor(info.mtimeMs);

      if (!force && trackUnchanged(db, file, size, mtime)) return;

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
        libraryRoot: dir,
      });
    },
    undefined,
    (file) => relative(dir, file),
  );
  pruneLibrary(db, dir, files);
}

export async function organizeLibrary(
  inputDir: string,
  outputDir: string | null,
  opts: { copy: boolean; forceIndex: boolean; force: boolean },
  onProgress?: ProgressCallback,
): Promise<Omit<OperationResult, "plan"> & { plan: { from: string; to: string }[] }> {
  const outDir = outputDir ?? inputDir;
  const db = openLibrary();

  if (!isLibraryIndexed(db, inputDir) || opts.forceIndex) {
    registerLibrary(db, inputDir);
    await indexDir(db, inputDir, opts.forceIndex ?? false);
  }

  const tracks = queryTracks(db, "*", inputDir);
  db.close();

  const byAlbum = new Map<string, LibraryTrack[]>();
  for (const t of tracks) {
    const rawDate = t.originalYear ? String(t.originalYear) : t.date ?? (t.year ? String(t.year) : "");
    const year = /(\d{4})/.exec(rawDate)?.[1] ?? "";
    // Discriminate releases of the same album (different pressings/remasters
    // share artist/album/year) so each gets its own folder.
    const release = t.mbReleaseId ?? t.catalogNumber ?? "";
    const key = `${t.albumArtist ?? t.artist ?? ""}||${t.album ?? ""}||${year}||${release}`;
    const list = byAlbum.get(key);
    if (list) list.push(t);
    else byAlbum.set(key, [t]);
  }

  const filePlan: { from: string; to: string }[] = [];
  for (const albumTracks of byAlbum.values()) {
    const info = buildAlbumInfo(albumTracks);
    const albumDirName = buildAlbumDirName(info);
    for (const t of albumTracks) {
      const fileName = buildTrackFileName(info, t, t.path);
      const to = await buildTargetPath(outDir, albumDirName, fileName, t.path, opts.force);
      if (to === null || t.path === to) continue;
      filePlan.push({ from: t.path, to });
    }
  }

  if (filePlan.length === 0) {
    return { ok: true, stats: { moved: 0, copied: 0 }, errors: [], plan: [] };
  }

  const errors: string[] = [];
  const fromToMap = new Map(filePlan.map(({ from, to }) => [from, to]));
  let moved = 0;
  let copied = 0;

  await runWithProgress(
    filePlan.map((p) => p.from),
    async (from) => {
      const to = fromToMap.get(from)!;
      await mkdir(dirname(to), { recursive: true });
      try {
        if (opts.copy) {
          await copyFile(from, to);
          copied++;
        } else {
          try {
            await rename(from, to);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "EXDEV") {
              await copyFile(from, to);
              await unlink(from);
            } else {
              throw err;
            }
          }
          moved++;
        }
      } catch (err) {
        errors.push(`${from}: ${(err as Error).message}`);
      }
    },
    onProgress,
    (f) => relative(inputDir, f),
  );

  return {
    ok: errors.length === 0,
    stats: { moved, copied },
    errors,
    plan: filePlan,
  };
}
