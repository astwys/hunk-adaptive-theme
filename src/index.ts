import type { HunkExtensionAPI } from "hunkdiff/extension";
import { queryTerminalThemeMode, selectTheme } from "./theme.js";

const THEME_ID = "adaptive-theme";

export default async function (hunk: HunkExtensionAPI) {
  const detected = await queryTerminalThemeMode();
  const mode = detected ?? "dark";

  // hunk.log is collected as diagnostics; the renderer owns stdout.
  hunk.log(detected ? `terminal background looks ${mode}` : `no background reply, using ${mode}`);

  const theme = selectTheme(hunk.config, mode);
  if (Object.keys(theme).length === 0) {
    hunk.log(`no ${mode} theme configured, registering Adaptive Theme with Hunk defaults`);
  }

  hunk.registerTheme({
    id: THEME_ID,
    label: "Adaptive Theme",
    ...theme,
  });
}
