/* Вкладка «Прочее»: весёлые зачёты сезона — производители, текущие серии, подиумы,
   топ-5 и топ-10. Считает local-api (rpc fun), отдельно по гонкам и квалификациям. */

let funSession = 'race';

// ссылка на протокол этапа той же сессии, что открыта во вкладке
const roundLink = n => `<span class="driver-link" title="Открыть протокол этапа" onclick="goToRound(${n}, '${funSession}')">${roundFullName(n)}</span>`;

async function setFunSession(session) {
  funSession = session;
  document.querySelectorAll('.rtog-btn[data-fun]').forEach(b => b.classList.toggle('rtog-active', b.dataset.fun === session));
  await renderFun();
}

async function renderFun() {
  const cache = state.fun ||= {};
  const d = cache[funSession] ||= await rpc('fun', { season: state.year, division: state.division, session: funSession }, state.fresh);
  const place = n => `<span class="pos-badge">${n}</span>`;
  const card = (title, body, cls = '') => `<div class="table-card${cls}"><div class="table-header"><h3>${title}</h3></div>${body}</div>`;
  const table = (head, rows) => `<div class="table-scroll"><table class="standings-table"><thead><tr>${head}</tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">Нет данных</td></tr>'}</tbody></table></div>`;
  const rankCls = r => r <= 3 ? ` class="rank-${r}"` : '';

  // 1. Производители: итог и сводная по этапам (лучшее место марки и кто его привёз)
  const m = d.manufacturers;
  const mfrTable = table('<th class="r w-40"></th><th>Марка</th><th class="r">Победы</th><th class="r">Очки</th>',
    m.map((x, i) => `<tr${rankCls(i + 1)}><td class="r">${place(i + 1)}</td><td>${mfrBadge(x.mfr)}</td>
      <td class="r">${x.wins}</td><td class="r"><strong>${x.points}</strong></td></tr>`).join(''));
  const mfrPivot = `<div class="table-scroll fun-pivot"><table class="standings-table"><thead><tr>
    <th class="sticky-col">Этап</th>${m.map(x => `<th class="c">${mfrBadge(x.mfr)}</th>`).join('')}</tr></thead><tbody>
    ${spoilerRows('funMfr', d.rounds, '', 5).map(n => {
      const best = Math.min(...m.map(x => x.byRound[n]?.pos ?? Infinity));
      return `<tr><td class="sticky-col">${roundLink(n)}</td>${m.map(x => {
        const c = x.byRound[n];
        return c ? `<td class="c${c.pos === best ? ' h2h-win' : ''}" title="${c.driver.replace(/"/g, '&quot;')} — ${c.pts} очк.">P${c.pos} ${driverLink(c.driver, null, surname(c.driver))}</td>`
          : '<td class="c muted">—</td>';
      }).join('')}</tr>`;
    }).join('')}</tbody></table></div>` + spoilerHtml('funMfr', d.rounds.length, 5);

  // 2. Текущие серии без пропусков
  const unit = funSession === 'qual' ? 'квалификаций' : 'гонок';
  const streaks = table(`<th class="r w-40"></th><th>Пилот</th><th class="hide-sm">Команда</th><th class="r">Подряд</th><th title="Этап, на котором серия прервалась в последний раз">Пропуск</th>`,
    spoilerRows('funStreaks', d.streaks, '', 10).map(x => `<tr${rankCls(x.rank)}><td class="r">${place(x.rank)}</td><td><strong>${driverLink(x.driver)}</strong></td>
      <td class="team-text hide-sm">${teamLink(x.team)}${coalMark(x.team)}</td><td class="r"><strong>${x.len}</strong></td>
      <td>${x.missed == null ? '<span class="muted">не было</span>' : roundLink(x.missed)}</td></tr>`).join(''))
    + spoilerHtml('funStreaks', d.streaks.length, 10);

  // Лучшие командные этапы сезона: два зачётных места и их очки NASCAR
  const posCells = (p, rnd) => p.map(x => `<span class="pos-cell ${posClass(x, state.roundMaxPos[rnd] || 40)}">${x}</span>`).join(' ');
  const teamBest = table('<th class="r w-40"></th><th>Команда</th><th>Этап</th><th>Позиции</th><th class="r">Очки</th>',
    spoilerRows('funTeamBest', d.teamBest, '', 10).map(x => `<tr${rankCls(x.rank)}><td class="r">${place(x.rank)}</td>
      <td class="team-text"><strong>${teamLink(x.team)}</strong>${coalMark(x.team)}</td><td>${roundLink(x.round)}</td>
      <td class="nowrap">${posCells(x.pos, x.round)}</td><td class="r"><strong>${x.pts}</strong></td></tr>`).join(''))
    + spoilerHtml('funTeamBest', d.teamBest.length, 10);

  // Лучшая команда каждого этапа (при равных очках — чей лучший результат выше)
  const roundTeams = table('<th>Этап</th><th>Команда</th><th>Позиции</th><th class="r">Очки</th>',
    spoilerRows('funRoundTeam', d.roundBestTeam, '', 10).map(x => `<tr><td>${roundLink(x.round)}</td>
      <td class="team-text">${x.teams.map(t => `<strong>${teamLink(t.team)}</strong>${coalMark(t.team)}`).join('<br>')}</td>
      <td class="nowrap">${x.teams.map(t => posCells(t.pos, x.round)).join('<br>')}</td><td class="r"><strong>${x.pts}</strong></td></tr>`).join(''))
    + spoilerHtml('funRoundTeam', d.roundBestTeam.length, 10);

  // 3. Подиумы / топ-5 / топ-10: пилоты и команды рядом
  // в каждой таблице видно 10 строк, остальные — под «Показать все» (key — свой у каждой таблицы)
  const pair = (t, key, unitLabel = 'К-во') => `<div class="fun-pair">
    <div>${table(`<th class="r w-40"></th><th>Пилот</th><th class="r">${unitLabel}</th>`, spoilerRows(`fun-${key}-d`, t.drivers, '', 10).map(x =>
      `<tr${rankCls(x.rank)}><td class="r">${place(x.rank)}</td><td><strong>${driverLink(x.name)}</strong></td><td class="r"><strong>${x.n}</strong></td></tr>`).join(''))}${spoilerHtml(`fun-${key}-d`, t.drivers.length, 10)}</div>
    <div>${table(`<th class="r w-40"></th><th>Команда</th><th class="r">${unitLabel}</th>`, spoilerRows(`fun-${key}-t`, t.teams, '', 10).map(x =>
      `<tr${rankCls(x.rank)}><td class="r">${place(x.rank)}</td><td class="team-text"><strong>${teamLink(x.name)}</strong>${coalMark(x.name)}</td><td class="r"><strong>${x.n}</strong></td></tr>`).join(''))}${spoilerHtml(`fun-${key}-t`, t.teams.length, 10)}</div>
  </div>`;

  // допы гонки — только во вкладке гонок; DUE — только там, где он есть (Star)
  const bonusCards = b => !b ? '' : [
    card('Жёлтые флаги', pair(b.cau, 'cau', 'Очки')),
    card('Сходы', pair(b.ret, 'ret', 'Очки')),
    b.due ? card('Дуэли', pair(b.due, 'due', 'Очки')) : '',
    card('Дополнительные показатели', pair(b.all, 'bonus', 'Очки')),
  ].join('');

  document.getElementById('fun-body').innerHTML = `<div class="fun-grid">
    ${card(`Зачёт производителей · ${unit}`, mfrTable + mfrPivot)}
    ${card('Текущая серия', streaks)}
    ${card('Максимальный результат', pair(d.maxResults, 'max'))}
    ${card('Лучшие командные этапы сезона', teamBest)}
    ${card('Лучшая команда этапа', roundTeams)}
    ${card('Победы', pair(d.wins, 'wins'))}
    ${card('Подиумы', pair(d.podium, 'podium'))}
    ${card('Топ-5', pair(d.top5, 'top5'))}
    ${card('Топ-10', pair(d.top10, 'top10'))}
    ${bonusCards(d.bonuses)}
  </div>`;
}
