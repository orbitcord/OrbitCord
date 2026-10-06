# OrbitCord

OrbitCord is a Discord desktop client for macOS and Windows. It keeps Discord's chat interface and adds controls for message appearance, music playback, and social link previews.

- Set chat bubble colors, avatars, and message position.
- Reply with Shift + Up and record voice messages in chat.
- Remove tracking parameters from links and reduce background analytics requests.
- Block YouTube embed ads with a bundled AdGuard script. Set the volume for YouTube, Spotify, and Apple Music players.
- Preview Spotify and Apple Music links while composing, then play them in chat.
- Turn supported social links into post cards with text and carousel media.
- Paste a Reddit video link by itself to attach the video with sound.

The embed extensions are on by default. **Photos and carousels as files** starts off; enable it under **OrbitCord Settings → Extensions** to send social image posts as attachments. Embed volume starts at 50%. OrbitCord uses Discord's own players when available and avoids adding a second player. Code blocks and suppressed embeds are left alone.

## Install

Download the installer from [GitHub Releases](https://github.com/orbitcord/OrbitCord/releases).

### macOS

Open the DMG and drag OrbitCord to Applications. The app is ad hoc signed and not notarized, so macOS will show a security warning. Only open an installer downloaded from this repository's Releases page.

Control-click OrbitCord in Applications, choose **Open**, then confirm **Open**. If macOS still blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway**.

### Windows

Run the setup EXE and follow the installer. If SmartScreen warns you, choose **More info**, then **Run anyway**. OrbitCord downloads updates in the background and asks you to restart to install them.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
