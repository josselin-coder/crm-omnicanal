# Fase 3 · Asistente comercial

## Simulador

Abre **Bandeja → Abrir simulador**. Introduce un mensaje ficticio, simula un adjunto escribiendo su nombre y avanza turno por turno. Puedes fijar la hora de Lima para probar el saludo, activar el modelo configurado o probar con reglas, y tomar el control. La simulación registra decisiones internas y no crea mensajes de WhatsApp.

## Observación

En una conversación real de WhatsApp, el vendedor asignado o un administrador puede seleccionar **Iniciar observación**. El modo está apagado por defecto. Cada mensaje recibido se guarda primero y luego puede iniciar el análisis de la conversación existente. **Actualizar análisis** permite recuperar una observación pendiente si falla el procesamiento en segundo plano.

El asistente extrae nombre, servicio, cantidad y adjuntos entregados. Si hay intención de compra o una solicitud de precio o de atención humana, registra un resumen y deriva al asesor. Conserva la asignación si el vendedor está activo. En conversaciones sin un vendedor activo, elige un vendedor no administrador con menor carga de conversaciones activas. Cuando no hay un vendedor disponible, la derivación queda para los administradores.

Tomar el control o reservar una respuesta manual en la bandeja detiene el análisis. Una observación que ya estaba en curso pierde la autorización de guardar sus resultados cuando entra un mensaje nuevo o el vendedor toma el control. Las ventas confirmadas manualmente conservan su estado.

## Configuración del modelo y límites

Define `OPENAI_API_KEY` y `OPENAI_ASSISTANT_MODEL` como secretos de Edge Functions en Supabase para usar un modelo compatible con Structured Outputs. Sin esa configuración, o si el proveedor falla, el servidor usa reglas y registra el motor utilizado. El modelo recibe texto del historial con accesos directos a teléfonos y correos redactados, y únicamente el tipo y la extensión de los adjuntos. El CRM no envía archivos al modelo.

Se analiza el historial completo hasta 200 mensajes y 50 000 caracteres. Los historiales mayores se derivan para revisión humana. Las decisiones guardan la clasificación, el motivo y los datos recopilados. El servidor aplica plantillas fijas para las sugerencias. El asistente carece de una operación para enviar mensajes, calcular precios, generar cotizaciones o cerrar ventas. El vendedor conserva el envío y el cierre.

Aplica las migraciones y despliega `crm-assistant` y la versión actualizada de `whatsapp-webhook` desde un entorno autorizado antes de probar observación real.

- [Structured Outputs de OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Secretos de Supabase Edge Functions](https://supabase.com/docs/guides/functions/secrets)
