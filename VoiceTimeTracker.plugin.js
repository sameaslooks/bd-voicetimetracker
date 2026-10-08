/**
 * @name VoiceTimeTracker
 * @author sameaslooks
 * @authorLink https://github.com/sameaslooks
 * @version 1.0.0
 * @description Tracks and displays how long each user has been sitting in a voice channel.
 * @source https://github.com/sameaslooks/bd-voicetimetracker
 * @website https://github.com/sameaslooks
 */

module.exports = class VoiceTimeTracker {
    constructor(meta) {
        this.meta = meta;

        // userId -> { userId, channelId, guildId, since, active }
        this.sessions = new Map();
        // userId -> username cache (avoids hammering UserStore)
        this.nameCache = new Map();
        // userId -> injected badge element
        this.badgeNodes = new Map();
        // usernameEl -> original inline style string (for cleanup on stop)
        this.modifiedStyles = new Map();

        this.refreshTimer = null;
        this.reconcileTimer = null;
        this.sweepTimer = null;
        this._injectDebounce = null;
        this._reseedDebounce = null;

        this.settingsContainer = null;
        this.lastSettingsRender = 0;

        // Tunables
        this.REFRESH_VISIBLE_MS = 5_000;
        this.REFRESH_HIDDEN_MS  = 30_000;
        this.SETTINGS_REFRESH_MS = 5_000;
        this.RECONCILE_MS = 60_000;
        this.SWEEP_MS = 10 * 60_000;
    }

    // =====================================================================
    // Lifecycle
    // =====================================================================

    start() {
        BdApi.Logger.info(this.meta.name, "Starting...");

        this.hookDispatcher();
        this.seedExistingSessions();

        this.scheduleRefresh();

        this.reconcileTimer = setInterval(() => {
            try { this.reconcileWithStore(); } catch (e) {}
        }, this.RECONCILE_MS);

        this.sweepTimer = setInterval(() => {
            try { this.sweepAllGuilds(); } catch (e) {}
        }, this.SWEEP_MS);

        this.visibilityHandler = () => this.scheduleRefresh();
        document.addEventListener("visibilitychange", this.visibilityHandler);

        BdApi.Logger.info(this.meta.name, "Started.");
    }

    stop() {
        BdApi.Logger.info(this.meta.name, "Stopping...");

        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.reconcileTimer) clearInterval(this.reconcileTimer);
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        if (this._injectDebounce) clearTimeout(this._injectDebounce);
        if (this._reseedDebounce) clearTimeout(this._reseedDebounce);

        this.refreshTimer = null;
        this.reconcileTimer = null;
        this.sweepTimer = null;
        this._injectDebounce = null;
        this._reseedDebounce = null;

        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
        }

        // Revert any inline styles we set on Discord elements.
        this.restoreModifiedStyles();

        // Unpatch all Patcher hooks (dispatch hook included).
        try { BdApi.Patcher.unpatchAll(this.meta.name); } catch (e) {}

        // Remove injected badges.
        for (const node of this.badgeNodes.values()) {
            try { node.remove(); } catch (e) {}
        }
        this.badgeNodes.clear();
        document.querySelectorAll("[data-voice-timer]").forEach(el => el.remove());

        this.sessions.clear();
        this.nameCache.clear();
        this.modifiedStyles.clear();
    }

    // =====================================================================
    // Dispatcher — hook via BdApi.Patcher (official API).
    //
    // NOTE: We read `store._dispatcher` because BD has no public API for
    // subscribing to Discord's Flux events. This is the standard approach
    // used across the BD plugin ecosystem; the alternative (Webpack
    // getByKeys) does not expose the dispatcher in current Discord builds.
    // =====================================================================

    getDispatcher() {
        try {
            const store = BdApi.Webpack.getStore("VoiceStateStore");
            return store?._dispatcher ?? null;
        } catch {
            return null;
        }
    }

    hookDispatcher() {
        const d = this.getDispatcher();
        if (!d || typeof d.dispatch !== "function") {
            BdApi.Logger.error(this.meta.name, "Dispatcher not found.");
            return;
        }

        const self = this;

        // Use BdApi.Patcher.after to observe dispatch calls without
        // reassigning the method ourselves (guidelines-safe).
        BdApi.Patcher.after(this.meta.name, d, "dispatch", (_, args) => {
            const action = args?.[0];
            try {
                if (action?.type === "VOICE_STATE_UPDATES") {
                    const states = action.voiceStates ?? [];
                    for (const vs of states) {
                        try { self.handleVoiceState(vs); } catch (e) {}
                    }
                    if (self._injectDebounce) clearTimeout(self._injectDebounce);
                    self._injectDebounce = setTimeout(() => {
                        try { self.injectBadges(); } catch (e) {}
                    }, 250);
                } else if (action?.type === "VOICE_CHANNEL_SELECT") {
                    const me = BdApi.Webpack.getStore("UserStore")?.getCurrentUser?.();
                    if (me) {
                        self.handleVoiceState({
                            userId: me.id,
                            channelId: action.channelId ?? null,
                            guildId: action.guildId ?? null
                        });
                    }
                } else if (
                    action?.type === "GUILD_SELECT" ||
                    action?.type === "CHANNEL_SELECT" ||
                    action?.type === "GUILD_CREATE"
                ) {
                    if (self._reseedDebounce) clearTimeout(self._reseedDebounce);
                    self._reseedDebounce = setTimeout(() => {
                        try {
                            self.seedExistingSessions();
                            self.reconcileWithStore();
                            self.injectBadges();
                        } catch (e) {}
                    }, 500);
                }
            } catch (e) {
                BdApi.Logger.error(self.meta.name, "dispatch hook error:", e);
            }
        });

        BdApi.Logger.info(this.meta.name, "Dispatcher hooked.");
    }

    // =====================================================================
    // Store access helpers
    // =====================================================================

    getSelectedGuildId() {
        try {
            return BdApi.Webpack.getStore("SelectedGuildStore")?.getGuildId?.() ?? null;
        } catch {
            return null;
        }
    }

    collectFromStore({ guildId = null } = {}) {
        const out = [];
        try {
            const store = BdApi.Webpack.getStore("VoiceStateStore");
            if (!store) return out;

            if (guildId) {
                const states = store.getVoiceStates?.(guildId) ?? {};
                for (const userId in states) {
                    const vs = states[userId];
                    if (vs?.channelId) {
                        out.push({ userId, channelId: vs.channelId, guildId });
                    }
                }
                return out;
            }

            const trackedGuilds = new Set();
            const current = this.getSelectedGuildId();
            if (current) trackedGuilds.add(current);

            for (const s of this.sessions.values()) {
                if (s.guildId) trackedGuilds.add(s.guildId);
            }

            for (const gId of trackedGuilds) {
                const states = store.getVoiceStates?.(gId) ?? {};
                for (const userId in states) {
                    const vs = states[userId];
                    if (vs?.channelId) {
                        out.push({ userId, channelId: vs.channelId, guildId: gId });
                    }
                }
            }
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "collectFromStore failed:", e);
        }
        return out;
    }

    seedExistingSessions() {
        const guildId = this.getSelectedGuildId();
        if (!guildId) return;

        const collected = this.collectFromStore({ guildId });
        BdApi.Logger.info(
            this.meta.name,
            `Seeded ${collected.length} sessions from current guild.`
        );
        for (const vs of collected) {
            try { this.handleVoiceState(vs); } catch (e) {}
        }
    }

    reconcileWithStore() {
        const present = new Map();
        for (const vs of this.collectFromStore()) {
            present.set(vs.userId, vs);
        }

        for (const [userId, session] of this.sessions) {
            if (!session.active) continue;
            const vs = present.get(userId);
            const stillInVoice = vs && vs.channelId === session.channelId;
            if (!stillInVoice) {
                this.sessions.delete(userId);
                this.nameCache.delete(userId);

                const node = this.badgeNodes.get(userId);
                if (node) {
                    try { node.remove(); } catch (e) {}
                    this.badgeNodes.delete(userId);
                }
            }
        }

        for (const vs of present.values()) {
            if (!this.sessions.has(vs.userId)) {
                this.handleVoiceState(vs);
            }
        }
    }

    sweepAllGuilds() {
        try {
            const guilds = BdApi.Webpack.getStore("GuildStore")?.getGuilds?.() ?? {};
            const store = BdApi.Webpack.getStore("VoiceStateStore");
            if (!store) return;

            for (const guildId of Object.keys(guilds)) {
                const states = store.getVoiceStates?.(guildId) ?? {};
                for (const userId in states) {
                    const vs = states[userId];
                    if (vs?.channelId && !this.sessions.has(userId)) {
                        this.handleVoiceState({
                            userId,
                            channelId: vs.channelId,
                            guildId
                        });
                    }
                }
            }
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "sweepAllGuilds failed:", e);
        }
    }

    // =====================================================================
    // Session tracking — full reset on leave
    // =====================================================================

    handleVoiceState(vs) {
        const { userId, channelId, guildId } = vs;
        if (!userId) return;

        const existing = this.sessions.get(userId);

        // Left voice — full reset.
        if (!channelId) {
            if (existing) {
                this.sessions.delete(userId);
                this.nameCache.delete(userId);

                const node = this.badgeNodes.get(userId);
                if (node) {
                    try { node.remove(); } catch (e) {}
                    this.badgeNodes.delete(userId);
                }
            }
            return;
        }

        // Moved channel.
        if (existing && existing.channelId !== channelId) {
            existing.channelId = channelId;
            existing.guildId = guildId ?? existing.guildId;
            // Reset timer for new channel.
            existing.since = Date.now();
            return;
        }

        // New session.
        if (!existing) {
            this.sessions.set(userId, {
                userId,
                channelId,
                guildId: guildId ?? null,
                since: Date.now(),
                active: true
            });
        }
    }

    getCurrentTime(userId) {
        const s = this.sessions.get(userId);
        if (!s || !s.active || !s.since) return null;
        return Date.now() - s.since;
    }

    // =====================================================================
    // Adaptive refresh
    // =====================================================================

    scheduleRefresh() {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        const hidden = document.visibilityState === "hidden";
        const delay = hidden ? this.REFRESH_HIDDEN_MS : this.REFRESH_VISIBLE_MS;

        this.refreshTimer = setTimeout(() => {
            try { this.refreshVisibleTimers(); } catch (e) {}
            this.scheduleRefresh();
        }, delay);
    }

    refreshVisibleTimers() {
        document.querySelectorAll("[data-voice-timer]").forEach(el => {
            const userId = el.getAttribute("data-voice-timer");
            const t = this.getCurrentTime(userId);
            if (t != null) el.textContent = this.formatDuration(t);
        });

        try { this.injectBadges(); } catch (e) {}

        if (this.settingsContainer && this.settingsContainer.isConnected) {
            const now = Date.now();
            if (now - this.lastSettingsRender > this.SETTINGS_REFRESH_MS) {
                this.lastSettingsRender = now;
                try { this.renderSettings(this.settingsContainer); } catch (e) {}
            }
        }
    }

    // =====================================================================
    // DOM injection
    // =====================================================================

    injectBadges() {
        if (this.sessions.size === 0) return;

        const rows = document.querySelectorAll("[class*='voiceUser']");
        if (rows.length === 0) return;

        for (const row of rows) {
            if (row.querySelector("[data-voice-timer]")) continue;

            const avatarEl = row.querySelector("[class*='userAvatar']");
            if (!avatarEl) continue;

            const bg = avatarEl.style?.backgroundImage || "";
            const match = bg.match(/\/avatars\/(\d+)\//);
            if (!match) continue;

            const userId = match[1];
            const time = this.getCurrentTime(userId);
            if (time == null) continue;

            const badge = document.createElement("span");
            badge.setAttribute("data-voice-timer", userId);
            badge.textContent = this.formatDuration(time);
            badge.style.cssText = [
                "display:inline-block",
                "margin-left:6px",
                "font-size:11px",
                "line-height:1",
                "opacity:0.7",
                "color:var(--text-muted)",
                "font-variant-numeric:tabular-nums",
                "pointer-events:none",
                "white-space:nowrap"
            ].join(";") + ";";

            const usernameEl = row.querySelector("[class*='username__']");
            if (!usernameEl) continue;

            // Save original inline style so we can restore on stop().
            if (!this.modifiedStyles.has(usernameEl)) {
                this.modifiedStyles.set(usernameEl, usernameEl.style.cssText);
            }

            // Make the username inline-flex so the badge flows next to the
            // name without wrapping. This is reverted in restoreModifiedStyles().
            usernameEl.style.display = "inline-flex";
            usernameEl.style.alignItems = "center";
            usernameEl.style.gap = "4px";

            usernameEl.appendChild(badge);
            this.badgeNodes.set(userId, badge);
        }
    }

    restoreModifiedStyles() {
        for (const [el, css] of this.modifiedStyles) {
            try {
                if (css) el.style.cssText = css;
                else el.removeAttribute("style");
            } catch (e) {}
        }
        this.modifiedStyles.clear();
    }

    // =====================================================================
    // Formatting / helpers
    // =====================================================================

    formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) {
            return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
        return `${m}:${String(s).padStart(2, "0")}`;
    }

    getUserName(userId) {
        const cached = this.nameCache.get(userId);
        if (cached) return cached;

        let name;
        try {
            const user = BdApi.Webpack.getStore("UserStore")?.getUser?.(userId);
            name = user?.username ?? user?.globalName ?? userId.slice(-6);
        } catch {
            name = userId.slice(-6);
        }
        this.nameCache.set(userId, name);
        return name;
    }

    // =====================================================================
    // Settings panel
    // =====================================================================

    getSettingsPanel() {
        const container = document.createElement("div");
        container.style.cssText = "padding:16px;color:var(--text-normal)";
        this.settingsContainer = container;
        this.lastSettingsRender = 0;
        this.renderSettings(container);
        return container;
    }

    renderSettings(container) {
        const entries = Array.from(this.sessions.values())
            .sort((a, b) => this.getCurrentTime(b.userId) - this.getCurrentTime(a.userId));

        const rows = entries.map((s, i) => {
            const name = this.getUserName(s.userId);
            const time = this.formatDuration(this.getCurrentTime(s.userId) ?? 0);
            return `<tr>
                <td style="padding:4px 8px">${i + 1}</td>
                <td style="padding:4px 8px">${name}</td>
                <td style="padding:4px 8px;font-variant-numeric:tabular-nums">${time}</td>
            </tr>`;
        }).join("");

        const authorName = this.meta.author ?? "unknown";
        const authorUrl  = this.meta.authorLink ?? this.meta.website ?? null;
        const authorHtml = authorUrl
            ? `by <a href="${authorUrl}" target="_blank" rel="noopener noreferrer"
                    style="color:var(--text-link);text-decoration:none"
                    onmouseover="this.style.textDecoration='underline'"
                    onmouseout="this.style.textDecoration='none'"
                 >${authorName}</a>`
            : `by ${authorName}`;

        container.innerHTML = `
            <h2 style="margin:0 0 4px 0">Voice Time Tracker</h2>
            <p style="opacity:.7;margin:0 0 4px 0;font-size:13px">
                ${authorHtml}
                <span style="opacity:.5"> · v${this.meta.version ?? "?"}</span>
            </p>
            <p style="opacity:.7;margin:0 0 12px 0;font-size:13px">
                Total tracked sessions: ${entries.length}
            </p>
            <table style="width:100%;text-align:left;border-collapse:collapse">
                <thead>
                    <tr style="opacity:.6;border-bottom:1px solid var(--background-modifier-accent)">
                        <th style="padding:4px 8px">#</th>
                        <th style="padding:4px 8px">User</th>
                        <th style="padding:4px 8px">Time</th>
                    </tr>
                </thead>
                <tbody>${rows || `<tr><td colspan="3" style="padding:8px;opacity:.5">No data yet.</td></tr>`}</tbody>
            </table>
        `;
    }
};