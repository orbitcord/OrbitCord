# Publishing a release

GitHub Actions builds a universal Mac DMG and Windows installer and creates a draft GitHub Release. OrbitCord checks GitHub for a newer published version and offers to open that release page. The app does not replace its own files; users download and install the new package themselves. This manual handoff works with notarized Mac releases without requiring the Mac app to install updates itself.

1. Update `version` in `package.json` (for example, `0.1.0` to `0.1.1`) and commit the change.
2. Create and push a matching version tag, such as `v0.1.1`.
3. Wait for **Build and publish release** under the **Actions** tab. It creates a draft release with Windows and Linux installers.
4. Replace the workflow's ad-hoc Mac DMG with the signed and notarized universal Mac DMG, then publish the release. The app only checks published releases, so users will not see the update popup while the draft is being reviewed.

The tag must match the version in `package.json`. The current build config creates an ad-hoc Mac signature; do not publish that DMG as a notarized release. Use the notarized replacement instead.
