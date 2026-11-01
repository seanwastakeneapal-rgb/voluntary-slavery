/* Voluntary Slavery: one page app. All data lives in Supabase; this file renders it. */
(() => {
  'use strict';

  const cfg = window.CREW_CONFIG || {};
  const app = document.getElementById('app');

  if (!cfg.url || cfg.url.includes('YOUR-PROJECT') || !window.supabase) {
    app.innerHTML = `<div class="wrap auth"><div class="auth-hero"><h1>Almost there</h1>
      <p>Paste your Supabase URL and anon key into <b>config.js</b>, then reload. Steps are in README.md.</p></div></div>`;
    return;
  }

  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  const EMOJIS = ['😎', '🦁', '🐺', '🦊', '🐼', '🐸', '🦄', '🐙', '🔥', '⚡', '🚀', '🌱', '🏀', '🎸', '🧠', '👑'];
  const COLORS = ['#3355ff', '#ff4f7b', '#12a67a', '#ff8a1f', '#8b5cf6', '#0ea5c6', '#d9a400', '#e8590c'];
  const CHEERS = ['🔥', '👏', '💪'];
  const TABS = [
    { id: 'me', label: 'Me', icon: '✅' },
    { id: 'crew', label: 'Crew', icon: '👥' },
    { id: 'calendar', label: 'Calendar', icon: '📅' },
    { id: 'board', label: 'Board', icon: '🏆' },
  ];

  const state = {
    session: null,
    me: null,
    profiles: {},
    tasks: [],
    goals: [],
    votes: [],
    donations: [],
    reactions: [],
    board: [],
    loaded: false,
    tab: 'me',
    authMode: 'signin',
    sheet: null, // 'inbox' | 'profile'
    draftProfile: null,
    boardMode: 'week',
    calMonth: startOfMonth(new Date()),
    calDay: todayStr(),
    calFilter: 'all',
    openDonate: null, // key of the open "give points" box
    confirmDelete: null,
  };

  // ---------- helpers ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayStr() { return dateKey(new Date()); }
  function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function daysUntil(s) { return Math.round((parseDay(s) - parseDay(todayStr())) / 86400000); }
  function localDayOf(ts) { return dateKey(new Date(ts)); }

  function dueChip(task) {
    if (!task.due_date) return '';
    const d = daysUntil(task.due_date);
    const nice = parseDay(task.due_date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (task.status === 'done') return `<span class="chip">Due ${nice}</span>`;
    if (d < 0) return `<span class="chip overdue">Overdue ${-d}d</span>`;
    if (d === 0) return `<span class="chip today">Due today</span>`;
    if (d === 1) return `<span class="chip today">Due tomorrow</span>`;
    return `<span class="chip">Due ${nice}</span>`;
  }

  function timeAgo(ts) {
    const s = (Date.now() - new Date(ts)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function person(id) { return state.profiles[id] || { display_name: 'Someone', emoji: '🙂', color: '#888' }; }
  function av(id, size = '') {
    const p = person(id);
    return `<span class="av ${size}" style="--c:${esc(p.color)}" title="${esc(p.display_name)}">${esc(p.emoji)}</span>`;
  }
  function isMe(id) { return state.me && id === state.me.id; }

  // Same rule as the task_scores view: 1 point until friends vote, then their rounded average.
  function taskScore(taskId) {
    const vs = state.votes.filter((v) => v.task_id === taskId);
    if (!vs.length) return { score: 1, count: 0 };
    return { score: Math.round(vs.reduce((a, v) => a + v.points, 0) / vs.length), count: vs.length };
  }

  // Days in a row with at least one finished task. Still alive if the last one was yesterday.
  function streakFor(userId) {
    const days = new Set(state.tasks.filter((t) => t.owner_id === userId && t.completed_at).map((t) => localDayOf(t.completed_at)));
    const d = new Date();
    if (!days.has(dateKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dateKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function boardRow(id) { return state.board.find((b) => b.id === id) || { total: 0, week: 0, tasks_done: 0, tasks_week: 0 }; }
  function goalOf(id) { return state.goals.find((g) => g.id === id); }

  let toastTimer;
  function toast(msg, isErr = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = isErr ? 'err' : '';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 4500 : 2600);
  }
  function fail(error) {
    console.error(error);
    toast(error?.message || 'Something went wrong. Try again.', true);
  }

  // ---------- data ----------

  async function loadAll() {
    const res = await Promise.all([
      sb.from('profiles').select('*'),
      sb.from('goals').select('*').order('created_at'),
      sb.from('tasks').select('*').order('created_at'),
      sb.from('task_votes').select('*'),
      sb.from('donations').select('*').order('created_at', { ascending: false }),
      sb.from('reactions').select('*').order('created_at', { ascending: false }),
      sb.from('leaderboard').select('*'),
    ]);
    const bad = res.find((r) => r.error);
    if (bad) return fail(bad.error);
    const [p, g, t, v, d, r, b] = res.map((x) => x.data);
    state.profiles = Object.fromEntries(p.map((x) => [x.id, x]));
    state.me = state.profiles[state.session.user.id] || null;
    Object.assign(state, { goals: g, tasks: t, votes: v, donations: d, reactions: r, board: b, loaded: true });
    render();
  }

  let reloadTimer;
  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 250); }

  let channel;
  function subscribe() {
    if (channel) return;
    channel = sb.channel('crew')
      .on('postgres_changes', { event: '*', schema: 'public' }, scheduleReload)
      .subscribe();
  }

  // ---------- render ----------

  function render() {
    // Keep whatever people are typing when live updates re-draw the page.
    const saved = {};
    app.querySelectorAll('input[id], textarea[id], select[id]').forEach((el) => { saved[el.id] = el.value; });
    const active = document.activeElement && document.activeElement.id;
    const sel = active && document.activeElement.selectionStart;

    app.innerHTML = view();

    for (const [id, val] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el && el.type !== 'hidden') el.value = val;
    }
    if (active) {
      const el = document.getElementById(active);
      if (el) {
        el.focus();
        try { if (sel != null) el.setSelectionRange(sel, sel); } catch (_) { /* date inputs */ }
      }
    }
  }

  function view() {
    if (!state.session) return authView();
    if (!state.loaded) return `<p class="boot">Loading your crew…</p>`;
    if (!state.me) return `<p class="boot">Setting up your profile… reload in a sec.</p>`;
    if (!state.me.onboarded) return `<div class="wrap auth">${profileForm(true)}</div>`;

    const body = { me: meView, crew: crewView, calendar: calendarView, board: boardView }[state.tab]();
    return `
      <header class="topbar"><div class="wrap">
        <div class="wordmark"><span class="mark">✓</span>Voluntary Slavery</div>
        <span class="pts num" title="Your points">${boardRow(state.me.id).total}</span>
        <button class="icon-btn" data-action="open-inbox" aria-label="Inbox">🔔${unseenCount() ? `<span class="badge">${unseenCount()}</span>` : ''}</button>
        <button class="icon-btn" data-action="open-profile" aria-label="Your profile" style="border:0;background:none">${av(state.me.id)}</button>
      </div></header>
      <main class="wrap main">${body}</main>
      <nav class="tabbar" aria-label="Sections"><div class="wrap">
        ${TABS.map((t) => `<button class="tab" data-action="tab" data-tab="${t.id}" ${state.tab === t.id ? 'aria-current="page"' : ''}>
          <span class="ti">${t.icon}</span>${t.label}</button>`).join('')}
      </div></nav>
      ${state.sheet === 'inbox' ? inboxSheet() : ''}
      ${state.sheet === 'profile' ? `<div class="scrim" data-action="close-sheet"><div class="sheet" data-stop>${profileForm(false)}</div></div>` : ''}`;
  }

  // ----- auth -----

  function authView() {
    const signup = state.authMode === 'signup';
    return `<div class="wrap auth">
      <div class="auth-hero">
        <div class="wordmark"><span class="mark">✓</span>Voluntary Slavery</div>
        <h1>Say it. Do it. <em>Get rated.</em></h1>
        <p>Your tasks, your goals, and a crew of friends who decide what they're worth.</p>
      </div>
      <form class="card" id="auth-form">
        <label class="field"><span>Email</span><input id="auth-email" type="email" autocomplete="email" required></label>
        <label class="field"><span>Password</span><input id="auth-pass" type="password" minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
        <button class="btn" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
        <div class="switch">${signup ? 'Already in the crew?' : 'New here?'}
          <button type="button" class="link-btn" data-action="auth-mode">${signup ? 'Sign in' : 'Create an account'}</button></div>
      </form>
      <ul class="rules">
        <li><span class="pts">1</span> for every task you finish</li>
        <li><span class="pts">1-5</span> friends vote on what it was really worth</li>
        <li><span class="pts">+</span> friends can give you some of their own points</li>
      </ul>
    </div>`;
  }

  // ----- profile -----

  function profileForm(first) {
    const d = state.draftProfile || (state.draftProfile = { display_name: state.me.display_name, emoji: state.me.emoji, color: state.me.color });
    return `<form class="${first ? 'card' : ''}" id="profile-form" style="display:grid;gap:16px;${first ? 'padding:18px' : ''}">
      <div class="sheet-head"><h2>${first ? 'Set up your player' : 'Your profile'}</h2>
        ${first ? '' : '<button type="button" class="x-btn" data-action="close-sheet" aria-label="Close">✕</button>'}</div>
      <div style="display:flex;gap:12px;align-items:center">
        <span class="av lg" style="--c:${esc(d.color)}">${esc(d.emoji)}</span>
        <label class="field" style="flex:1"><span>Name your friends will see</span>
          <input id="pf-name" type="text" maxlength="30" required value="${esc(d.display_name)}"></label>
      </div>
      <div class="field"><span>Pick an emoji</span><div class="emoji-grid">
        ${EMOJIS.map((e) => `<button type="button" data-action="pick-emoji" data-emoji="${e}" aria-pressed="${d.emoji === e}">${e}</button>`).join('')}
      </div></div>
      <div class="field"><span>Your colour</span><div class="swatches">
        ${COLORS.map((c) => `<button type="button" data-action="pick-color" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}" aria-pressed="${d.color === c}"></button>`).join('')}
      </div></div>
      <button class="btn" type="submit">${first ? "Let's go" : 'Save'}</button>
      ${first ? '' : '<button type="button" class="btn ghost" data-action="sign-out">Sign out</button>'}
    </form>`;
  }

  // ----- me -----

  function meView() {
    const me = state.me.id;
    const row = boardRow(me);
    const mine = state.tasks.filter((t) => t.owner_id === me);
    const open = mine.filter((t) => t.status === 'todo' && !t.goal_id).sort(byDue);
    const done = mine.filter((t) => t.status === 'done').sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at)).slice(0, 6);
    const goals = state.goals.filter((g) => g.owner_id === me).sort((a, b) => a.done - b.done);
    const myGoals = goals.filter((g) => !g.done);
    const streak = streakFor(me);

    return `
      <section class="card stats">
        <div class="stat points"><span class="label">Points</span><b>${row.total}</b></div>
        <div class="stat"><span class="label">Streak</span><b>${streak}</b><span class="label" style="letter-spacing:0;text-transform:none">${streak === 1 ? 'day' : 'days'}${streak ? ' 🔥' : ''}</span></div>
        <div class="stat"><span class="label">Done this week</span><b>${row.tasks_week}</b></div>
      </section>

      <form class="card add-form" id="task-form">
        <input id="t-title" class="title-input" type="text" maxlength="160" placeholder="What are you getting done?" required aria-label="Task">
        <div class="row">
          <label class="field grow"><span>Due date</span><input id="t-due" type="date"></label>
          <label class="field grow"><span>Part of a goal</span><select id="t-goal">
            <option value="">No goal</option>
            ${myGoals.map((g) => `<option value="${g.id}">${esc(g.title)}</option>`).join('')}
          </select></label>
        </div>
        <details class="more"><summary>+ Add notes</summary><textarea id="t-notes" maxlength="500" placeholder="Details, links, why it matters"></textarea></details>
        <button class="btn" type="submit">Add task</button>
      </form>

      <section class="section">
        <div class="section-head"><h2>To do</h2><span class="hint">${open.length} open</span></div>
        ${open.length ? `<ul class="list card">${open.map(taskRow).join('')}</ul>`
          : `<div class="empty">Nothing loose on your list. Add a task above, or add one to a goal below.</div>`}
      </section>

      <section class="section">
        <div class="section-head"><h2>Goals</h2><span class="hint">Big things, broken into tasks</span></div>
        <div class="goals">${goals.map(goalCard).join('')}</div>
        <form class="card add-form" id="goal-form">
          <div class="row">
            <label class="field grow"><span>New goal</span><input id="g-title" type="text" maxlength="120" placeholder="e.g. Run a 10k" required></label>
            <label class="field grow"><span>Target date</span><input id="g-date" type="date"></label>
          </div>
          <button class="btn ghost" type="submit">Add goal</button>
        </form>
      </section>

      ${done.length ? `<section class="section">
        <div class="section-head"><h2>Recently done</h2><span class="hint">Friends are rating these</span></div>
        <ul class="list card">${done.map(taskRow).join('')}</ul>
      </section>` : ''}`;
  }

  function byDue(a, b) {
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  }

  function reactionSummary(taskId, kind) {
    const rs = state.reactions.filter((r) => r.task_id === taskId && r.kind === kind);
    const counts = {};
    rs.forEach((r) => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
    return Object.entries(counts).map(([e, n]) => `${e} ${n}`).join('  ');
  }

  function taskRow(t, opts = {}) {
    const done = t.status === 'done';
    const goal = !opts.inGoal && t.goal_id && goalOf(t.goal_id);
    const nudges = state.reactions.filter((r) => r.task_id === t.id && r.kind === 'nudge').length;
    const cheers = reactionSummary(t.id, 'cheer');
    const sc = done ? taskScore(t.id) : null;
    const confirming = state.confirmDelete === t.id;
    return `<li class="task ${done ? 'is-done' : ''}">
      <button class="check ${done ? 'done' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}">✓</button>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ''}
        <div class="meta">
          ${done ? `<span class="pts">${sc.score}</span><span>${sc.count ? `${sc.count} vote${sc.count > 1 ? 's' : ''}` : 'waiting for votes'}</span>` : dueChip(t)}
          ${goal ? `<span class="chip goal">${esc(goal.title)}</span>` : ''}
          ${cheers ? `<span>${cheers}</span>` : ''}
          ${!done && nudges ? `<span class="chip overdue">👉 ${nudges} nudge${nudges > 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        ${confirming
          ? `<button class="btn danger sm" data-action="delete-task" data-id="${t.id}">Delete</button>`
          : `<button class="x-btn" data-action="ask-delete" data-id="${t.id}" aria-label="Delete task">✕</button>`}
      </div>
    </li>`;
  }

  function goalProgress(g) {
    const ts = state.tasks.filter((t) => t.goal_id === g.id);
    const done = ts.filter((t) => t.status === 'done').length;
    return { ts, done, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  }

  function goalCard(g) {
    const { ts, done, total, pct } = goalProgress(g);
    const color = person(g.owner_id).color;
    const confirming = state.confirmDelete === g.id;
    const target = g.target_date ? parseDay(g.target_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return `<article class="card goal ${g.done ? 'is-done' : ''}">
      <div class="goal-top">
        <h3>${g.done ? '🏁 ' : ''}${esc(g.title)}</h3>
        ${confirming
          ? `<button class="btn danger sm" data-action="delete-goal" data-id="${g.id}">Delete goal</button>`
          : `<button class="x-btn" data-action="ask-delete" data-id="${g.id}" aria-label="Delete goal">✕</button>`}
      </div>
      <div class="bar" style="--c:${esc(color)}"><i style="width:${g.done ? 100 : pct}%"></i></div>
      <div class="meta"><span class="num">${done}/${total} tasks</span>${target ? `<span class="chip">Target ${target}</span>` : ''}</div>
      ${ts.length ? `<ul class="list">${ts.sort(byDue).map((t) => taskRow(t, { inGoal: true })).join('')}</ul>` : ''}
      ${g.done ? '' : `<form class="mini-add" data-goal="${g.id}">
        <input id="gt-${g.id}" type="text" maxlength="160" placeholder="Add a step" required aria-label="Add a step to ${esc(g.title)}">
        <button class="btn sm ghost" type="submit">Add</button></form>`}
      <div><button class="link-btn" data-action="toggle-goal" data-id="${g.id}">${g.done ? 'Reopen goal' : 'Mark goal complete'}</button></div>
    </article>`;
  }

  // ----- crew -----

  function crewView() {
    const me = state.me.id;
    const pushes = state.tasks
      .filter((t) => t.owner_id !== me && t.status === 'todo' && t.due_date && daysUntil(t.due_date) <= 0)
      .sort(byDue);
    const feed = state.tasks
      .filter((t) => t.status === 'done')
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
      .slice(0, 40);
    const friendGoals = state.goals.filter((g) => g.owner_id !== me && !g.done);

    return `
      ${pushes.length ? `<section class="section">
        <div class="section-head"><h2>Needs a push</h2><span class="hint">Due today or overdue</span></div>
        <ul class="list card">${pushes.map(pushRow).join('')}</ul>
      </section>` : ''}

      <section class="section">
        <div class="section-head"><h2>Finished lately</h2><span class="hint">Vote on what it was worth</span></div>
        ${feed.length ? feed.map(feedItem).join('')
          : `<div class="empty">No finished tasks yet. The first one done sets the bar.</div>`}
      </section>

      ${friendGoals.length ? `<section class="section">
        <div class="section-head"><h2>Crew goals</h2></div>
        <ul class="list card">${friendGoals.map((g) => {
          const { done, total, pct } = goalProgress(g);
          return `<li class="push-item">${av(g.owner_id)}<div class="task-body">
            <div class="task-title">${esc(g.title)}</div>
            <div class="bar" style="--c:${esc(person(g.owner_id).color)}"><i style="width:${pct}%"></i></div>
            <div class="meta"><span>${esc(person(g.owner_id).display_name)}</span><span class="num">${done}/${total} tasks</span></div>
          </div></li>`;
        }).join('')}</ul>
      </section>` : ''}`;
  }

  function pushRow(t) {
    const nudges = state.reactions.filter((r) => r.task_id === t.id && r.kind === 'nudge');
    const iNudged = nudges.some((r) => isMe(r.from_id) && localDayOf(r.created_at) === todayStr());
    return `<li class="push-item">${av(t.owner_id)}
      <div class="task-body"><div class="task-title">${esc(t.title)}</div>
        <div class="meta"><span>${esc(person(t.owner_id).display_name)}</span>${dueChip(t)}${nudges.length ? `<span>👉 ${nudges.length}</span>` : ''}</div></div>
      <button class="btn sm ${iNudged ? 'ghost' : ''}" data-action="nudge" data-id="${t.id}" ${iNudged ? 'disabled' : ''}>${iNudged ? 'Nudged' : '👉 Nudge'}</button>
    </li>`;
  }

  function feedItem(t) {
    const mine = isMe(t.owner_id);
    const sc = taskScore(t.id);
    const myVote = state.votes.find((v) => v.task_id === t.id && isMe(v.voter_id));
    const goal = t.goal_id && goalOf(t.goal_id);
    const cheers = state.reactions.filter((r) => r.task_id === t.id && r.kind === 'cheer');
    const gifts = state.donations.filter((d) => d.task_id === t.id);
    const key = `task-${t.id}`;

    const stars = mine ? '' : `<div class="stars" role="group" aria-label="Rate this task">
      <span class="label" style="margin-right:6px">${myVote ? 'Your vote' : 'Rate it'}</span>
      ${[1, 2, 3, 4, 5].map((n) => `<button class="star ${myVote && n <= myVote.points ? 'on' : ''}" data-action="vote" data-id="${t.id}" data-points="${n}" aria-label="${n} point${n > 1 ? 's' : ''}">★</button>`).join('')}
    </div>`;

    const reacts = CHEERS.map((e) => {
      const n = cheers.filter((r) => r.emoji === e).length;
      const minePressed = cheers.some((r) => r.emoji === e && isMe(r.from_id));
      if (mine) return n ? `<span class="react">${e} ${n}</span>` : '';
      return `<button class="react ${minePressed ? 'mine' : ''}" data-action="cheer" data-id="${t.id}" data-emoji="${e}" aria-pressed="${minePressed}">${e}${n ? ` ${n}` : ''}</button>`;
    }).join('');

    return `<article class="card feed-item">
      <div class="who">${av(t.owner_id)}
        <div class="who-text"><div class="name">${mine ? 'You' : esc(person(t.owner_id).display_name)}</div>
          <div class="sub">finished ${timeAgo(t.completed_at)}</div></div>
        <span class="pts" title="${sc.count} vote${sc.count === 1 ? '' : 's'}">${sc.score}</span>
      </div>
      <div class="feed-title">${esc(t.title)}</div>
      ${goal ? `<div class="meta"><span class="chip goal">${esc(goal.title)}</span></div>` : ''}
      ${stars}
      <div class="react-row">${reacts}
        ${mine ? '' : `<button class="react" data-action="toggle-donate" data-key="${key}">🪙 Give points</button>`}
        <span class="meta" style="margin-left:auto">${sc.count} vote${sc.count === 1 ? '' : 's'}</span>
      </div>
      ${gifts.map((g) => `<div class="shout"><b>${esc(person(g.from_id).display_name)}</b> gave <b>${g.amount}</b> pt${g.amount > 1 ? 's' : ''}${g.message ? `: “${esc(g.message)}”` : ''}</div>`).join('')}
      ${state.openDonate === key ? donateBox(key, t.owner_id, t.id) : ''}
    </article>`;
  }

  function donateBox(key, toId, taskId) {
    const have = boardRow(state.me.id).total;
    return `<form class="donate-box" data-donate-to="${toId}" data-task="${taskId || ''}">
      <div class="shout">Give some of your <b>${have}</b> points to <b>${esc(person(toId).display_name)}</b>. They come off your total.</div>
      <div class="row">
        <input id="don-amt-${key}" type="number" min="1" max="${Math.max(have, 1)}" value="1" aria-label="Points to give">
        <input id="don-msg-${key}" type="text" maxlength="140" placeholder="Why they deserve it (optional)" class="grow" style="flex:1 1 160px">
        <button class="btn gold sm" type="submit" ${have < 1 ? 'disabled' : ''}>Give</button>
      </div>
    </form>`;
  }

  // ----- calendar -----

  function calendarView() {
    const m = state.calMonth;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // weeks start Monday
    const start = new Date(first); start.setDate(1 - offset);
    const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const cells = Math.ceil((offset + daysInMonth) / 7) * 7;

    const visible = state.tasks.filter((t) => t.due_date && (state.calFilter === 'all' || t.owner_id === state.calFilter));
    const byDay = {};
    visible.forEach((t) => { (byDay[t.due_date] ||= []).push(t); });

    const today = todayStr();
    let grid = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < cells; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = dateKey(d);
      const ts = byDay[k] || [];
      const cls = ['day', d.getMonth() !== m.getMonth() && 'out', k === today && 'today', k === state.calDay && 'sel'].filter(Boolean).join(' ');
      grid += `<button class="${cls}" data-action="cal-day" data-day="${k}" aria-label="${d.toDateString()}, ${ts.length} task${ts.length === 1 ? '' : 's'}">
        <span>${d.getDate()}</span>
        <span class="dots">${ts.slice(0, 6).map((t) => `<i class="dot ${t.status === 'done' ? 'done' : ''}" style="--c:${esc(person(t.owner_id).color)}"></i>`).join('')}</span>
      </button>`;
    }

    const dayTasks = (byDay[state.calDay] || []).sort((a, b) => a.status.localeCompare(b.status) * -1);
    const dayLabel = parseDay(state.calDay).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const people = Object.values(state.profiles).filter((p) => p.onboarded);

    return `
      <div class="filters">
        <button class="filter all" data-action="cal-filter" data-who="all" aria-pressed="${state.calFilter === 'all'}">Everyone</button>
        ${people.map((p) => `<button class="filter" data-action="cal-filter" data-who="${p.id}" aria-pressed="${state.calFilter === p.id}">${av(p.id, 'sm')}${isMe(p.id) ? 'Me' : esc(p.display_name)}</button>`).join('')}
      </div>
      <section class="card cal">
        <div class="cal-head">
          <button class="icon-btn" data-action="cal-move" data-dir="-1" aria-label="Previous month">‹</button>
          <h2>${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          <button class="btn ghost sm" data-action="cal-today">Today</button>
          <button class="icon-btn" data-action="cal-move" data-dir="1" aria-label="Next month">›</button>
        </div>
        <div class="cal-grid">${grid}</div>
      </section>
      <section class="section">
        <div class="section-head"><h2>${dayLabel}</h2><span class="hint">${dayTasks.length} due</span></div>
        ${dayTasks.length ? `<ul class="list card">${dayTasks.map((t) => `<li class="push-item">${av(t.owner_id)}
          <div class="task-body"><div class="task-title" style="${t.status === 'done' ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.title)}</div>
          <div class="meta"><span>${isMe(t.owner_id) ? 'You' : esc(person(t.owner_id).display_name)}</span>${t.status === 'done' ? '<span class="chip">Done</span>' : dueChip(t)}</div></div>
          ${isMe(t.owner_id) && t.status === 'todo' ? `<button class="check" data-action="toggle-task" data-id="${t.id}" aria-label="Mark done">✓</button>` : ''}
        </li>`).join('')}</ul>` : `<div class="empty">Nothing due this day.</div>`}
      </section>`;
  }

  // ----- leaderboard -----

  function boardView() {
    const week = state.boardMode === 'week';
    const rows = state.board
      .filter((b) => state.profiles[b.id] && state.profiles[b.id].onboarded)
      .map((b) => ({ ...b, streak: streakFor(b.id) }))
      .sort((a, b) => (week ? b.week - a.week : b.total - a.total) || b.streak - a.streak);
    const gifts = state.donations.slice(0, 10);

    return `
      <div class="section-head">
        <h2 style="font-size:var(--step-2)">Leaderboard</h2>
        <div class="seg" role="group" aria-label="Time range">
          <button data-action="board-mode" data-mode="week" aria-pressed="${week}">This week</button>
          <button data-action="board-mode" data-mode="all" aria-pressed="${!week}">All time</button>
        </div>
      </div>
      <ul class="list card">${rows.map((b, i) => {
        const key = `board-${b.id}`;
        const mine = isMe(b.id);
        return `<li class="board-row ${i === 0 && (week ? b.week : b.total) > 0 ? 'first' : ''}">
          <span class="rank">${i + 1}</span>${av(b.id)}
          <div class="who-text"><div class="name">${mine ? 'You' : esc(b.display_name)}</div>
            <div class="sub">${b.streak ? `🔥 ${b.streak} day streak · ` : ''}${week ? b.tasks_week : b.tasks_done} done
              ${mine ? '' : ` · <button class="link-btn" style="padding:0;font-size:inherit" data-action="toggle-donate" data-key="${key}">Give points</button>`}</div></div>
          <div class="score">${week ? b.week : b.total}<small>pts</small></div>
          ${state.openDonate === key ? donateBox(key, b.id, null) : ''}
        </li>`;
      }).join('')}</ul>
      <p class="hint" style="color:var(--muted);font-size:var(--step--1);margin:0">Points = finished tasks (rated by friends) + points given to you − points you gave away.</p>

      ${gifts.length ? `<section class="section">
        <div class="section-head"><h2>Points given</h2></div>
        <ul class="list card">${gifts.map((g) => `<li class="push-item">${av(g.from_id, 'sm')}<span aria-hidden="true">→</span>${av(g.to_id, 'sm')}
          <div class="task-body"><div class="shout"><b>${esc(person(g.from_id).display_name)}</b> gave <b>${esc(person(g.to_id).display_name)}</b> <span class="pts">${g.amount}</span></div>
          ${g.message ? `<div class="task-notes">“${esc(g.message)}”</div>` : ''}</div>
          <span class="meta">${timeAgo(g.created_at)}</span></li>`).join('')}</ul>
      </section>` : ''}`;
  }

  // ----- inbox -----

  function inboxItems() {
    const me = state.me.id;
    const myTask = new Set(state.tasks.filter((t) => t.owner_id === me).map((t) => t.id));
    const title = (id) => esc((state.tasks.find((t) => t.id === id) || {}).title || 'a task');
    const items = [];
    state.votes.filter((v) => myTask.has(v.task_id) && v.voter_id !== me).forEach((v) =>
      items.push({ at: v.created_at, from: v.voter_id, text: `rated <b>${title(v.task_id)}</b> ${'★'.repeat(v.points)}` }));
    state.reactions.filter((r) => myTask.has(r.task_id) && r.from_id !== me).forEach((r) =>
      items.push({ at: r.created_at, from: r.from_id, text: r.kind === 'nudge' ? `nudged you about <b>${title(r.task_id)}</b> 👉` : `cheered <b>${title(r.task_id)}</b> ${esc(r.emoji)}` }));
    state.donations.filter((d) => d.to_id === me).forEach((d) =>
      items.push({ at: d.created_at, from: d.from_id, text: `gave you <span class="pts">${d.amount}</span>${d.message ? ` “${esc(d.message)}”` : ''}` }));
    return items.sort((a, b) => new Date(b.at) - new Date(a.at));
  }
  function unseenCount() {
    const seen = new Date(state.me.last_seen_inbox);
    return inboxItems().filter((i) => new Date(i.at) > seen).length;
  }
  function inboxSheet() {
    const seen = new Date(state.inboxSeenBefore || state.me.last_seen_inbox);
    const items = inboxItems().slice(0, 50);
    return `<div class="scrim" data-action="close-sheet"><div class="sheet" data-stop>
      <div class="sheet-head"><h2>Inbox</h2><button class="x-btn" data-action="close-sheet" aria-label="Close">✕</button></div>
      ${items.length ? `<div>${items.map((i) => `<div class="inbox-item ${new Date(i.at) > seen ? 'new' : ''}">${av(i.from, 'sm')}
        <div class="who-text"><div><span class="name">${esc(person(i.from).display_name)}</span> ${i.text}</div>
        <div class="sub">${timeAgo(i.at)}</div></div></div>`).join('')}</div>`
        : `<div class="empty">Votes, cheers, nudges and points from friends land here.</div>`}
    </div></div>`;
  }

  // ---------- celebration ----------

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const c = document.getElementById('confetti');
    const ctx = c.getContext('2d');
    c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const colors = [state.me.color, '#f5b400', '#3355ff', '#ff4f7b', '#12a67a'];
    const bits = Array.from({ length: 90 }, () => ({
      x: innerWidth / 2, y: innerHeight * 0.55,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
      r: Math.random() * 6 + 4, rot: Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    let frame = 0;
    (function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      bits.forEach((b) => {
        b.vy += 0.45; b.x += b.vx; b.y += b.vy; b.rot += 0.2;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
        ctx.fillStyle = b.c; ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); ctx.restore();
      });
      if (++frame < 90) requestAnimationFrame(tick); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })();
  }

  // ---------- actions ----------

  const actions = {
    'auth-mode'() { state.authMode = state.authMode === 'signin' ? 'signup' : 'signin'; render(); },
    tab(el) { location.hash = el.dataset.tab; },

    'open-inbox'() {
      state.inboxSeenBefore = state.me.last_seen_inbox;
      state.sheet = 'inbox';
      const now = new Date().toISOString();
      state.me.last_seen_inbox = now;
      render();
      sb.from('profiles').update({ last_seen_inbox: now }).eq('id', state.me.id).then(({ error }) => error && fail(error));
    },
    'open-profile'() {
      state.draftProfile = { display_name: state.me.display_name, emoji: state.me.emoji, color: state.me.color };
      state.sheet = 'profile'; render();
    },
    'close-sheet'() { state.sheet = null; state.inboxSeenBefore = null; render(); },
    'pick-emoji'(el) { syncDraftName(); state.draftProfile.emoji = el.dataset.emoji; render(); },
    'pick-color'(el) { syncDraftName(); state.draftProfile.color = el.dataset.color; render(); },
    async 'sign-out'() { await sb.auth.signOut(); },

    'ask-delete'(el) { state.confirmDelete = el.dataset.id; render(); },
    async 'delete-task'(el) {
      state.confirmDelete = null;
      const { error } = await sb.from('tasks').delete().eq('id', el.dataset.id);
      if (error) return fail(error);
      toast('Task deleted'); loadAll();
    },
    async 'delete-goal'(el) {
      state.confirmDelete = null;
      const { error } = await sb.from('goals').delete().eq('id', el.dataset.id);
      if (error) return fail(error);
      toast('Goal deleted. Its tasks are still on your list.'); loadAll();
    },

    async 'toggle-task'(el) {
      const t = state.tasks.find((x) => x.id === el.dataset.id);
      if (!t) return;
      const status = t.status === 'done' ? 'todo' : 'done';
      t.status = status; t.completed_at = status === 'done' ? new Date().toISOString() : null;
      render();
      if (status === 'done') { confetti(); toast('Done. +1 point, now let the crew rate it.'); }
      const { error } = await sb.from('tasks').update({ status }).eq('id', t.id);
      if (error) fail(error);
      loadAll();
    },
    async 'toggle-goal'(el) {
      const g = goalOf(el.dataset.id);
      const { error } = await sb.from('goals').update({ done: !g.done }).eq('id', g.id);
      if (error) return fail(error);
      if (!g.done) { confetti(); toast('Goal complete. Massive.'); }
      loadAll();
    },

    async vote(el) {
      const task_id = el.dataset.id;
      const points = Number(el.dataset.points);
      const existing = state.votes.find((v) => v.task_id === task_id && isMe(v.voter_id));
      let error;
      if (existing && existing.points === points) {
        ({ error } = await sb.from('task_votes').delete().eq('task_id', task_id).eq('voter_id', state.me.id));
      } else {
        ({ error } = await sb.from('task_votes').upsert({ task_id, voter_id: state.me.id, points }));
      }
      if (error) return fail(error);
      loadAll();
    },
    async cheer(el) {
      const task_id = el.dataset.id, emoji = el.dataset.emoji;
      const mine = state.reactions.find((r) => r.task_id === task_id && r.kind === 'cheer' && r.emoji === emoji && isMe(r.from_id));
      const { error } = mine
        ? await sb.from('reactions').delete().eq('id', mine.id)
        : await sb.from('reactions').insert({ task_id, kind: 'cheer', emoji });
      if (error) return fail(error);
      loadAll();
    },
    async nudge(el) {
      const { error } = await sb.from('reactions').insert({ task_id: el.dataset.id, kind: 'nudge', emoji: '👉' });
      if (error) return fail(error);
      toast('Nudge sent'); loadAll();
    },
    'toggle-donate'(el) { state.openDonate = state.openDonate === el.dataset.key ? null : el.dataset.key; render(); },

    'board-mode'(el) { state.boardMode = el.dataset.mode; render(); },
    'cal-day'(el) { state.calDay = el.dataset.day; render(); },
    'cal-filter'(el) { state.calFilter = el.dataset.who; render(); },
    'cal-move'(el) {
      const m = state.calMonth;
      state.calMonth = new Date(m.getFullYear(), m.getMonth() + Number(el.dataset.dir), 1);
      render();
    },
    'cal-today'() { state.calMonth = startOfMonth(new Date()); state.calDay = todayStr(); render(); },
  };

  function syncDraftName() {
    const el = document.getElementById('pf-name');
    if (el) state.draftProfile.display_name = el.value;
  }

  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    // Clicks inside a sheet shouldn't hit the scrim's close action.
    if (el.classList.contains('scrim') && e.target.closest('[data-stop]')) return;
    if (el.dataset.action !== 'ask-delete' && el.dataset.action !== 'delete-task' && el.dataset.action !== 'delete-goal') state.confirmDelete = null;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

  app.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      if (f.id === 'auth-form') await submitAuth();
      else if (f.id === 'profile-form') await submitProfile();
      else if (f.id === 'task-form') await submitTask(f);
      else if (f.id === 'goal-form') await submitGoal(f);
      else if (f.classList.contains('mini-add')) await submitGoalStep(f);
      else if (f.classList.contains('donate-box')) await submitDonate(f);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });

  async function submitAuth() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-pass').value;
    if (state.authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return fail(error);
      if (!data.session) toast('Check your email to confirm, then sign in.');
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return fail(error.message === 'Invalid login credentials' ? { message: 'Wrong email or password.' } : error);
    }
  }

  async function submitProfile() {
    syncDraftName();
    const d = state.draftProfile;
    const name = d.display_name.trim();
    if (!name) return toast('Add a name first', true);
    const { error } = await sb.from('profiles').update({ display_name: name, emoji: d.emoji, color: d.color, onboarded: true }).eq('id', state.me.id);
    if (error) return fail(error);
    state.sheet = null; state.draftProfile = null;
    toast('Saved'); loadAll();
  }

  async function submitTask(f) {
    const title = document.getElementById('t-title').value.trim();
    if (!title) return;
    const row = {
      title,
      due_date: document.getElementById('t-due').value || null,
      goal_id: document.getElementById('t-goal').value || null,
      notes: document.getElementById('t-notes').value.trim() || null,
    };
    const { error } = await sb.from('tasks').insert(row);
    if (error) return fail(error);
    f.reset(); f.querySelector('details').open = false;
    toast('Task added'); loadAll();
  }

  async function submitGoal(f) {
    const title = document.getElementById('g-title').value.trim();
    if (!title) return;
    const { error } = await sb.from('goals').insert({ title, target_date: document.getElementById('g-date').value || null });
    if (error) return fail(error);
    f.reset(); toast('Goal added. Now break it into steps.'); loadAll();
  }

  async function submitGoalStep(f) {
    const input = f.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    const { error } = await sb.from('tasks').insert({ title, goal_id: f.dataset.goal });
    if (error) return fail(error);
    input.value = ''; loadAll();
  }

  async function submitDonate(f) {
    const key = state.openDonate;
    const amount = Number(document.getElementById(`don-amt-${key}`).value);
    const message = document.getElementById(`don-msg-${key}`).value;
    const { error } = await sb.rpc('donate_points', {
      p_to: f.dataset.donateTo, p_amount: amount, p_task: f.dataset.task || null, p_message: message || null,
    });
    if (error) return fail(error);
    state.openDonate = null;
    toast(`Gave ${amount} point${amount > 1 ? 's' : ''}`); loadAll();
  }

  // ---------- routing + auth ----------

  function readHash() {
    const h = location.hash.slice(1);
    state.tab = TABS.some((t) => t.id === h) ? h : 'me';
    state.openDonate = null;
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', readHash);

  sb.auth.onAuthStateChange((_event, session) => {
    const was = state.session && state.session.user.id;
    state.session = session;
    if (!session) {
      state.loaded = false; state.me = null; state.sheet = null;
      if (channel) { sb.removeChannel(channel); channel = null; }
      render();
    } else if (was !== session.user.id) {
      state.loaded = false;
      render();
      // Run outside the auth callback so supabase-js isn't blocked.
      setTimeout(() => { loadAll(); subscribe(); }, 0);
    }
  });

  readHash();
})();
