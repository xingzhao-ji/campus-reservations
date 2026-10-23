import { idempotencyKey } from "./keys.js";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Reservation = { id: string; state: string; expires_at: string | null };
type Slot = {
  id: string;
  title: string;
  location: string;
  capacity: number;
  occupied: number;
  waiting: number;
  starts_at: string;
  ends_at: string;
  mine: Reservation | null;
};
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    clock: "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    pin: "M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0 M14 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
    check: "M5 12l4 4L19 6",
    plus: "M12 5v14 M5 12h14",
    spark: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
    book: "M4 4h7l1 2 1-2h7v15h-7l-1 2-1-2H4z M12 6v15",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.grid} />
    </svg>
  );
}
const time = (s: string) =>
  new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function App() {
  const [demo, setDemo] = useState<boolean | null>(null),
    [storage, setStorage] = useState("postgresql"),
    [identity, setIdentity] = useState("alex"),
    [token, setToken] = useState(""),
    [draftToken, setDraftToken] = useState(""),
    [me, setMe] = useState<{ id: string; role: string } | null>(null),
    [slots, setSlots] = useState<Slot[]>([]),
    [filter, setFilter] = useState("all"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [now, setNow] = useState(Date.now()),
    [events, setEvents] = useState<any[]>([]),
    [showCreate, setShowCreate] = useState(false),
    [loaded, setLoaded] = useState(false);
  const headers = (): Record<string, string> =>
    demo
      ? { "X-Demo-Principal": identity }
      : token
        ? { Authorization: `Bearer ${token}` }
        : {};
  async function api(path: string, body?: any, key?: string) {
    const options: RequestInit = {
      headers: {
        ...headers(),
        ...(body !== undefined
          ? {
              "Content-Type": "application/json",
              "Idempotency-Key": key ?? idempotencyKey(),
            }
          : {}),
      },
      ...(body !== undefined
        ? { method: "POST", body: JSON.stringify(body) }
        : {}),
    };
    let response: Response;
    try {
      response = await fetch("/api" + path, options);
    } catch {
      response = await fetch("/api" + path, options);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Request failed");
    return result;
  }
  async function refresh(accept = () => true) {
    const [m, s] = await Promise.all([api("/me"), api("/slots")]);
    const es = m.role === "admin" ? await api("/admin/outbox") : [];
    if (!accept()) return;
    setMe(m);
    setSlots(s);
    setLoaded(true);
    setEvents(es);
  }
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        setDemo(c.demo);
        setStorage(c.storage);
      })
      .catch(() => setError("Unable to reach the reservation service."));
  }, []);
  useEffect(() => {
    setMe(null);
    setSlots([]);
    setLoaded(false);
    if (demo === null || (!demo && !token)) return;
    let active = true;
    const update = () =>
      refresh(() => active).catch((e) => {
        if (active) setError(e.message);
      });
    update();
    const timer = setInterval(update, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [demo, identity, token]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function act(
    id: string,
    path: string,
    body: any = {},
    message = "Reservation updated.",
  ) {
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await api(path, body);
      await refresh();
      setNotice(message);
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy("");
    }
  }
  const mine = slots.filter((s) => s.mine),
    available = slots.filter((s) => s.occupied < s.capacity),
    visible = slots.filter((s) =>
      filter === "mine"
        ? s.mine
        : filter === "available"
          ? s.occupied < s.capacity
          : true,
    );
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const success = await act(
      "create",
      "/slots",
      {
        title: data.get("title"),
        location: data.get("location"),
        capacity: Number(data.get("capacity")),
        startsAt: new Date(String(data.get("startsAt"))).toISOString(),
        endsAt: new Date(String(data.get("endsAt"))).toISOString(),
      },
      "New session is open for reservations.",
    );
    if (success) setShowCreate(false);
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Commonspace home">
          <span className="brand-icon">
            <Icon name="spark" size={27} />
          </span>
          commonspace<span className="brand-dot">.</span>
        </a>
        <p className="workspace-label">YOUR CAMPUS, CONNECTED</p>
        <nav aria-label="Main navigation">
          <button
            className={filter !== "mine" ? "nav active" : "nav"}
            onClick={() => setFilter("all")}
          >
            <Icon name="grid" />
            Explore spaces
            <span>{slots.length.toString().padStart(2, "0")}</span>
          </button>
          <button
            className={filter === "mine" ? "nav active" : "nav"}
            onClick={() => setFilter("mine")}
          >
            <Icon name="book" />
            My reservations
            <span>{mine.length.toString().padStart(2, "0")}</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="little-orbit">✳</span>
          <h3>
            A little space.
            <br />A lot of possibility.
          </h3>
          <p>Make time for the things you love doing.</p>
        </div>
        <div className="side-footer">
          <span className="status-dot" />
          Campus reservation service<span className="version">v0.1</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">Campus life</span>
            <span className="slash">/</span>
            <span>Spaces & sessions</span>
          </div>
          <div className="profile">
            <span className="avatar">
              {demo ? identity.charAt(0).toUpperCase() : "M"}
            </span>
            {demo ? (
              <label className="identity">
                <span>SYNTHETIC DEMO IDENTITY</span>
                <select
                  aria-label="Synthetic demo identity"
                  value={identity}
                  disabled={!!busy}
                  onChange={(e) => {
                    setIdentity(e.target.value);
                    setError("");
                    setNotice("");
                  }}
                >
                  <option value="alex">Alex · Member</option>
                  <option value="sam">Sam · Member</option>
                  <option value="admin">Admin · Administrator</option>
                </select>
              </label>
            ) : (
              <>
                <span>{me?.id ?? "Member access"}</span>
                {token && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setToken("");
                      setError("");
                      setNotice("");
                    }}
                  >
                    Change access token
                  </button>
                )}
              </>
            )}
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">ROOM TO DO YOUR THING</p>
              <h1>Find your next space.</h1>
              <p className="subtitle">
                A quiet corner, a creative afternoon, a little time for
                yourself.
              </p>
            </div>
            {me?.role === "admin" && (
              <button
                className="button dark"
                onClick={() => setShowCreate(true)}
              >
                <Icon name="plus" />
                Create session
              </button>
            )}
          </div>
          {demo && (
            <div className="demo-banner">
              <span className="badge small">LIVE LOCAL DEMO</span>
              <span>
                {storage === "embedded" ? "Serialized embedded demo. " : ""}
                Synthetic campus data. Switch identities to try holds, waitlists
                and admin controls.
              </span>
              <span className="demo-end">
                {storage === "embedded"
                  ? "Serialized embedded demo ↗"
                  : "PostgreSQL backed ↗"}
              </span>
            </div>
          )}
          {error && (
            <div role="alert" className="message error">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="message success">
              <Icon name="check" />
              {notice}
            </div>
          )}
          {demo === false && !token ? (
            <form
              className="login-panel"
              onSubmit={(e) => {
                e.preventDefault();
                setToken(draftToken);
                setDraftToken("");
              }}
            >
              <h2>Welcome to your campus.</h2>
              <p>Enter the bearer credential provided by your administrator.</p>
              <label>
                Access token
                <input
                  type="password"
                  required
                  minLength={32}
                  value={draftToken}
                  onChange={(e) => setDraftToken(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <button className="button dark">Connect securely</button>
            </form>
          ) : (
            <>
              <section className="stats" aria-label="Session overview">
                <div>
                  <span className="stat-icon lavender">
                    <Icon name="grid" />
                  </span>
                  <p>
                    <strong>{slots.length.toString().padStart(2, "0")}</strong>
                    <span>Sessions to explore</span>
                  </p>
                  <span className="stat-note">On the calendar</span>
                </div>
                <div>
                  <span className="stat-icon mint">
                    <Icon name="check" />
                  </span>
                  <p>
                    <strong>
                      {available.length.toString().padStart(2, "0")}
                    </strong>
                    <span>With room for you</span>
                  </p>
                  <span className="stat-note">Available now</span>
                </div>
                <div>
                  <span className="stat-icon peach">
                    <Icon name="book" />
                  </span>
                  <p>
                    <strong>{mine.length.toString().padStart(2, "0")}</strong>
                    <span>Your reservations</span>
                  </p>
                  <span className="stat-note">
                    Something to look forward to
                  </span>
                </div>
              </section>
              <section className="sessions">
                <div className="section-heading">
                  <div>
                    <h2>The campus is yours.</h2>
                    <p>Pick a session. Save your seat. Show up inspired.</p>
                  </div>
                  <div className="filters" aria-label="Filter sessions">
                    {[
                      ["all", "All sessions"],
                      ["available", "Available"],
                      ["mine", "My plans"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={filter === id ? "selected" : ""}
                        onClick={() => setFilter(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cards">
                  {visible.map((s, i) => {
                    const seconds = s.mine?.expires_at
                      ? Math.max(
                          0,
                          Math.ceil(
                            (Date.parse(s.mine.expires_at) - now) / 1000,
                          ),
                        )
                      : 0;
                    return (
                      <article className="session-card" key={s.id}>
                        <div className={`card-art art-${i % 3}`}>
                          <span className="art-word">
                            {s.title.split(" ")[0]}
                          </span>
                          <div className="art-shape shape-a" />
                          <div className="art-shape shape-b" />
                          <div className="art-shape shape-c" />
                          <span className="category">
                            {s.location.split(" · ")[0]}
                          </span>
                          <span className="art-number">0{i + 1}</span>
                        </div>
                        <div className="card-body">
                          <div className="card-date">
                            <span>
                              {new Date(s.starts_at).toLocaleDateString([], {
                                weekday: "short",
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                            <span
                              className={`badge ${s.mine?.state === "confirmed" ? "green" : s.occupied >= s.capacity ? "neutral" : ""}`}
                            >
                              {s.mine?.state === "confirmed"
                                ? "You’re booked"
                                : s.occupied >= s.capacity
                                  ? "Waitlist open"
                                  : `${s.capacity - s.occupied} spots left`}
                            </span>
                          </div>
                          <h3>{s.title}</h3>
                          <p className="detail">
                            <Icon name="clock" size={16} />
                            {time(s.starts_at)} – {time(s.ends_at)}
                          </p>
                          <p className="detail">
                            <Icon name="pin" size={16} />
                            {s.location}
                          </p>
                          <div className="capacity">
                            <div className="capacity-label">
                              <span>
                                {s.occupied} of {s.capacity} places reserved
                              </span>
                              <span>
                                {s.waiting > 0 ? `${s.waiting} waiting` : ""}
                              </span>
                            </div>
                            <progress
                              aria-label="Reserved places"
                              max={s.capacity}
                              value={s.occupied}
                            />
                          </div>
                          {s.mine?.state === "held" ? (
                            <div className="reservation-actions">
                              <p className="hold-clock">
                                <Icon name="clock" size={15} />
                                Held for {Math.floor(seconds / 60)}:
                                {String(seconds % 60).padStart(2, "0")} ·
                                confirm your place
                              </p>
                              <button
                                disabled={!!busy || seconds === 0}
                                className="button purple"
                                onClick={() =>
                                  act(
                                    s.id,
                                    `/reservations/${s.mine!.id}/confirm`,
                                    {},
                                    "Your place is confirmed. See you there!",
                                  )
                                }
                              >
                                Confirm reservation
                                <Icon name="check" size={17} />
                              </button>
                              <button
                                className="text-button"
                                disabled={!!busy}
                                onClick={() =>
                                  act(
                                    s.id,
                                    `/reservations/${s.mine!.id}/cancel`,
                                  )
                                }
                              >
                                Release my hold
                              </button>
                            </div>
                          ) : s.mine ? (
                            <div className="reservation-actions">
                              <div className="booked-note">
                                <Icon
                                  name={
                                    s.mine.state === "confirmed"
                                      ? "check"
                                      : "clock"
                                  }
                                  size={17}
                                />
                                {s.mine.state === "confirmed"
                                  ? "Your place is confirmed"
                                  : "You’re on the waitlist"}
                              </div>
                              <button
                                className="button outline"
                                disabled={!!busy}
                                onClick={() =>
                                  act(
                                    s.id,
                                    `/reservations/${s.mine!.id}/cancel`,
                                  )
                                }
                              >
                                Cancel{" "}
                                {s.mine.state === "waitlisted"
                                  ? "waitlist"
                                  : "reservation"}
                              </button>
                            </div>
                          ) : (
                            <button
                              disabled={!!busy}
                              className="button reserve"
                              onClick={() =>
                                act(
                                  s.id,
                                  `/slots/${s.id}/holds`,
                                  {},
                                  s.occupied < s.capacity
                                    ? "Your place is held for two minutes. Confirm to keep it."
                                    : "You’re on the waitlist. We’ll offer a hold here when a place opens.",
                                )
                              }
                            >
                              <span>
                                {busy === s.id
                                  ? "Saving…"
                                  : s.occupied < s.capacity
                                    ? "Reserve a place"
                                    : "Join the waitlist"}
                              </span>
                              <Icon name="arrow" size={19} />
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                {!visible.length && (
                  <div className="empty">
                    <Icon name="spark" size={32} />
                    <h3>
                      {loaded
                        ? "A little room for possibility."
                        : "Loading sessions…"}
                    </h3>
                    <p>
                      {loaded
                        ? "No sessions in this view. Explore all sessions to make a plan."
                        : "Connecting to your campus."}
                    </p>
                  </div>
                )}
              </section>
              <div className="how-it-works">
                <span className="info-mark">i</span>
                <p>
                  <strong>A moment to make it yours.</strong> Places are held
                  for two minutes. Confirm before the timer ends. If a session
                  is full, join the waitlist — the next person gets a fresh hold
                  when a place opens.
                </p>
              </div>
              {me?.role === "admin" && (
                <section className="admin-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">ADMINISTRATOR</p>
                      <h2>Delivery activity</h2>
                      <p>
                        Transactional events · leased delivery ·
                        acknowledgements fenced by token
                      </p>
                    </div>
                    <button
                      className="button outline"
                      onClick={() =>
                        act(
                          "expire",
                          "/admin/expire",
                          {},
                          "Expired holds processed.",
                        )
                      }
                    >
                      Process expiry
                    </button>
                  </div>
                  <div className="event-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Event</th>
                          <th>Type</th>
                          <th>Attempts</th>
                          <th>Delivery</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.slice(0, 8).map((e) => (
                          <tr key={e.id}>
                            <td>#{e.id}</td>
                            <td>{e.type}</td>
                            <td>{e.attempts}</td>
                            <td>
                              <span className="badge neutral">
                                {e.delivered_at
                                  ? "Acknowledged"
                                  : e.lease_until &&
                                      Date.parse(e.lease_until) > now
                                    ? "Leased"
                                    : "Pending"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!events.length && (
                      <p className="empty-events">
                        Activity appears here after the first reservation.
                      </p>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
          <footer>
            <span>Made for campus life.</span>
            <span>Commonspace · One campus, many possibilities.</span>
          </footer>
        </div>
      </main>
      {showCreate && (
        <div className="modal-backdrop">
          <section
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowCreate(false);
              if (e.key === "Tab") {
                const items = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled),input,select",
                  ),
                );
                const first = items[0],
                  last = items.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
            className="modal"
          >
            <button
              className="close"
              aria-label="Close dialog"
              onClick={() => setShowCreate(false)}
            >
              ×
            </button>
            <p className="eyebrow">MAKE ROOM FOR SOMETHING</p>
            <h2 id="create-title">Create a session</h2>
            <form onSubmit={create}>
              <label>
                Session name
                <input
                  name="title"
                  maxLength={120}
                  required
                  placeholder="Printmaking open studio"
                  autoFocus
                />
              </label>
              <label>
                Location
                <input
                  name="location"
                  maxLength={120}
                  required
                  placeholder="Arts Building · Studio 04"
                />
              </label>
              <div className="form-row">
                <label>
                  Starts
                  <input name="startsAt" type="datetime-local" required />
                </label>
                <label>
                  Ends
                  <input name="endsAt" type="datetime-local" required />
                </label>
              </div>
              <label>
                Capacity
                <input
                  name="capacity"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue={6}
                  required
                />
              </label>
              <button disabled={!!busy} className="button purple">
                {busy ? "Creating…" : "Open for reservations"}
                <Icon name="arrow" />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
