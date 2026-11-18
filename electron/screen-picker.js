// Runs in the sandboxed picker window. Everything it sends goes through
// window.screenPicker (screen-picker-preload.cjs) to electron/screen-picker.cjs.
const list = document.getElementById('sources'), status = document.getElementById('status');
const share = document.getElementById('share'), sound = document.getElementById('sound'), soundRow = document.getElementById('sound-row');
const tabs = [...document.querySelectorAll('[role="tab"]')];
let sources = [], kind = 'screen', selected = null;

function render() {
    const shown = sources.filter(source => source.kind === kind);
    if (!shown.some(source => source.id === selected)) selected = shown[0]?.id ?? null;
    list.setAttribute('aria-labelledby', `tab-${kind}`);
    list.replaceChildren(...shown.map(source => {
        const item = document.createElement('li');
        item.setAttribute('role', 'option'); item.tabIndex = source.id === selected ? 0 : -1;
        item.setAttribute('aria-selected', String(source.id === selected));
        item.dataset.id = source.id;
        const thumb = document.createElement('div'); thumb.className = 'thumb';
        if (source.thumbnail) { const image = document.createElement('img'); image.src = source.thumbnail; image.alt = ''; thumb.append(image); }
        const name = document.createElement('div'); name.className = 'name';
        if (source.icon) { const icon = document.createElement('img'); icon.src = source.icon; icon.alt = ''; name.append(icon); }
        const label = document.createElement('span'); label.textContent = source.name; label.title = source.name; name.append(label);
        item.append(thumb, name);
        item.addEventListener('click', () => { selected = source.id; render(); list.querySelector('[aria-selected="true"]')?.focus(); });
        item.addEventListener('dblclick', () => { selected = source.id; choose(); });
        return item;
    }));
    status.textContent = shown.length ? '' : kind === 'screen' ? 'No screens found.' : 'No windows to share.';
    share.disabled = !selected;
    for (const tab of tabs) { tab.setAttribute('aria-selected', String(tab.dataset.kind === kind)); tab.tabIndex = tab.dataset.kind === kind ? 0 : -1; }
}
async function load() {
    try {
        const result = await window.screenPicker.run('sources');
        sources = result.sources;
        soundRow.hidden = !result.audio;
        sound.checked = result.shareSound;
        render();
    } catch {
        status.textContent = 'Couldn\'t list screens. Check that OrbitCord may record your screen in your system settings.';
    }
}
function choose() { if (selected) window.screenPicker.run('choose', { id: selected, audio: !soundRow.hidden && sound.checked }); }
for (const tab of tabs) tab.addEventListener('click', () => { kind = tab.dataset.kind; render(); });
document.querySelector('.tabs').addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); kind = kind === 'screen' ? 'window' : 'screen'; render();
    tabs.find(tab => tab.dataset.kind === kind).focus();
});
list.addEventListener('keydown', event => {
    const items = [...list.children], index = items.findIndex(item => item.dataset.id === selected);
    if (event.key === 'Enter') { event.preventDefault(); choose(); return; }
    const columns = Math.max(1, Math.round(list.clientWidth / (items[0]?.offsetWidth || 1)));
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (!step || index < 0) return;
    event.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, index + step))];
    selected = next.dataset.id; render(); list.querySelector('[aria-selected="true"]')?.focus();
});
share.addEventListener('click', choose);
document.getElementById('cancel').addEventListener('click', () => window.screenPicker.run('cancel'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.screenPicker.run('cancel'); });
load();
