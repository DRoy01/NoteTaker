import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const COLS = 'id,title,notes,done,created_at,updated_at,completed_at,position,grp,color,deadline';

export async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  return { error };
}

export async function signOut() {
  await sb.auth.signOut();
}

export function onAuthChange(cb) {
  return sb.auth.onAuthStateChange((event, session) => cb(event, session));
}

export async function fetchAll() {
  const { data, error } = await sb.from('tasks').select(COLS);
  if (error) throw error;
  return data;
}

export async function upsertTask(task) {
  const { error } = await sb.from('tasks').upsert(task);
  if (error) throw error;
}

export async function deleteTask(id) {
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) throw error;
}

export function subscribe(userId, onChange, onStatus) {
  const ch = sb.channel('tasks-' + userId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` },
      p => onChange(p.eventType, p.new, p.old))
    .subscribe(status => onStatus(status));
  return () => sb.removeChannel(ch);
}
