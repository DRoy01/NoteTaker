# Synced To-Do

A small to-do PWA for PC and iPhone, synced in real time through Supabase. See `PLAN.md` for the full spec.

## Try it locally
```
python -m http.server 8080
```
Open http://localhost:8080. While `config.js` still has the `YOUR-` placeholders, the app runs local-only (no sign-in, no sync).

## Turn on sync
1. Create a Supabase project. Put its URL and anon key in `config.js`.
2. In Authentication, turn off "Allow new users to sign up" and add yourself as a user (auto confirm).
3. Run `supabase/schema.sql` in the SQL editor.

## Deploy
Push to a public GitHub repo, then enable Settings → Pages → main / root. Bump `CACHE` in `sw.js` on every deploy.

## Install
- iPhone: open in Safari → Share → Add to Home Screen, then sign in inside the installed app.
- PC: Chrome/Edge → install icon in the address bar.
