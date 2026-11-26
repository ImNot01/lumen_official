-- Run in Supabase Dashboard -> SQL Editor for the same project as this app.
-- Safe to run again if the table or function already exists.

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2048
     or p_p256dh is null or char_length(p_p256dh) > 256
     or p_auth is null or char_length(p_auth) > 256 then
    raise exception 'Invalid push subscription';
  end if;

  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        created_at = now();
end
$$;

revoke all on function public.register_push_subscription(text, text, text)
  from public, anon;
grant execute on function public.register_push_subscription(text, text, text)
  to authenticated;

notify pgrst, 'reload schema';
