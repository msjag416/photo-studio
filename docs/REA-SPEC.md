# Photo Studio: outside-in study and build spec

This file is the study of the reference photo editor (studied from the outside only) and the plan for our own app. No code, images, logo, wording, colours or name from the reference app are used.

Source of every OBSERVED finding: the owner's written screenshot notes ("WHAT I ALREADY KNOW FROM MY SCREENSHOTS"). Each one is tagged with the screen the note describes, for example `[Notes: Home]`.

---

## 1. Checklist (with status after the study)

| # | Question | Status |
|---|---|---|
| 1 | What is on the home screen? | Partly answered (tiles exist, their exact list is unknown) |
| 2 | What does the Create (+) menu contain? | Answered |
| 3 | Which preset canvas sizes exist? | Open |
| 4 | Is there a list of saved projects on home? | Open |
| 5 | How is the editor laid out (top bar, canvas, panel)? | Answered |
| 6 | How is a layer selected, moved, resized, rotated? | Answered |
| 7 | What tools does the photo panel hold, and in what order? | Answered (top two known, rest listed) |
| 8 | How does Remove Background work and look? | Answered |
| 9 | How does the edge fix (refine) brush work? | Partly answered (erase/restore known, brush size control unknown) |
| 10 | How does Remove Objects work? | Answered |
| 11 | What controls does Outline have? | Answered |
| 12 | What controls does Shadow have? | Open |
| 13 | What sliders does Adjust have? | Answered |
| 14 | What filters exist? | Open (count and names) |
| 15 | How do Crop and Expand work (ratios, fill)? | Open |
| 16 | What do Blur background, Enhance, Rounded corners, Opacity, Nudge control? | Partly answered (names only) |
| 17 | How does Text work (typing, fonts, colour, alignment)? | Answered |
| 18 | What does the Layers panel let you do (reorder, hide, delete, duplicate)? | Open |
| 19 | How do undo and redo behave (what counts as a step)? | Partly answered |
| 20 | What save formats and sizes exist? | Partly answered (PNG and JPG known, size options unknown) |
| 21 | What data is stored, and where? | Inferred (see section 4) |

---

## 2. Findings, feature by feature

| Feature | Finding | Label | Source |
|---|---|---|---|
| Home | Quick-start tiles on the home screen | OBSERVED | Notes: Home |
| Home | A large + button opens a Create menu | OBSERVED | Notes: Home |
| Home | Create menu: photo, blank canvas in preset sizes, shortcut straight to background removal | OBSERVED | Notes: Home |
| Home | The background removal shortcut opens a photo and runs removal right away | INFERRED | |
| Home | A list of past projects on home | UNKNOWN | |
| Editor | Canvas in the middle of the screen | OBSERVED | Notes: Editor |
| Editor | Top bar: back, undo, redo, add photo, add text, layers, save | OBSERVED | Notes: Editor |
| Editor | Tapping a photo selects it, shows corner handles and a rotate handle | OBSERVED | Notes: Editor |
| Editor | Selecting a photo opens a side panel of tools | OBSERVED | Notes: Editor |
| Editor | Dragging moves, corners scale, rotate handle turns the layer | INFERRED | |
| Editor | Tapping empty canvas deselects and closes the panel | INFERRED | |
| Editor | Two-finger pinch to zoom the canvas view | UNKNOWN | |
| Panel | Remove Background and Remove (objects) sit at the top of the panel | OBSERVED | Notes: Editor |
| Remove BG | One tap, result appears right on the canvas | OBSERVED | Notes: Remove Background |
| Remove BG | Removed area shows as a checkerboard | OBSERVED | Notes: Remove Background |
| Remove BG | A floating "refine" button appears after removal | OBSERVED | Notes: Remove Background |
| Remove BG | The original photo is kept so the brush can restore it | INFERRED | |
| Refine | Opens an erase / restore brush to fix edges | OBSERVED | Notes: Remove Background |
| Refine | Has a brush size control and its own done/cancel | INFERRED | |
| Remove obj | Opens its own full screen | OBSERVED | Notes: Remove objects |
| Remove obj | Brush size slider and a hint to mark what you want removed | OBSERVED | Notes: Remove objects |
| Remove obj | Paint over the object, it disappears, the gap fills to match | OBSERVED | Notes: Remove objects |
| Remove obj | Undo, cancel and a check mark to apply | OBSERVED | Notes: Remove objects |
| Remove obj | The fill runs when the finger lifts | INFERRED | |
| Remove obj | Can be repeated many times before applying | INFERRED | |
| Other tools | Blur background, enhance, adjust, filters, rounded corners, outline, shadow, opacity, nudge, crop, expand | OBSERVED | Notes: Other photo tools |
| Adjust | Brightness, contrast, saturation, warmth | OBSERVED | Notes: Other photo tools |
| Outline | Thickness, gap, colour swatches, colour picker, eyedropper | OBSERVED | Notes: Other photo tools |
| Outline | Outline follows the cut-out shape, not the box | INFERRED | |
| Shadow | Controls (blur, distance, angle, colour, strength) | UNKNOWN | |
| Blur bg | Blurs everything except the person | INFERRED | |
| Enhance | One tap auto boost of light, colour and sharpness | INFERRED | |
| Nudge | Arrow buttons move the layer a small step | INFERRED | |
| Expand | Makes the canvas larger around the photo | INFERRED (fill method UNKNOWN) | |
| Text | Full-screen typing | OBSERVED | Notes: Text |
| Text | Row of font styles, colour, alignment | OBSERVED | Notes: Text |
| Layers | A layers button in the top bar | OBSERVED | Notes: Editor |
| Layers | Reorder, hide, delete, duplicate | INFERRED | |
| Save | PNG keeps see-through areas, JPG also offered | OBSERVED | Notes: Save |
| Save | Size or quality choices | UNKNOWN | |

---

## 3. Gaps we will fill with our own choices (not copied)

Because these are UNKNOWN, we pick simple defaults of our own:

* Preset canvas sizes: Square 1080x1080, Story 1080x1920, Post 1080x1350, Landscape 1920x1080.
* Home: Create button plus quick tiles (Remove background, Remove objects, Blank canvas) and a "Recent" row of projects saved on the device.
* Shadow: blur, distance, angle, colour, strength.
* Filters: about 8 of our own, built from simple colour math.
* Crop: free, 1:1, 4:5, 9:16, 16:9. Expand: adds see-through space around the canvas (no AI fill in version 1).
* Layers: reorder (up/down), hide, duplicate, delete.
* Save: full size; JPG at 92% quality on a white background.

Optional screenshots if you want a closer match later (not needed to start): Create menu showing the canvas sizes; the Shadow panel; the Filters row; the Crop screen; the Layers panel open; the Save screen.

---

## 4. Data the app stores

Everything stays on the device (browser IndexedDB). Nothing is uploaded.

**Project**: id, name, canvas width, canvas height, background colour (or see-through), list of layers, thumbnail, created time, updated time.

**Layer** (photo): id, type "photo", original image (kept for restore), current image (after background or object removal), cut-out mask, x, y, scale, rotation, flip, opacity, hidden flag, adjust values (brightness, contrast, saturation, warmth), filter name, blur background amount, rounded corner radius, outline (on, thickness, gap, colour), shadow (on, blur, distance, angle, colour, strength), crop box.

**Layer** (text): id, type "text", words, font, colour, alignment, size, x, y, scale, rotation, opacity, hidden flag.

**History**: a list of past project states for undo and a list for redo, kept in memory only (up to about 30 steps). Each finished action (a slider let go, a brush stroke applied, a layer moved) is one step.

Screens that create or change data: Create menu makes a Project. Add photo / Add text makes a Layer. Every tool changes a Layer. Undo/redo swaps the whole project state. Save reads the project and makes a file.

---

## 5. Build this

**Name and look (our own):** "Photo Studio". Light warm background, one teal accent colour, rounded buttons with simple line icons drawn by us, system font.

**Tech:** One static website, plain HTML, CSS and JavaScript, no build step. Works in Safari and Chrome on iPad and iPhone. Hosted free on GitHub Pages.

**Screens**
1. Home: Create (+) button that opens a menu (Open photo, Blank canvas with 4 sizes, Remove background shortcut), quick tiles, and Recent projects.
2. Editor: top bar (back, undo, redo, add photo, add text, layers, save), canvas in the middle, tool panel (side panel on iPad, bottom sheet on iPhone) when a layer is selected. Remove Background and Remove Objects are the first two, large buttons in the panel.
3. Remove Objects screen: full screen photo, brush size slider, hint text, undo, cancel, apply.
4. Text screen: full-screen typing, font row, colour, alignment.
5. Save sheet: PNG or JPG.

**AI parts (run free in the browser)**
* onnxruntime-web, WebAssembly CPU engine, single thread. WebGL only as a backup.
* Background removal: U2-Net-p (u2netp.onnx, 4.5 MB, 320x320 input). Result mask is scaled back up and smoothed, then used as the cut-out.
* Edge fix: brush paints on the cut-out mask. Erase hides, Restore brings back the original pixels.
* Object removal: MI-GAN (MIT licence, 512x512, mask 255 = keep, 0 = remove). Crop about 2.2x the painted area, run the model, blend the patch back with soft edges.
* Model files are stored in the site itself so they load from the same address.

**Phone rules**
* Open photos with a `<label>` tied to a file input.
* Shrink photos to about 2000 px on the long side.
* Any error shows on screen in plain words with a short "Details" line.

**Build order (follows the must-have list)**
1. Home, open photo, editor canvas with select/move/resize/rotate.
2. Remove background, then the edge fix brush.
3. Remove objects screen.
4. Outline and shadow.
5. Adjust, filters, crop.
6. Text.
7. Layers panel, undo/redo.
8. Save PNG/JPG. Then the smaller tools (blur bg, enhance, rounded corners, opacity, nudge, expand) and Recent projects.

**Testing before calling it done**
Playwright with WebKit (Safari engine) and Chromium at iPad (820x1180) and iPhone (390x844) sizes, using a real photo of a person. Steps: open photo, remove background, fix edges, remove an object, outline, text, undo, save. Screenshots of each step are checked by eye.
