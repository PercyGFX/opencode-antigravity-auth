import * as path from "node:path";
import * as os from "node:os";

export const PACKAGE_NAME = "@percygfx/opencode-antigravity-auth";
/** The package name without its scope: what a local checkout's folder is called. */
export const PACKAGE_DIR_NAME = PACKAGE_NAME.split("/").pop() ?? PACKAGE_NAME;
// Scoped names need the slash encoded in registry URLs.
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME.replace("/", "%2f")}/dist-tags`;
export const NPM_FETCH_TIMEOUT = 5000;

function getCacheDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "opencode");
  }
  return path.join(os.homedir(), ".cache", "opencode");
}

export const CACHE_DIR = getCacheDir();
export const INSTALLED_PACKAGE_JSON = path.join(
  CACHE_DIR,
  "node_modules",
  PACKAGE_NAME,
  "package.json"
);

function getUserConfigDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export const USER_CONFIG_DIR = getUserConfigDir();
export const USER_OPENCODE_CONFIG = path.join(USER_CONFIG_DIR, "opencode", "opencode.json");
export const USER_OPENCODE_CONFIG_JSONC = path.join(USER_CONFIG_DIR, "opencode", "opencode.jsonc");
