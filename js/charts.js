/* Графики и мультиселект пилотов */

const chartSel = {
  races: { team: '', drivers: [], msFilter: '' },
  quals: { team: '', drivers: [], msFilter: '' }
};

function lineChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#bbb', font: { size: 11 }, boxWidth: 14 } },
      tooltip: { mode: 'index', intersect: false }
    },
    scales: {
      x: { grid: { color: '#ffffff0c' }, ticks: { color: '#666' } },
      y: { grid: { color: '#ffffff0c' }, ticks: { color: '#666' } }
    }
  };
}

function makeDataset(driver, standings, rounds, colorIdx) {
  const s = standings.find(x => x.driver === driver);
  if (!s) return null;
  let cum = 0;
  return {
    label: driver.split(' ').slice(-1)[0],
    borderColor: COLORS[colorIdx % COLORS.length],
    backgroundColor: COLORS[colorIdx % COLORS.length] + '20',
    data: rounds.map(r => { cum += s.roundPts[r] || 0; return cum; }),
    tension: 0.35, pointRadius: 3, fill: false,
  };
}

function drawChart(id, rounds, datasets) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  if (state.charts[id]) state.charts[id].destroy();
  datasets = datasets.filter(Boolean);
  if (!datasets.length) {
    state.charts[id] = null;
    ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
    return;
  }
  state.charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels: rounds.map(roundLabel), datasets },
    options: lineChartOptions()
  });
}

function drawTeamChart(type) {
  const team = chartSel[type].team;
  const { standings, rounds } = state[type];
  const drivers = standings.filter(s => s.team === team);
  const datasets = drivers.map((s, i) => makeDataset(s.driver, standings, rounds, i));
  drawChart(`chart-team-${type}`, rounds, datasets);
}

function drawDriverChart(type) {
  const selected = chartSel[type].drivers;
  const { standings, rounds } = state[type];
  const datasets = selected.map((d, i) => makeDataset(d, standings, rounds, i));
  drawChart(`chart-drivers-${type}`, rounds, datasets);
}

/* ── Multi-select ── */
function closeMs(type) {
  const panel = document.getElementById(`ms-panel-${type}`);
  const trigger = document.getElementById(`ms-trigger-${type}`);
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  trigger.classList.remove('open');
  const inp = panel.querySelector('.ms-search');
  if (inp) inp.value = '';
  chartSel[type].msFilter = '';
  renderMsOptions(type);
}

function toggleMs(type, e) {
  e.stopPropagation();
  const panel = document.getElementById(`ms-panel-${type}`);
  if (panel.classList.contains('open')) { closeMs(type); return; }
  panel.classList.add('open');
  document.getElementById(`ms-trigger-${type}`).classList.add('open');
}

function updateMsLabel(type) {
  const sel = chartSel[type].drivers;
  const label = document.getElementById(`ms-label-${type}`);
  label.textContent = sel.length
    ? sel.map(d => d.split(' ').slice(-1)[0]).join(', ')
    : 'Выберите пилотов…';
}

function renderMsOptions(type) {
  const list = document.getElementById(`ms-list-${type}`);
  const { standings } = state[type];
  const q = chartSel[type].msFilter.toLowerCase();
  const sel = chartSel[type].drivers;
  const drivers = standings.map(s => s.driver).filter(d => !q || d.toLowerCase().includes(q));

  list.innerHTML = drivers.map(d => {
    const checked = sel.includes(d);
    return `<div class="ms-item${checked ? ' selected' : ''}"
  data-type="${type}" data-d="${d.replace(/"/g, '&quot;')}"
  onclick="toggleMsDriver(event, this)">
  <span class="ms-check">${checked ? '✓' : ''}</span>
  <span>${d}</span>
</div>`;
  }).join('');
}

function filterMsOptions(type, val) {
  chartSel[type].msFilter = val;
  renderMsOptions(type);
}

function toggleMsDriver(e, el) {
  e.stopPropagation();
  const type = el.dataset.type;
  const driver = el.dataset.d;
  const sel = chartSel[type].drivers;
  const idx = sel.indexOf(driver);
  if (idx >= 0) sel.splice(idx, 1);
  else sel.push(driver);
  updateMsLabel(type);
  renderMsOptions(type);
  drawDriverChart(type);
}

function onTeamChange(type) {
  chartSel[type].team = document.getElementById(`team-select-${type}`).value;
  drawTeamChart(type);
}

function initCharts(type) {
  const teams = [...new Set(state[type].standings.map(s => s.team).filter(t => t && t !== '—'))].sort();
  const sel = document.getElementById(`team-select-${type}`);
  sel.innerHTML = teams.map(t => `<option value="${t}">${t}</option>`).join('');
  chartSel[type].team = teams[0] || '';
  drawTeamChart(type);
  renderMsOptions(type);
  drawDriverChart(type);
}

document.addEventListener('click', e => {
  ['races', 'quals'].forEach(type => {
    if (!document.getElementById(`ms-${type}`)?.contains(e.target)) {
      closeMs(type);
    }
  });
});

// Цвета из бейджей производителей; нет производителя — серый
const MFR_COLORS = { Toyota: '#f05555', Chevy: '#f0c000', Ford: '#7799ff' };
const GRAY = '#7a7a9a';

function drawRankChart(hist, color) {
  const id = 'chart-driver-rank';
  if (state.charts[id]) state.charts[id].destroy();
  const rounds = state.races.rounds.filter(r => hist[r] != null);
  if (!rounds.length) { state.charts[id] = null; return; }

  const opts = lineChartOptions();
  opts.plugins.legend.display = false;
  // 1-е место сверху; шаг только целый — дробных мест не бывает
  opts.scales.y = { ...opts.scales.y, reverse: true, min: 1, ticks: { ...opts.scales.y.ticks, precision: 0 } };
  opts.plugins.tooltip = { callbacks: { label: c => ` ${c.raw} место` } };

  state.charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: {
      labels: rounds.map(roundLabel),
      datasets: [{
        label: 'Место', data: rounds.map(r => hist[r]),
        borderColor: color, backgroundColor: color + '20',
        tension: 0.35, pointRadius: 3, fill: false,
      }]
    },
    options: opts
  });
}
