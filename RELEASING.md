# Publishing a release

GitHub Actions builds a universal Mac DMG and Windows installer and creates a draft GitHub Release. On Windows, OrbitCord checks for published releases, downloads updates in the background, and installs them when the user restarts or quits the app. macOS continues to use a manual download and install so notarized builds can be supplied separately.

1. Update `version` in `package.json` (for example, `0.1.0` to `0.1.1`) and commit the change.
2. Create and push a matching version tag, such as `v0.1.1`.
3. Wait for **Build and publish release** under the **Actions** tab. It creates a draft release with a Mac DMG and Windows installer. The Windows job also uploads `latest.yml` and the blockmap needed by the updater.
4. Replace the workflow's ad-hoc Mac DMG with the signed and notarized universal Mac DMG, then publish the release. The app only checks published releases, so users will not see the update popup while the draft is being reviewed.

The tag must match the version in `package.json`. The Windows update manifest and installer must be published together. The current Mac build is ad hoc signed; replace it with a notarized DMG before publishing if a notarized build is available.
