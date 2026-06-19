/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
// Import ApplicationAssetUtils
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

import { connectSocket, disconnectSocket, fetchData, login } from "./native";

// Define the ActivityAssets interface (good practice)
interface ActivityAssets {
    large_image?: string; // Discord Asset ID
    large_text?: string;
    small_image?: string; // Discord Asset ID
    small_text?: string;
}

interface Activity {
    state?: string;
    details?: string;
    timestamps?: {
        start?: number;
        end?: number;
    };
    assets?: ActivityAssets; // Use the interface
    buttons?: Array<string>;
    name: string; // This is the object of the action (e.g., "Maple" or song name)
    application_id: string;
    metadata?: {
        button_urls?: Array<string>;
    };
    type: number; // This determines the action verb ("Playing", "Listening to", etc.)
    flags: number;
}

// Interface for expected data from fetchData (adjust if needed)
interface MapleData {
    albumName: string | undefined;
    songName?: string;
    artistName?: string;
    details?: string;
    image?: string; // Expecting a URL here
    startTimestamp?: number;
    endTimestamp?: number;
    buttons?: Array<{ label: string; url: string }>;
}


const enum ActivityType {
    PLAYING = 0,
    LISTENING = 2, // We will use this value directly
}

const enum ActivityFlag {
    INSTANCE = 1 << 0,
}

// Use YOUR MapleRPC application ID
const applicationId = "1360456499263963156";
const MAPLE_URL = "https://maple.music/";

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: "MapleRPC",
    });
}

// --- Helper function to get Discord Asset ID from a URL ---
async function getDiscordAssetIdFromUrl(imageUrl: string | undefined): Promise<string | undefined> {
    if (!imageUrl) return undefined;
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(applicationId, [imageUrl]);
        return ids[0];
    } catch (error) {
        console.error("[MapleRPC] Failed to fetch asset ID for image:", imageUrl, error);
        return undefined;
    }
}
// --- End Helper Function ---


const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "Maple Server URL",
        default: "https://api.maple.music",
        restartNeeded: true
    },
    username: {
        type: OptionType.STRING,
        description: "Maple Username",
        default: "",
        restartNeeded: true,
        required: true
    },
    password: {
        type: OptionType.STRING,
        description: "Maple Password",
        default: "",
        restartNeeded: true,
        required: true,
    },
    autoConnect: {
        type: OptionType.BOOLEAN,
        description: "Automatically connect on startup",
        default: true
    },
    refreshInterval: {
        type: OptionType.SLIDER,
        description: "The interval between attempting to re-connect to Maple (seconds)",
        markers: [1, 2, 2.5, 3, 5, 10, 15],
        default: 5,
        restartNeeded: true,
    },
    enableTimestamps: {
        type: OptionType.BOOLEAN,
        description: "Whether or not to enable timestamps",
        default: true,
    },
    enableButtons: {
        type: OptionType.BOOLEAN,
        description: "Whether or not to enable buttons",
        default: true,
    }
});

export default definePlugin({
    name: "MapleRPC",
    description: "Adds discord RPC support for Maple",
    authors: [{ name: "Cattn", id: 523927057722376204n }],

    settings,

    async start() {
        console.log("[MapleRPC] Starting plugin...");
        if (settings.store.autoConnect) {
            console.log("[MapleRPC] Auto-connect enabled, attempting login...");
            try {
                const success = await login(
                    settings.store.serverUrl,
                    settings.store.username,
                    settings.store.password
                );

                if (success) {
                    console.log("[MapleRPC] Login successful, connecting socket...");
                    connectSocket(settings.store.serverUrl);
                    this.updatePresence(); // Initial update
                    this.updateInterval = setInterval(() => { this.updatePresence(); }, settings.store.refreshInterval * 1000);
                } else {
                    console.error("[MapleRPC] Failed to login - check credentials and server URL in settings.");
                }
            } catch (error) {
                console.error("[MapleRPC] Error during login/connection:", error);
            }
        } else {
             console.log("[MapleRPC] Auto-connect disabled.");
        }
    },

    stop() {
        clearInterval(this.updateInterval);
        disconnectSocket();
        setActivity(null); // Clear activity on stop
        console.log("[MapleRPC] Plugin stopped.");
    },

    updatePresence() {
        try {
            this.getActivity().then(activity => {
                 setActivity(activity);
            }).catch(error => {
                console.error("[MapleRPC] Error updating presence:", error);
                setActivity(null); // Clear activity on error
            });
        } catch(error) {
             console.error("[MapleRPC] Synchronous error in updatePresence:", error);
             setActivity(null);
        }
    },

    async getActivity(): Promise<Activity | null> {
        const data: MapleData | null = await fetchData();
        if (!data) {
            console.log("[MapleRPC] No data received from fetchData.");
            return null; // No data, no activity
        }

        const largeImageAssetId = await getDiscordAssetIdFromUrl(data.image);
        const largeImageText = data.albumName || data.songName || "Maple";

        // Basic activity structure
        const activity: Activity = {
            application_id: applicationId,
            name: "Maple", // Object of the action
            type: ActivityType.LISTENING,// Verb ("Listening to")
            flags: ActivityFlag.INSTANCE,
            state: data.artistName,// Typically artist or status
            details: data.songName,// Typically song title or details
            // Initialize optional fields that might be added later
            assets: undefined,
            timestamps: undefined,
            buttons: undefined,
            metadata: undefined,
        };

        // Assign Assets
        if (largeImageAssetId) {
             activity.assets = {
                large_image: largeImageAssetId,
                large_text: largeImageText,
            };
        } else {
             console.log("[MapleRPC] No large image asset ID could be obtained for:", data.image);
             // Optionally add a default Maple asset if you have one uploaded
             // activity.assets = { large_image: "your_default_maple_asset_id", large_text: "Maple" };
        }

        // Add Timestamps
        if (settings.store.enableTimestamps) {
            if (data.startTimestamp && data.endTimestamp && data.startTimestamp < data.endTimestamp) {
                activity.timestamps = {
                    start: data.startTimestamp,
                    end: data.endTimestamp
                };
            } else if (data.startTimestamp) {
                 activity.timestamps = { start: data.startTimestamp };
            }
        }

        // --- CORRECTED BUTTON LOGIC ---
        if (settings.store.enableButtons) {
            const finalButtons: { label: string; url: string }[] = [];

            // 1. Always add the primary "Listen on Maple" button first
            finalButtons.push({ label: "Listen on Maple", url: MAPLE_URL });

            // 2. Add the first valid button from server data, if available and space permits
            if (data.buttons?.length && finalButtons.length < 2) {
                // Find the first button object that has both a label and a URL
                const firstServerButton = data.buttons.find(b => b && typeof b.label === "string" && b.label.trim() !== "" && typeof b.url === "string" && b.url.trim() !== "");

                if (firstServerButton) {
                    // Push the valid button found
                    finalButtons.push({ label: firstServerButton.label, url: firstServerButton.url });
                    // Log if more buttons were available but skipped due to the limit
                    if (data.buttons.length > 1) {
                         console.warn("[MapleRPC] Received multiple buttons from server, but only used the first valid one due to the 2-button limit.");
                    }
                } else if (data.buttons.length > 0) {
                     // Log if button data was received but none were valid
                     console.warn("[MapleRPC] Received button data from server, but found no valid {label, url} pairs:", data.buttons);
                }
            }

            // 3. If we successfully prepared at least one button, assign them
            if (finalButtons.length > 0) {
                // Map the labels and URLs to the required Discord structure
                activity.buttons = finalButtons.map(b => b.label); // Array of strings (labels)
                activity.metadata = {
                    button_urls: finalButtons.map(b => b.url) // Array of strings (URLs)
                };
            }
        }
        // --- END CORRECTED BUTTON LOGIC ---

        // Log the final activity object before sending (for debugging)
        // console.log("[MapleRPC] Final Activity:", JSON.stringify(activity, null, 2));

        return activity;
    }
});
