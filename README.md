# OMP Honcho Memory

Honcho-backed cross-session memory for [Oh My Pi](https://github.com/can1357/oh-my-pi).

The extension binds each native OMP chat to a Honcho session, injects bounded relevant memory before model requests, and uploads completed user/assistant turns after each agent run.

## Features

- Preserves exact configured peer IDs; no forced lowercase or `user-`/`ai-` prefixes.
- Uses OMP's native `sessionManager.getSessionId()` and refuses missing session IDs.
- Creates one Honcho session per OMP chat with `chat-instance` strategy.
- Injects bounded structured context and raw workspace search results.
- Serializes message uploads and advances local deduplication only after success.
- Flushes pending writes on session switch, compaction, and shutdown.
- Shows transient bilingual operation notices instead of a persistent bottom-bar status.
- Provides explicit tools for search, context inspection, conclusions, and health checks.

## Requirements

- OMP 18.2.5 or newer. New OMP releases may change extension APIs; run the verification workflow after every OMP upgrade.
- Bun 1.3 or newer for building.
- A Honcho workspace and API key.

## Install

```sh
bun install --frozen-lockfile
bun run check
bun run build
mkdir -p ~/.omp/agent/extensions
cp dist/index.js ~/.omp/agent/extensions/honcho-memory.js
```

Restart OMP after installation.

## Configuration

Create `~/.honcho/config.json` with private file permissions. Never commit the real file.

```json
{
  "peerName": "YOUR_USER_PEER",
  "apiKey": "${HONCHO_API_KEY}",
  "hosts": {
    "omp": {
      "enabled": true,
      "workspace": "YOUR_WORKSPACE",
      "peerName": "YOUR_USER_PEER",
      "aiPeer": "omp",
      "sessionStrategy": "chat-instance",
      "sessionPeerPrefix": false,
      "observationMode": "unified",
      "saveMessages": true
    }
  }
}
```

Set the secret in the process environment:

```sh
export HONCHO_API_KEY='...'
chmod 600 ~/.honcho/config.json
```

Environment variables override file configuration. Supported overrides include `HONCHO_API_KEY`, `HONCHO_URL`, `HONCHO_WORKSPACE`, `HONCHO_PEER_NAME`, and `HONCHO_AI_PEER`.

## Runtime notices

The extension does not keep a permanent `connected` label in OMP's bottom status bar. It emits transient colored notices:

- `✓ Honcho 记忆已连接 · Memory connected`
- `⌕ 正在检索相关记忆 · Searching relevant memory`
- `✓ 相关记忆已载入 · Relevant memory loaded`
- `↑ 正在保存本轮记忆 · Saving turn memory`
- `✓ 本轮记忆已保存 · Turn memory saved`
- `! Honcho 记忆同步失败 · Memory sync failed`

## Verification

```sh
bun run check
bun run build
bun run verify
```

Then start a new OMP session and confirm:

1. `/tmp/honcho-plugin.log` contains `session_start`, `before_agent_start`, and `agent_end: batch saved`.
2. Honcho contains exactly attributed messages for the configured user peer and AI peer.
3. A second OMP session recalls a known, non-sensitive fact without including the answer in its prompt.

## Reliability boundaries

- Remote success followed by a local timeout can cause duplicates on retry; the server path is not exactly-once.
- The upload queue is process-local, not a crash-persistent journal.
- OMP bounds shutdown hooks, so normal turn persistence must not rely only on shutdown.
- Automatic durable-conclusion extraction is intentionally narrow but can still mistake temporary preference language for a stable preference.
- Independent peers and sessions are not an access-control system.

## Security

- Never commit `~/.honcho/config.json`, `.env`, API keys, session transcripts, cloud exports, or runtime logs.
- Use synthetic, non-sensitive data for verification.
- Review every OMP upgrade before enabling this extension globally.

## Attribution

Derived from `@citywalki/oh-my-pi-honcho-memory` 0.2.0 and substantially adapted for exact identity preservation, native OMP sessions, reliable turn persistence, bounded source-aware recall, and bilingual runtime notices. See [NOTICE](NOTICE).

## License

MIT. See [LICENSE](LICENSE).
