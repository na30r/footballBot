import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const LEAGUES = [
  { id: "all", label: "All" },
  { id: "premier-league", label: "Premier League" },
  { id: "serie-a", label: "Serie A" },
  { id: "bundesliga", label: "Bundesliga" },
  { id: "la-liga", label: "La Liga" },
  { id: "iran-pro-league", label: "Iran Pro League" },
  { id: "champions-league", label: "Champions League" },
  { id: "europa-league", label: "Europa League" },
  { id: "afc-champions-league", label: "AFC Champions League Elite" },
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

function dayHeading(isoDate) {
  const label = formatDay(isoDate);
  if (!label || label === isoDate) return isoDate || "Time unknown";
  if (isoDate === playedOn(new Date().toISOString())) return `Today · ${label}`;
  return label;
}

function playedOn(kickoff) {
  if (!kickoff) return "";
  const date = new Date(kickoff);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function storedCard(match) {
  const league = LEAGUES.find((item) => item.label === match.league);
  return {
    slug: match.slug,
    leagueId: league?.id ?? "",
    home: match.home,
    away: match.away,
    homeLogo: null,
    awayLogo: null,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    status: "finished",
    statusText: "Finished",
    kickoff: null,
    competition: match.league,
    competitionLogo: null,
  };
}

function outcomeLabel(outcome) {
  if (outcome === "win") return "Win";
  if (outcome === "draw") return "Draw";
  if (outcome === "lose") return "Loss";
  return outcome;
}

function isGoalEvent(event) {
  const type = (event?.type || "").toLowerCase();
  if (!type.includes("goal")) return false;
  return !type.includes("disallow") && !type.includes("cancel") && !type.includes("miss");
}

function ResultColumns({ goals, outcome, detail }) {
  return (
    <div className="result-cols">
      <div>
        <strong>{goals}</strong>
        <span>Goals</span>
        {detail && <p className="goal-minutes">{detail}</p>}
      </div>
      <div>
        <strong className={outcome}>{outcomeLabel(outcome)}</strong>
        <span>Result</span>
      </div>
    </div>
  );
}

function EventColumn({ title, events, empty, goals = false }) {
  return (
    <section>
      <p className="col-title">{title}</p>
      {events.length === 0 ? (
        <p className="detail-note">{empty}</p>
      ) : (
        <ul className={goals ? "events goals" : "events"}>
          {events.map((event, index) => (
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
    </section>
  );
}

function ConditionBoard({ days, error, selectedDate, onSelectDate }) {

  return (
    <section className="condition">
      <div className="condition-head">
        <h2>30' to half-time</h2>
        <p>Click a day to see that day’s games. 0 goals win, 1 goal draw, more than 1 goal lose.</p>
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
              <tr
                key={day.date}
                className={selectedDate === day.date ? "day-selected" : ""}
                role="button"
                tabIndex={0}
                aria-pressed={selectedDate === day.date}
                onClick={() => onSelectDate(day.date)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectDate(day.date);
                  }
                }}
              >
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

function MatchCard({ match, condition, selected, onSelect }) {
  const group = bucket(match.status);
  const hasScore = match.homeScore != null && match.awayScore != null;

  return (
    <li className={`card${group === "live" ? " live-card" : ""}${selected ? " selected" : ""}`}>
      <button
        className="card-select"
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(match)}
      >
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
        {condition && <ResultColumns goals={condition.goals} outcome={condition.outcome} />}
      </button>
    </li>
  );
}

function MatchStatus({ match, condition, onClose }) {
  const { detail, error } = useMatchDetail(match.slug);
  const group = bucket(detail?.status || match.status);
  const homeScore = detail?.homeScore ?? match.homeScore;
  const awayScore = detail?.awayScore ?? match.awayScore;
  const hasScore = homeScore != null && homeScore !== "" && awayScore != null && awayScore !== "";
  const statusText = detail?.statusText || match.statusText;
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [match.slug]);

  return (
    <section className="status-panel" ref={panelRef} aria-live="polite">
      <div className="status-main">
        <div className="status-top">
          <span className={`badge ${group}`}>{statusText}</span>
          {detail?.minute && <strong className="minute">{detail.minute}'</strong>}
          <span className="competition">
            <Crest src={match.competitionLogo} />
            {match.competition}
          </span>
          <button className="status-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="teams status-score">
          <div className="team">
            <Crest src={match.homeLogo} />
            <span className="name">{match.home}</span>
          </div>
          <div className="score">{hasScore ? `${homeScore} – ${awayScore}` : "vs"}</div>
          <div className="team away">
            <Crest src={match.awayLogo} />
            <span className="name">{match.away}</span>
          </div>
        </div>
        <div className="status-notes">
          {detail?.halfTime && <p className="detail-note">Half-time {detail.halfTime}</p>}
          {!detail && <p className="detail-note">{error || "Loading status…"}</p>}
          {condition && <ResultColumns goals={condition.goals} outcome={condition.outcome} />}
        </div>
      </div>
      <div className="status-side">
        {detail?.stats?.length > 0 && (
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
        {detail && (
          <div className="event-cols">
            <EventColumn title="Goals" events={detail.events.filter(isGoalEvent)} empty="No goals" goals />
            <EventColumn title="Match" events={detail.events.filter((event) => !isGoalEvent(event))} empty="No other events" />
          </div>
        )}
        {detail && detail.stats.length === 0 && detail.events.length === 0 && (
          <p className="detail-note">No live stats for this match yet.</p>
        )}
      </div>
    </section>
  );
}

function useMatchDetail(slug) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    setDetail(null);
    setError("");

    async function load() {
      try {
        const response = await fetch(`/api/match/${slug}`);
        if (!response.ok) throw new Error("Status is unavailable");
        const data = await response.json();
        if (!cancelled) {
          setDetail(data);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Status is unavailable");
      }

      if (!cancelled) timer = window.setTimeout(load, 20_000);
    }

    if (slug) load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [slug]);

  return { detail, error };
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
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [day, setDay] = useState(null);
  const [dayGames, setDayGames] = useState(null);
  const [dayError, setDayError] = useState("");
  const [sort, setSort] = useState("league");
  const [layout, setLayout] = useState("cards");

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

  useEffect(() => {
    if (!day) {
      setDayGames(null);
      setDayError("");
      return undefined;
    }

    let cancelled = false;
    setDayGames(null);
    setDayError("");

    async function load() {
      try {
        const params = new URLSearchParams({ date: day, from: "30" });
        const response = await fetch(`/api/range?${params}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load this day");
        if (!cancelled) {
          setDayGames(body.matches ?? []);
          setDayError("");
        }
      } catch (err) {
        if (!cancelled) setDayError(err.message || "Could not load this day");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [day]);

  const conditionBySlug = useMemo(() => {
    const map = new Map();
    for (const item of conditions?.matches ?? []) map.set(item.slug, item);
    return map;
  }, [conditions]);

  const matches = feed?.matches ?? [];
  const listedDays = useMemo(() => {
    const stored = conditions?.days ?? [];
    const today = playedOn(new Date().toISOString());
    if (!today || stored.some((item) => item.date === today)) return stored;
    if (!matches.some((match) => playedOn(match.kickoff) === today)) return stored;
    return [{ date: today, wins: 0, losses: 0, draws: 0 }, ...stored];
  }, [conditions, matches]);
  const boardMatches = useMemo(() => {
    if (!day) return matches;
    const bySlug = new Map();
    for (const match of (dayGames ?? []).map(storedCard)) bySlug.set(match.slug, match);
    for (const match of matches) {
      if (playedOn(match.kickoff) === day) bySlug.set(match.slug, match);
    }
    return [...bySlug.values()];
  }, [day, dayGames, matches]);
  const scope = day ? boardMatches : matches;
  const inLeague = league === "all" ? scope : scope.filter((match) => match.leagueId === league);

  const leagueCounts = useMemo(() => {
    const tally = { all: scope.length };
    for (const item of LEAGUES) {
      if (item.id !== "all") tally[item.id] = 0;
    }
    for (const match of scope) {
      if (match.leagueId in tally) tally[match.leagueId] += 1;
    }
    return tally;
  }, [scope]);

  const counts = useMemo(() => {
    const tally = { all: inLeague.length, live: 0, upcoming: 0, finished: 0 };
    for (const match of inLeague) {
      const group = bucket(match.status);
      if (group in tally) tally[group] += 1;
    }
    return tally;
  }, [inLeague]);

  const statusFilter = sort === "upcoming" ? "upcoming" : filter;

  const visible = useMemo(() => {
    const list = statusFilter === "all" ? inLeague : inLeague.filter((match) => bucket(match.status) === statusFilter);
    return [...list].sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
  }, [inLeague, statusFilter]);

  const grouped = useMemo(() => {
    if (sort === "upcoming") {
      const buckets = new Map();
      for (const match of visible) {
        const id = playedOn(match.kickoff) || "unknown";
        if (!buckets.has(id)) buckets.set(id, []);
        buckets.get(id).push(match);
      }
      return [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, list]) => ({
          id,
          label: id === "unknown" ? "Time unknown" : dayHeading(id),
          matches: list,
        }));
    }
    if (sort === "time") return [{ id: "time", label: "", matches: visible }];
    const buckets = new Map();
    for (const match of visible) {
      const id = match.leagueId || "other";
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(match);
    }
    const sections = [];
    for (const item of LEAGUES) {
      if (item.id === "all") continue;
      const list = buckets.get(item.id);
      if (list?.length) sections.push({ id: item.id, label: item.label, matches: list });
      buckets.delete(item.id);
    }
    for (const [id, list] of buckets) {
      sections.push({ id, label: list[0]?.competition || "Other", matches: list });
    }
    return sections;
  }, [visible, sort]);

  const selected = scope.find((match) => match.slug === selectedSlug) ?? null;

  function selectDay(date) {
    setDay((current) => (current === date ? null : date));
    setFilter("all");
    setLeague("all");
    setSort((current) => (current === "upcoming" ? "league" : current));
  }

  function showUpcoming() {
    setSort("upcoming");
    setFilter("upcoming");
    setDay(null);
    setLeague("all");
  }

  function leaveUpcoming(next) {
    setSort(next);
    if (sort === "upcoming") setFilter("all");
  }

  function setStatus(id) {
    setFilter(id);
    setSort((current) => {
      if (id === "upcoming") return "upcoming";
      if (current === "upcoming") return "league";
      return current;
    });
  }

  return (
    <div className="desk">
      <aside className="rail">
        <div className="kpis">
          <div>
            <strong className="live-count">{counts.live ?? 0}</strong>
            <span>Live</span>
          </div>
          <div>
            <strong>{counts.upcoming ?? 0}</strong>
            <span>Upcoming</span>
          </div>
          <div>
            <strong>{counts.finished ?? 0}</strong>
            <span>Finished</span>
          </div>
        </div>
        <ConditionBoard
          days={listedDays}
          error={conditionError}
          selectedDate={day}
          onSelectDate={selectDay}
        />
        <div className="filters rail-filters">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              className={statusFilter === item.id ? "chip active" : "chip"}
              onClick={() => setStatus(item.id)}
              type="button"
            >
              {item.label}
              <span>{counts[item.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="rail-foot">
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
      </aside>

      <section className="pitch">
        <header className="pitch-head">
          <div>
            <p className="eyebrow">{day ? "Games that day" : sort === "upcoming" ? "Not started" : "Match board"}</p>
            <h1>{day ? formatDay(day) : sort === "upcoming" ? "Upcoming" : "Match desk"}</h1>
            {day && (
              <button className="day-clear" type="button" onClick={() => setDay(null)}>
                All days
              </button>
            )}
            <div className="sorts">
              <button className={sort === "upcoming" ? "chip active" : "chip"} type="button" onClick={showUpcoming}>
                Upcoming
              </button>
              <button className={sort === "league" ? "chip active" : "chip"} type="button" onClick={() => leaveUpcoming("league")}>
                By league
              </button>
              <button className={sort === "time" ? "chip active" : "chip"} type="button" onClick={() => leaveUpcoming("time")}>
                By time
              </button>
              <button className={layout === "cards" ? "chip active" : "chip"} type="button" onClick={() => setLayout("cards")}>
                Cards
              </button>
              <button className={layout === "rows" ? "chip active" : "chip"} type="button" onClick={() => setLayout("rows")}>
                One per row
              </button>
            </div>
          </div>
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
        </header>

        {selected && (
          <MatchStatus
            key={selected.slug}
            match={selected}
            condition={selected.slug ? conditionBySlug.get(selected.slug) : null}
            onClose={() => setSelectedSlug(null)}
          />
        )}

        {(error || dayError) && (
          <p className="banner">
            {error ? `${error}. The .NET API should be running on port 5095.` : dayError}
          </p>
        )}

        {day && dayGames === null && !dayError && <p className="empty">Loading this day…</p>}

        {!error && !dayError && !(day && dayGames === null) && !loading && visible.length === 0 && (
          <p className="empty">
            {sort === "upcoming"
              ? "No upcoming matches."
              : day
                ? `No matches on ${formatDay(day)}.`
                : "No matches in this view right now."}
          </p>
        )}

        {grouped.map((section) => (
          <section key={section.id} className="league-block">
            {section.label && (
              <h2 className="league-title">
                {section.label}
                <span>{section.matches.length}</span>
              </h2>
            )}
            <ul className={layout === "rows" ? "list rows" : "list"}>
              {section.matches.map((match) => (
                <MatchCard
                  key={match.slug || `${match.competition}-${match.home}-${match.away}-${match.kickoff}`}
                  match={match}
                  condition={match.slug ? conditionBySlug.get(match.slug) : null}
                  selected={Boolean(match.slug) && match.slug === selectedSlug}
                  onSelect={(item) =>
                    setSelectedSlug((current) => (current === item.slug ? null : item.slug))
                  }
                />
              ))}
            </ul>
          </section>
        ))}
      </section>
    </div>
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
          <ResultColumns goals={match.goals} outcome={match.outcome} detail={minuteLine(match)} />
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
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Football</p>
          <strong>Live desk</strong>
        </div>
        <SiteNav path={path} go={go} />
        <p className="credit">
          Powered by <a href="https://sportscore.com/">SportScore</a>
        </p>
      </header>
      <main className="stage">{page}</main>
    </div>
  );
}
