module.exports = {
    appId: 'dev.lowcord.app', productName: 'OrbitCord', asar: true,
    directories: { output: 'dist' },
    buildVersion: '0.1.5.2', artifactName: '${productName}-0.1.5.2-${os}-${arch}.${ext}',
    files: ['electron/**', '.lowcord/preload.cjs', 'src-tauri/icons/32x32.png', 'src-tauri/icons/128x128.png', 'src-tauri/icons/icon.png', 'src-tauri/icons/trayTemplate.png', 'src-tauri/icons/app/*.png', 'package.json', 'LICENSE'],
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
    win: { icon: 'src-tauri/icons/icon.ico', target: ['nsis'], signExecutable: false,
        publish: [{ provider: 'github', owner: 'orbitcord', repo: 'OrbitCord' }] },
    dmg: { title: '${productName}', background: 'build/installers/mac-background.png',
        window: { width: 640, height: 360 }, iconSize: 112, iconTextSize: 14,
        contents: [{ x: 170, y: 146, type: 'file' },
            { x: 470, y: 146, type: 'link', path: '/Applications' }] },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true, createStartMenuShortcut: true, license: 'LICENSE',
        include: 'build/installers/frost.nsh',
        installerHeader: 'build/installers/windows-header.bmp',
        installerSidebar: 'build/installers/windows-sidebar.bmp',
        uninstallerSidebar: 'build/installers/windows-sidebar.bmp',
        artifactName: '${productName}-0.1.5.2-windows-${arch}-Setup.${ext}' },
    linux: { icon: 'src-tauri/icons', category: 'Network', target: ['AppImage'] },
};
