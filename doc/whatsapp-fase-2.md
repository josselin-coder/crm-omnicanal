# WhatsApp Business · Fase 2

La bandeja usa la Cloud API de Meta para un número de WhatsApp Business por proyecto Supabase. Las conversaciones de ejemplo de Instagram, Messenger y WhatsApp aparecen con la etiqueta **Demostración**. Las respuestas de WhatsApp son manuales y de texto.

## Configuración del servidor

Aplica las migraciones y despliega las Edge Functions `whatsapp-webhook` y `whatsapp-inbox`. Define estas variables como secretos de Edge Functions en el proyecto Supabase. Los entornos locales pueden usar un archivo de variables fuera del repositorio.

| Variable | Valor que se configura en Supabase |
| --- | --- |
| `WHATSAPP_WABA_ID` | ID de la cuenta de WhatsApp Business suscrita al webhook |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp Business |
| `WHATSAPP_GRAPH_VERSION` | Versión habilitada de Graph API en formato `vXX.X` |
| `WHATSAPP_ACCESS_TOKEN` | Token de Meta autorizado para mensajería en el activo empresarial |
| `WHATSAPP_APP_SECRET` | Secreto de la aplicación de Meta para validar la firma HMAC del webhook |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Valor aleatorio propio que también se configura al verificar el callback en Meta |

Supabase suministra las variables de ejecución `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` a las funciones. Conserva las variables de Meta en Supabase y utiliza HTTPS para el callback.

En Meta, registra `https://<proyecto>.supabase.co/functions/v1/whatsapp-webhook` como callback de WhatsApp y suscribe el campo `messages` de la cuenta indicada. El endpoint comprueba el token durante la verificación y valida la firma `X-Hub-Signature-256` sobre el cuerpo original de cada evento POST. Acepta eventos del número y la cuenta configurados. El endpoint de bandeja exige un token válido de un usuario de Supabase y revisa sus permisos antes de enviar o emitir un enlace de descarga.

## Operación

1. Envía un mensaje desde un número de prueba habilitado en Meta. El CRM crea un contacto y una conversación sin asignar para esa identidad de WhatsApp.
2. Entra como administrador y asigna la conversación. El administrador también puede transferirla a otro vendedor activo. El vendedor anterior pierde acceso a la conversación y sus adjuntos cuando la asignación cambia.
3. Responde desde la bandeja durante la ventana de 24 horas desde el último mensaje del cliente. Los estados de Meta se incorporan al historial. Ante una entrega sin confirmar, consulta el historial antes de iniciar un envío nuevo.
4. Envía una imagen o un documento desde el número de prueba. Los archivos de hasta 20 MiB se guardan en un bucket privado. El CRM genera un enlace de descarga con una vigencia de 60 segundos para los agentes autorizados.
5. Con una sesión del CRM abierta, los mensajes nuevos visibles para esa sesión generan una notificación y actualizan la bandeja mediante Supabase Realtime.

El modo de prueba del repositorio usa eventos simulados y una base de datos local. La prueba con Meta requiere completar la configuración anterior.

## Referencias

- [WhatsApp Business Platform de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/)
- [Webhooks de Meta](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)
- [Secretos de Supabase Edge Functions](https://supabase.com/docs/guides/functions/secrets)
