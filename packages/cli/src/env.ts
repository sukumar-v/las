import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Everything setup reads from the machine, so tests can supply a fake one. */
export interface Env {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows (also used as a fallback elsewhere, never relied on) */
  appData: string;
  /** the user config root: $XDG_CONFIG_HOME on Linux, ~/.config elsewhere */
  configHome: string;
  /** where LAS keeps its data and the backups setup makes of skill folders */
  lasHome: string;
  cwd: string;
  /** whether an executable is on PATH */
  hasCommand(name: string): boolean;
  /** $CODEX_HOME if set */
  codexHome: string;
}

export function commandOnPath(name: string, pathVar = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): boolean {
  const exts = platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat("") : [""];
  for (const dir of pathVar.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return true;
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return false;
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const appData = overrides.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const configHome = overrides.configHome ?? (platform === "linux" && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(home, ".config"));
  return {
    home,
    platform,
    appData,
    configHome,
    lasHome: overrides.lasHome ?? process.env.LAS_HOME ?? join(home, ".las"),
    cwd: overrides.cwd ?? process.cwd(),
    hasCommand: overrides.hasCommand ?? ((n) => commandOnPath(n)),
    codexHome: overrides.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex")
  };
}
