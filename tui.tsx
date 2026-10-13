/** @jsxImportSource @opentui/solid */
// OpenCode 2 TUI plugin: an "Antigravity" section in the session sidebar with each signed-in
// account's 5-hour quota and the account serving the selected model, plus account management
// (click an account, or run /antigravity). Data and actions go through the server plugin's
// `antigravity` RPC (rpc.ts); opencode loads this file next to server.ts.
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, For, Show } from "solid-js";

import { AntigravityRpc, type QuotaAccount, type QuotaSnapshot } from "./rpc";
import {
  accountLevel,
  formatPercent,
  formatReset,
  sortAccounts,
  windowLevel,
  windowsOf,
  type QuotaLevel,
} from "./src/opencode-v2/quota-format";

const PROVIDER_ID = "google-antigravity";
/** Background refresh; finished responses also trigger one (the server caches for a minute). */
const REFRESH_MS = 2 * 60 * 1000;
const CLOCK_MS = 30 * 1000;
/** opencode's built-in "Connect an integration" command (also /connect). */
const CONNECT_COMMAND = "provider.connect";

type AccountAction = "toggle" | "reauth" | "remove";

export default Plugin.define({
  id: "opencode-antigravity-auth.tui",
  setup(context) {
    const rpc = context.client.rpc(AntigravityRpc);
    const theme = context.theme;
    const [snapshot, setSnapshot] = createSignal<QuotaSnapshot>();
    const [now, setNow] = createSignal(Date.now());

    let inFlight = false;
    const refresh = async (force = false) => {
      if (inFlight && !force) return;
      inFlight = true;
      try {
        setSnapshot(await rpc.quota({ refresh: force }));
      } catch {
        // Not signed in, or the server plugin is not loaded: keep the last snapshot (or nothing).
      } finally {
        inFlight = false;
      }
    };

    /** "Gemini" or "Claude" when the prompt's model is an Antigravity model, else undefined. */
    const currentGroup = () => {
      const model = context.ui.model.current();
      if (!model || model.providerID !== PROVIDER_ID) return undefined;
      return /claude|gpt/i.test(model.modelID) ? "Claude" : "Gemini";
    };
    const servesCurrent = (account: QuotaAccount) => {
      const group = currentGroup();
      return group !== undefined && account.inUse.includes(group);
    };

    const color = (level: QuotaLevel) => {
      if (level === "critical") return theme.text.feedback.error.base;
      if (level === "low") return theme.text.feedback.warning.base;
      if (level === "ok") return theme.text.feedback.success.base;
      return theme.text.muted;
    };

    const toastError = (error: unknown) =>
      context.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" });

    const connect = () => context.keymap.dispatch(CONNECT_COMMAND);

    const manage = async (account: QuotaAccount) => {
      const action = await context.ui.dialog.select<AccountAction>({
        title: account.email,
        options: [
          {
            title: account.enabled ? "Disable" : "Enable",
            value: "toggle",
            description: account.enabled ? "Take this account out of rotation" : "Put this account back into rotation",
          },
          {
            title: "Re-authenticate",
            value: "reauth",
            description: "Sign in again with this Google account (Connect an integration → Google Antigravity)",
          },
          { title: "Remove", value: "remove", description: "Remove this account from the plugin" },
        ],
      });
      try {
        if (action === "toggle") {
          await rpc.setAccountEnabled({ index: account.index, email: account.email, enabled: !account.enabled });
          context.ui.toast.show({
            message: `${account.email} ${account.enabled ? "disabled" : "enabled"}`,
            variant: "success",
          });
          await refresh(true);
        } else if (action === "reauth") {
          connect();
        } else if (action === "remove") {
          const confirmed = await context.ui.dialog.confirm({
            title: `Remove ${account.email}?`,
            message: "The plugin stops using this account. Sign in again to add it back.",
            label: { confirm: "Remove" },
          });
          if (!confirmed) return;
          const { remaining } = await rpc.removeAccount({ index: account.index, email: account.email });
          context.ui.toast.show({ message: `${account.email} removed`, variant: "success" });
          if (remaining === 0) {
            await context.ui.dialog.alert({
              title: "No Antigravity accounts left",
              message: "opencode still has its Google Antigravity login. Run `opencode auth logout google-antigravity` to sign out completely.",
            });
          }
          await refresh(true);
        }
      } catch (error) {
        toastError(error);
      }
    };

    const chooseAccount = async () => {
      await refresh();
      const accounts = sortAccounts(snapshot()?.accounts ?? []);
      const choice = await context.ui.dialog.select<QuotaAccount | "add">({
        title: "Antigravity accounts",
        options: [
          ...accounts.map((account) => ({
            title: account.email,
            value: account as QuotaAccount | "add",
            description: account.error
              ? account.error
              : account.limits
                  .map((limit) => `${limit.name} ${windowsOf(limit).map((entry) => `${entry.label} ${formatPercent(entry.window)}`).join(" ")}`)
                  .join(" · "),
            footer: !account.enabled ? "disabled" : servesCurrent(account) ? "in use" : account.inUse.join(", "),
          })),
          { title: "Add account", value: "add", description: "Sign in with another Google account" },
        ],
      });
      if (choice === "add") connect();
      else if (choice) await manage(choice);
    };

    void refresh();
    const refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
    const clockTimer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    const stopListening = context.data.on("session.execution.succeeded", () => void refresh());

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "antigravity.accounts",
          title: "Antigravity accounts",
          group: "Antigravity",
          palette: true,
          slash: { name: "antigravity" },
          run: () => void chooseAccount(),
        },
      ],
    }));

    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={(snapshot()?.accounts.length ?? 0) > 0}>
          <box>
            <text fg={theme.text.base}>
              <b>Antigravity</b>
              <span style={{ fg: theme.text.muted }}> · limits</span>
            </text>
            <For each={sortAccounts(snapshot()?.accounts ?? [], currentGroup())}>
              {(account) => (
                <box onMouseUp={() => void manage(account)}>
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text flexShrink={0} style={{ fg: color(accountLevel(account)) }}>
                      •
                    </text>
                    <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                      {servesCurrent(account) ? <b>{account.email}</b> : account.email}
                    </text>
                    <text
                      fg={servesCurrent(account) ? theme.text.feedback.success.base : theme.text.muted}
                      wrapMode="none"
                      flexShrink={0}
                    >
                      {!account.enabled ? "disabled" : servesCurrent(account) ? "in use" : account.inUse.join(", ")}
                    </text>
                  </box>
                  <Show
                    when={!account.error}
                    fallback={
                      <text fg={theme.text.feedback.error.base} wrapMode="none" truncate minWidth={0}>
                        {`  ${account.error}`}
                      </text>
                    }
                  >
                    <For each={account.limits}>
                      {(limit) => (
                        <For each={windowsOf(limit)}>
                          {(entry, position) => (
                            <box flexDirection="row" gap={1} minWidth={0}>
                              <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                                {position() === 0 ? `  ${limit.name}` : ""}
                              </text>
                              <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                                {entry.label}
                              </text>
                              <text fg={color(windowLevel(entry.window))} wrapMode="none" flexShrink={0}>
                                {formatPercent(entry.window).padStart(4)}
                              </text>
                              <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                                {formatReset(entry.window.resetAt, now()).padStart(6)}
                              </text>
                            </box>
                          )}
                        </For>
                      )}
                    </For>
                  </Show>
                </box>
              )}
            </For>
            <text fg={theme.text.muted} onMouseUp={() => void chooseAccount()}>
              {"  manage: /antigravity"}
            </text>
          </box>
        </Show>
      ),
    });

    return () => {
      clearInterval(refreshTimer);
      clearInterval(clockTimer);
      stopListening();
      removeSlot();
    };
  },
});
