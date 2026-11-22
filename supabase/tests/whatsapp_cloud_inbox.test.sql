begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(17);

insert into public.user_invitations (user_id) values
    ('92000000-0000-4000-8000-000000000001'),
    ('92000000-0000-4000-8000-000000000002'),
    ('92000000-0000-4000-8000-000000000003');
insert into auth.users (id, email) values
    ('92000000-0000-4000-8000-000000000001', 'wa-admin@example.invalid'),
    ('92000000-0000-4000-8000-000000000002', 'wa-seller@example.invalid'),
    ('92000000-0000-4000-8000-000000000003', 'wa-other@example.invalid');
update sales set administrator = (email = 'wa-admin@example.invalid')
where email in ('wa-admin@example.invalid', 'wa-seller@example.invalid', 'wa-other@example.invalid');

select ok(receive_whatsapp_message('920','51111111111','Fase 2','wamid.inbound',now(),
    'Archivo de prueba','document','920/file','diseño.pdf','application/pdf'), 'First delivery creates the conversation and message');
select is(receive_whatsapp_message('920','51111111111','Fase 2','wamid.inbound',now(),
    'Archivo de prueba','document','920/file','diseño.pdf','application/pdf'), false, 'A repeated webhook is ignored');
select ok(receive_whatsapp_message('920','51111111111','Fase 2','wamid.second',now() - interval '25 hours',
    'Mensaje anterior','text',null,null,null), 'An older webhook is recorded in the same conversation');
select is((select count(*) from inbox_conversations where whatsapp_phone_id = '920'), 1::bigint, 'One thread and contact per sender identity');
select is((select count(*) from inbox_messages where provider_message_id = 'wamid.inbound'), 1::bigint, 'Provider ID is unique');
select is((select attachment_name from inbox_messages where provider_message_id = 'wamid.inbound'),
    'diseño.pdf', 'Private media metadata is attached to the message');
select is((select public from storage.buckets where id = 'whatsapp-media'), false, 'Media bucket is private');
select ok((select last_inbound_at > now() - interval '10 minutes' from inbox_conversations where whatsapp_phone_id = '920'),
    'A delayed delivery cannot regress the customer service window');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-4000-8000-000000000001';
update inbox_conversations set assigned_sales_id = (select id from sales where email = 'wa-seller@example.invalid')
where whatsapp_phone_id = '920';
select is((select assigned_sales_id from inbox_conversations where whatsapp_phone_id = '920'),
    (select id from sales where email = 'wa-seller@example.invalid'), 'An administrator can assign a new thread');
set local request.jwt.claim.sub = '92000000-0000-4000-8000-000000000003';
select is((select count(*) from inbox_messages where provider_message_id = 'wamid.inbound'), 0::bigint,
    'An unrelated seller cannot read WhatsApp messages or their media paths');
select is(has_function_privilege('authenticated', 'public.reserve_whatsapp_send(uuid,uuid,uuid,text,text)', 'execute'),
    false, 'Browser role cannot impersonate an actor on the reservation RPC');
reset role;
reset request.jwt.claim.sub;

create temporary table test_wa_thread as select id from inbox_conversations where whatsapp_phone_id = '920';

select is(reserve_whatsapp_send('92000000-0000-4000-8000-000000000003',
    (select id from test_wa_thread), '92000000-0000-4000-8000-000000000004','920','Hola')->>'error',
    'forbidden', 'Server rejects an unassigned seller');
select is(reserve_whatsapp_send('92000000-0000-4000-8000-000000000002',
    (select id from test_wa_thread), '92000000-0000-4000-8000-000000000004','920','Hola')->>'claimed',
    'true', 'Assigned seller reserves the reply once');
select is(reserve_whatsapp_send('92000000-0000-4000-8000-000000000002',
    (select id from test_wa_thread), '92000000-0000-4000-8000-000000000004','920','Hola')->>'claimed',
    'false', 'A repeated request does not send again');

select update_whatsapp_send('920','92000000-0000-4000-8000-000000000004','wamid.reply','delivered');
select update_whatsapp_send('920',null,'wamid.reply','sent');
select is((select send_status from inbox_messages where provider_message_id = 'wamid.reply'),
    'delivered', 'An out-of-order status does not regress delivery');
update inbox_conversations set assigned_sales_id = (select id from sales where email = 'wa-other@example.invalid')
where whatsapp_phone_id = '920';
select is(reserve_whatsapp_send('92000000-0000-4000-8000-000000000002',
    (select id from test_wa_thread), '92000000-0000-4000-8000-000000000005','920','Hola')->>'error',
    'forbidden', 'The former seller cannot reply after transfer');
update inbox_conversations set last_inbound_at = now() - interval '25 hours' where whatsapp_phone_id = '920';
select is(reserve_whatsapp_send('92000000-0000-4000-8000-000000000003',
    (select id from test_wa_thread), '92000000-0000-4000-8000-000000000005','920','Hola')->>'error',
    'window_closed', 'The new seller cannot send free-form replies outside the service window');

select * from finish();
rollback;
