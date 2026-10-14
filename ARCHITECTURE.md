# How Photo Studio works

Photo Studio is a free photo editor that runs entirely inside your web browser. There's no server and no account, and your photos never leave your device. The two AI tools (remove background and remove objects) also run inside the browser.

## The big picture

The app is a plain website: one page (`index.html`), one style file (`css/app.css`) and a few JavaScript files in `js/`. It has no build step, so the files you see are exactly the files the browser runs. GitHub Pages serves them as a normal web address.

```
index.html         All the screens (home, editor, brush screen, text, crop, sheets)
css/app.css        Colours, layout, iPad side panel, iPhone bottom panel
js/main.js         Starts the app: home screen, Create menu, photo pickers, recent projects
js/editor.js       The editor: canvas, moving/resizing layers, tool panel, layers list, undo/redo, saving
js/render.js       Draws each layer with its effects (colour, filters, cut-out, corners, outline, shadow)
js/ai.js           Runs the two AI models (background removal and object removal)
js/brush.js        Full-screen brush for "Refine edges", "Remove objects" and Retouch
js/retouch.js      The colour math for the Retouch tools (no AI)
js/faces.js        Finds faces (MediaPipe Face Landmarker), gives each one an id, face areas
js/faceshape.js    Face Shape sliders: smooth warps placed with the face points
js/brows.js        Eyebrows: shapes from the face points, styles, drawing, removing the original brows
js/screens.js      Full-screen text typing and the crop screen
js/store.js        Saves projects on the device (browser database called IndexedDB)
js/util.js         Small helpers: picture loading, blur, busy spinner, error box
js/icons.js        The app's own line icons
models/            The two AI model files
vendor/            ONNX Runtime Web, the free engine that runs the AI models
tests/e2e.mjs      Automatic test that clicks through every step in real browsers
```

## What happens when you use it

**Opening a photo.** Every "open photo" button is a `<label>` linked to a hidden file picker, because iPhones and iPads block pickers opened by a script. The photo is turned the right way up and shrunk to about 2000 pixels on its long side, so phones don't run out of memory. A new project is made the same size as the photo.

**The editor.** The canvas in the middle shows the project. Tapping a layer selects it and shows corner handles (resize) and a round handle on top (rotate). Two fingers zoom in and move around the picture like a magnifier, without changing the photo, and a Fit button zooms back out. iPad and iPhone Safari ignore the page setting that stops the whole page zooming, so `main.js` blocks Safari's own pinch and double-tap zoom. Otherwise a pinch would zoom the whole app instead of the photo. The tool panel sits on the right on iPad and at the bottom on iPhone. With nothing selected, it shows canvas options (background colour, add space).

**Remove background.** `ai.js` shrinks the photo to 320 × 320 and runs the U2-Net-p model, which scores how likely each pixel is part of the main subject. That score becomes a "mask" the same size as the photo. Where the mask is clear, the photo is see-through and a checkerboard shows. The original photo is never changed, so "Bring back background" just removes the mask.

**Refine edges.** This opens the brush screen with the cut-out on a checkerboard and a faint copy of the original underneath. Erase paints the mask away, and Restore paints it back. One finger paints, and two fingers zoom and move. The check mark keeps your changes and the X throws them away.

**Remove objects.** You paint over the thing you want gone, and when your finger lifts `ai.js` runs the MI-GAN model. To keep it precise, the app only closes tiny gaps between your strokes and grows the painted area by about 2 pixels, in a round shape, so the removal follows your brush. Zoom in with two fingers for fine work like a single brow hair or a blemish. The whole photo goes to the model, which zooms in on the hole by itself and fills it to match the surroundings. Only the painted area (with soft edges) is taken from the result. You can repeat this as many times as you like, use undo inside the screen, then tap the check mark to keep the result.

**Other tools.** These are drawn by `render.js` each time the picture changes:
* Adjust (brightness, contrast, saturation, warmth), filters and enhance are worked out pixel by pixel.
* Blur background blurs the whole photo and puts a sharp copy of the person back on top. It uses the same AI mask, worked out once.
* Rounded corners clip the picture.
* Outline measures how far every pixel is from the cut-out shape, then colours a ring at the chosen thickness and gap.
* Shadow is added when the layer is placed on the canvas.
* Crop opens its own screen. Expand adds see-through space around the canvas. Nudge moves, flips or straightens.

To stay smooth, the editor draws layers at up to 1400 pixels and remembers the last 40 drawings. Saving always uses the full size.

**Retouch.** The photo panel has a Retouch section with seven tools for photos of people: Smooth skin (Smooth or Smoother), Whiten teeth, Eye colour, Brighten, Makeup (Lips or Blush), Hair colour and Reshape (Move or Restore). Each one opens the same brush screen, with a row to switch tools, the tool's own choices and colour swatches, a Brush size slider and a Strength slider. There's no AI here; `retouch.js` uses simple colour math:
* For every tool except Reshape, the app first makes an "effect picture": the whole photo with the effect applied everywhere. Brushing reveals that picture only where you paint, never stronger than the Strength slider.
* Smooth skin splits the photo into fine texture (pores) and broader shading (wrinkles, blotches), softens only the broader shading, and puts the fine texture back.
* Whiten teeth takes out most of the yellow and lightens clearly (it starts at strength 70), but leaves pink gums and lips alone.
* Eye colour, lip colour and hair colour change the colour but keep the light and dark detail. Eye colour leaves very light and very dark spots alone (whites of the eyes, pupils). Lip colour only colours pinkish-red pixels (much more red than green), so teeth stay white even when the brush goes over them.
* Blush is a soft wash of colour with an extra-soft brush edge. Brighten lifts darker tones more than light ones.
* Reshape > Move is "grab and drag". Where your finger first touches, a round area (the brush circle) is picked up and moves with your finger as one smooth piece, fading out gently at the edge. Each move is redrawn from the photo as it was when your finger went down, so nothing smears, and only that spot moves. That's how you lift one cheek or one lip corner for symmetry. It works inside the larger head area and starts with a wide brush (bigger brush = bigger area). Restore brushes the original photo back.

On every brush screen, two fingers zoom up to 16 times and move around, so small spots like a blemish are easy to brush. Fit zooms back out. Each brush stroke is worked on a copy of the photo. Lifting your finger keeps it, and Undo on the brush screen goes back one stroke. The check mark returns one new picture that replaces the photo, which is one step for the editor's Undo and Redo. It's saved with the project like any photo.

**Patch.** The Patch tool (in the Retouch section) copies one round area of the photo onto another spot, for example a patch of hair moved to the hairline to make a widow's peak. It uses the same full-screen screen as the brushes, so two-finger zoom, Fit, Undo, the X and the check mark work as usual.
* The screen shows two linked circles. The circles open small and have no labels. Drag the dashed circle (copy from) onto what you want to copy and the solid circle (paste here) to where it should go. Touching anywhere else moves Paste here to that spot.
* The preview updates as you drag. The copy has a soft round edge, so it blends in.
* **Patch size** sets the circles' size, **Edge softness** how gently the copy fades in, and **Flip the copy** mirrors it.
* **Stamp patch** keeps it so you can patch again somewhere else. Undo takes back one stamp, and the check mark keeps everything, including an unstamped patch.
* The copy always comes from the photo as it was before that patch (`pastePatch` in `retouch.js`). The result replaces the photo as one step for the editor's Undo and Redo.

**Faces.** As soon as a photo opens, `faces.js` looks for faces in the background with MediaPipe Face Landmarker (free, Apache licence). It runs in the browser and marks 478 points on each face: eyebrows, eyes, lips and the face outline.
* **Finding small faces:** the detector shrinks what it looks at to a small square, so faces in a wide or group photo can become too small to see. So it looks at the whole photo, then at overlapping squares at two sizes, and keeps each person once.
* **Ids and order:** each face gets an id, and faces are numbered left to right.
* **Choosing a face:** when a photo has more than one face, an oval with a number shows on each face. Tap a face, or use the Face 1 / Face 2 buttons in the panel, to choose who to edit.
* **Faces kept apart:** every Retouch tool only works inside the selected face (a slightly larger area for hair colour). So brushing across two people changes only the chosen one.
* **After the photo changes:** if the photo changes (for example after Retouch), the faces are found again and matched to the old ids by position, so each person keeps their settings.

**Eyebrows.** The Eyebrows panel works on the selected face. It has Auto Fix Brows with a Strength slider, a gallery of 11 styles with previews drawn on that person's own face, colours (Match uses the person's own brow colour), sliders (thickness, arch height, length, density, darkness, definition, symmetry, hair texture), Match natural brows, Hold to see before, and Reset brows. How it works (`brows.js`):
* The brows are never painted into the photo. Each face's brow settings are stored on the layer (`layer.brows`, one entry per face id) and the brows are drawn fresh every time the photo is drawn. That's what makes undo, redo, reset, before/after and per-face settings simple.
* The shape comes from the face points. Each brow's centre line and thickness are measured along the eye's own direction. The settings then change it: thicker, longer, a higher or flatter arch, or more like the other brow (symmetry). Match natural brows keeps a quarter of the natural difference.
* A brow is drawn as a soft powder base, multiplied in so the skin's texture still shows, plus hundreds of fine, slightly curved hairs. The hairs point up near the nose and along the brow toward the tail, and they fade in from the inner end. A seeded random number generator places them, so the same face always gets the same hairs, and the preview matches the saved picture.
* Styles with a different shape first remove the original brows. The brow areas are filled from the skin around them, using only skin-coloured pixels: they're averaged at smaller and smaller sizes, then the holes are filled back in from those averages, with a little skin grain added. This copy of the photo is made once (`layer.noBrows`) and saved with the project.
* Limit: no free AI can grow truly photo-real new brow hair, so the hairs are drawn. They look natural at normal viewing size, less so when zoomed far in. On very small faces (brows only a few pixels tall) the removed-brow areas can look patchy.

**Face Shape.** The Face Shape panel works on the selected face. It has sliders for Slim face, Cheeks (slimmer or fuller), Mouth width, Lip fullness, Smile lift and Nose (narrower or wider), plus Hold to see before and Reset face shape. Like the eyebrows, it never changes the photo itself: each face's slider values are stored on the layer (`layer.shape`, one entry per face id) and applied every time the photo is drawn, so undo, redo, reset and saving all work. How it works (`faceshape.js`):
* Each slider adds a few soft "moves" placed with the face points. Slim face pulls the jaw outline toward the middle of the face. Mouth width and nose stretch or squeeze the area around them, along the face's own direction. Smile lift raises the mouth corners.
* For every pixel, the moves near it add up to an offset, and the pixel shows what was at that offset, with smooth sampling between pixels. So the whole area shifts as one smooth piece, evenly on both sides, with no seams.
* Things right next to the face, like earrings or hair at the jaw, can bend slightly at high amounts. Professional apps do the same, and small amounts look most natural.

**Text.** Typing happens on a full screen with a row of fonts, colours and alignment. The text becomes a layer that can be moved, resized, rotated, outlined and shadowed like a photo. Tap selected text again to edit it.

**Undo and redo.** After every finished action, such as letting go of a slider, finishing a move or applying a brush, the editor saves a copy of all layer settings, up to 30 steps. Pictures themselves are never edited in place. Every tool makes a new picture, so the steps can share pictures and use little memory.

**Saving.** Save draws the whole project at full size. PNG keeps see-through areas. JPG puts a white background behind them. On iPhone and iPad a "Share or save to Photos" button also appears.

**Projects on the device.** When you leave the editor (or switch apps), the project is saved in the browser's own database on your device, along with a small preview. It then shows under "Recent projects" on the home screen. Clearing your browser data removes these.

## The AI engine

ONNX Runtime Web runs the models using WebAssembly on the CPU, single thread. This is the most reliable choice on iPad and iPhone. If that engine fails to start, the app tries the WebGL (graphics chip) engine as a backup. The model files are part of the website, so they load from the same address. The browser keeps a copy after the first download.

* Background model: `models/u2netp.onnx` (4.5 MB, U2-Net small, Apache 2.0)
* Object removal model: `models/migan.onnx` (29 MB, MI-GAN by Picsart AI Research, MIT)
* Face points model: `models/face_landmarker.task` (3.7 MB, MediaPipe by Google, Apache 2.0), run by `vendor/mediapipe/` on the CPU. It also needs WebGL 2, which current iPhone, iPad and computer browsers have. It's given a normal canvas for that, because some Safari versions can't use WebGL on the "offscreen" canvas it would use otherwise

## When something goes wrong

Every error shows a box in plain words with a short "Details" line, instead of failing quietly.

## Testing

`tests/e2e.mjs` opens the app in the Safari engine (WebKit) and the Chrome engine (Chromium) at iPad and iPhone sizes. It uses a public domain NASA portrait (`tests/person.png`) and goes through: open photo, remove background, refine edges, remove an object, every Retouch tool, outline, shadow, filter, text, undo/redo, save PNG and JPG, and back to home. For each Retouch tool, it brushes the right spot on the face (cheek, teeth, eyes, under the eyes, lips, cheeks, hair, jaw) and checks that the pixels there changed while a patch of plain background did not. It takes a screenshot of every step, plus close-ups of the face. It then opens `tests/two-people.jpg` and does these checks:
* It finds both faces, and tapping each face selects it.
* With Face 1 selected, it brushes across both faces, then uses Auto Fix Brows, a style, a slider, a colour, Hold to see before, undo, redo and Reset brows.
* It saves the picture and checks that Face 1 changed while Face 2 is identical to the original photo.

It also sets every Face Shape slider to full strength and lets the face AI measure the result, for example that the mouth really got wider or the jaw slimmer. Last, it opens `tests/three-people.jpg` and checks that all three faces are found. The test photos are made from public domain NASA and scikit-image pictures. GitHub runs it automatically on every upload (`.github/workflows/browser-test.yml`) and saves the screenshots to the `test-shots` branch.

The test uses `tests/server.mjs`, a small web server that compresses files the same way GitHub Pages does. (An early version broke on GitHub Pages because of that compression, so the test now checks for it.) To run it yourself: start the server with `node tests/server.mjs . 8080`, then run `node tests/e2e.mjs http://localhost:8080/ test-shots chromium,webkit`.
