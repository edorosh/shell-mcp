import path from "node:path";

export class PathMapper {
  private readonly hostPath: typeof path.win32;
  private readonly guestRoot: string;
  private readonly re: RegExp;

  constructor(
    private readonly hostRoot: string,
    guestRoot: string,
    platform: NodeJS.Platform,
  ) {
    this.hostPath = platform === "win32" ? path.win32 : path.posix;
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
    return this.hostPath.join(this.hostRoot, ...rel.split("/"));
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
