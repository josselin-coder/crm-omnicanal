export const services = [
  "corte_laser",
  "grabado",
  "cnc",
  "impresion_3d",
] as const;
export const intentValues = [
  "nuevo",
  "interesado",
  "indeciso",
  "listo_para_ventas",
  "descartado",
] as const;

export type Service = (typeof services)[number];
export type Intent = (typeof intentValues)[number];
export type Turn = {
  role: "customer" | "seller" | "assistant";
  text: string;
  attachment?: { name: string; kind: string } | null;
};

const proposals = {
  greet_morning: "Buenos días. ¿Cuál es tu nombre?",
  greet_afternoon: "Buenas tardes. ¿Cuál es tu nombre?",
  greet_evening: "Buenas noches. ¿Cuál es tu nombre?",
  ask_service: "¿Qué servicio necesitas realizar?",
  ask_dxf: "¿Puedes compartir tu archivo DXF?",
  ask_3d_file: "¿Puedes compartir tu archivo STL, OBJ o STEP?",
  ask_cnc_file: "¿Puedes compartir el archivo técnico de la pieza para CNC?",
  ask_reference: "¿Puedes compartir una imagen de referencia?",
  ask_quantity: "¿Cuántas unidades necesitas?",
  acknowledge: "Gracias por la información. La dejamos registrada.",
  handoff: null,
  stopped: null,
} as const;

export type Action = keyof typeof proposals;
export type Reason =
  | "next_question"
  | "waiting"
  | "price_request"
  | "human_request"
  | "purchase_intent"
  | "history_limit"
  | "human_control"
  | "declined";
export type Engine = "rules" | "model" | "rules_fallback";
export type Extraction = {
  name: string | null;
  service: Service | null;
  quantity: number | null;
  noDesign: boolean;
  intent: Intent;
  humanRequested: boolean;
  priceRequested: boolean;
};
export type Decision = {
  action: Action;
  classification: Intent;
  reason: Reason;
  engine: Engine;
  facts: {
    name: string | null;
    service: Service | null;
    quantity: number | null;
    files: string[];
  };
};

export const historyLimit = { turns: 200, characters: 50_000 };

const normalize = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const namePattern =
  /^[\p{L}][\p{L}\p{M}'’-]*(?: [\p{L}][\p{L}\p{M}'’-]*){0,3}$/u;
const explicitName =
  /(?:me llamo|mi nombre es|soy)\s+([\p{L}][\p{L}\p{M}'’-]*(?: +[\p{L}][\p{L}\p{M}'’-]*){0,3})/iu;
const nameBoundary = /\s+(?:y|pero|quiero|necesito|busco|de la empresa)\b/i;
const pricePattern =
  /\b(?:precios?|cotiz\w*|presupuesto|costos?|tarifas?|cuanto\s+(?:cuesta|sale|vale|cobran)|que\s+(?:cuesta|valor\s+tiene)|cuanto\s+(?:es|seria)\s+(?:el total|por))\b/;
const humanPattern =
  /\b(?:asesor(?:a)?|vendedor(?:a)?|atencion\s+humana|hablar\s+(?:con\s+)?(?:una\s+)?persona|hablar\s+con\s+alguien|atenderme\s+alguien)\b/;
const purchasePattern =
  /\b(?:quiero\s+(?:comprar|pedir|encargar|hacer\s+el\s+pedido|ordenar|pagar|confirmar)|confirmo|hagan\s+el\s+pedido|hagamos\s+el\s+pedido|como\s+(?:pago|compro|hago\s+el\s+pedido)|ya\s+pague|voy\s+a\s+comprar|puedo\s+encargar)\b/;
const noDesignPattern =
  /\b(?:no\s+(?:tengo|cuento\s+con|tiene|hay|dispongo\s+de)\s+(?:un\s+|el\s+|mi\s+)?(?:archivo|diseno|modelo|plano|dxf|stl|obj|step)|sin\s+(?:archivo|diseno|modelo)|solo\s+tengo\s+(?:una\s+)?(?:imagen|foto))\b/;

function getService(text: string): Service | null {
  if (
    /\b(?:impr(?:esion|imir|eso|esora)\s*(?:en\s*)?3d|prototipo\s*3d|stl|step)\b/.test(
      text,
    )
  )
    return "impresion_3d";
  if (/\b(?:cnc|fresad[oa]|router|mecanizad[oa]|tornead[oa])\b/.test(text))
    return "cnc";
  if (/\b(?:grabad[oa]|grabar|grabame|grabamos|marcado\s+laser)\b/.test(text))
    return "grabado";
  if (
    /\b(?:corte\s*(?:con\s*|a\s*|de\s*)?laser|cortar|corten|corte|cortado)\b/.test(
      text,
    )
  )
    return "corte_laser";
  return null;
}

const numberWords: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  veinte: 20,
  treinta: 30,
  cincuenta: 50,
  cien: 100,
};

const quantityToken = "\\d{1,6}|" + Object.keys(numberWords).join("|");
const countPattern = new RegExp(
  `\\b(${quantityToken})\\s+(?:unidades?|piezas?|copias?|ejemplares?|placas?|llaveros?|letreros?|figuras?|muestras?|items?)\\b`,
  "g",
);
const explicitQuantity = new RegExp(
  `\\b(?:cantidad|serian|seran|necesito|quiero)[:\\s]+(${quantityToken})(?=\\s*$|[.!?]\\s*$)`,
  "g",
);

function toQuantity(token: string): number | null {
  const value = numberWords[token] ?? Number(token);
  return Number.isInteger(value) && value > 0 && value <= 999999 ? value : null;
}

function countFromText(text: string) {
  const matches = [
    ...text.matchAll(countPattern),
    ...text.matchAll(explicitQuantity),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  return matches.length ? toQuantity(matches.at(-1)![1]) : null;
}

function normalizedName(candidate: string) {
  const name = candidate.trim().replace(/\s+/g, " ");
  if (
    name.length > 70 ||
    !namePattern.test(name) ||
    /\b(?:hola|buenos|buenas|cliente|persona|archivo|diseno|cotiza|precio)\b/.test(
      normalize(name),
    )
  )
    return null;
  return name;
}

function greeting(now: Date): Action {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Lima",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  if (hour >= 6 && hour < 12) return "greet_morning";
  if (hour >= 12 && hour < 19) return "greet_afternoon";
  return "greet_evening";
}

export function proposalFor(action: unknown): string | null {
  return typeof action === "string" && Object.hasOwn(proposals, action)
    ? proposals[action as Action]
    : null;
}

export function decide(
  turns: Turn[],
  now: Date,
  options: {
    model?: Extraction;
    engine?: Engine;
    stopped?: boolean;
    overflow?: boolean;
  } = {},
): Decision {
  let name: string | null = null;
  let service: Service | null = null;
  let quantity: number | null = null;
  let noDesign = false;
  let lastQuestion: string | undefined;
  const customer = turns.filter((turn) => turn.role === "customer");
  const customerText = customer.map((turn) => normalize(turn.text)).join("\n");
  const evidence = new Set<number>();

  for (const turn of turns) {
    if (turn.role !== "customer") {
      lastQuestion = normalize(turn.text);
      continue;
    }
    const text = normalize(turn.text);
    const statedName = turn.text
      .match(explicitName)?.[1]
      ?.split(nameBoundary)[0];
    const directName = lastQuestion?.includes("tu nombre") ? turn.text : null;
    const foundName = normalizedName(statedName ?? directName ?? "");
    if (foundName) name = foundName;
    service = getService(text) ?? service;
    let count = countFromText(text);
    if (!count && lastQuestion?.includes("cuantas unidades"))
      count = toQuantity(text.trim());
    if (count) quantity = count;
    for (const match of text.matchAll(
      new RegExp(`\\b(${quantityToken})\\b`, "g"),
    )) {
      const possible = toQuantity(match[1]);
      if (possible && !pricePattern.test(text)) evidence.add(possible);
    }
    noDesign ||=
      noDesignPattern.test(text) ||
      Boolean(
        lastQuestion?.includes("archivo") &&
        /^(?:no|aun no|todavia no|no lo tengo|no tengo)[.!]?$/i.test(
          text.trim(),
        ),
      );
    lastQuestion = undefined;
  }

  const model = options.model;
  if (model?.name && normalize(customerText).includes(normalize(model.name))) {
    name ??= normalizedName(model.name);
  }
  service ??= model?.service ?? null;
  if (quantity === null && model?.quantity && evidence.has(model.quantity)) {
    quantity = model.quantity;
  }
  noDesign ||= model?.noDesign ?? false;

  const attachments = customer.flatMap(({ attachment }) =>
    attachment?.name ? [attachment] : [],
  );
  const files = [...new Set(attachments.map(({ name }) => name))];
  const facts = { name, service, quantity, files };
  const engine = options.engine ?? "rules";
  const result = (
    action: Action,
    classification: Intent,
    reason: Reason,
  ): Decision => ({ action, classification, reason, engine, facts });

  if (options.stopped) return result("stopped", "nuevo", "human_control");
  if (options.overflow) return result("handoff", "indeciso", "history_limit");
  if (humanPattern.test(customerText) || model?.humanRequested)
    return result("handoff", "listo_para_ventas", "human_request");
  if (pricePattern.test(customerText) || model?.priceRequested)
    return result("handoff", "listo_para_ventas", "price_request");
  if (
    purchasePattern.test(customerText) ||
    model?.intent === "listo_para_ventas"
  )
    return result("handoff", "listo_para_ventas", "purchase_intent");

  const lastCustomerText = normalize(customer.at(-1)?.text ?? "");
  if (
    model?.intent === "descartado" ||
    /\b(?:ya no me interesa|cancela mi solicitud|no deseo continuar|ya no lo necesito)\b/.test(
      lastCustomerText,
    )
  )
    return result("stopped", "descartado", "declined");

  const classification =
    model?.intent === "indeciso" ||
    /\b(?:no estoy segur[oa]|estoy evaluando|aun no decido|estoy comparando)\b/.test(
      lastCustomerText,
    )
      ? "indeciso"
      : service || files.length > 0 || model?.intent === "interesado"
        ? "interesado"
        : "nuevo";

  if (!name) return result(greeting(now), classification, "next_question");
  if (!service) return result("ask_service", classification, "next_question");

  const reference = attachments.some(
    ({ name, kind }) =>
      kind === "image" || /\.(?:png|jpe?g|webp|gif|heic)$/i.test(name),
  );
  const technicalFile = attachments.some(({ name, kind }) => {
    if (service === "impresion_3d") return /\.(?:stl|obj|step)$/i.test(name);
    if (service === "cnc")
      return (
        kind === "document" && !/\.(?:png|jpe?g|webp|gif|heic)$/i.test(name)
      );
    return /\.dxf$/i.test(name);
  });
  if (!technicalFile) {
    if (noDesign && !reference)
      return result("ask_reference", classification, "next_question");
    if (!noDesign) {
      const action =
        service === "impresion_3d"
          ? "ask_3d_file"
          : service === "cnc"
            ? "ask_cnc_file"
            : "ask_dxf";
      return result(action, classification, "next_question");
    }
  }
  if (quantity === null)
    return result("ask_quantity", classification, "next_question");
  return result("acknowledge", classification, "waiting");
}
