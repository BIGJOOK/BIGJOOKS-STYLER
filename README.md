# BIGJOOKS Styler

**Colors, dividers, and faces for your dialogue — with zero prompt bloat.**

BIGJOOKS Styler is a display-only SillyTavern extension that makes script-format
chats beautiful. It detects speaker lines (`**Name**: dialogue` or plain
`Name: dialogue`) and decorates them per character — while never modifying a
single byte of your stored chat, injecting nothing into your prompt, and
costing zero tokens.

## Features

### 🎨 Per-Speaker Colors
- Every speaker gets a stable, deterministic pastel color — same name, same
  color, in every message and every chat, with zero configuration.
- Manual **color overrides**: pick from the swatch or type an exact hex code.
- **Comma-separated aliases**: `Wonder Woman, Diana, Diana Prince` — all her
  names share one color. Matching is case-insensitive.

### ➖ Thin Dividers
Dialogue paragraphs are visually separated from narration and each other.
Four styles: thin, dashed, fade, none.

### 🙂 Speaker Avatars
- Characters with a **character card** (including group-chat members) and your
  **persona** get a small avatar next to their dialogue automatically.
- **Speaker portraits**: give *any* speaker a picture — no character card
  needed. Images are downscaled to lightweight thumbnails automatically.
- Avatar size slider from Small to *gloriously huge* (Super large).
- Unknown NPCs stay clean — no placeholder clutter.

### 🗂️ A Real Library
Manage everything in a floating dark-glass window (ST-Copilot aesthetic):
- Tabs for **Color Overrides** and **Speaker Portraits**
- **Independent folder categories** per tab (e.g. `DC`, `Overlord`, `Pathfinder`)
- Live search, pagination, entry counts
- Everything saves instantly — closing the window loses nothing

### 🧠 Smart & Safe
- Styles appear the moment generation finishes; streaming stays untouched and
  lag-free.
- Old chats with model-written `<font color>` tags? Inside styled speech the
  speaker's color wins automatically.
- Deleting a folder never deletes characters — they safely return to `Default`.

## Installation

**Method 1 — SillyTavern Extension Installer**
1. SillyTavern → **Extensions** → **Install Extension**
2. Paste: `https://github.com/BIGJOOK/BIGJOOKS-STYLER`
3. Save / Install, then hard-refresh (Ctrl+F5).

**Method 2 — Manual clone**
```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/BIGJOOK/BIGJOOKS-STYLER bigjooks-styler
```
Reload SillyTavern.

## Quick Start
1. Make sure your preset asks the model for script-format dialogue
   (`**Name**: "..."` per paragraph). Most script-format presets already do.
2. Open **Extensions → BIGJOOKS Styler** — it works out of the box.
3. Click **Color library** or **Portrait gallery** to customize.

## Requirements & Notes
- SillyTavern 1.18+
- Speaker detection is paragraph-initial: `**Name**:` (bold) or `Name:`
  (plain text) at the start of a paragraph. Plain-text detection is generous —
  a narration line that happens to start `Word:` will be styled as speech too.
- All settings (colors, portraits, folders) live in SillyTavern's extension
  storage and survive every update. Portraits are stored as compact 256px
  thumbnails to keep settings light.

## License
MIT
