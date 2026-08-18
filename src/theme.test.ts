import { describe, expect, mock, test } from "bun:test";
import {
  OSC_11_BACKGROUND_QUERY,
  parseOsc11BackgroundColor,
  queryTerminalThemeMode,
  readThemeModeFromTerminal,
  selectTheme,
  themeModeForBackground,
} from "./theme.js";
import type { TerminalThemeMode } from "./theme.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** A stand-in for a TTY read stream that records raw-mode changes and listeners. */
function fakeInput({ isRaw = false } = {}) {
  const listeners = new Set<(chunk: Buffer | string) => void>();
  const rawModes: boolean[] = [];
  const resumeCalls: number[] = [];
  return {
    rawModes,
    resumeCalls,
    get listenerCount() {
      return listeners.size;
    },
    emit(chunk: string) {
      for (const listener of Array.from(listeners)) listener(chunk);
    },
    input: {
      isRaw,
      on(_event: "data", listener: (chunk: Buffer | string) => void) {
        listeners.add(listener);
      },
      off(_event: "data", listener: (chunk: Buffer | string) => void) {
        listeners.delete(listener);
      },
      setRawMode(mode: boolean) {
        rawModes.push(mode);
      },
      resume() {
        resumeCalls.push(1);
      },
    },
  };
}

/** Put a property descriptor back, or remove the stand-in if there was none. */
function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete (target as Record<string, unknown>)[key];
}

describe("OSC_11_BACKGROUND_QUERY", () => {
  test("is the escaped background query, with no raw control bytes in source", () => {
    expect(OSC_11_BACKGROUND_QUERY).toBe(`${ESC}]11;?${ESC}\\`);
  });
});

describe("parseOsc11BackgroundColor", () => {
  test("parses OSC 11 RGB responses", () => {
    expect(parseOsc11BackgroundColor(`${ESC}]11;rgb:ffff/8000/0000${BEL}`)).toEqual({
      red: 255,
      green: 128,
      blue: 0,
    });
  });

  test("parses OSC 11 hex responses", () => {
    expect(parseOsc11BackgroundColor(`${ESC}]11;#ffffff${ESC}\\`)).toEqual({
      red: 255,
      green: 255,
      blue: 255,
    });
  });

  test("accepts both terminators and scales two-digit channels", () => {
    expect(parseOsc11BackgroundColor(`${ESC}]11;rgb:1e/1e/1e${ESC}\\`)).toEqual({
      red: 30,
      green: 30,
      blue: 30,
    });
  });

  test("finds a reply that arrives behind other bytes", () => {
    expect(parseOsc11BackgroundColor(`junk${ESC}]11;#000000${BEL}`)).toEqual({
      red: 0,
      green: 0,
      blue: 0,
    });
  });

  test("rejects unterminated, malformed, and unrelated sequences", () => {
    expect(parseOsc11BackgroundColor(`${ESC}]11;rgb:ffff/8000/0000`)).toBeUndefined();
    expect(parseOsc11BackgroundColor(`${ESC}]11;#fff${BEL}`)).toBeUndefined();
    expect(parseOsc11BackgroundColor(`${ESC}]10;#ffffff${BEL}`)).toBeUndefined();
    expect(parseOsc11BackgroundColor("")).toBeUndefined();
  });
});

describe("themeModeForBackground", () => {
  test("classifies black as dark and white as light", () => {
    expect(themeModeForBackground({ red: 0, green: 0, blue: 0 })).toBe("dark");
    expect(themeModeForBackground({ red: 255, green: 255, blue: 255 })).toBe("light");
  });

  test("classifies real terminal backgrounds the way Hunk's built-in auto does", () => {
    const cases: [string, { red: number; green: number; blue: number }, TerminalThemeMode][] = [
      ["one dark #282c34", { red: 40, green: 44, blue: 52 }, "dark"],
      ["solarized light #fdf6e3", { red: 253, green: 246, blue: 227 }, "light"],
      ["gruvbox light #fbf1c7", { red: 251, green: 241, blue: 199 }, "light"],
      ["solarized dark #002b36", { red: 0, green: 43, blue: 54 }, "dark"],
      ["mid gray #808080", { red: 128, green: 128, blue: 128 }, "dark"],
    ];
    for (const [name, color, expected] of cases) {
      expect(themeModeForBackground(color), name).toBe(expected);
    }
  });
});

describe("readThemeModeFromTerminal", () => {
  test("writes the query and resolves from the reply", async () => {
    const fake = fakeInput();
    const write = mock(() => {
      fake.emit(`${ESC}]11;#ffffff${ESC}\\`);
      return true;
    });

    expect(await readThemeModeFromTerminal({ input: fake.input, write })).toBe("light");
    expect(write).toHaveBeenCalledWith(OSC_11_BACKGROUND_QUERY);
  });

  test("assembles a reply split across chunks", async () => {
    const fake = fakeInput();
    const write = () => {
      fake.emit(`${ESC}]11;rgb:0000/`);
      fake.emit(`0000/0000${BEL}`);
      return true;
    };

    await expect(readThemeModeFromTerminal({ input: fake.input, write })).resolves.toBe("dark");
  });

  test("gives up when the terminal stays silent", async () => {
    const fake = fakeInput();

    await expect(
      readThemeModeFromTerminal({ input: fake.input, write: () => true, timeoutMs: 1 }),
    ).resolves.toBeUndefined();
  });

  test("gives up once the reply exceeds the buffer cap", async () => {
    const fake = fakeInput();
    const write = () => {
      fake.emit("x".repeat(5000));
      return true;
    };

    await expect(
      readThemeModeFromTerminal({ input: fake.input, write, timeoutMs: 50 }),
    ).resolves.toBeUndefined();
  });

  test("gives up at once when the query cannot be written", async () => {
    const fake = fakeInput();
    const started = Date.now();

    await expect(
      readThemeModeFromTerminal({ input: fake.input, write: () => false, timeoutMs: 10_000 }),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake.rawModes).toEqual([true, false]);
  });

  test("restores raw mode and drops its listener on every path", async () => {
    const answered = fakeInput();
    await readThemeModeFromTerminal({
      input: answered.input,
      write: () => {
        answered.emit(`${ESC}]11;#000000${BEL}`);
        return true;
      },
    });
    expect(answered.rawModes, "answered").toEqual([true, false]);
    expect(answered.resumeCalls, "answered").toHaveLength(1);
    expect(answered.listenerCount, "answered").toBe(0);

    const silent = fakeInput();
    await readThemeModeFromTerminal({ input: silent.input, write: () => true, timeoutMs: 1 });
    expect(silent.rawModes, "silent").toEqual([true, false]);
    expect(silent.resumeCalls, "silent").toHaveLength(1);
    expect(silent.listenerCount, "silent").toBe(0);
  });

  test("preserves a terminal that was already in raw mode", async () => {
    const fake = fakeInput({ isRaw: true });

    await readThemeModeFromTerminal({ input: fake.input, write: () => true, timeoutMs: 1 });
    expect(fake.rawModes).toEqual([true, true]);
  });

  test("restores raw mode when writing the query throws", async () => {
    const fake = fakeInput();
    const write = () => {
      throw new Error("terminal went away");
    };

    await expect(readThemeModeFromTerminal({ input: fake.input, write })).rejects.toThrow(
      "terminal went away",
    );
    expect(fake.rawModes).toEqual([true, false]);
    expect(fake.listenerCount).toBe(0);
  });
});

describe("queryTerminalThemeMode", () => {
  test("queries at most once concurrently and sequentially", async () => {
    // Factories re-run on repo-trust and on cwd changes under --watch. By then the
    // renderer has leased stdin and stdout, so a second query must never happen.
    const queries: string[] = [];
    const realWrite = process.stdout.write;
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      if (chunk.toString() === OSC_11_BACKGROUND_QUERY) queries.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const firstPromise = queryTerminalThemeMode(1);
      const secondPromise = queryTerminalThemeMode(1);
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(queries).toHaveLength(1);
      expect(second).toBe(first);
      await queryTerminalThemeMode(1);
      expect(queries).toHaveLength(1);
    } finally {
      process.stdout.write = realWrite;
      restore(process.stdin, "isTTY", stdinTTY);
      restore(process.stdout, "isTTY", stdoutTTY);
    }
  });
});

describe("selectTheme", () => {
  test("selects the requested configuration and keeps its fixed identity", () => {
    const config = {
      light: { id: "ignored", label: "Ignored", base: "github-light-default", accent: "#123456" },
      dark: { base: "github-dark-default", accent: "#abcdef" },
    };

    expect(selectTheme(config, "light")).toEqual({
      base: "github-light-default",
      accent: "#123456",
    });
    expect(selectTheme(config, "dark")).toEqual({
      base: "github-dark-default",
      accent: "#abcdef",
    });
  });

  test("keeps syntax scope tables but drops non-string entries inside them", () => {
    const config = {
      dark: { syntaxScopes: { "keyword.operator": "#7fd1ff", "string.quoted": 42 } },
    };

    expect(selectTheme(config, "dark")).toEqual({
      syntaxScopes: { "keyword.operator": "#7fd1ff" },
    });
  });

  test("drops values a reviewed repository could smuggle in", () => {
    const config = {
      dark: { accent: { toString: "nope" }, base: ["array"], panel: 1, text: null, muted: "#fff" },
    };

    expect(selectTheme(config, "dark")).toEqual({ muted: "#fff" });
  });

  test("falls back to an empty override for malformed config", () => {
    expect(selectTheme({ light: "not a theme" }, "light")).toEqual({});
    expect(selectTheme({}, "light")).toEqual({});
    expect(selectTheme(undefined, "light")).toEqual({});
    expect(selectTheme([{ base: "x" }], "light")).toEqual({});
  });
});
