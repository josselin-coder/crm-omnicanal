-- Sample conversations are loaded by the local Supabase seed, not by migrations.
do $$
declare
    customer_id bigint;
    thread_id uuid;
    sample record;
begin
    for sample in select * from (values
        ('whatsapp', 'Valeria', 'Torres', 'interesado',
         'Hola, necesito cortar un letrero de acrílico con láser.',
         'Hola, Valeria. Recibimos tu consulta sobre el letrero.'),
        ('instagram', 'Diego', 'Rojas', 'indeciso',
         '¿Hacen grabado en madera? Tengo una imagen de referencia.',
         'Hola, Diego. Puedes compartir la imagen por aquí.'),
        ('messenger', 'Lucía', 'Vargas', 'listo_para_ventas',
         'Quiero encargar la impresión 3D de una pieza. Tengo el STL.',
         'Hola, Lucía. Podemos revisar el archivo para entender tu proyecto.')
    ) as samples(channel, first_name, last_name, classification, incoming, outgoing)
    loop
        insert into public.contacts (first_name, last_name, first_seen, last_seen)
        values (sample.first_name, sample.last_name, now(), now())
        returning id into customer_id;

        insert into public.inbox_customers (contact_id, classification)
        values (customer_id, sample.classification);

        insert into public.inbox_conversations (contact_id, channel)
        values (customer_id, sample.channel)
        returning id into thread_id;

        insert into public.inbox_messages (conversation_id, direction, body, sent_at)
        values
            (thread_id, 'incoming', sample.incoming, now() - interval '5 minutes'),
            (thread_id, 'outgoing', sample.outgoing, now());
    end loop;
end;
$$;
