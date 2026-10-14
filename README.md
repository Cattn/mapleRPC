# MapleRPC

MapleRPC shows what you are listening to in [Maple](https://play.maple.music/) as a Discord listening activity. It is a user plugin for Vencord and Equicord.

Your Discord profile displays the song title, artist, album artwork, and playback progress when Maple provides it. The member list shows the current song title, while the expanded activity uses **Maple** as the app name.

## Features

- Song and artist information from your Maple session.
- Album artwork that updates when a cover finishes uploading.
- A default Maple cover if artwork is unavailable after 30 seconds.
- Playback timestamps based on Maple's reported position, duration, and playback rate.
- A **Listen on Maple** button and up to one additional HTTPS link supplied by Maple.
- Automatic reconnection and cleanup when playback stops or the connection is lost.

## Installation

You need a Vencord or Equicord source checkout with its normal build dependencies installed, a Maple account, and access to the Maple API.

From your Vencord or Equicord repository directory:

```sh
git clone https://github.com/Cattn/mapleRPC.git src/userplugins/mapleRPC
pnpm build
```

Restart Discord after building, then:

1. Open your mod's plugin settings and enable **MapleRPC**.
2. Open MapleRPC's settings. The default API server is `https://api.maple.music`. If you use a custom server, save its URL and restart Discord before connecting.
3. Enter your Maple username and password, then select **Sign in**.
4. If Discord asks for permission to connect to the API, allow it, restart Discord, and sign in again.
5. Enable Discord integration in Maple and start playing a song.

MapleRPC uses your mod's existing dependencies. All three source files—`index.tsx`, `playback.ts`, and `transport.ts`—must be present in the plugin directory.

## Updating

From your mod's repository directory:

```sh
git -C src/userplugins/mapleRPC pull
pnpm build
```

Restart Discord to load the updated plugin. If you installed by copying files, replace all three source files. When upgrading from a version that included `native.ts`, remove that file too.

## Settings

- **Maple API server URL:** The HTTPS API address. Defaults to `https://api.maple.music`. Changing it requires a restart. Use an API URL without embedded credentials, query parameters, or a fragment.
- **Session:** Sign in with your Maple account, reconnect using its existing session cookie, or disconnect and clear the activity. The connection status appears here.
- **Reuse your Maple session on startup:** Enabled by default. Automatically connects using an existing Maple session cookie.
- **Initial connection retry delay:** Defaults to 5 seconds. Failed connections retry with increasing delays, up to 30 seconds. This controls reconnection timing; it is separate from playback updates.
- **Clear playback after this many minutes without a Maple playback update:** Defaults to 10 minutes. Prevents an old song from remaining visible indefinitely. Older Maple servers may only send updates when tracks change.
- **Show timestamps:** Enabled by default. Displays progress when Maple supplies a playback position.
- **Show buttons:** Enabled by default. Adds the Maple listening link and a valid additional link when available.

## How artwork works

With the updated Maple API and web client, playback reports indicate whether the current track's cover has finished uploading. After the API saves the image, it emits an `albumArtUploaded` socket event. MapleRPC receives that notification, asks Discord to resolve the image, and updates the listening activity.

Artwork is fetched using the existing endpoint:

```text
https://api.maple.music/public/get/albumArt/{userId}/{random}
```

`userId` is the Maple account ID from the playback report. `random` is a new UUID used to avoid reusing a cached image lookup. A custom API server replaces the base URL. No SHA hash is required.

An optional `artworkRequestId` identifies an upload for a particular track. MapleRPC matches it against upload notifications so a late notification from an earlier track does not confirm the current track's artwork. This token is separate from the artwork URL.

The plugin waits up to **30 seconds total** for upload completion and Discord image resolution. Playback updates do not restart that deadline. If the cover is still unavailable, the activity appears with Maple's default cover when that asset resolves. If the default asset also fails, the song information can still appear without an image.

Once album artwork resolves, it stays cached for that track and remains visible after the deadline. Failed image lookups retry every five seconds, and a later successful lookup or upload notification can replace the fallback cover.

Playback reports include artwork readiness so a reconnect can recover even if the original upload event was missed. To use this flow, deploy the matching Maple API and web client changes, reload Maple tabs, and rebuild your mod.

### Older Maple clients and servers

If a playback report omits artwork readiness, MapleRPC attempts to load the account's current cover through the same random URL endpoint. This preserves compatibility with older systems, but that image may still be the previous track's cover until a new upload completes. Without an upload notification, the plugin cannot reliably identify that transition.

## Playback and connection behavior

Pause, stop, and ended reports clear the activity. The activity also expires at the reported track end or after the configured timeout without a fresh playback update, whichever comes first.

If Maple does not report a playback position, MapleRPC leaves out timestamps. When it does, progress is calculated from the reported position, duration, and playback rate.

Connection loss, disconnecting, and disabling the plugin clear the activity. Pending artwork lookups are invalidated when playback is cleared or superseded, so they cannot restore an obsolete song.

## Sign-in and privacy

Your password is used for the sign-in request and is not saved in plugin settings. Maple's session cookie authenticates later requests and startup reconnections. Disconnecting stops MapleRPC's connection; it does not sign you out of Maple.

When upgrading from an older version that saved a plaintext password, starting this version removes that setting from active plugin settings. Previously saved backups may still contain it.

## Troubleshooting

- **No activity appears:** Enable both MapleRPC and Maple's Discord integration, start playback, and check the connection status in the plugin settings. With pending artwork, the activity may take up to 30 seconds to appear. Also check Discord's activity privacy settings.
- **A restart is requested:** Restart Discord after granting the API connection permission, then sign in again.
- **The session expired or was rejected:** Sign in again to obtain a fresh Maple session cookie.
- **The connection keeps retrying:** Check the configured API URL and server availability. Custom servers must allow credentialed requests from your Discord client through their CORS configuration.
- **The default cover appears:** The upload or Discord image lookup has not succeeded. Check the Maple API/client versions and that the artwork URL returns an image. A successful cover lookup can still replace the fallback later.
- **The previous song's cover appears:** Make sure the Maple API and client both support upload readiness and upload notifications. Older reports use the account's current image and cannot always distinguish an upload in progress.
- **Progress is missing:** The server may not provide a playback position, or timestamps may be disabled in MapleRPC settings.
- **A long track disappears:** Check the stale playback timeout. A legacy server that only reports track changes may need a longer timeout.

## Development

The plugin runs in Discord's renderer. `transport.ts` implements the Engine.IO v4 HTTP polling and Socket.IO JSON events used by Maple's default namespace. `playback.ts` parses playback reports and calculates timestamps and expiry. `index.tsx` handles settings, connection state, artwork, and activity updates.

Build through the parent Vencord or Equicord checkout. For a manual smoke test:

1. Play a track with artwork and confirm its cover stays visible past 30 seconds and through progress updates.
2. Play a track without artwork and confirm the fallback appears after the deadline.
3. Complete a delayed artwork upload and confirm it replaces the fallback.
4. Switch tracks, pause, and disconnect while an image lookup is pending; confirm an old activity does not reappear.
