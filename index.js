/*
 * Veyrin Speaker Cards v0.1.1
 * Visual speaker separation for a single SillyTavern assistant response.
 *
 * No extra LLM calls are made by this extension.
 * Portraits are stored locally in the browser via IndexedDB/localforage.
 */

const MODULE_NAME = 'veyrin-speaker-cards';
const PROMPT_KEY = 'veyrin_speaker_cards_format';
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;
const DEFAULT_DM_NAME = 'Veyrin DM';

const DEFAULT_SETTINGS = {
    enabled: true,
    injectFormatPrompt: true,
    targetCharacters: 'Veyrin DM, Veyrin',
    dmName: DEFAULT_DM_NAME,
    portraitMode: 'default', // default | cycle
    showPortraits: true,
};

const FORMAT_PROMPT = `
[VEYRiN SPEAKER CARD FORMAT — DISPLAY CONTROL]
Format the visible narrative response into speaker blocks using these exact markers:
[[SPK:Speaker Name]]
content for that speaker/focus
[[/SPK]]

Rules:
- Put neutral narration, mechanics, roll requests, transitions, and scene-setting under [[SPK:Veyrin DM]].
- When a named NPC is the active speaker or action focus, use that character's exact established name, e.g. [[SPK:Elena]], [[SPK:Valeria]], [[SPK:Seraphine Veyl]].
- A character block may contain that character's dialogue plus actions/reactions centered on that character.
- Change blocks whenever the active speaker/focus changes. A speaker may appear more than once in the same response.
- Do not create a Seth/player-character speaker block and do not invent Seth's voluntary dialogue, thoughts, decisions, or actions. Seth's input remains the player's message.
- Do not show or explain the marker syntax in-world. The markers are display-control codes only.
- Keep any mandatory machine-readable trailer required by another extension outside these speaker blocks.
- Every visible prose segment should be inside a speaker block.
`.trim();

let portraitStore;
let settingsPanelInstalled = false;
let portraitLibraryCache = null;

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

function getSettings() {
    const context = ctx();
    if (!context) return structuredClone(DEFAULT_SETTINGS);
    context.extensionSettings[MODULE_NAME] ??= {};
    const settings = context.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in settings)) settings[key] = value;
    }
    return settings;
}

function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}

function normalizeName(name) {
    return String(name ?? '')
        .trim()
        .toLocaleLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function currentCharacterName() {
    const context = ctx();
    if (!context || context.groupId) return '';
    const id = Number(context.characterId);
    return Number.isInteger(id) && context.characters?.[id]?.name
        ? context.characters[id].name
        : context.name2 || '';
}

function isTargetChat() {
    const settings = getSettings();
    if (!settings.enabled) return false;
    const active = normalizeName(currentCharacterName());
    if (!active) return false;
    const targets = String(settings.targetCharacters ?? '')
        .split(',')
        .map(normalizeName)
        .filter(Boolean);
    return targets.length === 0 || targets.includes(active);
}

function applyPromptInjection(type = 'normal') {
    const context = ctx();
    if (!context?.setExtensionPrompt) return;

    const settings = getSettings();
    const skipType = ['quiet', 'impersonate'].includes(String(type ?? '').toLowerCase());
    const shouldInject = settings.enabled && settings.injectFormatPrompt && isTargetChat() && !skipType;
    const prompt = shouldInject
        ? FORMAT_PROMPT.replaceAll('Veyrin DM', settings.dmName || DEFAULT_DM_NAME)
        : '';

    // IN_CHAT at depth 0 keeps the formatting instruction near the changing tail of the prompt.
    context.setExtensionPrompt(PROMPT_KEY, prompt, IN_CHAT, 0, false, SYSTEM_ROLE);
}

globalThis.veyrinSpeakerCardsGenerateInterceptor = async function (_chat, _contextSize, _abort, type) {
    applyPromptInjection(type);
};

function stripTrackerTrailer(text) {
    return String(text ?? '')
        .replace(/<!--SP_TRACKER_START-->[\s\S]*?<!--SP_TRACKER_END-->/gi, '')
        .replace(/<!--\s*SP_[\s\S]*?-->/gi, '');
}

function parseSpeakerBlocks(rawText) {
    const text = stripTrackerTrailer(rawText);
    const openRegex = /\[\[SPK:([^\]\r\n]{1,120})\]\]/gi;
    const matches = [...text.matchAll(openRegex)];
    if (!matches.length) return [];

    const blocks = [];
    const dmName = getSettings().dmName || DEFAULT_DM_NAME;

    const prefix = text.slice(0, matches[0].index).replace(/\[\[\/SPK\]\]/gi, '').trim();
    if (prefix) blocks.push({ speaker: dmName, content: prefix });

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const speaker = String(match[1] ?? '').trim() || dmName;
        const start = match.index + match[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        let content = text.slice(start, end);
        content = content.replace(/\[\[\/SPK\]\]/gi, '').trim();
        if (!content) continue;

        const previous = blocks.at(-1);
        if (previous && normalizeName(previous.speaker) === normalizeName(speaker)) {
            previous.content += `\n\n${content}`;
        } else {
            blocks.push({ speaker, content });
        }
    }

    return blocks;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

async function getPortraitLibrary() {
    if (portraitLibraryCache) return portraitLibraryCache;
    portraitLibraryCache = (await portraitStore?.getItem('library')) || {};
    return portraitLibraryCache;
}

async function savePortraitLibrary(library) {
    portraitLibraryCache = library;
    await portraitStore?.setItem('library', library);
}

function findPortraitEntry(library, speaker) {
    const exactKey = normalizeName(speaker);
    if (library[exactKey]) return library[exactKey];

    const first = exactKey.split(' ')[0];
    if (!first) return null;
    const candidates = Object.values(library).filter(entry => normalizeName(entry.displayName).split(' ')[0] === first);
    return candidates.length === 1 ? candidates[0] : null;
}

function choosePortrait(entry, messageId, blockIndex) {
    const images = Array.isArray(entry?.images) ? entry.images : [];
    if (!images.length) return null;

    const settings = getSettings();
    if (settings.portraitMode === 'cycle' && images.length > 1) {
        const index = hashString(`${messageId}:${blockIndex}:${entry.displayName}`) % images.length;
        return images[index];
    }

    const defaultId = entry.defaultImageId;
    return images.find(image => image.id === defaultId) || images[0];
}

function initialsFor(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return parts.slice(0, 2).map(x => x[0]?.toUpperCase()).join('');
}

function isDmSpeaker(speaker) {
    const normalized = normalizeName(speaker);
    const dm = normalizeName(getSettings().dmName || DEFAULT_DM_NAME);
    return normalized === dm || normalized === 'dm' || normalized === 'veyrin dm' || normalized === 'narrator';
}

function buildAvatar(speaker, portrait) {
    const wrap = document.createElement('div');
    wrap.className = 'vsc-avatar';

    if (portrait?.dataUrl && getSettings().showPortraits) {
        const img = document.createElement('img');
        img.src = portrait.dataUrl;
        img.alt = `${speaker} portrait`;
        img.loading = 'lazy';
        wrap.append(img);
    } else {
        const initials = document.createElement('span');
        initials.textContent = isDmSpeaker(speaker) ? 'DM' : initialsFor(speaker);
        wrap.append(initials);
    }

    return wrap;
}

async function renderMessage(messageId) {
    const context = ctx();
    const settings = getSettings();
    if (!context || !settings.enabled || !isTargetChat()) return;

    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return;
    const message = context.chat?.[id];
    if (!message || message.is_user || message.is_system) return;

    const blocks = parseSpeakerBlocks(message.mes);
    if (!blocks.length) return;

    const messageElement = document.querySelector(`#chat .mes[mesid="${id}"]`);
    const textElement = messageElement?.querySelector('.mes_text');
    if (!textElement) return;

    const library = await getPortraitLibrary();
    const fragment = document.createDocumentFragment();
    const root = document.createElement('div');
    root.className = 'vsc-block-list';

    blocks.forEach((block, blockIndex) => {
        const dm = isDmSpeaker(block.speaker);
        const entry = findPortraitEntry(library, block.speaker);
        const portrait = choosePortrait(entry, id, blockIndex);
        const accent = hashString(normalizeName(block.speaker)) % 360;

        const card = document.createElement('section');
        card.className = `vsc-card${dm ? ' vsc-card-dm' : ''}`;
        card.style.setProperty('--vsc-speaker-hue', String(accent));
        card.dataset.speaker = block.speaker;

        const header = document.createElement('header');
        header.className = 'vsc-card-header';
        header.append(buildAvatar(block.speaker, portrait));

        const name = document.createElement('div');
        name.className = 'vsc-speaker-name';
        name.textContent = block.speaker;
        header.append(name);

        const body = document.createElement('div');
        body.className = 'vsc-card-body';
        const formatted = context.messageFormatting
            ? context.messageFormatting(block.content, block.speaker, false, false, id)
            : block.content;
        body.innerHTML = formatted;

        card.append(header, body);
        root.append(card);
    });

    fragment.append(root);
    textElement.replaceChildren(fragment);
    textElement.dataset.vscRendered = 'true';
}

async function renderVisibleMessages() {
    if (!isTargetChat()) return;
    const nodes = [...document.querySelectorAll('#chat .mes[mesid]')];
    for (const node of nodes) {
        const id = Number(node.getAttribute('mesid'));
        if (Number.isInteger(id)) await renderMessage(id);
    }
}

function fileToOptimizedDataUrl(file, maxDimension = 768) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Could not decode image.'));
            img.onload = () => {
                const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
                const width = Math.max(1, Math.round(img.naturalWidth * scale));
                const height = Math.max(1, Math.round(img.naturalHeight * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const draw = canvas.getContext('2d', { alpha: false });
                draw.drawImage(img, 0, 0, width, height);
                let dataUrl;
                try {
                    dataUrl = canvas.toDataURL('image/webp', 0.9);
                } catch {
                    dataUrl = canvas.toDataURL('image/jpeg', 0.9);
                }
                resolve(dataUrl);
            };
            img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
}

async function addPortrait(characterName, file) {
    const displayName = String(characterName ?? '').trim();
    if (!displayName) throw new Error('Enter the character name first.');
    if (!file || !String(file.type).startsWith('image/')) throw new Error('Choose an image file.');

    const dataUrl = await fileToOptimizedDataUrl(file);
    const library = await getPortraitLibrary();
    const key = normalizeName(displayName);
    const entry = library[key] || { displayName, images: [], defaultImageId: null };
    entry.displayName = displayName;
    entry.images ??= [];
    const image = {
        id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        fileName: file.name,
        addedAt: Date.now(),
        dataUrl,
    };
    entry.images.push(image);
    entry.defaultImageId ||= image.id;
    library[key] = entry;
    await savePortraitLibrary(library);
    await refreshPortraitList();
    await renderVisibleMessages();
}

async function removePortrait(characterKey, imageId) {
    const library = await getPortraitLibrary();
    const entry = library[characterKey];
    if (!entry) return;
    entry.images = (entry.images || []).filter(image => image.id !== imageId);
    if (!entry.images.length) {
        delete library[characterKey];
    } else if (entry.defaultImageId === imageId) {
        entry.defaultImageId = entry.images[0].id;
    }
    await savePortraitLibrary(library);
    await refreshPortraitList();
    await renderVisibleMessages();
}

async function makeDefaultPortrait(characterKey, imageId) {
    const library = await getPortraitLibrary();
    if (!library[characterKey]) return;
    library[characterKey].defaultImageId = imageId;
    await savePortraitLibrary(library);
    await refreshPortraitList();
    await renderVisibleMessages();
}

async function refreshPortraitList() {
    const list = document.querySelector('#vsc_portrait_list');
    if (!list) return;
    const library = await getPortraitLibrary();
    list.replaceChildren();

    const entries = Object.entries(library).sort((a, b) => a[1].displayName.localeCompare(b[1].displayName));
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'vsc-empty';
        empty.textContent = 'No portraits added yet. Speaker cards will use initials until you add them.';
        list.append(empty);
        return;
    }

    for (const [key, entry] of entries) {
        const group = document.createElement('div');
        group.className = 'vsc-portrait-group';

        const title = document.createElement('div');
        title.className = 'vsc-portrait-group-title';
        title.textContent = `${entry.displayName} · ${entry.images?.length || 0}`;
        group.append(title);

        const images = document.createElement('div');
        images.className = 'vsc-portrait-images';
        for (const image of entry.images || []) {
            const item = document.createElement('div');
            item.className = `vsc-portrait-item${entry.defaultImageId === image.id ? ' is-default' : ''}`;
            item.title = entry.defaultImageId === image.id ? 'Default portrait' : 'Click star to make default';

            const img = document.createElement('img');
            img.src = image.dataUrl;
            img.alt = `${entry.displayName} portrait`;

            const controls = document.createElement('div');
            controls.className = 'vsc-portrait-controls';

            const star = document.createElement('button');
            star.type = 'button';
            star.className = 'menu_button vsc-small-button';
            star.textContent = entry.defaultImageId === image.id ? '★' : '☆';
            star.title = 'Make default';
            star.addEventListener('click', () => makeDefaultPortrait(key, image.id));

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'menu_button vsc-small-button';
            remove.textContent = '×';
            remove.title = 'Remove portrait';
            remove.addEventListener('click', () => removePortrait(key, image.id));

            controls.append(star, remove);
            item.append(img, controls);
            images.append(item);
        }
        group.append(images);
        list.append(group);
    }
}

async function exportPortraitPack() {
    const library = await getPortraitLibrary();
    const payload = {
        format: 'veyrin-speaker-cards-portrait-pack',
        version: 1,
        exportedAt: new Date().toISOString(),
        library,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'veyrin-speaker-cards-portraits.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importPortraitPack(file) {
    if (!file) return;
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload?.format !== 'veyrin-speaker-cards-portrait-pack' || typeof payload.library !== 'object') {
        throw new Error('That file is not a Veyrin Speaker Cards portrait pack.');
    }
    await savePortraitLibrary(payload.library);
    await refreshPortraitList();
    await renderVisibleMessages();
}

function installSettingsPanel() {
    if (settingsPanelInstalled || document.querySelector('#vsc_settings')) return;
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;

    const panel = document.createElement('div');
    panel.id = 'vsc_settings';
    panel.className = 'extension_container vsc-settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Veyrin Speaker Cards</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="vsc_enabled" type="checkbox"><span>Enable speaker cards</span></label>
                <label class="checkbox_label"><input id="vsc_inject" type="checkbox"><span>Inject speaker-format instruction into Veyrin generations</span></label>
                <label class="checkbox_label"><input id="vsc_show_portraits" type="checkbox"><span>Show portraits</span></label>

                <label for="vsc_targets"><small>Apply to these SillyTavern character names (comma-separated)</small></label>
                <input id="vsc_targets" class="text_pole" type="text" placeholder="Veyrin DM, Veyrin">

                <label for="vsc_dm_name"><small>DM / narrator label</small></label>
                <input id="vsc_dm_name" class="text_pole" type="text" placeholder="Veyrin DM">

                <label for="vsc_portrait_mode"><small>When a character has multiple portraits</small></label>
                <select id="vsc_portrait_mode" class="text_pole">
                    <option value="default">Always use default portrait</option>
                    <option value="cycle">Deterministically vary portraits by message</option>
                </select>

                <hr>
                <b>Portrait Library</b>
                <div class="vsc-help">You can add portraits after installation. Multiple portraits per character are supported. The ★ image is the default.</div>
                <input id="vsc_portrait_name" class="text_pole" type="text" placeholder="Character name, e.g. Elena">
                <input id="vsc_portrait_file" type="file" accept="image/*" hidden>
                <div class="vsc-button-row">
                    <button id="vsc_add_portrait" type="button" class="menu_button">Add Portrait</button>
                    <button id="vsc_rerender" type="button" class="menu_button">Re-render Chat</button>
                </div>
                <div id="vsc_portrait_list"></div>
                <div class="vsc-button-row">
                    <button id="vsc_export" type="button" class="menu_button">Export Portrait Pack</button>
                    <button id="vsc_import_button" type="button" class="menu_button">Import Portrait Pack</button>
                    <input id="vsc_import_file" type="file" accept="application/json,.json" hidden>
                </div>
                <div class="vsc-help">No extra model/API call is made. Existing unmarked messages are left unchanged.</div>
            </div>
        </div>
    `;
    host.append(panel);
    settingsPanelInstalled = true;

    const settings = getSettings();
    const enabled = panel.querySelector('#vsc_enabled');
    const inject = panel.querySelector('#vsc_inject');
    const showPortraits = panel.querySelector('#vsc_show_portraits');
    const targets = panel.querySelector('#vsc_targets');
    const dmName = panel.querySelector('#vsc_dm_name');
    const portraitMode = panel.querySelector('#vsc_portrait_mode');

    enabled.checked = settings.enabled;
    inject.checked = settings.injectFormatPrompt;
    showPortraits.checked = settings.showPortraits;
    targets.value = settings.targetCharacters;
    dmName.value = settings.dmName;
    portraitMode.value = settings.portraitMode;

    enabled.addEventListener('input', async e => {
        settings.enabled = e.target.checked;
        saveSettings();
        applyPromptInjection();
        if (settings.enabled) await renderVisibleMessages();
        else ctx()?.reloadCurrentChat?.();
    });
    inject.addEventListener('input', e => {
        settings.injectFormatPrompt = e.target.checked;
        saveSettings();
        applyPromptInjection();
    });
    showPortraits.addEventListener('input', async e => {
        settings.showPortraits = e.target.checked;
        saveSettings();
        await renderVisibleMessages();
    });
    targets.addEventListener('change', async e => {
        settings.targetCharacters = e.target.value;
        saveSettings();
        applyPromptInjection();
        await renderVisibleMessages();
    });
    dmName.addEventListener('change', async e => {
        settings.dmName = e.target.value.trim() || DEFAULT_DM_NAME;
        e.target.value = settings.dmName;
        saveSettings();
        applyPromptInjection();
        await renderVisibleMessages();
    });
    portraitMode.addEventListener('change', async e => {
        settings.portraitMode = e.target.value;
        saveSettings();
        await renderVisibleMessages();
    });

    const portraitNameInput = panel.querySelector('#vsc_portrait_name');
    const portraitFileInput = panel.querySelector('#vsc_portrait_file');
    const addPortraitButton = panel.querySelector('#vsc_add_portrait');

    // The Add Portrait button is the file-picker trigger. This avoids relying on
    // SillyTavern/browser styling of a standalone <input type="file"> control.
    addPortraitButton.addEventListener('click', () => {
        const name = portraitNameInput.value.trim();
        if (!name) {
            globalThis.toastr?.error?.('Enter the character name first.', 'Veyrin Speaker Cards');
            portraitNameInput.focus();
            return;
        }
        portraitFileInput.click();
    });

    portraitFileInput.addEventListener('change', async e => {
        const name = portraitNameInput.value.trim();
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            await addPortrait(name, file);
            globalThis.toastr?.success?.(`Portrait added for ${name}.`, 'Veyrin Speaker Cards');
        } catch (error) {
            globalThis.toastr?.error?.(error.message, 'Veyrin Speaker Cards');
        } finally {
            e.target.value = '';
        }
    });

    panel.querySelector('#vsc_rerender').addEventListener('click', renderVisibleMessages);
    panel.querySelector('#vsc_export').addEventListener('click', exportPortraitPack);
    panel.querySelector('#vsc_import_button').addEventListener('click', () => panel.querySelector('#vsc_import_file').click());
    panel.querySelector('#vsc_import_file').addEventListener('change', async e => {
        try {
            await importPortraitPack(e.target.files?.[0]);
            globalThis.toastr?.success?.('Portrait pack imported.', 'Veyrin Speaker Cards');
        } catch (error) {
            globalThis.toastr?.error?.(error.message, 'Veyrin Speaker Cards');
        } finally {
            e.target.value = '';
        }
    });

    refreshPortraitList();
}

function installEventHandlers() {
    const context = ctx();
    if (!context?.eventSource) return;
    const events = context.eventTypes || context.event_types;
    if (!events) return;

    context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, messageId => {
        setTimeout(() => renderMessage(messageId), 0);
    });
    context.eventSource.on(events.MESSAGE_EDITED, messageId => {
        setTimeout(() => renderMessage(messageId), 0);
    });
    context.eventSource.on(events.MESSAGE_SWIPED, messageId => {
        setTimeout(() => renderMessage(messageId), 0);
    });
    context.eventSource.on(events.CHAT_CHANGED, () => {
        setTimeout(() => {
            applyPromptInjection();
            renderVisibleMessages();
        }, 50);
    });
}

async function initialize() {
    const context = ctx();
    if (!context) {
        setTimeout(initialize, 100);
        return;
    }

    portraitStore = globalThis.SillyTavern?.libs?.localforage?.createInstance
        ? globalThis.SillyTavern.libs.localforage.createInstance({ name: 'VeyrinSpeakerCards', storeName: 'portrait_library' })
        : globalThis.localforage?.createInstance?.({ name: 'VeyrinSpeakerCards', storeName: 'portrait_library' });

    getSettings();
    installSettingsPanel();
    installEventHandlers();
    applyPromptInjection();
    await renderVisibleMessages();
    console.log('[Veyrin Speaker Cards] v0.1.1 loaded');
}

jQuery(initialize);
