# Image Bridge (dsh-image-bridge)

[Repository front page](../README.en.md) · [中文手册](manual.md)

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

Package name `@local/dsh-image-bridge` (the `@local/` prefix is DSH convention for a locally authored plugin that is not published to npm), version `0.3.0`.

### The three installation situations

**First install.** Run the command above, restart `dsh web`, then open **Settings → Image Bridge**. The list holds exactly one card: named "Default provider", tagged "Existing config" (the synthesised legacy single-provider record — base URL `https://api.openai.com/v1`, generation model `gpt-image-1`, size `1024x1024`; all of them are Config-schema defaults, since `cordis.patch.yml` deliberately carries no `config`). The four dropdowns are disabled, with the line "Add a model provider and test the connection first" beneath them — **that is the normal state of a fresh install, not a fault**. The shortest path from there is to edit that card: paste your API Key → Test connection → Save → then pick models in the Models section.

**Updating an existing install.** The directory is installed as a `link:`, so **whatever is in the source directory is what runs** — copy the new version over it (or `git pull`) and restart `dsh web`. No reinstall, and no need to remove anything first. Conversely, **do not move or rename this directory**: the link points at the original path, so moving it breaks the install and you have to `install_bundle` again from the new path. Your configuration lives on the profile row, not inside the plugin, so overwriting files never loses it.

**Uninstalling.** Disable or remove the bundle in the plugin manager. **Neither the config nor the credentials are cleaned up for you**: the config row (provider list, model routes, connect timeout) goes away with the row, while the keys stay in `$DSH_HOME/.credentials.yaml` — deliberately, see the third of the **three safety constraints** below. If you really want them gone, delete the lines starting with `DSH_IMAGE_BRIDGE_` from that file yourself.

## What you can do

### Generating and editing images

- **Generate** — the model calls `image_generate(prompt)` and the image lands in the conversation as an image card.
- **Edit** — `image_edit` changes an existing image by prompt. The image comes from a file path in the session workspace; PNG / JPEG / WebP / GIF are supported, and the edit request is sent as multipart.
- **Both tools take overrides**: a one-off `size`, or `model` to pick the model for this one call (blank means "use the model route from the settings page").
- **A file on disk** — besides the image card in the conversation, every result is saved to the workspace (see "Where the images go").

These are the only arguments the model sees:

| Tool | Argument | Required | Meaning |
| --- | --- | --- | --- |
| `image_generate` | `prompt` | yes | What to draw, as specific as possible |
| | `size` | no | Overrides the size for this call; blank uses the global size from the settings page |
| `image_edit` | `prompt` | yes | How to change it, e.g. "make the background a night street" |
| | `image_path` | yes | Path of the image to edit — relative to the workspace or absolute, both work |
| | `size` | no | Output size; blank keeps the original image's size or the configured default |

Both tools also take `model` (optional) to override the model for that one call.

### Multiple providers and model routing

- **Several providers** — generate with provider A and edit with provider B, or use just one; each has its own base URL, key, and model list.
- **Four slots** — generation and editing each have a **primary** and a **fallback**, and all four can be combined across providers freely.
- **A failed primary hands over to the fallback automatically**, and the reason is reported honestly (see "When the fallback model takes over").
- **Change the config whenever you like**: providers, model routes, and the connect timeout are re-read on every call — no restart needed.
- Nothing switches behind your back when you have not chosen anything: with no provider ever picked, using the first entry is the expected behaviour and no warning is emitted.

### How model candidates are presented and filtered

- **Candidates come from** the **union** of every provider that has a saved model list, grouped by provider, and **model names are never rewritten**.
- **Only image models are listed by default**, under a deliberately narrow rule (see "How image models are filtered"); tick "Show all models" to see language models too, or just type one with "Manual input…".
- **The selected model never disappears**: even if it does not look like an image model, it is added to the options.
- Every dropdown ends with **"Manual input…"** (a reserved value, never written to config).

### Credentials and safety

- **Keys never reach the config**: one key per provider, stored in the DSH credential service; the config only holds the credential name `DSH_IMAGE_BRIDGE_KEY_<ID>`. It is never written to config and never sent back to the browser.
- **Environment variables win**: with multiple providers each reads **its own** variable (id `zhipu` → `DSH_IMAGE_BRIDGE_KEY_ZHIPU`); legacy fallback mode reads `DSH_IMAGE_BRIDGE_API_KEY`. Key resolution **never crosses names**.
- **No request without an explicit key** — not even "Test connection" — so A's key is never sent to B's address.
- **Image URLs handed back by a provider have to pass inspection** (protocol, loopback, private ranges, size limits), while **a base URL you typed yourself may be local**.
- The details are in "Three safety constraints".

### Diagnostics and troubleshooting

- A **host startup report** (`$DSH_HOME/dsh-image-bridge-startup.json`): how far `apply` got, whether the seven dependency services are in place, the effective config, **which provider is actually in use**, and the failure reason. Credential names only, never keys.
- A **browser log** (`$DSH_HOME/dsh-image-bridge-client.log`): tab-separated time, level, event, detail; **never records a key**.
- `$DSH_HOME/dsh-image-bridge-degraded.json`, present only when dependency resolution failed. Read these three first, then go to "Troubleshooting".

## Configuration

The entry point is **Settings → Image Bridge**. Top to bottom the page is: page header → provider cards → dashed "＋ Add model provider" → the Models section → Global image size.

### Page header

`[icon] Image Bridge  dsh-image-bridge  v0.3.0`, with one subtitle line below. The badge links to the GitHub repository (opens in a new tab) and shows only the repository name — no `@local/` prefix. The icon follows the theme colour.

### The icon has two sources (do not edit the wrong one)

| Source | What it looks like | Where its colour comes from |
| --- | --- | --- |
| `icon.svg` (shipped with the package) | **White mark on brand blue**: the brand-blue rounded square plus a white line drawing — this is what the plugin list / market shows, matching how every other plugin there looks | The brand blue `#4176e6` in the file (the shell palette's `--dsw-static-deepseek-500`; in light themes `--dsw-alias-state-business-primary` is the same colour), with the mark stroked in white |
| `GLYPH_SHAPES` in `client.js` (inline) | The 22 px mark in the page header, and the mark the plugin claims for its own row in the settings navigation | **`currentColor` only**: the navigation row is tinted by CSS `mask-image` (a mask reads alpha only), so the inline shapes **must not** contain any hard-coded colour, or dark themes get a blob that ignores the theme |

The **geometry must match entry for entry** (frame + sun + deck/arch/two piers); a cross-file assertion watches this. The brand-blue background in `icon.svg` **is not part of the glyph group** — the navigation mask takes only what is inside `<g id="dib-icon-glyph">`, so putting the background into the inline shapes renders the navigation row as a solid square. The assertion is scoped the same way: **the colour discipline binds the inline shapes only; `icon.svg` is allowed to have the brand colour**.

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
| Status light | Green = this provider works (**two sources**, see below); red = a test or model fetch failed in **this session**; grey = never succeeded and never tested (hover for text) |
| Name | Whatever you typed when creating the card; the derived id when blank |
| Status line | Same source as the light, **four states**: tested in this session → "Connected"; green without a test this session → "Worked before (model list saved; not tested this session)"; red → "Connection failed"; grey → "Not tested" |
| Failure reason | An extra line only on failure; **reasons belong to one provider**, so a failure at A never shows up on B |
| Buttons | Test / Edit / Delete (delete is two-step: "Delete", then "Confirm delete") |

Green survives a page refresh: with no test result in this session, the card treats "this provider has a saved model list" as a **persistent signal** — but the UI now **says so**, reading "Worked before", instead of claiming "Connected". That is deliberate: the signal only proves it worked at some point, the key may since have been revoked, and the UI does not re-verify. Calling both situations "Connected" would be **over-promising**. Failure state stays in memory only and is never written to config. Base URL, models, and key status all live inside the **Edit** dialog.

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
[Fallback model ▾]   Used automatically when the primary cannot be reached (the fallback gets 30 s).
```

- **The two fallback rows have no visible label** (the dropdown already reads "Fallback model"), but each carries an equivalent `aria-label`, so screen readers can still tell the four controls apart.
- The dropdowns are **hand-rolled menus**: click-outside to close, Esc, arrow keys plus Enter, Home/End, and focus returns to the trigger on close; `role=listbox` / `role=option` with `aria-activedescendant`; the panel has a max height and keyboard movement scrolls the active item into view.
- **Options are the union of every provider that has ever fetched a model list**, grouped by provider (group headings look like `— OTHER —`), and **model names are never rewritten**. Every option carries `{ providerId, model }`, so generation can use A while the fallback uses B.
- Each dropdown ends with a fixed **"Manual input…"** entry (reserved value `__dib_manual__`, **not written to config**); the text box only appears once it is explicitly selected, and a **manually typed model goes to the provider currently in effect**.
- **Empty state** (no provider has ever fetched a model list): all four dropdowns are disabled and show their placeholders. The UI does **not** open four text boxes at once — just one hint line, "Add and test a model provider first".
- The block also holds the **"Connect timeout (seconds)"** input (default 15; you type seconds, the code converts to milliseconds); see "Connect timeout (seconds) and call timeout" for what it means.
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

`provider.id` is derived from the name: lowercased, runs of non-`[a-z0-9]` folded to `-`, leading and trailing `-` trimmed, truncated to 40 characters; a pure Chinese name folds to an empty string, in which case the host name of the base URL is used instead, and `provider` after that (with `-2`, `-3`… appended on collisions). **Host and client use the same rule** — any difference in normalisation produces "the UI reports a missing key under name A while the tool fetches the key under name B". A valid explicit `keyRef` on the provider record wins; only when it is blank is the name derived from the id.

Upgrade compatibility: when `providers` is empty but the legacy `baseUrl`/`model` (or `editModel`) have values, the settings page synthesises them into one card — named "Default provider", tagged "Existing config", id `default`, credential name kept as `DSH_IMAGE_BRIDGE_API_KEY` — and the tools keep using the legacy fields, so **your old key keeps working**. Nobody upgrading from the single-provider version sees "my configuration is gone".

### Directory layout

**Since v0.3.0 the repository root *is* the plugin package** — that is what makes the one-command install (`dsh plugin add github:kkj520/dsh-image-bridge`) work: when pnpm fetches a git dependency it packs the repository root, and there is no way to point it at a subdirectory.

```text
dsh-image-bridge/          ← repository root = package root
├── package.json       Manifest: bundle patch, dsh.client, icon, display metadata, files allowlist
├── cordis.patch.yml   Mount declaration: row id (= the namespace the settings page writes to) and package name; deliberately carries no config
├── index.js           Host half: the two tools, multi-provider resolution, attachments and workspace writes, test/models/log channels, the startup report and degraded diagnostics
├── client.js          Client half: the custom tool card + the settings page (header, cards, dialog, Models, size)
├── locale/{zh,en}.json Display name and summary on the plugin card
├── icon.svg           Plugin icon (white mark on brand blue, shipped with the package; same geometry as the inline shapes)
├── README.md          Repository front page (GitHub home / npm page)
├── docs/manual.en.md  This file; manual.md and README.en.md are the Chinese and English counterparts
├── CHANGELOG.md       Changelog
├── LICENSE            MIT
├── .npmignore         Packaging exclusions (see below)
└── .dib-verify/       Test and acceptance suites (travel with the repo, **not the package**)
```

Anything not on this list belongs to the repository rather than to the package: `.dib-verify/` (acceptance suites), `docs/*.png` (screenshots and logo) and `.ref-*.tmp*` (local caches of reference READMEs) are all kept out of the package by `.npmignore`. What lands on a user's machine is only what has to run.

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

### When the fallback model takes over

Model resolution order: an explicit `model` argument on the tool call → the **primary model** from the Models section (with its own providerId's base URL and credential) → the effective provider's `imageModel`/`editModel` → the legacy `baseUrl`/`model`. The fallback **only** comes from the Models section; unset, or pointing at an unusable provider, means there is no fallback.

**Three cases switch to the fallback** (and then the fallback is tried once):

1. **Cannot connect**: DNS / TCP / TLS / proxy did not put the request on the wire within the connect timeout (connect-phase timeout), or the network layer failed outright;
2. **Non-2xx**, including a body that is not valid JSON;
3. **HTTP 200 that yields no usable image** — from the user's point of view, nothing was drawn.

**Two cases do not**:

- **The user cancelled** (`exec.signal` already aborted) — a cancellation is not a failure;
- **The image was produced but the download failed** — you were already billed, and generating again bills you twice.

**Response time no longer switches anything.** The old "how long after the request was sent before headers arrive" budget (`fallbackAfterMs`) has been removed entirely: synchronous image APIs routinely take tens of seconds (measured: 42–61 seconds), so judging a provider by speed was both imprecise and prone to killing perfectly normal slow generations. Once the request is on the wire it is no longer timed, and the wait is bounded by the whole-call ceiling instead.

The fallback reports honestly: on success the message names the primary that failed, the reason, and the fallback model actually used; when both fail, the error names **both attempts with their own model and reason**. **When neither can be reached the error starts with "模型连接失败" (model connection failed)** and points at Settings → Image Bridge, plus the "Test connection" button for a reachability check.

### Connect timeout (seconds) and call timeout

The settings page has exactly one time setting: **"Connect timeout (seconds)"**, default **15**. You type **seconds**; the code converts to milliseconds. It measures exactly one thing: **whether the request got out** — DNS, TCP, TLS, proxy. If it has not been sent within that time, the provider counts as unreachable and the **fallback model takes over**; the error also spells out how many milliseconds the connect phase took before giving up.

- **The fallback's connect limit is a fixed 30 seconds**, not a setting: it is the last resort, and its budget should not be another knob to get wrong.
- **Once the request is sent, nothing is timed any more**: however long the provider takes is fine, bounded by the **whole-call ceiling**. A mistyped address or an offline provider therefore costs at most 15 seconds before the fallback steps in, while normal slow generation is never mistaken for a failure.
- Each attempt has its own connect budget: the primary uses the seconds you typed, the fallback uses its fixed 30.
- When neither can be reached the error says **"模型连接失败"** plus both attempts' own reasons, instead of a vague failure.
- A request that has already been sent is **never resent**: resending a non-idempotent POST can bill you twice for one generation.

**The whole-call ceiling** (`timeoutMs`, default **180000** ms) is a different thing: it bounds how long one tool call may take in total, and on expiry the error states how far over it went. It is **not on the settings page**: like `saveToWorkspace` and `outputDir`, it is a "config-only" field. Like the connect timeout it is **re-read on every call** — the old version captured it once at mount time, so changing it did nothing; now a change takes effect immediately.

### Three safety constraints (deliberate)

1. **No request without an explicit key.** "Test connection" and "Fetch available models" accept only the `apiKey` explicitly present in the request, or a credential behind a valid `keyRef`. With neither, the host **sends not a single byte** and never falls back to the effective provider's key — otherwise A's key would be sent to B's address. The base URL works the same way and is **never substituted**: a key with no address is an error, not "borrow someone else's address". Tool calls work the same way: a key is resolved only under its own ref, and **never across names**.
2. **Image URLs handed back by a provider have to pass inspection.** Some APIs do not return image data but a URL for the client to download. That address is **the provider's**, so only `http`/`https` is allowed and loopback and private ranges are refused (cloud metadata `169.254.169.254`, `10.x`, `192.168.x`, …) — otherwise a compromised provider could use your process to probe your intranet. The response body has a cap too (32 MiB), and the download itself is bounded (15 seconds, 20 MiB). Note this **only constrains addresses handed to you**: a base URL you typed yourself may be local (a local image service or a local mock are legitimate uses), as long as the protocol is http/https.
3. **Deleting a provider does not delete its credential.** Deleting is a configuration action and should not destroy a key you may want to reuse. If you really want it gone, remove that line from `$DSH_HOME/.credentials.yaml` yourself.

### Where the images go

1. Submitted as a **persistent image attachment** — shown as an image card in the conversation.
2. Saved as `generated-images/image-<timestamp>-<prompt fragment>.png`. The directory can be changed with `outputDir`, but the resolved path must stay inside the session workspace, otherwise the write is refused. Whether this step happens at all is decided by `saveToWorkspace` (on by default).

`outputDir` and `saveToWorkspace` are likewise **not on the settings page** — they live in the config (the `config` of the profile row; see the note on `cordis.patch.yml` under "Directory layout").

### While generating, you can see how long you have waited

During generation or editing, the card's "正在生成图片…" / "正在修改图片…" line carries a **second counter that ticks up every second** (e.g. `正在生成图片… 12s`, same for `edit`), which disappears when the call finishes. The first frame is already `0s` (there is no blank first second); the locale key is `running.elapsed` (zh / en share the `{seconds}s` format). This placeholder is the **only moment the user can see this card's contents** — once the conversation settles, the host collapses/hides the card (see below).

### When the model cannot see images

The behaviour forks on **whether the calling route declares image input**:

- declares `image` input → the image ships as an image content block with the tool result, and the model sees it directly;
- does not declare it → only a text envelope and the file path go out (otherwise the DSH adapter throws `UNSUPPORTED_CONTENT` for a route that does not accept image input).

**Either way the image card in the UI is shown** — it reads the persisted image reference from the tool result, independently of the model's vision.

## Troubleshooting

Start with the three self-diagnostics; almost every failure can be read off them:

| File | Contents |
| --- | --- |
| `$DSH_HOME/dsh-image-bridge-startup.json` | Rewritten on every host activation: `steps`, `services`, `config`, `configSource`, **which provider is actually in use** (`provider`), and the failure reason. Credential names only, never keys |
| `$DSH_HOME/dsh-image-bridge-client.log` | Tab-separated browser-side log (time, level, event, detail); **never records a key** |
| `$DSH_HOME/dsh-image-bridge-degraded.json` | Present only when dependency resolution failed |

`provider.level` tells you **which level the fallback actually landed on** (`active` / `first` / `legacy`), and `provider.requested` is the id you had picked. The config list alone cannot distinguish "configured" from "actually in use"; these two fields exist to answer that.

`steps` is the main line `apply` walked, read in order: normally "Config schema ready → both tools registered → test channel mounted". When the tools step is missing, the next line states the real cause (for example `dsh-tools 未解析：两个工具未注册`) and how to fix it — **a missing dependency means no tools are registered, and it never degrades silently**: if the parameters cannot be compiled into a JSON Schema you get no tool at all, and you read about it here instead of getting one whose schema silently does nothing.

`services` reports whether seven dependencies are in place; whichever is missing produces its own symptom:

| Key | When true | When false |
| --- | --- | --- |
| `tools` | the two tools register | there are no tools at all; the rest of the settings page still works |
| `attachments` | images enter the conversation as persistent attachments | a produced image cannot be attached, so the card never appears |
| `fs` | images are saved into the workspace, and the source image for an edit is read | workspace writes and edit-time reads fail |
| `credentials` | the API key can be stored and read | no key can be read → "No usable API key" |
| `llm` | the route's vision capability can be determined | it degrades to a text envelope only |
| `webServer` / `connection` | the settings page's test / fetch-models / log channels | the page opens, but every button reports a channel failure |

All-false `services` usually means this report came from a **test harness** (or from applying the plugin on its own) rather than a real session — in a real session `tools`, `fs`, and `credentials` are expected to be true.

| Symptom | What to do |
| --- | --- |
| "No usable API key" | This card has no key typed and none stored, so **no request was sent at all**. It is not the same as "key rejected (401/403)". Enter the key and click Save |
| 401/403 key rejected | The key is wrong, or the service does not accept `Authorization: Bearer`. Remember **environment variables take precedence over the credential service**: with multiple providers each reads **its own** variable (id `zhipu` → `DSH_IMAGE_BRIDGE_KEY_ZHIPU`), while legacy fallback mode uses `DSH_IMAGE_BRIDGE_API_KEY` |
| 404 | Usually the provider simply has no `/models`, which does not affect generation; if generation itself 404s, the API path is not OpenAI-compatible |
| All four dropdowns are empty (disabled) | No model list has been saved yet: test connection / fetch models → **Save**. You can also use "Manual input…" right away |
| There are candidates but not the model I want | Only image models are shown by default — tick "Show all models" or use "Manual input…"; a model just fetched must be saved in the dialog first; it may also belong to another provider, so expand that group |
| No "Image Bridge" page in Settings | Check that the plugin is enabled; look for `fatal` on `client apply` in the client log; check for a degraded file |
| **Nothing changed after installing / editing code** | **Restart `dsh web`**: Node caches loaded modules and hot reload ignores `node_modules`, so editing `index.js` and refreshing the page is not enough — the same goes for `client.js`. **Config** travels a separate channel (the settings page saves through hot update) and is unaffected. Before restarting, confirm the plugin manager really shows it as enabled |
| Changing `timeoutMs` / `connectTimeoutSeconds` did nothing | Both are re-read on every call and take effect as soon as they are saved. If nothing changes at all, make sure you edited the row `config` of **this** profile (the settings page writes to the same row, id `image-bridge-v4`), and check whether `config` in the startup report shows your new value |
| Primary cannot be reached and neither can the fallback | The error says "模型连接失败" and lists both attempts' reasons. Use "Test connection" on both providers first; the connect timeout is counted in seconds (15 by default, 30 fixed for the fallback), and a cross-border cold connect usually takes a few hundred milliseconds — a timeout means the address or the network is wrong |
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
| Fallback trigger set | Encoded in `attemptWithConnectBudget` (distinguishing `cancelled`/`timeout`/`failed`) and `requestImagesWithFallback` (one fallback attempt only) |
| Zero client dependencies | No Harness client package is imported, React comes from the browser module table, and colours use only `--dsw-*` theme tokens |
| Rendering must never throw | The host **permanently retires** a slot entry that throws while rendering, so any missing field degrades to a single line of text |
| Navigation icon | The shell picks navigation icons from a fixed list by section id and defaults third-party sections to a gear; the plugin "claims its own row" and swaps in its own mark, silently degrading when it cannot match and removing it on unmount. Revert to official capability once `settings.section` supports `icon` |

## Tests

The regression suites live in `.dib-verify/` at the repository root. They need **no network and no real key**, and the six of them total **425 assertions** (measured):

```bash
node .dib-verify/verify-manifest.mjs   # 47
node .dib-verify/verify-client.mjs     # 180
node .dib-verify/verify-host.mjs       # 147
node .dib-verify/verify-security.mjs   # 19
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
| [Repository README](../README.md) | Project overview, quick start, test commands |
| [verify-report.md](../.dib-verify/verify-report.md) | Independent verification report for the multi-provider rework |
| [verify-report-2.md](../.dib-verify/verify-report-2.md) | Independent verification report on rename safety, the dropdown rework, the empty state, and navigation-icon claiming |

License: [MIT](../LICENSE).
