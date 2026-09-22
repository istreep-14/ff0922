import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../src/config.js';
import { safeUrl } from '../src/http.js';
import { resolve, currentWeek, kickoff } from '../src/week.js';
import { nameKey, scoringFormat } from '../src/names.js';
import { rankingUrl, parseEcr, playersFromEcr } from '../src/projections.js';
import { parsePlayerBlock, parseRankingsTable } from '../src/draftsharks.js';
import { shapeLeague } from '../src/leagues.js';
import { buildSnapshot, keepLeagues } from '../src/build.js';
import { render } from '../src/html.js';

const GIBBS = `
<tbody
    data-player-row
    data-key="13542"
    data-tier-overall="1"
    data-fantasy-position="RB"
    data-player-name="Jahmyr Gibbs"
    class="">
    <tr class="player-row">
        <td class="ds-cell ds-cell--lg rank centered">
            <div class="column-title rank-index"><span>1</span></div>
        </td>
        <td class="player-cell">
            <img class="team-badge" src="/img/icons/teams/DET.svg" alt="DET logo" />
            <span class="player-details-group__team-name">DET</span>
        </td>
        <td class="ds-cell matchup centered" data-value="@IND" data-attribute="matchup"><span>@IND</span></td>
        <td class="ds-cell" data-value="18" data-attribute="weeklyFloorPts"><span>18.0</span></td>
        <td class="ds-cell ds-proj centered" data-value="20.4" data-attribute="weeklyPts"><span>20.4</span></td>
        <td class="ds-cell" data-value="25.5" data-attribute="weeklyCeilingPts"><span>25.5</span></td>
    </tr>
</tbody>`;

test('env values drop unquoted trailing comments', () => {
  const env = parseEnv('FP_WEEK=3 # pinned\nFP_EMAIL="a@b.com"\n');
  assert.equal(env.get('FP_WEEK'), '3');
  assert.equal(env.get('FP_EMAIL'), 'a@b.com');
});

test('errors do not keep the email or the league key', () => {
  const s = safeUrl('https://mpbnfl.fantasypros.com/api/getUserLeaguesJSON?email=person@example.com&key=secret-key');
  assert.equal(s.includes('person@example.com'), false);
  assert.equal(s.includes('secret-key'), false);
  assert.match(s, /email=\*\*\*/);
  assert.match(s, /key=\*\*\*/);
});

test('week pins pass through and garbage does not become a path', () => {
  assert.deepEqual(resolve({ season: 2026, week: 5 }), { season: 2026, week: 5 });
  assert.throws(() => resolve({ season: 2026, week: 'fifteen' }), /Invalid week/);
  const ko = kickoff(2026);
  assert.equal(currentWeek(ko, 2026), 1);
  assert.equal(currentWeek(new Date(ko.getTime() + 5 * 86_400_000), 2026), 2);
});

test('QB boards are one URL across scoring formats', () => {
  assert.equal(rankingUrl('QB', 'PPR'), rankingUrl('QB', 'HALF'));
  assert.equal(rankingUrl('RB', 'HALF', { ros: true }), 'https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-rb.php');
  assert.equal(rankingUrl('DST', 'STD'), 'https://www.fantasypros.com/nfl/rankings/dst.php');
});

test('ecrData projected points become players', () => {
  const html = `<script>var ecrData = {"players":[{"player_id":10,"player_name":"Ja'Marr Chase","player_team_id":"CIN","player_position_id":"WR","rank_ecr":"1","r2p_pts":"18.4","player_opponent":"BAL"}]};</script>`;
  const players = playersFromEcr(parseEcr(html));
  assert.equal(players.length, 1);
  assert.equal(players[0].fpId, '10');
  assert.equal(players[0].proj, 18.4);
  assert.equal(players[0].team, 'CIN');
});

const ROS = `
<tbody data-player-row data-key="13542" data-fantasy-position="RB" data-player-name="Jahmyr Gibbs">
  <tr>
    <td class="rank-index"><span>1</span></td>
    <span class="player-details-group__team-name">DET</span>
    <td data-attribute="games_played" data-value="15.0"></td>
    <td data-attribute="player.team.bye" data-value="6"></td>
    <td data-attribute="rosWeeklyPts" data-value="21.2"></td>
  </tr>
</tbody>`;

test('Draft Sharks ROS total is weekly points times games left', () => {
  const p = parsePlayerBlock(ROS);
  assert.equal(p.bye, 6);
  assert.equal(p.rosWeekly, 21.2);
  assert.equal(p.games, 15);
  assert.equal(p.rosTotal, 318);
});

test('Draft Sharks weekly row keeps the projection', () => {
  const p = parsePlayerBlock(GIBBS);
  assert.equal(p.name, 'Jahmyr Gibbs');
  assert.equal(p.position, 'RB');
  assert.equal(p.team, 'DET');
  assert.equal(p.opp, 'IND');
  assert.equal(p.proj, 20.4);
  assert.equal(p.floor, 18);
  assert.equal(p.ceiling, 25.5);
  assert.equal(parseRankingsTable(GIBBS + GIBBS.replace('Jahmyr Gibbs', 'Bijan Robinson')).length, 2);
});

test('a roster id picks up both projection sources', () => {
  const league = shapeLeague(
    { nickname: 'Home', host: 'sleeper' },
    {
      rosters: { ok: true, data: { scoring: 'PPR', teamId: 1, teamName: 'Mine', teams: [{ id: 1, name: 'Mine', players: [10] }] } },
      settings: { ok: true, data: {} },
      analysisWeek: { ok: true, data: { grid: [{ position: 'WR', cells: [{ fpId: 10, teamId: 1, pos: 'WR', team: 'CIN', vorp: 4.2 }] }], standings: [{ teamId: 1, teamName: 'Mine', rank: 1, score: 4.2, isUser: true }], starters: [{ position: 'WR', player: { fpId: 10, fullName: "Ja'Marr Chase" } }] } },
      analysisRos: { ok: true, data: { grid: [{ position: 'WR', cells: [{ fpId: 10, teamId: 1, pos: 'WR', team: 'CIN', vorp: 80 }] }], standings: [], starters: [] } },
    },
  );
  const snap = buildSnapshot({
    season: 2026,
    week: 3,
    leagues: [league],
    boards: {
      PPR: {
        week: [{ fpId: '10', name: "Ja'Marr Chase", team: 'CIN', position: 'WR', rank: 1, proj: 18.4, opp: 'BAL' }],
        ros: [{ fpId: '10', name: "Ja'Marr Chase", team: 'CIN', position: 'WR', rank: 2, proj: 240 }],
      },
    },
    sharks: {
      PPR: {
        week: [{ name: 'JaMarr Chase', position: 'WR', proj: 17.2, rank: 3 }],
        ros: [{ name: "Ja'Marr Chase", position: 'WR', rosTotal: 250, rank: 4 }],
      },
    },
  });
  const p = snap.leagues[0].teams[0].players[0];
  assert.equal(nameKey("Ja'Marr Chase", 'WR'), nameKey('JaMarr Chase', 'WR'));
  assert.equal(p.name, "Ja'Marr Chase");
  assert.equal(p.fpWeek, 18.4);
  assert.equal(p.fpRos, 240);
  assert.equal(p.dsWeek, 17.2);
  assert.equal(p.dsRos, 250);
  assert.equal(p.vorpWeek, 4.2);
  assert.equal(scoringFormat('HALF'), 'HALF');

  const html = render(snap);
  assert.match(html, /Ja&#39;Marr Chase/);
  assert.match(html, /18\.4/);
  assert.match(html, /17\.2/);
  assert.match(html, /id="week"/);
  assert.match(html, /id="sharks"/);
  assert.equal(html.includes('<script>alert'), false);
});

test('an empty league fetch does not wipe the previous list', () => {
  const prev = [{ nickname: 'Kept', teams: [] }];
  assert.equal(keepLeagues(prev, []).kept, true);
  assert.equal(keepLeagues(prev, []).leagues[0].nickname, 'Kept');
  assert.equal(keepLeagues(prev, [{ nickname: 'New' }]).kept, false);
  assert.equal(keepLeagues([], []).kept, false);
});

test('html escapes a league name', () => {
  const html = render({
    season: 2026,
    week: 3,
    fetchedAt: '2026-09-22T00:00:00Z',
    scorings: ['PPR'],
    errors: [],
    leagues: [{ nickname: 'A <script>', host: 'espn', scoring: 'PPR', teams: [], standings: { week: [], ros: [] }, errors: [] }],
    boards: { PPR: { week: [], ros: [] } },
    sharks: { PPR: { week: [], ros: [] } },
  });
  assert.match(html, /A &lt;script&gt;/);
  assert.equal(html.includes('A <script>'), false);
});
