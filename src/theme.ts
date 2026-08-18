/**
 * Terminal background detection.
 *
 * The OSC 11 query, its reply grammar, and the luminance threshold are taken from
 * Hunk's own `src/core/theme/detection.ts` (MIT, Copyright (c) Ben Vinegar,
 * https://github.com/modem-dev/hunk) so that this extension classifies a
 * background the same way Hunk's built-in `theme = "auto"` does. Two different
 * answers for the same terminal would be worse than none. See NOTICE.
 *
 * The query goes to stdout and the reply is read from stdin, matching Hunk's
 * detection at the protocol and classification level. Hunk's extension guidance says
 * not to write to stdout, because the renderer leases that stream and replaces
 * `stdout.write`. That applies to a mounted renderer; this runs in the factory, before
 * any renderer exists, and the module-level cache below guarantees it never runs a
 * second time — factories are re-run mid-session on repo-trust and on cwd changes
 * under `--watch`.
 */
import type { CustomThemeConfig } from "hunkdiff/extension";

export type TerminalThemeMode = "light" | "dark";

export const OSC_11_BACKGROUND_QUERY = "\x1b]11;?\x1b\\";

/** A real reply is under 32 bytes. Cap the buffer so a chatty terminal cannot grow it. */
const MAX_REPLY_BYTES = 4096;

/** The parts of a TTY read stream this query needs, so tests can pass a plain stream. */
type QueryInput = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  readonly isRaw?: boolean;
  resume?(): unknown;
  setRawMode?(mode: boolean): unknown;
};

export function parseOsc11BackgroundColor(sequence: string) {
  const rgb = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\x07|\x1b\\)/i.exec(
    sequence,
  );
  if (rgb) {
    const red = parseChannel(rgb[1]);
    const green = parseChannel(rgb[2]);
    const blue = parseChannel(rgb[3]);
    if (red === undefined || green === undefined || blue === undefined) return undefined;
    return {
      red,
      green,
      blue,
    };
  }

  const hex = /\x1b\]11;#([0-9a-f]{6})(?:\x07|\x1b\\)/i.exec(sequence);
  if (!hex) return undefined;

  return {
    red: Number.parseInt(hex[1].slice(0, 2), 16),
    green: Number.parseInt(hex[1].slice(2, 4), 16),
    blue: Number.parseInt(hex[1].slice(4, 6), 16),
  };
}

function parseChannel(value: string): number | undefined {
  const parsed = Number.parseInt(value, 16);
  if (Number.isNaN(parsed)) return undefined;
  return Math.round((parsed / (16 ** value.length - 1)) * 255);
}

export function themeModeForBackground({
  red,
  green,
  blue,
}: {
  red: number;
  green: number;
  blue: number;
}): TerminalThemeMode {
  const linear = [red, green, blue].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.5 ? "light" : "dark";
}

/**
 * Ask one stream for the background color and classify it.
 *
 * Raw mode is a property of the terminal device, not of this stream, so a throw
 * between enabling and restoring it would leave the user's shell without echo.
 * The restore therefore lives in `finally`.
 */
export async function readThemeModeFromTerminal({
  input,
  write,
  timeoutMs = 150,
}: {
  input: QueryInput;
  write: (query: string) => boolean;
  timeoutMs?: number;
}): Promise<TerminalThemeMode | undefined> {
  const wasRaw = input.isRaw ?? false;
  let onData: ((chunk: Buffer | string) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<TerminalThemeMode | undefined>((resolve) => {
      let buffer = "";
      onData = (chunk) => {
        buffer += chunk.toString();
        const color = parseOsc11BackgroundColor(buffer);
        if (color) resolve(themeModeForBackground(color));
        else if (Buffer.byteLength(buffer) > MAX_REPLY_BYTES) resolve(undefined);
      };

      timer = setTimeout(() => resolve(undefined), timeoutMs);
      input.setRawMode?.(true);
      input.resume?.();
      input.on("data", onData);
      if (!write(OSC_11_BACKGROUND_QUERY)) resolve(undefined);
    });
  } finally {
    clearTimeout(timer);
    if (onData) input.off("data", onData);
    input.setRawMode?.(wasRaw);
  }
}

let cached: Promise<TerminalThemeMode | undefined> | undefined;

/**
 * Ask the terminal for its background, or give up.
 *
 * Returns `undefined` whenever no answer is available: stdin or stdout is not a
 * terminal (piped input, pager mode, CI), no reply arrives within the timeout, or the
 * reply cannot be parsed. The answer — including a failure — is cached for the life of
 * the process, so a mid-session extension reload never queries a live renderer's
 * streams. Extension modules are imported without cache busting, so this survives.
 *
 * Note: bytes typed during the query window are consumed rather than delivered,
 * exactly as Hunk's own `theme = "auto"` does. Pushing them back would mean tracking
 * which bytes belonged to the reply; a one-off 150 ms window is not worth it.
 */
export async function queryTerminalThemeMode(timeoutMs?: number) {
  if (cached) return cached;

  cached = detectTerminalThemeMode(timeoutMs);
  return cached;
}

async function detectTerminalThemeMode(timeoutMs?: number) {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    return undefined;
  }

  const wasPaused = input.isPaused();
  try {
    return await readThemeModeFromTerminal({
      input,
      write: (query) => output.write(query),
      timeoutMs,
    });
  } catch {
    return undefined;
  } finally {
    if (wasPaused) input.pause();
  }
}

/**
 * Read the theme for `mode` out of the extension's config table.
 *
 * A repository under review can set this table, so values are shape-checked here.
 * Key names are Hunk's business — config themes and `registerTheme` calls share
 * one validation path — and `id`/`label` are dropped because this extension owns
 * its own identity in the theme selector.
 */
export function selectTheme(config: unknown, mode: TerminalThemeMode): CustomThemeConfig {
  if (!isRecord(config)) return {};
  const candidate = config[mode];
  if (!isRecord(candidate)) return {};

  const theme: Record<string, string | Record<string, string>> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "id" || key === "label") continue;
    if (typeof value === "string") theme[key] = value;
    else if ((key === "syntax" || key === "syntaxScopes") && isRecord(value)) {
      theme[key] = onlyStrings(value);
    }
  }

  return theme as CustomThemeConfig;
}

function onlyStrings(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
