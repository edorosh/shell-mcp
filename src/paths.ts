import path from "node:path";

export interface PathMount {
  host: string;
  guest: string;
}

export class PathMapper {
  private readonly hostPath: typeof path.win32;
  /** Normalized mounts, longest guest root first. */
  private readonly mounts: PathMount[];
  private readonly re: RegExp;

  constructor(mounts: PathMount[], platform: NodeJS.Platform) {
    this.hostPath = platform === "win32" ? path.win32 : path.posix;
    this.mounts = mounts
      .map((m) => {
        const norm = this.hostPath.normalize(m.host);
        const stripped = norm.replace(/(.)[\\/]+$/, "$1");
        return {
          // Keep a bare drive root ("C:\\"): "C:" would make join drive-relative.
          host: /^[A-Za-z]:$/.test(stripped) ? norm : stripped,
          guest: path.posix.normalize(m.guest).replace(/(.)\/+$/, "$1"),
        };
      })
      .sort((x, y) => y.guest.length - x.guest.length);
    const escaped = this.mounts
      .map((m) => m.guest.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"))
      .join("|");
    this.re = new RegExp(
      "(^|[\\s\"'`(=:\\[,])(" + escaped + ")(?=/|[\\s\"'`:),\\]]|$)([^\\s\"'`:),\\]]*)",
      "gm",
    );
  }

  /** Host path for a guest path, or null when it is outside every mount. */
  toHost(guestPath: string): string | null {
    if (!guestPath.startsWith("/")) return null;
    const norm = path.posix.normalize(guestPath);
    for (const m of this.mounts) {
      const rel = path.posix.relative(m.guest, norm);
      if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) continue;
      return this.join(m.host, rel);
    }
    return null;
  }

  private join(hostRoot: string, rel: string): string | null {
    if (rel === "") return hostRoot;
    const segments = rel.split("/");
    // On Windows a guest segment may hold host separators or drive syntax.
    if (this.hostPath === path.win32 && segments.some((s) => /[\\:]/.test(s))) return null;
    const joined = this.hostPath.join(hostRoot, ...segments);
    const back = this.hostPath.relative(hostRoot, joined);
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
