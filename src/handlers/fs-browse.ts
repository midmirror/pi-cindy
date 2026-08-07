/**
 * 本机 FS 浏览 invoke handler —— fs:stat-path。
 *
 * 对齐 desktop fsBrowse/ipc.ts（channel 已在 device-link allowlist 内，
 * 设计上就允许被控端经隧道执行，见参考仓 apps/desktop/src/main/fsBrowse/ipc.ts
 * registerFsBrowseIpc 注释）。返回形状 FsStatResult：
 *   { kind: 'dir' | 'file' | 'missing', resolvedPath }
 * 手机端用 stat 判断「已存在项目目录 / 新目录名」分支（missing 场景）。
 */
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

export interface FsStatResult {
  kind: "dir" | "file" | "missing";
  resolvedPath: string;
}

/**
 * 把 `~` 开头路径展开到本机 home 并归一为绝对路径（对齐 desktop expandHome）：
 * 空串 / `~` → home；`~/x` → home/x；绝对路径 → resolve；相对路径 → 相对 home 兜底
 * （项目选择器里不该出现相对路径；被控端 process.cwd 无意义）。
 */
export function expandHome(input: string): string {
  const home = os.homedir();
  const raw = (input ?? "").trim();
  if (raw === "" || raw === "~" || raw === "~/" || raw === "~\\") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.resolve(home, raw.slice(2));
  }
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(home, raw);
}

/** fs:stat-path —— 判断路径是 dir / file / missing。 */
export async function statPath(args: unknown[]): Promise<FsStatResult> {
  const obj = args[0] as { path?: unknown } | undefined;
  const raw = typeof obj?.path === "string" ? obj.path : "";
  const resolvedPath = expandHome(raw);
  try {
    const st = await stat(resolvedPath);
    return { kind: st.isDirectory() ? "dir" : "file", resolvedPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "missing", resolvedPath };
    }
    throw Object.assign(
      new Error(`stat failed: ${err instanceof Error ? err.message : String(err)}`),
      { code: "FS_BROWSE_FAILED" },
    );
  }
}
