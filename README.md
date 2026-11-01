# Voluntary Slavery

A little website for a group of friends to track tasks and goals and push each other.

- Add your own tasks with a due date, or group them under a bigger goal.
- Finish a task and you get 1 point. Friends then vote 1-5 on what it was really worth, and your score becomes their average.
- Give some of your own points to a friend when they smash something.
- Leaderboard (this week + all time), streaks, cheers, and nudges for overdue tasks.
- Shared calendar with everyone's due dates, one colour per person.

Costs $0: plain HTML/CSS/JS, Supabase free tier for data and logins, GitHub Pages for hosting.

## Setup (once, about 15 minutes)

### 1. Supabase
1. Go to supabase.com, sign in, **New project** (free plan). Any name, pick a region close to the crew, save the database password somewhere.
2. Open **SQL Editor > New query**, paste all of `supabase/schema.sql`, click **Run**. It should say "Success". Then do the same with `supabase/002_pipeline_goals.sql` (pipelines, measurable goals, "working on" line).
3. **Authentication > Sign In / Providers > Email**: turn **off** "Confirm email". (Supabase's free email sender only sends a few emails an hour, so we skip emails completely.)
4. **Project Settings > API Keys**: copy the **Project URL** and the **anon public** key into `.env` (copy `.env.example` if it doesn't exist), then run `node scripts/make-config.mjs` to write them into `config.js`. `.env` is git-ignored, so keys there never reach GitHub.

Free plan notes:
- Free projects pause after about a week with nobody using them. If the site stops loading, open the Supabase dashboard and click **Restore**.
- You get 2 free active projects per account.

### 2. Try it locally
```
python -m http.server 8000
```
Open http://localhost:8000, create an account, set up your profile.

### 3. Put it online (GitHub Pages)
1. Create a new GitHub repo (e.g. `crew-goals`), push this folder to it.
2. Repo **Settings > Pages**: Source = "Deploy from a branch", branch = `main`, folder = `/ (root)`. Save.
3. After a minute the site is live at `https://<your-username>.github.io/crew-goals/`.
4. Back in Supabase, **Authentication > URL Configuration**: set Site URL to that address.

### 4. Lock it down
Once all your friends have made accounts, go to **Authentication > Sign In / Providers** and turn off **"Allow new users to sign up"**. Now nobody else can join. Turn it back on if someone new wants in.

## For friends: how to join
1. Open the link.
2. Tap **Create an account**, use any email + a password (6+ characters).
3. Pick a name, emoji, and colour. Done.
4. On your phone, use "Add to Home Screen" so it opens like an app.

## How points work
| What happens | Points |
|---|---|
| You finish a task | 1 (the only point you can give yourself) |
| Friends vote on it | Task becomes the rounded average of their votes (1-5) |
| A friend gives you points | + what they gave (it comes off their total) |
| You give a friend points | − what you gave |

Rules enforced by the database (not just the page): you can't vote on your own task, can't vote outside 1-5, can't give away more points than you have, and can't edit anyone else's stuff. Finish times are stamped by the server, so streaks can't be faked by backdating.

## Files
- `index.html` page shell
- `styles.css` look and feel (light + dark mode)
- `app.js` everything the app does
- `config.js` your Supabase URL + anon key (safe to be public)
- `supabase/schema.sql` tables, scoring, and security rules
