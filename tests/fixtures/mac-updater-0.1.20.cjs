// Frozen asset selector from release 0.1.20 (8ca2390).
const repository = 'https://github.com/orbitcord/OrbitCord';
function macAsset(release, arch) {
    const assets = release.assets || [];
    const asset = assets.find(asset => asset.name === `OrbitCord-${release.tag_name.replace(/^v/, '')}-mac-universal.dmg`)
        || assets.find(asset => asset.name === `OrbitCord-${release.tag_name.replace(/^v/, '')}-mac-${arch}.dmg`);
    if (!asset || asset.browser_download_url !== `${repository}/releases/download/${release.tag_name}/${asset.name}`
        || !Number.isSafeInteger(asset.size) || asset.size <= 0)
        throw new Error('This release does not include a compatible Mac installer.');
    return asset;
}
module.exports = { macAsset };
