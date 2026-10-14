/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher, Forms, React, TextInput, useEffect, useState } from "@webpack/common";

import { MAPLE_URL, parsePlayback, Playback, playbackExpiry, playbackTimestamps } from "./playback";
import { MapleConnection, normalizeServerUrl, request } from "./transport";

const applicationId = "1360456499263963156";

interface Activity {
    application_id: string;
    name: string;
    type: number;
    status_display_type: number;
    flags: number;
    details: string;
    state?: string;
    assets?: { large_image: string; large_text: string; };
    timestamps?: { start: number; end?: number; };
    buttons?: string[];
    metadata?: { button_urls: string[]; };
}

let running = false;
let generation = 0;
let renderRevision = 0;
let connection: MapleConnection | undefined;
let loginController: AbortController | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let artworkRetryTimer: ReturnType<typeof setTimeout> | undefined;
let artworkFallbackTimer: ReturnType<typeof setTimeout> | undefined;
let artworkDeadline = 0;
let artworkTrack: string | undefined;
let defaultArtwork: Promise<string | undefined> | undefined;
let currentPlayback: Playback | null = null;
let artwork: { key: string; url: string; assetId?: string; asset?: Promise<string | undefined>; } | undefined;
let status = "Disconnected.";
const statusListeners = new Set<(status: string) => void>();

function setStatus(value: string): void {
    status = value;
    statusListeners.forEach(listener => listener(value));
}

function setActivity(activity: Activity | null): void {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: "MapleRPC" });
}

function clearPlayback(): void {
    ++renderRevision;
    clearTimeout(expiryTimer);
    clearTimeout(artworkRetryTimer);
    clearTimeout(artworkFallbackTimer);
    artworkTrack = undefined;
    artworkDeadline = 0;
    currentPlayback = null;
    artwork = undefined;
    setActivity(null);
}

function disconnect(): void {
    ++generation;
    loginController?.abort();
    loginController = undefined;
    connection?.stop();
    connection = undefined;
    clearPlayback();
    setStatus("Disconnected.");
}

async function ensureConnectSrcAllowed(serverUrl: string): Promise<void> {
    if (IS_WEB) return;
    const { origin } = new URL(serverUrl);
    if (await VencordNative.csp.isDomainAllowed(origin, ["connect-src"])) return;
    const result = await VencordNative.csp.requestAddOverride(origin, ["connect-src"], "MapleRPC");
    throw new Error(result === "ok" ? "Restart Discord to apply Maple's connection permission, then sign in." : "Maple's connection permission was not granted.");
}

async function connect(password?: string, username?: string): Promise<void> {
    if (!running) {
        setStatus("Enable MapleRPC before connecting.");
        throw new Error("Enable MapleRPC before connecting.");
    }
    disconnect();
    const attempt = generation;
    const controller = new AbortController();
    loginController = controller;
    try {
        const serverUrl = normalizeServerUrl(settings.store.serverUrl);
        await ensureConnectSrcAllowed(serverUrl);
        if (!running || attempt !== generation) return;
        if (password !== undefined) {
            if (!username?.trim() || !password) throw new Error("Enter your Maple username and password.");
            setStatus("Signing in to Maple…");
            const body = await request(`${serverUrl}/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: username.trim(), password })
            }, controller.signal);
            if (JSON.parse(body)?.status !== "Success") throw new Error("Maple sign-in failed.");
        }
        if (!running || attempt !== generation) return;
        connection = new MapleConnection(serverUrl, {
            onUpdate(value) {
                if (!running || generation !== attempt) return;
                const playback = parsePlayback(value);
                if (!playback) {
                    clearPlayback();
                    setStatus("Connected. No active playback.");
                    return;
                }
                currentPlayback = playback;
                setStatus("Connected. Receiving playback.");
                void updatePresence();
            },
            onArtwork(value) {
                if (!running || generation !== attempt || !currentPlayback || !value || typeof value !== "object") return;
                const event = value as { id?: unknown; artworkRequestId?: unknown; };
                if (event.id !== currentPlayback.id || event.artworkRequestId !== currentPlayback.artworkRequestId) return;
                if (currentPlayback.artworkRequestId && currentPlayback.artworkReady) return;
                currentPlayback = { ...currentPlayback, artworkReady: true };
                // Legacy upload notifications refresh an already-resolved per-account image.
                if (!currentPlayback.artworkRequestId) artwork = undefined;
                void updatePresence();
            },
            onDisconnect() {
                if (running && generation === attempt) clearPlayback();
            },
            onStatus(value) {
                if (running && generation === attempt) setStatus(value);
            }
        }, settings.store.refreshInterval * 1000);
        connection.start();
    } catch (error) {
        if (!running || attempt !== generation) return;
        clearPlayback();
        setStatus(error instanceof Error ? error.message : "Unable to connect to Maple.");
        throw error;
    } finally {
        if (loginController === controller) loginController = undefined;
    }
}

function SessionSettings() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(status);
    useEffect(() => {
        statusListeners.add(setMessage);
        return () => { statusListeners.delete(setMessage); };
    }, []);
    async function signIn() {
        setBusy(true);
        const secret = password;
        setPassword("");
        try {
            await connect(secret, username);
        } catch { /* The connection status contains the error. */ }
        finally { setBusy(false); }
    }
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Forms.FormText>{message}</Forms.FormText>
            <Forms.FormText>Save changes to the server URL before signing in. Passwords are used for this sign-in only; Maple's session cookie is reused on startup.</Forms.FormText>
            <TextInput placeholder="Maple username" value={username} onChange={setUsername} disabled={busy} />
            <TextInput type="password" placeholder="Maple password" value={password} onChange={setPassword} disabled={busy} />
            <div style={{ display: "flex", gap: 8 }}>
                <Button disabled={busy || !username.trim() || !password} onClick={() => void signIn()}>Sign in</Button>
                <Button disabled={busy} variant="secondary" onClick={() => { void connect().catch(() => {}); }}>Reconnect</Button>
                <Button variant="secondary" onClick={disconnect}>Disconnect</Button>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "Maple API server URL (HTTPS)",
        default: "https://api.maple.music",
        restartNeeded: true,
        isValid: value => {
            if (typeof value !== "string") return false;
            try { normalizeServerUrl(value); return true; }
            catch { return "Enter an HTTPS API URL without credentials, query parameters, or a fragment."; }
        }
    },
    session: {
        type: OptionType.COMPONENT,
        component: SessionSettings
    },
    autoConnect: {
        type: OptionType.BOOLEAN,
        description: "Reuse your Maple session on startup",
        default: true
    },
    refreshInterval: {
        type: OptionType.SLIDER,
        description: "Initial connection retry delay (seconds; backs off to 30 seconds)",
        markers: [1, 2, 3, 5, 10, 15],
        default: 5,
        restartNeeded: true
    },
    staleTimeout: {
        type: OptionType.SLIDER,
        description: "Clear playback after this many minutes without a Maple playback update. Legacy Maple only updates on track changes.",
        markers: [1, 3, 5, 10, 15, 30],
        default: 10,
        onChange: () => { void updatePresence(); }
    },
    enableTimestamps: {
        type: OptionType.BOOLEAN,
        description: "Show timestamps when Maple supplies an actual playback position",
        default: true,
        onChange: () => { void updatePresence(); }
    },
    enableButtons: {
        type: OptionType.BOOLEAN,
        description: "Show Listen on Maple and a valid additional link",
        default: true,
        onChange: () => { void updatePresence(); }
    }
});

async function updatePresence(): Promise<void> {
    const revision = ++renderRevision;
    const playback = currentPlayback;
    clearTimeout(expiryTimer);
    clearTimeout(artworkRetryTimer);
    clearTimeout(artworkFallbackTimer);
    if (!running || !playback) return;
    const staleMs = Math.max(1, Math.min(30, settings.store.staleTimeout || 10)) * 60000;
    const expiresAt = playbackExpiry(playback, staleMs);
    if (Date.now() >= expiresAt) {
        clearPlayback();
        setStatus("Connected. Playback expired; waiting for a fresh update.");
        return;
    }
    // Arm expiry before artwork fetching, which can be slow or fail.
    expiryTimer = setTimeout(() => {
        if (currentPlayback === playback) {
            clearPlayback();
            setStatus("Connected. Playback expired; waiting for a fresh update.");
        }
    }, expiresAt - Date.now());
    const activity: Activity = {
        application_id: applicationId,
        name: "Maple",
        type: 2,
        // Show the song title from details in Discord's member list.
        status_display_type: 2,
        flags: 1,
        details: playback.title,
        state: playback.artist,
        timestamps: settings.store.enableTimestamps ? playbackTimestamps(playback) : undefined
    };
    if (settings.store.enableButtons) {
        const buttons = [{ label: "Listen on Maple", url: MAPLE_URL }, ...playback.buttons];
        activity.buttons = buttons.map(button => button.label);
        activity.metadata = { button_urls: buttons.map(button => button.url) };
    }
    const track = JSON.stringify([settings.store.serverUrl, playback.id, playback.title, playback.artist, playback.album, playback.artworkRequestId]);
    const deadline = Date.now() + playback.artworkWait * 1000;
    artworkDeadline = artworkTrack === track ? Math.min(artworkDeadline, deadline) : deadline;
    artworkTrack = track;
    const key = track;
    if (artwork?.key !== key) {
        setActivity(null);
        artwork = {
            key,
            url: playback.id
                ? `${normalizeServerUrl(settings.store.serverUrl)}/public/get/albumArt/${encodeURIComponent(playback.id)}`
                : ""
        };
    }
    const cover = artwork;
    const isCurrent = () => running && revision === renderRevision && currentPlayback === playback && Date.now() < expiresAt;
    const showArtwork = (asset: string) => {
        clearTimeout(artworkFallbackTimer);
        activity.assets = { large_image: asset, large_text: playback.album || playback.title };
        setActivity(activity);
        setStatus("Connected. Receiving playback.");
    };
    // Progress/settings updates must reuse a resolved cover before considering fallback.
    if (cover.assetId) {
        showArtwork(cover.assetId);
        return;
    }
    const showFallback = () => {
        if (!isCurrent() || cover.assetId) return;
        setActivity(activity);
        setStatus("Connected. Artwork unavailable; showing playback.");
        defaultArtwork ??= Promise.resolve().then(() => ApplicationAssetUtils.fetchAssetIds(applicationId, ["maple"]))
            .then(ids => ids[0] as string | undefined).catch(() => undefined);
        void defaultArtwork.then(asset => {
            if (!asset || !isCurrent() || cover.assetId) return;
            activity.assets = { large_image: asset, large_text: playback.album || playback.title };
            setActivity(activity);
        });
    };
    if (Date.now() >= artworkDeadline) showFallback();
    else artworkFallbackTimer = setTimeout(showFallback, artworkDeadline - Date.now());
    // Updated clients explicitly wait for upload completion; legacy clients omit this flag.
    if (!playback.id || playback.artworkReady === false) return;
    // Keep the legacy random path segment and retry without caching failed lookups.
    const imageUrl = `${cover.url}/${crypto.randomUUID()}`;
    cover.asset ??= Promise.resolve().then(() => ApplicationAssetUtils.fetchAssetIds(applicationId, [imageUrl]))
        .then(ids => ids[0] as string | undefined)
        .catch(() => undefined)
        .then(asset => {
            if (asset) cover.assetId = asset;
            else cover.asset = undefined;
            return asset;
        });
    const asset = await cover.asset;
    if (!isCurrent()) return;
    if (!asset) {
        if (Date.now() >= artworkDeadline) showFallback();
        else setStatus("Connected. Waiting for album artwork.");
        artworkRetryTimer = setTimeout(() => { void updatePresence(); }, 5000);
        return;
    }
    showArtwork(asset);
}

export default definePlugin({
    name: "MapleRPC",
    description: "Displays your Maple playback as a Discord listening activity.",
    authors: [{ name: "Cattn", id: 523927057722376204n }],
    settings,
    start() {
        // Remove the old plaintext password from live settings, including future exports/syncs.
        delete Settings.plugins.MapleRPC.password;
        running = true;
        if (settings.store.autoConnect) void connect().catch(() => {});
    },
    stop() {
        running = false;
        disconnect();
    }
});
