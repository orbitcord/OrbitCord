// Spellcheck uses Chromium's own checker: the OS checker on macOS and
// Windows, Hunspell dictionaries Chromium fetches on Linux. Each account has
// its own session, so each window applies its account's choice to its session.

// macOS checks with the system's languages; Chromium ignores a language list there.
const choosesLanguage = platform => platform !== 'darwin';

// 'auto' follows the system's preferred languages, as far as dictionaries exist.
function autoLanguages(available, preferred) {
    const pick = [];
    for (const tag of preferred) {
        const exact = available.find(code => code.toLowerCase() === tag.toLowerCase());
        const base = exact ?? available.find(code => code.split('-')[0].toLowerCase() === tag.split('-')[0].toLowerCase());
        if (base && !pick.includes(base)) pick.push(base);
        if (pick.length === 2) break;
    }
    if (!pick.length) pick.push(available.includes('en-US') ? 'en-US' : available[0]);
    return pick.filter(Boolean);
}

function applySpellcheck(ses, settings, { platform = process.platform, preferred = [] } = {}) {
    if (!settings || typeof settings.enabled !== 'boolean' || typeof settings.language !== 'string') throw new Error('Invalid spellcheck settings');
    const available = choosesLanguage(platform) ? ses.availableSpellCheckerLanguages : [];
    if (settings.language !== 'auto' && !available.includes(settings.language)) throw new Error('Unknown spellcheck language');
    ses.setSpellCheckerEnabled(settings.enabled);
    if (settings.enabled && available.length) {
        ses.setSpellCheckerLanguages(settings.language === 'auto' ? autoLanguages(available, preferred) : [settings.language]);
    }
    return { enabled: ses.isSpellCheckerEnabled(), language: settings.language, languages: available,
        active: available.length ? ses.getSpellCheckerLanguages() : [] };
}

module.exports = { applySpellcheck, autoLanguages };
