# OrbitCord

OrbitCord is a lean Discord desktop client built for quick startup and lower resource use. It keeps the core chat experience and adds a few tools without the usual extra client features.

- Customize chat bubbles, avatars, and message position.
- Reply quickly with Shift + Up and record voice messages in chat.
- Clean tracking links and reduce background analytics requests.
- Block YouTube embed ads with AdGuard and control YouTube / Spotify / Apple Music embed volume.
- Preview Spotify and Apple Music links in the composer and play them inline in chat.
- Automatically fix pasted X, Instagram, Bluesky, Reddit, TikTok, Twitch, Tumblr, Facebook, Threads and pixiv post links, with checked provider fallbacks.
- Show social posts as consistent cards with every image and video of a carousel or gallery.
- Paste a Reddit video link to attach the video itself, with sound, instead of the link.

The embed plugins are enabled by default under **OrbitCord Settings → Extensions**.
Embed volume defaults to 50%, including YouTube. Spotify and Apple Music links
show official players in the composer and get a local player in chat when Discord
does not create one. Native players are preferred, duplicate players are avoided,
and code blocks / suppressed embeds are respected. Social embeds offer automatic selection or
a fixed provider for each site. Auto mode checks public post metadata with
[FxTwitter](https://github.com/FxEmbed/FxEmbed) / [VxTwitter](https://github.com/dylanpdx/BetterTwitFix)
and [vxInstagram](https://github.com/Lainmode/InstagramEmbed-vxinstagram) / [eeInstagram](https://eeinstagram.com/),
with a short timeout and a bounded cache. If both services fail, the original
service link is sent. Other platforms use [FxBluesky / VixBluesky](https://github.com/Lexedia/VixBluesky),
[vxReddit](https://github.com/dylanpdx/vxReddit) / [FixReddit](https://github.com/MinnDevelopment/fxreddit),
[fxTikTok](https://github.com/okdargy/fxtiktok) / [TikTxk](https://github.com/Britmoji/tiktxk),
[fxtwitch](https://github.com/seriaati/fxtwitch), [fxtumblr](https://github.com/knuxify/fxtumblr),
[facebed](https://facebed.com), fixthreads and [phixiv](https://github.com/thelaao/phixiv).

**Social post cards** replace Discord's preview for supported links in OrbitCord with
one card style for every platform: author, text, stats and a carousel of every image
and video (all Instagram carousel items, Reddit galleries, multi-image posts and
pixiv pages). Sensitive and spoiler media is covered until clicked, except in NSFW
channels. Post data comes from public APIs (FxTwitter, Bluesky, Reddit, pixiv) or
the fix providers' metadata; media is proxied by the main process, so remote hosts
never see Discord. If a post can't be loaded, Discord's own embed stays.

**Reddit videos as files**: pasting a Reddit video link on its own downloads the best
quality that fits your upload limit, joins Reddit's separate video and audio streams
locally (no re-encoding, no third-party service) and attaches the MP4 to the message
box. Text posts, galleries and oversized videos insert the link instead.

Code blocks, suppressed embeds and explicitly chosen fix
URLs are preserved. Private/deleted posts, service outages and platform changes
can still prevent previews. AdGuard's script is bundled locally; no remote code
is downloaded at startup.

## Install

Download the installer from [GitHub Releases](https://github.com/orbitcord/OrbitCord/releases).

### macOS

Open the DMG and drag OrbitCord to Applications. The package is ad hoc signed and not notarized, so macOS will show a security warning. Only open it if you downloaded it from this repository's Releases page.

To open it, Control-click OrbitCord in Applications, choose **Open**, then confirm **Open**. If macOS still blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway**.

### Windows

Run the setup EXE and follow the installer. If SmartScreen warns you, choose **More info**, then **Run anyway**. OrbitCord checks for updates, downloads them in the background, and asks you to restart to install.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
