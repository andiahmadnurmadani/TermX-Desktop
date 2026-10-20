import type { ITheme } from "@xterm/xterm";

export const THEME_IDS = ["termx", "dracula", "one-dark", "nord", "solarized-dark", "github-light", "solarized-light"] as const;
export const THEME_NAMES: Record<string, string> = {
  termx: "TermX (auto)", dracula: "Dracula", "one-dark": "One Dark", nord: "Nord",
  "solarized-dark": "Solarized Dark", "github-light": "GitHub Light", "solarized-light": "Solarized Light",
};

const ansi = (a: string[]): Partial<ITheme> => ({
  black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
  brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11], brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
});

const T: Record<string, ITheme> = {
  "termx-dark": {
    background: "#0e0f12", foreground: "#e3e6eb", cursor: "#3ddc97", cursorAccent: "#0e0f12", selectionBackground: "#3ddc9733",
    ...ansi(["#2a2d34", "#f2777a", "#6ee7a8", "#f5d76e", "#6aa9ff", "#c792ea", "#5fd7e0", "#d5d9e0", "#4b505a", "#ff9a9c", "#8ff0bd", "#ffe38f", "#8dbfff", "#d7aaf5", "#86e6ee", "#ffffff"]),
  },
  "termx-light": {
    background: "#ffffff", foreground: "#1f2328", cursor: "#10a971", cursorAccent: "#ffffff", selectionBackground: "#10a97126",
    ...ansi(["#24292f", "#cf222e", "#116329", "#9a6700", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#7d4e00", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
  },
  dracula: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a99",
    ...ansi(["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
  },
  "one-dark": {
    background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", selectionBackground: "#3e4451aa",
    ...ansi(["#3f4451", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#4f5666", "#ff7b86", "#a9d98a", "#f0cf8c", "#74bdfa", "#d78ff0", "#6bc6d3", "#d7dae0"]),
  },
  nord: {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selectionBackground: "#434c5eaa",
    ...ansi(["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
  },
  "solarized-dark": {
    background: "#002b36", foreground: "#93a1a1", cursor: "#93a1a1", selectionBackground: "#073642cc",
    ...ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  },
  "github-light": {
    background: "#ffffff", foreground: "#24292f", cursor: "#0969da", selectionBackground: "#0969da26",
    ...ansi(["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
  },
  "solarized-light": {
    background: "#fdf6e3", foreground: "#586e75", cursor: "#586e75", selectionBackground: "#eee8d5cc",
    ...ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  },
};

export function terminalTheme(id: string, dark: boolean, accent: string): ITheme {
  if (id === "termx") {
    const base = { ...(dark ? T["termx-dark"] : T["termx-light"]) };
    base.cursor = accent;
    return base;
  }
  return T[id] ?? T["termx-dark"];
}
