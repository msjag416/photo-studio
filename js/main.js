// Start-up: home screen, Create menu, photo pickers, recent projects, and the error box.
import { $, $$, fileToCanvas, busy, nextFrame, showError } from './util.js';
import { fillIcons, icon } from './icons.js';
import { initEditor, openEditor, newProject, photoLayer, addPhoto, isOpen, autosave } from './editor.js';
import { initBrush } from './brush.js';
import { initScreens } from './screens.js';
import { listProjects, loadProject, deleteProject } from './store.js';

// Any error that slips through still shows up on screen in plain words.
window.addEventListener('error', e => showError('Something went wrong.', e.error || e.message));
window.addEventListener('unhandledrejection', e => showError('Something went wrong.', e.reason));
$('#errorOk').onclick = () => ($('#error').hidden = true);

function goHome() {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#home').classList.add('active');
  refreshRecent();
}

async function refreshRecent() {
  let items = [];
  try { items = await listProjects(); } catch (e) { console.warn('No saved projects available', e); }
  const box = $('#recent');
  box.innerHTML = '';
  $('#recentTitle').hidden = !items.length;
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'recent-item';
    const img = document.createElement('img');
    img.alt = 'Saved project';
    img.src = URL.createObjectURL(it.thumb);
    el.appendChild(img);
    const del = document.createElement('button');
    del.className = 'del';
    del.setAttribute('aria-label', 'Delete project');
    del.innerHTML = icon('close');
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Delete this project?')) return;
      await deleteProject(it.id);
      refreshRecent();
    };
    el.appendChild(del);
    el.onclick = async () => {
      try {
        busy('Opening…');
        const P = await loadProject(it.id);
        busy(false);
        openEditor(P, {}, goHome);
      } catch (err) {
        showError('This project could not be opened.', err);
      }
    };
    box.appendChild(el);
  }
}

// A photo was picked. "then" says what to do next: nothing, remove background, or remove objects.
async function photoPicked(input, then) {
  const file = input.files && input.files[0];
  input.value = ''; // so the same photo can be picked again later
  if (!file) return;
  $('#createSheet').hidden = true;
  try {
    busy('Opening your photo…');
    await nextFrame();
    const img = await fileToCanvas(file);
    busy(false);
    if (then === 'add' && isOpen()) { addPhoto(img); return; }
    const P = newProject(img.width, img.height);
    const L = photoLayer(img, P, true);
    P.layers.push(L);
    await openEditor(P, { select: L.id, then }, goHome);
  } catch (err) {
    showError('This photo could not be opened. Try a JPG or PNG photo.', err);
  }
}

function init() {
  fillIcons();
  initEditor();
  initBrush();
  initScreens();
  fillIcons();

  $('#fileEdit').addEventListener('change', e => photoPicked(e.target, null));
  $('#fileBg').addEventListener('change', e => photoPicked(e.target, 'bg'));
  $('#fileObj').addEventListener('change', e => photoPicked(e.target, 'erase'));
  $('#fileAdd').addEventListener('change', e => photoPicked(e.target, 'add'));

  $('#createBtn').onclick = () => ($('#createSheet').hidden = false);
  $$('.sheet-wrap').forEach(w => {
    w.addEventListener('click', e => { if (e.target === w || e.target.closest('[data-close]')) w.hidden = true; });
  });
  const blank = size => {
    const [w, h] = size.split('x').map(Number);
    $('#createSheet').hidden = true;
    openEditor(newProject(w, h, '#FFFFFF'), {}, goHome);
  };
  $$('[data-size]').forEach(b => (b.onclick = () => blank(b.dataset.size)));
  $('[data-action=blank]').onclick = () => blank('1080x1080');

  // Save the open project if the app is put in the background.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave(); });

  refreshRecent();
}

try {
  init();
} catch (err) {
  showError('The app could not start in this browser.', err);
}
