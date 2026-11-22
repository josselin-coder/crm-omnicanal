alter table public.inbox_conversations
    add column whatsapp_phone_id text,
    add column whatsapp_sender text,
    add column last_inbound_at timestamptz,
    add constraint inbox_whatsapp_identity check (
        (whatsapp_phone_id is null and whatsapp_sender is null)
        or (channel = 'whatsapp' and coalesce(whatsapp_phone_id, '') ~ '^[0-9]{1,32}$'
            and coalesce(whatsapp_sender, '') ~ '^[0-9]{1,32}$')
    ),
    add constraint inbox_whatsapp_conversation_unique unique (whatsapp_phone_id, whatsapp_sender);

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
    message_body text, kind text, media_path text, media_name text, media_mime text
)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
    thread_id uuid;
    customer_id bigint;
    inserted_id uuid;
begin
    -- Serializes first contact creation and concurrent deliveries for this identity.
    perform pg_advisory_xact_lock(hashtextextended(phone_id || ':' || sender, 0));
    if exists (select 1 from public.inbox_messages where provider_message_id = provider_id) then
        return false;
    end if;

    select id into thread_id
    from public.inbox_conversations
    where whatsapp_phone_id = phone_id and whatsapp_sender = sender;

    if thread_id is null then
        insert into public.contacts (first_name, phone_jsonb, tags, first_seen, last_seen)
        values (
            coalesce(nullif(left(trim(sender_name), 160), ''), '+' || sender),
            jsonb_build_array(jsonb_build_object('number', '+' || sender, 'type', 'Other')),
            '{}', received_at, received_at
        )
        returning id into customer_id;

        insert into public.inbox_customers (contact_id) values (customer_id);
        insert into public.inbox_conversations
            (contact_id, channel, whatsapp_phone_id, whatsapp_sender, last_message_at, last_inbound_at)
        values (customer_id, 'whatsapp', phone_id, sender, received_at, received_at)
        returning id into thread_id;
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
    set last_seen = greatest(contact.last_seen, received_at)
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
        or thread.whatsapp_sender is null or thread.whatsapp_phone_id <> phone_id then
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
    return jsonb_build_object('status', 'pending', 'claimed', true, 'recipient', thread.whatsapp_sender);
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

revoke all on function public.receive_whatsapp_message(text, text, text, text, timestamptz, text, text, text, text, text)
    from public, anon, authenticated;
revoke all on function public.reserve_whatsapp_send(uuid, uuid, uuid, text, text)
    from public, anon, authenticated;
revoke all on function public.update_whatsapp_send(text, uuid, text, text)
    from public, anon, authenticated;
grant execute on function public.receive_whatsapp_message(text, text, text, text, timestamptz, text, text, text, text, text)
    to service_role;
grant execute on function public.reserve_whatsapp_send(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.update_whatsapp_send(text, uuid, text, text) to service_role;
