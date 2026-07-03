# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [Pengu Loader](https://pengu.lol) plugin for the League of Legends client. Pengu Loader injects plain ES modules (`index.js` as the entry point) directly into the client's Chromium/Ember webview — there is no bundler, no `package.json`, no npm dependencies, and no build step. Files are loaded and run as-is. `import`/`export` work because the client's page is loaded as an ES module.

## Development workflow

There is no build, lint, or test tooling in this repo — everything is verified by copying the plugin into a running League client and observing behavior.

- To test changes: copy this whole folder (or symlink it) into `Pengu Loader/plugins/`, then reload the client (or restart Pengu Loader) to re-inject `index.js`.
- Debug logging is silent by default. Enable it via the manager's Settings tab ("Enable debug logs") or `Utils.Store.set('core', 'debugLogs', true)`, then check the client's devtools console (Pengu Loader exposes a devtools toggle) — all logging goes through `Utils.Debug` (`modules/generalUtils.js`), which is a no-op until that flag is set.
- There's no automated way to verify a change works; reproduce the actual client flow (champ select, ready check, honor screen, etc.) manually.

## Reference links

These are working references for this codebase (not something to invent from memory):

- `https://raw.communitydragon.org/` — Community Dragon CDN, used for champion/item/skin/icon assets not exposed (or awkward to reach) via the LCU asset endpoints `Utils.GameData.Assets` already wraps.
- @"Ember Reference.html" — reference for the League client's Ember component/service `classNames`, used to find the `matcher` value when adding a new `Utils.Hooks.Ember.registerRule({...})` rule.
- `https://github.com/ReformedDoge/riot-invoke-api` — reference for LCDS "invoke" endpoints (the raw pre-serialized payloads passed via `Utils.LCU.post(url, body, { raw: true })`), used for client operations not covered by regular documented LCU REST routes.

## Architecture

### Manager vs Standalone (read this before touching any module)

Every feature module (`modules/*.js` except `generalUtils.js`) is written to run in **two different hosting modes**, and must keep working in both:

1. **Manager mode** — `index.js` imports the module and calls its `init(ctx)` / `load()`. `index.js` also creates `window.SnoozeManager` (a custom in-page modal — not the native LoL settings UI) and every module registers its settings into it via `window.SnoozeManager.registerModule({...})`.
2. **Standalone mode** — a user copies `generalUtils.js` + one module file directly into `Pengu Loader/plugins/`, without `index.js`. In this case `window.SnoozeManager` never exists, so each module's `init()` falls back to `Utils.Settings.inject(...)` + `Utils.DOM.observer.observe(...)` to render its toggle inside the League client's **native** settings menu (a `lol-uikit-scrollable` node under the `plugins` category group).

This is why almost every module's `init()` has an `if (window.SnoozeManager && window.SnoozeManager.registerModule) { ... } else { ... }` branch — both branches must be kept in sync when a setting is added/changed. `modules/generalUtils.js`'s `settingsUtils()` (`Utils.Settings.inject`) also early-returns when `window.SnoozeManager.__isLoader` is set, so the native-settings machinery doesn't double-register when the manager is present.

### Module contract

Every module in `modules/` (except `generalUtils.js`) exports:

- `init(context)` — called once at plugin init. Registers settings (manager or native, see above), runs one-time settings migrations, and reads persisted config into module-level state.
- `load()` — called once after `Utils.GameData.Assets.init()` resolves. Wires up the actual behavior: `Utils.LCU.observe(...)` subscriptions, DOM observers, hooks, etc.
- Some modules (`socialPanelTweaks`, `whaleHelper`, `modeSelectorTweaks`) additionally export `installEmberHook()`, called from `index.js` `init()` _before_ `Utils.Hooks.Ember.install(ctx)` resolves — these register Ember component/service patches via `Utils.Hooks.Ember.registerRule(...)`.

`index.js` is the only place that wires modules together: it imports each module and lists its namespace in the `MODULES` manifest array, which drives `installEmberHook()`/`init()`/`load()` for every module via `.forEach()`. Sidebar category is self-declared by the module itself, as a `category` field in the config object it passes to `registerModule({ id, category, name, description, settings })` (falls back to `'Other'` if omitted — see `CATEGORY_ORDER` in `index.js`). **A module not imported and added to `MODULES` will never run in manager mode, even if `modules/` contains its file and the README lists it as a feature** — check `index.js`'s `MODULES` array before assuming a module is active.

### `modules/generalUtils.js` — the shared runtime

Everything below is exposed as the default-exported `Utils` object and is the only inter-module dependency:

- `Utils.LCU` — thin `fetch` wrapper for the League Client Update (LCU) REST API (`get`/`post`/`put`/`patch`/`delete`), plus `observe(uri, cb)` for the LCU's websocket event bus. Bound once via `Utils.LCU.bind(ctx)` in `index.js` `init()`.
- `Utils.Store` — persistence, backed by Pengu Loader's `window.DataStore`, namespaced as `{ [moduleName]: { [key]: value } }` under a single `Snooze-Store` key. Has a `schemaVersion` and `migrateLegacyKeys(mapping)` used once at startup to move pre-manager flat keys (`sm:xxx`) into the new namespaced shape — see `LEGACY_MIGRATION_MAP` in `index.js`.
- `Utils.Hooks.Ember` (`EmberHook`) — monkey-patches `Ember.Component.extend` / `Ember.Service.extend` globally (once) so any module can call `registerRule({ name, matcher, mixin, wraps })` to inject behavior into League's Ember components by class name (`matcher` matches against `classNames`, or pass `'*'`/a predicate function). This is the primary mechanism for hooking into client UI beyond DOM mutation. See the Ember reference link above for `classNames` to match against.
- `Utils.Hooks.Fetch` / `Utils.Hooks.Xhr` / `Utils.Hooks.WS` — patch `window.fetch`, `XMLHttpRequest`, and the LCU websocket dispatcher respectively, to intercept/rewrite requests or responses matching a string or `RegExp` pattern. Used for things like spoofing identity payloads or rewriting game data responses.
- `Utils.DOM.observer` — a shared `MutationObserver`-based "smart observer" singleton (`createSmartObserver`): `observer.observe(selector, cb)` fires once per matching element (existing + future), batched via `requestAnimationFrame`. Prefer this over creating new `MutationObserver`s per module.
- `Utils.Panic` — global cancel-current-auto-action hotkey (default F2, configurable in the manager Settings tab). Modules register a one-shot callback via `Utils.Panic.register(cb)` before starting a delayed auto-action (e.g. auto-accept's delay, auto-lock's delay) so the user can abort it.
- `Utils.GameData.Assets` — fetches and caches champion/item/spell/perk/queue static data from LCU once (`Assets.init()`, awaited in `index.js` `load()` before any module's `load()` effectively becomes useful for icons/queue names).
- `Utils.GameData.getSgpContext` / `getSgpMatchHistory` — resolves the correct regional SGP (spectator/match-history) backend host for the player's region (with a Tencent/China fallback path) and fetches match history directly from SGP rather than the LCU, used by `gameAnalysisPopup.js`'s player-lookup and match history modal.
- `Utils.Settings.inject` / `Utils.Settings.createToggleRow` — standalone-mode native settings page registration (see Manager vs Standalone above) and a reusable native-styled checkbox row.

### `index.js` — the manager shell

Besides wiring modules (see above), `index.js` owns:

- The custom modal UI (`Modal` IIFE) — sidebar categories, per-module tabs, settings-row rendering (toggle/select/textarea/custom setting types), all built with vanilla DOM APIs and inline styles (no framework, no CSS files).
- The configurable open/close hotkey (default F1) and the separate Panic key (see `Utils.Panic` above) — both are captured via raw `keydown`/`keyup` listeners in the Settings tab UI.
- GitHub release polling for update notifications (`checkForUpdates`, reads `@version` from this file's own doc comment at runtime via `fetch(import.meta.url)`).

When adding a new module: add `import * as xModule from './modules/x.js'` and add `xModule` to the `MODULES` array in `index.js` (order matters only in that `load()` implicitly depends on `Assets.init()` having run first) — that's the only `index.js` edit needed. The module's own `registerModule({...})` call declares its `category`, `id`, `name`, and `description` directly, so nothing else needs to be kept in sync.
