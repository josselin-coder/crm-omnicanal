alter table public.inbox_conversations
    add column whatsapp_phone_id text,
    add column whatsapp_sender text,
    add column whatsapp_user_id text,
    add column last_inbound_at timestamptz,
    add constraint inbox_whatsapp_identity check (
        (whatsapp_phone_id is null and whatsapp_sender is null and whatsapp_user_id is null)
        or (channel = 'whatsapp' and coalesce(whatsapp_phone_id, '') ~ '^[0-9]{1,32}$'
            and (whatsapp_sender is not null or whatsapp_user_id is not null)
            and (whatsapp_sender is null or whatsapp_sender ~ '^[0-9]{1,32}$')
            and (whatsapp_user_id is null or whatsapp_user_id ~ '^[A-Z]{2}[.][A-Za-z0-9]{1,128}$'))
    ),
    add constraint inbox_whatsapp_conversation_unique unique (whatsapp_phone_id, whatsapp_sender),
    add constraint inbox_whatsapp_user_unique unique (whatsapp_phone_id, whatsapp_user_id);

alter table public.inbox_messages
    add column provider_message_id text unique,
    add column message_kind text not null default 'text'
        check (message_kind in ('text', 'image', 'document', 'audio', 'video', 'sticker', 'unsupported')),
    add column attachment_path text,
    add column attachment_name text,
    add column attachment_mime text,
    add column send_status text
        check (send_status in ('pending', 'accepted', 'sent', 'delivered', 'read', 'failed', 'unknown')),
    add column sent_by bigint references public.sales(id) on delete set null;

insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

alter publication supabase_realtime add table public.inbox_messages, public.inbox_conversations;

create function public.receive_whatsapp_message(
    phone_id text, sender text, sender_name text, provider_id text, received_at timestamptz,
    message_body text, kind text, media_path text, media_name text, media_mime text,
    sender_user_id text default null
)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
    thread_id uuid;
    customer_id bigint;
    inserted_id uuid;
    available_phone text;
begin
    -- Lookup can use either identity. Serialize the short DB transaction per business number.
    perform pg_advisory_xact_lock(hashtextextended('whatsapp:' || phone_id, 0));
    if exists (select 1 from public.inbox_messages where provider_message_id = provider_id) then
        return false;
    end if;

    select id into thread_id
    from public.inbox_conversations
    where whatsapp_phone_id = phone_id and whatsapp_user_id = sender_user_id;

    if thread_id is null then
        select id into thread_id from public.inbox_conversations
        where whatsapp_phone_id = phone_id and whatsapp_sender = sender
          and (whatsapp_user_id is null or sender_user_id is null);
    end if;

    available_phone := sender;
    if exists (
        select 1 from public.inbox_conversations
        where whatsapp_phone_id = phone_id and whatsapp_sender = sender
          and id is distinct from thread_id
    ) then
        available_phone := null;
    end if;

    if thread_id is null then
        insert into public.contacts (first_name, phone_jsonb, tags, first_seen, last_seen)
        values (
            coalesce(nullif(left(trim(sender_name), 160), ''), '+' || sender, 'Cliente de WhatsApp'),
            case when sender is null then '[]'::jsonb
                else jsonb_build_array(jsonb_build_object('number', '+' || sender, 'type', 'Other'))
            end,
            '{}', received_at, received_at
        )
        returning id into customer_id;

        insert into public.inbox_customers (contact_id) values (customer_id);
        insert into public.inbox_conversations
            (contact_id, channel, whatsapp_phone_id, whatsapp_sender, whatsapp_user_id, last_message_at, last_inbound_at)
        values (customer_id, 'whatsapp', phone_id, available_phone, sender_user_id, received_at, received_at)
        returning id into thread_id;
    elsif sender_user_id is not null and available_phone is not null then
        update public.inbox_conversations
        set whatsapp_user_id = sender_user_id, whatsapp_sender = available_phone
        where id = thread_id and (
            whatsapp_user_id is distinct from sender_user_id or whatsapp_sender is distinct from available_phone
        );
    end if;

    insert into public.inbox_messages
        (conversation_id, direction, provider_message_id, sent_at, body, message_kind,
         attachment_path, attachment_name, attachment_mime)
    values (thread_id, 'incoming', provider_id, received_at, message_body, kind, media_path, media_name, media_mime)
    returning id into inserted_id;

    update public.inbox_conversations
    set last_inbound_at = greatest(last_inbound_at, received_at),
        last_message_at = greatest(last_message_at, received_at)
    where id = thread_id;

    update public.contacts as contact
    set last_seen = greatest(contact.last_seen, received_at),
        phone_jsonb = case when sender is not null and coalesce(contact.phone_jsonb, '[]'::jsonb) = '[]'::jsonb
            then jsonb_build_array(jsonb_build_object('number', '+' || sender, 'type', 'Other'))
            else contact.phone_jsonb end
    from public.inbox_conversations as conversation
    where conversation.id = thread_id and contact.id = conversation.contact_id;

    return inserted_id is not null;
end;
$$;

create function public.reserve_whatsapp_send(
    actor_user uuid, thread_id uuid, request_id uuid, phone_id text, message_body text
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
    if actor.id is null or thread.id is null or
        not (actor.administrator or thread.assigned_sales_id is not distinct from actor.id)
        or thread.whatsapp_phone_id is distinct from phone_id then
        return jsonb_build_object('error', 'forbidden');
    end if;

    select * into existing from public.inbox_messages where id = request_id;
    if existing.id is not null then
        if existing.conversation_id <> thread_id or existing.direction <> 'outgoing'
            or existing.sent_by is distinct from actor.id or existing.body <> message_body then
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
    if message_body is null or length(trim(message_body)) = 0 or length(message_body) > 4096 then
        return jsonb_build_object('error', 'invalid_text');
    end if;

    insert into public.inbox_messages (id, conversation_id, direction, body, send_status, sent_by)
    values (request_id, thread_id, 'outgoing', message_body, 'pending', actor.id)
    on conflict (id) do nothing;
    if not found then
        return jsonb_build_object('error', 'conflict');
    end if;

    update public.inbox_conversations set last_message_at = greatest(last_message_at, now())
    where id = thread_id;
    return jsonb_build_object('status', 'pending', 'claimed', true, 'recipient', coalesce(thread.whatsapp_user_id, thread.whatsapp_sender));
end;
$$;

create function public.update_whatsapp_send(
    phone_id text, request_id uuid, provider_id text, next_status text
)
returns void
language sql security invoker set search_path = ''
as $$
    update public.inbox_messages as message
    set provider_message_id = coalesce(message.provider_message_id, provider_id),
        send_status = case
            when message.send_status = 'read' then 'read'
            when message.send_status = 'delivered' and next_status <> 'read' then 'delivered'
            when next_status in ('read', 'delivered') then next_status
            when next_status = 'failed' then 'failed'
            when message.send_status = 'failed' then 'failed'
            when next_status = 'sent' then 'sent'
            when message.send_status = 'sent' then 'sent'
            when next_status = 'accepted' then 'accepted'
            when message.send_status = 'accepted' then 'accepted'
            else next_status
        end
    from public.inbox_conversations as thread
    where message.conversation_id = thread.id and thread.whatsapp_phone_id = phone_id
      and message.direction = 'outgoing'
      and (message.id = request_id or message.provider_message_id = provider_id)
      and (message.provider_message_id is null or provider_id is null or message.provider_message_id = provider_id)
      and next_status in ('accepted', 'sent', 'delivered', 'read', 'failed', 'unknown');
$$;

revoke all on function public.receive_whatsapp_message(text, text, text, text, timestamptz, text, text, text, text, text, text)
    from public, anon, authenticated;
revoke all on function public.reserve_whatsapp_send(uuid, uuid, uuid, text, text)
    from public, anon, authenticated;
revoke all on function public.update_whatsapp_send(text, uuid, text, text)
    from public, anon, authenticated;
grant execute on function public.receive_whatsapp_message(text, text, text, text, timestamptz, text, text, text, text, text, text)
    to service_role;
grant execute on function public.reserve_whatsapp_send(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.update_whatsapp_send(text, uuid, text, text) to service_role;

create function public.rotate_whatsapp_identity(
    phone_id text, previous_user_id text, next_user_id text, next_phone text
)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('whatsapp:' || phone_id, 0));
    -- Never merge two existing identities implicitly.
    if exists (
        select 1 from public.inbox_conversations
        where whatsapp_phone_id = phone_id and whatsapp_user_id = next_user_id
    ) then
        return;
    end if;

    if exists (
        select 1 from public.inbox_conversations
        where whatsapp_phone_id = phone_id and whatsapp_sender = next_phone
          and whatsapp_user_id is distinct from previous_user_id
    ) then
        next_phone := null;
    end if;

    update public.inbox_conversations
    set whatsapp_user_id = next_user_id, whatsapp_sender = next_phone
    where whatsapp_phone_id = phone_id and whatsapp_user_id = previous_user_id;
end;
$$;
revoke all on function public.rotate_whatsapp_identity(text, text, text, text)
    from public, anon, authenticated;
grant execute on function public.rotate_whatsapp_identity(text, text, text, text) to service_role;
