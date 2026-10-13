import { homedir } from "node:os";
import { join } from "node:path";

export interface LasConfig {
  /** ~/.las */
  dataDir: string;
  dbPath: string;
  mediaDir: string;
  modelsDir: string;
  fontsDir: string;
  /** studio host and port; the server only listens on 127.0.0.1 */
  host: string;
  port: number;
  studioUrl: string;
  /** built studio assets (packages/studio/dist), if present */
  studioDist?: string;
  version: string;
}

export const LAS_VERSION = "0.1.0";

export function defaultConfig(overrides: Partial<LasConfig> = {}): LasConfig {
  const dataDir = overrides.dataDir ?? process.env.LAS_HOME ?? join(homedir(), ".las");
  const port = overrides.port ?? Number(process.env.LAS_PORT ?? 4711);
  const host = overrides.host ?? "127.0.0.1";
  return {
    dataDir,
    dbPath: overrides.dbPath ?? process.env.LAS_DB ?? join(dataDir, "las.db"),
    mediaDir: overrides.mediaDir ?? join(dataDir, "media"),
    modelsDir: overrides.modelsDir ?? join(dataDir, "models"),
    fontsDir: overrides.fontsDir ?? join(dataDir, "fonts"),
    host,
    port,
    studioUrl: overrides.studioUrl ?? `http://${host}:${port}`,
    studioDist: overrides.studioDist ?? process.env.LAS_STUDIO_DIST,
    version: LAS_VERSION
  };
}
