# Hunk Adaptive Theme

A [Hunk](https://www.hunk.dev/) extension that selects a light or dark theme from
the terminal background.

## Built-in Hunk support

```toml
theme = "auto"          # switches between GitHub's default light/dark themes
transparent_bg = true   # follows terminal theme changes during a review
```

Use this extension when you want custom themes for each mode.

## Install

Requires Hunk 0.19.0 or later.

```sh
hunk extension install astwys/hunk-adaptive-theme
```

For a one-off local test:

```sh
hunk diff --extension . --theme adaptive-theme
```

## Configure

```toml
theme = "adaptive-theme"

[extension.hunk-adaptive-theme]
light = { base = "catppuccin-latte", accent = "#1e66f5" }
dark = { base = "catppuccin-mocha", accent = "#89b4fa" }
```

The `light` and `dark` tables accept the same fields as Hunk custom themes.
The configuration table name must match the extension directory name.

## Detection

At startup, the extension queries the terminal with OSC 11, classifies the response
by luminance, and registers the matching theme. Detection runs once per process.
If the terminal does not answer within 150 ms, or stdin/stdout is not a TTY, it uses
the `dark` table.

Hunk recommends that extensions do not write to stdout. This extension intentionally
writes one fixed OSC 11 query before the renderer mounts, matching Hunk's startup
detection. It never writes to renderer-owned stdout afterward; diagnostics use
`hunk.log`.

Check terminal support:

```sh
printf '\033]11;?\033\\'; sleep 0.3; echo
```

Supported terminals print a response such as:

```text
rgb:1e1e/1e1e/1e1e
```

If the command prints nothing before the blank line, the terminal does not answer
OSC 11 and the extension will use the `dark` theme.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm test:pty
```

`pnpm test:pty` requires Bun, Python 3, and a real terminal.

## License

[MIT](LICENSE). Includes code derived from Hunk; see [NOTICE](NOTICE).
