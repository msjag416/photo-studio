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

**The editor.** The canvas in the middle shows the project. Tapping a layer selects it and shows corner handles (resize) and a round handle on top (rotate). You can also pinch with two fingers. The tool panel sits on the right on iPad and at the bottom on iPhone. With nothing selected, it shows canvas options (background colour, add space).

**Remove background.** `ai.js` shrinks the photo to 320 × 320 and runs the U2-Net-p model, which scores how likely each pixel is part of the main subject. That score becomes a "mask" the same size as the photo. Where the mask is clear, the photo is see-through and a checkerboard shows. The original photo is never changed, so "Bring back background" just removes the mask.

**Refine edges.** This opens the brush screen with the cut-out on a checkerboard and a faint copy of the original underneath. Erase paints the mask away, and Restore paints it back. One finger paints, and two fingers zoom and move. The check mark keeps your changes and the X throws them away.

**Remove objects.** You paint over the thing you want gone, and when your finger lifts `ai.js` runs the MI-GAN model. The app first closes small gaps between your strokes and grows the painted area a little, so no edge of the object is left behind. The whole photo goes to the model, which zooms in on the hole by itself and fills it to match the surroundings. Only the painted area (with soft edges) is taken from the result. You can repeat this as many times as you like, use undo inside the screen, then tap the check mark to keep the result.

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
* Whiten teeth takes out yellow and lightens, but leaves pink gums and lips alone.
* Eye colour, lip colour and hair colour change the colour but keep the light and dark detail. Eye and lip colour leave very light and very dark spots alone (whites of the eyes, pupils, teeth).
* Blush is a soft wash of colour with an extra-soft brush edge. Brighten lifts darker tones more than light ones.
* Reshape > Move slides the pixels under your finger along with it, strongest in the middle of the brush. Restore brushes the original photo back.

Each brush stroke is worked on a copy of the photo. Lifting your finger keeps it, and Undo on the brush screen goes back one stroke. The check mark returns one new picture that replaces the photo, which is one step for the editor's Undo and Redo. It's saved with the project like any photo.

**Text.** Typing happens on a full screen with a row of fonts, colours and alignment. The text becomes a layer that can be moved, resized, rotated, outlined and shadowed like a photo. Tap selected text again to edit it.

**Undo and redo.** After every finished action, such as letting go of a slider, finishing a move or applying a brush, the editor saves a copy of all layer settings, up to 30 steps. Pictures themselves are never edited in place. Every tool makes a new picture, so the steps can share pictures and use little memory.

**Saving.** Save draws the whole project at full size. PNG keeps see-through areas. JPG puts a white background behind them. On iPhone and iPad a "Share or save to Photos" button also appears.

**Projects on the device.** When you leave the editor (or switch apps), the project is saved in the browser's own database on your device, along with a small preview. It then shows under "Recent projects" on the home screen. Clearing your browser data removes these.

## The AI engine

ONNX Runtime Web runs the models using WebAssembly on the CPU, single thread. This is the most reliable choice on iPad and iPhone. If that engine fails to start, the app tries the WebGL (graphics chip) engine as a backup. The model files are part of the website, so they load from the same address. The browser keeps a copy after the first download.

* Background model: `models/u2netp.onnx` (4.5 MB, U2-Net small, Apache 2.0)
* Object removal model: `models/migan.onnx` (29 MB, MI-GAN by Picsart AI Research, MIT)

## When something goes wrong

Every error shows a box in plain words with a short "Details" line, instead of failing quietly.

## Testing

`tests/e2e.mjs` opens the app in the Safari engine (WebKit) and the Chrome engine (Chromium) at iPad and iPhone sizes. It uses a public domain NASA portrait (`tests/person.png`) and goes through: open photo, remove background, refine edges, remove an object, every Retouch tool, outline, shadow, filter, text, undo/redo, save PNG and JPG, and back to home. For each Retouch tool, it brushes the right spot on the face (cheek, teeth, eyes, under the eyes, lips, cheeks, hair, jaw) and checks that the pixels there changed while a patch of plain background did not. It takes a screenshot of every step, plus close-ups of the face. GitHub runs it automatically on every upload (`.github/workflows/browser-test.yml`) and saves the screenshots to the `test-shots` branch.

The test uses `tests/server.mjs`, a small web server that compresses files the same way GitHub Pages does. (An early version broke on GitHub Pages because of that compression, so the test now checks for it.) To run it yourself: start the server with `node tests/server.mjs . 8080`, then run `node tests/e2e.mjs http://localhost:8080/ test-shots chromium,webkit`.
