/**
 * 最小 Zod → JSON Schema 转换器（V3.0）。
 *
 * 为什么要自己写：
 *  项目未引入 `zod-to-json-schema` 依赖，而 V3.0 要求把**同一份** Zod 领域 schema
 *  下发给支持 Structured Outputs 的 Provider（OpenAI `json_schema` / Gemini `responseSchema`）。
 *  如果不转换，就必须手写第二套结构 —— 那正是 V3.0 明令禁止的「一个领域两套 schema」。
 *
 * 覆盖本项目实际用到的 Zod 能力：
 *  object / array / string / number / integer / boolean / enum / optional / default / union(轻量)
 *  `default()` 会被忽略为 required=false（JSON Schema 不含默认值语义）。
 */

import { z } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
}

/** 取被 ZodDefault / ZodOptional 包裹的内层类型 */
function unwrap(def: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let cur: z.ZodTypeAny = def;
  let optional = false;
  // 最多解 6 层，防御性上限
  for (let i = 0; i < 6; i++) {
    const name = cur._def?.typeName;
    if (name === 'ZodOptional' || name === 'ZodNullable' || name === 'ZodDefault') {
      optional = true;
      cur = cur._def.innerType as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return { inner: cur, optional };
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { inner } = unwrap(schema);
  const def = inner._def;
  const typeName: string = def?.typeName ?? 'ZodAny';
  const description: string | undefined = def?.description;

  switch (typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      if (description) out.description = description;
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      for (const c of checks) {
        if (c.kind === 'max') out.maxLength = c.value;
        if (c.kind === 'min') out.minLength = c.value;
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: typeName === 'ZodNumber' ? 'number' : 'number' };
      if (description) out.description = description;
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      for (const c of checks) {
        if (c.kind === 'max') out.maximum = c.value;
        if (c.kind === 'min') out.minimum = c.value;
      }
      return out;
    }
    case 'ZodBigInt':
      return { type: 'integer' };
    case 'ZodBoolean':
      return description ? { type: 'boolean', description } : { type: 'boolean' };
    case 'ZodEnum': {
      const values = def.values as string[];
      return { type: 'string', enum: values };
    }
    case 'ZodNativeEnum': {
      const enumObj = def.values as Record<string, string | number>;
      const values = Object.values(enumObj).filter((v) => typeof v === 'string') as string[];
      return { type: 'string', enum: values };
    }
    case 'ZodLiteral': {
      const v = def.value;
      return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string', enum: [v] };
    }
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(def.type as z.ZodTypeAny) };
      if (description) out.description = description;
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      for (const c of checks) {
        if (c.kind === 'max') out.maxItems = c.value;
        if (c.kind === 'min') out.minItems = c.value;
      }
      return out;
    }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(field);
        const { optional } = unwrap(field);
        if (!optional) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
      // Structured Outputs（strict 模式）要求 required 覆盖所有 key；
      // 这里保留真实 required，由调用方决定 strict。
      if (required.length) out.required = required;
      if (description) out.description = description;
      return out;
    }
    case 'ZodUnion': {
      const options = (def.options as z.ZodTypeAny[]).map((o) => zodToJsonSchema(o));
      return { anyOf: options };
    }
    case 'ZodRecord': {
      // Record<string, unknown> —— OpenAI strict 模式不接受自由对象
      return { type: 'object', additionalProperties: true };
    }
    case 'ZodUnknown':
    case 'ZodAny':
      return { type: 'string', description: '（任意值，已降级为字符串）' };
    case 'ZodEffects':
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    default:
      return { type: 'string' };
  }
}

/**
 * 生成「strict 模式」JSON Schema：
 *  所有 object 的 required 必须列出全部 properties（OpenAI Structured Outputs 硬要求）。
 * 可选字段用 `type: [..., 'null']` 表达可空。
 */
export function zodToStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const base = zodToJsonSchema(schema);
  return makeStrict(base);
}

function makeStrict(node: JsonSchema): JsonSchema {
  if (node.type === 'object' && node.properties) {
    const properties: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(node.properties)) {
      properties[k] = makeStrict(v);
    }
    return {
      ...node,
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (node.type === 'array' && node.items) {
    return { ...node, items: makeStrict(node.items) };
  }
  if (node.anyOf) {
    return { ...node, anyOf: node.anyOf.map(makeStrict) };
  }
  return node;
}
