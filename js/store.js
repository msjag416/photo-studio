// Saves projects on this device (browser IndexedDB). Nothing is uploaded anywhere.
import { canvasToBlob, blobToCanvas } from './util.js';

const DB = 'photo-studio', STORE = 'projects';
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
  });
}

const PICS = ['img', 'mask', 'subject'];

// Pictures (canvases) are turned into PNG data before saving. They are stored as raw
// bytes, not Blobs, because Safari can refuse to store Blobs (for example in private browsing).
const toBytes = async c => ({ type: 'image/png', data: await (await canvasToBlob(c)).arrayBuffer() });
const fromBytes = b => new Blob([b.data], { type: b.type });
export async function saveProject(P, thumb) {
  const layers = [];
  for (const L of P.layers) {
    const copy = { ...L };
    for (const k of PICS) if (L[k]) copy[k] = await toBytes(L[k]);
    layers.push(copy);
  }
  const rec = { id: P.id, w: P.w, h: P.h, bg: P.bg, layers, updated: Date.now(), thumb: await toBytes(thumb) };
  await tx('readwrite', s => s.put(rec));
}

export async function listProjects() {
  const all = (await tx('readonly', s => s.getAll())) || [];
  return all.sort((a, b) => b.updated - a.updated).map(r => ({ id: r.id, thumb: fromBytes(r.thumb), updated: r.updated }));
}

export async function loadProject(id) {
  const r = await tx('readonly', s => s.get(id));
  if (!r) throw new Error('Project not found');
  const layers = [];
  for (const L of r.layers) {
    const copy = { ...L };
    for (const k of PICS) if (L[k]) copy[k] = await blobToCanvas(fromBytes(L[k]));
    layers.push(copy);
  }
  return { id: r.id, w: r.w, h: r.h, bg: r.bg, layers };
}

export async function deleteProject(id) {
  await tx('readwrite', s => s.delete(id));
}
