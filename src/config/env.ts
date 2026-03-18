import { resolve } from 'node:path';

import { z } from 'zod/v4';

const envSchema = z
  .object({
    JOB_BOT_HOST: z.string().default('0.0.0.0'),
    JOB_BOT_PORT: z.coerce.number().int().positive().default(3000),
    JOB_BOT_DATA_DIR: z.string().default('./data'),
    JOB_BOT_APPLY_SCHEMA_ON_BOOT: z
      .string()
      .optional()
      .transform((value) => value === 'true'),

    AI_GATEWAY_API_KEY: z.string().min(1, 'AI_GATEWAY_API_KEY is required'),
    MAIN_AGENT_MODEL: z.string().default('openai/gpt-5.2'),
    SEARCH_AGENT_MODEL: z.string().default('openai/gpt-5.2-chat'),
    EXA_API_KEY: z.string().min(1, 'EXA_API_KEY is required'),

    SURREAL_URL: z.string().url('SURREAL_URL must be a valid URL'),
    SURREAL_NAMESPACE: z.string().min(1, 'SURREAL_NAMESPACE is required'),
    SURREAL_DATABASE: z.string().min(1, 'SURREAL_DATABASE is required'),
    SURREAL_USERNAME: z.string().min(1, 'SURREAL_USERNAME is required'),
    SURREAL_PASSWORD: z.string().min(1, 'SURREAL_PASSWORD is required'),

    WHATSAPP_SESSION_ID: z.string().default('job-bot'),
    WHATSAPP_PAIRING_PHONE_NUMBER: z.string().optional(),
    WHATSAPP_USE_PAIRING_CODE: z
      .string()
      .optional()
      .transform((value) => value === 'true'),

    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    PUBLIC_URL: z.string().optional(),
  });

export type Env = ReturnType<typeof loadEnv>;

export function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${messages.join('\n')}`);
  }

  return {
    host: parsed.data.JOB_BOT_HOST,
    port: parsed.data.JOB_BOT_PORT,
    dataDir: resolve(process.cwd(), parsed.data.JOB_BOT_DATA_DIR),
    applySchemaOnBoot: parsed.data.JOB_BOT_APPLY_SCHEMA_ON_BOOT,
    aiGatewayApiKey: parsed.data.AI_GATEWAY_API_KEY,
    mainAgentModel: parsed.data.MAIN_AGENT_MODEL,
    searchAgentModel: parsed.data.SEARCH_AGENT_MODEL,
    exaApiKey: parsed.data.EXA_API_KEY,
    surreal: {
      url: parsed.data.SURREAL_URL,
      namespace: parsed.data.SURREAL_NAMESPACE,
      database: parsed.data.SURREAL_DATABASE,
      username: parsed.data.SURREAL_USERNAME,
      password: parsed.data.SURREAL_PASSWORD,
    },
    whatsapp: {
      sessionId: parsed.data.WHATSAPP_SESSION_ID,
      pairingPhoneNumber: parsed.data.WHATSAPP_PAIRING_PHONE_NUMBER,
      usePairingCode: parsed.data.WHATSAPP_USE_PAIRING_CODE,
    },
    broadcastWindow: {
      startUtcHour: 15,
      durationMinutes: 120,
    },
    stripe: {
      secretKey: parsed.data.STRIPE_SECRET_KEY,
      webhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
    },
    publicUrl: parsed.data.PUBLIC_URL ?? '',
  };
}
