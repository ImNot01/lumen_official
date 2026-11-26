-- Run in Supabase Dashboard -> SQL Editor for the project configured in Lumen.
-- This creates the table required for 1:1 audio/video call signaling.

create table if not exists public.call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('offer', 'answer', 'candidate', 'hangup', 'decline', 'busy')),
  payload jsonb not null default '{}'::jsonb
    check (pg_column_size(payload) <= 32768),
  created_at timestamptz not null default now(),
  constraint call_signals_no_self_call check (sender_id <> recipient_id)
);

create index if not exists call_signals_recipient_created_idx
  on public.call_signals (recipient_id, created_at);

alter table public.call_signals enable row level security;
revoke all on public.call_signals from anon, authenticated;
grant select, insert, delete on public.call_signals to authenticated;

drop policy if exists call_signals_select_participants on public.call_signals;
create policy call_signals_select_participants on public.call_signals
  for select to authenticated using (
    (sender_id = auth.uid() or recipient_id = auth.uid())
    and public.is_member(conversation_id)
    and public.can_message(conversation_id)
    and exists (
      select 1
      from public.conversations c
      join public.conversation_members sender
        on sender.conversation_id = c.id and sender.user_id = call_signals.sender_id
      join public.conversation_members recipient
        on recipient.conversation_id = c.id and recipient.user_id = call_signals.recipient_id
      where c.id = call_signals.conversation_id and c.type = 'direct'
    )
  );

drop policy if exists call_signals_insert_sender on public.call_signals;
create policy call_signals_insert_sender on public.call_signals
  for insert to authenticated with check (
    sender_id = auth.uid()
    and recipient_id <> auth.uid()
    and public.is_member(conversation_id)
    and public.can_message(conversation_id)
    and exists (
      select 1
      from public.conversations c
      join public.conversation_members sender
        on sender.conversation_id = c.id and sender.user_id = auth.uid()
      join public.conversation_members recipient
        on recipient.conversation_id = c.id and recipient.user_id = call_signals.recipient_id
      where c.id = call_signals.conversation_id and c.type = 'direct'
    )
  );

drop policy if exists call_signals_delete_recipient on public.call_signals;
create policy call_signals_delete_recipient on public.call_signals
  for delete to authenticated using (recipient_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'call_signals'
  ) then
    alter publication supabase_realtime add table public.call_signals;
  end if;
end
$$;

notify pgrst, 'reload schema';
