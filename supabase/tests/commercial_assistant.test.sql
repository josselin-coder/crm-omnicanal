begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(35);

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
    'Handoff disables suggestions while preserving internal classification');
select is((select classification from inbox_customers where contact_id = (select contact_id from assistant_fixture)),
    'listo_para_ventas', 'Classification is visible in the inbox');
select is((select count(*) from inbox_messages where conversation_id = (select id from assistant_fixture) and direction = 'outgoing'),
    0::bigint, 'Observation does not create a WhatsApp reply');
select ok((select requires_attention from assistant_decisions
    where conversation_id = (select id from assistant_fixture) and reason = 'price_request'),
    'The original handoff notifies the seller');
select receive_whatsapp_message('930','9312345678','Simulación','wamid.assistant.third',now(),
    'Adjunto el archivo','document','fixture/design.dxf','diseño.dxf','application/octet-stream');
update assistant_claim set job = claim_assistant_observation((select id from assistant_fixture));
select is((select job->>'mode' from assistant_claim), 'handoff', 'Follow-up claims know they are in classification-only mode');
select ok(finish_assistant_observation((select id from assistant_fixture),
    (select (job->>'token')::uuid from assistant_claim), (select (job->>'revision')::bigint from assistant_claim),
    '{"action":"handoff","classification":"listo_para_ventas","reason":"brief_complete","engine":"rules","facts":{}}'),
    'Complete brief is recorded during handoff');
select is((select requires_attention from assistant_decisions
    where conversation_id = (select id from assistant_fixture) and reason = 'brief_complete'), false,
    'Repeated readiness does not notify again');

select receive_whatsapp_message('930','9312345678','Simulación','wamid.assistant.rejected',now(),
    'Ya no me interesa el servicio','text',null,null,null);
update assistant_claim set job = claim_assistant_observation((select id from assistant_fixture));
select is((select job->'transcript'->-1->>'text' from assistant_claim), 'Ya no me interesa el servicio',
    'Same-timestamp messages are analyzed in arrival order');
select ok(finish_assistant_observation((select id from assistant_fixture),
    (select (job->>'token')::uuid from assistant_claim), (select (job->>'revision')::bigint from assistant_claim),
    '{"action":"stopped","classification":"descartado","reason":"declined","engine":"rules","facts":{"name":"Luz","service":"grabado","quantity":20,"files":["diseño.dxf"]}}'),
    'Rejection is recorded after the handoff');
select is((select classification from inbox_customers where contact_id = (select contact_id from assistant_fixture)),
    'descartado', 'The latest rejection replaces the previous readiness');
select is((select count(*) from inbox_messages where conversation_id = (select id from assistant_fixture) and direction = 'outgoing'),
    0::bigint, 'Follow-up classification sends no reply');

select is(control_inbox_assistant('93000000-0000-4000-8000-000000000001',
    (select id from assistant_fixture),'take_control'), 'human', 'Seller can take control');
select is((select classification from inbox_customers where contact_id = (select contact_id from assistant_fixture)),
    'descartado', 'Taking control preserves the stored rejected classification');
select is((select facts from assistant_decisions where conversation_id = (select id from assistant_fixture)
    order by revision desc limit 1), '{"name":"Luz","service":"grabado","quantity":20,"files":["diseño.dxf"]}'::jsonb,
    'Taking control preserves the recorded service, quantity and files');
select is((select count(*) from inbox_messages where conversation_id = (select id from assistant_fixture)),
    4::bigint, 'Taking control preserves the conversation history');
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

reset role;
reset request.jwt.claim.sub;
insert into public.user_invitations (user_id) values ('93000000-0000-4000-8000-000000000003');
insert into auth.users (id, email) values ('93000000-0000-4000-8000-000000000003', 'assistant-admin@example.invalid');
update sales set administrator = true where email = 'assistant-admin@example.invalid';
select receive_whatsapp_message('930','9312345680','Cliente sin asignación','wamid.assistant.unassigned',now(),
    'Quiero comprar','text',null,null,null);
create temporary table assistant_unassigned as select id from inbox_conversations where whatsapp_sender = '9312345680';
select is(control_inbox_assistant('93000000-0000-4000-8000-000000000003',
    (select id from assistant_unassigned),'enable'), 'observe', 'An administrator can observe an unassigned conversation');
update assistant_claim set job = claim_assistant_observation((select id from assistant_unassigned));
select is(finish_assistant_observation((select id from assistant_unassigned),
    (select (job->>'token')::uuid from assistant_claim), (select (job->>'revision')::bigint from assistant_claim),
    '{"action":"handoff","classification":"listo_para_ventas","reason":"purchase_intent","engine":"rules","facts":{}}'),
    true, 'An unassigned conversation can be handed off');
select is((select assigned_sales_id from inbox_conversations where id = (select id from assistant_unassigned)),
    (select id from sales where email = 'assistant-other@example.invalid'), 'Handoff assigns the active seller with the lower workload');

select receive_whatsapp_message('930','9312345681','Cliente interesado','wamid.assistant.interested',now(),
    'Quiero grabar una placa','text',null,null,null);
select receive_whatsapp_message('930','9312345682','Cliente listo','wamid.assistant.ready',now(),
    'Quiero encargar un pedido','text',null,null,null);
update inbox_customers as customer
set classification = case conversation.whatsapp_sender when '9312345681' then 'interesado' else 'listo_para_ventas' end
from inbox_conversations as conversation
where conversation.whatsapp_phone_id = '930' and conversation.whatsapp_sender in ('9312345681','9312345682')
  and conversation.contact_id = customer.contact_id;
select control_inbox_assistant('93000000-0000-4000-8000-000000000003', id, 'take_control')
from inbox_conversations where whatsapp_phone_id = '930' and whatsapp_sender in ('9312345681','9312345682');
select is((select classification from inbox_customers join inbox_conversations using (contact_id) where whatsapp_sender = '9312345681'),
    'interesado', 'Taking control preserves an interested customer');
select is((select classification from inbox_customers join inbox_conversations using (contact_id) where whatsapp_sender = '9312345682'),
    'listo_para_ventas', 'Taking control preserves a sales-ready customer');

select * from finish();
rollback;
