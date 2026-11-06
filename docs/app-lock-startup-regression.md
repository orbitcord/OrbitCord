# App Lock startup regression — 0.1.32, 2026-11-06

0.1.31 called App Lock synchronously from its document-start preload when a saved
passcode and enabled lock were present. Chromium can run that preload before
creating document.documentElement. Appending the lock to null threw and aborted
privacy initialization and every later feature, including settings and composer
controls. The running installed app showed that exact preload error; boot, themes
and the core had loaded, but privacy/extensions/settings had not. Fifteen saved
OrbitCord preference entries remained accessible through the retained Storage
object. Profile paths were unchanged. No profile or stored preference was cleared.

Lock mounting now observes document child insertion until the root exists. The
observer mounts the opaque lock before rendering, while the rest of initialization
continues. Body inertness and keyboard trapping remain; disabling/unlocking also
cleans up a pending root observer. Existing passcodes are retained.

Verification: a deterministic root-absence regression failed before the change
and passes after it, including correct-passcode unlock, inert body protection and
saved extension/privacy preferences. All 23 privacy cases pass. Three real Electron
checks against the minified release preload pass, including saved App Lock with
headers delivered before HTML, settings access, preserved preferences and no preload
errors. The native/preload release build and all 25 privacy-core/updater checks pass.
The release workflow now includes the native saved-App-Lock regression.

Risks: the fix preserves the existing local UI-lock design; it does not change
passcode storage or profile migration. Affected users may need the fixed installer
or native update prompt because the broken preload cannot display its settings UI.
