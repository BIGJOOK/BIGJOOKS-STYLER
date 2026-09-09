import { eventSource, event_types } from '../../../events.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { debounce } from '../../../utils.js';
import { decorateMessage, decorateAll } from './decorate.js';

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

const OVERRIDES_PER_PAGE = 5;
let overridePage = 0;
let overrideSearchTerm = '';

const PORTRAITS_PER_PAGE = 5;
let portraitPage = 0;
let portraitSearchTerm = '';

let activeModalTab = 'colors'; // 'colors' | 'portraits'

const DEFAULT_FOLDER = 'Default';
const ALL_FOLDERS = 'All';

let activeColorFolder = ALL_FOLDERS;
let activePortraitFolder = ALL_FOLDERS;

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
 * Retrieves the full list of folders for color overrides, guaranteeing 'Default'
 * is first and capturing any folders referenced by existing entries.
 */
function getColorFolders() {
    const settings = getSettings();
    if (!Array.isArray(settings.colorFolders)) {
        settings.colorFolders = Array.isArray(settings.folders) ? [...settings.folders] : [DEFAULT_FOLDER];
    }
    if (!settings.colorFolders.includes(DEFAULT_FOLDER)) {
        settings.colorFolders.unshift(DEFAULT_FOLDER);
    }
    for (const val of Object.values(settings.colorOverrides)) {
        const folder = typeof val === 'object' && val?.folder ? String(val.folder).trim() : null;
        if (folder && !settings.colorFolders.includes(folder)) {
            settings.colorFolders.push(folder);
        }
    }
    return settings.colorFolders;
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
 * Adds a new category folder to either colors or portraits. Returns true on success.
 *
 * @param {string} name
 * @param {'colors'|'portraits'} type
 */
function addFolder(name, type = activeModalTab) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    if (trimmed.toLowerCase() === ALL_FOLDERS.toLowerCase()) {
        if (typeof toastr !== 'undefined') toastr.warning(`"${ALL_FOLDERS}" is a reserved filter.`);
        return false;
    }
    const folders = type === 'colors' ? getColorFolders() : getPortraitFolders();
    if (folders.some(f => f.toLowerCase() === trimmed.toLowerCase())) {
        if (typeof toastr !== 'undefined') toastr.info(`Folder "${trimmed}" already exists.`);
        return false;
    }
    folders.push(trimmed);
    if (type === 'colors') {
        getSettings().colorFolders = folders;
    } else {
        getSettings().portraitFolders = folders;
    }
    persistAndRedecorate();
    return true;
}

/**
 * Deletes a custom category folder from either colors or portraits.
 * All entries inside are reassigned to 'Default'.
 *
 * @param {string} folderName
 * @param {'colors'|'portraits'} type
 */
function deleteFolder(folderName, type = activeModalTab) {
    if (folderName === DEFAULT_FOLDER || folderName === ALL_FOLDERS) return;
    const settings = getSettings();

    if (type === 'colors') {
        const folders = getColorFolders();
        const index = folders.indexOf(folderName);
        if (index === -1) return;

        // Reassign color overrides in this folder to Default
        for (const [key, val] of Object.entries(settings.colorOverrides)) {
            const parsed = parseColorOverride(val);
            if (parsed.folder === folderName) {
                settings.colorOverrides[key] = { hex: parsed.hex, folder: DEFAULT_FOLDER };
            }
        }
        folders.splice(index, 1);
        settings.colorFolders = folders;
        if (activeColorFolder === folderName) activeColorFolder = DEFAULT_FOLDER;
    } else {
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
        if (activePortraitFolder === folderName) activePortraitFolder = DEFAULT_FOLDER;
    }

    persistAndRedecorate();
    renderFolderBar();
    renderActiveModalView();
}

function filteredOverrideEntries() {
    const term = overrideSearchTerm.trim().toLowerCase();
    const activeFolder = activeColorFolder;
    return Object.entries(getSettings().colorOverrides)
        .filter(([name, val]) => {
            const parsed = parseColorOverride(val);
            if (activeFolder !== ALL_FOLDERS && parsed.folder !== activeFolder) return false;
            return !term || name.toLowerCase().includes(term);
        });
}

function filteredPortraitEntries() {
    const term = portraitSearchTerm.trim().toLowerCase();
    const activeFolder = activePortraitFolder;
    return getSettings().portraits
        .filter(entry => {
            const folder = entry?.folder || DEFAULT_FOLDER;
            if (activeFolder !== ALL_FOLDERS && folder !== activeFolder) return false;
            return !term || String(entry?.names ?? '').toLowerCase().includes(term);
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
 * @param {'colors'|'portraits'} tab
 */
function switchModalTab(tab) {
    activeModalTab = tab;
    $('.bj-modal-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');

    const isColors = tab === 'colors';
    $('#bj_modal_search')
        .val(isColors ? overrideSearchTerm : portraitSearchTerm)
        .attr('placeholder', isColors ? 'Search color overrides...' : 'Search speaker portraits...');

    $('#bj_modal_add_label').text(isColors ? 'Add Override' : 'Add Portrait');
    $('#bj_modal_footer_hint').text(
        isColors
            ? 'Color overrides take precedence over the automatic palette. Comma-separate names for aliases.'
            : 'Give any speaker a picture without making a character card. Comma-separate names for aliases.'
    );

    renderFolderBar();
    renderActiveModalView();
}

/**
 * Renders the folder category bar with folder chips and the [+ Folder] button.
 */
function renderFolderBar() {
    const $bar = $('#bj_modal_folder_bar').empty();
    const isColors = activeModalTab === 'colors';
    const currentActive = isColors ? activeColorFolder : activePortraitFolder;
    const folders = isColors ? getColorFolders() : getPortraitFolders();

    // 1. "All" Chip
    const $allChip = $(`
        <button type="button" class="bj-folder-chip${currentActive === ALL_FOLDERS ? ' active' : ''}" data-folder="${ALL_FOLDERS}" title="Show all entries">
            <i class="fa-solid fa-layer-group"></i>
            <span>All</span>
        </button>
    `);
    $allChip.on('click', () => {
        if (isColors) { activeColorFolder = ALL_FOLDERS; overridePage = 0; }
        else { activePortraitFolder = ALL_FOLDERS; portraitPage = 0; }
        renderFolderBar();
        renderActiveModalView();
    });
    $bar.append($allChip);

    // 2. "Default" Chip
    const $defaultChip = $(`
        <button type="button" class="bj-folder-chip${currentActive === DEFAULT_FOLDER ? ' active' : ''}" data-folder="${DEFAULT_FOLDER}" title="Default category">
            <i class="fa-solid fa-folder"></i>
            <span>Default</span>
        </button>
    `);
    $defaultChip.on('click', () => {
        if (isColors) { activeColorFolder = DEFAULT_FOLDER; overridePage = 0; }
        else { activePortraitFolder = DEFAULT_FOLDER; portraitPage = 0; }
        renderFolderBar();
        renderActiveModalView();
    });
    $bar.append($defaultChip);

    // 3. Custom User Folders
    for (const f of folders) {
        if (f === DEFAULT_FOLDER) continue;
        const isActive = currentActive === f;
        const $wrap = $(`
            <div class="bj-folder-chip-wrap${isActive ? ' active' : ''}">
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
            const folder = $(this).data('folder');
            if (isColors) { activeColorFolder = folder; overridePage = 0; }
            else { activePortraitFolder = folder; portraitPage = 0; }
            renderFolderBar();
            renderActiveModalView();
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
            if (confirmed) deleteFolder(folder, isColors ? 'colors' : 'portraits');
        });

        $bar.append($wrap);
    }

    // 4. [+ Folder] Button
    const tabLabel = isColors ? 'color' : 'portrait';
    const $addBtn = $(`
        <button type="button" class="bj-btn-folder-add" id="bj_modal_add_folder" title="Create new ${tabLabel} category">
            <i class="fa-solid fa-folder-plus"></i>
            <span>+ Folder</span>
        </button>
    `);
    $addBtn.on('click', async () => {
        let name = '';
        try {
            const popup = new Popup(`<h3>Create New ${isColors ? 'Color' : 'Portrait'} Category</h3>`, POPUP_TYPE.INPUT, '', {
                okButton: 'Create',
                cancelButton: 'Cancel',
                placeholder: 'Category name (e.g. DC, Overlord)',
            });
            const result = await popup.show();
            if (popup.result === POPUP_RESULT.AFFIRMATIVE && typeof result === 'string') {
                name = result.trim();
            }
        } catch {
            name = (window.prompt(`Enter new ${isColors ? 'color' : 'portrait'} category name:`) ?? '').trim();
        }

        if (name && addFolder(name, isColors ? 'colors' : 'portraits')) {
            if (isColors) {
                activeColorFolder = name;
                overridePage = 0;
            } else {
                activePortraitFolder = name;
                portraitPage = 0;
            }
            renderFolderBar();
            renderActiveModalView();
        }
    });
    $bar.append($addBtn);
}

/**
 * Renders the active tab's card list into the modal body with pagination.
 */
function renderActiveModalView() {
    const isColors = activeModalTab === 'colors';
    const $body = $('#bj_modal_body').empty();

    if (isColors) {
        const entries = filteredOverrideEntries();
        const pageCount = Math.max(1, Math.ceil(entries.length / OVERRIDES_PER_PAGE));
        overridePage = Math.min(Math.max(0, overridePage), pageCount - 1);

        if (entries.length === 0) {
            const activeFolder = activeColorFolder;
            const folderText = activeFolder === ALL_FOLDERS ? '' : ` in ${escapeHtml(activeFolder)}`;
            $body.append(`
                <div class="bj-empty-state">
                    <i class="fa-solid fa-palette bj-empty-icon"></i>
                    <div class="bj-empty-title">No color overrides found${folderText}</div>
                    <div class="bj-empty-desc">Click "+ Add Override" to define a custom color for any speaker.</div>
                </div>
            `);
        } else {
            const start = overridePage * OVERRIDES_PER_PAGE;
            for (const [name, hex] of entries.slice(start, start + OVERRIDES_PER_PAGE)) {
                $body.append(makeOverrideCard(name, hex));
            }
        }

        $('#bj_modal_page_label').text(`${overridePage + 1} / ${pageCount}`);
        $('#bj_modal_prev').toggleClass('disabled', overridePage <= 0);
        $('#bj_modal_next').toggleClass('disabled', overridePage >= pageCount - 1);

        const total = Object.keys(getSettings().colorOverrides).length;
        const activeFolder = activeColorFolder;
        const inFolder = entries.length;
        const folderNote = activeFolder === ALL_FOLDERS ? '' : ` in ${activeFolder}`;
        $('#bj_modal_footer_count').text(`${inFolder} override${inFolder === 1 ? '' : 's'}${folderNote} (${total} total)`);
    } else {
        const entries = filteredPortraitEntries();
        const pageCount = Math.max(1, Math.ceil(entries.length / PORTRAITS_PER_PAGE));
        portraitPage = Math.min(Math.max(0, portraitPage), pageCount - 1);

        if (entries.length === 0) {
            const activeFolder = activePortraitFolder;
            const folderText = activeFolder === ALL_FOLDERS ? '' : ` in ${escapeHtml(activeFolder)}`;
            $body.append(`
                <div class="bj-empty-state">
                    <i class="fa-solid fa-image-portrait bj-empty-icon"></i>
                    <div class="bj-empty-title">No portraits found${folderText}</div>
                    <div class="bj-empty-desc">Click "+ Add Portrait" to assign an avatar thumbnail to any speaker.</div>
                </div>
            `);
        } else {
            const start = portraitPage * PORTRAITS_PER_PAGE;
            for (const entry of entries.slice(start, start + PORTRAITS_PER_PAGE)) {
                $body.append(makePortraitCard(entry));
            }
        }

        $('#bj_modal_page_label').text(`${portraitPage + 1} / ${pageCount}`);
        $('#bj_modal_prev').toggleClass('disabled', portraitPage <= 0);
        $('#bj_modal_next').toggleClass('disabled', portraitPage >= pageCount - 1);

        const total = getSettings().portraits.length;
        const activeFolder = activePortraitFolder;
        const inFolder = entries.length;
        const folderNote = activeFolder === ALL_FOLDERS ? '' : ` in ${activeFolder}`;
        $('#bj_modal_footer_count').text(`${inFolder} portrait${inFolder === 1 ? '' : 's'}${folderNote} (${total} total)`);
    }
}

/**
 * Builds one color override card.
 *
 * @param {string} name Speaker name
 * @param {string|object} val Color hex or { hex, folder }
 * @returns {jQuery}
 */
function makeOverrideCard(name, val) {
    const parsed = parseColorOverride(val);
    let currentKey = name;
    let currentColor = parsed.hex;
    let currentFolder = parsed.folder;

    const folders = getColorFolders();
    const optionsHtml = folders.map(f =>
        `<option value="${escapeHtml(f)}"${f === currentFolder ? ' selected' : ''}>${escapeHtml(f)}</option>`
    ).join('');

    const $card = $(`
        <div class="bj-item-card bj-color-card">
            <input type="text" class="bj-input bj-override-name" placeholder="Speaker name(s)">
            <select class="bj-folder-select" title="Move to category">
                ${optionsHtml}
            </select>
            <div class="bj-color-input-wrap">
                <input type="color" class="bj-color-picker bj-override-color">
                <input type="text" class="bj-input bj-hex-input" spellcheck="false" autocomplete="off" maxlength="7" title="Type a hex color (#rrggbb) and press Enter">
            </div>
            <button type="button" class="bj-btn-icon bj-btn-danger bj-override-remove" title="Remove override">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `);

    const $nameInput = $card.find('.bj-override-name').val(name);
    const $colorInput = $card.find('.bj-override-color').val(currentColor);
    const $hexInput = $card.find('.bj-hex-input').val(currentColor);
    const $folderSelect = $card.find('.bj-folder-select');

    $folderSelect.on('change', function () {
        currentFolder = this.value;
        getSettings().colorOverrides[currentKey] = { hex: currentColor, folder: currentFolder };
        persistAndRedecorate();
        if (activeColorFolder !== ALL_FOLDERS && activeColorFolder !== currentFolder) {
            renderActiveModalView();
        }
    });

    // Picker drags update the hex text live.
    $colorInput.on('input change', function () {
        $hexInput.val(this.value);
        currentColor = this.value;
        getSettings().colorOverrides[currentKey] = { hex: currentColor, folder: currentFolder };
        persistAndRedecorate();
    });

    // Typed hex commits on Enter or blur. A missing '#' is forgiven; anything
    // that is not a color reverts to the one in force.
    const commitHex = () => {
        let val = String($hexInput.val() ?? '').trim();
        if (/^[0-9a-f]{6}$/i.test(val)) val = `#${val}`;
        if (HEX_COLOR.test(val)) {
            val = val.toLowerCase();
            $hexInput.val(val);
            $colorInput.val(val);
            currentColor = val;
            getSettings().colorOverrides[currentKey] = { hex: currentColor, folder: currentFolder };
            persistAndRedecorate();
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
        delete settings.colorOverrides[currentKey];
        currentKey = next;
        settings.colorOverrides[currentKey] = { hex: currentColor, folder: currentFolder };
        persistAndRedecorate();
    });

    $card.find('.bj-override-remove').on('click', () => {
        delete getSettings().colorOverrides[currentKey];
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
        if (activePortraitFolder !== ALL_FOLDERS && activePortraitFolder !== entry.folder) {
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
        if (activeModalTab === 'colors') {
            overrideSearchTerm = this.value;
            overridePage = 0;
        } else {
            portraitSearchTerm = this.value;
            portraitPage = 0;
        }
        renderActiveModalView();
    });

    // Pagination
    $('#bj_modal_prev').on('click', () => {
        if (activeModalTab === 'colors') {
            if (overridePage > 0) { overridePage--; renderActiveModalView(); }
        } else {
            if (portraitPage > 0) { portraitPage--; renderActiveModalView(); }
        }
    });

    $('#bj_modal_next').on('click', () => {
        if (activeModalTab === 'colors') {
            const pageCount = Math.max(1, Math.ceil(filteredOverrideEntries().length / OVERRIDES_PER_PAGE));
            if (overridePage < pageCount - 1) { overridePage++; renderActiveModalView(); }
        } else {
            const pageCount = Math.max(1, Math.ceil(filteredPortraitEntries().length / PORTRAITS_PER_PAGE));
            if (portraitPage < pageCount - 1) { portraitPage++; renderActiveModalView(); }
        }
    });

    // Add new item
    $('#bj_modal_add').on('click', () => {
        if (activeModalTab === 'colors') {
            const map = getSettings().colorOverrides;
            const targetFolder = (activeColorFolder === ALL_FOLDERS || !activeColorFolder)
                ? DEFAULT_FOLDER
                : activeColorFolder;
            let name = 'New speaker';
            let n = 2;
            while (map[name] !== undefined) name = `New speaker ${n++}`;
            map[name] = { hex: '#b39ddb', folder: targetFolder };
            overrideSearchTerm = '';
            $('#bj_modal_search').val('');
            const entries = filteredOverrideEntries();
            overridePage = Math.max(0, Math.ceil(entries.length / OVERRIDES_PER_PAGE) - 1);
            renderActiveModalView();
            $('#bj_modal_body .bj-color-card').last().find('.bj-override-name').trigger('focus').select();
            persistAndRedecorate();
        } else {
            const list = getSettings().portraits;
            const targetFolder = (activePortraitFolder === ALL_FOLDERS || !activePortraitFolder)
                ? DEFAULT_FOLDER
                : activePortraitFolder;
            list.push({ names: 'New speaker', image: PORTRAIT_PLACEHOLDER, folder: targetFolder });
            portraitSearchTerm = '';
            $('#bj_modal_search').val('');
            const entries = filteredPortraitEntries();
            portraitPage = Math.max(0, Math.ceil(entries.length / PORTRAITS_PER_PAGE) - 1);
            renderActiveModalView();
            $('#bj_modal_body .bj-portrait-card').last().find('.bj-portrait-names').trigger('focus').select();
            persistAndRedecorate();
        }
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
