module.exports = {
    appId: 'dev.lowcord.app', productName: 'OrbitCord', asar: true,
    directories: { output: 'dist' },
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    files: ['electron/**', '.lowcord/preload.cjs', 'src-tauri/icons/32x32.png', 'src-tauri/icons/128x128.png', 'src-tauri/icons/icon.png', 'src-tauri/icons/trayTemplate.png', 'package.json', 'LICENSE'],
    extraResources: [{ from: '.lowcord/native-${os}-${arch}', to: 'native', filter: ['lowcord-native', 'lowcord-native.exe'] }],
    beforePack: async context => {
        const { Arch } = require('electron-builder');
        const { join } = require('node:path');
        const { validateNative } = require('./scripts/native-target.cjs');
        const platform = context.electronPlatformName;
        const arch = Arch[context.arch];
        const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
        await validateNative(join(context.packager.projectDir, '.lowcord', `native-${os}-${arch}`,
            `lowcord-native${platform === 'win32' ? '.exe' : ''}`), platform, arch);
    },
    mac: { category: 'public.app-category.social-networking', icon: 'src-tauri/icons/icon.icns',
        target: ['dmg', 'zip'], identity: '-', hardenedRuntime: false,
        entitlements: 'src-tauri/Entitlements.plist', entitlementsInherit: 'src-tauri/Entitlements.plist',
        binaries: ['Contents/Resources/native/lowcord-native'],
        extendInfo: { NSMicrophoneUsageDescription: 'OrbitCord uses your microphone for calls and voice messages.',
            NSCameraUsageDescription: 'OrbitCord uses your camera for video calls.' } },
    win: { icon: 'src-tauri/icons/icon.ico', target: ['nsis'], signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true, createStartMenuShortcut: true, license: 'LICENSE',
        artifactName: '${productName}-${version}-windows-${arch}-Setup.${ext}' },
    linux: { icon: 'src-tauri/icons', category: 'Network', target: ['AppImage'] },
};
