# Fase 4 · Instagram Direct y Facebook Messenger

## Antes de habilitar la integración

Aplica las migraciones en un proyecto Supabase de prueba y despliega las Edge Functions `meta-webhook` y `meta-inbox`. Conserva la configuración existente de WhatsApp. Los canales nuevos permanecen deshabilitados mientras `META_MESSAGING_ENABLED` no sea `true`. Configura los valores en **Edge Functions → Secrets** de Supabase. Usa un entorno de Meta de prueba antes de conectar cuentas de producción.

| Secreto                               | Valor                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `META_MESSAGING_ENABLED`              | `true` para habilitar ambos canales configurados                          |
| `META_MESSAGING_GRAPH_VERSION`        | Versión de Graph habilitada para la aplicación en formato `vXX.X`        |
| `META_MESSAGING_VERIFY_TOKEN`         | Valor aleatorio que se introduce también en Meta al verificar el webhook |
| `META_MESSENGER_ACCOUNT_ID`           | ID de la página de Facebook                                            |
| `META_MESSENGER_APP_SECRET`           | Secreto de la app que firma los eventos de Messenger                    |
| `META_MESSENGER_ACCESS_TOKEN`         | Token de acceso de esa página                                          |
| `META_INSTAGRAM_ACCOUNT_ID`           | ID de la cuenta profesional autorizada con Instagram Login               |
| `META_INSTAGRAM_APP_SECRET`           | Secreto de la app que firma los eventos de Instagram                    |
| `META_INSTAGRAM_ACCESS_TOKEN`         | Token de usuario de Instagram emitido para la cuenta profesional         |

Los canales pueden usar la misma aplicación o dos aplicaciones de Meta. Si comparten aplicación, el secreto de firma configurado para cada uno es el de esa misma app. Usa como callback HTTPS `https://<proyecto>.supabase.co/functions/v1/meta-webhook`.

## Facebook Messenger

1. Configura el caso de uso de Messenger para la aplicación de Meta y vincula la página de Facebook que recibirá los mensajes.
2. Obtén un token de la página de una persona con la tarea de mensajería. Accede a `pages_messaging` para mensajería y `pages_manage_metadata` para gestionar la suscripción de la página. Si obtienes la página y su token a partir de una lista de páginas administradas, usa `pages_show_list` donde corresponda.
3. Configura el webhook del objeto **Page** y suscribe `messages`, `message_echoes`, `message_deliveries` y `message_reads`. Instala la app en la página mediante `POST https://graph.facebook.com/<version>/<page-id>/subscribed_apps` con el token de la página y los campos correspondientes.
4. El CRM envía respuestas a `POST https://graph.facebook.com/<version>/<page-id>/messages` con `messaging_type=RESPONSE` y el identificador de la persona dentro de la página.

[Webhooks de páginas](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages/) · [Guía de Messenger](https://developers.facebook.com/docs/messenger-platform/getting-started/quick-start/)

## Instagram Direct

1. Usa **Instagram API with Instagram Login** con una cuenta profesional Business o Creator. Autoriza `instagram_business_basic` e `instagram_business_manage_messages` y obtén el token para esa cuenta. Este método de Instagram Login no depende de vincular una página de Facebook.
2. Configura el webhook del objeto **Instagram** y suscribe `messages` y `messaging_seen`. Activa la suscripción para la cuenta autorizada mediante `POST https://graph.instagram.com/<version>/<ig-user-id>/subscribed_apps` con los campos elegidos y su token de usuario de Instagram.
3. El CRM responde a `POST https://graph.instagram.com/<version>/<ig-user-id>/messages` con el identificador de la persona dentro del ámbito de la cuenta de Instagram.
4. Para pasar a producción, completa la revisión y el nivel de acceso que Meta exija para tus cuentas y aplicación. Si Meta rechaza un envío por control de conversación, comprueba el enrutamiento de la app en Meta antes de volver a intentar.

[Instagram Messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/) · [Webhook de Instagram](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram)

## Pruebas y operación

- Desde otra cuenta de prueba permitida por Meta, escribe a la página y a la cuenta profesional. Cada canal crea su propio cliente dentro de su ámbito de identidad y muestra la conversación en la misma bandeja que WhatsApp.
- Asigna el contacto a un vendedor activo y prueba la respuesta manual. Después de transferir la conversación, el asesor anterior pierde el derecho a enviar y a emitir nuevos enlaces de descarga.
- Verifica fotos, documentos y otros adjuntos compatibles. El CRM puede conservar hasta ocho adjuntos por mensaje y hasta 20 MiB por archivo. Las imágenes JPEG, PNG, GIF y WebP tienen vista previa. Los demás archivos compatibles se descargan. Las URL de origen se aceptan únicamente desde dominios CDN de Meta admitidos. Los enlaces privados del CRM vencen en 60 segundos.
- El CRM usa una ventana de respuesta conservadora de 24 horas desde el último mensaje del cliente. La integración actual no aplica extensiones por anuncios, etiquetas, mensajes promocionales ni excepciones de atención humana. [Actualizaciones de las ventanas de Meta](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/changelog/)
- Los mensajes y adjuntos se registran por identificadores únicos. Ante un fallo transitorio de un adjunto, el webhook solicita reentrega y mantiene el registro del mensaje. Las descargas pueden intentarse hasta cinco veces. Los reintentos de una respuesta manual con el mismo identificador consultan su estado. Ante una entrega incierta, revisa el historial y Meta antes de iniciar un envío nuevo.
- Las notificaciones aparecen mientras el CRM está abierto. Los errores operativos se registran en `public.meta_transport_errors` para administración de la base de datos, con códigos y etapa, sin copiar tokens, URLs de origen ni cuerpos de mensajes. Los ecos externos no crean mensajes nuevos. Los recibos se actualizan cuando pueden asociarse a una respuesta registrada.
- El asistente se activa por conversación en modo de observación y usa el historial y los adjuntos de ambos canales. El envío manual o la toma de control lo detienen. La IA no dispone de operaciones de envío ni de cotización o cierre de ventas.

Las pruebas automatizadas usan cargas sintéticas. Completar la prueba con las cuentas reales requiere configurar los secretos y suscripciones después de revisar el PR.
