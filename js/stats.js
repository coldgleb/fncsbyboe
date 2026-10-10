/* Вкладка «Статистика»: факты сезона одного пилота или команды — первые результаты,
   участие, места, серии, зачёт по ходу сезона, Чейз, напарники. Отдельно по гонкам и по
   квалам (в квалах — можно без квал по метрике). Считает local-api (rpc stats). */

let statsMode = 'driver';
let statsSession = 'race';
let statsNoMetric = false;
const statsPick = { driver: null, team: null };   // выбор помнится и при смене года/дивизиона

async function initStats() {
  state.h2hTeams = await rpc('team_standings', { ...season(), upto: 1000, with_guest_only: true }, state.fresh);
  fillStatsSelect();
  await renderStats();
}

function setStatsMode(mode) {
  statsMode = mode;
  document.querySelectorAll('.rtog-btn[data-stats]').forEach(b => b.classList.toggle('rtog-active', b.dataset.stats === mode));
  fillStatsSelect();
  renderStats();
}

function setStatsSession(session) {
  statsSession = session;
  document.querySelectorAll('.rtog-btn[data-stats-s]').forEach(b => b.classList.toggle('rtog-active', b.dataset.statsS === session));
  document.getElementById('stats-metric').style.display = session === 'qual' ? '' : 'none';
  renderStats();
}

function setStatsNoMetric(on) {
  statsNoMetric = on;
  renderStats();
}

function fillStatsSelect() {
  const groups = h2hGroups(statsMode === 'team' ? 'teams' : 'drivers');
  const opts = groups.flatMap(([, list]) => list);
  const keep = opts.includes(statsPick[statsMode]) ? statsPick[statsMode] : opts[0];
  statsPick[statsMode] = keep;
  const esc = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const option = o => `<option value="${esc(o)}"${o === keep ? ' selected' : ''}>${esc(o.replace(' (i)', ''))}${isGuestDriver(o) ? ' (i)' : ''}</option>`;
  document.getElementById('stats-pick').innerHTML = groups.map(([label, list]) => label == null ? list.map(option).join('')
    : `<optgroup label="${esc(label)}">${list.map(option).join('')}</optgroup>`).join('');
}

function pickStats(name) {
  statsPick[statsMode] = name;
  renderStats();
}

async function renderStats() {
  const name = statsPick[statsMode];
  const body = document.getElementById('stats-body');
  if (!name) { body.innerHTML = '<p class="muted">Нет данных</p>'; return; }
  const req = { kind: statsMode, name, session: statsSession, noMetric: statsNoMetric };
  const d = await rpc('stats', { ...season(), ...req }, state.fresh);
  // пока считали, выбор сменился
  if (statsPick[statsMode] !== name || statsSession !== req.session || statsNoMetric !== req.noMetric) return;
  const team = d.kind === 'team', qual = d.session === 'qual';

  const no = '<span class="muted">нет</span>';
  const fx = (v, n = 1) => v == null ? '—' : (Math.round(v * 10 ** n) / 10 ** n).toLocaleString('ru-RU');
  const pct = (a, b) => b ? ` <span class="muted">(${Math.round(a / b * 100)}%)</span>` : '';
  const rl = n => roundLink(n);
  // пилот — с номером машины в её цветах: номер строки результата, иначе — последний известный
  const drv = (name, car, mfr) => {
    const c = car ? { car, mfr } : state.carOf?.[name];
    return `<span class="stats-drv">${c?.car ? carBadge(c.car, c.mfr) + ' ' : ''}${driverLink(name)}</span>`;
  };
  const who = x => team && x.driver ? ' · ' + drv(x.driver, x.car, x.mfr) : '';
  // первый результат: этап, место (у первого места — без него) и у команды — кто привёз
  const at = (x, showPos = true) => !x ? no : `${rl(x.round)}${showPos ? ' · P' + x.pos : ''}${who(x)}`;
  const span = x => !x.len ? no : `<strong>${x.len}</strong> <span class="muted">(${x.from === x.to ? rl(x.from) : rl(x.from) + ' – ' + rl(x.to)})</span>`;
  const place = x => !x ? no : `<strong>${x.rank}</strong> <span class="muted">(после ${rl(x.round)})</span>`;
  const rows = list => `<table class="standings-table stats-table"><tbody>${list.filter(Boolean)
    .map(([k, v]) => `<tr><td class="stats-key">${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>`;
  const card = (title, list) => `<div class="table-card"><div class="table-header"><h3>${title}</h3></div>${rows(list)}</div>`;

  const f = d.firsts, e = d.entries, p = d.pos, r = d.results, s = d.standing, c = d.chase, m = d.mates;
  const P1 = qual ? 'Поул' : 'Победа', P1s = qual ? 'Поулы' : 'Победы';

  const cards = [
    card('Первые', [
      [P1, at(f.p1, false)],
      team && qual ? ['Первый ряд', f.frontRow ? `${rl(f.frontRow.round)}<br>${f.frontRow.drivers.map(x => drv(x.driver, x.car, x.mfr)).join('<br>')}` : no] : null,
      [qual ? 'Топ-3' : 'Подиум', at(f.p3)],
      ['Топ-10', at(f.p10)], ['Топ-20', at(f.p20)],
    ]),
    card('Участие', [
      qual ? ['Квалификации', e.n] : team ? null : ['Квалификации', e.quals],
      qual ? null : ['Гонки', `${e.n}${pct(e.n, e.quals)}`],
      ['Самая длинная серия', span(e.streak.best)], ['Текущая серия', span(e.streak.current)],
    ]),
    card('Места', !p ? [['Лучшее место', no]] : [
      ['Лучшее место', `<strong>P${p.best}</strong> · ${p.bestList.length} раз`],
      ['', p.bestList.map(x => `${rl(x.round)}${team ? ' · ' + drv(x.driver, x.car, x.mfr) : ''}`).join('<br>')],
      ['Среднее место', fx(p.avg)],
      ['Место по среднему', `<strong>${p.avgRank}</strong> из ${p.of}`],
      ['Медиана места', fx(p.median)],
      ['Место по медиане', `<strong>${p.medianRank}</strong> из ${p.of}`],
    ]),
    card('Результативность', [
      [P1s, `${r.p1}${pct(r.p1, r.n)}`], [qual ? 'Топ-3' : 'Подиумы', `${r.p3}${pct(r.p3, r.n)}`],
      ['Топ-5', `${r.p5}${pct(r.p5, r.n)}`], ['Топ-10', `${r.p10}${pct(r.p10, r.n)}`],
      ['Лучший этап по очкам NASCAR', r.bestPts ? `<strong>${r.bestPts.pts}</strong> · ${rl(r.bestPts.round)}${team && r.bestPts.drivers?.length ? '<br>' + r.bestPts.drivers.map(x => drv(x)).join('<br>') : ''}` : no],
      ['Средние очки NASCAR за этап', fx(r.avgPts)],
      r.avgPtsRank ? ['Место по средним очкам', `<strong>${r.avgPtsRank.rank}</strong> из ${r.avgPtsRank.of}`] : null,
      ['Самая длинная серия топ-10', span(r.top10Streak.best)],
    ]),
    card('Зачёт по ходу сезона', [
      ['Лучшее место', place(s.best)], ['Худшее место', place(s.worst)],
      // ход позиций — только смены места: подряд одинаковые схлопываются
      ['Ход позиций', s.path.length ? `<span class="stats-path">${s.path.filter((x, i, a) => !i || x.rank !== a[i - 1].rank).map((x, i, a) =>
        `<span title="после ${roundFullName(x.round).replace(/"/g, '&quot;')}">${i === a.length - 1 ? `<strong>${x.rank}</strong>` : x.rank}</span>`).join(' → ')}</span>` : no],
      ['Этапов лидером', s.leader],
    ]),
    card('Чейз', team ? [
      ['Пилотов в Чейзе', c.full ? `<strong>${c.n}</strong> из ${c.full}${pct(c.n, c.full)}` : no],
      c.n ? ['Кто', c.drivers.map(x => drv(x)).join('<br>')] : null,
      ['Очки за Чейз', c.started ? `<strong>${c.pts}</strong>` : '<span class="muted">Чейз ещё не начался</span>'],
      c.started ? ['Место среди команд', `<strong>${c.rank}</strong> из ${c.teams}`] : null,
      c.started && c.onlyChase.inChase ? ['Очки за Чейз только пилотов Чейза', `<strong>${c.onlyChase.pts}</strong>`] : null,
      c.started && c.onlyChase.inChase ? ['Среднее на пилота Чейза', `<strong>${fx(c.onlyChase.avg)}</strong>`] : null,
      c.started && c.onlyChase.inChase ? ['Место среди команд Чейза', `<strong>${c.onlyChase.rank}</strong> из ${c.onlyChase.teams}`] : null,
    ] : [
      ['В Чейзе', c.playoff ? 'да' : no],
      c.playoff && c.seed != null ? ['Место посева', `<strong>${c.seed}</strong>`] : null,
      ['Место в зачёте', c.rank ?? '—'],
      c.playoff && c.started ? ['Очки за этапы Чейза', `<strong>${c.pts}</strong>`] : null,
      c.playoff && c.started ? ['Место среди пилотов Чейза', `<strong>${c.ptsRank}</strong> из ${c.of}`] : null,
    ]),
    // состав — на всю ширину: пилоты в шапке, место и очки строками
    team ? `<div class="table-card stats-wide"><div class="table-header"><h3>Состав</h3>
      <span class="muted" title="Доля гостевых заявок среди всех заявок команды">гостевые заявки: ${Math.round(m.guestPct * 100)}%</span></div>
      <div class="table-scroll"><table class="standings-table stats-roster"><thead><tr><th></th>${m.roster.map(x => `<th class="c">${drv(x.driver, x.car, x.mfr)}</th>`).join('')}</tr></thead><tbody>
      <tr><td class="stats-key">Место</td>${m.roster.map(x => `<td class="c">${x.rank ?? '—'}</td>`).join('')}</tr>
      <tr><td class="stats-key">Очки</td>${m.roster.map(x => `<td class="c"><strong>${x.pts ?? '—'}</strong></td>`).join('')}</tr>
      </tbody></table></div></div>` :
    // напарники — на всю ширину, как состав у команды: напарники в шапке, выше / ниже строками
    `<div class="table-card stats-wide"><div class="table-header"><h3>Напарники</h3>
      <span class="muted">этапов с напарниками: ${m.rounds}${m.rounds ? ` · выше всех: ${m.aboveAll}${pct(m.aboveAll, m.rounds)}` : ''}</span></div>
      ${m.vs.length ? `<div class="table-scroll"><table class="standings-table stats-roster"><thead><tr><th></th>${m.vs.map(v => `<th class="c">${drv(v.driver)}</th>`).join('')}</tr></thead><tbody>
      <tr><td class="stats-key">Выше</td>${m.vs.map(v => `<td class="c"><strong>${v.won}</strong></td>`).join('')}</tr>
      <tr><td class="stats-key">Ниже</td>${m.vs.map(v => `<td class="c">${v.lost}</td>`).join('')}</tr>
      </tbody></table></div>` : rows([['Напарников', no]])}</div>`,
  ];

  const title = team ? `${teamLink(name)}${coalMark(name)}` : drv(name);
  body.innerHTML = `<h2 class="stats-title">${title}</h2><div class="fun-grid">${cards.join('')}</div>`;
}
