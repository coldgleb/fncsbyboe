/* Графики: общие настройки линий, график места в карточках (пилот, команда, машина) */

/* Цвета осей и легенды — из токенов темы, чтобы график жил в тёмной и светлой */
const themeColor = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function lineChartOptions() {
  const text = themeColor('--text2'), muted = themeColor('--muted'), grid = themeColor('--row-line');
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: text, font: { size: 11 }, boxWidth: 14 } },
      tooltip: { mode: 'index', intersect: false }
    },
    scales: {
      x: { grid: { color: grid }, ticks: { color: muted } },
      y: { grid: { color: grid }, ticks: { color: muted } }
    }
  };
}

// Цвета из бейджей производителей; нет производителя — серый
const MFR_COLORS = { Toyota: '#eb4a58', Chevy: '#f5d90a', Ford: '#5aa9ff' };
const GRAY = '#8d95a3';

function drawRankChart(hist, color, allRounds = state.races.rounds) {
  const id = 'chart-driver-rank';
  if (state.charts[id]) state.charts[id].destroy();
  const rounds = allRounds.filter(r => hist[r] != null);
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
