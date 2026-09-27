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

  // 3. Подиумы / топ-5 / топ-10: пилоты и команды рядом
  const pair = t => `<div class="fun-pair">
    ${table('<th class="r w-40"></th><th>Пилот</th><th class="r">К-во</th>', t.drivers.map(x =>
      `<tr${rankCls(x.rank)}><td class="r">${place(x.rank)}</td><td><strong>${driverLink(x.name)}</strong></td><td class="r"><strong>${x.n}</strong></td></tr>`).join(''))}
    ${table('<th class="r w-40"></th><th>Команда</th><th class="r">К-во</th>', t.teams.map(x =>
      `<tr${rankCls(x.rank)}><td class="r">${place(x.rank)}</td><td class="team-text"><strong>${teamLink(x.name)}</strong>${coalMark(x.name)}</td><td class="r"><strong>${x.n}</strong></td></tr>`).join(''))}
  </div>`;

  document.getElementById('fun-body').innerHTML = `<div class="fun-grid">
    ${card(`Зачёт производителей · ${unit}`, mfrTable + mfrPivot)}
    ${card('Текущая серия', streaks)}
    ${card('Победы — 10 лучших', pair(d.wins))}
    ${card('Подиумы — 10 лучших', pair(d.podium))}
    ${card('Топ-5 — 10 лучших', pair(d.top5))}
    ${card('Топ-10 — 10 лучших', pair(d.top10))}
  </div>`;
}
