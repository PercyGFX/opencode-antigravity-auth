import { spawn } from "node:child_process";

import { createLogger } from "../plugin/logger";

const log = createLogger("opencode-v2.clipboard");

const COPY_TIMEOUT_MS = 3_000;

function clipboardCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "win32") return [["clip"]];
  if (platform === "darwin") return [["pbcopy"]];
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.OPENCODE_HEADLESS);
}

function runCopy(command: string[], text: string): Promise<boolean> {
  const [program, ...args] = command;
  if (!program) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(program, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, COPY_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(text);
  });
}

/**
 * Best-effort copy of the sign-in link, so it can go into any browser without opencode opening
 * the default one. Returns false (and the caller falls back to the printed link) over SSH or
 * when no clipboard tool is available.
 */
export async function copyToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isRemoteSession(env)) return false;
  for (const command of clipboardCommands(platform)) {
    if (await runCopy(command, text)) return true;
  }
  log.debug("no clipboard tool succeeded", { platform });
  return false;
}
