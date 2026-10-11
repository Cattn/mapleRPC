/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAPLE_URL = "https://play.maple.music/";

export interface Playback {
    title: string;
    artist?: string;
    album?: string;
    id?: string;
    artworkId?: string;
    artworkWait: number;
    position?: number;
    duration?: number;
    playbackRate: number;
    receivedAt: number;
    buttons: { label: string; url: string; }[];
}

function text(value: unknown, limit = 128): string | undefined {
    if (typeof value !== "string") return;
    return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit) || undefined;
}

function seconds(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400 ? value : undefined;
}

export function safeButtonUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > 2048) return;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) return;
        // Upgrade Maple's legacy profile links to its official web app.
        if (["maple.kolf.pro", "maple.music"].includes(url.hostname)) return new URL(url.pathname + url.search + url.hash, MAPLE_URL).href;
        return url.href;
    } catch { return; }
}

export function parsePlayback(value: unknown, now = Date.now()): Playback | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.playing === false || data.paused === true || data.state === "paused" || data.state === "stopped" || data.state === "ended") return null;
    const title = text(data.title);
    if (!title) return null;
    // Maple returns this content hash only after storing the client's cover.
    const position = seconds(data.position);
    const duration = seconds(data.duration);
    if (duration !== undefined && (duration === 0 || (position !== undefined && position >= duration))) return null;
    const buttons: Playback["buttons"] = [];
    if (Array.isArray(data.buttons)) {
        for (const item of data.buttons.slice(0, 10)) {
            if (!item || typeof item !== "object") continue;
            const label = text(item.label, 32);
            const url = safeButtonUrl(item.url);
            if (label && url && url !== MAPLE_URL && label !== "Listen on Maple") {
                buttons.push({ label, url });
                break;
            }
        }
    }
    return {
        title,
        artist: text(data.artist),
        album: text(data.album),
        id: typeof data.id === "string" && /^[\w-]{1,256}$/.test(data.id) ? data.id : undefined,
        artworkId: typeof data.artworkId === "string" && /^[a-f0-9]{64}$/.test(data.artworkId) ? data.artworkId : undefined,
        artworkWait: typeof data.artworkWait === "number" && Number.isFinite(data.artworkWait) ? Math.max(0, Math.min(30, data.artworkWait)) : 30,
        position,
        duration,
        playbackRate: typeof data.playbackRate === "number" && Number.isFinite(data.playbackRate) && data.playbackRate > 0 && data.playbackRate <= 16 ? data.playbackRate : 1,
        receivedAt: now,
        buttons
    };
}

export function playbackExpiry(playback: Playback, staleMs: number): number {
    const staleAt = playback.receivedAt + staleMs;
    if (playback.position === undefined || playback.duration === undefined) return staleAt;
    return Math.min(staleAt, playback.receivedAt + (playback.duration - playback.position) / playback.playbackRate * 1000);
}

export function playbackTimestamps(playback: Playback): { start: number; end?: number; } | undefined {
    // Legacy Maple doesn't send a playback position. Receipt time is not song start time.
    if (playback.position === undefined) return;
    const start = playback.receivedAt - playback.position / playback.playbackRate * 1000;
    return {
        start: Math.round(start),
        end: playback.duration === undefined ? undefined : Math.round(start + playback.duration / playback.playbackRate * 1000)
    };
}
