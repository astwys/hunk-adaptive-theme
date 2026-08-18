/**
 * Loads the extension the way Hunk does — one default-exported factory, one API
 * object — and reports what it registered. Driven by run.py over a pty.
 *
 * With `keyboard` as an argument it then reads stdin the way Hunk's renderer does, so
 * run.py can prove the query left the keyboard working.
 */
import type { HunkExtensionAPI } from "hunkdiff/extension";
import factory from "../../src/index.js";

const logs: string[] = [];
const themes: unknown[] = [];

// Only the members this extension touches; the rest of the API is unused here.
const api = {
  apiVersion: 2,
  config: {
    light: { base: "github-light-default", accent: "#0969da" },
    dark: { base: "github-dark-default", accent: "#58a6ff" },
  },
  log: (message: string) => logs.push(message),
  registerTheme: (theme: unknown) => themes.push(theme),
} as unknown as HunkExtensionAPI;

await factory(api);

// Hunk re-runs factories mid-session (repo trust, cwd change under --watch) with the
// renderer already holding stdin and stdout. The second run must not query again.
if (process.argv[2] === "reload") await factory(api);

console.log(`RESULT ${JSON.stringify({ logs, themes })}`);

if (process.argv[2] === "keyboard") {
  let typed = "";
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    typed += chunk.toString();
  });
  // Only now is the terminal in raw mode. Announcing earlier would let run.py type
  // into a cooked terminal, where the line discipline holds the bytes back.
  console.log("TYPE-NOW");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(`KEYBOARD ${JSON.stringify(typed)}`);
}

process.exit(0);
