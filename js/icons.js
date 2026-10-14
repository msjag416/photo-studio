// Simple line icons drawn for this app. Each entry is the inside of a 24x24 SVG.
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 2.5-2.5L20 18"/>',
  addimage: '<rect x="3.5" y="5.5" width="13" height="13" rx="2.5"/><path d="M4 16l4-4 3 3 2-2 3.5 3.5"/><path d="M19.5 3v6M16.5 6h6"/>',
  square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
  cutout: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6"/><path d="M3 3h3M18 3h3M3 3v3M21 3v3M3 21h3M18 21h3M3 21v-3M21 21v-3"/>',
  eraser: '<path d="M14.5 4.5l5 5-8.5 8.5H7l-3-3z"/><path d="M10 9l5 5M11 19h9"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  brush: '<path d="M19.5 4.5l-8 8"/><path d="M11 12c-3 0-4.5 2-4.5 4 0 1.5-1 2.5-2.5 3 4 .5 8-1 8-4.5z"/>',
  blur: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2.5"/>',
  sparkle: '<path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  sliders: '<path d="M5 7h9M18 7h1M5 17h3M12 17h7"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  filter: '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/>',
  corners: '<path d="M4 11V9a5 5 0 015-5h2M20 11V9a5 5 0 00-5-5h-2M4 13v2a5 5 0 005 5h2M20 13v2a5 5 0 01-5 5h-2"/>',
  outline: '<path d="M12 3.5c3 2.5 6.5 4 6.5 9a6.5 6.5 0 01-13 0c0-5 3.5-6.5 6.5-9z"/><path d="M12 7.5c1.8 1.5 3.5 2.6 3.5 5.5a3.5 3.5 0 01-7 0c0-2.9 1.7-4 3.5-5.5z"/>',
  shadow: '<rect x="4" y="4" width="11" height="11" rx="2"/><path d="M18 8.5h1a1 1 0 011 1V19a1 1 0 01-1 1H9.5a1 1 0 01-1-1v-1"/>',
  opacity: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 010 16" fill="currentColor" stroke="none"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  crop: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
  expand: '<rect x="8" y="8" width="8" height="8" rx="1"/><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.5 6c.5-.1 1-.1 1.5-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 01-2.6 3.4M6.5 7.4A16 16 0 002.5 12S6 18.5 12 18.5c1.5 0 2.8-.4 4-1"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  dropper: '<path d="M14 6l4 4M15.5 3.5a2.1 2.1 0 013 3L9 16l-4 1 1-4z"/>',
  flip: '<path d="M12 3v18M8 7L3 17h5zM16 7l5 10h-5z"/>',
  center: '<circle cx="12" cy="12" r="2"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  alignleft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  aligncenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignright: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 100 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.8-1.6 1.7-1.6h2.2a3.8 3.8 0 003.8-3.8c0-4-3.8-7.3-8.5-7.3z"/><circle cx="8" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}

// Fill every <i data-icon="name"> inside root with its SVG.
export function fillIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach(el => {
    if (!el.firstChild) el.innerHTML = icon(el.dataset.icon);
  });
}
