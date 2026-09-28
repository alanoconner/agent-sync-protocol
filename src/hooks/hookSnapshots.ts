import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface SnapshotIdentity {
  workspaceRoot: string;
  sessionId?: string;
  toolUseId?: string;
}

export class HookSnapshots {
  constructor(private readonly directory = join(tmpdir(), "agent-sync-hook-snapshots")) {}

  private path(identity: SnapshotIdentity, docName: string): string {
    if (!identity.sessionId || !identity.toolUseId) throw new Error("Hook snapshot requires session_id and tool_use_id.");
    const key = JSON.stringify([resolve(identity.workspaceRoot), identity.sessionId, identity.toolUseId, docName]);
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.snapshot`);
  }

  stash(identity: SnapshotIdentity, docName: string, content: string): void {
    const path = this.path(identity, docName);
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  take(identity: SnapshotIdentity, docName: string): string {
    const path = this.path(identity, docName);
    const content = readFileSync(path, "utf8");
    unlinkSync(path);
    return content;
  }
}
