/** Streaming UTF-8 decoder: multibyte characters split across chunks are joined. */
export class Utf8Accumulator {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private buf = "";

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
  }

  /** Non-destructive: pending partial bytes stay in the decoder for the next push. */
  text(): string {
    return this.buf;
  }

  /** End of stream: flush any incomplete sequence (becomes U+FFFD) and return the full text. */
  finish(): string {
    this.buf += this.decoder.decode();
    return this.buf;
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
  const len = text.length;
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

  const build = (keep: number): { text: string; omitted: number } => {
    if (keep >= len) {
      const omitted = alreadyOmitted;
      return { text: text + marker(omitted), omitted };
    }
    let head = Math.floor(keep * 0.4);
    let tailStart = len - (keep - head);
    // Do not split surrogate pairs at either cut point.
    if (head > 0 && isHigh(text.charCodeAt(head - 1))) head--;
    if (tailStart < len && isLow(text.charCodeAt(tailStart)) && tailStart > 0 && isHigh(text.charCodeAt(tailStart - 1))) tailStart++;
    const omitted = alreadyOmitted + (tailStart - head);
    return { text: text.slice(0, head) + marker(omitted) + text.slice(tailStart), omitted };
  };

  for (let keep = Math.min(len, Math.max(0, max)); keep > 0; keep--) {
    const r = build(keep);
    if (r.text.length <= max) return r;
  }
  // Budget smaller than the marker itself: hard-slice the marker.
  const omitted = alreadyOmitted + len;
  return { text: marker(omitted).slice(0, Math.max(0, max)), omitted };
}
