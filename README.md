# dsh-profile-multica

English | [中文](README.zh.md)

An installable community bundle that exposes the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI to Multica through a versioned JSONL process protocol.

See the [protocol reference](docs/protocol.md) for request, event, cancellation, and exit semantics.

The bundle adds three commands to a dedicated profile:

```bash
dsh --profile multica --probe
dsh --profile multica --list-models
dsh --profile multica --stdio
```

`--probe` prints the discovery frame used by Multica. `--list-models` projects the installed DSH providers, models, and reasoning levels. `--stdio` accepts one version-1 execute request, streams Agent and Session events as JSONL, accepts cancellation for the active request, flushes persistence, prints one terminal result, and exits. Protocol frames use stdout; diagnostics use stderr.

An execute request can create a fresh Agent or resume a persisted Session, select a provider/model/reasoning level, and mount task-scoped stdio or Streamable HTTP MCP servers. `MULTICA_DSH_SESSION_ROOT` selects the JSONL persistence directory. `DSH_PERMISSION_MODE` may be `read-only`, `workspace-write`, or `danger-full-access`; the default is `workspace-write`. This transport has no interactive approval round trip, so operations outside the selected policy fail instead of waiting.

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- `@deepseek-ai/dsh` `0.1.0-rc.7` or later. Assistant output is projected from the durable
  `assistant/message` settlement, so the bundle also covers the 0.1.3+ lines, where session
  format v2 stopped recording per-delta `assistant/chunk` events.
- pnpm on `PATH` for `dsh plugin`

## Install

After the package is published to npm:

```bash
npm install --global @deepseek-ai/dsh@0.1.0-rc.7
dsh plugin --profile multica add dsh-profile-multica
dsh --profile multica --probe
```

To install a local checkout, build a tarball first:

```bash
pnpm install
pnpm pack
dsh plugin --profile multica add /absolute/path/dsh-profile-multica-0.1.0.tgz
dsh --profile multica --probe
```

The plugin command creates the `multica` profile over the official `dsh-base`, installs this bundle, and appends its declared patch layer. Profile installation and the Multica daemon must run as the same OS user and use the same `DSH_HOME` when it is customized.

## Develop

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run smoke:pack
pnpm pack
```

`smoke:pack` packs the current checkout, installs the tarball into an isolated profile using the supported official DSH release, verifies `--probe`, and removes the temporary profile.

Before publishing, add the `dsh-plugin` GitHub topic and verify the packed tarball against a clean official CLI installation.

## Model experience

The bridge adds no system-prompt text or tool schema. It submits Multica input as an ordinary user message and projects existing DSH events.

## Limitations

- One process accepts one execute request; Multica launches a fresh process per task.
- The protocol has no approval response. Choose an appropriate non-interactive permission mode for the target environment.
- Model discovery reports a failing provider on stderr and continues with the remaining providers.
- The package tracks prerelease DSH APIs, so a new DSH prerelease may require a matching plugin release.

## License

MIT
