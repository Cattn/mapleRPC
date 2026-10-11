/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The default namespace, JSON events, and Engine.IO v4 HTTP polling are all Maple needs.
// Keep this in the renderer: Vencord treats native.ts as an Electron main-process module.
const MAX_RESPONSE_LENGTH = 256 * 1024;

export function normalizeServerUrl(value: string): string {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("Use an HTTPS Maple API URL without credentials, a query, or a fragment.");
    }
    return url.href.replace(/\/+$/, "");
}

export async function request(url: string, init: RequestInit, signal: AbortSignal, timeoutMs = 15000): Promise<string> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, timeoutMs);
    try {
        const response = await fetch(url, {
            ...init,
            credentials: "include",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Maple request failed (HTTP ${response.status}).`);
        // Limit streamed bodies too, rather than checking only after response.text().
        if (!response.body) throw new Error("Empty Maple response.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let body = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_RESPONSE_LENGTH) {
                    controller.abort();
                    throw new Error("Maple response is too large.");
                }
                body += decoder.decode(value, { stream: true });
            }
            return body + decoder.decode();
        } finally {
            reader.releaseLock();
        }
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
    }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
    });
}

class AuthenticationError extends Error { }

interface Callbacks {
    onUpdate(data: unknown): void;
    onDisconnect(): void;
    onStatus(status: string): void;
}

export class MapleConnection {
    private controller = new AbortController();

    constructor(private serverUrl: string, private callbacks: Callbacks, private retryMs = 5000) {
        this.serverUrl = normalizeServerUrl(serverUrl);
        this.retryMs = Math.max(1000, Math.min(30000, retryMs || 5000));
    }

    start(): void {
        void this.run();
    }

    stop(): void {
        this.controller.abort();
    }

    private async run(): Promise<void> {
        const { signal } = this.controller;
        let failures = 0;
        while (!signal.aborted) {
            this.callbacks.onStatus("Connecting to Maple…");
            try {
                await this.session(() => { failures = 0; });
            } catch (error) {
                if (signal.aborted) return;
                this.callbacks.onDisconnect();
                if (error instanceof AuthenticationError) {
                    this.callbacks.onStatus("Maple session expired or rejected. Sign in below.");
                    return;
                }
                this.callbacks.onStatus("Maple connection lost. Retrying…");
            }
            await delay(Math.min(30000, this.retryMs * 2 ** Math.min(failures++, 5)), signal);
        }
    }

    private async session(onConnect: () => void): Promise<void> {
        const { signal } = this.controller;
        const endpoint = new URL(`${this.serverUrl}/socket.io/`);
        endpoint.searchParams.set("EIO", "4");
        endpoint.searchParams.set("transport", "polling");
        const pollUrl = () => {
            endpoint.searchParams.set("t", crypto.randomUUID());
            return endpoint.href;
        };
        const opening = await request(pollUrl(), {}, signal);
        if (signal.aborted) return;
        if (!opening.startsWith("0")) throw new Error("Invalid Engine.IO handshake.");
        const handshake = JSON.parse(opening.slice(1));
        const { sid, pingInterval, pingTimeout } = handshake ?? {};
        if (typeof sid !== "string" || !/^[\w-]{1,256}$/.test(sid)
            || !Number.isFinite(pingInterval) || pingInterval <= 0 || pingInterval > 120000
            || !Number.isFinite(pingTimeout) || pingTimeout <= 0 || pingTimeout > 120000) {
            throw new Error("Invalid Engine.IO handshake.");
        }
        endpoint.searchParams.set("sid", sid);
        const send = async (packet: string) => {
            const response = await request(pollUrl(), {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
                body: packet
            }, signal, Math.min(15000, pingTimeout));
            if (response !== "ok") throw new Error("Invalid Engine.IO acknowledgement.");
        };
        // Socket.IO CONNECT packet, wrapped in an Engine.IO MESSAGE packet.
        await send("40");
        let connected = false;
        let heartbeatDeadline = Date.now() + pingInterval + pingTimeout;
        const connectDeadline = Date.now() + 15000;
        while (!signal.aborted) {
            const remaining = Math.min(heartbeatDeadline, connected ? Infinity : connectDeadline) - Date.now();
            if (remaining <= 0) throw new Error("Maple heartbeat timed out.");
            const body = await request(pollUrl(), {}, signal, remaining);
            if (signal.aborted) return;
            for (const packet of body.split("\x1e")) {
                if (signal.aborted) return;
                if (packet === "2") {
                    heartbeatDeadline = Date.now() + pingInterval + pingTimeout;
                    await send("3");
                } else if (packet === "1" || packet === "41") {
                    throw new Error("Maple closed the connection.");
                } else if (packet.startsWith("44")) {
                    // Do not log server error payloads or retry invalid cookies forever.
                    throw new AuthenticationError();
                } else if (packet.startsWith("40")) {
                    if (connected) throw new Error("Duplicate Socket.IO connection.");
                    const namespace = JSON.parse(packet.slice(2));
                    if (typeof namespace?.sid !== "string") throw new Error("Invalid Socket.IO connection.");
                    connected = true;
                    onConnect();
                    this.callbacks.onStatus("Connected. Waiting for Maple playback…");
                } else if (packet.startsWith("42")) {
                    const match = /^42(?:\d+)?(\[.*\])$/s.exec(packet);
                    if (!connected || !match) throw new Error("Invalid Socket.IO event.");
                    const event: unknown = JSON.parse(match[1]);
                    if (!Array.isArray(event) || typeof event[0] !== "string") throw new Error("Invalid Socket.IO event.");
                    if (event[0] === "rpcUpdate") this.callbacks.onUpdate(event[1]);
                } else if (packet !== "6" && !packet.startsWith("4")) {
                    throw new Error("Unsupported Engine.IO packet.");
                }
            }
        }
    }
}
