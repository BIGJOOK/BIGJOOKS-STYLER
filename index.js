import { eventSource, event_types } from '../../../events.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { debounce } from '../../../utils.js';
import { decorateMessage, decorateAll, resolveSpeakerColor } from './decorate.js';

const MODULE_KEY = 'bigjooksStyler';
const LOG_PREFIX = '[BIGJOOKS]';
const EXTENSION_NAME = 'third-party/bigjooks-styler';

/** Settings a fresh install starts with. colorOverrides is handled separately
 *  so the default object is never shared with the live settings store. */
const defaultSettings = Object.freeze({
    enabled: true,
    colorSpeech: true,
    showDividers: true,
    dividerStyle: 'thin',
    showAvatars: true,
    avatarSize: 2,
});

/** Labels for the avatar size slider stops (1-based, decorate.js clamps). */
const AVATAR_SIZE_LABELS = Object.freeze(['Small', 'Medium', 'Large', 'Extra large', 'Super large']);

/** Valid 6-character hex color regex. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Portraits live inside settings.json, so they are stored as small thumbnails. */
const PORTRAIT_MAX_DIMENSION = 256;

/** Shown in a portrait row until a picture is picked; never mistaken for one. */
const PORTRAIT_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
        + '<rect width="24" height="24" rx="12" fill="#4a4a55"/>'
        + '<circle cx="12" cy="9" r="3.5" fill="#7a7a8c"/>'
        + '<path d="M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5z" fill="#7a7a8c"/></svg>');

/**
 * The extension's settings, with defaults merged in key by key so an upgrade
 * that adds a setting keeps everything the user already saved.
 *
 * @returns {object} The live settings object (mutate, then save).
 */
function getSettings() {
    const store = extension_settings[MODULE_KEY] ?? (extension_settings[MODULE_KEY] = {});
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (store[key] === undefined) store[key] = value;
    }
    if (typeof store.colorOverrides !== 'object' || store.colorOverrides === null) {
        store.colorOverrides = {};
    }
    if (typeof store.nameColorOverrides !== 'object' || store.nameColorOverrides === null) {
        store.nameColorOverrides = {};
    }
    if (!Array.isArray(store.nameColorFolders)) {
        store.nameColorFolders = ['Default'];
    }
    if (!store.nameColorFolders.includes('Default')) {
        store.nameColorFolders.unshift('Default');
    }
    if (!Array.isArray(store.portraits)) store.portraits = [];
    if (!Array.isArray(store.colorFolders)) {
        store.colorFolders = Array.isArray(store.folders) ? [...store.folders] : ['Default'];
    }
    if (!store.colorFolders.includes('Default')) {
        store.colorFolders.unshift('Default');
    }
    if (!Array.isArray(store.portraitFolders)) {
        store.portraitFolders = ['Default'];
    }
    if (!store.portraitFolders.includes('Default')) {
        store.portraitFolders.unshift('Default');
    }
    return store;
}

function persistAndRedecorate() {
    saveSettingsDebounced();
    redecorateAllDebounced();
}

/** Chat-wide re-decoration, debounced so bursts of events cost one pass. */
const redecorateAllDebounced = debounce(() => decorateAll(getSettings), 150);

/**
 * Decorates the message an event named, on the next frame so the browser has
 * finished whatever rendering it was doing first.
 *
 * @param {string|number} messageId
 */
function onMessageEvent(messageId) {
    requestAnimationFrame(() => {
        try {
            const el = document.querySelector(`#chat .mes[mesid="${Number(messageId)}"]`);
            if (el) decorateMessage(el, getSettings());
        } catch (err) {
            console.debug(LOG_PREFIX, 'message decorate failed', err);
        }
    });
}

/**
 * Streaming suppresses the RENDERED events, so this is the backstop that
 * styles a reply the moment generation finishes.
 */
function onGenerationEnded() {
    try {
        const chat = getContext().chat;
        if (Array.isArray(chat) && chat.length > 0) onMessageEvent(chat.length - 1);
    } catch (err) {
        console.debug(LOG_PREFIX, 'generation-end decorate failed', err);
    }
}

/**
 * Loads an image file, downscales it to a small thumbnail and returns it as a
 * data URI. Settings are rewritten on every save, so full-size images here are
 * how extensions bloat themselves slow.
 *
 * @param {File} file
 * @returns {Promise<string>} Data URI (PNG keeps transparency, others JPEG).
 */
function processPortraitFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, PORTRAIT_MAX_DIMENSION / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const type = (file.type === 'image/png' || file.type === 'image/gif') ? 'image/png' : 'image/jpeg';
            resolve(canvas.toDataURL(type, 0.85));
        };
        img.onerror = (err) => {
            URL.revokeObjectURL(url);
            reject(err);
        };
        img.src = url;
    });
}

/* ══════════════════════════════════════════════════════════════════
   Floating Glass Modal: State, Filtering, and Pagination
   ══════════════════════════════════════════════════════════════════ */

const DEFAULT_FOLDER = 'Default';
const ALL_FOLDERS = 'All';

/**
 * One entry per library tab. The modal controller is driven entirely by these
 * descriptors — tab switching, folder bars, card lists, search, pagination and
 * the add flow all read from them, so a tab is configuration plus a card
 * builder, not a new pile of if/else arms.
 *
 * kind 'colorMap'    — entries in a { name: { hex, folder } } settings map
 *                      (overridesKey/foldersKey say which map and folder list)
 * kind 'portraitList'— entries in the settings.portraits array
 */
const TABS = Object.freeze({
    colors: Object.freeze({
        kind: 'colorMap',
        overridesKey: 'colorOverrides',
        foldersKey: 'colorFolders',
        folderWord: 'Color',
        cardClass: 'bj-color-card',
        focusField: '.bj-override-name',
        perPage: 5,
        addLabel: 'Add Color',
        searchPlaceholder: 'Search dialogue colors...',
        hint: 'Dialogue colors take precedence over the automatic palette. Comma-separate names for aliases.',
        emptyIcon: 'fa-palette',
        emptyTitle: 'No dialogue colors found',
        emptyDesc: 'Click "+ Add Color" to color any speaker\'s dialogue.',
        itemWord: 'override',
    }),
    names: Object.freeze({
        kind: 'colorMap',
        overridesKey: 'nameColorOverrides',
        foldersKey: 'nameColorFolders',
        folderWord: 'Name Color',
        cardClass: 'bj-name-card',
        focusField: '.bj-override-name',
        perPage: 5,
        addLabel: 'Add Name Color',
        searchPlaceholder: 'Search name colors...',
        hint: 'Name colors recolor the speaker tag only — dialogue keeps its own color. Unlisted names match their dialogue color.',
        emptyIcon: 'fa-signature',
        emptyTitle: 'No name colors found',
        emptyDesc: 'Click "+ Add Name Color" to give any speaker\'s name its own color.',
        itemWord: 'name color',
    }),
    portraits: Object.freeze({
        kind: 'portraitList',
        folderWord: 'Portrait',
        cardClass: 'bj-portrait-card',
        focusField: '.bj-portrait-names',
        perPage: 5,
        addLabel: 'Add Portrait',
        searchPlaceholder: 'Search speaker portraits...',
        hint: 'Give any speaker a picture without making a character card. Comma-separate names for aliases.',
        emptyIcon: 'fa-image-portrait',
        emptyTitle: 'No portraits found',
        emptyDesc: 'Click "+ Add Portrait" to assign an avatar thumbnail to any speaker.',
        itemWord: 'portrait',
    }),
});

/** Transient per-tab UI state: active folder chip, page, search box contents. */
const tabUi = {
    colors: { folder: ALL_FOLDERS, page: 0, search: '' },
    names: { folder: ALL_FOLDERS, page: 0, search: '' },
    portraits: { folder: ALL_FOLDERS, page: 0, search: '' },
};

let activeModalTab = 'colors'; // 'colors' | 'names' | 'portraits'

/**
 * Escapes characters for HTML attributes and text to prevent injection.
 */
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Normalizes a color override entry to { hex, folder }.
 */
function parseColorOverride(val) {
    if (typeof val === 'object' && val !== null) {
        return {
            hex: String(val.hex ?? '#b39ddb'),
            folder: String(val.folder || DEFAULT_FOLDER),
        };
    }
    return {
        hex: String(val ?? '#b39ddb'),
        folder: DEFAULT_FOLDER,
    };
}

/**
 * Folder list for a color-map tab (dialogue or name colors), guaranteeing
 * 'Default' is first and capturing any folders referenced by existing entries
 * (the safety net that never loses a folder an entry still points at).
 *
 * @param {'colors'|'names'} tab
 */
function getMapFolders(tab) {
    const { overridesKey, foldersKey } = TABS[tab];
    const settings = getSettings();
    if (!Array.isArray(settings[foldersKey])) settings[foldersKey] = [DEFAULT_FOLDER];
    if (!settings[foldersKey].includes(DEFAULT_FOLDER)) settings[foldersKey].unshift(DEFAULT_FOLDER);
    for (const val of Object.values(settings[overridesKey])) {
        const folder = typeof val === 'object' && val?.folder ? String(val.folder).trim() : null;
        if (folder && !settings[foldersKey].includes(folder)) settings[foldersKey].push(folder);
    }
    return settings[foldersKey];
}

/**
 * The folder list for whichever side a tab manages.
 *
 * @param {'colors'|'names'|'portraits'} tab
 */
function getFoldersFor(tab) {
    return TABS[tab].kind === 'portraitList' ? getPortraitFolders() : getMapFolders(tab);
}

/**
 * Retrieves the full list of folders for portraits, guaranteeing 'Default' is
 * first and capturing any folders referenced by existing entries.
 */
function getPortraitFolders() {
    const settings = getSettings();
    if (!Array.isArray(settings.portraitFolders)) {
        settings.portraitFolders = [DEFAULT_FOLDER];
    }
    if (!settings.portraitFolders.includes(DEFAULT_FOLDER)) {
        settings.portraitFolders.unshift(DEFAULT_FOLDER);
    }
    for (const entry of settings.portraits) {
        const folder = entry?.folder ? String(entry.folder).trim() : null;
        if (folder && !settings.portraitFolders.includes(folder)) {
            settings.portraitFolders.push(folder);
        }
    }
    return settings.portraitFolders;
}

/**
 * Adds a new category folder to whichever tab is active. Returns true on success.
 *
 * @param {string} name
 * @param {'colors'|'names'|'portraits'} tab
 */
function addFolder(name, tab = activeModalTab) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    if (trimmed.toLowerCase() === ALL_FOLDERS.toLowerCase()) {
        if (typeof toastr !== 'undefined') toastr.warning(`"${ALL_FOLDERS}" is a reserved filter.`);
        return false;
    }
    const d = TABS[tab];
    const folders = getFoldersFor(tab);
    if (folders.some(f => f.toLowerCase() === trimmed.toLowerCase())) {
        if (typeof toastr !== 'undefined') toastr.info(`Folder "${trimmed}" already exists.`);
        return false;
    }
    folders.push(trimmed);
    if (d.kind === 'portraitList') getSettings().portraitFolders = folders;
    else getSettings()[d.foldersKey] = folders;
    persistAndRedecorate();
    return true;
}

/**
 * Deletes a custom category folder from whichever tab is active.
 * All entries inside are reassigned to 'Default' — never deleted.
 *
 * @param {string} folderName
 * @param {'colors'|'names'|'portraits'} tab
 */
function deleteFolder(folderName, tab = activeModalTab) {
    if (folderName === DEFAULT_FOLDER || folderName === ALL_FOLDERS) return;
    const settings = getSettings();
    const d = TABS[tab];

    if (d.kind === 'portraitList') {
        const folders = getPortraitFolders();
        const index = folders.indexOf(folderName);
        if (index === -1) return;

        // Reassign portraits in this folder to Default
        for (const entry of settings.portraits) {
            if (entry?.folder === folderName) {
                entry.folder = DEFAULT_FOLDER;
            }
        }
        folders.splice(index, 1);
        settings.portraitFolders = folders;
    } else {
        const folders = getMapFolders(tab);
        const index = folders.indexOf(folderName);
        if (index === -1) return;

        // Reassign overrides in this folder to Default
        for (const [key, val] of Object.entries(settings[d.overridesKey])) {
            const parsed = parseColorOverride(val);
            if (parsed.folder === folderName) {
                settings[d.overridesKey][key] = { hex: parsed.hex, folder: DEFAULT_FOLDER };
            }
        }
        folders.splice(index, 1);
        settings[d.foldersKey] = folders;
    }
    if (tabUi[tab].folder === folderName) tabUi[tab].folder = DEFAULT_FOLDER;

    persistAndRedecorate();
    renderFolderBar();
    renderActiveModalView();
}

/**
 * The active tab's entries after folder-chip and search filtering.
 * Color-map tabs yield [name, val] pairs; the portrait tab yields entries.
 *
 * @param {'colors'|'names'|'portraits'} tab
 */
function filteredEntries(tab) {
    const { folder, search } = tabUi[tab];
    const term = search.trim().toLowerCase();

    if (TABS[tab].kind === 'portraitList') {
        return getSettings().portraits.filter(entry => {
            const entryFolder = entry?.folder || DEFAULT_FOLDER;
            if (folder !== ALL_FOLDERS && entryFolder !== folder) return false;
            return !term || String(entry?.names ?? '').toLowerCase().includes(term);
        });
    }

    return Object.entries(getSettings()[TABS[tab].overridesKey])
        .filter(([name, val]) => {
            const parsed = parseColorOverride(val);
            if (folder !== ALL_FOLDERS && parsed.folder !== folder) return false;
            return !term || name.toLowerCase().includes(term);
        });
}

/**
 * Ensures the modal overlay HTML is loaded and injected into document.body.
 */
async function ensureModalInjected() {
    if ($('#bj_modal_overlay').length > 0) return;

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'modal');
        if (html) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = html;
            while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);
            bindModalEvents();
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to inject modal overlay', err);
    }
}

/**
 * Opens the floating modal overlay and activates the specified tab.
 *
 * @param {'colors'|'portraits'} tab
 */
function openModal(tab = 'colors') {
    ensureModalInjected().then(() => {
        $('#bj_modal_overlay').css('display', 'flex');
        switchModalTab(tab);
        renderFolderBar();

        $(document).off('keydown.bjModal').on('keydown.bjModal', (e) => {
            if (e.key === 'Escape') closeModal();
        });
    });
}

function closeModal() {
    $('#bj_modal_overlay').hide();
    $(document).off('keydown.bjModal');
}

/**
 * Switches the active tab in the floating modal.
 *
 * @param {'colors'|'names'|'portraits'} tab
 */
function switchModalTab(tab) {
    activeModalTab = tab;
    const d = TABS[tab];
    $('.bj-modal-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');

    $('#bj_modal_search').val(tabUi[tab].search).attr('placeholder', d.searchPlaceholder);
    $('#bj_modal_add_label').text(d.addLabel);
    $('#bj_modal_footer_hint').text(d.hint);

    renderFolderBar();
    renderActiveModalView();
}

/**
 * Renders the folder category bar with folder chips and the [+ Folder] button
 * for whichever tab is active. Folder taxonomies stay per-tab (Law 28): a
 * folder created here belongs to this tab's side only.
 */
function renderFolderBar() {
    const $bar = $('#bj_modal_folder_bar').empty();
    const tab = activeModalTab;
    const d = TABS[tab];
    const ui = tabUi[tab];
    const folders = getFoldersFor(tab);

    /** Selecting a chip always resets paging — page 3 of an old filter is meaningless. */
    const selectFolder = (folder) => {
        ui.folder = folder;
        ui.page = 0;
        renderFolderBar();
        renderActiveModalView();
    };

    // 1. "All" Chip
    const $allChip = $(`
        <button type="button" class="bj-folder-chip${ui.folder === ALL_FOLDERS ? ' active' : ''}" data-folder="${ALL_FOLDERS}" title="Show all entries">
            <i class="fa-solid fa-layer-group"></i>
            <span>All</span>
        </button>
    `);
    $allChip.on('click', () => selectFolder(ALL_FOLDERS));
    $bar.append($allChip);

    // 2. "Default" Chip
    const $defaultChip = $(`
        <button type="button" class="bj-folder-chip${ui.folder === DEFAULT_FOLDER ? ' active' : ''}" data-folder="${DEFAULT_FOLDER}" title="Default category">
            <i class="fa-solid fa-folder"></i>
            <span>Default</span>
        </button>
    `);
    $defaultChip.on('click', () => selectFolder(DEFAULT_FOLDER));
    $bar.append($defaultChip);

    // 3. Custom User Folders
    for (const f of folders) {
        if (f === DEFAULT_FOLDER) continue;
        const $wrap = $(`
            <div class="bj-folder-chip-wrap${ui.folder === f ? ' active' : ''}">
                <button type="button" class="bj-folder-chip" data-folder="${escapeHtml(f)}" title="Category: ${escapeHtml(f)}">
                    <i class="fa-solid fa-folder"></i>
                    <span class="bj-folder-name">${escapeHtml(f)}</span>
                </button>
                <button type="button" class="bj-folder-delete" data-folder="${escapeHtml(f)}" title="Delete category '${escapeHtml(f)}' (characters move to Default)">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `);

        $wrap.find('.bj-folder-chip').on('click', function () {
            selectFolder($(this).data('folder'));
        });

        $wrap.find('.bj-folder-delete').on('click', async function (e) {
            e.stopPropagation();
            const folder = $(this).data('folder');
            let confirmed = false;
            try {
                confirmed = await Popup.show.confirm(
                    'Delete Category',
                    `Delete category "<b>${escapeHtml(folder)}</b>"?<br><br>All characters inside will be moved to <b>Default</b>. No characters will be deleted.`
                );
            } catch {
                confirmed = window.confirm(`Delete category "${folder}"? All characters inside will be moved to Default.`);
            }
            if (confirmed) deleteFolder(folder, tab);
        });

        $bar.append($wrap);
    }

    // 4. [+ Folder] Button
    const $addBtn = $(`
        <button type="button" class="bj-btn-folder-add" id="bj_modal_add_folder" title="Create new ${d.folderWord.toLowerCase()} category">
            <i class="fa-solid fa-folder-plus"></i>
            <span>+ Folder</span>
        </button>
    `);
    $addBtn.on('click', async () => {
        let name = '';
        try {
            const popup = new Popup(`<h3>Create New ${d.folderWord} Category</h3>`, POPUP_TYPE.INPUT, '', {
                okButton: 'Create',
                cancelButton: 'Cancel',
                placeholder: 'Category name (e.g. DC, Overlord)',
            });
            const result = await popup.show();
            if (popup.result === POPUP_RESULT.AFFIRMATIVE && typeof result === 'string') {
                name = result.trim();
            }
        } catch {
            name = (window.prompt(`Enter new ${d.folderWord.toLowerCase()} category name:`) ?? '').trim();
        }

        if (name && addFolder(name, tab)) {
            selectFolder(name);
        }
    });
    $bar.append($addBtn);
}

/**
 * Renders the active tab's card list into the modal body with pagination.
 */
function renderActiveModalView() {
    const tab = activeModalTab;
    const d = TABS[tab];
    const ui = tabUi[tab];
    const $body = $('#bj_modal_body').empty();

    const entries = filteredEntries(tab);
    const pageCount = Math.max(1, Math.ceil(entries.length / d.perPage));
    ui.page = Math.min(Math.max(0, ui.page), pageCount - 1);

    if (entries.length === 0) {
        const folderText = ui.folder === ALL_FOLDERS ? '' : ` in ${escapeHtml(ui.folder)}`;
        $body.append(`
            <div class="bj-empty-state">
                <i class="fa-solid ${d.emptyIcon} bj-empty-icon"></i>
                <div class="bj-empty-title">${d.emptyTitle}${folderText}</div>
                <div class="bj-empty-desc">${d.emptyDesc}</div>
            </div>
        `);
    } else {
        const start = ui.page * d.perPage;
        for (const item of entries.slice(start, start + d.perPage)) {
            if (d.kind === 'portraitList') $body.append(makePortraitCard(item));
            else $body.append(makeOverrideCard(tab, item[0], item[1]));
        }
    }

    $('#bj_modal_page_label').text(`${ui.page + 1} / ${pageCount}`);
    $('#bj_modal_prev').toggleClass('disabled', ui.page <= 0);
    $('#bj_modal_next').toggleClass('disabled', ui.page >= pageCount - 1);

    const total = d.kind === 'portraitList'
        ? getSettings().portraits.length
        : Object.keys(getSettings()[d.overridesKey]).length;
    const folderNote = ui.folder === ALL_FOLDERS ? '' : ` in ${ui.folder}`;
    $('#bj_modal_footer_count').text(`${entries.length} ${d.itemWord}${entries.length === 1 ? '' : 's'}${folderNote} (${total} total)`);
}

/**
 * Builds one color-map card — a dialogue color on the 'colors' tab, a name-tag
 * color on the 'names' tab. Name cards lead with a live sample showing the
 * pairing (name tag color vs. that speaker's dialogue color) since that
 * pairing is the whole point of the tab.
 *
 * @param {'colors'|'names'} tab
 * @param {string} name Speaker name(s)
 * @param {string|object} val Color hex or { hex, folder }
 * @returns {jQuery}
 */
function makeOverrideCard(tab, name, val) {
    const d = TABS[tab];
    const isNames = tab === 'names';
    const parsed = parseColorOverride(val);
    let currentKey = name;
    let currentColor = parsed.hex;
    let currentFolder = parsed.folder;

    const folders = getMapFolders(tab);
    const optionsHtml = folders.map(f =>
        `<option value="${escapeHtml(f)}"${f === currentFolder ? ' selected' : ''}>${escapeHtml(f)}</option>`
    ).join('');

    const $card = $(`
        <div class="bj-item-card ${d.cardClass}">
            ${isNames ? `
            <div class="bj-name-sample" title="Live preview — name tag color vs. dialogue color">
                <span class="bj-name-sample-tag"></span>
                <span class="bj-name-sample-text">&quot;…&quot;</span>
            </div>` : ''}
            <input type="text" class="bj-input bj-override-name" placeholder="Speaker name(s)">
            <select class="bj-folder-select" title="Move to category">
                ${optionsHtml}
            </select>
            <div class="bj-color-input-wrap">
                <input type="color" class="bj-color-picker bj-override-color">
                <input type="text" class="bj-input bj-hex-input" spellcheck="false" autocomplete="off" maxlength="7" title="Type a hex color (#rrggbb) and press Enter">
            </div>
            <button type="button" class="bj-btn-icon bj-btn-danger bj-override-remove" title="Remove ${d.itemWord}">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `);

    const $nameInput = $card.find('.bj-override-name').val(name);
    const $colorInput = $card.find('.bj-override-color').val(currentColor);
    const $hexInput = $card.find('.bj-hex-input').val(currentColor);
    const $folderSelect = $card.find('.bj-folder-select');
    const $sampleTag = $card.find('.bj-name-sample-tag');
    const $sampleText = $card.find('.bj-name-sample-text');

    /** Repaints the name-card sample: tag shows this color, the quote shows
     *  the speaker's dialogue color (override or palette hash). */
    const refreshSample = () => {
        if (!isNames) return;
        const displayName = currentKey.split(',')[0].trim() || 'Name';
        $sampleTag.text(`${displayName}:`).css('color', currentColor);
        $sampleText.css('color', resolveSpeakerColor(displayName, getSettings()));
    };
    refreshSample();

    const saveEntry = () => {
        getSettings()[d.overridesKey][currentKey] = { hex: currentColor, folder: currentFolder };
        persistAndRedecorate();
    };

    $folderSelect.on('change', function () {
        currentFolder = this.value;
        saveEntry();
        if (tabUi[tab].folder !== ALL_FOLDERS && tabUi[tab].folder !== currentFolder) {
            renderActiveModalView();
        }
    });

    // Picker drags update the hex text live.
    $colorInput.on('input change', function () {
        $hexInput.val(this.value);
        currentColor = this.value;
        refreshSample();
        saveEntry();
    });

    // Typed hex commits on Enter or blur. A missing '#' is forgiven; anything
    // that is not a color reverts to the one in force.
    const commitHex = () => {
        let typed = String($hexInput.val() ?? '').trim();
        if (/^[0-9a-f]{6}$/i.test(typed)) typed = `#${typed}`;
        if (HEX_COLOR.test(typed)) {
            typed = typed.toLowerCase();
            $hexInput.val(typed);
            $colorInput.val(typed);
            currentColor = typed;
            refreshSample();
            saveEntry();
        } else {
            $hexInput.val($colorInput.val());
        }
    };
    $hexInput.on('change', commitHex);
    $hexInput.on('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitHex(); this.blur(); }
    });

    $nameInput.on('change', function () {
        const next = this.value.trim();
        if (!next || next === currentKey) { this.value = currentKey; return; }
        const settings = getSettings();
        delete settings[d.overridesKey][currentKey];
        currentKey = next;
        settings[d.overridesKey][currentKey] = { hex: currentColor, folder: currentFolder };
        refreshSample();
        persistAndRedecorate();
    });

    $card.find('.bj-override-remove').on('click', () => {
        delete getSettings()[d.overridesKey][currentKey];
        persistAndRedecorate();
        renderActiveModalView();
    });

    return $card;
}

/**
 * Builds one portrait card.
 *
 * @param {{ names: string, image: string, folder?: string }} entry
 * @returns {jQuery}
 */
function makePortraitCard(entry) {
    const currentFolder = entry.folder || DEFAULT_FOLDER;
    const folders = getPortraitFolders();
    const optionsHtml = folders.map(f =>
        `<option value="${escapeHtml(f)}"${f === currentFolder ? ' selected' : ''}>${escapeHtml(f)}</option>`
    ).join('');

    const $card = $(`
        <div class="bj-item-card bj-portrait-card">
            <img class="bj-portrait-thumb" alt="">
            <input type="text" class="bj-input bj-portrait-names" placeholder="Speaker name(s)">
            <select class="bj-folder-select" title="Move to category">
                ${optionsHtml}
            </select>
            <label class="bj-btn-icon bj-portrait-pick" title="Choose picture">
                <i class="fa-solid fa-image"></i>
                <input class="bj-portrait-file" type="file" accept="image/*" hidden>
            </label>
            <button type="button" class="bj-btn-icon bj-btn-danger bj-portrait-remove" title="Remove portrait">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `);

    $card.find('.bj-portrait-names').val(entry.names ?? '');
    $card.find('.bj-portrait-thumb').attr('src', entry.image || PORTRAIT_PLACEHOLDER);

    $card.find('.bj-folder-select').on('change', function () {
        entry.folder = this.value;
        persistAndRedecorate();
        if (tabUi.portraits.folder !== ALL_FOLDERS && tabUi.portraits.folder !== entry.folder) {
            renderActiveModalView();
        }
    });

    $card.find('.bj-portrait-file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            entry.image = await processPortraitFile(file);
            $card.find('.bj-portrait-thumb').attr('src', entry.image);
            persistAndRedecorate();
        } catch (err) {
            console.debug(LOG_PREFIX, 'portrait processing failed', err);
        }
    });

    $card.find('.bj-portrait-names').on('change input', function () {
        entry.names = this.value;
        persistAndRedecorate();
    });

    $card.find('.bj-portrait-remove').on('click', () => {
        const list = getSettings().portraits;
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        persistAndRedecorate();
        renderActiveModalView();
    });

    return $card;
}

/**
 * Binds events for the floating modal window controls.
 */
function bindModalEvents() {
    // Backdrop click dismiss
    $('#bj_modal_overlay').on('click', function (e) {
        if (e.target === this) closeModal();
    });

    // Close button
    $('#bj_modal_close').on('click', closeModal);

    // Tab switching
    $('.bj-modal-tab').on('click', function () {
        const tab = $(this).data('tab');
        if (tab && tab !== activeModalTab) {
            switchModalTab(tab);
        }
    });

    // Live search
    $('#bj_modal_search').on('input', function () {
        const ui = tabUi[activeModalTab];
        ui.search = this.value;
        ui.page = 0;
        renderActiveModalView();
    });

    // Pagination
    $('#bj_modal_prev').on('click', () => {
        const ui = tabUi[activeModalTab];
        if (ui.page > 0) { ui.page--; renderActiveModalView(); }
    });

    $('#bj_modal_next').on('click', () => {
        const tab = activeModalTab;
        const ui = tabUi[tab];
        const pageCount = Math.max(1, Math.ceil(filteredEntries(tab).length / TABS[tab].perPage));
        if (ui.page < pageCount - 1) { ui.page++; renderActiveModalView(); }
    });

    // Add new item — color-map tabs add to their own map, portraits to the list.
    // A new entry joins the folder currently being viewed (Default when on All).
    $('#bj_modal_add').on('click', () => {
        const tab = activeModalTab;
        const d = TABS[tab];
        const ui = tabUi[tab];
        const settings = getSettings();
        const targetFolder = (ui.folder === ALL_FOLDERS || !ui.folder) ? DEFAULT_FOLDER : ui.folder;

        if (d.kind === 'portraitList') {
            settings.portraits.push({ names: 'New speaker', image: PORTRAIT_PLACEHOLDER, folder: targetFolder });
        } else {
            const map = settings[d.overridesKey];
            let name = 'New speaker';
            let n = 2;
            while (map[name] !== undefined) name = `New speaker ${n++}`;
            map[name] = { hex: '#b39ddb', folder: targetFolder };
        }

        // Land on the new entry's page with any search cleared, ready to type.
        ui.search = '';
        $('#bj_modal_search').val('');
        ui.page = Math.max(0, Math.ceil(filteredEntries(tab).length / d.perPage) - 1);
        renderActiveModalView();
        $(`#bj_modal_body .${d.cardClass}`).last().find(d.focusField).trigger('focus').select();
        persistAndRedecorate();
    });
}

/**
 * Renders the settings drawer into the Extensions panel and wires controls.
 */
async function initSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings2').append(html);

    const settings = getSettings();

    $('#bj_enable').prop('checked', settings.enabled)
        .on('change', function () { settings.enabled = this.checked; persistAndRedecorate(); });
    $('#bj_colors').prop('checked', settings.colorSpeech)
        .on('change', function () { settings.colorSpeech = this.checked; persistAndRedecorate(); });
    $('#bj_dividers').prop('checked', settings.showDividers)
        .on('change', function () { settings.showDividers = this.checked; persistAndRedecorate(); });
    $('#bj_divider_style').val(settings.dividerStyle)
        .on('change', function () { settings.dividerStyle = this.value; persistAndRedecorate(); });
    $('#bj_avatars').prop('checked', settings.showAvatars)
        .on('change', function () { settings.showAvatars = this.checked; persistAndRedecorate(); });

    // Avatar size slider
    $('#bj_avatar_size').val(settings.avatarSize ?? 2)
        .on('input change', function () {
            const size = Math.min(AVATAR_SIZE_LABELS.length, Math.max(1, Number(this.value) || 2));
            settings.avatarSize = size;
            $('#bj_avatar_size_label').text(AVATAR_SIZE_LABELS[size - 1]);
            persistAndRedecorate();
        });
    $('#bj_avatar_size_label').text(AVATAR_SIZE_LABELS[(settings.avatarSize ?? 2) - 1]);

    // Drawer launch buttons
    $('#bj_drawer_open_colors').on('click', () => openModal('colors'));
    $('#bj_drawer_open_names').on('click', () => openModal('names'));
    $('#bj_drawer_open_portraits').on('click', () => openModal('portraits'));
}

jQuery(async () => {
    try {
        getSettings();
        await initSettingsPanel();

        // Anything that renders or rewrites a single message decorates just that one.
        for (const type of [
            event_types.CHARACTER_MESSAGE_RENDERED,
            event_types.USER_MESSAGE_RENDERED,
            event_types.MESSAGE_UPDATED,
            event_types.MESSAGE_EDITED,
            event_types.MESSAGE_SWIPED,
        ]) {
            eventSource.on(type, (messageId) => onMessageEvent(messageId));
        }

        // Chat-wide changes go through the debounced pass (with its stale-batch guard).
        eventSource.on(event_types.CHAT_CHANGED, redecorateAllDebounced);
        eventSource.on(event_types.MORE_MESSAGES_LOADED, redecorateAllDebounced);
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

        // First paint for whatever chat is already open at load.
        decorateAll(getSettings);

        console.debug(LOG_PREFIX, 'BIGJOOKS Styler loaded');
    } catch (err) {
        console.error(LOG_PREFIX, 'extension failed to load', err);
    }
});
