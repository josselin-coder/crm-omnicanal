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
    expect(proposalFor(decide([customer("Hola")], new Date(date)).action)).toBe(expected);
  });

  it("asks the service as an open question after finding the name", () => {
    const decision = decide([customer("Hola"), suggested("Buenos días. ¿Cuál es tu nombre?"), customer("Lucía")], when);
    expect(decision.facts.name).toBe("Lucía");
    expect(proposalFor(decision.action)).toBe("¿Qué servicio necesitas realizar?");
  });

  it.each([
    ["Necesito hacer un corte láser", "corte_laser", "ask_dxf"],
    ["Necesito grabar madera", "grabado", "ask_dxf"],
    ["Quiero un mecanizado CNC", "cnc", "ask_cnc_file"],
    ["Busco impresión 3D", "impresion_3d", "ask_3d_file"],
  ])("identifies %s and asks for the appropriate file", (text, service, action) => {
    const result = decide([customer("Me llamo Ana."), customer(text)], when);
    expect(result.facts.service).toBe(service);
    expect(result.action).toBe(action);
  });

  it("asks for a reference without a design, followed by a missing quantity", () => {
    const transcript = [customer("Me llamo Ana."), customer("Quiero impresión 3D y no tengo diseño")];
    expect(decide(transcript, when).action).toBe("ask_reference");
    transcript.push({ role: "customer", text: "", attachment: { name: "guía.png", kind: "image" } });
    expect(decide(transcript, when).action).toBe("ask_quantity");
    transcript.push(suggested("¿Cuántas unidades necesitas?"), customer("cinco"));
    const result = decide(transcript, when);
    expect(result.facts).toEqual({ name: "Ana", service: "impresion_3d", quantity: 5, files: ["guía.png"] });
    expect(result.action).toBe("acknowledge");
  });

  it("preserves the quantity from previous turns and verifies the file extension", () => {
    const transcript = [
      customer("Soy Luz. Necesito 20 placas de corte láser."),
      { ...customer("Te envío el documento"), attachment: { name: "plano.pdf", kind: "document" } },
    ];
    expect(decide(transcript, when).action).toBe("ask_dxf");
    transcript.push({ ...customer("Adjunto el diseño"), attachment: { name: "plano.DXF", kind: "document" } });
    expect(decide(transcript, when).action).toBe("acknowledge");
    expect(decide(transcript, when).facts.quantity).toBe(20);
  });

  it.each([
    ["¿Cuánto cuesta?", "price_request"],
    ["¿Me atiende una persona? Quisiera hablar con un asesor.", "human_request"],
    ["Quiero encargar el pedido", "purchase_intent"],
  ])("hands off %s without outputting a reply", (text, reason) => {
    const decision = decide([customer("Me llamo Luz. Necesito 20 piezas de CNC."), customer(text)], when);
    expect(decision.reason).toBe(reason);
    expect(decision.classification).toBe("listo_para_ventas");
    expect(decision.facts.quantity).toBe(20);
    expect(proposalFor(decision.action)).toBeNull();
  });

  it("stops when a seller takes control, even for a price request", () => {
    const decision = decide([customer("¿Qué precio tiene?")], when, { stopped: true });
    expect(decision.action).toBe("stopped");
    expect(proposalFor(decision.action)).toBeNull();
  });

  it("rejects untrusted actions and model fields that could carry free-form proposals", () => {
    const extraction = {
      name: "Luz", service: "cnc", quantity: 20, noDesign: false,
      intent: "interesado", humanRequested: false, priceRequested: false,
    };
    expect(validateExtraction(extraction)).toEqual(extraction);
    expect(validateExtraction({ ...extraction, reply: "Son S/ 300" })).toBeUndefined();
    expect(validateExtraction({ ...extraction, intent: "comprado" })).toBeUndefined();
    expect(proposalFor("Ofrece un precio")).toBeNull();
    expect(proposalFor("constructor")).toBeNull();
    expect(decide([customer("Quiero grabado")], when, { model: validateExtraction(extraction) }).facts.quantity).toBeNull();
  });
});
