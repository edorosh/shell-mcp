import path from "node:path";

export class PathMapper {
  private readonly hostPath: typeof path.win32;
  private readonly hostRoot: string;
  private readonly guestRoot: string;
  private readonly re: RegExp;

  constructor(
    hostRoot: string,
    guestRoot: string,
    platform: NodeJS.Platform,
  ) {
    this.hostPath = platform === "win32" ? path.win32 : path.posix;
    this.hostRoot = this.hostPath.normalize(hostRoot).replace(/(.)[\\/]+$/, "$1");
    this.guestRoot = path.posix.normalize(guestRoot).replace(/(.)\/+$/, "$1");
    const escaped = this.guestRoot.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
    this.re = new RegExp(
      "(^|[\\s\"'`(=:\\[,])(" + escaped + ")(?=/|[\\s\"'`:),\\]]|$)([^\\s\"'`:),\\]]*)",
      "gm",
    );
  }

  /** Host path for a guest path, or null when it is outside the guest root. */
  toHost(guestPath: string): string | null {
    if (!guestPath.startsWith("/")) return null;
    const rel = path.posix.relative(this.guestRoot, path.posix.normalize(guestPath));
    if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
    if (rel === "") return this.hostRoot;
    const segments = rel.split("/");
    // On Windows a guest segment may hold host separators or drive syntax.
    if (this.hostPath === path.win32 && segments.some((s) => /[\\:]/.test(s))) return null;
    const joined = this.hostPath.join(this.hostRoot, ...segments);
    const back = this.hostPath.relative(this.hostRoot, joined);
    if (back === ".." || back.startsWith(".." + this.hostPath.sep) || this.hostPath.isAbsolute(back)) {
      return null;
    }
    return joined;
  }

  displayCwd(guestCwd: string): string {
    return this.toHost(guestCwd) ?? guestCwd;
  }

  rewriteOutput(text: string): string {
    return text.replace(this.re, (match, lead: string, root: string, rest: string) => {
      const host = this.toHost(root + rest);
      return host === null ? match : lead + host;
    });
  }
}
