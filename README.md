# VoiceTimeTracker

A BetterDiscord plugin that shows how long each user has been sitting in a voice channel — right next to their name in the sidebar.

Discord only shows voice duration for some users, and often not at all. VoiceTimeTracker fills that gap: it reads the voice state events Discord already streams to your client and renders a live timer next to everyone sitting in voice, on any server you're a member of.

![preview](docs/preview.png)

## Features

- Live timer next to every voice user in the channel sidebar.
- Real-time updates: reacts to joins, leaves and channel moves within ~250 ms.
- Works across all your servers, no need to open a server to start tracking.
- Zero API requests. No polling, no fetch, no WebSocket. Everything is read from Discord's own in-memory stores.
- Native look: the timer uses Discord's own text colors and styling.
- Settings panel with a full leaderboard of tracked sessions and totals.

## Installation

### Manual

1. Install [BetterDiscord](https://betterdiscord.app/) if you haven't already.
2. Download the latest `VoiceTimeTracker.plugin.js` from the [releases page](../../releases).
3. Drop the file into your BetterDiscord plugins folder:
   - Windows: `%AppData%\BetterDiscord\plugins`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins`
   - Linux: `~/.config/BetterDiscord/plugins`
4. Restart Discord or press `Ctrl+R`.
5. Enable VoiceTimeTracker in Settings → Plugins.

## How it works

Discord's client already receives every voice state change through its own gateway connection. That data lands in an internal store called `VoiceStateStore`. VoiceTimeTracker listens to the same event stream Discord uses and stores a timestamp when it first sees a user in a voice channel. The timer is just `Date.now() - since`, formatted and rendered.

No network requests are made. No polling. No Discord API calls. The plugin is a pure reader: it observes what Discord already knows.

## Preview

    # General
       alice       12:34
       bob          3:21
       charlie    1:05:47

## Settings

Open Settings → Plugins → VoiceTimeTracker (gear icon) to see a full table of every tracked session: user, status (active/left), and accumulated time. The table updates live while it's open.

## Limitations

- Discord does not send voice states for servers you have never opened. If the client has no cached state for a guild, there is nothing for the plugin to read. This is Discord client behavior, not a plugin bug. Servers you visit regularly will always be tracked.
- Discord occasionally shuffles its internal class names. The plugin uses stable substrings (like `voiceUser`, `userAvatar`, `username`) so it survives most updates, but a major redesign might require a patch.
- The timer starts from the moment the plugin first sees the user in voice. If a user was already sitting in a channel when you launched Discord, their timer begins when Discord loads the state.

## Troubleshooting

**Timers do not appear at all**

- Check the console (`Ctrl+Shift+I` → Console) for `[VoiceTimeTracker]` logs.
- Make sure the plugin is enabled and shows no error under Settings → Plugins.
- Reload Discord (`Ctrl+R`).

**Timers appear on some servers but not others**

That is expected: Discord only caches voice states for servers it has loaded. Open the server once and timers will appear for it.

**Timers stop updating**

Discord throttles background activity. When the Discord window is hidden, the plugin refreshes every 30 seconds instead of every 5. Bring the window back into focus and it should resume.

## License

MIT. See [LICENSE](LICENSE).

## Support

- Found a bug? [Open an issue](../../issues).
- Want to contribute? Pull requests are welcome.

---

Made by [sameaslooks](https://github.com/sameaslooks).