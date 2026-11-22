begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(26);

insert into public.user_invitations (user_id) values
    ('94000000-0000-4000-8000-000000000001'),
    ('94000000-0000-4000-8000-000000000002'),
    ('94000000-0000-4000-8000-000000000003');
insert into auth.users (id, email) values
    ('94000000-0000-4000-8000-000000000001', 'meta-admin@example.invalid'),
    ('94000000-0000-4000-8000-000000000002', 'meta-seller@example.invalid'),
    ('94000000-0000-4000-8000-000000000003', 'meta-other@example.invalid');
update sales set administrator = (email = 'meta-admin@example.invalid')
where email in ('meta-admin@example.invalid', 'meta-seller@example.invalid', 'meta-other@example.invalid');

create temporary table meta_fixture as
select receive_meta_message('instagram','940','941','m_file',now(),'Necesito grabado de 12 placas',
    '[{"name":"referencia.png","kind":"image","url":"https://cdninstagram.com/test"},{"name":"plano.dxf","kind":"document","url":"https://fbcdn.net/test"}]') as ids;
select ok((select ids->>'id' is not null from meta_fixture), 'A verified message creates a contact, thread and message');
select is(
    receive_meta_message('instagram','940','941','m_file',now(),'duplicado','[]')->>'id',
    (select ids->>'id' from meta_fixture), 'A repeated provider event returns the original message');
select receive_meta_message('messenger','940','941','m_file',now(),'Hola por Messenger','[]');
select is((select count(*) from inbox_messages where provider_message_id in ('instagram:940:m_file','messenger:940:m_file')),
    2::bigint, 'The same external ID can appear in two channels');
select is((select count(distinct contact_id) from inbox_conversations where meta_account_id = '940'), 2::bigint,
    'Account-scoped contact IDs are never merged across channels');
select is((select count(*) from meta_message_attachments where message_id = (select (ids->>'id')::uuid from meta_fixture)),
    2::bigint, 'All received attachments are recorded once');

set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000001';
update inbox_conversations set assigned_sales_id = (select id from sales where email = 'meta-seller@example.invalid')
where channel = 'instagram' and meta_account_id = '940';
select is((select assigned_sales_id from inbox_conversations where channel = 'instagram' and meta_account_id = '940'),
    (select id from sales where email = 'meta-seller@example.invalid'), 'An administrator can assign the new conversation');
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000003';
select is((select count(id) from meta_message_attachments), 0::bigint, 'An unrelated seller cannot read attachments');
select is(has_column_privilege('authenticated', 'public.meta_message_attachments', 'source_url','select'),
    false, 'A browser client cannot retrieve provider download URLs');
select is(has_function_privilege('authenticated', 'public.reserve_meta_send(uuid,uuid,uuid,text,text,text)','execute'),
    false, 'A browser client cannot impersonate an agent on the send RPC');
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000002';
select is((select count(id) from meta_message_attachments), 2::bigint, 'The assigned seller can see attachment metadata');
reset role;
reset request.jwt.claim.sub;

select is((select public from storage.buckets where id = 'meta-messaging-media'), false, 'Attachments bucket is private');
select is(control_inbox_assistant('94000000-0000-4000-8000-000000000002',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'enable'), 'observe', 'The Phase 3 assistant can observe an Instagram thread');
create temporary table meta_claims as select * from claim_meta_media((select (ids->>'id')::uuid from meta_fixture));
select is((select count(*) from meta_claims), 2::bigint, 'Both private attachment jobs are claimed once');
select is((select count(*) from claim_meta_media((select (ids->>'id')::uuid from meta_fixture))), 0::bigint,
    'A second webhook cannot claim media already in progress');
select finish_meta_media(id, claim, 'pending', null,null,null,'cdn_unavailable')
from meta_claims where source_url like '%fbcdn.net%';
delete from meta_claims where source_url like '%fbcdn.net%';
insert into meta_claims select * from claim_meta_media((select (ids->>'id')::uuid from meta_fixture));
select is((select attempts from meta_claims where source_url like '%fbcdn.net%'), 2::smallint,
    'Transient failures can be retried without creating a new attachment record');
select finish_meta_media(id, claim, 'ready', id::text, 'application/octet-stream', null,null) from meta_claims;
select is((select count(*) from meta_message_attachments where state = 'ready'), 2::bigint, 'Retried files become available');
select is(jsonb_array_length(claim_assistant_observation((select (ids->>'conversation_id')::uuid from meta_fixture))->'transcript'->0->'attachments'),
    2, 'Observation receives all ready attachment metadata');

select is(reserve_meta_send('94000000-0000-4000-8000-000000000003',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'94000000-0000-4000-8000-000000000004',
    'instagram','940','Hola')->>'error', 'forbidden', 'An unassigned seller cannot send');
select is(reserve_meta_send('94000000-0000-4000-8000-000000000002',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'94000000-0000-4000-8000-000000000004',
    'messenger','940','Hola')->>'error', 'forbidden', 'An authorized actor cannot send through a different channel');
select is(reserve_meta_send('94000000-0000-4000-8000-000000000002',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'94000000-0000-4000-8000-000000000004',
    'instagram','940','Hola')->>'claimed', 'true', 'The assigned seller can reserve a manual response');
select is(reserve_meta_send('94000000-0000-4000-8000-000000000002',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'94000000-0000-4000-8000-000000000004',
    'instagram','940','Hola')->>'claimed', 'false', 'Retrying the nonce does not send again');
select is((select mode from assistant_states where conversation_id = (select (ids->>'conversation_id')::uuid from meta_fixture)),
    'human', 'Manual replies stop the assistant');
select update_meta_delivery('instagram','940','941','94000000-0000-4000-8000-000000000004',
    array['instagram:940:m_reply'],null,'accepted');
select update_meta_delivery('instagram','940','942',null,array['instagram:940:m_reply'],null,'read');
select is((select send_status from inbox_messages where provider_message_id = 'instagram:940:m_reply'), 'accepted',
    'A receipt from a different sender cannot change the message');
select update_meta_delivery('instagram','940','941',null,array['instagram:940:m_reply'],null,'read');
select update_meta_delivery('instagram','940','941',null,array['instagram:940:m_reply'],null,'delivered');
select is((select send_status from inbox_messages where provider_message_id = 'instagram:940:m_reply'), 'read',
    'An out-of-order receipt cannot regress the delivery state');

update inbox_conversations set assigned_sales_id = (select id from sales where email = 'meta-other@example.invalid')
where channel = 'instagram' and meta_account_id = '940';
select is(reserve_meta_send('94000000-0000-4000-8000-000000000002',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'94000000-0000-4000-8000-000000000005',
    'instagram','940','Hola')->>'error', 'forbidden', 'Transferred sellers lose send access');
update inbox_conversations set last_inbound_at = now() - interval '25 hours'
where channel = 'instagram' and meta_account_id = '940';
select is(reserve_meta_send('94000000-0000-4000-8000-000000000003',
    (select (ids->>'conversation_id')::uuid from meta_fixture),'94000000-0000-4000-8000-000000000005',
    'instagram','940','Hola')->>'error', 'window_closed', 'New seller cannot send after the standard window');

select * from finish();
rollback;
