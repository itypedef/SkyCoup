/* ── Dice Roller ─────────────────────────────────────────── */

(function () {
  'use strict';

  const MIN_DICE = 1;
  const MAX_DICE = 12;

  let diceCount = 2;
  const history = [];

  const btnDice      = document.getElementById('btn-dice');
  const btnBack      = document.getElementById('btn-back-home-dice');
  const btnDec       = document.getElementById('dice-dec');
  const btnInc       = document.getElementById('dice-inc');
  const btnRoll      = document.getElementById('btn-roll');
  const countDisplay = document.getElementById('dice-count-display');
  const sidesSelect  = document.getElementById('dice-sides');
  const facesEl      = document.getElementById('dice-faces');
  const totalEl      = document.getElementById('dice-total');
  const logEl        = document.getElementById('dice-log');

  // ── Navigation ──────────────────────────────────────────
  btnDice.addEventListener('click', () => showScreen('screen-dice'));
  btnBack.addEventListener('click', () => showScreen('screen-home'));

  // ── Count controls ──────────────────────────────────────
  btnDec.addEventListener('click', () => {
    if (diceCount > MIN_DICE) { diceCount--; updateCountDisplay(); }
  });
  btnInc.addEventListener('click', () => {
    if (diceCount < MAX_DICE) { diceCount++; updateCountDisplay(); }
  });

  function updateCountDisplay() {
    countDisplay.textContent = diceCount;
    btnDec.disabled = diceCount <= MIN_DICE;
    btnInc.disabled = diceCount >= MAX_DICE;
  }
  updateCountDisplay();

  // ── Roll ────────────────────────────────────────────────
  btnRoll.addEventListener('click', roll);

  function roll() {
    const sides = parseInt(sidesSelect.value, 10);
    const results = Array.from({ length: diceCount }, () => Math.floor(Math.random() * sides) + 1);
    const total = results.reduce((a, b) => a + b, 0);

    renderFaces(results, sides);
    renderTotal(results, total, sides);
    addHistory(results, total, sides);
  }

  function renderFaces(results, sides) {
    // Trigger animation by replacing nodes
    facesEl.innerHTML = '';
    results.forEach(val => {
      const div = document.createElement('div');
      div.className = 'die-face' +
        (val === sides ? ' die-max' : val === 1 ? ' die-min' : '');
      div.textContent = val;
      facesEl.appendChild(div);
    });
  }

  function renderTotal(results, total, sides) {
    if (results.length === 1) {
      totalEl.innerHTML = '';
      return;
    }
    totalEl.innerHTML = `Total: <strong>${total}</strong> &nbsp;<span style="color:var(--text-muted);font-size:0.85rem">(${diceCount}d${sides})</span>`;
  }

  function addHistory(results, total, sides) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    history.unshift({ results, total, sides, time });
    if (history.length > 50) history.pop();
    renderLog();
  }

  function renderLog() {
    logEl.innerHTML = '';
    history.forEach(entry => {
      const div = document.createElement('div');
      div.className = 'dice-log-entry';
      div.innerHTML =
        `<span class="dice-log-roll">${entry.results.join(', ')} <span style="color:var(--text-muted)">(${entry.results.length}d${entry.sides})</span></span>` +
        `<span style="display:flex;gap:8px;align-items:center">` +
        `<span class="dice-log-total">${entry.results.length > 1 ? '= ' + entry.total : ''}</span>` +
        `<span style="font-size:0.7rem;color:var(--text-muted)">${entry.time}</span>` +
        `</span>`;
      logEl.appendChild(div);
    });
  }

})();
