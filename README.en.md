<p align="center">
  <img src="plugins/dsh-image-bridge-v4/icon.svg" width="96" alt="Image Bridge">
</p>

# Image Bridge (dsh-image-bridge)

English | [中文](README.md)

[![stars](https://img.shields.io/github/stars/kkj520/dsh-image-bridge?style=flat)](https://github.com/kkj520/dsh-image-bridge)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f8cff)](https://github.com/deepseek-ai)

Give a [DeepSeek Harness](https://github.com/deepseek-ai) model that **cannot draw** access to an external image service: install one plugin and the model gains two tools — `image_generate` and `image_edit` — with each result shown in the conversation as a persistent image attachment and saved to `generated-images/` in the session workspace.

> 📷 Screenshot pending: take one on **Settings → Image Bridge** and drop it at `docs/settings-en.png`.

## Install

```sh
dsh plugin --profile web add <absolute path to this repo>/plugins/dsh-image-bridge-v4
```

Your agent can also install it through the plugin manager: `install_bundle` with that directory as the target. Then restart `dsh web` and open **Settings → Image Bridge**.

## What you get

- **Drawing does not depend on the model** — vision or no vision, it works the same: the model calls the plugin, the plugin asks your external image service, and the image comes back as an attachment in the conversation
- **Several providers side by side** — each with its own endpoint and API key, with a connection light right on the card; one "Test connection" also lists the models that provider offers
- **Mix and match models** — generation and editing may use models from different vendors, each with a primary and a fallback; if the primary fails or times out the fallback takes over and the reply says which one was used
- **Only drawable models are listed** — your key may expose hundreds of models; by default only the ones recognised as image models show up, and one toggle reveals the rest
- **Size is up to you** — eight common presets, or any size string you type
- **Keys stay put** — API keys live in the DSH credential store (`$DSH_HOME/.credentials.yaml`, mode `0600`), never in the config file and never back to the browser
- **No key, no request** — when a request carries neither an explicit key nor a valid credential reference, the host sends not a single byte, and never falls back to another provider's key
- **Updates keep your config** — providers, models and size live in the profile, so updating the plugin leaves them alone

## Quick start

1. **Add a provider**: Settings → Image Bridge → "＋ Add model provider", then fill in the endpoint (e.g. `https://api.openai.com/v1`) and the API key
2. **Test, then save**: click "Test connection" → "Save" once the model list appears
3. **Pick models**: in the **Models** section, choose one model for generation and one for editing
4. **Draw**: just ask — "draw me a Shiba Inu in an astronaut helmet"

> Test without saving and the models never reach the dropdowns.

## Timeouts and fallback

Image generation is synchronous, so tens of seconds is normal (42–61 s measured). Keep both timeouts generous:

- **"Primary model timeout (ms)" = `fallbackAfterMs`, default 90000**: how long after the request was actually sent the host waits for response headers before switching to the fallback. DNS / TCP / TLS connection time does not count.
- **`timeoutMs`, default 180000**: the ceiling for one whole call.
- After a timeout the host probes the provider (`GET {baseUrl}/models`) and turns the result into one readable sentence that separates "the provider is down" from "the provider is just drawing slowly".

## Supported providers

Any **OpenAI-compatible** endpoint works: OpenAI, Zhipu, Qwen, SiliconFlow and the various relay services. Generation posts to `POST {endpoint}/images/generations`; editing posts to `POST {endpoint}/images/edits` with the reference image uploaded as multipart. All you need is an endpoint and an API key.

## Troubleshooting

Start with the **status light** and the failure reason on the card — most answers are already there.

| Symptom | Cause |
| --- | --- |
| "No usable API key" | This card has no key typed and none stored. It is **not** a network error — no request was sent |
| "Key rejected (401/403)" | The request went out; the provider refused the key |
| "Fetch models" returns 404 | That provider has no `/models`; generation still works |

Three self-diagnostics land in `$DSH_HOME/`:

| File | Contents |
| --- | --- |
| `dsh-image-bridge-startup.json` | rewritten by the host on every activation; names the provider actually in use |
| `dsh-image-bridge-client.log` | browser-side log, **never containing keys** |
| `dsh-image-bridge-degraded.json` | appears only when dependency resolution fails |

## Tests

```sh
node .dib-verify/verify-manifest.mjs   # 36   manifest and cross-file consistency
node .dib-verify/verify-client.mjs     # 157  client registration and component rendering
node .dib-verify/verify-host.mjs       # 139  host end to end
node .dib-verify/verify-security.mjs   # 12   security boundaries (SSRF refusal, response cap)
node .dib-verify/verify-resolve.mjs    # 8    dependency resolution robustness
node .dib-verify/verify-upgrade.mjs    # 24   user config survives an upgrade
```

**376 assertions**, no network and no real API key needed. The cross-process end-to-end run additionally needs the local mock service:

```sh
node .dib-verify/mock-image-api.mjs 8799   # in a second terminal
node .dib-verify/verify-cross.mjs
```

Every path is derived at runtime — no machine paths are hardcoded — and a missing environment tells you which variable to set (`DSH_BIN` / `DSH_PROFILE_DIR` / `DIB_PLUGIN_DIR`). A global `dsh` install is required.

## Layout

```
plugins/dsh-image-bridge-v4/   the plugin (host half index.js + client half client.js)
.dib-verify/                   test and acceptance suites
generated-images/              generated output (ignored, not committed)
```

`dsh-image-bridge/`, `image-bridge/` and `plugins/dsh-image-bridge{,-live,-v3}/` are historical copies superseded by v4 and not tracked — do not edit them.

## Known limitations

- **Plugin code changes require restarting DSH**: Node caches loaded modules and hot reload ignores `node_modules` (config hot reload is a separate channel and unaffected)
- **The sidebar icon is a workaround**: the shell hardcodes icons per section id, so third-party plugins always get a gear. This plugin claims its own row and swaps in its mark; it should revert to the official capability once `settings.section` supports an `icon` field

## Documentation

| Document | Contents |
| --- | --- |
| [Full plugin guide](plugins/dsh-image-bridge-v4/README.md) (Chinese) | configuration, behaviour details, troubleshooting, implementation notes |
| [Verification report](.dib-verify/verify-report.md) · [second round](.dib-verify/verify-report-2.md) | independent verification results, including what was not covered |
