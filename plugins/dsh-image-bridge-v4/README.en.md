<p align="center"><img src="icon.svg" width="96" alt="Image Bridge" style="color:#4f8cff"></p>

# Image Bridge (dsh-image-bridge)

English | [中文](README.md)

Give **models that cannot draw** a connection to an external image model. Configure at least one provider under **Settings → Image Bridge** and the model gains two tools — `image_generate` and `image_edit` — with the resulting images shown right in the conversation.

- Configure **several** providers, each with its own base URL, key, and models.
- Pick a primary model for generation and one for editing, each with an optional fallback.
- The model does not need to see images at all — **it can still draw for you**.

## Installation

Ask the agent in a DSH session, or install this directory with the plugin manager:

```
plugin_manager  action: install_bundle
                target: <absolute path to this directory>
```

Installation writes a `link:` dependency into the profile and inserts the plugin row into the profile's config layer (row id `image-bridge-v4`, which is also the namespace the settings page writes to). **Restart `dsh web` afterwards**, then open **Settings → Image Bridge**.

Package name `@local/dsh-image-bridge` (the `@local/` prefix is DSH convention for a locally authored plugin that is not published to npm), version `0.2.0`.

## What you can do

- **Generate** — the model calls `image_generate(prompt)` and the image lands in the conversation.
- **Edit** — `image_edit` changes an existing image.
- **Multiple providers** — generate with provider A and edit with provider B, or use just one.
- **Fallback** — when the primary times out or fails, the fallback takes over, and the reason is reported honestly.
- **A file on disk** — besides the image card in the conversation, every result is saved to the workspace.
- **Debuggable** — one startup report plus one browser log, so failures do not have to be guessed at.

## Configuration

The entry point is **Settings → Image Bridge**. Top to bottom the page is: page header → provider cards → dashed "＋ Add model provider" → the Models section → Global image size.

### Page header

`[icon] Image Bridge  dsh-image-bridge  v0.2.0`, with one subtitle line below. The badge links to the GitHub repository (opens in a new tab) and shows only the repository name — no `@local/` prefix. The icon follows the theme colour.

### Provider cards

Each card is a **single row**: a status light, the name (with a lighter status line underneath, plus a reason line when it failed), and three buttons on the right.

```
● 智谱                        [Test] [Edit] [Delete]
  Connected
● other                       [Test] [Edit] [Delete]
  Connection failed
  Connection failed: 401 key rejected
```

| Element | Meaning |
| --- | --- |
| Status light | Green = this provider works; red = a test or model fetch failed in **this session**; grey = never succeeded and never tested (hover for text) |
| Name | Whatever you typed when creating the card; falls back to the id when blank |
| Status line | Same source as the light: green says "Connected", red says "Connection failed", grey says "Not tested" |
| Failure reason | An extra line only on failure; **reasons belong to one provider**, so a failure at A never shows up on B |
| Buttons | Test / Edit / Delete (delete is two-step: "Delete", then "Confirm delete") |

Green survives a page refresh: with no test result in this session, the card treats "this provider has a saved model list" as a **persistent signal**. Failure state stays in memory only and is never written to config. Base URL, models, and key status all live inside the **Edit** dialog.

There is **no** "Set as current" button: primary and fallback already bind models to providers by role (`{ providerId, model }`), so "which provider is current" means nothing to the user.

At the bottom of the list is the dashed **"＋ Add model provider"**. Clicking it — or **Edit** on a card — opens a centred dialog (translucent mask plus panel, `z-index: 1200`, above every host overlay). **Four ways to close it**: the × in the top-right corner, Cancel, clicking the mask, or Esc. On open, focus moves into the dialog and **Tab cannot escape to the page behind it**; closing returns focus to the element that opened it. An unsaved key draft is not lost to a stray Esc either (while a dropdown is open, Esc closes only the dropdown).

### Edit dialog

The dialog covers the provider itself; *which model to use* is chosen in the Models section below.

| Field / button | Meaning |
| --- | --- |
| Name | Display name, and the source of the derived id |
| Base URL | OpenAI-compatible base address, e.g. `https://api.openai.com/v1` |
| API Key | Password field; the placeholder reflects whether a key is already stored. The key goes to the credential service — it is never written to config and never sent back to the browser |
| Test connection | `GET {base URL}/models`, costs nothing; on success it also lists this provider's models |
| Fetch available models | Pulls the list again; once models are present the label becomes "Re-fetch available models" |
| Model list | Title "Available models (9 / 20)", a line "Non-image models hidden: 11", and a "Show all models" toggle. It only confirms the key works and shows what the provider offers — there is no picker here |
| Cancel / Save | Save writes the name, base URL, and fetched model list into `providers`, and the key into the credential service |

**Test connection** — `GET {base URL}/models`; it only checks reachability and whether the key is accepted, and **costs nothing**. On success the host brings the model list back with it, so the UI lists it immediately without a second click. A 404 counts as **reachable** (the provider may simply not offer a model list, which does not affect generation), 401/403 is a key problem, and 500 and friends mean **unreachable**. A 200 whose body is not valid JSON, or has no `data` array, is **still reachable** — the reachability verdict never depends on the response format.

**Fetch available models** — again `GET {base URL}/models` with `Authorization: Bearer` and a **15-second timeout**, taking only `data[].id`. Non-2xx, non-JSON, and a missing `data` array all raise an error with the status code.

### The Models section

Four dropdowns, split into two pairs by generation/editing, each pair a **primary + fallback**:

```
Image generation
[Primary model ▾]    Used first for tool calls.
[Fallback model ▾]   Used automatically when the primary times out or fails to connect.
```

- **The two fallback rows have no visible label** (the dropdown already reads "Fallback model"), but each carries an equivalent `aria-label`, so screen readers can still tell the four controls apart.
- The dropdowns are **hand-rolled menus**: click-outside to close, Esc, arrow keys plus Enter, Home/End, and focus returns to the trigger on close; `role=listbox` / `role=option` with `aria-activedescendant`; the panel has a max height and keyboard movement scrolls the active item into view.
- **Options are the union of every provider that has ever fetched a model list**, grouped by provider (group headings look like `— OTHER —`), and **model names are never rewritten**. Every option carries `{ providerId, model }`, so generation can use A while the fallback uses B.
- Each dropdown ends with a fixed **"Manual input…"** entry (reserved value `__dib_manual__`, **not written to config**); the text box only appears once it is explicitly selected, and a **manually typed model goes to the provider currently in effect**.
- **Empty state** (no provider has ever fetched a model list): all four dropdowns are disabled and show their placeholders. The UI does **not** open four text boxes at once — just one hint line, "Add and test a model provider first".
- The block also holds the **"Primary model timeout (ms)"** input (default 90000); see Behavior below for what it means.
- Click **"Save model settings"** to persist changes.

### Global image size

| Option | Notes |
| --- | --- |
| `1024x1024` | Default, 1:1 |
| `1024x1536` / `1536x1024` | 2:3 portrait / 3:2 landscape |
| `768x1024` / `1024x768` | 3:4 portrait / 4:3 landscape |
| `512x512` | 1:1 small |
| `1792x1024` / `1024x1792` | 16:9 wide / 9:16 tall |
| Custom… | Reserved value `__dib_custom_size__`; the text box appears only when selected |

It applies to every provider and has its own **Save size** button. **The current value is always present among the options**: if config holds a non-preset size (say a hand-typed `1280*720`), the dropdown switches to custom mode and echoes the original value — never blank, never silently changed. The ratio lives only in the option label; the value actually sent is always the size string itself.

### How image models are filtered

Only image models are listed by default (one real key returned around 200 models, nearly all of them language, embedding, or speech models). The rule is **deliberately narrow**:

1. Split the model name into tokens on non-alphanumeric characters and compare **token by token** — never a whole-name substring match, which would misfire on `qwen-mt-uni` or `qwen3.7-text-embedding-flash`;
2. a token containing `image` counts as image generation;
3. plus a set of dedicated words: `t2i`, `i2i`, `flux`, `kolors`, `dall`/`dalle`, `seedream`, `cogview`, `diffusion`, `sdxl`, `sd3`, `wanx`, `midjourney`, `imagen` (some of them also accept a version suffix, e.g. `flux1`, `cogview4`).

The same rule drives the four dropdowns. Tick "Show all models" to see language models too, or use "Manual input…".

### Credential names and upgrades

Every provider has its own credential name:

```
DSH_IMAGE_BRIDGE_KEY_<ID>     ID = provider.id uppercased, non-alphanumerics replaced with underscores
```

`provider.id` is derived from the name: lowercased, runs of non-`[a-z0-9]` folded to `-`, leading and trailing `-` trimmed, truncated to 40 characters; a pure Chinese name folds to an empty string, in which case the host name of the base URL is used instead. **Host and client use the same rule** — any difference in normalisation produces "the UI reports a missing key under name A while the tool fetches the key under name B".

Upgrade compatibility: when `providers` is empty but the legacy `baseUrl`/`model` have values, the settings page synthesises them into one "Existing configuration" card (id `default`, credential name kept as `DSH_IMAGE_BRIDGE_API_KEY`) and the tools keep using the legacy fields — **your old key keeps working**.

## Usage flow

1. Click "＋ Add model provider" and fill in name, base URL, and API Key.
2. Click **Test connection** (or "Fetch available models").
3. Click **Save** in the dialog.
4. Back on the settings page, pick primary and fallback models for generation and editing in the Models section, then click "Save model settings".
5. Ask the model to draw.

> **The one thing that confuses everybody**: dropdown candidates come from the model lists **already saved** on the provider records. So the order is
> **"Test connection / Fetch available models" → click Save → the provider's models appear in the dropdowns**.
> Testing without saving and closing the dialog leaves those models out of the candidates.

## Behavior

### Which provider is in effect

Three-level fallback, and tool calls use **the same rule**:

| Level | Condition | What is used |
| --- | --- | --- |
| `active` | `activeProviderId` matches an entry in `providers` | that entry |
| `first` | no match (empty, or pointing at a renamed/deleted entry) and the list is not empty | `providers[0]` |
| `legacy` | `providers` is empty | the legacy `baseUrl`/`model`/`editModel`, credential name `DSH_IMAGE_BRIDGE_API_KEY` |

The UI no longer offers a switch, but the field is still saved and still drives the fallback. A provider with no base URL fails immediately, naming the provider.

**A level-two fallback tells you so.** When the provider named by `activeProviderId` has been renamed or deleted, the tool still produces an image (using the first entry) but the result carries a warning naming both what you had picked and what was actually used. That is **billing-relevant**: you think provider A was used while the request went to provider B with B's key and quota, and that should not be known only from `level: first` in the startup report. Conversely, if you **never picked one** (empty field), using the first entry is the expected behaviour and no warning is emitted.

### When the fallback takes over

Model resolution order: an explicit `model` argument on the tool call → the **primary model** from the Models section (with its own providerId's base URL and credential) → the effective provider's `imageModel`/`editModel` → the legacy `baseUrl`/`model`. The fallback **only** comes from the Models section; unset, or pointing at an unusable provider, means there is no fallback.

**Four cases switch to the fallback** (and then retry exactly once):

1. **Connection failure** (a network-layer error);
2. **Non-2xx**, including a body that is not valid JSON;
3. **No response headers within the primary-model timeout**;
4. **HTTP 200 that yields no usable image** — from the user's point of view, nothing was drawn.

**Two cases do not**:

- **The user cancelled** (`exec.signal` already aborted) — a cancellation is not a failure;
- **The image was produced but the download failed** — you were already billed, and generating again bills you twice.

The fallback reports honestly: on success the message names the primary that failed, the reason, and the fallback model actually used; when both fail, the error names **both attempts with their own model and reason**.

### Primary model timeout (fallbackAfterMs)

The setting is **"Primary model timeout (ms)"**, default **90000**. It measures how long after **the request was actually sent** the response headers may take, and **connection time (DNS/TCP/TLS) does not count**. It is **not** the total budget for the call — that ceiling is `timeoutMs` (default 180000).

**Synchronous image APIs routinely take tens of seconds (measured: 42–61 seconds before headers arrive), so do not set this low.** Failing to send at all (a connection that never comes up) is a different failure: the error says "connection phase…" rather than pretending the provider did not respond.

After a timeout the host automatically **probes** the provider (`GET {baseUrl}/models`, within 4 seconds): if it answers, the error explains that the provider is alive and the key is valid and that this run was merely slow, suggesting a larger timeout; if not, it says the provider is currently unreachable rather than just slow. The probe **only adds a hint and never changes whether the fallback is used**.

### Two safety constraints (deliberate)

1. **No request without an explicit key.** "Test connection" and "Fetch available models" accept only the `apiKey` explicitly present in the request, or a credential behind a valid `keyRef`. With neither, the host **sends not a single byte** and never falls back to the effective provider's key — otherwise A's key would be sent to B's address. Tool calls work the same way: a key is resolved only under its own ref, and **never across names**.
2. **Deleting a provider does not delete its credential.** Deleting is a configuration action and should not destroy a key you may want to reuse. If you really want it gone, remove that line from `$DSH_HOME/.credentials.yaml` yourself.

### Where the images go

1. Submitted as a **persistent image attachment** — shown as an image card in the conversation.
2. Saved as `generated-images/image-<timestamp>-<prompt fragment>.png`. The directory can be changed with `outputDir`, but the resolved path must stay inside the session workspace, otherwise the write is refused.

### When the model cannot see images

The behaviour forks on **whether the calling route declares image input**:

- declares `image` input → the image ships as an image content block with the tool result, and the model sees it directly;
- does not declare it → only a text envelope and the file path go out (otherwise the DSH adapter throws `UNSUPPORTED_CONTENT` for a route that does not accept image input).

**Either way the image card in the UI is shown** — it reads the persisted image reference from the tool result, independently of the model's vision.

## Troubleshooting

Start with the three self-diagnostics; almost every failure can be read off them:

| File | Contents |
| --- | --- |
| `$DSH_HOME/dsh-image-bridge-startup.json` | Rewritten on every host activation: how far `apply` got, whether the dependency services are in place, the effective config, **which provider is actually in use** (`provider.{level,id,label,baseUrl,keyRef,imageModel,editModel}`), and the failure reason. Credential names only, never keys |
| `$DSH_HOME/dsh-image-bridge-client.log` | Tab-separated browser-side log (time, level, event, detail); **never records a key** |
| `$DSH_HOME/dsh-image-bridge-degraded.json` | Present only when dependency resolution failed |

`provider.level` tells you **which level the fallback actually landed on** (`active` / `first` / `legacy`). The config list alone cannot distinguish "configured" from "actually in use"; this field exists to answer that.

| Symptom | What to do |
| --- | --- |
| "No usable API key" | This card has no key typed and none stored, so **no request was sent at all**. It is not the same as "key rejected (401/403)". Enter the key and click Save |
| 401/403 key rejected | The key is wrong, or the service does not accept `Authorization: Bearer`. Remember **environment variables take precedence over the credential service**: with multiple providers each reads **its own** variable (id `zhipu` → `DSH_IMAGE_BRIDGE_KEY_ZHIPU`), while legacy fallback mode uses `DSH_IMAGE_BRIDGE_API_KEY` |
| 404 | Usually the provider simply has no `/models`, which does not affect generation; if generation itself 404s, the API path is not OpenAI-compatible |
| All four dropdowns are empty (disabled) | No model list has been saved yet: test connection / fetch models → **Save**. You can also use "Manual input…" right away |
| There are candidates but not the model I want | Only image models are shown by default — tick "Show all models" or use "Manual input…"; a model just fetched must be saved in the dialog first; it may also belong to another provider, so expand that group |
| No "Image Bridge" page in Settings | Check that the plugin is enabled; look for `fatal` on `client apply` in the client log; **restart DSH after changing code** (Node caches loaded modules and hot reload ignores `node_modules`); check for a degraded file |
| A normal slow generation is treated as a failure | The old `fallbackAfterMs` (say 15000) is too small — raise "Primary model timeout" (90000 recommended) |
| "Model route points at provider X, which is not in the provider list" | The provider you once selected was **renamed or deleted** (the route still holds its old id). **No request was sent.** Re-pick that slot in the Models section. This is deliberately a hard error: an earlier version silently fell back to the *active* provider's model name against the wrong endpoint, which came back as `404 Model not exist` and hid the real cause |
| A model is selected but generation errors | See whether the error names the primary or the fallback: one model only → the fallback did not engage (unset, or its provider lacks a base URL or key); two models → both were tried, so investigate both reasons; "used fallback" → the fallback drew this one, and the primary is the thing to fix |

## Implementation notes

For maintainers, one line each:

| Concern | Approach |
| --- | --- |
| Dependency resolution | The profile holds a link, so Node resolves bare specifiers against the real path. Try, in order, plain resolution → the CLI entry location → `DSH_PROFILE_DIR` → `DSH_HOME` → cwd to find dsh's `node_modules`; if all fail, degrade gracefully and write the self-diagnostic |
| Tool definition | Prefer `defineTool` (with argument validation); fall back to the identity function when it cannot be resolved |
| Image value shape | Identical to the built-in `read_image` |
| UI vs. model fork | `output.render` decides what the model sees (forked by vision capability); `output.presentationMeta` decides what the UI sees |
| File write boundary | `node:fs` is used (`ctx.fs` has no binary write), but the target is forced to be inside the session workspace first |
| Settings read/write | `remote.settings.update` requires the field to be marked `volatile()`; the ref passed to `remote.credentials.set` must match `^[A-Za-z_][A-Za-z0-9_]*$` |
| Normalisation is shared | `provider.id` is slugified on both sides with byte-identical rules; the credential name derives from the normalised id |
| Keys never resolve across names | Resolution happens only under the provider's own ref (credential service → same-named env var), and the RPCs accept only a payload `apiKey` or a valid `keyRef` |
| One fallback chain only | `activeProviderId` match → `providers[0]` → legacy fields, with host and UI using the same rule |
| Model-list RPC | `GET {baseUrl}/models`, 15-second timeout, only `data[].id`; it is a settings-page helper and must never let an unresponsive provider freeze the page |
| Dialog implementation | With no primitives there is no portal, so `position:fixed` covers the viewport at `z-index` 1200, above every host overlay (Modal/lightbox 1000, Toast/Tooltip 1100, menus 100/101); the four close paths deliberately ignore `disabled` |
| Image-model filter | Token-based, never a whole-name substring match; the currently selected model is added to the options even if it does not look like an image model, so a selection never "disappears" |
| Model selection has one home | The four dropdowns map one-to-one to `modelRoutes`, `<option>` values are `providerId::model`, and the dialog holds no model-selection state. An empty-value option must be `hidden` + `disabled` **and must exist**, or a controlled dropdown renders the wrong value |
| Fallback trigger set | Encoded in `attemptWithHeaderBudget` (distinguishing `cancelled`/`timeout`/`failed`) and `requestImagesWithFallback` (one fallback attempt only) |
| Zero client dependencies | No Harness client package is imported, React comes from the browser module table, and colours use only `--dsw-*` theme tokens |
| Rendering must never throw | The host **permanently retires** a slot entry that throws while rendering, so any missing field degrades to a single line of text |
| Navigation icon | The shell picks navigation icons from a fixed list by section id and defaults third-party sections to a gear; the plugin "claims its own row" and swaps in its own mark, silently degrading when it cannot match and removing it on unmount. Revert to official capability once `settings.section` supports `icon` |

## Directory and tests

```
dsh-image-bridge-v4/
├── package.json        Manifest: bundle patch, dsh.client, icon, display metadata
├── cordis.patch.yml    Mount declaration (row id = the namespace the settings page writes to)
├── index.js            Host half: the two tools, multi-provider resolution, attachments and file writes, test/models/log channels, degraded self-diagnostics
├── client.js           Client half: the custom tool card + the settings page
├── locale/{zh,en}.json Display name and summary on the plugin card
└── icon.svg            Plugin icon
```

The regression suites live in `.dib-verify/` at the repository root. They need **no network and no real key**, and total 390 assertions:

```bash
node .dib-verify/verify-manifest.mjs   # 41
node .dib-verify/verify-client.mjs     # 162
node .dib-verify/verify-host.mjs       # 143
node .dib-verify/verify-security.mjs   # 12
node .dib-verify/verify-resolve.mjs    # 8
node .dib-verify/verify-upgrade.mjs    # 24
```

The cross-process end-to-end run needs a local mock image API first:

```bash
node .dib-verify/mock-image-api.mjs 8799   # in another terminal
node .dib-verify/verify-cross.mjs
```

`verify-upgrade` deserves a note of its own: **a user's provider config does not live in the plugin** — it lives on the profile row — so the plugin's own suites can never catch "renaming the plugin, changing the row id, or changing a default loses saved configuration". It drives the real patch-composition algorithm exported by Harness and asserts zero config drift after composing the real layer order.

**Restart DSH after changing plugin code**: Node caches loaded modules and hot reload ignores `node_modules` (config hot-reload is a separate channel and is unaffected).

Related documents:

| Document | Contents |
| --- | --- |
| [Repository README](../../README.md) | Project overview, quick start, test commands |
| [verify-report.md](../../.dib-verify/verify-report.md) | Independent verification report for the multi-provider rework |
| [verify-report-2.md](../../.dib-verify/verify-report-2.md) | Independent verification report on rename safety, the dropdown rework, the empty state, and navigation-icon claiming |

License: [MIT](LICENSE).

