# MapleRPC

Show Maple playback as a Discord listening activity in Vencord or Equicord. The official Maple app is [play.maple.music](https://play.maple.music/).

## Installation

1. Clone this repository into your mod's `src/userplugins/mapleRPC` directory.
2. Build your mod normally (`pnpm build`), then restart Discord.
3. Enable MapleRPC. Save the Maple API URL if you use a custom HTTPS server.
4. Open MapleRPC settings and sign in with your Maple username and password. If Discord asks to allow the API connection, allow it and restart Discord before signing in again.
5. Enable Discord integration in Maple and start a track. Existing Maple servers only publish an RPC update when a track starts; the plugin cannot recover an already-playing track when first connecting.

No additional npm packages or changes to the mod's `package.json` or lockfile are needed. `crypto.randomUUID()` replaces `uuid`, and a small renderer-side Engine.IO v4 / Socket.IO JSON polling client replaces `socket.io-client`. Only Maple's default namespace is supported; this is not a general Socket.IO client.

When upgrading a manually copied installation, replace the plugin directory, including removal of the old `native.ts`. All three source files (`index.tsx`, `transport.ts`, `playback.ts`) are required. The plugin performs browser requests in the renderer, rather than registering a misleading Electron native helper.

[Original installation video](https://www.youtube.com/watch?v=XmVNRKrphlw).

## Sign-in and connection handling

The password field is masked and used for a single sign-in. Passwords are not stored in plugin settings. Starting the plugin removes the previous version's saved plaintext password from active settings. Old backups or previously synced copies may still contain it.

Maple's cookie authenticates the connection. Auto-connect reuses that cookie until it expires; sign in again when the settings status reports a rejected session. Cookies may be blocked by browser policies or server CORS configuration. Disconnect stops the plugin's connection and clears presence; it does not revoke Maple's cookie.

API URLs must use HTTPS and cannot contain embedded credentials, query parameters, or fragments. Requests include cookies, reject redirects, have timeouts and response limits, and never log credentials or RPC payloads. Artwork URLs use the configured API server. Additional activity buttons accept credential-free HTTPS URLs only.

Connection failures and missed server heartbeats clear presence. Reconnection backs off to 30 seconds. Stop, disconnect, pause/stop events, and expiry invalidate pending artwork requests so they cannot restore an obsolete activity.

## Playback accuracy and existing Maple servers

Analysis used the `Maple-too` clone. Its `src/lib/player.ts` sends `nowPlaying` at track start. `api/iomanager/io.js` forwards track metadata as `rpcUpdate`, but drops playback timing. `api/maple.js` only logs a listener disconnect; it does not clear other RPC clients. The plugin remaining connected is therefore not proof that the listening browser is still playing.

With this existing protocol, the plugin shows metadata without inventing a playback start time. Presence expires after **10 minutes without a playback update** by default. The timeout is adjustable from 1–30 minutes. This bounds stale presence after a listening browser closes, but also clears unusually long tracks that send no fresh update. Pausing or seeking cannot be detected immediately with the current server.

For accurate progress and immediate pause/stop handling, Maple must extend `rpcUpdate` as described in [the playback contract](docs/playback-contract.md). The plugin already accepts those fields, recalculates timestamps on seeks, accounts for playback rate, and expires at track end when position and duration are available.

## Development checks

With Node 24 or later, run the transport and playback tests without installing packages:

```sh
node --experimental-transform-types --test --test-isolation=none tests/*.test.mjs
```

For all tests, including plugin lifecycle checks, point to an existing Vencord or Equicord checkout with its normal build dependencies installed:

```sh
VENCORD_DIR=/path/to/Vencord node --experimental-transform-types --test --test-isolation=none tests/*.test.mjs
```

The lifecycle fixture uses that checkout's existing `esbuild`; it does not modify the checkout. Real Discord rendering, CSP permission prompts, and live Maple authentication still need a manual smoke test.
