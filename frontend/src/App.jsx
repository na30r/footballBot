import { useEffect, useMemo, useState } from "react";
import "./App.css";

const LEAGUES = [
  { id: "all", label: "All" },
  { id: "premier-league", label: "Premier League" },
  { id: "serie-a", label: "Serie A" },
  { id: "bundesliga", label: "Bundesliga" },
  { id: "la-liga", label: "La Liga" },
];

const FILTERS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "upcoming", label: "Upcoming" },
  { id: "finished", label: "Finished" },
];

function bucket(status) {
  const value = (status || "").toLowerCase().replace(/[\s_-]/g, "");
  if (["finished", "ft", "aet", "pen", "ended", "closed"].includes(value)) return "finished";
  if (["upcoming", "scheduled", "notstarted", "ns", "postponed", "cancelled", "canceled", "delayed"].includes(value)) {
    return "upcoming";
  }
  if (["live", "inplay", "inprogress", "playing", "halftime", "ht", "paused", "1h", "2h"].includes(value)) {
    return "live";
  }
  return "finished";
}

function formatKickoff(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function Crest({ src }) {
  const [hidden, setHidden] = useState(false);
  if (!src || hidden) return <span className="crest fallback" aria-hidden="true" />;
  return <img className="crest" src={src} alt="" onError={() => setHidden(true)} />;
}

function formatDay(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(year, month - 1, day));
}

function outcomeLabel(outcome) {
  if (outcome === "win") return "Win";
  if (outcome === "draw") return "Draw";
  if (outcome === "lose") return "Loss";
  return outcome;
}

function ConditionBoard({ report, error }) {
  const days = report?.days ?? [];

  return (
    <section className="condition">
      <div className="condition-head">
        <h2>30' to half-time</h2>
        <p>0 goals win, 1 goal draw, more than 1 goal lose. Counted when the match finishes.</p>
      </div>
      {error && <p className="detail-note">{error}</p>}
      {!error && days.length === 0 && <p className="detail-note">No finished matches recorded yet.</p>}
      {days.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Wins</th>
              <th>Losses</th>
              <th>Draws</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <td>{formatDay(day.date)}</td>
                <td className="win">{day.wins}</td>
                <td className="lose">{day.losses}</td>
                <td className="draw">{day.draws}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MatchCard({ match, condition }) {
  const group = bucket(match.status);
  const [open, setOpen] = useState(group === "live");
  const hasScore = match.homeScore != null && match.awayScore != null;

  return (
    <li className={group === "live" ? "card live-card" : "card"}>
      <div className="meta">
        <span className={`badge ${group}`}>{match.statusText}</span>
        <span className="competition">
          <Crest src={match.competitionLogo} />
          {match.competition}
        </span>
        <time dateTime={match.kickoff || undefined}>{formatKickoff(match.kickoff)}</time>
      </div>
      <div className="teams">
        <div className="team">
          <Crest src={match.homeLogo} />
          <span className="name">{match.home}</span>
        </div>
        <div className="score">{hasScore ? `${match.homeScore} – ${match.awayScore}` : "vs"}</div>
        <div className="team away">
          <Crest src={match.awayLogo} />
          <span className="name">{match.away}</span>
        </div>
      </div>
      {condition && (
        <p className="condition-result">
          <span className={`condition-pill ${condition.outcome}`}>
            {condition.goals === 1 ? "1 goal" : `${condition.goals} goals`} · {outcomeLabel(condition.outcome)}
          </span>
        </p>
      )}
      {match.slug && (
        <button className="details-toggle" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide detail" : "Match detail"}
        </button>
      )}
      {open && match.slug && <MatchDetails slug={match.slug} />}
    </li>
  );
}

function MatchDetails({ slug }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function load() {
      try {
        const response = await fetch(`/api/match/${slug}`);
        if (!response.ok) throw new Error("Details are unavailable");
        const data = await response.json();
        if (!cancelled) {
          setDetail(data);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Details are unavailable");
      }

      if (!cancelled) timer = window.setTimeout(load, 20_000);
    }

    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [slug]);

  if (error && !detail) return <p className="detail-note">{error}</p>;
  if (!detail) return <p className="detail-note">Loading match detail…</p>;

  return (
    <div className="detail">
      {detail.minute && <p className="minute">{detail.minute}'</p>}
      {detail.halfTime && <p className="detail-note">Half-time {detail.halfTime}</p>}

      {detail.stats.length > 0 && (
        <ul className="stats">
          {detail.stats.map((stat) => (
            <li key={stat.label} className="stat">
              <span>{stat.home}{stat.suffix}</span>
              <span className="track home" aria-hidden="true">
                <span style={{ width: `${stat.homePct ?? 0}%` }} />
              </span>
              <span className="stat-label">{stat.label}</span>
              <span className="track away" aria-hidden="true">
                <span style={{ width: `${stat.awayPct ?? 0}%` }} />
              </span>
              <span>{stat.away}{stat.suffix}</span>
            </li>
          ))}
        </ul>
      )}

      {detail.events.length > 0 && (
        <ul className="events">
          {detail.events.map((event, index) => (
            <li key={`${event.minute}-${event.type}-${index}`}>
              <span className={`side ${event.side}`} />
              <strong>{event.minute ? `${event.minute}'` : ""}</strong>
              <span>{event.type}</span>
              <span>{event.text}</span>
              {event.score && <em>{event.score}</em>}
            </li>
          ))}
        </ul>
      )}

      {detail.lineup && (
        <div className="lineups">
          <PlayerList
            title="Home"
            formation={detail.lineup.homeFormation}
            players={detail.lineup.homeXi}
            bench={detail.lineup.homeBench}
          />
          <PlayerList
            title="Away"
            formation={detail.lineup.awayFormation}
            players={detail.lineup.awayXi}
            bench={detail.lineup.awayBench}
          />
        </div>
      )}
    </div>
  );
}

function PlayerList({ title, formation, players, bench }) {
  return (
    <div>
      <p className="xi-title">
        {title}
        {formation ? ` · ${formation}` : ""}
      </p>
      <ul className="xi">
        {players.map((player) => (
          <li key={`${player.number}-${player.name}`}>
            <span>{player.number ?? "–"}</span>
            {player.name}
            {player.captain ? " (c)" : ""}
          </li>
        ))}
      </ul>
      {bench.length > 0 && (
        <p className="bench">Bench: {bench.map((player) => player.name).join(", ")}</p>
      )}
    </div>
  );
}

function Board() {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [league, setLeague] = useState("all");
  const [filter, setFilter] = useState("all");
  const [telegramNote, setTelegramNote] = useState("");
  const [sending, setSending] = useState(false);
  const [conditions, setConditions] = useState(null);
  const [conditionError, setConditionError] = useState("");

  async function sendToTelegram() {
    setSending(true);
    setTelegramNote("");
    try {
      const response = await fetch("/api/telegram", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not send the Telegram message");
      setTelegramNote(
        body.count > 0
          ? body.count === 1
            ? "Sent 1 message for the match at minute 25."
            : `Sent ${body.count} messages, one per match at minute 25.`
          : "No match is at minute 25.",
      );
    } catch (err) {
      setTelegramNote(err.message || "Could not send the Telegram message");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function loadConditions() {
      try {
        const response = await fetch("/api/conditions");
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Results are unavailable");
        if (!cancelled) {
          setConditions(body);
          setConditionError(body.ready ? "" : "PostgreSQL is not configured.");
        }
      } catch (err) {
        if (!cancelled) setConditionError(err.message || "Results are unavailable");
      }

      if (!cancelled) timer = window.setTimeout(loadConditions, 60_000);
    }

    loadConditions();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function load() {
      let ok = false;
      try {
        const response = await fetch("/api/matches");
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `The match feed returned ${response.status}`);
        }
        const data = await response.json();
        if (!cancelled) {
          setFeed(data);
          setError("");
          ok = true;
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not load matches");
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (!cancelled) timer = window.setTimeout(load, ok ? 60_000 : 3_000);
    }

    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const conditionBySlug = useMemo(() => {
    const map = new Map();
    for (const item of conditions?.matches ?? []) map.set(item.slug, item);
    return map;
  }, [conditions]);

  const matches = feed?.matches ?? [];
  const inLeague = league === "all" ? matches : matches.filter((match) => match.leagueId === league);

  const leagueCounts = useMemo(() => {
    const tally = { all: matches.length };
    for (const item of LEAGUES) {
      if (item.id !== "all") tally[item.id] = 0;
    }
    for (const match of matches) {
      if (match.leagueId in tally) tally[match.leagueId] += 1;
    }
    return tally;
  }, [matches]);

  const counts = useMemo(() => {
    const tally = { all: inLeague.length, live: 0, upcoming: 0, finished: 0 };
    for (const match of inLeague) {
      const group = bucket(match.status);
      if (group in tally) tally[group] += 1;
    }
    return tally;
  }, [inLeague]);

  const visible = useMemo(() => {
    const list = filter === "all" ? inLeague : inLeague.filter((match) => bucket(match.status) === filter);
    const order = { live: 0, upcoming: 1, finished: 2 };
    return [...list].sort((a, b) => {
      const statusCompare = (order[bucket(a.status)] ?? 9) - (order[bucket(b.status)] ?? 9);
      if (statusCompare !== 0) return statusCompare;
      return new Date(a.kickoff || 0) - new Date(b.kickoff || 0);
    });
  }, [inLeague, filter]);

  return (
    <>
      <header className="top">
        <div>
          <p className="eyebrow">Football</p>
          <h1>Match board</h1>
          <p className="lede">Premier League, Serie A, Bundesliga, and La Liga.</p>
        </div>
        <div className="actions">
          <p className="updated">
            {feed?.updated
              ? `Updated ${new Date(feed.updated).toLocaleTimeString()}`
              : loading
                ? "Loading scores…"
                : "Waiting for scores"}
          </p>
          <button className="send" type="button" onClick={sendToTelegram} disabled={sending}>
            {sending ? "Sending…" : "Send to Telegram"}
          </button>
          {telegramNote && <p className="telegram-note">{telegramNote}</p>}
        </div>
      </header>

      <ConditionBoard report={conditions} error={conditionError} />

      <div className="filters">
        {LEAGUES.map((item) => (
          <button
            key={item.id}
            className={league === item.id ? "chip active" : "chip"}
            onClick={() => setLeague(item.id)}
            type="button"
          >
            {item.label}
            <span>{leagueCounts[item.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={filter === item.id ? "chip active" : "chip"}
            onClick={() => setFilter(item.id)}
            type="button"
          >
            {item.label}
            <span>{counts[item.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && <p className="banner">{error}. The .NET API should be running on port 5095.</p>}

      {!error && !loading && visible.length === 0 && (
        <p className="empty">No matches in this view right now.</p>
      )}

      <ul className="list">
        {visible.map((match) => (
          <MatchCard
            key={match.slug || `${match.competition}-${match.home}-${match.away}-${match.kickoff}`}
            match={match}
            condition={match.slug ? conditionBySlug.get(match.slug) : null}
          />
        ))}
      </ul>
    </>
  );
}

function SiteNav({ path, go }) {
  const links = [
    ["/", "Board"],
    ["/range", "Range"],
    ["/games", "25' games"],
  ];

  return (
    <nav className="nav">
      {links.map(([href, label]) => (
        <a key={href} href={href} className={path === href ? "active" : ""} onClick={(event) => go(event, href)}>
          {label}
        </a>
      ))}
    </nav>
  );
}

function useRoute() {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function go(event, href) {
    event.preventDefault();
    const next = normalizePath(href);
    window.history.pushState({}, "", next);
    setPath(next);
  }

  return [path, go];
}

function normalizePath(path) {
  if (!path) return "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function useDays() {
  const [days, setDays] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function load() {
      try {
        const response = await fetch("/api/days");
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "Days are unavailable");
        if (!cancelled) {
          setDays(Array.isArray(body) ? body : []);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Days are unavailable");
      }

      if (!cancelled) timer = window.setTimeout(load, 30_000);
    }

    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return { days, error };
}

function goalText(goals) {
  return goals === 1 ? "1 goal" : `${goals} goals`;
}

function minuteText(minute) {
  const name = minute.player ? ` ${minute.player}` : "";
  return `${minute.label}'${name}`;
}

function minuteLine(match) {
  const listed = match.minutes ?? [];
  const hidden = Math.max(0, match.goals - listed.length);
  const parts = listed.map(minuteText);
  if (hidden === 1) parts.push("1 goal without a minute");
  else if (hidden > 1) parts.push(`${hidden} goals without a minute`);
  return parts.length ? parts.join(" · ") : "No goals in this range";
}

function RangeTotals({ report }) {
  return (
    <div className="tally">
      <div>
        <strong className="win">{report?.wins ?? 0}</strong>
        <span>Wins</span>
      </div>
      <div>
        <strong className="lose">{report?.losses ?? 0}</strong>
        <span>Losses</span>
      </div>
      <div>
        <strong className="draw">{report?.draws ?? 0}</strong>
        <span>Draws</span>
      </div>
    </div>
  );
}

function GameRows({ matches }) {
  if (!matches?.length) return <p className="empty">No finished matches for this choice.</p>;

  return (
    <ul className="list">
      {matches.map((match) => (
        <li key={match.slug} className="card">
          <div className="meta">
            <span className="competition">{match.league}</span>
            <span className={`condition-pill ${match.outcome}`}>
              {goalText(match.goals)} · {outcomeLabel(match.outcome)}
            </span>
          </div>
          <div className="teams">
            <div className="team">
              <span className="name">{match.home}</span>
            </div>
            <div className="score">
              {match.homeScore != null && match.awayScore != null ? `${match.homeScore} – ${match.awayScore}` : "vs"}
            </div>
            <div className="team away">
              <span className="name">{match.away}</span>
            </div>
          </div>
          <p className="goal-minutes">{minuteLine(match)}</p>
        </li>
      ))}
    </ul>
  );
}

function RangePage() {
  const { days, error: dayError } = useDays();
  const [league, setLeague] = useState("all");
  const [date, setDate] = useState("");
  const [fromMinute, setFromMinute] = useState(29);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!date && days.length > 0) setDate(days[0]);
  }, [date, days]);

  useEffect(() => {
    if (!date) return undefined;
    let cancelled = false;

    async function load() {
      try {
        const params = new URLSearchParams({ league, date, from: String(fromMinute) });
        const response = await fetch(`/api/range?${params}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not calculate this range");
        if (!cancelled) {
          setReport(body);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not calculate this range");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [league, date, fromMinute]);

  return (
    <>
      <header className="top">
        <div>
          <p className="eyebrow">Range</p>
          <h1>Win, loss, draw</h1>
          <p className="lede">Count goals from the minute you pick until the end of the first half.</p>
        </div>
      </header>
      <div className="pickers">
        <label>
          League
          <select value={league} onChange={(event) => setLeague(event.target.value)}>
            {LEAGUES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Day
          <select value={date} onChange={(event) => setDate(event.target.value)}>
            {days.map((day) => (
              <option key={day} value={day}>
                {formatDay(day)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From minute
          <input
            type="number"
            min="0"
            max="45"
            value={fromMinute}
            onChange={(event) => setFromMinute(Math.min(45, Math.max(0, Number(event.target.value) || 0)))}
          />
        </label>
      </div>
      <p className="lede">
        {fromMinute}' until half-time. 0 goals win, 1 goal draw, more than 1 goal lose.
      </p>
      {(error || dayError) && <p className="banner">{error || dayError}</p>}
      <RangeTotals report={report} />
      <GameRows matches={report?.matches} />
    </>
  );
}

function GamesPage() {
  const { days, error: dayError } = useDays();
  const [date, setDate] = useState("");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!date && days.length > 0) setDate(days[0]);
  }, [date, days]);

  useEffect(() => {
    if (!date) return undefined;
    let cancelled = false;

    async function load() {
      try {
        const params = new URLSearchParams({ date, from: "25" });
        const response = await fetch(`/api/range?${params}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load the games");
        if (!cancelled) {
          setReport(body);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not load the games");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [date]);

  return (
    <>
      <header className="top">
        <div>
          <p className="eyebrow">25' to half-time</p>
          <h1>Each game</h1>
          <p className="lede">Every finished match on the day, scored from the 25th minute to half-time.</p>
        </div>
      </header>
      <div className="pickers">
        <label>
          Day
          <select value={date} onChange={(event) => setDate(event.target.value)}>
            {days.map((day) => (
              <option key={day} value={day}>
                {formatDay(day)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(error || dayError) && <p className="banner">{error || dayError}</p>}
      <RangeTotals report={report} />
      <GameRows matches={report?.matches} />
    </>
  );
}

export default function App() {
  const [path, go] = useRoute();
  const page = path === "/range" ? <RangePage /> : path === "/games" ? <GamesPage /> : <Board />;

  return (
    <div className="page">
      <SiteNav path={path} go={go} />
      {page}
      <footer>
        Powered by <a href="https://sportscore.com/">SportScore</a>
      </footer>
    </div>
  );
}
