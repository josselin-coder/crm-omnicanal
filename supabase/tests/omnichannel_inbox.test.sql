begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

insert into public.user_invitations (user_id) values
    ('90000000-0000-4000-8000-000000000001'),
    ('90000000-0000-4000-8000-000000000002'),
    ('90000000-0000-4000-8000-000000000003'),
    ('90000000-0000-4000-8000-000000000004');

insert into auth.users (id, email) values
    ('90000000-0000-4000-8000-000000000001', 'inbox-admin@example.invalid'),
    ('90000000-0000-4000-8000-000000000002', 'inbox-seller@example.invalid'),
    ('90000000-0000-4000-8000-000000000003', 'inbox-other@example.invalid'),
    ('90000000-0000-4000-8000-000000000004', 'inbox-disabled@example.invalid');

update public.sales set administrator = true where email = 'inbox-admin@example.invalid';
update public.sales set disabled = true where email = 'inbox-disabled@example.invalid';

insert into public.contacts (id, first_name) values (9000001, 'Cliente de prueba RLS');
insert into public.inbox_customers (contact_id) values (9000001);
insert into public.inbox_conversations (id, contact_id, channel)
values ('90000000-0000-4000-8000-000000000005', 9000001, 'whatsapp');
insert into public.inbox_messages (conversation_id, direction, body)
values ('90000000-0000-4000-8000-000000000005', 'incoming', 'Mensaje conservado');

set local role anon;
select throws_ok(
    'select * from public.inbox_messages', '42501', 'permission denied for table inbox_messages',
    'Anonymous sessions cannot read messages'
);

set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-4000-8000-000000000002';
select is((select count(*) from public.inbox_conversations where contact_id = 9000001), 0::bigint,
    'Sellers cannot read unassigned conversations');

set local request.jwt.claim.sub = '90000000-0000-4000-8000-000000000001';
select throws_ok(
    $$update public.inbox_conversations
      set assigned_sales_id = (select id from public.sales where email = 'inbox-disabled@example.invalid')
      where contact_id = 9000001$$,
    '42501', 'new row violates row-level security policy for table "inbox_conversations"',
    'Administrators cannot assign to disabled sellers'
);
select lives_ok(
    $$update public.inbox_conversations
      set assigned_sales_id = (select id from public.sales where email = 'inbox-seller@example.invalid')
      where contact_id = 9000001$$,
    'An administrator can assign a conversation'
);

set local request.jwt.claim.sub = '90000000-0000-4000-8000-000000000003';
select is((select count(*) from public.inbox_customers where contact_id = 9000001), 0::bigint,
    'Other sellers cannot read the customer classification');
select is((select count(*) from public.inbox_messages
    where conversation_id = '90000000-0000-4000-8000-000000000005'), 0::bigint,
    'Other sellers cannot read the message history');

set local request.jwt.claim.sub = '90000000-0000-4000-8000-000000000002';
select is((select count(*) from public.inbox_messages
    where conversation_id = '90000000-0000-4000-8000-000000000005'), 1::bigint,
    'The assigned seller can read the message history');
with reassigned as (update public.inbox_conversations set assigned_sales_id = null
     where contact_id = 9000001 returning id)
select is((select count(*) from reassigned),
    0::bigint, 'A seller cannot reassign a conversation'
);
update public.inbox_customers set classification = 'interesado' where contact_id = 9000001;
select public.set_contact_archived(9000001, true);
select is((select classification from public.inbox_customers where contact_id = 9000001), 'interesado',
    'An assigned seller can classify the customer');
select ok((select archived_at is not null from public.contacts where id = 9000001),
    'An assigned seller can archive the customer');
select public.set_contact_archived(9000001, false);
select ok((select archived_at is null from public.contacts_summary where id = 9000001),
    'An assigned seller can restore the customer');
select is((select body from public.inbox_messages
    where conversation_id = '90000000-0000-4000-8000-000000000005'), 'Mensaje conservado',
    'Archive and restore preserve the original message');
select * from finish();
rollback;
