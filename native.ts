/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { io } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

export interface MapleRPCData {
    state?: string;
    details?: string;
    startTimestamp?: number;
    endTimestamp?: number;
    buttons?: Array<{
        label: string;
        url: string;
    }>;
    songName?: string;
    image?: string;
    artistName?: string;
    id?: string;
    albumName?: string;
}

let socket: ReturnType<typeof io> | null = null;
let currentData: MapleRPCData | null = null;

export async function login(serverUrl: string, username: string, password: string): Promise<boolean> {
    try {
        console.log("[MapleRPC] Attempting to login...");
        const response = await fetch(`${serverUrl}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username,
                password
            }),
            credentials: "include"
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || "Login failed");
        }

        const data = await response.json();
        console.log("[MapleRPC] Login result:", data.status);
        return data.status === "Success";
    } catch (err) {
        console.error("[MapleRPC] Login failed:", err);
        return false;
    }
}

export function connectSocket(serverUrl: string): void {
    if (socket) {
        console.log("[MapleRPC] Disconnecting existing socket...");
        socket.disconnect();
    }

    console.log("[MapleRPC] Attempting to connect to socket at:", serverUrl);

    socket = io(serverUrl, {
        withCredentials: true
    });

    socket.on("connect", () => {
        console.log("[MapleRPC] Connected to Maple server");
    });

    socket.on("disconnect", reason => {
        console.log("[MapleRPC] Disconnected from Maple server:", reason);
        currentData = null;
    });

    socket.on("connect_error", error => {
        console.error("[MapleRPC] Connection error:", error);
    });

    socket.on("rpcUpdate", (data: any) => {
        console.log("[MapleRPC] Received RPC update:", data);
        const newData: MapleRPCData = {
            state: data.artist,
            startTimestamp: Date.now(),
            songName: data.title,
            artistName: data.artist,
            id: data.id,
            albumName: data.album,
            buttons: [],
            image: "https://api.maple.music/public/get/albumArt/" + data.id + "/" + uuidv4()
        };
        console.log("[MapleRPC] Received RPC update:", JSON.stringify(newData, null, 2));

        currentData = newData;
    });
}

export function disconnectSocket(): void {
    if (socket) {
        console.log("[MapleRPC] Disconnecting socket...");
        socket.disconnect();
        socket = null;
        currentData = null;
    }
}

export function emitRPCUpdate(data: MapleRPCData): void {
    console.log("[MapleRPC] Emitting RPC update:", data);
    if (socket) {
        socket.emit("rpcUpdate", data);
    } else {
        console.warn("[MapleRPC] Socket not connected, cannot emit RPC update");
    }
}

export async function fetchData(): Promise<MapleRPCData | null> {
    return currentData;
}
