# Changelog

## [Unreleased] - OpenCode 2 support

### Added

- **OpenCode 2 entry point** - `server.ts` default-exports a v2 plugin (`src/opencode-v2/`). OpenCode 2 loads it from a plugin folder or a package's `./server` export. OpenCode 1.x keeps loading `index.ts` unchanged.

- **`google-antigravity` integration and provider** - Sign-in is an OAuth method on its own integration (`opencode auth login google-antigravity`, or `/connect` in the TUI). Models are registered automatically with their variants, so OpenCode 2 needs no `provider.google.models` config. A separate provider keeps Antigravity from replacing a Gemini API key on `google`. Each login is labeled with its Google email.

- **Model list from Antigravity** - The models come from Antigravity's `fetchAvailableModels` Recommended list, discovered after sign-in and every 6 hours and cached in `antigravity-models.json`; a built-in snapshot is used until then. New models appear and retired ones disappear without a plugin update. Low/Medium/High entries become one model with variants, each mapped to its own upstream ID (`gemini-3.8-flash-high`, `gemini-pro-agent`, ...), and IDs only served to the current Antigravity client get its User-Agent automatically. `node scripts/list-models.mjs` shows what an account is offered.

- **Models** - Added Gemini 3.8, 3.7 and 3.6 Flash (low/medium/high) and GPT-OSS 120B. Removed models Antigravity no longer recommends: Gemini 3 Pro, Gemini 3 Flash, Gemini 3.5 Flash, Gemini 2.5, and the Gemini CLI preview entries.

- **Sidebar limits and account management (TUI plugin)** - `tui.tsx` adds an "Antigravity · limits" section to the session sidebar: each account's remaining 5-hour and weekly quota per model group (Gemini; Claude & GPT) with refresh times, from `retrieveUserQuotaSummary` (the API behind Antigravity's Settings → Models page), and the account serving the selected model. Click an account or run `/antigravity` to disable/enable, re-authenticate, remove or add accounts. Re-authenticate shows the sign-in link with Google's `login_hint` set to that account, closes once the browser finishes, accepts a pasted redirect URL as a fallback, and updates only the plugin's account (no extra opencode login). Backed by the `antigravity` RPC (`rpc.ts`).

- **Sign-in without opening a browser** - The plugin copies the sign-in link to the clipboard and never opens a browser itself; OpenCode's own CLI still opens the link when it runs in a terminal. There are two methods. **Google account (Antigravity)** waits on the 1.x callback page (`localhost:51121`, "All set!") and finishes by itself. **Paste the redirect URL** has no local server, for browsers on another machine. The first method falls back to pasting when the port is busy or in WSL/remote sessions.

- **Loopback proxy** - OpenCode 2's native Gemini client is pointed at a `127.0.0.1` proxy with a per-process secret path. The proxy feeds the unchanged v1 `fetch` interceptor, so account rotation, quota fallback and request transformation are shared by both versions.

### Changed

- `package.json` gains an `exports` map (`.`, `./server`, `./tui`, `./rpc`), and `@opencode/plugin@2.0.26` plus the OpenTUI/Solid types become dev dependencies.
- GPT-OSS is counted with Claude for rate limits and quota, matching Antigravity's buckets.

### Fixed

- Models from Antigravity's list no longer fall back to the Gemini CLI quota. Accounts without a Gemini CLI license turned a temporary 429 into a 403 "no valid license" error.
- With quota fallback off, hybrid account selection treated a rate-limited Gemini account as available (its unused Gemini CLI pool looked free). The rotation loop then spun without awaiting and froze OpenCode's background service. Selection now checks only the pool in use.
- Removing an account saves the pool with a replacing write; the merging save brought removed accounts back.
- Re-authenticating or removing an account no longer leaves stale copies behind. Account managers still holding the old refresh token (an earlier request pipeline, or another opencode location) merged it back as a second entry for the same email. Replaced and removed tokens are now retired (`retiredTokenHashes`, SHA-256 fingerprints only), saves skip them and collapse same-email entries in place, and existing duplicates are cleaned up on the next save.

### Not yet on OpenCode 2

- Session recovery of interrupted tool calls (`session_recovery`, `auto_resume`), toasts and TUI log output from the request pipeline, and the `google_search` tool. (Accounts and quota are handled by the TUI plugin instead of the 1.x terminal menu.)

### Documentation

- README and docs updated for OpenCode 2: installation, sign-in, model IDs (`google-antigravity/<model>#<variant>`), account management, troubleshooting, a 1.x → 2.x migration guide, and the adapter architecture.

## [1.6.0] - 2026-02-20

### Fixed

- **#397** - Gemini tool-call payload handling now enforces valid `thought_signature` behavior for `functionCall` parts, preventing `400 INVALID_ARGUMENT` in mixed and parallel call turns.

- **#454** - Request sanitization now removes empty/invalid `contents.parts` entries and invalid `systemInstruction.parts` before forwarding to Antigravity.

- **#444** - Response transform fallback now uses cloned responses and preserves recovery signaling, eliminating `Body already used` failures.

- **#368 (Tackled)** - Claude thinking/signature handling now replaces foreign signatures with sentinels and tightens thinking-order classification to reduce false-positive recovery triggers.

### Changed

- **Debug Sink Split** - `debug` now controls file logging only, while `debug_tui` independently controls TUI panel logging.

- **Header Normalization** - `x-goog-user-project` is now stripped across Antigravity and Gemini CLI request styles.

- **Claude Prompt Auto-Caching (Optional)** - Added `claude_prompt_auto_caching` to inject `cache_control: { type: "ephemeral" }` when Claude prompt caching is desired and unset.

### Documentation

- Updated README, architecture/config/troubleshooting docs, and generated schema docs to reflect new debug sink semantics and config keys.

## [1.5.2] - 2026-02-18

### Changed

- Added support for Sonnet 4.6 and removed old models support.

## [1.5.1] - 2026-02-11

### Changed

- **Header Identity Alignment** - `ideType` changed from `IDE_UNSPECIFIED` to `ANTIGRAVITY` and `platform` from `PLATFORM_UNSPECIFIED` to dynamic `WINDOWS`/`MACOS` (based on `process.platform`) across all header sources (`getAntigravityHeaders`, `oauth.ts`, `project.ts`). Now matches Antigravity Manager behavior

- **Gemini CLI `Client-Metadata` Header** - Gemini CLI requests now include `Client-Metadata` header, aligning with actual `gemini-cli` behavior. Previously only Antigravity-style requests sent this header

- **Gemini CLI User-Agent Format** - Updated from `GeminiCLI/{ver}/{model}` to `GeminiCLI/{ver}/{model} ({platform}; {arch})` to match real `gemini-cli` UA strings. Version pool updated from `1.2.0/1.1.0/1.0.0` to `0.28.0/0.27.4/0.27.3` to align with actual release numbers

- **Randomized Headers Model-Aware** - `getRandomizedHeaders()` now accepts an optional `model` parameter, embedding the actual model name in Gemini CLI User-Agent strings instead of a hardcoded default

- **Fingerprint Platform Alignment** - Antigravity-style `Client-Metadata` platform now consistently matches the randomized User-Agent platform, fixing a potential mismatch where headers could disagree on reported platform

### Removed

- **Linux Fingerprints** - Removed `linux/amd64` and `linux/arm64` from `ANTIGRAVITY_PLATFORMS` and fingerprint generation. Linux users now masquerade as macOS (Antigravity does not support Linux as a native platform)

- **`getAntigravityUserAgents()` Function** - Removed unused helper that had no callers in the codebase

- **`X-Opencode-Tools-Debug` Header** - Removed debug telemetry header from outgoing requests

## [1.5.0] - 2026-02-11

### Added

- **Account Verification Flow** - Auth login menu now supports `verify` and `verify-all` actions. When Antigravity returns a 403 with `validation_required`, the account is automatically disabled, marked with a verification URL, and cooled down. Users can verify accounts directly from the menu with a probe request to confirm resolution

- **Dynamic Antigravity Version** - Plugin version is now fetched at startup from the Antigravity updater API, with a changelog-scrape fallback and a hardcoded last-resort. Eliminates stale "version no longer supported" errors after Antigravity updates

- **Storage V4 Schema** - New storage version adds `verificationRequired`, `verificationRequiredAt`, `verificationRequiredReason`, `verificationUrl`, and `fingerprintHistory` fields per account. Full migration chain from v1/v2/v3 to v4

- **`saveAccountsReplace`** - New destructive-write storage function that replaces the entire accounts file without merging, preventing deleted accounts from being resurrected by concurrent reads

- **`setAccountEnabled` / Account Toggling** - New account management methods: `setAccountEnabled()`, `markAccountVerificationRequired()`, `clearAccountVerificationRequired()`, `removeAccountByIndex()`

- **Secure File Permissions** - Credential storage files are now created with mode `0600` (owner read/write only). Existing files with overly permissive modes are tightened on load

- **`opencode.jsonc` Support** - Configure models flow now detects and prefers existing `opencode.jsonc` files. JSONC parsing strips comments and trailing commas before JSON.parse

- **Header Contract Tests** - New `src/constants.test.ts` validates header shapes, randomization behavior, and optional header fields for both Antigravity and Gemini CLI styles

### Changed

- **Unified Gemini Routing** - Gemini quota fallback between Antigravity and Gemini CLI pools is now always enabled for Gemini models. The `quota_fallback` config flag is deprecated and ignored (backward-compatible, no breakage)

- **`cli_first` Honored in Routing** - `resolveHeaderRoutingDecision()` centralizes routing logic and properly respects `cli_first` for unsuffixed Gemini models

- **Fingerprint Headers Simplified** - `buildFingerprintHeaders()` now returns only `User-Agent`. Removed `X-Goog-QuotaUser`, `X-Client-Device-Id`, `X-Goog-Api-Client`, and `Client-Metadata` from outgoing content requests to align with Antigravity Manager behavior

- **Client Metadata Reduced** - Fingerprint client metadata trimmed to `ideType`, `platform`, `pluginType` only. Removed `osVersion`, `arch`, `sqmId`

- **Gemini CLI User-Agent Format** - Updated from `google-genai-sdk/...` to `GeminiCLI/...` format

- **Search Model** - Changed from `gemini-2.0-flash` to `gemini-2.5-flash` for improved search result quality

- **Deterministic Search Generation** - Search requests now use `temperature: 0` and `topP: 1` instead of thinking config

- **OAuth Headers Dynamic** - `oauth.ts` and `project.ts` now use `getAntigravityHeaders()` instead of static constants, removing stale `X-Goog-Api-Client` from token/project calls

### Fixed

- **#410**: Strip `x-goog-user-project` header for ALL header styles, not just Antigravity. This header caused 403 errors on Daily/Prod endpoints when the user's GCP project lacked Cloud Code API
- **#370 / #336**: Account deletion now persists correctly. Root cause: `saveAccounts()` merged deleted accounts back from disk. Fixed by introducing `saveAccountsReplace()` for destructive writes and syncing in-memory state immediately
- **#381**: Disabled accounts no longer selected via sticky index. `getCurrentAccountForFamily()` now skips disabled accounts and advances the active index
- **#384**: `google_search` tool no longer returns empty citations when using `gemini-3-flash`. Search model switched to `gemini-2.5-flash`
- **#377**: Configure models flow now respects existing `opencode.jsonc` files instead of creating duplicate `opencode.json`
- **Excessive Disk Writes** - Fixed project context auth updates causing 3000+ writes/sec during streaming. Changed from reference equality to value comparison on auth tokens and added throttled saves. Prevents SSD wear on macOS
- **Fingerprint Alignment** - Force-regenerated fingerprints to match current Antigravity Manager behavior, fixing `ideType` and stripping stale client metadata fields

### Removed

- **Extra Outgoing Headers** - `X-Goog-Api-Client`, `Client-Metadata`, `X-Goog-QuotaUser`, `X-Client-Device-Id` no longer sent on content requests
- **Fingerprint Metadata Fields** - `osVersion`, `arch`, `sqmId` removed from fingerprint client metadata
- **`updateFingerprintVersion` Helper** - Removed from accounts module (fingerprint version rewriting no longer needed)

### Documentation

- **AGENTS.md** expanded with detailed architecture, code style, and fingerprint system documentation
- **README.md**, **CONFIGURATION.md**, **MULTI-ACCOUNT.md** updated to reflect deprecated `quota_fallback` and automatic Gemini pool fallback behavior
- **`antigravity.schema.json`** marks `quota_fallback` as deprecated/ignored

## [1.4.5] - 2026-02-05

### Added

- **Configure Models Menu Action** - Auth login menu now includes a "Configure models" action that writes plugin model definitions directly into `opencode.json`, making setup easier for new users

- **`cli_first` Config Option** - New configuration option to route Gemini models to Gemini CLI quota first, useful for users who want to preserve Antigravity quota for Claude models

- **`toast_scope` Configuration** - Control toast visibility per session with `toast_scope: "root_only"` to suppress toasts in subagent sessions

- **Soft Quota Protection** - Skip accounts over 90% usage threshold to prevent Google penalties, with configurable `soft_quota_threshold_percent` and wait/retry behavior

- **Gemini CLI Quota Management** - Enhanced quota display with dual quota pool support (Antigravity + Gemini CLI)

- **`OPENCODE_CONFIG_DIR` Environment Variable** - Custom config location support for non-standard setups

- **`quota_refresh_interval_minutes`** - Background quota cache refresh (default 15 minutes)

- **`soft_quota_cache_ttl_minutes`** - Cache freshness control for soft quota checks

### Changed

- **Model Naming and Routing** - Documented antigravity-prefixed model names and automatic mapping to CLI preview names (e.g., `antigravity-gemini-3-flash` → `gemini-3-flash-preview`)

- **Antigravity-First Quota Strategy** - Exhausts Antigravity quota across ALL accounts before falling back to Gemini CLI quota (previously per-account)

- **Quota Routing Respects `cli_first`** - Fallback behavior updated to respect `cli_first` preference

- **Config Directory Resolution** - Now prioritizes `OPENCODE_CONFIG_DIR` environment variable

- **Enhanced Debug Logging** - Process ID included for better traceability across concurrent sessions

- **Improved Quota Group Resolution** - More consistent quota management with `resolveQuotaGroup` function

### Fixed

- **#337**: Skip disabled accounts in proactive token refresh
- **#233**: Skip sandbox endpoints for Gemini CLI models (fixes 404/403 cascade)
- **Windows Config Auto-Migration**: Automatically migrates config from `%APPDATA%\opencode\` to `~/.config/opencode/`
- **Root Session Detection**: Reset `isChildSession` flag correctly for root sessions
- **Stale Quota Cache**: Prevent spin loop on stale quota cache
- **Quota Group Default**: Fix quota group selection defaulting to `gemini-pro` when model is null

### Removed

- **Fingerprint Headers for Gemini CLI** - Removed fingerprint headers from Gemini CLI model requests to align with official behavior
- **`web_search` Configuration Leftovers** - Cleaned up remaining `web_search` config remnants from schema

### Documentation

- Updated README with model configuration options and simplified setup instructions
- Updated MODEL-VARIANTS.md with Antigravity model names and configuration guidance
- Updated CONFIGURATION.md to clarify `quota_fallback` behavior across accounts
- Updated MULTI-ACCOUNT.md with dual quota pool and fallback flow details

---

## [1.3.2] - 2026-01-27

### Added

- **Quota check and account management in auth login** - Added new `--quota` and `--manage` options to the `auth login` command for checking account quota status and managing accounts directly from the CLI ([#284](https://github.com/NoeFabris/opencode-antigravity-auth/issues/284))

- **Request timing jitter** - Added configurable random delay to requests to reduce detection patterns and improve rate limit resilience. Requests now include small random timing variations

- **Header randomization for fingerprint diversity** - Headers are now randomized to create more diverse fingerprints, reducing the likelihood of requests being grouped and rate-limited together

- **Per-account fingerprint persistence** - Fingerprints are now persisted per-account in storage, allowing consistent identity across sessions and enabling fingerprint history tracking
  - Added fingerprint restore operations to AccountManager
  - Extended per-account fingerprint history for better tracking
  - Fingerprint now shown in debug output

- **Scheduling mode configuration** - Added new scheduling modes including `cache-first` mode that prioritizes accounts with cached tokens, reducing authentication overhead

- **Failure count TTL expiration** - Account failure counts now expire after a configurable time period, allowing accounts to naturally recover from temporary issues

- **Exponential backoff for 503/529 errors** - Implemented exponential backoff with jitter for capacity-related errors, matching behavior of Antigravity-Manager

### Changed

- **Increased MODEL_CAPACITY backoff to 45s with jitter** - Extended the base backoff time for model capacity errors from previous values to 45 seconds, with added jitter to prevent thundering herd issues

- **Regenerate fingerprint after capacity retry exhaustion** - When all capacity retries are exhausted, the fingerprint is now regenerated to potentially get assigned to a different backend partition

- **Enhanced duration parsing for Go format** - Improved parsing of duration strings to handle Go-style duration formats (e.g., `1h30m`) used in some API responses

### Fixed

- **Prevent toast spam for rate limit warnings** - Added 5-second debounce for rate limit warning toasts to prevent notification flooding when multiple requests hit rate limits simultaneously ([#286](https://github.com/NoeFabris/opencode-antigravity-auth/issues/286))

- **`getEnabledAccounts` now treats undefined as enabled** - Fixed issue where accounts without an explicit `enabled` field were incorrectly filtered out. Accounts now default to enabled when the field is undefined

- **Show correct position in account toast for enabled accounts** - Fixed the account position indicator in toast notifications to only count enabled accounts, showing accurate position like "Account 2/5" instead of including disabled accounts

- **Filter disabled accounts in all selection methods** - Ensured disabled accounts are properly excluded from all account selection strategies (round-robin, least-used, random, etc.)

- **Robust handling for capacity/5xx errors** - Implemented comprehensive retry logic for model capacity and server errors, achieving parity with Antigravity-Manager's behavior
  - Reordered parsing logic to prioritize capacity checks
  - Fixed loop retry logic to prevent state pollution
  - Added capacity retry limit to prevent infinite loops ([#263](https://github.com/NoeFabris/opencode-antigravity-auth/issues/263))

- **Fixed @opencode-ai/plugin dependency location** - Moved `@opencode-ai/plugin` from devDependencies to dependencies section, fixing runtime errors when the plugin was installed without dev dependencies

### Removed

- **Removed deprecated `web_search` configuration** - The deprecated `web_search.default_mode` and `web_search.grounding_threshold` configuration options have been fully removed. Use the `google_search` tool instead (introduced in 1.3.1)

## [1.3.1] - 2026-01-21

### Added

- **New `google_search` tool for web search** - Implements Google Search grounding as a callable tool that the model can invoke explicitly
  - Makes separate API calls with only `{ googleSearch: {} }` tool, avoiding Gemini API limitation where grounding tools cannot be combined with function declarations
  - Returns formatted markdown with search results, sources with URLs, and search queries used
  - Supports optional URL analysis via `urlContext` when URLs are provided
  - Configurable thinking mode (deep vs fast) for search operations
  - Uses `gemini-3-flash` model for fast, cost-effective search operations

### Changed

- Upgraded to Zod v4 and adjusted schema generation for compatibility
- **Deprecated `web_search` config** - The `web_search.default_mode` and `web_search.grounding_threshold` config options are now deprecated. Google Search is now implemented as a dedicated tool rather than automatic grounding injection

### Fixed

- **`keep_thinking=true` now works without debug mode** - Fixed Claude multi-turn conversations failing with "Failed to process error response" when `keep_thinking=true` after tool calls, unless debug mode was enabled
  - Root cause: `filterContentArray` trusted any signature >= 50 chars for last assistant messages, but Claude returns its own signatures that Antigravity doesn't recognize
  - Fix: Now verifies signatures against our cache via `isOurCachedSignature()` before passing through. Foreign/missing signatures get replaced with `SKIP_THOUGHT_SIGNATURE` sentinel
  - Why debug worked: Debug mode injects synthetic thinking with no signature, triggering sentinel injection correctly

- **Fixed tool calls failing for tools with no parameters** - Tools like `hive_plan_read`, `hive_status`, and `hive_feature_list` that have no required parameters would fail with Zod validation error `state.input: expected record, received undefined`
  - Root cause: When Claude calls a tool with no parameters, it returns `functionCall` without an `args` field. The response transformation only processed parts where `functionCall.args` was defined, leaving `args` as `undefined`
  - Fix: Changed condition to handle all `functionCall` parts, defaulting `args` to `{}` when missing, ensuring opencode's `state.input` always receives a valid record

- **Auth headers aligned with official Gemini CLI** - Updated authentication headers to match the official Antigravity/Gemini CLI behavior, reducing "account ineligible" errors and potential bans ([#178](https://github.com/NoeFabris/opencode-antigravity-auth/issues/178))
  - `GEMINI_CLI_HEADERS["User-Agent"]`: `9.15.1` → `10.3.0`
  - `GEMINI_CLI_HEADERS["X-Goog-Api-Client"]`: `gl-node/22.17.0` → `gl-node/22.18.0`
  - `ANTIGRAVITY_HEADERS["User-Agent"]`: Updated to full Chrome/Electron user agent string
  - Token exchange now includes `Accept`, `Accept-Encoding`, `User-Agent`, `X-Goog-Api-Client` headers
  - Userinfo fetch now includes `User-Agent`, `X-Goog-Api-Client` headers
  - `fetchProjectID` now uses centralized constants instead of hardcoded strings

- **`quiet_mode` now properly suppresses all toast notifications** - Fixed `quiet_mode: true` in `antigravity.json` not suppressing "Status dialog dismissed" and other toast notifications ([#207](https://github.com/NoeFabris/opencode-antigravity-auth/issues/207))
  - Root cause: The `showToast` helper function didn't check `quietMode`, and only some call sites had manual `!quietMode &&` guards
  - Fix: Moved `quietMode` check inside `showToast` helper so all toasts are automatically suppressed when `quiet_mode: true`

### Removed

- **Removed automatic `googleSearch` injection** - Previously attempted to inject `{ googleSearch: {} }` into all Gemini requests, which never worked due to API limitations. Now uses the explicit tool approach instead

## [1.3.0] - Previous Release

See [releases](https://github.com/NoeFabris/opencode-antigravity-auth/releases) for previous versions.
