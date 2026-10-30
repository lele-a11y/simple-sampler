// Entry module: renders the tracks and wires up all controls.

import { audioCtx } from './synth.js';
import { instruments } from './instruments/index.js';
import {
  events, state, tracks, fitSteps, canEdit, play, stop, setBpm, shareTrack, resetSound,
  claimTrack, releaseTrack, addTrack, removeTrack, NUM_STEPS, MAX_TRACKS,
} from './sequencer.js';
import { connect, isOnline, roomId } from './net.js';
import { saveState, loadState } from './storage.js';
import { attachKnob } from './knobs.js';
import { attachSoundPresets, attachPatternPresets } from './presets.js';

const playIcon = `<svg width='28' height='28' viewBox='0 0 24 24' fill='currentColor'><polygon points='5,3 21,12 5,21'></polygon></svg>`;
const stopIcon = `<svg width='28' height='28' viewBox='0 0 24 24' fill='currentColor'><rect x='4' y='4' width='16' height='16' rx='2'></rect></svg>`;

// Leading + trailing throttle; flush() runs a pending call immediately.
function throttle(fn, ms) {
  let timer = null;
  let pending = null;

  function run() {
    if (!pending) {
      timer = null;
      return;
    }

    fn(...pending);
    pending = null;
    timer = setTimeout(run, ms);
  }

  const throttled = (...args) => {
    pending = args;
    if (!timer) run();
  };

  throttled.flush = () => {
    clearTimeout(timer);
    run();
  };

  return throttled;
}

// ---------- Steps ----------

function updateStepVisual(step) {
  document.querySelectorAll('.step.current').forEach(el =>
    el.classList.remove('current')
  );

  document.querySelectorAll(`.step[data-step="${step}"]`).forEach(el =>
    el.classList.add('current')
  );
}

function updateStepButton(btn, track, step) {
  const v = Number(track.steps[step]);
  const current = btn.classList.contains('current');
  const color = track.instrument.color;

  btn.className = `step ${v === 1 ? 'on-' + color : ''} ${v === 0.25 ? 'half-' + color : ''}`;

  btn.classList.toggle('current', current);

  btn.dataset.step = step;
  btn.dataset.track = track.id;
}

// ---------- Painting / Drawing ----------

let painting = null;

function paintStep(btn, track, value) {
  if (!btn || !canEdit(track)) return;

  if (btn.dataset.track !== String(track.id)) return;

  const step = Number(btn.dataset.step);

  if (!Number.isInteger(step) || step < 0 || step >= NUM_STEPS) return;

  if (Number(track.steps[step]) === value) return;

  track.steps[step] = value;

  updateStepButton(btn, track, step);

  shareTrack(track, 'steps');
  saveState();
}

function startPainting(btn, track, e) {
  if (!canEdit(track)) return;

  const step = Number(btn.dataset.step);
  const currentValue = Number(track.steps[step]);

  painting = {
    track,
    value: currentValue === 0 ? 1 : 0,
    moved: false,
    startX: e.clientX,
    startY: e.clientY,
    startStep: step,
    startBtn: btn,
    pointerId: e.pointerId
  };
}

function stopPainting(e) {
  if (!painting) return;

  const operation = painting;
  painting = null;

  // Normal click: cycle through all three states.
  if (!operation.moved && canEdit(operation.track)) {
    const { track, startStep, startBtn } = operation;
    const v = Number(track.steps[startStep]);

    track.steps[startStep] =
      v === 0 ? 1 :
      v === 1 ? 0.25 : 0;

    updateStepButton(startBtn, track, startStep);

    shareTrack(track, 'steps');
    saveState();
  }
}

// Start painting
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest('.step');

  if (!btn) return;

  const track = tracks.find(t => String(t.id) === btn.dataset.track);

  if (!track || !canEdit(track)) return;

  e.preventDefault();

  startPainting(btn, track, e);
});

// Paint while moving
document.addEventListener('pointermove', e => {
  if (!painting) return;

  if (e.pointerId !== painting.pointerId) return;

  const distance = Math.hypot(
    e.clientX - painting.startX,
    e.clientY - painting.startY
  );

  if (distance > 5) {
    painting.moved = true;
  }

  if (!painting.moved) return;

  const btn = document.elementFromPoint(
    e.clientX,
    e.clientY
  )?.closest('.step');

  if (!btn) return;

  if (btn.dataset.track !== String(painting.track.id)) return;

  paintStep(btn, painting.track, painting.value);
});

// Finish painting
document.addEventListener('pointerup', stopPainting);

document.addEventListener('pointercancel', () => {
  painting = null;
});

window.addEventListener('blur', () => {
  painting = null;
});

// Keyboard accessibility: cycle through all three states.
document.addEventListener('click', e => {
  const btn = e.target.closest('.step');

  if (!btn || e.detail !== 0) return;

  const track = tracks.find(t => String(t.id) === btn.dataset.track);

  if (!track || !canEdit(track)) return;

  const step = Number(btn.dataset.step);
  const v = Number(track.steps[step]);

  track.steps[step] =
    v === 0 ? 1 :
    v === 1 ? 0.25 : 0;

  updateStepButton(btn, track, step);

  shareTrack(track, 'steps');
  saveState();
});

// ---------- Tracks ----------

const trackViews = new Map();

function editTrack(track, field, change) {
  if (!canEdit(track)) return;

  change();
  shareTrack(track, field);
  trackViews.get(track.id).refresh();
  saveState();
}

function syncTracks() {
  const container = document.getElementById('tracks');

  trackViews.forEach((view, id) => {
    const track = tracks.find(t => t.id === id);

    if (track && view.track === track && view.instrument === track.instrument) return;

    view.root.remove();
    trackViews.delete(id);
  });

  let prev = null;

  tracks.forEach(track => {
    if (!trackViews.has(track.id)) {
      trackViews.set(track.id, renderTrack(track));
    }

    const { root } = trackViews.get(track.id);

    const expected = prev
      ? prev.nextElementSibling
      : container.firstElementChild;

    if (root !== expected) {
      container.insertBefore(root, expected);
    }

    prev = root;
  });

  updateAddBar();
}

function renderTrack(track) {
  const { instrument } = track;

  const root = document.createElement('div');
  root.className = 'track panel';

  // Info column
  const infoCol = document.createElement('div');
  infoCol.className = 'track-info';

  infoCol.innerHTML = `
    <div class="track-header">
      <span class="track-name color-${instrument.color}">${instrument.name}</span>
      <div class="track-buttons">
        <button class="claim-btn btn btn-sm"></button>
        <button class="default-btn btn btn-sm">Default</button>
        <button class="mute-btn btn btn-sm"></button>
        <button class="remove-btn btn btn-sm" title="Remove this instrument for everyone" aria-label="Remove">&times;</button>
      </div>
    </div>
  `;

  // Knob column
  const knobCol = document.createElement('div');
  knobCol.className = 'knob-col';

  knobCol.innerHTML = `
    <div class="knob-row">
      ${instrument.knobs.map(k => `
        <div class="knob knob-data" data-key="${k.key}" aria-label="${k.label}">
          <div class="knob-indicator"></div>
          <div class="knob-label">${k.label}</div>
          <div class="knob-value">0</div>
        </div>
      `).join('')}
    </div>
  `;

  // Steps
  const stepsContainer = document.createElement('div');
  stepsContainer.className = 'steps step-grid';

  stepsContainer.style.gridTemplateColumns =
    `repeat(${NUM_STEPS}, minmax(0, 1fr))`;

  const stepButtons = [];

  for (let s = 0; s < NUM_STEPS; s++) {
    const btn = document.createElement('button');

    updateStepButton(btn, track, s);

    stepsContainer.appendChild(btn);
    stepButtons.push(btn);
  }

  // Sound presets
  const soundRow = document.createElement('div');
  soundRow.className = 'preset-row';

  const updateSoundRow = attachSoundPresets(soundRow, track, editTrack);

  // Pattern presets
  const patternRow = document.createElement('div');
  patternRow.className = 'preset-row';

  const updatePatternRow = attachPatternPresets(patternRow, track, editTrack);

  // Steps column
  const stepsCol = document.createElement('div');
  stepsCol.className = 'steps-col';

  stepsCol.appendChild(stepsContainer);
  stepsCol.appendChild(soundRow);
  stepsCol.appendChild(patternRow);

  root.appendChild(infoCol);
  root.appendChild(knobCol);
  root.appendChild(stepsCol);

  // Claim
  const claimBtn = root.querySelector('.claim-btn');

  claimBtn.addEventListener('click', () => {
    if (track.owner === 'me') {
      releaseTrack(track);
    } else if (!track.owner) {
      claimTrack(track);
    }
  });

  // Mute
  const muteBtn = root.querySelector('.mute-btn');

  muteBtn.addEventListener('click', () => {
    editTrack(track, 'muted', () => {
      track.muted = !track.muted;
    });
  });

  // Remove
  const removeBtn = root.querySelector('.remove-btn');

  removeBtn.addEventListener('click', () => {
    if (
      canEdit(track) &&
      confirm(`Remove ${instrument.name}? Its presets are lost for everyone.`)
    ) {
      removeTrack(track);
    }
  });

  // Default
  const defaultBtn = root.querySelector('.default-btn');

  defaultBtn.addEventListener('click', () => {
    if (!canEdit(track)) return;

    resetSound(track);
    saveState();
  });

  // Knobs
  const shareKnobs = throttle(() => shareTrack(track, 'params'), 50);

  const knobUpdates = [];

  root.querySelectorAll('.knob').forEach(knobEl => {
    const key = knobEl.dataset.key;
    const knobDef = instrument.knobs.find(k => k.key === key);

    if (knobDef) {
      knobUpdates.push(
        attachKnob(knobEl, track, knobDef, shareKnobs)
      );
    }
  });

  function refresh() {
    stepButtons.forEach((btn, s) => {
      updateStepButton(btn, track, s);
    });

    knobUpdates.forEach(update => update());

    updateSoundRow();
    updatePatternRow();

    root.classList.toggle('mine', track.owner === 'me');
    root.classList.toggle('locked', !canEdit(track));
    root.classList.toggle('muted', track.muted);

    muteBtn.textContent = track.muted ? 'Unmute' : 'Mute';

    muteBtn.disabled = !canEdit(track);
    removeBtn.disabled = !canEdit(track);

    claimBtn.hidden = !isOnline();
    claimBtn.disabled = track.owner === 'other';

    claimBtn.textContent =
      track.owner === 'me'
        ? 'Release'
        : track.owner === 'other'
          ? 'Taken'
          : 'Claim';

    claimBtn.title =
      track.owner === 'me'
        ? 'Your instrument; release it so others can take it'
        : track.owner === 'other'
          ? 'Another player owns this instrument'
          : 'Free: anyone can edit it. Claim it to make it yours';
  }

  refresh();

  return {
    track,
    instrument,
    root,
    refresh
  };
}

// ---------- Adding tracks ----------

const addBar = document.getElementById('addBar');

instruments.forEach(instrument => {
  const btn = document.createElement('button');

  btn.className = `btn btn-sm add-btn color-${instrument.color}`;
  btn.textContent = '+ ' + instrument.name;

  btn.addEventListener('click', () => addTrack(instrument));

  addBar.appendChild(btn);
});

function updateAddBar() {
  const full = tracks.length >= MAX_TRACKS;

  addBar.querySelectorAll('button').forEach(btn => {
    btn.disabled = full;

    btn.title = full
      ? `At most ${MAX_TRACKS} instruments`
      : 'Add a free instrument';
  });
}

// ---------- Controls ----------

const playBtn = document.getElementById('playBtn');
const clearBtn = document.getElementById('clearBtn');
const bpmInput = document.getElementById('bpm');
const bpmVal = document.getElementById('bpmVal');
const joinOverlay = document.getElementById('joinOverlay');
const shareBtn = document.getElementById('shareBtn');

// BPM
let bpmDragging = false;

function setBpmUI(value) {
  if (bpmDragging) return;

  bpmInput.value = value;
  bpmVal.textContent = value;
}

const setBpmThrottled = throttle(setBpm, 100);

// ---------- Events ----------

events.addEventListener('step', e => {
  updateStepVisual(e.detail);
});

events.addEventListener('transport', () => {
  const playing = state.transport.playing;

  setBpmUI(state.transport.bpm);

  playBtn.innerHTML = playing ? stopIcon : playIcon;
  playBtn.classList.toggle('playing', playing);

  if (!playing) {
    document.querySelectorAll('.step.current').forEach(el => {
      el.classList.remove('current');
    });
  }

  saveState();
});

events.addEventListener('track', e => {
  trackViews.get(e.detail.id)?.refresh();
  saveState();
});

events.addEventListener('tracks', () => {
  syncTracks();
  saveState();
});

// ---------- Play / Stop ----------

playBtn.addEventListener('click', () => {
  if (state.transport.playing) {
    stop();
  } else {
    play();
  }
});

// ---------- Clear ----------

clearBtn.addEventListener('click', () => {
  tracks.forEach(track => {
    editTrack(track, 'steps', () => {
      track.steps = fitSteps([]);
    });
  });
});

// ---------- Share ----------

shareBtn.hidden = !roomId;

shareBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);

    shareBtn.textContent = 'Copied!';

    setTimeout(() => {
      shareBtn.textContent = 'Copy room link';
    }, 1500);

  } catch (err) {
    window.prompt('Room link:', location.href);
  }
});

// ---------- BPM ----------

bpmInput.addEventListener('pointerdown', () => {
  bpmDragging = true;
});

document.addEventListener('pointerup', () => {
  if (!bpmDragging) return;

  bpmDragging = false;
  setBpmUI(state.transport.bpm);
});

bpmInput.addEventListener('input', e => {
  const value = parseInt(e.target.value, 10);

  bpmVal.textContent = value;
  setBpmThrottled(value);
});

// ---------- Keyboard shortcuts ----------

document.addEventListener('keydown', e => {
  if (!joinOverlay.hidden) return;

  if (e.code === 'Space' || e.code === 'Enter') {
    if (
      e.target.matches('input, textarea, select, button') ||
      e.target.isContentEditable
    ) {
      return;
    }

    e.preventDefault();
    playBtn.click();
  }
});

// ---------- Prevent dropped files ----------

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// ---------- Initialization ----------

loadState();

setBpmUI(state.transport.bpm);

syncTracks();

// Join room
document.getElementById('joinBtn').addEventListener('click', async () => {
  await audioCtx.resume();

  joinOverlay.hidden = true;

  connect();
});
