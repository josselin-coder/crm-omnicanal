begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

insert into public.user_invitations (user_id) values
    ('91000000-0000-4000-8000-000000000001'),
    ('91000000-0000-4000-8000-000000000002'),
    ('91000000-0000-4000-8000-000000000003');

insert into auth.users (id, email) values
    ('91000000-0000-4000-8000-000000000001', 'access-admin@example.invalid'),
    ('91000000-0000-4000-8000-000000000002', 'access-owner@example.invalid'),
    ('91000000-0000-4000-8000-000000000003', 'access-other@example.invalid');

update public.sales set administrator = (email = 'access-admin@example.invalid')
where email in ('access-admin@example.invalid', 'access-owner@example.invalid', 'access-other@example.invalid');

insert into public.companies (id, name) values (9100001, 'Security company');
insert into public.contacts (id, company_id, first_name, sales_id)
select fixture.id, 9100001, fixture.name, seller.id
from (values (9100001, 'Private client'), (9100002, 'Duplicate client')) as fixture(id, name)
cross join public.sales as seller where seller.email = 'access-owner@example.invalid';
insert into public.deals (id, company_id, name, stage, sales_id)
select 9100001, 9100001, 'Private deal', 'new', id
from public.sales where email = 'access-owner@example.invalid';
insert into public.contact_notes (id, contact_id, sales_id, text)
select 9100001, 9100001, id, 'Private contact note'
from public.sales where email = 'access-owner@example.invalid';
insert into public.deal_notes (id, deal_id, sales_id, text)
select 9100001, 9100001, id, 'Private deal note'
from public.sales where email = 'access-owner@example.invalid';
insert into public.inbox_customers (contact_id, classification) values (9100002, 'interesado');
insert into public.inbox_conversations (id, contact_id, channel)
values ('91000000-0000-4000-8000-000000000004', 9100002, 'instagram');
insert into public.inbox_messages (conversation_id, direction, body)
values ('91000000-0000-4000-8000-000000000004', 'incoming', 'Original message');

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000003';

select is((select count(*) from contacts where id = 9100001), 0::bigint, 'A peer cannot read contacts');
select is((select count(*) from contacts_summary where id = 9100001), 0::bigint, 'The contact view respects RLS');
select is((select count(*) from contact_notes where id = 9100001), 0::bigint, 'A peer cannot read protected contact notes');
select is((select count(*) from deal_notes where id = 9100001), 0::bigint, 'A peer cannot read protected deal notes');
select is((select count(*) from activity_log where id in ('contactNote.9100001.created', 'dealNote.9100001.created')),
    0::bigint, 'The activity feed cannot expose private notes');
select is(set_contact_archived(9100001, true), false, 'A peer cannot archive another owner contact');
select is(archive_crm_note(9100001, 'contact_notes'), false, 'A peer cannot archive a private note');
select throws_ok('select public.merge_contacts(9100002, 9100001)', '42501', 'Cannot merge these contacts',
    'The merge RPC enforces contact ownership');

set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000002';

select is((select text from contact_notes where id = 9100001), 'Private contact note', 'The owner can read the contact note');
select is((select text from deal_notes where id = 9100001), 'Private deal note', 'The owner can read the deal note');
select throws_ok('delete from contacts where id = 9100001', '42501', 'permission denied for table contacts',
    'Even the contact owner cannot delete the contact permanently');
select throws_ok('delete from contact_notes where id = 9100001', '42501', 'permission denied for table contact_notes',
    'Even the note author cannot delete a contact note permanently');
select throws_ok('delete from deal_notes where id = 9100001', '42501', 'permission denied for table deal_notes',
    'Even the note author cannot delete a deal note permanently');

select ok(set_contact_archived(9100001, true), 'The owner can archive their contact');
select ok((select archived_at is not null from contacts_summary where id = 9100001), 'The list view uses the CRM archive field');
select ok(set_contact_archived(9100001, false), 'The owner can restore their contact');
select ok(archive_crm_note(9100001, 'contact_notes'), 'The note author can archive their note');
select is((select count(*) from contact_notes where id = 9100001), 0::bigint, 'An archived note is absent from regular reads');

set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000001';
select is(merge_contacts(9100002, 9100001), 9100001::bigint, 'An administrator can merge the contacts');
select is((select contact_id from inbox_conversations where id = '91000000-0000-4000-8000-000000000004'),
    9100001::bigint, 'Merge preserves the inbox conversation under the surviving contact');

select ok((select archived_at is not null from contacts_summary where id = 9100002),
    'The original contact is retained as archived after a merge');
select is((select body from inbox_messages where conversation_id = '91000000-0000-4000-8000-000000000004'),
    'Original message', 'Merge preserves the original message');

delete from companies where id = 9100001;
select ok((select company_id is null from contacts where id = 9100001),
    'Company deletion detaches the contact without deleting its history');

reset role;
select is((select text from contact_notes where id = 9100001 and archived_at is not null),
    'Private contact note', 'The archived note and its content are retained in storage');

select * from finish();
rollback;
