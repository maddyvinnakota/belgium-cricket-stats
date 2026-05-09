const express = require('express');
const cors    = require('cors');
const path    = require('path');
const {
  fetchSeriesList,
  fetchPointsTable,
  fetchMatchList,
  fetchTeamMatches,
  fetchSeriesRules,
  fetchPlayerStats,
  fetchFixtureDetails,
  ensureBrowser,
  closeBrowser,
} = require('./scraper');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── TTL cache with per-key durations ─────────────────────────────
const TTL = {
  series:  24 * 60 * 60 * 1000,  // 24 h  — series list almost never changes
  rules:    6 * 60 * 60 * 1000,  //  6 h  — points rules fixed for the season
  pt:      30 * 60 * 1000,       // 30 min — points table updates after matches
  ml:      30 * 60 * 1000,       // 30 min — match list
  tm:      30 * 60 * 1000,       // 30 min — per-team match points
  ps:      30 * 60 * 1000,       // 30 min — player stats
};
function ttlFor(k) {
  const prefix = k.split('_')[0];
  return TTL[prefix] ?? 30 * 60 * 1000;
}
const _cache = new Map();
function cGet(k)      { const e = _cache.get(k); return e && Date.now()-e.ts < ttlFor(k) ? e.d : null; }
function cSet(k, d)   { _cache.set(k, { d, ts: Date.now() }); return d; }
async function cached(k, fn) { return cGet(k) ?? cSet(k, await fn()); }

// ── Error wrapper ─────────────────────────────────────────────────
function handle(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      console.error(e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

// Send cache-control header matching our server-side TTL
function setCacheHeader(res, cacheKey) {
  const secs = Math.floor(ttlFor(cacheKey) / 1000);
  res.set('Cache-Control', `public, max-age=${secs}, stale-while-revalidate=${secs * 2}`);
}

// ══════════════════════════════════════════════════════════════════
//  GET /api/series
//  Returns: [{seriesId, seriesName, year, seriesStatus, seriesType, startDate}]
// ══════════════════════════════════════════════════════════════════
app.get('/api/series', handle(async (req, res) => {
  const raw = await cached('series', () => fetchSeriesList());
  const series = (raw.seriesList ?? raw).map(s => ({
    seriesId:   s.seriesId,
    name:       s.seriesName,
    year:       s.year,
    status:     s.seriesStatus,   // UPCOMING / ONGOING / COMPLETED
    type:       s.seriesType,
    startDate:  s.startDate,
    divisions:  (s.divisions ?? []).map(d => ({
      seriesId: d.seriesId, name: d.name, status: d.seriesStatus,
    })),
  }));
  setCacheHeader(res, 'series');
  res.json(series);
}));

// ══════════════════════════════════════════════════════════════════
//  GET /api/points-table?seriesId=XXX
//  Returns: [{groupName, groupId, teams: [...normalised team objects]}]
// ══════════════════════════════════════════════════════════════════
app.get('/api/points-table', handle(async (req, res) => {
  const { seriesId } = req.query;
  if (!seriesId) return res.status(400).json({ error: 'seriesId required' });

  const raw = await cached(`pt_${seriesId}`, () => fetchPointsTable(seriesId));

  // raw is an array of group objects: [{groupName, groupId, teams:[...]}]
  const groups = raw.map(group => ({
    groupName: group.groupName || 'Group',
    groupId:   group.encryptedGroupId || group.groupId,
    teams: (group.teams ?? []).map((t, i) => {
      const tm = t.team ?? t;
      const m  = (tm.matches       ?? tm.mat    ?? 0);
      const w  = (tm.won           ?? tm.wins   ?? 0);
      const l  = (tm.lost          ?? tm.losses ?? 0);
      const ti = (tm.tied          ?? tm.tie    ?? 0);
      const nr = (tm.noResult      ?? tm.nr     ?? 0);
      const rs = (tm.runsScored    ?? 0);
      const rg = (tm.runsGiven     ?? 0);
      const bs = (tm.ballsBowled   ?? 0);  // balls bowled = overs bowled * 6
      const bf = (tm.ballsFaced    ?? 0);

      // Compute overs
      const oversFor   = bs > 0 ? `${Math.floor(bs/6)}.${bs%6}` : '-';
      const oversAgst  = bf > 0 ? `${Math.floor(bf/6)}.${bf%6}` : '-';

      return {
        rank:    i + 1,
        team:    tm.teamName  ?? tm.name ?? '',
        code:    tm.teamCode  ?? '',
        teamId:  tm.encryptedTeamId ?? '',
        logo:    tm.logo_file_path ? `https://static.cricclubs.com/${tm.logo_file_path}` : '',
        m, w, l, t: ti, nr,
        pts:     parseFloat(tm.points ?? tm.pts ?? 0),
        nrr:     parseFloat(tm.netRunRate ?? tm.nrr ?? 0),
        runsFor:  rs,
        runsAgst: rg,
        oversFor,
        oversAgst,
        forDisplay:   rs > 0 ? `${rs}/${oversFor}` : '-',
        agstDisplay:  rg > 0 ? `${rg}/${oversAgst}` : '-',
        matchSchedule: (t.matchSchedule ?? []).map(ms => ({
          date:   ms.matchDate ?? ms.date ?? '',
          vs:     ms.opponentTeamName ?? ms.opponent ?? '',
          result: ms.result ?? '',
        })),
      };
    }).sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      return b.nrr - a.nrr;
    }).map((t, i) => ({ ...t, rank: i + 1 })),
  }));

  setCacheHeader(res, `pt_${seriesId}`);
  res.json(groups);
}));

// ══════════════════════════════════════════════════════════════════
//  GET /api/matches?seriesId=XXX
//  Returns all matches (completed + upcoming) for a series,
//  sorted chronologically.
// ══════════════════════════════════════════════════════════════════
app.get('/api/matches', handle(async (req, res) => {
  const { seriesId } = req.query;
  if (!seriesId) return res.status(400).json({ error: 'seriesId required' });

  const raw = await cached(`ml_${seriesId}`, () => fetchMatchList(seriesId));

  // Completed entries take priority; deduplicate by (dateDay + teamOne + teamTwo)
  // because the same physical match can appear in both completed[] and scheduled[]
  // with different fixtureIds.
  const normalize = m => ({
    fixtureId: m.fixtureId ?? '',
    date:      m.matchDateTime ?? m.date ?? '',
    teamOne:   { id: m.teamOne?.id ?? '', name: m.teamOne?.name ?? '' },
    teamTwo:   { id: m.teamTwo?.id ?? '', name: m.teamTwo?.name ?? '' },
    status:    m.status ?? '',
    condition: m.condition ?? '',
    result:    m.scoreSummary?.result ?? '',
    ground:    m.ground?.name ?? '',
  });

  const key = m => {
    const day = (m.matchDateTime ?? m.date ?? '').slice(0, 10);
    const t1  = m.teamOne?.name ?? '';
    const t2  = m.teamTwo?.name ?? '';
    return `${day}|${[t1, t2].sort().join('|')}`;
  };

  // Process completed first so their keys win the dedup
  const byKey = new Map();
  for (const m of [...(raw.completed ?? []), ...(raw.ongoing ?? []), ...(raw.scheduled ?? [])]) {
    const k = key(m);
    if (!byKey.has(k)) byKey.set(k, m); // first (completed) wins
  }

  const matches = [...byKey.values()]
    .map(normalize)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Fetch points rules in parallel (cached separately)
  const rules = await cached(`rules_${seriesId}`, () => fetchSeriesRules(seriesId))
    .catch(() => ({ winPoints: 2, lossPoints: 0, tiePoints: 1, abandonedPoints: 1 }));

  setCacheHeader(res, `ml_${seriesId}`);
  res.json({ matches, rules });
}));

// Keep /api/schedule as an alias that returns the old per-team flat format
// (used by the Schedule tab in the UI)
app.get('/api/schedule', handle(async (req, res) => {
  const { seriesId } = req.query;
  if (!seriesId) return res.status(400).json({ error: 'seriesId required' });

  const raw = await cached(`ml_${seriesId}`, () => fetchMatchList(seriesId));

  // Same dedup as /api/matches: key by date+teams, completed wins over scheduled
  const matchKey = m => {
    const day = (m.matchDateTime ?? m.date ?? '').slice(0, 10);
    return `${day}|${[m.teamOne?.name ?? '', m.teamTwo?.name ?? ''].sort().join('|')}`;
  };
  const byKey = new Map();
  for (const m of [...(raw.completed ?? []), ...(raw.ongoing ?? []), ...(raw.scheduled ?? [])]) {
    if (!byKey.has(matchKey(m))) byKey.set(matchKey(m), m);
  }
  const schedule = [...byKey.values()]
    .sort((a, b) => new Date(a.matchDateTime ?? a.date) - new Date(b.matchDateTime ?? b.date))
    .flatMap(m => {
      const base = { date: m.matchDateTime ?? m.date ?? '', result: m.scoreSummary?.result ?? '', ground: m.ground?.name ?? '', matchId: m.fixtureId ?? '' };
      return [
        { ...base, team: m.teamOne?.name ?? '', opponent: m.teamTwo?.name ?? '' },
        { ...base, team: m.teamTwo?.name ?? '', opponent: m.teamOne?.name ?? '' },
      ];
    });
  setCacheHeader(res, `ml_${seriesId}`);
  res.json(schedule);
}));

// ══════════════════════════════════════════════════════════════════
//  GET /api/player-stats?seriesId=XXX
// ══════════════════════════════════════════════════════════════════
app.get('/api/player-stats', handle(async (req, res) => {
  const { seriesId } = req.query;
  if (!seriesId) return res.status(400).json({ error: 'seriesId required' });

  const raw = await cached(`ps_${seriesId}`, () => fetchPlayerStats(seriesId));
  setCacheHeader(res, `ps_${seriesId}`);
  res.json(raw);
}));

// ══════════════════════════════════════════════════════════════════
//  GET /api/debug?seriesId=XXX  —  raw API response for inspection
// ══════════════════════════════════════════════════════════════════
app.get('/api/debug-raw', handle(async (req, res) => {
  const { seriesId } = req.query;
  const raw = await fetchPointsTable(seriesId ?? '_DyhIUkq6-wjDK5YPh4A9w');
  res.json(raw);
}));

// ══════════════════════════════════════════════════════════════════
//  GET /api/team-matches?seriesId=XXX&teamId=YYY&year=ZZZZ
//  Returns per-match data for one team with exact points (incl. bonus)
//  via selectedTeamPoints field from CricClubs API
// ══════════════════════════════════════════════════════════════════
app.get('/api/team-matches', handle(async (req, res) => {
  const { seriesId, teamId, year } = req.query;
  if (!seriesId || !teamId) return res.status(400).json({ error: 'seriesId and teamId required' });

  const raw = await cached(`tm_${seriesId}_${teamId}`, () => fetchTeamMatches(seriesId, teamId, year));

  // Normalize: extract fixtureId -> selectedTeamPoints from completed matches
  const matches = [...(raw.completed ?? []), ...(raw.ongoing ?? [])].map(m => ({
    fixtureId:          m.fixtureId ?? '',
    selectedTeamPoints: m.selectedTeamPoints ?? null,
    result:             m.scoreSummary?.result ?? m.result ?? '',
  }));

  setCacheHeader(res, `tm_${seriesId}_${teamId}`);
  res.json(matches);
}));

app.get('/api/debug-fixture', handle(async (req, res) => {
  const { fixtureId } = req.query;
  if (!fixtureId) return res.status(400).json({ error: 'fixtureId required' });
  const raw = await fetchFixtureDetails(fixtureId);
  res.json(raw);
}));

// Warm up: launch browser and pre-fetch series list
ensureBrowser()
  .then(() => fetchSeriesList())
  .then(() => console.log('  ✅ Ready'))
  .catch(e  => console.warn('  ⚠️  Pre-load failed:', e.message));

process.on('exit', () => closeBrowser().catch(() => {}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏏 Belgium Cricket Stats  →  http://localhost:${PORT}\n`);
});
