import { useEffect, useMemo, useState } from 'react';
import {
  collection, doc, onSnapshot, addDoc, deleteDoc, updateDoc,
  serverTimestamp, query, orderBy
} from 'firebase/firestore';
import { db, ready, connect, auth, ADMIN_EMAIL, loginAdmin, logoutAdmin } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

const LOCAL = 'gamezone-data';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const makeId = () => crypto.randomUUID();

const localRead = () => {
  try {
    const data = JSON.parse(localStorage.getItem(LOCAL)) || {};
    return { players: data.players || [], matches: data.matches || [], sessions: data.sessions || [] };
  } catch {
    return { players: [], matches: [], sessions: [] };
  }
};

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

  useEffect(() => {
    if (!ready || !auth) return;
    return onAuthStateChanged(auth, user => setAdmin(user?.email === ADMIN_EMAIL));
  }, []);

  useEffect(() => {
    if (!ready) {
      const data = localRead();
      setPlayers(data.players);
      setMatches(data.matches);
      setSessions(data.sessions);
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
    if (!ask() || !confirm('Delete this player?')) return;
    if (ready) await deleteDoc(doc(db, 'players', id));
    else setPlayers(old => old.filter(p => p.id !== id));
  };

  const delMatch = async id => {
    if (!ask() || !confirm('Delete this game result?')) return;
    if (ready) await deleteDoc(doc(db, 'matches', id));
    else setMatches(old => old.filter(m => m.id !== id));
  };

  const startSessionForm = () => {
    if (!ask()) return;
    setChosen([]);
    setSessionTitle('Game Session');
    setSessionDate(today());
    setSessionOpen(true);
  };

  const createSession = async () => {
    if (chosen.length < 2) return setMsg('Select at least two players');
    const session = {
      title: sessionTitle.trim() || 'Game Session',
      date: sessionDate,
      playerIds: chosen,
      playerNames: chosen.map(id => players.find(p => p.id === id)?.name || 'Unknown'),
      status: 'active',
      gameCount: 0,
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
    setActiveSession(created);
    setRanks({});
    setSessionOpen(false);
    setTab('Sessions');
  };

  const resumeSession = session => {
    if (!ask()) return;
    setActiveSession(session);
    setRanks({});
    setTab('Sessions');
  };

  const saveGame = async () => {
    if (!activeSession) return;
    const entries = activeSession.playerIds.map(id => ({
      playerId: id,
      playerName: players.find(p => p.id === id)?.name || activeSession.playerNames?.[activeSession.playerIds.indexOf(id)] || 'Unknown',
      rank: Number(ranks[id])
    }));
    if (entries.some(x => !Number.isInteger(x.rank) || x.rank < 1 || x.rank > entries.length)) {
      setMsg(`Enter a rank from 1 to ${entries.length} for every player`); return;
    }
    if (new Set(entries.map(x => x.rank)).size !== entries.length) {
      setMsg('Each player must have a different rank'); return;
    }
    const game = {
      title: `${activeSession.title} · Game ${(matches.filter(m => m.sessionId === activeSession.id).length) + 1}`,
      date: activeSession.date,
      sessionId: activeSession.id,
      sessionTitle: activeSession.title,
      rankings: entries.sort((a, b) => a.rank - b.rank),
      createdAt: ready ? serverTimestamp() : new Date().toISOString()
    };
    if (ready) {
      await addDoc(collection(db, 'matches'), game);
      await updateDoc(doc(db, 'sessions', activeSession.id), { gameCount: (activeSession.gameCount || 0) + 1 });
      setActiveSession(old => ({ ...old, gameCount: (old.gameCount || 0) + 1 }));
    } else {
      setMatches(old => [{ ...game, id: makeId() }, ...old]);
      setSessions(old => old.map(s => s.id === activeSession.id ? { ...s, gameCount: (s.gameCount || 0) + 1 } : s));
      setActiveSession(old => ({ ...old, gameCount: (old.gameCount || 0) + 1 }));
    }
    setRanks({});
    setMsg('Game saved. Enter the next game ranks.');
  };

  const endSession = async session => {
    if (!ask() || !confirm('End this session? You can still view its history later.')) return;
    if (ready) await updateDoc(doc(db, 'sessions', session.id), { status: 'completed', endedAt: serverTimestamp() });
    else setSessions(old => old.map(s => s.id === session.id ? { ...s, status: 'completed' } : s));
    setActiveSession(null);
    setMsg('Session completed');
  };

  const sessionGames = session => matches.filter(m => m.sessionId === session.id);
  const statsFor = (list) => {
    const out = {};
    players.forEach(p => out[p.id] = { played: 0, wins: 0, losses: 0 });
    list.forEach(m => (m.rankings || []).forEach(r => {
      if (!out[r.playerId]) out[r.playerId] = { played: 0, wins: 0, losses: 0 };
      out[r.playerId].played++;
      if (Number(r.rank) === 1) out[r.playerId].wins++;
      else out[r.playerId].losses++;
    }));
    return out;
  };
  const stats = useMemo(() => statsFor(matches), [players, matches]);
  const board = players.map(p => {
    const s = stats[p.id] || { played: 0, wins: 0, losses: 0 };
    return { ...p, ...s, rate: s.played ? Math.round(s.wins / s.played * 100) : 0,
      lossRate: s.played ? Math.round(s.losses / s.played * 100) : 0 };
  }).sort((a, b) => b.rate - a.rate || b.wins - a.wins);
  const dailyMatches = matches.filter(m => m.date === dailyDate);
  const dailyStats = statsFor(dailyMatches);
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
            {matches.slice(0, 5).map(m => <Match key={m.id} m={m}/>)}
            {!matches.length && <p className="muted">No games recorded yet.</p>}
          </section>
          <section className="panel"><h3>Top players</h3>
            {board.slice(0, 5).map((p, i) => <p className="line" key={p.id}>#{i+1}　<b>{p.name}</b><span>{p.wins} wins</span></p>)}
            {!players.length && <p className="muted">Add players to begin.</p>}
          </section>
        </div>
      </>}

      {tab === 'Players' && <section className="panel"><h2>Players <small>{players.length} total</small></h2>
        {admin && <form onSubmit={addPlayer}><input value={name} onChange={e => setName(e.target.value)} placeholder="Player name"/><button className="primary">＋ Add player</button></form>}
        {players.map(p => <div className="line" key={p.id}><b>{p.name}</b><span>{stats[p.id]?.played || 0} games · {stats[p.id]?.wins || 0} wins · {stats[p.id]?.losses || 0} losses</span>{admin && <button onClick={() => delPlayer(p.id)}>Delete</button>}</div>)}
        {!players.length && <p className="muted">Add players to begin.</p>}
      </section>}

      {tab === 'Sessions' && <div className="session-page">
        <section className="panel"><div className="section-heading"><h2>Active sessions</h2>{admin && <button className="primary" onClick={startSessionForm}>＋ New session</button>}</div>
          {!activeSessions.length && <p className="muted">No active sessions. Start a new session to record games.</p>}
          {activeSessions.map(s => <div className="session-row" key={s.id}><div><b>{s.title}</b><small>{s.date} · {(s.playerNames || []).join(', ')} · {s.gameCount || sessionGames(s).length} games</small></div>
            <div className="row-actions">{admin && <button className="primary" onClick={() => resumeSession(s)}>Continue</button>}{admin && <button onClick={() => endSession(s)}>End session</button>}</div>
          </div>)}
        </section>

        {activeSession && <section className="panel active-game-panel">
          <div className="section-heading"><div><small>ACTIVE SESSION</small><h2>{activeSession.title}</h2><p className="muted">{activeSession.date} · {activeSession.playerNames?.join(', ')}</p></div>
            <button onClick={() => endSession(activeSession)}>End session</button>
          </div>
          <div className="quick-entry-title"><h3>Game {(matches.filter(m => m.sessionId === activeSession.id).length) + 1}</h3><span>Type each player's rank</span></div>
          <div className="rank-entry">
            {activeSession.playerIds.map((id, index) => <label className="rank-row" key={id}>
              <span><i>{index + 1}</i>{players.find(p => p.id === id)?.name || activeSession.playerNames?.[index] || 'Player'}</span>
              <input aria-label={`Rank for ${players.find(p => p.id === id)?.name || 'player'}`} type="number" min="1" max={activeSession.playerIds.length} inputMode="numeric" placeholder="Rank" value={ranks[id] || ''} onChange={e => setRanks(old => ({ ...old, [id]: e.target.value }))}/>
            </label>)}
          </div>
          <p className="muted rank-hint">Use each rank once, from 1 to {activeSession.playerIds.length}. Rank 1 is the winner.</p>
          <button className="primary save-game" onClick={saveGame}>Save game &amp; next →</button>
          <div className="session-game-history"><h3>Games saved in this session</h3>
            {sessionGames(activeSession).map((m, i) => <Match key={m.id} m={m} index={i+1}/>)}
            {!sessionGames(activeSession).length && <p className="muted">Your saved games will appear here.</p>}
          </div>
        </section>}

        <section className="panel"><h2>Completed sessions</h2>
          {!completedSessions.length && <p className="muted">Completed sessions will appear here.</p>}
          {completedSessions.map(s => <div className="session-row" key={s.id}><div><b>{s.title}</b><small>{s.date} · {(s.playerNames || []).join(', ')} · {sessionGames(s).length || s.gameCount || 0} games</small></div><span className="completed-tag">COMPLETED</span></div>)}
        </section>
      </div>}

      {tab === 'Matches' && <section className="panel"><h2>Game history</h2>
        {matches.map(m => <div className="match-wrap" key={m.id}><Match m={m}/>{admin && <button onClick={() => delMatch(m.id)}>Delete</button>}</div>)}
        {!matches.length && <p className="muted">No games recorded.</p>}
      </section>}

      {tab === 'Leaderboard' && <section className="panel"><h2>Leaderboard</h2>
        <div className="table"><b>RANK　 PLAYER　 GAMES　 WINS　 LOSSES　 WIN RATE</b>
          {board.map((p, i) => <p key={p.id}>#{i+1}　 {p.name}　 {p.played}　 {p.wins}　 {p.losses}　 {p.rate}%</p>)}
        </div>
      </section>}

      {tab === 'Statistics' && <div className="statistics-page">
        <section className="panel"><div className="section-heading"><h2>Daily statistics</h2><input type="date" value={dailyDate} onChange={e => setDailyDate(e.target.value)}/></div>
          <p className="muted">{dailyMatches.length} games · {sessions.filter(s => s.date === dailyDate).length} sessions on {dailyDate}</p>
          {players.map(p => {
            const s = dailyStats[p.id] || { played: 0, wins: 0, losses: 0 };
            const winRate = s.played ? Math.round(s.wins / s.played * 100) : 0;
            const lossRate = s.played ? Math.round(s.losses / s.played * 100) : 0;
            return <div className="line stat-line" key={p.id}><b>{p.name}</b><span>{s.played} games · {s.wins} wins · {s.losses} losses · {winRate}% win · {lossRate}% loss</span></div>;
          })}
        </section>
        <section className="panel"><h2>Overall statistics</h2>
          {board.map(p => <div className="line stat-line" key={p.id}><b>{p.name}</b><span>{p.played} games · {p.wins} wins · {p.losses} losses · {p.rate}% win · {p.lossRate}% loss</span></div>)}
          {!players.length && <p className="muted">Add players to see statistics.</p>}
        </section>
      </div>}

      <footer>GAMEZONE · YOUR GAME, YOUR STATS</footer>
    </main>

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

function Match({ m, index }) {
  return <div className="match"><div><b>{index ? `Game ${index}` : m.title}</b><small>{m.date} · {(m.rankings || []).length} players{m.sessionTitle ? ` · ${m.sessionTitle}` : ''}</small></div>
    <span>Winner: {m.rankings?.find(r => Number(r.rank) === 1)?.playerName || '—'}</span></div>;
}
