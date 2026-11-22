-- The CRM contact owns the archive state for both interfaces.
alter table public.contacts add column archived_at timestamptz;
alter table public.contact_notes add column archived_at timestamptz;
alter table public.deal_notes add column archived_at timestamptz;

revoke update on public.inbox_customers from authenticated;
revoke update (archived_at) on public.inbox_customers from authenticated;
alter table public.inbox_customers drop column archived_at;
grant update (classification) on public.inbox_customers to authenticated;

-- Parent deletion must not silently delete CRM history.
alter table public.contacts drop constraint contacts_company_id_fkey,
    add constraint contacts_company_id_fkey foreign key (company_id)
    references public.companies(id) on update cascade on delete set null;
alter table public.deals drop constraint deals_company_id_fkey,
    add constraint deals_company_id_fkey foreign key (company_id)
    references public.companies(id) on update cascade on delete set null;
alter table public.contact_notes drop constraint "contactNotes_contact_id_fkey",
    add constraint "contactNotes_contact_id_fkey" foreign key (contact_id)
    references public.contacts(id) on update cascade on delete restrict;
alter table public.contact_notes drop constraint "contactNotes_sales_id_fkey",
    add constraint "contactNotes_sales_id_fkey" foreign key (sales_id)
    references public.sales(id) on update cascade on delete set null;
alter table public.deal_notes drop constraint "dealNotes_deal_id_fkey",
    add constraint "dealNotes_deal_id_fkey" foreign key (deal_id)
    references public.deals(id) on update cascade on delete restrict;
alter table public.tasks drop constraint tasks_contact_id_fkey,
    add constraint tasks_contact_id_fkey foreign key (contact_id)
    references public.contacts(id) on update cascade on delete restrict;

revoke all on public.contacts, public.contact_notes, public.deal_notes from public, anon;
revoke delete, truncate on public.contacts, public.contact_notes, public.deal_notes, public.deals from authenticated;
drop policy "Attachments 1mt4rzk_3" on storage.objects;
drop policy "Contact Delete Policy" on public.contacts;
drop policy "Contact Notes Delete Policy" on public.contact_notes;
drop policy "Deal Notes Delete Policy" on public.deal_notes;
drop policy "Deals Delete Policy" on public.deals;

-- Evaluated as the caller. The existing sales policy exposes staff rows, so
-- matching auth.uid() here is essential.
create function public.crm_can_manage_record(owner_id bigint)
returns boolean
language sql stable security invoker set search_path = ''
as $$
    select exists (
        select 1 from public.sales as actor
        where actor.user_id = (select auth.uid()) and not actor.disabled
          and (actor.administrator or actor.id = owner_id)
    );
$$;

revoke all on function public.crm_can_manage_record(bigint) from public, anon;
grant execute on function public.crm_can_manage_record(bigint) to authenticated;

drop policy "Enable read access for authenticated users" on public.contacts;
drop policy "Enable insert for authenticated users only" on public.contacts;
drop policy "Enable update for authenticated users only" on public.contacts;
create policy contacts_read on public.contacts for select to authenticated
using (public.crm_can_manage_record(sales_id) or exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.contact_id = contacts.id
));
create policy contacts_insert on public.contacts for insert to authenticated
with check (public.crm_can_manage_record(sales_id));
create policy contacts_update on public.contacts for update to authenticated
using (public.crm_can_manage_record(sales_id) or exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.contact_id = contacts.id
))
with check (public.crm_can_manage_record(sales_id) or exists (
    select 1 from public.inbox_conversations as conversation
    where conversation.contact_id = contacts.id
));

create function public.restrict_contact_owner_change()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
    if new.sales_id is distinct from old.sales_id
       and auth.uid() is not null and not public.crm_can_manage_record(null) then
        raise exception 'Only an administrator can change the contact owner' using errcode = '42501';
    end if;
    return new;
end;
$$;
create trigger restrict_contact_owner_change before update of sales_id on public.contacts
for each row execute function public.restrict_contact_owner_change();

-- Restrict deal writes so a user cannot change sales_id to gain note access.
drop policy "Enable insert for authenticated users only" on public.deals;
drop policy "Enable update for authenticated users only" on public.deals;
create policy deals_insert on public.deals for insert to authenticated
with check (public.crm_can_manage_record(sales_id));
create policy deals_update on public.deals for update to authenticated
using (public.crm_can_manage_record(sales_id))
with check (public.crm_can_manage_record(sales_id));

drop policy "Enable read access for authenticated users" on public.contact_notes;
drop policy "Enable insert for authenticated users only" on public.contact_notes;
drop policy "Contact Notes Update policy" on public.contact_notes;
create policy contact_notes_read on public.contact_notes for select to authenticated
using (archived_at is null and exists (
    select 1 from public.contacts as parent where parent.id = contact_id
));
create policy contact_notes_insert on public.contact_notes for insert to authenticated
with check (archived_at is null and public.crm_can_manage_record(sales_id) and exists (
    select 1 from public.contacts as parent where parent.id = contact_id
));
create policy contact_notes_update on public.contact_notes for update to authenticated
using (archived_at is null and public.crm_can_manage_record(sales_id) and exists (
    select 1 from public.contacts as parent where parent.id = contact_id
))
with check (archived_at is null and public.crm_can_manage_record(sales_id) and exists (
    select 1 from public.contacts as parent where parent.id = contact_id
));

drop policy "Enable read access for authenticated users" on public.deal_notes;
drop policy "Enable insert for authenticated users only" on public.deal_notes;
drop policy "Deal Notes Update Policy" on public.deal_notes;
create policy deal_notes_read on public.deal_notes for select to authenticated
using (archived_at is null and exists (
    select 1 from public.deals as parent
    where parent.id = deal_id and public.crm_can_manage_record(parent.sales_id)
));
create policy deal_notes_insert on public.deal_notes for insert to authenticated
with check (archived_at is null and public.crm_can_manage_record(sales_id) and exists (
    select 1 from public.deals as parent
    where parent.id = deal_id and public.crm_can_manage_record(parent.sales_id)
));
create policy deal_notes_update on public.deal_notes for update to authenticated
using (archived_at is null and public.crm_can_manage_record(sales_id) and exists (
    select 1 from public.deals as parent
    where parent.id = deal_id and public.crm_can_manage_record(parent.sales_id)
))
with check (archived_at is null and public.crm_can_manage_record(sales_id) and exists (
    select 1 from public.deals as parent
    where parent.id = deal_id and public.crm_can_manage_record(parent.sales_id)
));

create function public.set_contact_archived(target_id bigint, archived boolean)
returns boolean
language sql security definer set search_path = ''
as $$
    with changed as (
        update public.contacts as contact
        set archived_at = case when archived then coalesce(contact.archived_at, now()) end
        where contact.id = target_id and (
            public.crm_can_manage_record(contact.sales_id)
            or exists (
                select 1 from public.inbox_conversations as conversation
                join public.sales as actor on actor.id = conversation.assigned_sales_id
                where conversation.contact_id = target_id
                  and actor.user_id = (select auth.uid()) and not actor.disabled
            )
        )
        returning contact.id
    )
    select exists (select 1 from changed);
$$;
revoke all on function public.set_contact_archived(bigint, boolean) from public, anon;
grant execute on function public.set_contact_archived(bigint, boolean) to authenticated;

create function public.archive_crm_note(target_id bigint, note_resource text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
    changed_id bigint;
begin
    if note_resource = 'contact_notes' then
        update public.contact_notes as note
        set archived_at = coalesce(note.archived_at, now())
        from public.contacts as parent
        where note.id = target_id and parent.id = note.contact_id
          and public.crm_can_manage_record(note.sales_id)
          and (
            public.crm_can_manage_record(parent.sales_id) or exists (
                select 1 from public.inbox_conversations as conversation
                join public.sales as actor on actor.id = conversation.assigned_sales_id
                where conversation.contact_id = parent.id
                  and actor.user_id = (select auth.uid()) and not actor.disabled
            )
          )
        returning note.id into changed_id;
    elsif note_resource = 'deal_notes' then
        update public.deal_notes as note
        set archived_at = coalesce(note.archived_at, now())
        from public.deals as parent
        where note.id = target_id and parent.id = note.deal_id
          and public.crm_can_manage_record(note.sales_id)
          and public.crm_can_manage_record(parent.sales_id)
        returning note.id into changed_id;
    end if;
    return changed_id is not null;
end;
$$;
revoke all on function public.archive_crm_note(bigint, text) from public, anon;
grant execute on function public.archive_crm_note(bigint, text) to authenticated;

create or replace view public.contacts_summary with (security_invoker = on) as
select
    co.id,
    co.first_name,
    co.last_name,
    co.gender,
    co.title,
    co.background,
    co.avatar,
    co.first_seen,
    co.last_seen,
    co.has_newsletter,
    co.status,
    co.tags,
    co.company_id,
    co.sales_id,
    co.linkedin_url,
    co.email_jsonb,
    co.phone_jsonb,
    (jsonb_path_query_array(co.email_jsonb, '$[*]."email"'))::text as email_fts,
    (jsonb_path_query_array(co.phone_jsonb, '$[*]."number"'))::text as phone_fts,
    c.name as company_name,
    count(distinct t.id) filter (where t.done_date is null) as nb_tasks,
    co.archived_at
from public.contacts co
    left join public.tasks t on co.id = t.contact_id
    left join public.companies c on co.company_id = c.id
group by co.id, c.name;

CREATE OR REPLACE FUNCTION "public"."merge_contacts"("loser_id" bigint, "winner_id" bigint) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO pg_catalog, public, pg_temp
    AS $$
DECLARE
  winner_contact public.contacts%ROWTYPE;
  loser_contact public.contacts%ROWTYPE;
  deal_record RECORD;
  merged_emails jsonb;
  merged_phones jsonb;
  merged_tags bigint[];
  winner_emails jsonb;
  loser_emails jsonb;
  winner_phones jsonb;
  loser_phones jsonb;
  email_map jsonb;
  phone_map jsonb;
BEGIN
  IF loser_id = winner_id OR loser_id IS NULL OR winner_id IS NULL THEN
    RAISE EXCEPTION 'Two different contact IDs are required' USING ERRCODE = '22023';
  END IF;

  PERFORM id FROM public.contacts WHERE id IN (loser_id, winner_id)
  ORDER BY id FOR UPDATE;

  -- Fetch both contacts
  SELECT * INTO winner_contact FROM public.contacts WHERE id = winner_id;
  SELECT * INTO loser_contact FROM public.contacts WHERE id = loser_id;

  IF winner_contact.id IS NULL OR loser_contact.id IS NULL
      OR NOT public.crm_can_manage_record(winner_contact.sales_id)
      OR NOT public.crm_can_manage_record(loser_contact.sales_id)
      OR winner_contact.archived_at IS NOT NULL OR loser_contact.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot merge these contacts' USING ERRCODE = '42501';
  END IF;

  -- 1. Reassign tasks from loser to winner
  UPDATE public.tasks SET contact_id = winner_id WHERE contact_id = loser_id;

  -- 2. Reassign contact notes from loser to winner
  UPDATE public.contact_notes SET contact_id = winner_id WHERE contact_id = loser_id;

  -- 3. Update deals - replace loser with winner in contact_ids array
  FOR deal_record IN
    SELECT id, contact_ids
    FROM public.deals
    WHERE contact_ids @> ARRAY[loser_id]
      AND public.crm_can_manage_record(sales_id)
  LOOP
    UPDATE public.deals
    SET contact_ids = (
      SELECT ARRAY(
        SELECT DISTINCT unnest(
          array_remove(deal_record.contact_ids, loser_id) || ARRAY[winner_id]
        )
      )
    )
    WHERE id = deal_record.id AND public.crm_can_manage_record(sales_id);
  END LOOP;

  -- 4. Merge contact data

  -- Get email arrays
  winner_emails := COALESCE(winner_contact.email_jsonb, '[]'::jsonb);
  loser_emails := COALESCE(loser_contact.email_jsonb, '[]'::jsonb);

  -- Merge emails with deduplication by email address
  -- Build a map of email -> email object, then convert back to array
  email_map := '{}'::jsonb;

  -- Add winner emails to map
  IF jsonb_array_length(winner_emails) > 0 THEN
    FOR i IN 0..jsonb_array_length(winner_emails)-1 LOOP
      IF nullif(winner_emails->i->>'email', '') IS NOT NULL THEN
        email_map := email_map || jsonb_build_object(winner_emails->i->>'email', winner_emails->i);
      END IF;
    END LOOP;
  END IF;

  -- Add loser emails to map (won't overwrite existing keys)
  IF jsonb_array_length(loser_emails) > 0 THEN
    FOR i IN 0..jsonb_array_length(loser_emails)-1 LOOP
      IF nullif(loser_emails->i->>'email', '') IS NOT NULL AND NOT email_map ? (loser_emails->i->>'email') THEN
        email_map := email_map || jsonb_build_object(
          loser_emails->i->>'email',
          loser_emails->i
        );
      END IF;
    END LOOP;
  END IF;

  -- Convert map back to array
  merged_emails := (SELECT jsonb_agg(value) FROM jsonb_each(email_map));
  merged_emails := COALESCE(merged_emails, '[]'::jsonb);

  -- Get phone arrays
  winner_phones := COALESCE(winner_contact.phone_jsonb, '[]'::jsonb);
  loser_phones := COALESCE(loser_contact.phone_jsonb, '[]'::jsonb);

  -- Merge phones with deduplication by number
  phone_map := '{}'::jsonb;

  -- Add winner phones to map
  IF jsonb_array_length(winner_phones) > 0 THEN
    FOR i IN 0..jsonb_array_length(winner_phones)-1 LOOP
      IF nullif(winner_phones->i->>'number', '') IS NOT NULL THEN
        phone_map := phone_map || jsonb_build_object(winner_phones->i->>'number', winner_phones->i);
      END IF;
    END LOOP;
  END IF;

  -- Add loser phones to map (won't overwrite existing keys)
  IF jsonb_array_length(loser_phones) > 0 THEN
    FOR i IN 0..jsonb_array_length(loser_phones)-1 LOOP
      IF nullif(loser_phones->i->>'number', '') IS NOT NULL AND NOT phone_map ? (loser_phones->i->>'number') THEN
        phone_map := phone_map || jsonb_build_object(
          loser_phones->i->>'number',
          loser_phones->i
        );
      END IF;
    END LOOP;
  END IF;

  -- Convert map back to array
  merged_phones := (SELECT jsonb_agg(value) FROM jsonb_each(phone_map));
  merged_phones := COALESCE(merged_phones, '[]'::jsonb);

  -- Merge tags (remove duplicates)
  merged_tags := ARRAY(
    SELECT DISTINCT unnest(
      COALESCE(winner_contact.tags, ARRAY[]::bigint[]) ||
      COALESCE(loser_contact.tags, ARRAY[]::bigint[])
    )
  );

  -- 5. Update winner with merged data
  UPDATE public.contacts SET
    avatar = COALESCE(winner_contact.avatar, loser_contact.avatar),
    gender = COALESCE(winner_contact.gender, loser_contact.gender),
    first_name = COALESCE(winner_contact.first_name, loser_contact.first_name),
    last_name = COALESCE(winner_contact.last_name, loser_contact.last_name),
    title = COALESCE(winner_contact.title, loser_contact.title),
    company_id = COALESCE(winner_contact.company_id, loser_contact.company_id),
    email_jsonb = merged_emails,
    phone_jsonb = merged_phones,
    linkedin_url = COALESCE(winner_contact.linkedin_url, loser_contact.linkedin_url),
    background = COALESCE(winner_contact.background, loser_contact.background),
    has_newsletter = COALESCE(winner_contact.has_newsletter, loser_contact.has_newsletter),
    first_seen = LEAST(COALESCE(winner_contact.first_seen, loser_contact.first_seen), COALESCE(loser_contact.first_seen, winner_contact.first_seen)),
    last_seen = GREATEST(COALESCE(winner_contact.last_seen, loser_contact.last_seen), COALESCE(loser_contact.last_seen, winner_contact.last_seen)),
    sales_id = COALESCE(winner_contact.sales_id, loser_contact.sales_id),
    tags = merged_tags
  WHERE id = winner_id;

  -- Keep conversations and messages attached to the surviving contact.
  INSERT INTO public.inbox_customers (contact_id, classification)
  SELECT winner_id, classification FROM public.inbox_customers WHERE contact_id = loser_id
  ON CONFLICT (contact_id) DO NOTHING;

  UPDATE public.inbox_conversations SET contact_id = winner_id WHERE contact_id = loser_id;
  UPDATE public.contacts SET archived_at = now() WHERE id = loser_id;

  RETURN winner_id;
END;
$$;

revoke all on function public.merge_contacts(bigint, bigint) from public, anon;
grant execute on function public.merge_contacts(bigint, bigint) to authenticated;

-- Search must use the same row visibility as direct API reads.
do $$
declare
    signature regprocedure;
begin
    for signature in
        select procedure.oid::regprocedure from pg_catalog.pg_proc as procedure
        join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public' and procedure.proname = 'global_search'
    loop
        execute format('alter function %s security invoker', signature);
    end loop;
end;
$$;

create function public.archive_contacts(target_ids bigint[])
returns bigint[]
language plpgsql security invoker set search_path = ''
as $$
declare
    target_id bigint;
    archived_ids bigint[] := '{}';
begin
    for target_id in select distinct id from unnest(target_ids) as input(id) order by id loop
        if not public.set_contact_archived(target_id, true) then
            raise exception 'Cannot archive the selected contacts' using errcode = '42501';
        end if;
        archived_ids := array_append(archived_ids, target_id);
    end loop;
    return archived_ids;
end;
$$;
revoke all on function public.archive_contacts(bigint[]) from public, anon;
grant execute on function public.archive_contacts(bigint[]) to authenticated;
