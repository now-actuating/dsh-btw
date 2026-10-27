# Local DSH BTW integration

Based on [iyllyt/dsh-btw](https://github.com/iyllyt/dsh-btw/tree/dd2923dca9304ea08f9f33bc5578533d61ec2d42), upstream v0.4.0; local version `0.4.0-local.5`, DSH `0.2.1-rc.2`.

## Changes

- For `openai-codex` on the current `dsh-codex-subscription` 3.1.1 SSE route, use the parent session identity for the registered LLM adapter, preserving its cache identity. Keep a separate sidechain ID for bookkeeping only; never select the isolated Anthropic PiAi delegate on this route.
- Check the live Codex transport before dispatch. Refuse WebSocket/unknown modes and unverifiable provider entries without sending a model request, rather than overwriting the parent's WebSocket continuation state. This local integration supports the current SSE mode, not WebSocket. It does not change the provider's connection preference.
- Preserve the parent's request configuration, system/developer messages, tool schema/history and replay state; use the registered provider adapter (including subscription auth and wrappers), not a second API client.
- Keep question/answer outside the parent SessionStore and do not execute tools. The installed bundle selects `sidechain.mode: none`, so it also does not save private question/context/answer transcripts.
- A bare `/btw` reopens the most recent successful question/answer and its usage label from the current session's Client controller, without any RPC or model request. Keep only one success per retained controller in page memory; errors/cancellations do not replace it. No success shows guidance. Recall does not cancel an in-flight request, whose completion can still update the panel. There is no durable storage or replay into later model questions.
- Own controllers at the Client plugin root, independently of transient Session UI scopes. Navigation keeps the request and answer alive. Maintain a strict maximum of 10 controllers with LRU ordering: actual BTW submission (including bare recall) and revisiting an existing BTW session promote it; ordinary session browsing, command completion, render churn, and background replies do not allocate controllers or promote them. Evict the oldest before creating the eleventh, aborting its request and clearing its success even if it is still running.
- Successful Session archival, explicit Host removal, authoritative catalog disappearance, LRU eviction, page refresh, or plugin unload clears the affected recall. Archive is observed through the Workspace archive snapshot, not confused with Session removal; failed archive attempts do not clear it. Unarchive starts without an old answer.
- While a request is actually active, only the explicit Cancel button performs user cancellation; outside clicks and panel Esc/Enter/Space dismissal do nothing. Native keyboard activation of the focused Cancel button still works. This uses observable request activity independently of recalled display state. After settlement, existing outside/key Close gestures remain. Existing timeout and replacement-by-new-question behavior are unchanged.
- Display provider-reported cached input tokens and the cached fraction of input in the answer panel. Missing telemetry is explicitly not reported as a hit. A configured cache strategy is not proof of a hit.
- Preserve upstream Anthropic cache-boundary support. Other provider routes retain upstream behavior; no unverified cache guarantees are made.

## Use

Refresh the existing DSH GUI and enter `/btw <question>` in the main composer. The one-shot answer appears above the composer; close it to dismiss. This is another model request using the parent's model and reasoning configuration, and consumes usage. No synthetic prewarming or automatic retry is performed to manufacture a hit.

Cache reuse depends on matching prefix/model/account and provider cache lifetime. A cold or expired cache can still miss; inspect the actual cache label rather than assuming every request is cached. Cached input still occupies the model context and is transmitted to the provider.

## Installation layout

The local.5 deployment uses the built package snapshot at `../artifacts/btw-lru/snapshot/package` through the Harness bundle manager. That directory has no development `node_modules`; it is intentional installed-source data, not temporary download debris. Development lives here. Do not edit the installed snapshot directly: rebuild, create a new versioned snapshot, and reinstall through the Harness bundle manager. The prior local.4 deployment's snapshot remains at `../artifacts/btw-reopen/snapshot/package` for rollback; this deployment's profile manifest, lockfile, and patch are backed up under `../backups/btw-lru-20261023`.

The consumed installation archive was removed after installation. The profile's previous manifest, lockfile, and patch are backed up under `../backups/btw-20261022`. Uninstall with `dsh plugin --profile web remove dsh-btw`; do not restore the whole old profile over unrelated later changes.

## Lifecycle and LRU verification (local.5)

- Typecheck, build and all 68 tests passed, covering lazy acquisition, strict capacity-10 LRU, pending-request eviction, session navigation and revisit order, archive/removal/teardown, stale claims/replies, actual request activity during recall, outside/keyboard protection, explicit cancellation, and the loaded Client bundle.
- Host JavaScript and its source map are byte-identical to the previous local.4 deployment. New Workspace Client API dependency is pinned to DSH `0.2.1-rc.2`; RPC format, Host provider route, settings, panel styling and transcript policy are unchanged.
- [Existing-GUI checks](<../artifacts/btw-lru/gui-verification.json>) passed with intercepted delayed responses: real sidebar navigation and scope release preserved the request; returning restored either loading or the completed answer/cache label; bare recall issued no new request; recalled display did not permit accidental cancellation; native keyboard activation of Cancel aborted the request. No page errors or real model requests occurred. Synthetic usage labels here are not evidence of a real provider cache hit.
- [Installation checks](<../artifacts/btw-lru/installation-verification.json>) confirm 32 installed files match the source, prior Host builds/sources and profile patch are preserved, and the consumed archive is removed. Another session changed GoogleAI's source and bundle order between the initial backup and this install; the preinstall-observed change was preserved and the lock delta is explicitly reported rather than attributed to BTW. Strict LRU/Archive edge cases were tested in the unit/integration harness, not by archiving real user sessions in the GUI.
- Refresh the existing GUI to load the new Client plugin. DSH server PID remained unchanged; no core changes or server restart were performed.

## Previous recall verification (local.4)

- Typecheck, build and all 38 tests passed. New cases cover bare/mixed-case command interception, repeated recall with no RPC, latest-success replacement including usage, missing-history guidance, failure/cancelled-late-response isolation, per-session/recreated-controller isolation, disposal and in-flight recall.
- This is only view recall, not Claude Code's multi-exchange thread replay, history navigation, or persistent VS Code panel.
- Existing Host request/caching behavior, one-shot semantics, sidechain mode, panel styling, metadata and artwork are unchanged. The earlier live model/cache observations below belong to local.3, not a new local.4 model test.

## Previous provider verification (local.3)

- Unit tests and type checking: 30 tests passed, including registered-adapter-only routing, no-hit/unknown telemetry, and fail-closed WebSocket transport guards.
- Final real current-session provider test (existing server, no replacement host): `openai-codex / gpt-6.1-sol`, 232,960 cached input tokens + 377 uncached input tokens = 99.84% cached input; no artificial warmup.
- Random test question and answer nonce were absent from the parent journal; previously existing parent records were unchanged.
- GUI end-to-end: selected the existing main session, typed `/btw`, received the correct one-shot answer and visible `233,472 cached input tokens · 99.9% of input`, then closed the panel; no JavaScript errors.
- Two simultaneous SSE side requests both returned correct independent responses and reported 233,472 cached input tokens each.
- Source build, package snapshot and installed build hashes match. Other dependencies are unchanged. A deployment-default-model change observed during the pause was not reverted; this session's actual Codex selection was used for all live tests.
- Sanitized results: [main context and isolation](<../artifacts/btw-live/live-main-verification.json>), [GUI](<../artifacts/btw-live/gui-verification.json>), [concurrency](<../artifacts/btw-live/concurrent-verification.json>), [installation](<../artifacts/btw-live/installation-verification.json>). No raw test prompt/response or authentication material is stored in these reports.
- Agent did not restart DSH or modify DSH core; package HMR and a fresh browser navigation were used for this plugin's activation/verification.

The live result proves a real cache hit on this deployment, not a universal guarantee about future requests or other provider implementations.
