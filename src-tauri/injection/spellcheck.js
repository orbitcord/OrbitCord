(() => {
    const extensions = window.Lowcord?.extensions;
    if (!extensions) return;
    const native = window.__LOWCORD_NATIVE__;

    // ----- Spellcheck ----------------------------------------------------------
    // Chromium checks spelling per session; each account window applies its
    // own saved choice. The result lists the dictionaries the settings can offer.
    const spellcheck = window.Lowcord.spellcheck = { languages: [], active: [] };
    let applied = "";
    function sync() {
        if (!native?.spellcheck) return;
        const settings = { enabled: extensions.enabled("spellcheck"), language: extensions.options.spellcheckLanguage };
        const key = JSON.stringify(settings);
        if (key === applied) return;
        applied = key;
        native.spellcheck(settings).then(result => {
            const changed = JSON.stringify(result.languages) !== JSON.stringify(spellcheck.languages);
            Object.assign(spellcheck, { languages: result.languages, active: result.active });
            if (changed) window.dispatchEvent(new Event(extensions.changeEvent));
        }, error => {
            // A saved dictionary this system doesn't have falls back to the system's.
            if (settings.language !== "auto") { try { extensions.setOption("spellcheckLanguage", "auto"); } catch {} }
            else console.warn("[lowcord] Spellcheck:", error.message);
        });
    }
    window.addEventListener(extensions.changeEvent, sync);
    sync();

    // ----- Autocorrect -----------------------------------------------------------
    const contractions = ["dont:don't", "doesnt:doesn't", "didnt:didn't", "isnt:isn't", "wasnt:wasn't", "arent:aren't", "werent:weren't",
        "havent:haven't", "hasnt:hasn't", "hadnt:hadn't", "wouldnt:wouldn't", "couldnt:couldn't", "shouldnt:shouldn't", "thats:that's",
        "whats:what's", "theyre:they're", "youre:you're", "youve:you've", "theyve:they've", "wouldve:would've", "couldve:could've",
        "shouldve:should've", "im:I'm", "ive:I've", "i:I"];
    const typos = ["teh:the", "hte:the", "tyhe:the", "adn:and", "nad:and", "taht:that", "thta:that", "wiht:with", "waht:what", "wnat:want",
        "jsut:just", "knwo:know", "konw:know", "yuo:you", "yoru:your", "abotu:about", "agian:again", "becuase:because", "becasue:because",
        "beacuse:because", "recieve:receive", "recieved:received", "beleive:believe", "belive:believe", "wierd:weird", "definately:definitely",
        "definatly:definitely", "seperate:separate", "seperately:separately", "untill:until", "occured:occurred", "occurence:occurrence",
        "thier:their", "alot:a lot", "aswell:as well", "tommorow:tomorrow", "tomorow:tomorrow", "tommorrow:tomorrow", "goverment:government",
        "enviroment:environment", "wich:which", "whcih:which", "peopel:people", "poeple:people", "freind:friend", "freinds:friends",
        "realy:really", "probaly:probably", "acually:actually", "actualy:actually", "basicly:basically", "basicaly:basically",
        "begining:beginning", "calender:calendar", "comming:coming", "completly:completely", "concious:conscious", "embarass:embarrass",
        "existance:existence", "foward:forward", "happend:happened", "immediatly:immediately", "independant:independent",
        "knowlege:knowledge", "neccessary:necessary", "necesary:necessary", "noticable:noticeable", "occassion:occasion",
        "persistant:persistent", "posession:possession", "prefered:preferred", "publically:publicly", "recomend:recommend",
        "reccomend:recommend", "refered:referred", "relevent:relevant", "remeber:remember", "rember:remember", "sentance:sentence",
        "succesful:successful", "suprise:surprise", "truely:truly", "unfortunatly:unfortunately", "usualy:usually", "writting:writing",
        "acheive:achieve", "accomodate:accommodate", "adress:address", "arguement:argument", "beautifull:beautiful", "bussiness:business",
        "buisness:business", "diffrent:different", "differnt:different", "dissapoint:disappoint", "excercise:exercise", "familar:familiar",
        "finaly:finally", "fourty:forty", "grammer:grammar", "harrass:harass", "intresting:interesting", "interesing:interesting",
        "lenght:length", "momment:moment", "naturaly:naturally", "oppurtunity:opportunity", "particulary:particularly", "peice:piece",
        "posible:possible", "rythm:rhythm", "shoudl:should", "similiar:similar", "somthing:something", "soemthing:something",
        "speach:speech", "strenght:strength", "thnak:thank", "thnaks:thanks", "togther:together", "tounge:tongue", "yeild:yield"];
    const corrections = new Map([...contractions, ...typos].map(pair => pair.split(":")));
    // Words the user reverted with Backspace stay as typed until reload.
    const kept = new Set();
    const editorSelector = '[class*="channelTextArea_"] [contenteditable="true"][role="textbox"]';
    // Opening wrappers a word may follow, and punctuation it may end with.
    const tokenPattern = /(?:^|\s)[("'“‘*_~]*([A-Za-z]+(?:'[A-Za-z]+)?)([.,!?;)"'”’*_~]*)$/;

    function cased(original, fix) {
        if (original.length > 1 && original === original.toUpperCase()) return fix.toUpperCase();
        if (original[0] === original[0].toUpperCase()) return fix[0].toUpperCase() + fix.slice(1);
        return fix;
    }
    // Text from the start of root up to the caret.
    function textBefore(root, node, offset) {
        const range = document.createRange();
        range.setStart(root, 0); range.setEnd(node, offset);
        return range.toString().replace(/\uFEFF/g, "");
    }
    // Code fences and inline code are left as typed: an open ``` fence before
    // the caret, or an odd number of single backticks on the current line.
    function inCode(before, line) {
        if ((before.match(/```/g)?.length ?? 0) % 2) return true;
        return (line.replace(/```/g, "").match(/`/g)?.length ?? 0) % 2 === 1;
    }
    // Trusted input over the selection, so the editor handles it like typing.
    function insert(text) {
        if (native?.insertText) return native.insertText(text);
        return document.execCommand("insertText", false, text);
    }
    function select(node, start, end) {
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, end);
        const selection = getSelection();
        selection.removeAllRanges(); selection.addRange(range);
    }
    // The word before the caret, if it's a known typo outside code, links,
    // mentions and emoji shortcodes: what to select and what replaces it.
    function candidate(editor) {
        const selection = getSelection();
        if (!selection?.isCollapsed || !selection.focusNode || selection.focusNode.nodeType !== Node.TEXT_NODE) return null;
        const node = selection.focusNode, offset = selection.focusOffset;
        if (!editor.contains(node) || node.parentElement.closest('[contenteditable="false"]')) return null;
        const local = node.data.slice(0, offset);
        const match = tokenPattern.exec(local.replace(/\uFEFF/g, ""));
        if (!match) return null;
        const [, word, tail] = match;
        const fix = corrections.get(word.toLowerCase());
        if (!fix || kept.has(word.toLowerCase()) || !local.endsWith(word + tail)) return null;
        const block = node.parentElement.closest('[data-slate-node="element"]') ?? editor;
        if (inCode(textBefore(editor, node, offset), textBefore(block, node, offset).split("\n").at(-1))) return null;
        return { node, start: offset - word.length - tail.length, end: offset, word, original: word + tail, replacement: cased(word, fix) + tail };
    }
    let last = null; // The latest correction, until another key is pressed.
    // Space corrects before it's inserted: the word and the space go in as one
    // edit, so nothing typed afterwards can land in between.
    document.addEventListener("keydown", event => {
        if (event.key === "Shift") return;
        const previous = last;
        last = null;
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
        if (!extensions.enabled("autocorrect")) return;
        const editor = event.target instanceof Element ? event.target.closest(editorSelector) : null;
        if (!editor || editor.closest('[role="dialog"]')) return;
        if (event.key === " " && !event.shiftKey) {
            const found = candidate(editor);
            if (!found) return;
            event.preventDefault();
            select(found.node, found.start, found.end);
            if (insert(found.replacement + " ")) last = { editor, ...found };
            else { getSelection().collapseToEnd(); insert(" "); }
            return;
        }
        // Backspace right after a fix restores what was typed, minus the space,
        // and keeps that word as typed from then on.
        if (event.key !== "Backspace" || event.shiftKey || !previous || previous.editor !== editor) return;
        const selection = getSelection(), node = selection?.focusNode;
        if (!selection?.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return;
        const offset = selection.focusOffset, typed = node.data.slice(0, offset).replace(/\u00a0$/, " ");
        if (!typed.endsWith(previous.replacement + " ")) return;
        event.preventDefault();
        select(node, offset - previous.replacement.length - 1, offset);
        kept.add(previous.word.toLowerCase());
        insert(previous.original);
    }, true);

    extensions.autocorrect = { corrections, candidate };
})();
