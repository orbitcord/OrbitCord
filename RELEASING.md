# Publishing a release

Change `version` in `package.json` to a new three-part stable version, commit, and push to `main`. **Build and publish release** automatically tests and builds the universal macOS DMG and Windows x64 installer, validates their names and Windows update checksums, creates the matching `vX.Y.Z` tag, and publishes the GitHub Release after both builds pass. Installer names and build versions come from `package.json`.

Pushing a matching `vX.Y.Z` tag also starts the workflow. The tag must match `package.json`. A manual workflow run can retry a failed release; an already published version is skipped. An ordinary source change without a version bump does not publish a new app. Check the Actions result after pushing; failed builds leave the previous stable release available.

The stable release includes the Mac DMG, Windows setup EXE, Windows blockmap, and `latest.yml`. The manifest points to that exact installer and contains its SHA-512 checksum. Files are uploaded to a draft before it becomes the latest stable release, so update checks never select a release with incomplete assets. Keep previous releases available; older installed versions check the latest stable release directly and can skip intermediate versions.

Windows automatically checks after startup and daily, downloads in the background, and installs when the user restarts or quits. macOS checks on the same schedule, downloads the DMG after confirmation, and opens it for the user to replace the app in Applications. Both platforms have **OrbitCord Settings → Check for updates** with manual check, download progress, retry, and installation actions. macOS builds are ad hoc signed; installing silently through Apple's signed updater is not configured.

## Legacy 0.1.5.1 installations

Those installers displayed `0.1.5.1` but stored `0.1.5-1` as the app version. Windows selected numeric prerelease channel `1`. Each release also publishes a `vX.Y.Z-1` compatibility prerelease with `1.yml` and the same stable Windows installer. It lets those old clients discover and install the stable version; the updated app explicitly uses the stable channel thereafter. The compatibility prerelease is never marked latest.

The macOS 0.1.5.1 updater rejected its own version before contacting GitHub. It requires one manual upgrade from the stable release page. This cannot be repaired remotely in the already installed code. Other older Mac versions with working checks show the stable release, and 0.1.7 and later support the settings download flow.

Use stable semantic versions such as `0.1.7` and `0.1.8`. Do not put a fourth revision or a prerelease suffix in `package.json` for a stable release. The `-1` suffix is only for the compatibility release's tag, not the app version.
