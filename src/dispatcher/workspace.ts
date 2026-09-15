import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type WorkspaceState = { branch: string; head: string; dirty: boolean } | null;
export async function workspaceState(cwd: string): Promise<WorkspaceState> {
  const git = async (...args: string[]) => (await execute("git", ["-C", cwd, ...args], {
    windowsHide: true, timeout: 10000, maxBuffer: 65536
  })).stdout.trim();
  try {
    const results = await Promise.allSettled([git("rev-parse", "--abbrev-ref", "HEAD"), git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=normal")]);
    if (results.some(result => result.status === "rejected")) return null;
    const [branch, head, status] = results.map(result => (result as PromiseFulfilledResult<string>).value);
    return { branch: branch!, head: head!, dirty: status!.length > 0 };
  } catch { return null; } // A non-Git fixture/project is supported; unknown Git state is never evidence of equality.
}
export function sameRevision(left: WorkspaceState | undefined, right: WorkspaceState | undefined): boolean {
  return !!left && !!right && left.branch === right.branch && left.head === right.head;
}
