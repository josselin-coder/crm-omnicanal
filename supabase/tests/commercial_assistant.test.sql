begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(19);

insert into public.user_invitations (user_id) values
    ('93000000-0000-4000-8000-000000000001'),
    ('93000000-0000-4000-8000-000000000002');
insert into auth.users (id, email) values
    ('93000000-0000-4000-8000-000000000001', 'assistant-owner@example.invalid'),
    ('93000000-0000-4000-8000-000000000002', 'assistant-other@example.invalid');
update sales set administrator = false
where email in ('assistant-owner@example.invalid', 'assistant-other@example.invalid');

select receive_whatsapp_message('930','9312345678','Simulación','wamid.assistant.first',now(),
    'Quiero grabar 20 placas','text',null,null,null);
create temporary table assistant_fixture as select id, contact_id from inbox_conversations where whatsapp_phone_id = '930';
update inbox_conversations set assigned_sales_id = (select id from sales where email = 'assistant-owner@example.invalid')
where id = (select id from assistant_fixture);

select is(claim_assistant_observation((select id from assistant_fixture)), null::jsonb, 'Observation is off by default');
select is(control_inbox_assistant('93000000-0000-4000-8000-000000000002',
    (select id from assistant_fixture),'enable'), 'forbidden', 'Unassigned sellers cannot enable observation');
select is(control_inbox_assistant('93000000-0000-4000-8000-000000000001',
    (select id from assistant_fixture),'enable'), 'observe', 'Assigned seller can enable observation');
create temporary table assistant_claim as select claim_assistant_observation((select id from assistant_fixture)) as job;
select is(jsonb_array_length((select job->'transcript' from assistant_claim)), 1, 'The claim returns the persisted history');
select is(claim_assistant_observation((select id from assistant_fixture)), null::jsonb, 'A duplicate worker cannot claim the same history');

select receive_whatsapp_message('930','9312345678','Simulación','wamid.assistant.second',now(),
    '¿Me pueden cotizar?','text',null,null,null);
select is(finish_assistant_observation((select id from assistant_fixture),
    (select (job->>'token')::uuid from assistant_claim), (select (job->>'revision')::bigint from assistant_claim),
    '{"action":"ask_dxf","classification":"interesado","reason":"next_question","engine":"rules","facts":{}}'),
    false, 'A newer incoming message invalidates an old decision');
update assistant_claim set job = claim_assistant_observation((select id from assistant_fixture));
select is(jsonb_array_length((select job->'transcript' from assistant_claim)), 2, 'New claim contains both customer messages');
select is(finish_assistant_observation((select id from assistant_fixture),
    (select (job->>'token')::uuid from assistant_claim), (select (job->>'revision')::bigint from assistant_claim),
    '{"action":"handoff","classification":"listo_para_ventas","reason":"price_request","engine":"rules","facts":{"quantity":20}}'),
    true, 'Price intent records an internal handoff');
select is((select mode from assistant_states where conversation_id = (select id from assistant_fixture)), 'handoff',
    'Handoff pauses observation');
select is((select classification from inbox_customers where contact_id = (select contact_id from assistant_fixture)),
    'listo_para_ventas', 'Classification is visible in the inbox');
select is((select count(*) from inbox_messages where conversation_id = (select id from assistant_fixture) and direction = 'outgoing'),
    0::bigint, 'Observation does not create a WhatsApp reply');
select is(control_inbox_assistant('93000000-0000-4000-8000-000000000001',
    (select id from assistant_fixture),'take_control'), 'human', 'Seller can take control');
select is(control_inbox_assistant('93000000-0000-4000-8000-000000000001',
    (select id from assistant_fixture),'enable'), 'human', 'Human control is not reset by enabling observation');
select is(claim_assistant_observation((select id from assistant_fixture)), null::jsonb, 'Worker stops after takeover');

select receive_whatsapp_message('930','9312345679','Otro cliente','wamid.assistant.manual',now(),
    'Hola','text',null,null,null);
insert into inbox_messages (conversation_id, direction, body, send_status, sent_by)
select conversation.id, 'outgoing', 'Hola, soy tu asesor', 'pending', seller.id
from inbox_conversations as conversation cross join sales as seller
where conversation.whatsapp_sender = '9312345679' and seller.email = 'assistant-owner@example.invalid';
select is((select mode from assistant_states where conversation_id = (
    select id from inbox_conversations where whatsapp_sender = '9312345679')),
    'human', 'A manually reserved reply also stops the assistant');

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000002';
select is((select count(*) from assistant_decisions), 0::bigint, 'Another seller cannot read decisions');
select is(has_function_privilege('authenticated', 'public.finish_assistant_observation(uuid,uuid,bigint,jsonb)', 'execute'),
    false, 'Clients cannot spoof an observed decision');
select is(has_table_privilege('authenticated', 'public.assistant_decisions', 'insert'), false,
    'Clients cannot write the audit log');
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000001';
select is((select count(*) from assistant_decisions where reason = 'price_request'), 1::bigint,
    'The assigned seller can read the handoff audit record');

select * from finish();
rollback;
