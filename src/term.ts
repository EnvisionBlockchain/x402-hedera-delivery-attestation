/**
 * Terminal styling.
 *
 * The palette is the one from envisionblockchain.com, so a recording of this
 * CLI and the slides around it in the demo video look like the same product
 * rather than two different ones.
 *
 * Colour is a presentation detail and never load-bearing: every line still
 * reads correctly with escapes stripped, because the words carry the meaning
 * and the colour only reinforces it. That matters for CI logs, for pipes, and
 * for anyone reading with a screen reader.
 *
 * Disabled automatically when stdout is not a TTY, so `npm start > log.txt`
 * produces clean text. Honours NO_COLOR (https://no-color.org) and FORCE_COLOR.
 * An asciinema capture runs under a real PTY, so recordings keep their colour.
 */

const forced = process.env.FORCE_COLOR;
const enabled =
  forced !== undefined && forced !== "0"
    ? true
    : process.env.NO_COLOR !== undefined || forced === "0"
      ? false
      : Boolean(process.stdout.isTTY);

/** Brand tokens, matching scripts/video/segments.mjs THEME. */
const RGB = {
  cyan: [86, 200, 255],
  teal: [126, 224, 195],
  lavender: [201, 157, 240],
  amber: [255, 201, 138],
  red: [255, 128, 135],
  dim: [182, 190, 201],
  dimmer: [107, 116, 128],
} as const;

type Token = keyof typeof RGB;

function paint(token: Token, text: string): string {
  if (!enabled) return text;
  const [r, g, b] = RGB[token];
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export const colorEnabled = enabled;

export const c = {
  cyan: (s: string) => paint("cyan", s),
  teal: (s: string) => paint("teal", s),
  lavender: (s: string) => paint("lavender", s),
  amber: (s: string) => paint("amber", s),
  red: (s: string) => paint("red", s),
  dim: (s: string) => paint("dim", s),
  dimmer: (s: string) => paint("dimmer", s),
  bold: (s: string) => (enabled ? `\x1b[1m${s}\x1b[22m` : s),
  /** Success. Reads as "confirmed", not merely "green". */
  ok: (s: string) => paint("teal", s),
  /** Failure. Always paired with a word, never colour alone. */
  bad: (s: string) => paint("red", s),
  warn: (s: string) => paint("amber", s),
  /** A URL or identifier worth the eye landing on. */
  link: (s: string) => paint("cyan", s),
};

/** Visible width, ignoring escape sequences, for alignment maths. */
export function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pads to a visible width, so colouring before padding still aligns. */
export function pad(text: string, to: number): string {
  return text + " ".repeat(Math.max(0, to - width(text)));
}

export const RULE_WIDTH = 74;

/** Heavy rule used to open and close a section. */
export function rule(char = "━", w = RULE_WIDTH): string {
  return c.dimmer(char.repeat(w));
}

/**
 * Section banner: a title between two rules.
 *
 * @param title - Section name
 * @param accent - Which brand colour carries the title
 * @returns The banner, ready to print
 */
export function banner(title: string, accent: "cyan" | "teal" | "red" | "lavender" = "cyan"): string {
  return [rule(), ` ${c.bold(c[accent](title))}`, rule()].join("\n");
}

/**
 * Width of the check-name column.
 *
 * Sized for the common case rather than the longest case. Widening it to fit
 * `seller_identity_controls_paid_account` would cost every other line nine
 * columns of detail text; `check` gives an over-long label its own line
 * instead, so one name pays for its length rather than all of them.
 */
const LABEL_COLUMN = 28;
/** Gutter before the label: two spaces, a mark, two spaces. */
const GUTTER = 5;

/** Terminal width, with a sane floor for pipes and narrow windows. */
function columns(): number {
  return Math.max(60, process.stdout.columns ?? 100);
}

/**
 * Wraps detail text into the detail column with a hanging indent.
 *
 * Without this, a long check detail wraps to column zero and the output looks
 * broken rather than dense. Several of these details are full DIDs plus a
 * sentence, so they exceed any reasonable width.
 *
 * @param detail - Text to wrap
 * @param indent - Visible column the text starts at
 * @returns Wrapped text, continuation lines aligned under the first
 */
function wrapDetail(detail: string, indent: number): string {
  const room = columns() - indent - 1;
  if (room <= 20 || detail.length <= room) return detail;

  const lines: string[] = [];
  let current = "";
  for (const word of detail.split(" ")) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= room) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.join(`\n${" ".repeat(indent)}`);
}

function check(mark: string, label: string, detail: string | undefined, ok: boolean): string {
  const indent = GUTTER + LABEL_COLUMN;
  // A label at or past the column would abut the detail with no separator, so
  // it gets its own line rather than colliding.
  const overlong = width(label) >= LABEL_COLUMN;
  const head = ok ? c.ok(pad(label, LABEL_COLUMN)) : c.bad(c.bold(pad(label, LABEL_COLUMN)));
  const body = detail ? c.dim(wrapDetail(detail, indent)) : "";
  const separator = overlong && detail ? `\n${" ".repeat(indent)}` : "";
  return `  ${ok ? c.ok(mark) : c.bad(mark)}  ${head}${separator}${body}`;
}

/** A passed check. */
export function pass(label: string, detail?: string): string {
  return check("✓", label, detail, true);
}

/** A failed check. The mark, the weight, and the word all say so. */
export function fail(label: string, detail?: string): string {
  return check("✗", label, detail, false);
}

/** Aligned `key : value` line, for the header blocks. */
export function field(key: string, value: string, keyWidth = 17): string {
  return `  ${c.dimmer(pad(key, keyWidth))}: ${value}`;
}
