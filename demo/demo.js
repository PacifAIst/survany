// The quiet scene is drawn, not filmed: a dim loading bay with a slowly drifting light, so the motion
// gate sees a little movement and the fire detector sees nothing. The incident swaps in a real fire
// photograph from the D-Fire test split (CC0) with a gentle zoom so consecutive frames differ.
const quiet = document.getElementById('quiet');
const incident = document.getElementById('incident');
const state = document.getElementById('state');
const clock = document.getElementById('clock');
const ctx = quiet.getContext('2d');
let timer = null;
let t0 = performance.now();

function drawQuiet(t) {
  const w = quiet.width;
  const h = quiet.height;
  ctx.fillStyle = '#15181c';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#20252b';
  ctx.fillRect(0, h * 0.62, w, h * 0.38); // floor
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = '#2b3138';
    ctx.fillRect(w * (0.08 + i * 0.23), h * 0.2, w * 0.18, h * 0.42); // bay doors
    ctx.fillStyle = '#23282e';
    for (let k = 1; k < 8; k++) ctx.fillRect(w * (0.08 + i * 0.23), h * (0.2 + k * 0.052), w * 0.18, 2);
  }
  ctx.fillStyle = '#3a3f45';
  ctx.fillRect(w * 0.55, h * 0.66, w * 0.14, h * 0.12); // pallet
  const x = w * (0.5 + 0.35 * Math.sin(t / 7000));
  const g = ctx.createRadialGradient(x, h * 0.1, 10, x, h * 0.1, w * 0.35);
  g.addColorStop(0, 'rgba(160,170,180,0.18)');
  g.addColorStop(1, 'rgba(160,170,180,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function frame(t) {
  clock.textContent = new Date().toLocaleTimeString();
  if (incident.hidden) drawQuiet(t);
  else incident.style.transform = `scale(${1.04 + 0.03 * Math.sin((t - t0) / 900)})`;
  requestAnimationFrame(frame);
}

function startIncident() {
  clearTimeout(timer);
  timer = null;
  t0 = performance.now();
  incident.hidden = false;
  state.textContent = 'Incident in progress: fire at the loading dock.';
}

function reset() {
  clearTimeout(timer);
  timer = null;
  incident.hidden = true;
  state.textContent = 'Quiet scene.';
}

document.getElementById('start').addEventListener('click', () => {
  reset();
  let left = 10;
  state.textContent = `Incident starts in ${left} s.`;
  const tick = () => {
    left -= 1;
    if (left <= 0) startIncident();
    else {
      state.textContent = `Incident starts in ${left} s.`;
      timer = setTimeout(tick, 1000);
    }
  };
  timer = setTimeout(tick, 1000);
});
document.getElementById('now').addEventListener('click', startIncident);
document.getElementById('reset').addEventListener('click', reset);
if (new URLSearchParams(location.search).get('incident') === 'now') startIncident();
requestAnimationFrame(frame);
