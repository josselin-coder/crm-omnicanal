import { describe, expect, it } from "vitest";
import { decide, proposalFor, type Turn } from "./assistant";
import { validateExtraction } from "./assistantModel";

const when = new Date("2026-11-22T14:00:00Z");
const customer = (text: string): Turn => ({ role: "customer", text });
const suggested = (text: string): Turn => ({ role: "assistant", text });

describe("Commercial assistant", () => {
  it.each([
    ["2026-11-22T14:00:00Z", "Buenos días. ¿Cuál es tu nombre?"],
    ["2026-11-22T20:00:00Z", "Buenas tardes. ¿Cuál es tu nombre?"],
    ["2026-11-23T02:00:00Z", "Buenas noches. ¿Cuál es tu nombre?"],
  ])("uses Lima time at %s", (date, expected) => {
    expect(proposalFor(decide([customer("Hola")], new Date(date)).action)).toBe(
      expected,
    );
  });

  it("asks the service as an open question after finding the name", () => {
    const decision = decide(
      [
        customer("Hola"),
        suggested("Buenos días. ¿Cuál es tu nombre?"),
        customer("Lucía"),
      ],
      when,
    );
    expect(decision.facts.name).toBe("Lucía");
    expect(proposalFor(decision.action)).toBe(
      "¿Qué servicio necesitas realizar?",
    );
  });

  it.each([
    ["Necesito hacer un corte láser", "corte_laser", "ask_dxf"],
    ["Necesito grabar madera", "grabado", "ask_dxf"],
    ["Quiero un mecanizado CNC", "cnc", "ask_cnc_file"],
    ["Busco impresión 3D", "impresion_3d", "ask_3d_file"],
  ])(
    "identifies %s and asks for the appropriate file",
    (text, service, action) => {
      const result = decide([customer("Me llamo Ana."), customer(text)], when);
      expect(result.facts.service).toBe(service);
      expect(result.action).toBe(action);
    },
  );

  it("asks for a reference without a design, followed by a missing quantity", () => {
    const transcript = [
      customer("Me llamo Ana."),
      customer("Quiero impresión 3D y no tengo diseño"),
    ];
    expect(decide(transcript, when).action).toBe("ask_reference");
    transcript.push({
      role: "customer",
      text: "",
      attachment: { name: "guía.png", kind: "image" },
    });
    expect(decide(transcript, when).action).toBe("ask_quantity");
    transcript.push(
      suggested("¿Cuántas unidades necesitas?"),
      customer("cinco"),
    );
    const result = decide(transcript, when);
    expect(result.facts).toEqual({
      name: "Ana",
      service: "impresion_3d",
      quantity: 5,
      files: ["guía.png"],
    });
    expect(result.action).toBe("handoff");
  });

  it("asks for a reference when the customer declines to provide the file", () => {
    const transcript = [
      customer("Soy Ana. Necesito un corte láser."),
      suggested("¿Puedes compartir tu archivo DXF?"),
      customer("No lo tengo."),
    ];
    expect(decide(transcript, when).action).toBe("ask_reference");
  });

  it("preserves the quantity from previous turns and verifies the file extension", () => {
    const transcript = [
      customer("Soy Luz. Necesito 20 placas de corte láser."),
      {
        ...customer("Te envío el documento"),
        attachment: { name: "plano.pdf", kind: "document" },
      },
    ];
    expect(decide(transcript, when).action).toBe("ask_dxf");
    transcript.push({
      ...customer("Adjunto el diseño"),
      attachment: { name: "plano.DXF", kind: "document" },
    });
    expect(decide(transcript, when).action).toBe("handoff");
    expect(decide(transcript, when).facts.quantity).toBe(20);
  });

  it.each([
    ["¿Cuánto cuesta?", "price_request"],
    [
      "¿Me atiende una persona? Quisiera hablar con un asesor.",
      "human_request",
    ],
    ["Quiero encargar el pedido", "purchase_intent"],
  ])("hands off %s without outputting a reply", (text, reason) => {
    const decision = decide(
      [customer("Me llamo Luz. Necesito 20 piezas de CNC."), customer(text)],
      when,
    );
    expect(decision.reason).toBe(reason);
    expect(decision.classification).toBe("listo_para_ventas");
    expect(decision.facts.quantity).toBe(20);
    expect(proposalFor(decision.action)).toBeNull();
  });

  it("accepts a spontaneous image and asks only for the missing quantity", () => {
    const transcript: Turn[] = [
      customer("Soy Luz. Necesito grabar madera."),
      {
        ...customer("Esta es mi referencia"),
        attachment: { name: "referencia.jpg", kind: "image" },
      },
    ];
    expect(decide(transcript, when).action).toBe("ask_quantity");
    transcript.push(suggested("¿Cuántas unidades necesitas?"), customer("20"));
    const decision = decide(transcript, when);
    expect(decision).toMatchObject({
      action: "handoff",
      classification: "listo_para_ventas",
      reason: "brief_complete",
      facts: { quantity: 20, files: ["referencia.jpg"] },
    });
    expect(proposalFor(decision.action)).toBeNull();
  });

  it("hands off a complete brief even when the customer did not give a name", () => {
    const decision = decide(
      [
        customer("Necesito grabado de 12 placas."),
        {
          ...customer("Adjunto el diseño"),
          attachment: { name: "placa.dxf", kind: "document" },
        },
      ],
      when,
    );
    expect(decision.reason).toBe("brief_complete");
    expect(decision.classification).toBe("listo_para_ventas");
  });

  it("uses the latest rejection instead of previous requests for price or purchase", () => {
    const transcript = [
      customer("¿Me cotizas un grabado?"),
      customer("Quiero comprar 10 placas, ¿puedo hablar con un asesor?"),
      customer("Ya no me interesa, cancela mi solicitud."),
      customer("Gracias."),
    ];
    const decision = decide(transcript, when, {
      afterHandoff: true,
      model: {
        name: null,
        service: "grabado",
        quantity: 10,
        noDesign: false,
        intent: "listo_para_ventas",
        humanRequested: true,
        priceRequested: false,
        decisionTurn: 1,
      },
    });
    expect(decision.classification).toBe("descartado");
    expect(decision.reason).toBe("declined");
    expect(proposalFor(decision.action)).toBeNull();
    transcript.push(customer("Cambié de opinión. Quiero encargar el pedido."));
    expect(
      decide(transcript, when, { afterHandoff: true }).classification,
    ).toBe("listo_para_ventas");
  });

  it("uses a newer model interpretation only when it points to a customer turn", () => {
    const transcript = [
      customer("¿Cuánto cuesta?"),
      customer("Prefiero dejar esto aquí."),
      suggested("Anotado."),
    ];
    const model = {
      name: null,
      service: null,
      quantity: null,
      noDesign: false,
      intent: "descartado" as const,
      humanRequested: false,
      priceRequested: false,
      decisionTurn: 1,
    };
    expect(decide(transcript, when, { model }).classification).toBe(
      "descartado",
    );
    expect(
      decide(transcript, when, { model: { ...model, decisionTurn: 2 } }).reason,
    ).toBe("price_request");
  });

  it("stops when a seller takes control, even for a price request", () => {
    const decision = decide([customer("¿Qué precio tiene?")], when, {
      stopped: true,
    });
    expect(decision.action).toBe("stopped");
    expect(proposalFor(decision.action)).toBeNull();
  });

  it("rejects untrusted actions and model fields that could carry free-form proposals", () => {
    const extraction = {
      name: "Luz",
      service: "cnc",
      quantity: 20,
      noDesign: false,
      intent: "interesado",
      humanRequested: false,
      priceRequested: false,
      decisionTurn: null,
    };
    expect(validateExtraction(extraction)).toEqual(extraction);
    expect(
      validateExtraction({ ...extraction, reply: "Son S/ 300" }),
    ).toBeUndefined();
    expect(
      validateExtraction({ ...extraction, intent: "comprado" }),
    ).toBeUndefined();
    expect(proposalFor("Ofrece un precio")).toBeNull();
    expect(proposalFor("constructor")).toBeNull();
    expect(
      decide([customer("Quiero grabado")], when, {
        model: validateExtraction(extraction),
      }).facts.quantity,
    ).toBeNull();
  });
});
