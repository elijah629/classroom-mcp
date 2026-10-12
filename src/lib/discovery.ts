import stable from "./discovery/stable.json";

export interface DiscoverySchema {
  $ref?: string;
  type?: string;
  description?: string;
  properties?: Record<string, DiscoverySchema>;
  additionalProperties?: DiscoverySchema | boolean;
  items?: DiscoverySchema;
  enum?: string[];
  enumDescriptions?: string[];
  required?: boolean | string[];
  repeated?: boolean;
  readOnly?: boolean;
  location?: string;
  format?: string;
  minimum?: string | number;
  maximum?: string | number;
  pattern?: string;
}
export interface DiscoveryMethod {
  id: string;
  path: string;
  httpMethod: string;
  description: string;
  parameters?: Record<string, DiscoverySchema>;
  request?: DiscoverySchema;
  response?: DiscoverySchema;
  scopes?: string[];
}
export interface DiscoveryDocument {
  revision: string;
  rootUrl: string;
  schemas: Record<string, DiscoverySchema>;
  parameters: Record<string, DiscoverySchema>;
  resources?: Record<string, DiscoveryResource>;
  methods?: Record<string, DiscoveryMethod>;
  auth: { oauth2: { scopes: Record<string, { description: string }> } };
}
interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}
export const stableDiscovery = stable as unknown as DiscoveryDocument;
export function flattenMethods(resource: DiscoveryResource): DiscoveryMethod[] {
  return [
    ...Object.values(resource.methods ?? {}),
    ...Object.values(resource.resources ?? {}).flatMap(flattenMethods),
  ].sort((a, b) => a.id.localeCompare(b.id));
}
export const stableMethods = flattenMethods(stableDiscovery);
export const allMethods = new Map(
  stableMethods.map((method) => [method.id, method]),
);
export const discoverySchemas = stableDiscovery.schemas;
export const classroomScopes = Object.keys(
  stableDiscovery.auth.oauth2.scopes,
).sort();

export type JsonSchema = {
  [key: string]: unknown;
  properties?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
};
// Discovery uses an older schema dialect and singular `required` on parameters.
// Convert without losing fields, enums, recursive references or map value types.
export function methodInputSchema(method: DiscoveryMethod): JsonSchema {
  const definitions: Record<string, JsonSchema> = {};
  const sourceSchemas = discoverySchemas;
  function convert(source: DiscoverySchema): JsonSchema {
    if (source.$ref) {
      const name = source.$ref;
      if (!(name in definitions)) {
        const referenced = sourceSchemas[name];
        if (!referenced)
          throw new Error(`Unresolved Discovery schema: ${name}`);
        definitions[name] = {};
        definitions[name] = convert(referenced);
      }
      return {
        $ref: `#/$defs/${name}`,
        ...(source.description ? { description: source.description } : {}),
      };
    }
    const result: JsonSchema = {};
    if (source.type && source.type !== "any") result.type = source.type;
    if (source.description) result.description = source.description;
    if (source.enum) result.enum = source.enum;
    if (source.enumDescriptions)
      result["x-enumDescriptions"] = source.enumDescriptions;
    if (source.pattern) result.pattern = source.pattern;
    if (source.readOnly) result.readOnly = true;
    if (source.format) result["x-google-format"] = source.format;
    for (const key of ["minimum", "maximum"] as const) {
      if (source[key] !== undefined) result[key] = Number(source[key]);
    }
    if (source.properties)
      result.properties = Object.fromEntries(
        Object.entries(source.properties).map(([key, value]) => [
          key,
          convert(value),
        ]),
      );
    if (Array.isArray(source.required)) result.required = source.required;
    if (source.items) result.items = convert(source.items);
    if (source.additionalProperties !== undefined)
      result.additionalProperties =
        typeof source.additionalProperties === "boolean"
          ? source.additionalProperties
          : convert(source.additionalProperties);
    if (source.repeated)
      return { type: "array", items: result, description: source.description };
    return result;
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  // Authentication is server owned. JSONP/upload/alternate wire formats do not
  // apply to Classroom's JSON REST actions; keep useful global query controls.
  const globals = Object.fromEntries(
    Object.entries(stableDiscovery.parameters).filter(([key]) =>
      ["fields", "quotaUser", "prettyPrint", "$.xgafv"].includes(key),
    ),
  );
  for (const [name, parameter] of Object.entries({
    ...globals,
    ...method.parameters,
  })) {
    properties[name] = convert(parameter);
    if (parameter.required === true) required.push(name);
  }
  if (method.request) {
    properties.body = convert(method.request);
    required.push("body");
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
  };
}
