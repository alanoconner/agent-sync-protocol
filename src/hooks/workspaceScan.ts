import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface FileState {
  mtimeMs: number;
  size: number;
  hash: string | null;
}
export type Manifest = Record<string, FileState>;
export type FileChange =
  | { kind: "write"; docName: string; before: string; after: string; isNew: boolean }
  | { kind: "delete"; docName: string; before: string };

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_CHANGES_PER_CALL = 200;
const OBJECT_MIN_AGE_MS = 10 * 60 * 1000;
const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function isAlwaysExcluded(rel: string): boolean {
  const segments = rel.split("/");
  return segments.includes(".git") || segments.includes("node_modules") || segments[0] === ".claude" ||
    segments[0] === ".codex" || rel === ".agent-sync.yml";
}

export function compileIgnore(patterns: string[]): (rel: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
      .replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*");
    return new RegExp(`^${source}(?:/.*)?$`);
  });
  return (rel) => regexes.some((regex) => regex.test(rel));
}

function sha1(buffer: Buffer): string { return createHash("sha1").update(buffer).digest("hex"); }
function isProbablyBinary(buffer: Buffer): boolean { return buffer.subarray(0, 8000).includes(0); }

export class WorkspaceScanner {
  private readonly base: string;
  private readonly isIgnored: (rel: string) => boolean;

  constructor(private readonly workspaceRoot: string, ignorePatterns: string[] = [], storeDir = join(tmpdir(), "agent-sync-hook-workspace")) {
    this.base = join(storeDir, createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 24));
    this.isIgnored = compileIgnore(ignorePatterns);
  }

  private get objectsDir(): string { return join(this.base, "objects"); }
  private get runsDir(): string { return join(this.base, "runs"); }
  private get cachePath(): string { return join(this.base, "cache.json"); }
  isExcluded(rel: string): boolean { return isAlwaysExcluded(rel) || this.isIgnored(rel); }

  listFiles(): string[] {
    let names: string[];
    try {
      const out = execFileSync("git", ["-C", this.workspaceRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      });
      names = out.toString("utf8").split("\0").filter(Boolean);
    } catch { names = this.walk(""); }
    return [...new Set(names)].filter((rel) => !this.isExcluded(rel));
  }

  private walk(dir: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(join(this.workspaceRoot, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (isAlwaysExcluded(rel)) continue;
      if (entry.isDirectory()) result.push(...this.walk(rel));
      else if (entry.isFile()) result.push(rel);
    }
    return result;
  }

  private loadCache(): Manifest { try { return JSON.parse(readFileSync(this.cachePath, "utf8")) as Manifest; } catch { return {}; } }
  private writeAtomic(path: string, content: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  }
  private stat(rel: string): Stats | undefined {
    try { const st = lstatSync(join(this.workspaceRoot, rel)); return st.isFile() ? st : undefined; } catch { return undefined; }
  }
  private record(rel: string, st: Stats, store: boolean): FileState {
    const state: FileState = { mtimeMs: st.mtimeMs, size: st.size, hash: null };
    if (st.size > MAX_FILE_BYTES) return state;
    const buffer = readFileSync(join(this.workspaceRoot, rel));
    if (isProbablyBinary(buffer)) return state;
    state.hash = sha1(buffer);
    if (store) {
      mkdirSync(this.objectsDir, { recursive: true });
      try { writeFileSync(join(this.objectsDir, state.hash), buffer, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    return state;
  }

  snapshot(): Manifest {
    const cache = this.loadCache();
    const manifest: Manifest = {};
    for (const rel of this.listFiles()) {
      const st = this.stat(rel);
      if (!st) continue;
      const previous = cache[rel];
      manifest[rel] = previous && previous.mtimeMs === st.mtimeMs && previous.size === st.size ? previous : this.record(rel, st, true);
    }
    this.writeAtomic(this.cachePath, JSON.stringify(manifest));
    return manifest;
  }
  saveRun(runId: string, manifest: Manifest): void {
    this.writeAtomic(join(this.runsDir, `${runId}.json`), JSON.stringify(manifest));
    this.collectGarbage(manifest);
  }
  takeRun(runId: string): Manifest {
    const path = join(this.runsDir, `${runId}.json`);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    rmSync(path, { force: true });
    return manifest;
  }
  private readObject(hash: string): string | undefined { try { return readFileSync(join(this.objectsDir, hash), "utf8"); } catch { return undefined; } }
  changes(pre: Manifest): { changes: FileChange[]; warnings: string[] } {
    const changes: FileChange[] = [];
    const warnings: string[] = [];
    for (const rel of this.listFiles()) {
      const st = this.stat(rel);
      if (!st) continue;
      const previous = pre[rel];
      if (previous && previous.mtimeMs === st.mtimeMs && previous.size === st.size) continue;
      if (previous?.hash === null) continue;
      const now = this.record(rel, st, false);
      if (now.hash === null || (previous && previous.hash === now.hash)) continue;
      const before = previous ? this.readObject(previous.hash as string) : "";
      if (before === undefined) { warnings.push(`${rel}: pre-command snapshot is unavailable — not synced.`); continue; }
      changes.push({ kind: "write", docName: rel, before, after: readFileSync(join(this.workspaceRoot, rel), "utf8"), isNew: !previous });
    }
    for (const [rel, previous] of Object.entries(pre)) {
      if (this.stat(rel)) continue;
      if (previous.hash === null) {
        warnings.push(`${rel}: deleted binary or oversized file is not synced.`);
        continue;
      }
      const before = this.readObject(previous.hash);
      if (before === undefined) {
        warnings.push(`${rel}: pre-command snapshot is unavailable — deletion not synced.`);
        continue;
      }
      changes.push({ kind: "delete", docName: rel, before });
    }
    if (changes.length > MAX_CHANGES_PER_CALL) {
      warnings.push(`${changes.length} files changed; syncing only the first ${MAX_CHANGES_PER_CALL}.`);
      changes.length = MAX_CHANGES_PER_CALL;
    }
    return { changes, warnings };
  }
  private collectGarbage(current: Manifest): void {
    const referenced = new Set<string>();
    const addAll = (manifest: Manifest) => { for (const state of Object.values(manifest)) if (state.hash) referenced.add(state.hash); };
    addAll(current);
    const now = Date.now();
    try {
      for (const name of readdirSync(this.runsDir)) {
        const path = join(this.runsDir, name);
        if (!name.endsWith(".json")) continue;
        if (now - statSync(path).mtimeMs > RUN_MAX_AGE_MS) rmSync(path, { force: true });
        else addAll(JSON.parse(readFileSync(path, "utf8")) as Manifest);
      }
      if (!existsSync(this.objectsDir)) return;
      for (const name of readdirSync(this.objectsDir)) {
        const path = join(this.objectsDir, name);
        if (!referenced.has(name) && now - statSync(path).mtimeMs > OBJECT_MIN_AGE_MS) rmSync(path, { force: true });
      }
    } catch { /* best-effort cleanup */ }
  }
}
