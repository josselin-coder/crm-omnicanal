create table public.assistant_states (
    conversation_id uuid primary key references public.inbox_conversations(id) on delete restrict,
    mode text not null check (mode in ('observe', 'handoff', 'human', 'off')),
    revision bigint not null default 0,
    resolved_revision bigint not null default -1,
    claim uuid,
    claimed_at timestamptz,
    controlled_by bigint references public.sales(id) on delete set null,
    updated_at timestamptz not null default now()
);

create table public.assistant_decisions (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid references public.inbox_conversations(id) on delete restrict,
    actor_id bigint references public.sales(id) on delete set null,
    revision bigint,
    mode text not null check (mode in ('simulation', 'observe')),
    action text not null check (action in (
        'greet_morning', 'greet_afternoon', 'greet_evening', 'ask_service',
        'ask_dxf', 'ask_3d_file', 'ask_cnc_file', 'ask_reference', 'ask_quantity',
        'acknowledge', 'handoff', 'stopped'
    )),
    classification text not null check (classification in (
        'nuevo', 'interesado', 'indeciso', 'listo_para_ventas', 'descartado'
    )),
    reason text not null check (reason in (
        'next_question', 'waiting', 'price_request', 'human_request',
        'purchase_intent', 'history_limit', 'human_control', 'declined'
    )),
    engine text not null check (engine in ('rules', 'model', 'rules_fallback')),
    facts jsonb not null check (jsonb_typeof(facts) = 'object'),
    created_at timestamptz not null default now(),
    constraint assistant_decision_scope check (
        (mode = 'simulation' and conversation_id is null and revision is null)
        or (mode = 'observe' and conversation_id is not null and revision is not null)
    ),
    unique (conversation_id, revision)
);
create index assistant_decisions_conversation_created_idx
on public.assistant_decisions (conversation_id, created_at desc);

alter table public.assistant_states enable row level security;
alter table public.assistant_decisions enable row level security;
revoke all on public.assistant_states, public.assistant_decisions from public, anon, authenticated;
grant select on public.assistant_states, public.assistant_decisions to authenticated;
grant select, insert, update on public.assistant_states to service_role;
grant select, insert on public.assistant_decisions to service_role;

create policy assistant_state_read on public.assistant_states for select to authenticated
using (exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.id = assistant_states.conversation_id
));

create policy assistant_decisions_read on public.assistant_decisions for select to authenticated
using (
    (mode = 'simulation' and public.crm_can_manage_record(actor_id))
    or (mode = 'observe' and exists (
        select 1 from public.inbox_conversations as conversation
        where conversation.id = assistant_decisions.conversation_id
    ))
);

alter publication supabase_realtime add table public.assistant_states, public.assistant_decisions;

create function public.control_inbox_assistant(actor_user uuid, target uuid, command text)
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
    if actor.id is null or conversation.id is null or conversation.whatsapp_phone_id is null
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
    elsif command = 'disable' and current_mode = 'observe' then
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

create function public.invalidate_assistant_on_message()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
    if new.direction = 'incoming' and new.provider_message_id is not null then
        perform 1 from public.inbox_conversations where id = new.conversation_id for update;
        update public.assistant_states set revision = revision + 1, claim = null
        where conversation_id = new.conversation_id and mode = 'observe';
    elsif new.direction = 'outgoing' and new.send_status = 'pending' and new.sent_by is not null then
        perform 1 from public.inbox_conversations where id = new.conversation_id for update;
        insert into public.assistant_states (conversation_id, mode, controlled_by)
        values (new.conversation_id, 'human', new.sent_by)
        on conflict (conversation_id) do update
        set mode = 'human', controlled_by = excluded.controlled_by, claim = null,
            revision = assistant_states.revision + 1, updated_at = now();
    end if;
    return new;
end;
$$;

create trigger assistant_on_inbox_message after insert on public.inbox_messages
for each row execute function public.invalidate_assistant_on_message();

create function public.claim_assistant_observation(target uuid)
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
    if state.mode is distinct from 'observe' or state.resolved_revision = state.revision
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
                jsonb_build_object('name', attachment_name, 'kind', message_kind) end
        ) order by sent_at, id) into transcript
        from public.inbox_messages where conversation_id = target;
    end if;

    token := gen_random_uuid();
    update public.assistant_states set claim = token, claimed_at = now() where conversation_id = target;
    return jsonb_build_object('token', token, 'revision', state.revision, 'transcript', transcript);
end;
$$;

create function public.finish_assistant_observation(target uuid, token uuid, expected_revision bigint, decision jsonb)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
    state public.assistant_states%rowtype;
    conversation public.inbox_conversations%rowtype;
    next_seller bigint;
begin
    select * into conversation from public.inbox_conversations where id = target for update;
    select * into state from public.assistant_states where conversation_id = target for update;
    if state.mode is distinct from 'observe' or state.claim is distinct from token
        or state.revision is distinct from expected_revision
        or state.resolved_revision = expected_revision
        or not exists (
            select 1 from public.contacts where id = conversation.contact_id and archived_at is null
        ) then
        return false;
    end if;

    insert into public.assistant_decisions
        (conversation_id, revision, mode, action, classification, reason, engine, facts)
    values (target, expected_revision, 'observe', decision->>'action', decision->>'classification',
        decision->>'reason', decision->>'engine', decision->'facts');

    update public.inbox_customers set classification = decision->>'classification'
    where contact_id = conversation.contact_id and classification <> 'comprado';

    if decision->>'action' = 'handoff' and not exists (
        select 1 from public.sales where id = conversation.assigned_sales_id and not disabled
    ) then
        select sales.id into next_seller
        from public.sales as sales
        where not sales.disabled and not sales.administrator
        order by (
            select count(*) from public.inbox_conversations as assigned
            join public.contacts as contact on contact.id = assigned.contact_id
            where assigned.assigned_sales_id = sales.id and contact.archived_at is null
        ), sales.id
        limit 1;

        if next_seller is not null then
            update public.inbox_conversations set assigned_sales_id = next_seller where id = target;
        end if;
    end if;

    update public.assistant_states
    set resolved_revision = expected_revision, claim = null,
        mode = case when decision->>'action' = 'handoff' then 'handoff' else 'observe' end,
        updated_at = now()
    where conversation_id = target;
    return true;
end;
$$;

revoke all on function public.control_inbox_assistant(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_assistant_observation(uuid) from public, anon, authenticated;
revoke all on function public.finish_assistant_observation(uuid, uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.invalidate_assistant_on_message() from public, anon, authenticated;
grant execute on function public.control_inbox_assistant(uuid, uuid, text) to service_role;
grant execute on function public.claim_assistant_observation(uuid) to service_role;
grant execute on function public.finish_assistant_observation(uuid, uuid, bigint, jsonb) to service_role;
