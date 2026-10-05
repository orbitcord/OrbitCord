# Frost installer artwork

`electron-builder.cjs` uses these assets for the macOS DMG and Windows NSIS installer. Both use pale-blue frosted artwork with a cropped orbital ring. The macOS app and Applications folder are real Finder items; only the arrow, background, and footer are baked into the background. The macOS headings are intentionally omitted. Both standard and Retina backgrounds are included.

Windows uses the standard NSIS MUI2 wizard geometry throughout welcome, license, install location, progress, finish, and uninstall. Every page uses the same window size with native DPI scaling. The pale-blue sidebar and header contain the app icon; text, navigation buttons, progress, and the finish page's Open OrbitCord checkbox are native controls. `frost.nsh` supplies branding and copy only: it must not resize the wizard or introduce custom GDI painters. The install engine owns elevation, silent updates, shortcuts, launch-as-user behavior, and uninstall behavior.

Run `pnpm installer:artwork` to regenerate the artwork from `scripts/installer-artwork.mjs` using the existing app icon. The generated files are checked in so packaging requires no artwork renderer. Playwright's Chromium is needed only when regenerating them.

To regenerate only Windows artwork, run `node scripts/installer-artwork.mjs --win`. The full-page Windows BMP/PNG files are retained as design previews; the installer uses only the header and sidebar BMPs.

Build both installers on macOS with `pnpm build:installers`, or use `pnpm build:mac` and `pnpm build:win` individually. Files are written to `dist/`.
