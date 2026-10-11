# MapleRPC

Show Maple playback as a Discord listening activity in Vencord or Equicord. The official Maple app is [play.maple.music](https://play.maple.music/).

## Installation

1. Clone this repository into your mod's `src/userplugins/mapleRPC` directory.
2. Build your mod normally (`pnpm build`), then restart Discord.
3. Enable MapleRPC. Save the Maple API URL if you use a custom HTTPS server.
4. Open MapleRPC settings and sign in with your Maple username and password. If Discord asks to allow the API connection, allow it and restart Discord before signing in again.
5. Enable Discord integration in Maple and start a track. Updated Maple servers support upload-confirmed artwork IDs; older servers use the fallback described below.

No additional npm packages or changes to the mod's `package.json` or lockfile are needed. `crypto.randomUUID()` replaces `uuid`, and a small renderer-side Engine.IO v4 / Socket.IO JSON polling client replaces `socket.io-client`. Only Maple's default namespace is supported; this is not a general Socket.IO client.

When upgrading a manually copied installation, replace the plugin directory, including removal of the old `native.ts`. All three source files (`index.tsx`, `transport.ts`, `playback.ts`) are required. The plugin performs browser requests in the renderer, rather than registering a misleading Electron native helper.

[Original installation video](https://www.youtube.com/watch?v=XmVNRKrphlw).

## Sign-in and connection handling

The password field is masked and used for a single sign-in. Passwords are not stored in plugin settings. Starting the plugin removes the previous version's saved plaintext password from active settings. Old backups or previously synced copies may still contain it.

Maple's cookie authenticates the connection. Auto-connect reuses that cookie until it expires; sign in again when the settings status reports a rejected session. Cookies may be blocked by browser policies or server CORS configuration. Disconnect stops the plugin's connection and clears presence; it does not revoke Maple's cookie.

API URLs must use HTTPS and cannot contain embedded credentials, query parameters, or fragments. Requests include cookies, reject redirects, have timeouts and response limits, and never log credentials or RPC payloads. Artwork URLs use the configured API server. Additional activity buttons accept credential-free HTTPS URLs only.

Connection failures and missed server heartbeats clear presence. Reconnection backs off to 30 seconds. Stop, disconnect, pause/stop events, and expiry invalidate pending artwork requests so they cannot restore an obsolete activity.

## Artwork and playback

MapleRPC waits up to **30 seconds total** for a successful cover upload and Discord image resolution. If artwork is missing, rejected, slow, or unavailable, the current song still appears after that deadline, using Maple's default cover when it resolves. A failed default image lookup still allows the listening activity to display. The previous song clears when the next track starts preparing its cover.

The companion changes in `Maple-too` return an `artworkId` (a SHA-256 content hash) and forward it in playback reports, together with the remaining artwork wait. Upload and image lookup share one deadline; heartbeats do not restart it. Deploy the updated Maple API and web client together, reload Maple tabs, and rebuild your mod. Older servers without artwork confirmation can still publish playback using the 30-second fallback.

Artwork URLs are tied to the uploaded bytes. If another upload replaces the account's cover, an old URL returns 404 instead of the wrong album. Failed Discord image lookups retry every five seconds, including after fallback; a late successful lookup replaces the default cover. Successful artwork is reused for progress updates; a changed artwork ID refreshes the cover even when song metadata stays the same.

Maple's playback position, duration, and playback rate determine timestamps. Pause/stop updates clear presence immediately, and presence expires at track end or after the configured timeout without fresh updates. Pending artwork requests cannot restore a paused, disconnected, or superseded track.

## Development checks

Run the artwork lifecycle tests using an existing Vencord or Equicord checkout with its normal build dependencies installed:

```sh
VENCORD_DIR=/path/to/Vencord node --test --test-isolation=none tests/artwork.test.mjs
```

The fixture uses the checkout's existing `esbuild` and does not modify that checkout. Live Discord artwork rendering and Maple authentication still need a manual smoke test.
