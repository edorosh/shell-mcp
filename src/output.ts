/** Streaming UTF-8 decoder: multibyte characters split across chunks are joined. */
export class Utf8Accumulator {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private buf = "";

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
  }

  text(): string {
    return this.buf + this.decoder.decode();
  }
}

const marker = (n: number): string => `[... ${n} characters omitted ...]`;

/**
 * Keep the head (40%) and tail (60%) of `text`, replacing the middle with a marker.
 * The marker counts characters cut here plus `alreadyOmitted` (dropped upstream),
 * and the whole result is guaranteed to be at most `max` characters.
 */
export function truncateMiddle(
  text: string,
  max: number,
  alreadyOmitted = 0,
): { text: string; omitted: number } {
  if (text.length <= max && alreadyOmitted === 0) return { text, omitted: 0 };

  let keep = text.length <= max ? text.length : max;
  let omitted = alreadyOmitted + text.length - keep;
  // The marker length depends on the digits of `omitted`, which depends on keep: iterate to a fixed point.
  for (let i = 0; i < 5; i++) {
    const next = Math.max(0, Math.min(text.length, max - marker(omitted).length));
    keep = next;
    const o = alreadyOmitted + text.length - keep;
    if (o === omitted) break;
    omitted = o;
  }
  // Guard against a non-converged edge: shrink until it fits.
  while (keep > 0 && keep + marker(omitted).length > max) {
    keep--;
    omitted = alreadyOmitted + text.length - keep;
  }
  if (keep >= text.length) return { text: text + marker(omitted), omitted };
  const head = Math.floor(keep * 0.4);
  const tail = keep - head;
  return {
    text: text.slice(0, head) + marker(omitted) + (tail > 0 ? text.slice(text.length - tail) : ""),
    omitted,
  };
}
