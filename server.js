import http from 'node:http';

const LEAGUE_ID = 202061;
const BASE = 'https://fantasy.premierleague.com/api';
const PORT = process.env.PORT || 10000;

async function getJSON(path) {
  const r = await fetch(BASE + path, { headers: { Accept: 'application/json', 'User-Agent': 'Kiwi-Hjemseng-FPL/1.0' } });
  if (!r.ok) throw new Error(`FPL API ${r.status}: ${path}`);
  return r.json();
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (path === '/health') return send(res, 200, { ok: true, service: 'Kiwi Hjemseng FPL', league_id: LEAGUE_ID, time: new Date().toISOString() });
  if (path !== '/' && path !== '/league') return send(res, 404, { error: 'Not found', routes: ['/', '/league', '/health'] });

  try {
    const [bootstrap, league] = await Promise.all([
      getJSON('/bootstrap-static/'),
      getJSON(`/leagues-classic/${LEAGUE_ID}/standings/`)
    ]);
    const events = bootstrap.events || [];
    const event = events.find(e => e.is_current) || [...events].reverse().find(e => e.finished) || events[0];
    if (!event) throw new Error('Could not determine gameweek');
    const gw = event.id;
    const playerMap = new Map((bootstrap.elements || []).map(p => [p.id, p.web_name]));
    let live = { elements: [] };
    try { live = await getJSON(`/event/${gw}/live/`); } catch {}
    const livePoints = new Map((live.elements || []).map(p => [p.id, p.stats?.total_points ?? 0]));
    const rows = league.standings?.results || [];

    const managers = await Promise.all(rows.map(async row => {
      const id = row.entry;
      const [h, p, e] = await Promise.allSettled([
        getJSON(`/entry/${id}/history/`),
        getJSON(`/entry/${id}/event/${gw}/picks/`),
        getJSON(`/entry/${id}/`)
      ]);
      const history = h.status === 'fulfilled' ? h.value : null;
      const picks = p.status === 'fulfilled' ? p.value : null;
      const entry = e.status === 'fulfilled' ? e.value : null;
      const gh = history?.current?.find(x => x.event === gw) || null;
      const squad = (picks?.picks || []).map(x => ({ id: x.element, name: playerMap.get(x.element) || `Player ${x.element}`, position: x.position, multiplier: x.multiplier, captain: !!x.is_captain, vice_captain: !!x.is_vice_captain, live_points: livePoints.get(x.element) ?? null }));
      const bench = squad.filter(x => x.position > 11);
      const cap = squad.find(x => x.captain) || null;
      const vice = squad.find(x => x.vice_captain) || null;
      const synchronized = gh?.points != null && row.event_total != null && gh.points === row.event_total;
      return {
        rank: row.rank, last_rank: row.last_rank, rank_change: row.last_rank && row.rank ? row.last_rank - row.rank : 0,
        entry_id: id, team_name: row.entry_name, manager_name: row.player_name,
        gw_points: row.event_total, total_points: row.total, overall_rank: entry?.summary_overall_rank ?? null,
        history_gw_points: gh?.points ?? null, synchronized,
        transfers: gh?.event_transfers ?? null, transfer_cost: gh?.event_transfers_cost ?? null,
        official_bench_points: gh?.points_on_bench ?? null,
        computed_bench_points: bench.reduce((s, x) => s + (x.live_points || 0), 0), active_chip: picks?.active_chip || null,
        captain: cap ? { name: cap.name, live_points: cap.live_points, multiplier: cap.multiplier } : null,
        vice_captain: vice ? { name: vice.name, live_points: vice.live_points } : null,
        starting_xi: squad.filter(x => x.position <= 11), bench
      };
    }));

    const synced = managers.filter(m => m.synchronized).length;
    const scores = managers.map(m => m.gw_points).filter(Number.isFinite).sort((a,b)=>a-b);
    const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : null;
    const mid = Math.floor(scores.length/2);
    const median = !scores.length ? null : scores.length % 2 ? scores[mid] : (scores[mid-1]+scores[mid])/2;
    const high = managers.length ? [...managers].sort((a,b)=>b.gw_points-a.gw_points)[0] : null;
    const low = managers.length ? [...managers].sort((a,b)=>a.gw_points-b.gw_points)[0] : null;

    send(res, 200, {
      generated_at: new Date().toISOString(),
      league: { id: LEAGUE_ID, name: league.league?.name || 'Kiwi Hjemseng', number_of_managers: managers.length },
      gameweek: { id: gw, name: event.name, deadline_time: event.deadline_time, finished: !!event.finished, data_checked: !!event.data_checked, is_current: !!event.is_current },
      processing_status: { all_managers_synchronized: managers.length > 0 && synced === managers.length, synchronized_managers: synced, total_managers: managers.length, safe_to_treat_as_final: !!event.finished && !!event.data_checked && managers.length > 0 && synced === managers.length },
      gw_statistics: { average: avg == null ? null : Math.round(avg*10)/10, median, highest_score: high ? { manager: high.manager_name, team: high.team_name, points: high.gw_points } : null, lowest_score: low ? { manager: low.manager_name, team: low.team_name, points: low.gw_points } : null },
      standings: managers
    });
  } catch (err) {
    send(res, 500, { ok: false, error: err.message, time: new Date().toISOString() });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
