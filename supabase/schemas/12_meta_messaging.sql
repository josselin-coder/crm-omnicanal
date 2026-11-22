alter table public.inbox_conversations
    add column meta_account_id text,
    add column meta_sender_id text,
    add column meta_media_updated_at timestamptz,
    add constraint inbox_meta_identity check (
        (meta_account_id is null and meta_sender_id is null)
        or (channel in ('instagram', 'messenger')
            and coalesce(meta_account_id, '') ~ '^[0-9]{1,32}$'
            and coalesce(meta_sender_id, '') ~ '^[0-9]{1,32}$')
    ),
    add constraint inbox_meta_thread_unique unique (channel, meta_account_id, meta_sender_id);

create table public.meta_message_attachments (
    id uuid primary key default gen_random_uuid(),
    message_id uuid not null references public.inbox_messages(id) on delete restrict,
    position smallint not null,
    name text not null,
    kind text not null,
    mime text,
    state text not null default 'pending' check (state in ('pending', 'ready', 'unavailable')),
    storage_path text,
    source_url text,
    attempts smallint not null default 0,
    claim uuid,
    claim_until timestamptz,
    unique (message_id, position)
);

create table public.meta_transport_errors (
    id bigint generated always as identity primary key,
    created_at timestamptz not null default now(),
    channel text not null check (channel in ('instagram', 'messenger')),
    stage text not null check (stage in ('webhook', 'attachment', 'send', 'receipt')),
    code text not null check (code ~ '^[a-z0-9_]{1,48}$'),
    conversation_id uuid references public.inbox_conversations(id) on delete set null,
    attempt smallint
);

alter table public.meta_message_attachments enable row level security;
alter table public.meta_transport_errors enable row level security;
revoke all on public.meta_message_attachments, public.meta_transport_errors from public, anon, authenticated;
grant select (id, message_id, position, name, kind, mime, state) on public.meta_message_attachments to authenticated;
grant select, insert, update on public.meta_message_attachments to service_role;
grant select, insert on public.meta_transport_errors to service_role;

create policy meta_media_read on public.meta_message_attachments for select to authenticated
using (exists (
    select 1 from public.inbox_messages as message where message.id = meta_message_attachments.message_id
));

insert into storage.buckets (id, name, public, file_size_limit)
values ('meta-messaging-media', 'meta-messaging-media', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create function public.receive_meta_message(
    p_channel text, account text, sender text, external_id text, received_at timestamptz,
    body_text text, attachments jsonb
)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
    thread_id uuid;
    customer_id bigint;
    internal_id uuid;
    provider_id text := p_channel || ':' || account || ':' || external_id;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_channel || ':' || account || ':' || sender, 0));
    select id, conversation_id into internal_id, thread_id
    from public.inbox_messages where provider_message_id = provider_id;
    if internal_id is not null then
        if not exists (
            select 1 from public.inbox_conversations
            where id = thread_id and channel = p_channel and meta_account_id = account and meta_sender_id = sender
        ) then
            raise exception 'Provider message belongs to another conversation';
        end if;
        return jsonb_build_object('id', internal_id, 'conversation_id', thread_id);
    end if;

    select id, contact_id into thread_id, customer_id from public.inbox_conversations
    where channel = p_channel and meta_account_id = account and meta_sender_id = sender
    for update;
    if thread_id is null then
        insert into public.contacts (first_name, first_seen, last_seen, tags)
        values (case p_channel when 'instagram' then 'Cliente de Instagram' else 'Cliente de Messenger' end,
            received_at, received_at, '{}')
        returning id into customer_id;
        insert into public.inbox_customers (contact_id) values (customer_id);
        insert into public.inbox_conversations
            (contact_id, channel, meta_account_id, meta_sender_id, last_message_at, last_inbound_at)
        values (customer_id, p_channel, account, sender, received_at, received_at)
        returning id into thread_id;
    end if;

    insert into public.inbox_messages (conversation_id, direction, provider_message_id, sent_at, body)
    values (thread_id, 'incoming', provider_id, received_at, body_text)
    returning id into internal_id;

    insert into public.meta_message_attachments (message_id, position, name, kind, source_url, state)
    select internal_id, item.ordinality, item.value->>'name', item.value->>'kind', item.value->>'url',
        case when item.value->>'url' is null then 'unavailable' else 'pending' end
    from jsonb_array_elements(attachments) with ordinality as item(value, ordinality);

    update public.inbox_conversations set last_inbound_at = greatest(last_inbound_at, received_at),
        last_message_at = greatest(last_message_at, received_at)
    where id = thread_id;
    update public.contacts set last_seen = greatest(last_seen, received_at) where id = customer_id;

    return jsonb_build_object('id', internal_id, 'conversation_id', thread_id);
end;
$$;

create function public.claim_meta_media(target uuid)
returns table (id uuid, source_url text, claim uuid, attempts smallint)
language sql security invoker set search_path = ''
as $$
    update public.meta_message_attachments as item
    set claim = gen_random_uuid(), claim_until = clock_timestamp() + interval '30 seconds',
        attempts = item.attempts + 1
    where item.id in (
        select queued.id from public.meta_message_attachments as queued
        where queued.message_id = target and queued.state = 'pending'
          and (queued.claim_until is null or queued.claim_until < clock_timestamp())
          and queued.attempts < 5
        order by queued.position
        for update skip locked
    )
    returning item.id, item.source_url, item.claim, item.attempts;
$$;

create function public.finish_meta_media(
    target uuid, token uuid, next_state text, saved_path text, saved_mime text, saved_name text, failure text
)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
    thread_id uuid;
    p_channel text;
    used_attempt smallint;
begin
    select thread.id, thread.channel into thread_id, p_channel
    from public.meta_message_attachments as item
    join public.inbox_messages as message on message.id = item.message_id
    join public.inbox_conversations as thread on thread.id = message.conversation_id
    where item.id = target for update of thread;

    update public.meta_message_attachments as item
    set state = case when next_state = 'pending' and item.attempts >= 5 then 'unavailable' else next_state end,
        source_url = case when next_state = 'pending' and item.attempts < 5 then item.source_url end,
        storage_path = saved_path, mime = saved_mime, name = coalesce(saved_name, item.name),
        claim = null, claim_until = null
    where item.id = target and item.claim = token and item.state = 'pending'
    returning item.attempts into used_attempt;
    if not found then return; end if;

    if failure is not null then
        insert into public.meta_transport_errors (channel, stage, code, conversation_id, attempt)
        values (p_channel, 'attachment', failure, thread_id, used_attempt);
    end if;
    update public.inbox_conversations set meta_media_updated_at = now() where id = thread_id;
    if next_state = 'ready' then
        update public.assistant_states set revision = revision + 1, claim = null
        where conversation_id = thread_id and mode in ('observe', 'handoff');
    end if;
end;
$$;

create function public.reserve_meta_send(
    actor_user uuid, thread_id uuid, request_id uuid, p_channel text, account text, body_text text
)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
    thread public.inbox_conversations%rowtype;
    actor public.sales%rowtype;
    existing public.inbox_messages%rowtype;
begin
    select * into actor from public.sales where user_id = actor_user and not disabled;
    select * into thread from public.inbox_conversations where id = thread_id for update;
    if actor.id is null or thread.id is null
        or not (actor.administrator or thread.assigned_sales_id is not distinct from actor.id)
        or thread.channel is distinct from p_channel or thread.meta_account_id is distinct from account then
        return jsonb_build_object('error', 'forbidden');
    end if;

    select * into existing from public.inbox_messages where id = request_id;
    if existing.id is not null then
        if existing.conversation_id <> thread_id or existing.direction <> 'outgoing'
            or existing.sent_by is distinct from actor.id or existing.body <> body_text then
            return jsonb_build_object('error', 'conflict');
        end if;
        return jsonb_build_object('status', existing.send_status, 'claimed', false);
    end if;

    if exists (select 1 from public.contacts where id = thread.contact_id and archived_at is not null) then
        return jsonb_build_object('error', 'archived');
    end if;
    if thread.last_inbound_at is null or thread.last_inbound_at <= now() - interval '24 hours' then
        return jsonb_build_object('error', 'window_closed');
    end if;
    if body_text is null or length(trim(body_text)) = 0 or length(body_text) > 1000 then
        return jsonb_build_object('error', 'invalid_message');
    end if;

    insert into public.inbox_messages (id, conversation_id, direction, body, send_status, sent_by)
    values (request_id, thread_id, 'outgoing', body_text, 'pending', actor.id)
    on conflict (id) do nothing;
    if not found then return jsonb_build_object('error', 'conflict'); end if;
    update public.inbox_conversations set last_message_at = greatest(last_message_at, now()) where id = thread_id;
    return jsonb_build_object('status', 'pending', 'claimed', true, 'recipient', thread.meta_sender_id);
end;
$$;

create function public.update_meta_delivery(
    p_channel text, account text, peer text, request_id uuid,
    provider_ids text[], through_at timestamptz, next_status text
)
returns void
language sql security invoker set search_path = ''
as $$
    update public.inbox_messages as message
    set provider_message_id = case when request_id is not null and cardinality(provider_ids) = 1
        then coalesce(message.provider_message_id, provider_ids[1]) else message.provider_message_id end,
        send_status = case
            when message.send_status = 'read' or next_status = 'read' then 'read'
            when message.send_status = 'delivered' or next_status = 'delivered' then 'delivered'
            when message.send_status = 'sent' or next_status = 'sent' then 'sent'
            when message.send_status = 'accepted' or next_status = 'accepted' then 'accepted'
            when message.send_status = 'failed' or next_status = 'failed' then 'failed'
            else next_status end
    from public.inbox_conversations as thread
    where message.conversation_id = thread.id and message.direction = 'outgoing'
      and thread.channel = p_channel and thread.meta_account_id = account and thread.meta_sender_id = peer
      and (
        (request_id = message.id and (message.provider_message_id is null or provider_ids is null
            or message.provider_message_id = any(provider_ids)))
        or (request_id is null and (message.provider_message_id = any(provider_ids)
            or (through_at is not null and message.sent_at <= through_at and message.provider_message_id is not null)))
      )
      and next_status in ('accepted', 'sent', 'delivered', 'read', 'failed', 'unknown');
$$;

revoke all on function public.receive_meta_message(text,text,text,text,timestamptz,text,jsonb),
    public.claim_meta_media(uuid), public.finish_meta_media(uuid,uuid,text,text,text,text,text),
    public.reserve_meta_send(uuid,uuid,uuid,text,text,text),
    public.update_meta_delivery(text,text,text,uuid,text[],timestamptz,text)
    from public, anon, authenticated;
grant execute on function public.receive_meta_message(text,text,text,text,timestamptz,text,jsonb),
    public.claim_meta_media(uuid), public.finish_meta_media(uuid,uuid,text,text,text,text,text),
    public.reserve_meta_send(uuid,uuid,uuid,text,text,text),
    public.update_meta_delivery(text,text,text,uuid,text[],timestamptz,text)
    to service_role;

create or replace function public.control_inbox_assistant(actor_user uuid, target uuid, command text)
returns text
language plpgsql security invoker set search_path = ''
as $$
declare
    actor public.sales%rowtype;
    conversation public.inbox_conversations%rowtype;
    current_mode text;
    next_mode text;
begin
    select * into actor from public.sales where user_id = actor_user and not disabled;
    select * into conversation from public.inbox_conversations where id = target for update;
    if actor.id is null or conversation.id is null or (conversation.whatsapp_phone_id is null and conversation.meta_account_id is null)
        or not (actor.administrator or conversation.assigned_sales_id is not distinct from actor.id) then
        return 'forbidden';
    end if;
    select mode into current_mode from public.assistant_states where conversation_id = target;
    current_mode := coalesce(current_mode, 'off');
    if command = 'take_control' then
        next_mode := 'human';
    elsif command = 'enable' and current_mode = 'off' then
        if exists (select 1 from public.contacts where id = conversation.contact_id and archived_at is not null) then
            return 'archived';
        end if;
        next_mode := 'observe';
    elsif command = 'disable' and current_mode in ('observe', 'handoff') then
        next_mode := 'off';
    else
        return current_mode;
    end if;
    insert into public.assistant_states (conversation_id, mode, controlled_by)
    values (target, next_mode, actor.id)
    on conflict (conversation_id) do update
    set mode = excluded.mode, controlled_by = excluded.controlled_by, claim = null,
        revision = assistant_states.revision + 1, updated_at = now();
    return next_mode;
end;
$$;

create or replace function public.claim_assistant_observation(target uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
    state public.assistant_states%rowtype;
    token uuid;
    message_count int;
    character_count int;
    transcript jsonb;
begin
    select * into state from public.assistant_states where conversation_id = target for update;
    if (state.mode is null or state.mode not in ('observe', 'handoff')) or state.resolved_revision = state.revision
      or (state.claim is not null and state.claimed_at > now() - interval '45 seconds')
      or not exists (
        select 1 from public.inbox_conversations as conversation
        join public.contacts as customer on customer.id = conversation.contact_id
        where conversation.id = target and customer.archived_at is null
      ) then
        return null;
    end if;

    select count(*), coalesce(sum(length(sample.body)), 0) into message_count, character_count
    from (select body from public.inbox_messages where conversation_id = target limit 201) as sample;

    if message_count = 0 then
        return null;
    end if;

    if message_count <= 200 and character_count <= 50000 then
        select jsonb_agg(jsonb_build_object(
            'role', case direction when 'incoming' then 'customer' else 'seller' end,
            'text', body,
            'attachment', case when attachment_path is not null then
                jsonb_build_object('name', attachment_name, 'kind', message_kind) end,
            'attachments', (
                select jsonb_agg(jsonb_build_object('name', media.name, 'kind', media.kind) order by media.position)
                from public.meta_message_attachments as media
                where media.message_id = message.id and media.state = 'ready'
            )
        ) order by sent_at, assistant_arrival) into transcript
        from public.inbox_messages as message where conversation_id = target;
    end if;

    token := gen_random_uuid();
    update public.assistant_states set claim = token, claimed_at = now() where conversation_id = target;
    return jsonb_build_object('token', token, 'revision', state.revision, 'mode', state.mode, 'transcript', transcript);
end;
$$;

