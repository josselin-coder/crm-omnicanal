create table public.inbox_customers (
    contact_id bigint primary key references public.contacts(id) on delete restrict,
    classification text not null default 'nuevo'
        check (classification in ('nuevo', 'interesado', 'indeciso', 'listo_para_ventas', 'comprado', 'descartado')),
    archived_at timestamptz
);

create table public.inbox_conversations (
    id uuid primary key default gen_random_uuid(),
    contact_id bigint not null references public.inbox_customers(contact_id) on delete restrict,
    channel text not null check (channel in ('whatsapp', 'instagram', 'messenger')),
    assigned_sales_id bigint references public.sales(id) on delete set null,
    last_message_at timestamptz not null default now()
);

create table public.inbox_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.inbox_conversations(id) on delete restrict,
    direction text not null check (direction in ('incoming', 'outgoing')),
    body text not null check (length(trim(body)) > 0),
    sent_at timestamptz not null default now()
);

create index inbox_conversations_contact_idx on public.inbox_conversations (contact_id);
create index inbox_conversations_assignee_idx on public.inbox_conversations (assigned_sales_id);
create index inbox_conversations_recent_idx on public.inbox_conversations (last_message_at desc, id desc);
create index inbox_messages_history_idx on public.inbox_messages (conversation_id, sent_at desc, id desc);

alter table public.inbox_customers enable row level security;
alter table public.inbox_conversations enable row level security;
alter table public.inbox_messages enable row level security;

revoke all on public.inbox_customers, public.inbox_conversations, public.inbox_messages from public, anon, authenticated;
grant select on public.inbox_customers, public.inbox_conversations, public.inbox_messages to authenticated;
grant update (classification, archived_at) on public.inbox_customers to authenticated;
grant update (assigned_sales_id) on public.inbox_conversations to authenticated;
grant select, insert, update on public.inbox_customers, public.inbox_conversations, public.inbox_messages to service_role;

create policy inbox_conversations_read on public.inbox_conversations for select to authenticated
using (exists (
    select 1 from public.sales as actor
    where actor.user_id = (select auth.uid()) and not actor.disabled
      and (actor.administrator or actor.id = assigned_sales_id)
));

create policy inbox_conversations_assign on public.inbox_conversations for update to authenticated
using (exists (
    select 1 from public.sales as actor
    where actor.user_id = (select auth.uid()) and not actor.disabled and actor.administrator
))
with check (
    exists (
        select 1 from public.sales as actor
        where actor.user_id = (select auth.uid()) and not actor.disabled and actor.administrator
    )
    and (assigned_sales_id is null or exists (
        select 1 from public.sales as seller
        where seller.id = assigned_sales_id and not seller.disabled
    ))
);

create policy inbox_customers_read on public.inbox_customers for select to authenticated
using (exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.contact_id = inbox_customers.contact_id
));

create policy inbox_customers_update on public.inbox_customers for update to authenticated
using (exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.contact_id = inbox_customers.contact_id
))
with check (exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.contact_id = inbox_customers.contact_id
));

create policy inbox_messages_read on public.inbox_messages for select to authenticated
using (exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.id = inbox_messages.conversation_id
));
