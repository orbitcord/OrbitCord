# OrbitCord

OrbitCord is a Discord desktop client for macOS and Windows. It keeps Discord's chat interface and adds controls for message appearance, music playback, and social link previews.

- Set chat bubble colors, avatars, and message position.
- Reply with Shift + Up and record voice messages in chat.
- Remove tracking parameters from links and reduce background analytics requests.
- Block YouTube embed ads with a bundled AdGuard script. Set the volume for YouTube, Spotify, and Apple Music players.
- Preview Spotify and Apple Music links while composing, then play them in chat.
- Turn supported social links into post cards with text and carousel media.
- Paste a Reddit video link by itself to attach the video with sound.

The embed extensions are on by default. Find them under **OrbitCord Settings → Extensions**. Embed volume starts at 50%. OrbitCord uses Discord's own players when available and avoids adding a second player. Code blocks and suppressed embeds are left alone.

## Social links

OrbitCord can replace Discord's link preview with a card for posts on X, Instagram, Bluesky, Reddit, TikTok, Twitch, Tumblr, Facebook, Threads, and Pixiv. Cards can show the author, post text, stats, and the images or videos in a carousel, gallery, or multi-image post. Sensitive media stays covered until clicked, except in NSFW channels. If a post can't be loaded, Discord's preview remains.

For X and Instagram, automatic mode checks public post metadata through [FxTwitter](https://github.com/FxEmbed/FxEmbed), [VxTwitter](https://github.com/dylanpdx/BetterTwitFix), [vxInstagram](https://github.com/Lainmode/InstagramEmbed-vxinstagram), and [eeInstagram](https://eeinstagram.com/). Other supported services use providers including [VixBluesky](https://github.com/Lexedia/VixBluesky), [vxReddit](https://github.com/dylanpdx/vxReddit), [FixReddit](https://github.com/MinnDevelopment/fxreddit), [fxTikTok](https://github.com/okdargy/fxtiktok), [TikTxk](https://github.com/Britmoji/tiktxk), [fxtwitch](https://github.com/seriaati/fxtwitch), [fxtumblr](https://github.com/knuxify/fxtumblr), [facebed](https://facebed.com), fixthreads, and [phixiv](https://github.com/thelaao/phixiv). You can use automatic provider selection or choose one for each site. If providers time out or fail, OrbitCord sends the original link.

## Reddit video attachments

When you paste a Reddit video link by itself, OrbitCord downloads the best quality that fits your upload limit and joins Reddit's separate video and audio streams into an MP4 on your computer. It does not re-encode the video or send it to a third-party service. Text posts, galleries, and videos that exceed the upload limit stay as links.

OrbitCord bundles the AdGuard script locally and does not download code at startup. Private or deleted posts, provider outages, and changes to third-party services can prevent a preview from loading.

## Install

Download the installer from [GitHub Releases](https://github.com/orbitcord/OrbitCord/releases).

### macOS

Open the DMG and drag OrbitCord to Applications. The app is ad hoc signed and not notarized, so macOS will show a security warning. Only open an installer downloaded from this repository's Releases page.

Control-click OrbitCord in Applications, choose **Open**, then confirm **Open**. If macOS still blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway**.

### Windows

Run the setup EXE and follow the installer. If SmartScreen warns you, choose **More info**, then **Run anyway**. OrbitCord downloads updates in the background and asks you to restart to install them.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
