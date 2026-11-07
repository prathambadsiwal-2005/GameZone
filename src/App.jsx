import { useEffect, useMemo, useState } from 'react';
import {
  collection, doc, onSnapshot, addDoc, deleteDoc, updateDoc, getDocs,
  serverTimestamp, query, orderBy, where
} from 'firebase/firestore';
import { db, ready, connect, auth, ADMIN_EMAIL, loginAdmin, logoutAdmin } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

const LOCAL = 'gamezone-data';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const makeId = () => crypto.randomUUID();
const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]} Place`;
};
const positionLabel = (rank, total) => Number(rank) === Number(total) ? 'Last Place' : ordinal(Number(rank));
const scoreFor = (rank, total) => total > 1 ? ((total - Number(rank)) / (total - 1)) * 100 : 100;
const round = n => Math.round((n + Number.EPSILON) * 10) / 10;

const localRead = () => {
  try {
    const data = JSON.parse(localStorage.getItem(LOCAL)) || {};
    return { players: data.players || [], matches: data.matches || [], sessions: data.sessions || [] };
  } catch {
    return { players: [], matches: [], sessions: [] };
  }
};

function buildStats(list, players = []) {
  const out = {};
  players.forEach(p => out[p.id] = {
    played: 0, wins: 0, losses: 0, scoreTotal: 0, positions: {}, firstRate: 0, lastRate: 0
  });
  list.forEach(m => {
    const rankings = m.rankings || [];
    const total = rankings.length;
    rankings.forEach(r => {
      if (!out[r.playerId]) out[r.playerId] = {
        played: 0, wins: 0, losses: 0, scoreTotal: 0, positions: {}, firstRate: 0, lastRate: 0
      };
      const s = out[r.playerId];
      const rank = Number(r.rank);
      const label = positionLabel(rank, total);
      s.played += 1;
      s.positions[label] = (s.positions[label] || 0) + 1;
      s.scoreTotal += scoreFor(rank, total);
      if (rank === 1) s.wins += 1;
      if (rank === total) s.losses += 1;
    });
  });
  Object.values(out).forEach(s => {
    s.firstRate = s.played ? round((s.wins / s.played) * 100) : 0;
    s.lastRate = s.played ? round((s.losses / s.played) * 100) : 0;
    s.averageScore = s.played ? round(s.scoreTotal / s.played) : 0;
    Object.keys(s.positions).forEach(k => {
      s.positions[k + 'Rate'] = round((s.positions[k] / s.played) * 100);
    });
  });
  return out;
}

function positionRows(list, playerId = null) {
  const counts = {};
  list.forEach(m => {
    const total = (m.rankings || []).length;
    (m.rankings || []).filter(r => !playerId || r.playerId === playerId).forEach(r => {
      const label = positionLabel(r.rank, total);
      counts[label] = (counts[label] || 0) + 1;
    });
  });
  return Object.entries(counts).sort((a, b) => {
    if (a[0] === 'Last Place') return 1;
    if (b[0] === 'Last Place') return -1;
    return parseInt(a[0], 10) - parseInt(b[0], 10);
  }).map(([position, count]) => ({ position, count }));
}

function MatchRow({ m, onOpen, index }) {
  const winner = m.rankings?.find(r => Number(r.rank) === 1);
  const loser = m.rankings?.find(r => Number(r.rank) === (m.rankings || []).length);
  return <button className="match match-click" onClick={() => onOpen(m)}>
    <div><b>{index ? `Game ${index}` : (m.title || 'Game')}</b>
      <small>{m.date} · {(m.rankings || []).length} players{m.sessionTitle ? ` · ${m.sessionTitle}` : ''}</small></div>
    <span>1st: {winner?.playerName || '—'}<small>Last: {loser?.playerName || '—'}</small></span>
  </button>;
}

function PositionTable({ list, players, compact = false }) {
  const stats = buildStats(list, players);
  const allPositions = positionRows(list).map(x => x.position);
  return <div className="table-wrap"><table className="position-table">
    <thead><tr><th>Player</th><th>Games</th>{allPositions.map(pos => <th key={pos}>{pos}</th>)}<th>Avg. Score</th></tr></thead>
    <tbody>{players.filter(p => (stats[p.id]?.played || 0) > 0).map(p => {
      const s = stats[p.id];
      return <tr key={p.id}><td>{p.name}</td><td>{s.played}</td>
        {allPositions.map(pos => <td key={pos}>{s.positions[pos] || 0}</td>)}
        <td>{s.averageScore}/100</td></tr>;
    })}</tbody>
  </table>{!list.length && <p className="muted">No games recorded for this period.</p>}
  {compact && <small className="muted">Position columns are generated from the ranks used in these matches. Last Place is identified separately for each game.</small>}</div>;
}

export default function App() {
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [tab, setTab] = useState('Dashboard');
  const [admin, setAdmin] = useState(false);
  const [email, setEmail] = useState(ADMIN_EMAIL);
  const [password, setPassword] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [name, setName] = useState('');
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState('Game Session');
  const [sessionDate, setSessionDate] = useState(today());
  const [chosen, setChosen] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [ranks, setRanks] = useState({});
  const [dailyDate, setDailyDate] = useState(today());
  const [msg, setMsg] = useState('');
  const [cloud, setCloud] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);

  useEffect(() => {
    if (!ready || !auth) return;
    return onAuthStateChanged(auth, user => setAdmin(user?.email === ADMIN_EMAIL));
  }, []);

  useEffect(() => {
    if (!ready) {
      const data = localRead();
      setPlayers(data.players); setMatches(data.matches); setSessions(data.sessions);
      setDataLoaded(true);
      return;
    }
    let stopPlayers, stopMatches, stopSessions;
    connect().then(() => {
      setCloud(true);
      stopPlayers = onSnapshot(collection(db, 'players'), snap =>
        setPlayers(snap.docs.map(x => ({ id: x.id, ...x.data() })))
      );
      stopMatches = onSnapshot(query(collection(db, 'matches'), orderBy('createdAt', 'desc')), snap =>
        setMatches(snap.docs.map(x => ({ id: x.id, ...x.data() })))
      );
      stopSessions = onSnapshot(query(collection(db, 'sessions'), orderBy('createdAt', 'desc')), snap =>
        setSessions(snap.docs.map(x => ({ id: x.id, ...x.data() })))
      );
    }).catch(error => setMsg(`Firebase connection: ${error.message}`));
    return () => { stopPlayers?.(); stopMatches?.(); stopSessions?.(); };
  }, []);

  useEffect(() => {
    if (!ready && dataLoaded) localStorage.setItem(LOCAL, JSON.stringify({ players, matches, sessions }));
  }, [players, matches, sessions, dataLoaded]);

  const ask = () => {
    if (!admin) setLoginOpen(true);
    return admin;
  };

  const unlock = async () => {
    setAuthBusy(true);
    try {
      await loginAdmin(email.trim(), password);
      setLoginOpen(false); setPassword(''); setMsg('Admin access enabled');
    } catch (error) {
      setMsg(error.code === 'auth/invalid-credential' ? 'Incorrect email or password' : `Login failed: ${error.message}`);
    } finally { setAuthBusy(false); }
  };

  const exitAdmin = async () => {
    try { await logoutAdmin(); setMsg('Admin access closed'); }
    catch (error) { setMsg(`Logout failed: ${error.message}`); }
  };

  const addPlayer = async e => {
    e.preventDefault();
    if (!ask()) return;
    const playerName = name.trim();
    if (!playerName) return;
    if (players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      setMsg('Player already exists'); return;
    }
    if (ready) await addDoc(collection(db, 'players'), { name: playerName, createdAt: serverTimestamp() });
    else setPlayers(old => [...old, { id: makeId(), name: playerName }]);
    setName('');
  };

  const delPlayer = async id => {
    if (!ask() || !confirm('Delete this player? Historical match records will remain.')) return;
    if (ready) await deleteDoc(doc(db, 'players', id));
    else setPlayers(old => old.filter(p => p.id !== id));
  };

  const delMatch = async id => {
    if (!ask() || !confirm('Delete this game result? Statistics will be recalculated.')) return;
    if (ready) await deleteDoc(doc(db, 'matches', id));
    else setMatches(old => old.filter(m => m.id !== id));
    setSelectedMatch(null);
  };

  const delSession = async session => {
    if (!ask()) return;
    const gameCount = matches.filter(m => m.sessionId === session.id).length;
    const message = gameCount
      ? `Delete session "${session.title}" and its ${gameCount} saved game(s)? This cannot be undone.`
      : `Delete session "${session.title}"? This cannot be undone.`;
    if (!confirm(message)) return;
    if (ready) {
      const snapshot = await getDocs(query(collection(db, 'matches'), where('sessionId', '==', session.id)));
      await Promise.all(snapshot.docs.map(item => deleteDoc(item.ref)));
      await deleteDoc(doc(db, 'sessions', session.id));
    } else {
      setMatches(old => old.filter(m => m.sessionId !== session.id));
      setSessions(old => old.filter(s => s.id !== session.id));
    }
    if (activeSession?.id === session.id) setActiveSession(null);
    if (selectedSession?.id === session.id) setSelectedSession(null);
    setMsg('Session and its saved games deleted.');
  };

  const startSessionForm = () => {
    if (!ask()) return;
    setChosen([]); setSessionTitle('Game Session'); setSessionDate(today()); setSessionOpen(true);
  };

  const createSession = async () => {
    if (chosen.length < 2) return setMsg('Select at least two players');
    const session = {
      title: sessionTitle.trim() || 'Game Session', date: sessionDate,
      playerIds: chosen,
      playerNames: chosen.map(id => players.find(p => p.id === id)?.name || 'Unknown'),
      status: 'active', gameCount: 0,
      createdAt: ready ? serverTimestamp() : new Date().toISOString()
    };
    let created;
    if (ready) {
      const ref = await addDoc(collection(db, 'sessions'), session);
      created = { ...session, id: ref.id };
    } else {
      created = { ...session, id: makeId() };
      setSessions(old => [created, ...old]);
    }
    setActiveSession(created); setRanks({}); setSessionOpen(false); setTab('Sessions');
  };

  const resumeSession = session => {
    if (!ask()) return;
    setActiveSession(session); setRanks({}); setTab('Sessions');
  };

  const saveGame = async () => {
    if (!activeSession) return;
    const entries = activeSession.playerIds.map((id, index) => ({
      playerId: id,
      playerName: players.find(p => p.id === id)?.name || activeSession.playerNames?.[index] || 'Unknown',
      rank: Number(ranks[id])
    }));
    if (entries.some(x => !Number.isInteger(x.rank) || x.rank < 1 || x.rank > entries.length)) {
      setMsg(`Enter a rank from 1 to ${entries.length} for every player`); return;
    }
    if (new Set(entries.map(x => x.rank)).size !== entries.length) {
      setMsg('Each player must have a different rank'); return;
    }
    const game = {
      title: `${activeSession.title} · Game ${matches.filter(m => m.sessionId === activeSession.id).length + 1}`,
      date: activeSession.date, sessionId: activeSession.id, sessionTitle: activeSession.title,
      rankings: entries.sort((a, b) => a.rank - b.rank),
      createdAt: ready ? serverTimestamp() : new Date().toISOString()
    };
    if (ready) {
      await addDoc(collection(db, 'matches'), game);
      await updateDoc(doc(db, 'sessions', activeSession.id), { gameCount: (activeSession.gameCount || 0) + 1 });
      setActiveSession(old => old ? ({ ...old, gameCount: (old.gameCount || 0) + 1 }) : old);
    } else {
      setMatches(old => [{ ...game, id: makeId() }, ...old]);
      setSessions(old => old.map(s => s.id === activeSession.id ? { ...s, gameCount: (s.gameCount || 0) + 1 } : s));
      setActiveSession(old => old ? ({ ...old, gameCount: (old.gameCount || 0) + 1 }) : old);
    }
    setRanks({}); setMsg('Game saved. Enter the next game ranks.');
  };

  const endSession = async session => {
    if (!ask() || !confirm('End this session? You can still view its complete summary later.')) return;
    if (ready) await updateDoc(doc(db, 'sessions', session.id), { status: 'completed', endedAt: serverTimestamp() });
    else setSessions(old => old.map(s => s.id === session.id ? { ...s, status: 'completed' } : s));
    setActiveSession(null);
    setSelectedSession(session);
    setMsg('Session completed. Its summary is ready.');
  };

  const sessionGames = session => matches.filter(m => m.sessionId === session.id);
  const stats = useMemo(() => buildStats(matches, players), [players, matches]);
  const board = useMemo(() => players.map(p => {
    const s = stats[p.id] || { played: 0, wins: 0, losses: 0, firstRate: 0, lastRate: 0, averageScore: 0, positions: {} };
    return { ...p, ...s };
  }).sort((a, b) => b.wins - a.wins || b.averageScore - a.averageScore), [players, stats]);
  const dailyMatches = matches.filter(m => m.date === dailyDate);
  const dailySessions = sessions.filter(s => s.date === dailyDate);
  const dailyStats = buildStats(dailyMatches, players);
  const activeSessions = sessions.filter(s => s.status !== 'completed');
  const completedSessions = sessions.filter(s => s.status === 'completed');

  return <div className="layout">
    <aside>
      <h2>🎮 Game<span>Zone</span></h2><small>GAME TRACKER</small>
      {['Dashboard', 'Players', 'Sessions', 'Matches', 'Leaderboard', 'Statistics'].map(t =>
        <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
      )}
      <div className="bottom"><p>{cloud ? '● Cloud sync connected' : '● Local preview mode'}</p>
        <button onClick={() => admin ? exitAdmin() : setLoginOpen(true)}>{admin ? 'Exit Admin' : 'Admin Access'}</button>
      </div>
    </aside>

    <main>
      <header><div><small>GAMING HUB</small><h1>{tab}</h1></div><b>{cloud ? 'LIVE SYNC' : 'PREVIEW'}</b></header>
      {msg && <p className="notice" onClick={() => setMsg('')}>{msg}　×</p>}

      {tab === 'Dashboard' && <>
        <section className="hero"><div><small>YOUR GAME • YOUR STATS</small><h2>Every match tells<br/>a <em>story.</em></h2>
          <p>Keep score, track your wins, and follow the leaderboard.</p>
          <button className="primary" onClick={startSessionForm}>＋ Start a session</button>
        </div><div className="trophy">🏆</div></section>
        <div className="stats">
          {[['Total players', players.length], ['Games played', matches.length], ["Today's games", matches.filter(m => m.date === today()).length], ['Active sessions', activeSessions.length]].map(x =>
            <article key={x[0]}><small>{x[0]}</small><strong>{x[1]}</strong></article>
          )}
        </div>
        <div className="columns">
          <section className="panel"><h3>Recent games <a onClick={() => setTab('Matches')}>View all →</a></h3>
            {matches.slice(0, 5).map(m => <MatchRow key={m.id} m={m} onOpen={setSelectedMatch}/>)}
            {!matches.length && <p className="muted">No games recorded yet.</p>}
          </section>
          <section className="panel"><h3>Top players</h3>
            {board.slice(0, 5).map((p, i) => <button className="line line-button" key={p.id} onClick={() => setSelectedPlayer(p)}>#{i+1}　<b>{p.name}</b><span>{p.wins} wins · {p.averageScore}/100</span></button>)}
            {!players.length && <p className="muted">Add players to begin.</p>}
          </section>
        </div>
      </>}

      {tab === 'Players' && <section className="panel"><h2>Players <small>{players.length} total</small></h2>
        {admin && <form onSubmit={addPlayer}><input value={name} onChange={e => setName(e.target.value)} placeholder="Player name"/><button className="primary">＋ Add player</button></form>}
        {players.map(p => <div className="line" key={p.id}>
          <button className="text-button" onClick={() => setSelectedPlayer(p)}>{p.name}</button>
          <span>{stats[p.id]?.played || 0} games · {stats[p.id]?.wins || 0} firsts · {stats[p.id]?.losses || 0} last places</span>
          {admin && <button onClick={() => delPlayer(p.id)}>Delete</button>}
        </div>)}
        {!players.length && <p className="muted">Add players to begin.</p>}
      </section>}

      {tab === 'Sessions' && <div className="session-page">
        <section className="panel"><div className="section-heading"><h2>Active sessions</h2>{admin && <button className="primary" onClick={startSessionForm}>＋ New session</button>}</div>
          {!activeSessions.length && <p className="muted">No active sessions. Start a new session to record games.</p>}
          {activeSessions.map(s => <div className="session-row" key={s.id}><div><b>{s.title}</b><small>{s.date} · {(s.playerNames || []).join(', ')} · {sessionGames(s).length} games</small></div>
            <div className="row-actions">{admin && <button className="primary" onClick={() => resumeSession(s)}>Continue</button>}<button onClick={() => setSelectedSession(s)}>View summary</button>{admin && <button onClick={() => endSession(s)}>End session</button>}{admin && <button className="danger" onClick={() => delSession(s)}>Delete session</button>}</div>
          </div>)}
        </section>
        {activeSession && <section className="panel active-game-panel">
          <div className="section-heading"><div><small>ACTIVE SESSION</small><h2>{activeSession.title}</h2><p className="muted">{activeSession.date} · {activeSession.playerNames?.join(', ')}</p></div>
            <div className="row-actions"><button onClick={() => endSession(activeSession)}>End session</button>{admin && <button className="danger" onClick={() => delSession(activeSession)}>Delete session</button>}</div>
          </div>
          <div className="quick-entry-title"><h3>Game {sessionGames(activeSession).length + 1}</h3><span>Type each player's rank</span></div>
          <div className="rank-entry">
            {activeSession.playerIds.map((id, index) => <label className="rank-row" key={id}>
              <span><i>{index + 1}</i>{players.find(p => p.id === id)?.name || activeSession.playerNames?.[index] || 'Player'}</span>
              <input aria-label={`Rank for ${players.find(p => p.id === id)?.name || 'player'}`} type="number" min="1" max={activeSession.playerIds.length} inputMode="numeric" placeholder="Rank" value={ranks[id] || ''} onChange={e => setRanks(old => ({ ...old, [id]: e.target.value }))}/>
            </label>)}
          </div>
          <p className="muted rank-hint">Use each rank once, from 1 to {activeSession.playerIds.length}. 1st is Winner; last position is Loser.</p>
          <button className="primary save-game" onClick={saveGame}>Save game &amp; next →</button>
          <div className="session-game-history"><h3>Games saved in this session</h3>
            {sessionGames(activeSession).map((m, i) => <MatchRow key={m.id} m={m} index={i+1} onOpen={setSelectedMatch}/>)}
            {!sessionGames(activeSession).length && <p className="muted">Your saved games will appear here.</p>}
          </div>
        </section>}
        <section className="panel"><h2>Completed sessions</h2>
          {!completedSessions.length && <p className="muted">Completed sessions will appear here.</p>}
          {completedSessions.map(s => <div className="session-row" key={s.id}><div><b>{s.title}</b><small>{s.date} · {(s.playerNames || []).join(', ')} · {sessionGames(s).length} games</small></div>
            <div className="row-actions"><button onClick={() => setSelectedSession(s)}>View session summary →</button>{admin && <button className="danger" onClick={() => delSession(s)}>Delete session</button>}</div></div>)}
        </section>
      </div>}

      {tab === 'Matches' && <section className="panel"><h2>Game history</h2>
        {matches.map(m => <div className="match-wrap" key={m.id}><MatchRow m={m} onOpen={setSelectedMatch}/>{admin && <button onClick={() => delMatch(m.id)}>Delete</button>}</div>)}
        {!matches.length && <p className="muted">No games recorded.</p>}
      </section>}

      {tab === 'Leaderboard' && <section className="panel"><h2>Leaderboard</h2>
        <p className="muted">Ranked by total 1st-place finishes, then average performance score.</p>
        <div className="table-wrap"><table className="position-table"><thead><tr><th>Rank</th><th>Player</th><th>Games</th><th>1st Places</th><th>Last Places</th><th>Avg. Score</th><th>Profile</th></tr></thead>
          <tbody>{board.map((p, i) => <tr key={p.id}><td>#{i+1}</td><td>{p.name}</td><td>{p.played}</td><td>{p.wins}</td><td>{p.losses}</td><td>{p.averageScore}/100</td><td><button onClick={() => setSelectedPlayer(p)}>Open</button></td></tr>)}</tbody>
        </table></div>
      </section>}

      {tab === 'Statistics' && <div className="statistics-page">
        <section className="panel"><div className="section-heading"><h2>Daily statistics</h2><input type="date" value={dailyDate} onChange={e => setDailyDate(e.target.value)}/></div>
          <p className="muted">{dailySessions.length} sessions · {dailyMatches.length} games on {dailyDate}</p>
          <h3>Session-wise results</h3>
          {!dailySessions.length && <p className="muted">No sessions on this date.</p>}
          {dailySessions.map(s => {
            const games = sessionGames(s);
            const participants = (s.playerIds || []).map((id, i) => players.find(p => p.id === id) || { id, name: s.playerNames?.[i] || 'Unknown' });
            const ss = buildStats(games, participants);
            return <div className="daily-session-card" key={s.id}>
              <div className="section-heading"><div><b>{s.title}</b><small>{games.length} games · {participants.length} players · {s.status === 'completed' ? 'Completed' : 'Active'}</small></div>
                <button onClick={() => setSelectedSession(s)}>View summary</button></div>
              {participants.map(p => {
                const x = ss[p.id] || { played: 0, wins: 0, losses: 0, averageScore: 0, positions: {} };
                return <p className="line" key={p.id}><b>{p.name}</b><span>{x.played} games · 1st {x.positions['1st Place'] || 0} · 2nd {x.positions['2nd Place'] || 0} · 3rd {x.positions['3rd Place'] || 0} · Last {x.losses}</span></p>;
              })}
            </div>;
          })}
          <h3>Daily overall – all sessions combined</h3>
          <p className="muted">Each player's percentage uses only the games that player actually played on this date.</p>
          <PositionTable list={dailyMatches} players={players} compact/>
          {players.filter(p => (dailyStats[p.id]?.played || 0) > 0).map(p => {
            const s = dailyStats[p.id];
            return <div className="line stat-line" key={p.id}><b>{p.name}</b><span>{s.played} games · 1st {s.wins} ({s.firstRate}%) · Last {s.losses} ({s.lastRate}%) · Avg. {s.averageScore}/100</span></div>;
          })}
        </section>
        <section className="panel"><h2>Overall statistics</h2>
          <p className="muted">Lifetime position counts and percentages. Each player's percentage is based on their own games played.</p>
          {board.map(p => <button className="line line-button" key={p.id} onClick={() => setSelectedPlayer(p)}>
            <b>{p.name}</b><span>{p.played} games · 1st {p.firstRate}% · Last {p.lastRate}% · Avg. {p.averageScore}/100</span>
          </button>)}
          {!players.length && <p className="muted">Add players to see statistics.</p>}
        </section>
      </div>}

      <footer>GAMEZONE · YOUR GAME, YOUR STATS</footer>
    </main>

    {selectedMatch && <div className="shade" onClick={() => setSelectedMatch(null)}><div className="modal wide detail-modal" onClick={e => e.stopPropagation()}>
      <button className="close" onClick={() => setSelectedMatch(null)}>×</button>
      <small>MATCH RESULT</small><h2>{selectedMatch.title || 'Game result'}</h2>
      <p className="muted">{selectedMatch.date} · {selectedMatch.sessionTitle || 'Session'}</p>
      <div className="detail-ranking">{(selectedMatch.rankings || []).slice().sort((a,b) => a.rank-b.rank).map(r => {
        const total = (selectedMatch.rankings || []).length;
        return <div className="detail-rank-row" key={r.playerId}><b>{r.playerName}</b><span>{positionLabel(r.rank, total)}</span><strong>{round(scoreFor(r.rank, total))} pts</strong></div>;
      })}</div>
      {admin && <button className="danger" onClick={() => delMatch(selectedMatch.id)}>Delete this match</button>}
    </div></div>}

    {selectedSession && <div className="shade" onClick={() => setSelectedSession(null)}><div className="modal wide detail-modal" onClick={e => e.stopPropagation()}>
      <button className="close" onClick={() => setSelectedSession(null)}>×</button>
      <small>SESSION SUMMARY</small><h2>{selectedSession.title}</h2>
      <p className="muted">{selectedSession.date} · {sessionGames(selectedSession).length} games · {(selectedSession.playerIds || []).length} players · {selectedSession.status === 'completed' ? 'Completed' : 'In progress'}</p>
      <PositionTable list={sessionGames(selectedSession)} players={(selectedSession.playerIds || []).map((id, i) => players.find(p => p.id === id) || { id, name: selectedSession.playerNames?.[i] || 'Unknown' })}/>
      {(selectedSession.playerIds || []).map((id, i) => {
        const p = players.find(x => x.id === id) || { id, name: selectedSession.playerNames?.[i] || 'Unknown' };
        const s = buildStats(sessionGames(selectedSession), [p])[id];
        if (!s || !s.played) return null;
        return <div className="line stat-line" key={id}><b>{p.name}</b><span>{s.played} games · 1st {s.firstRate}% · Last {s.lastRate}% · Average score {s.averageScore}/100</span></div>;
      })}
    </div></div>}

    {selectedPlayer && <div className="shade" onClick={() => setSelectedPlayer(null)}><div className="modal wide detail-modal" onClick={e => e.stopPropagation()}>
      <button className="close" onClick={() => setSelectedPlayer(null)}>×</button>
      <small>PLAYER PERFORMANCE PROFILE</small><h2>👤 {selectedPlayer.name}</h2>
      {(() => {
        const games = matches.filter(m => (m.rankings || []).some(r => r.playerId === selectedPlayer.id));
        const s = buildStats(games, [selectedPlayer])[selectedPlayer.id] || { played: 0, wins: 0, losses: 0, positions: {}, firstRate: 0, lastRate: 0, averageScore: 0 };
        const most = Object.entries(s.positions).sort((a,b) => b[1]-a[1])[0];
        return <>
          <div className="profile-metrics">
            <article><small>Total Games</small><strong>{s.played}</strong></article>
            <article><small>Most Frequent Position</small><strong>{most?.[0] || '—'}</strong></article>
            <article><small>1st Place Rate</small><strong>{s.firstRate}%</strong></article>
            <article><small>Last Place Rate</small><strong>{s.lastRate}%</strong></article>
            <article><small>Average Performance</small><strong>{s.averageScore}/100</strong></article>
          </div>
          <h3>Position breakdown</h3>
          <div className="table-wrap"><table className="position-table"><thead><tr><th>Position</th><th>Count</th><th>Percentage</th></tr></thead>
            <tbody>{positionRows(games, selectedPlayer.id).map(row => <tr key={row.position}><td>{row.position}</td><td>{row.count}</td><td>{s.played ? round(row.count / s.played * 100) : 0}%</td></tr>)}</tbody>
          </table></div>
          <h3>Match history</h3>
          {games.map(m => <MatchRow key={m.id} m={m} onOpen={match => { setSelectedPlayer(null); setSelectedMatch(match); }}/>)}
          {!games.length && <p className="muted">No games played yet.</p>}
        </>;
      })()}
    </div></div>}

    {loginOpen && <div className="shade"><div className="modal"><button className="close" onClick={() => setLoginOpen(false)}>×</button>
      <h2>Admin login</h2><p>Sign in with the GameZone administrator account.</p>
      <label>Email</label><input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="Admin email"/>
      <label>Password</label><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Admin password" onKeyDown={e => e.key === 'Enter' && unlock()}/>
      <button className="primary" onClick={unlock} disabled={authBusy || !email.trim() || !password}>{authBusy ? 'Signing in…' : 'Sign in'}</button>
    </div></div>}

    {sessionOpen && <div className="shade"><div className="modal wide"><button className="close" onClick={() => setSessionOpen(false)}>×</button>
      <h2>Create session</h2><label>Session name</label><input value={sessionTitle} onChange={e => setSessionTitle(e.target.value)} placeholder="Game Session"/>
      <label>Date</label><input type="date" value={sessionDate} onChange={e => setSessionDate(e.target.value)}/>
      <label>Select players for this session</label>
      <div className="chips">{players.map(p => <button type="button" key={p.id} className={chosen.includes(p.id) ? 'chosen' : ''} onClick={() => setChosen(old => old.includes(p.id) ? old.filter(x => x !== p.id) : [...old, p.id])}>{p.name}</button>)}</div>
      <p className="muted">{chosen.length} players selected. These players stay selected for every game in this session.</p>
      <button className="primary" onClick={createSession}>Start session →</button>
    </div></div>}
  </div>;
}
