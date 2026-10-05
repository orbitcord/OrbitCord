These tiny fixtures are generated locally, contain a black frame and a sine wave,
and do not contain downloaded or user media. The playback tests mute them.

`sample.png` is a generated 32×24 RGB gradient used to verify full-resolution image copying and byte-preserving downloads.

```sh
ffmpeg -f lavfi -i color=c=black:s=160x90:r=15 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 2 -c:v libx264 -pix_fmt yuv420p -profile:v baseline -c:a aac -b:a 32k -movflags +faststart sample.mp4
ffmpeg -i sample.mp4 -vn -c:a copy -movflags +faststart sample.m4a
ffmpeg -i sample.mp4 -c:v libvpx-vp9 -b:v 20k -c:a libopus -b:a 24k sample.webm
```

`dash-video.mp4` and `dash-audio.mp4` are fragmented, single-track copies of the
samples above, laid out like Reddit's separate DASH video and audio streams:

```sh
ffmpeg -i sample.mp4 -an -c:v copy -movflags +frag_keyframe+empty_moov+default_base_moof+dash -frag_duration 500000 dash-video.mp4
ffmpeg -i sample.m4a -vn -c:a copy -movflags +frag_keyframe+empty_moov+default_base_moof+dash -frag_duration 500000 dash-audio.mp4
```
