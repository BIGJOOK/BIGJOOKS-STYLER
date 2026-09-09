import { getContext } from '../../../st-context.js';
import { user_avatar } from '../../../personas.js';

/** CSS custom property carrying each speech block's speaker color. */
const COLOR_PROP = '--bj-color';

/** Every class this extension can leave behind — the clear pass removes them all. */
const ALL_CLASSES = [
    'bj-speech', 'bj-colored', 'bj-name',
    'bj-div', 'bj-div-thin', 'bj-div-dashed', 'bj-div-fade',
];

/** Selectable divider styles; anything unexpected falls back to 'thin'. */
const DIVIDER_STYLES = new Set(['thin', 'dashed', 'fade', 'none']);

/** A bold tag longer than this is a sentence, not a speaker name. */
const NAME_MAX_LENGTH = 40;

/** Names that end like a sentence are emphasis, not speaker tags. */
const SENTENCE_END = /[.!?…。"」』]$/;

/** A plain-text speaker line: a run of characters, then the first colon. */
const PLAIN_SPEAKER = /^[^:\n]{1,80}:/;

/** Plain names must open with a letter (rejects "- Item" / "1. Foo" list lines). */
const NAME_START = /^\p{L}/u;

/** Plain names may hold letters, digits, spaces, apostrophes, periods, hyphens. */
const NAME_CHARS = /^[\p{L}\p{N}\s.'\-]+$/u;

/** Valid override colors. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Inline portrait images we are willing to render (svg excluded so the panel's
 *  placeholder preview can never be mistaken for a chosen picture). */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)/i;

/**
 * The palette an unknown speaker hashes onto — pastels and purples only,
 * because this chat gets read at night. Nothing harsh, nothing yellow.
 */
const PALETTE = Object.freeze([
    '#b39ddb', '#9fa8da', '#ce93d8', '#f48fb1', '#f8bbd0', '#ef9a9a',
    '#ffab91', '#90caf9', '#80deea', '#80cbc4', '#a5d6a7', '#b0bec5',
]);

/**
 * The color a speaker lands on: a manual override wins, otherwise their name
 * hashes onto the palette. The hash is pure, so the same speaker is the same
 * color in every message, in every chat, forever.
 *
 * @param {string} speaker
 * @param {object} settings
 * @returns {string} Hex color.
 */
export function resolveSpeakerColor(speaker, settings) {
    const wanted = String(speaker).toLowerCase();
    const overrides = settings?.colorOverrides ?? {};
    for (const [names, val] of Object.entries(overrides)) {
        const hex = typeof val === 'object' && val !== null ? val.hex : val;
        if (!HEX_COLOR.test(String(hex))) continue;
        for (const raw of String(names).split(',')) {
            if (raw.trim().toLowerCase() === wanted) return hex;
        }
    }
    return hashNameToPalette(speaker);
}

function hashNameToPalette(name) {
    let index = 0;
    for (const ch of String(name)) index = (index * 31 + ch.codePointAt(0)) % PALETTE.length;
    return PALETTE[index];
}

/**
 * The avatar URL for a speaker, when they have a real image, in order: a
 * character card (group members are all in the characters list), the user
 * persona, or a portrait assigned in settings — which also covers aliases a
 * card's exact name misses ("Diana" wearing the Wonder Woman picture) and
 * speakers with no card at all. Everyone else gets nothing — color and
 * dividers only, never a placeholder.
 *
 * @param {string} speaker
 * @param {object|null} mes The chat record for the message being decorated.
 * @param {{ ctx: object, charByName: Map<string, string>, portraitByName: Map<string, string>, userName: string }} cache
 * @returns {string|null} Null means no avatar.
 */
function resolveSpeakerAvatar(speaker, mes, cache) {
    const wanted = String(speaker).toLowerCase();

    const file = cache.charByName.get(wanted);
    if (file) return cache.ctx.getThumbnailUrl('avatar', file);

    if (wanted === cache.userName) {
        // Empty means no persona image selected — better no avatar than a broken one.
        return user_avatar ? cache.ctx.getThumbnailUrl('persona', user_avatar) : null;
    }

    // A user message written under a different persona keeps that persona's face.
    if (mes?.is_user
        && String(mes.force_avatar ?? '').includes('type=persona')
        && wanted === String(mes.name ?? '').toLowerCase()) {
        return mes.force_avatar;
    }

    const portrait = cache.portraitByName.get(wanted);
    if (portrait) return portrait;

    return null;
}

/**
 * Everything speaker resolution needs from the context, built once per pass
 * instead of once per paragraph.
 *
 * @param {object} ctx
 * @param {object} settings
 */
function buildSpeakerCache(ctx, settings) {
    const charByName = new Map();   // lowercase card name → avatar filename
    for (const ch of ctx?.characters ?? []) {
        if (ch?.name && ch.avatar && ch.avatar !== 'none') {
            charByName.set(String(ch.name).toLowerCase(), ch.avatar);
        }
    }
    // A portrait row may carry several comma-separated names (aliases); every
    // one of them points at the same picture.
    const portraitByName = new Map();   // lowercase speaker name → inline data URI
    for (const entry of settings?.portraits ?? []) {
        const image = String(entry?.image ?? '');
        if (!DATA_IMAGE.test(image)) continue;
        for (const raw of String(entry?.names ?? '').split(',')) {
            const name = raw.trim().toLowerCase();
            if (name) portraitByName.set(name, image);
        }
    }
    return { ctx, charByName, portraitByName, userName: String(ctx?.name1 ?? '').toLowerCase() };
}

/**
 * Finds the speaker paragraphs in a rendered message body, bold or plain:
 * `**Name**: dialogue` and `Name: dialogue` both count.
 *
 * Bold path — the paragraph's first meaningful child is a bold tag (strong/b;
 * italics are action beats in this format, never speaker tags) holding a
 * plausible name, with the colon inside the tag (`<strong>Name:</strong>`) or
 * as the first non-space character after it (`<strong>Name</strong>: "..."`).
 *
 * Plain path — the first meaningful child is a text node opening with
 * `Name:`, where the run before the colon reads as a name: starts with a
 * letter, only name-ish characters, same plausibility guards as bold. This is
 * deliberately generous — a narration paragraph that happens to open with
 * `Word:` will be styled as speech too; in a script-formatted chat, a
 * paragraph-initial colon line is a speaker far more often than it is prose.
 *
 * Paragraph-initial only either way, so names mid-paragraph never turn
 * narration into speech. tagEl is the bold tag when there was one, null for
 * plain speakers (their bare name simply inherits the paragraph's color).
 *
 * @param {Element} mesTextEl
 * @returns {{ block: Element, tagEl: Element|null, speaker: string }[]}
 */
function detectSpeechBlocks(mesTextEl) {
    const found = [];
    for (const node of mesTextEl.children) {
        // Only paragraphs are examined — code blocks and raw images are never speech.
        if (node.tagName !== 'P') continue;

        const first = firstMeaningfulChild(node);

        if (first && (first.tagName === 'STRONG' || first.tagName === 'B')) {
            if (first.querySelector('img')) continue;
            const raw = first.textContent.trim();
            const name = raw.endsWith(':') ? raw.slice(0, -1).trim() : raw;
            if (isPlausibleName(name) && colonFollows(first, raw)) {
                found.push({ block: node, tagEl: first, speaker: name });
            }
            continue;
        }

        if (first && first.nodeType === Node.TEXT_NODE) {
            const match = first.textContent.match(PLAIN_SPEAKER);
            if (!match) continue;
            const name = first.textContent.slice(0, match[0].length - 1).trim();
            if (isPlausibleName(name) && NAME_START.test(name) && NAME_CHARS.test(name)) {
                found.push({ block: node, tagEl: null, speaker: name });
            }
        }
    }
    return found;
}

/** First child that is real content — skips whitespace text and HTML comments. */
function firstMeaningfulChild(p) {
    for (const child of p.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && !child.textContent.trim()) continue;
        if (child.nodeType === Node.COMMENT_NODE) continue;
        return child;
    }
    return null;
}

function isPlausibleName(name) {
    return name.length > 0 && name.length <= NAME_MAX_LENGTH && !SENTENCE_END.test(name);
}

/** Whether a colon sits immediately after the bold tag (or ends its own text). */
function colonFollows(strong, rawText) {
    if (rawText.endsWith(':')) return true;
    for (let s = strong.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === Node.COMMENT_NODE) continue;
        if (s.nodeType === Node.TEXT_NODE) return /^\s*:/.test(s.textContent);
        return false;   // any real element before the colon means this is not a speaker line
    }
    return false;
}

/** Avatar size stops: 1 Small · 2 Medium · 3 Large · 4 Extra large · 5 Super large. */
const AVATAR_SIZE_MIN = 1;
const AVATAR_SIZE_MAX = 5;
const AVATAR_SIZE_DEFAULT = 2;

/** The circular avatar chip placed before a speaker's name. */
function makeAvatar(speaker, url, size) {
    const img = document.createElement('img');
    img.className = `bj-avatar bj-size-${size}`;
    img.src = url;
    img.alt = speaker;
    img.loading = 'lazy';
    img.setAttribute('aria-hidden', 'true');
    return img;
}

/**
 * Decorates one message element: strip old decorations, find the speech
 * paragraphs, resolve each speaker's color and avatar, apply classes. Purely
 * display layer — the stored chat is never touched.
 *
 * @param {Element} mesEl A `.mes` element from #chat.
 * @param {object} settings Extension settings snapshot.
 */
export function decorateMessage(mesEl, settings) {
    const mesTextEl = mesEl?.querySelector?.('.mes_text');
    if (!mesTextEl) return;

    // Strip first: re-renders usually hand us clean HTML, but settings toggles
    // and element-reusing update paths make this pass idempotent.
    clearMessageDecorations(mesTextEl);

    // Master switch off: clearing was the whole job.
    if (!settings?.enabled) return;

    const ctx = getContext();
    const cache = buildSpeakerCache(ctx, settings);
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
    const mes = chat ? chat[Number(mesEl.getAttribute('mesid'))] : null;

    const dividerStyle = DIVIDER_STYLES.has(settings.dividerStyle) ? settings.dividerStyle : 'thin';
    const avatarSize = Math.min(AVATAR_SIZE_MAX, Math.max(AVATAR_SIZE_MIN, Number(settings.avatarSize) || AVATAR_SIZE_DEFAULT));

    for (const { block, tagEl, speaker } of detectSpeechBlocks(mesTextEl)) {
        block.classList.add('bj-speech');

        if (settings.colorSpeech) {
            block.classList.add('bj-colored');
            block.style.setProperty(COLOR_PROP, resolveSpeakerColor(speaker, settings));
        }

        if (tagEl) tagEl.classList.add('bj-name');

        if (settings.showAvatars) {
            const url = resolveSpeakerAvatar(speaker, mes, cache);
            if (url) block.insertBefore(makeAvatar(speaker, url, avatarSize), block.firstChild);
        }

        if (settings.showDividers && dividerStyle !== 'none') {
            block.classList.add('bj-div', `bj-div-${dividerStyle}`);
        }
    }
}

/**
 * Removes every trace of a previous decoration pass from a message body.
 *
 * @param {Element} mesTextEl
 */
export function clearMessageDecorations(mesTextEl) {
    if (!mesTextEl) return;

    mesTextEl.querySelectorAll('img.bj-avatar').forEach(img => img.remove());

    mesTextEl.querySelectorAll('.bj-speech, .bj-colored, .bj-name, .bj-div, .bj-div-thin, .bj-div-dashed, .bj-div-fade')
        .forEach(el => el.classList.remove(...ALL_CLASSES));

    mesTextEl.querySelectorAll('[style*="--bj-color"]').forEach(el => el.style.removeProperty(COLOR_PROP));
}

/** Bumped by every chat-wide pass; an in-flight batch whose token is stale aborts. */
let runToken = 0;

/**
 * Decorates every message in the chat, in requestAnimationFrame batches so a
 * long history never blocks the UI.
 *
 * @param {() => object} getSettings Live settings accessor from index.js.
 */
export function decorateAll(getSettings) {
    const token = ++runToken;
    const settings = getSettings();
    const messages = [...document.querySelectorAll('#chat .mes')];
    const CHUNK = 5;

    const step = (i) => {
        // A newer pass (chat switch, settings change) superseded this one.
        if (token !== runToken) return;
        for (const el of messages.slice(i, i + CHUNK)) {
            try {
                decorateMessage(el, settings);
            } catch (err) {
                console.debug('[BIGJOOKS] decorate failed on a message', err);
            }
        }
        if (i + CHUNK < messages.length) requestAnimationFrame(() => step(i + CHUNK));
    };

    step(0);
}
