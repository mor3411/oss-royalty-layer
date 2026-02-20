import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { CurrencyCodeSchema } from "../shared/currency.js";

loadDotEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEFAULT_CURRENCY: CurrencyCodeSchema.default("USD"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export const env: AppEnv = EnvSchema.parse(process.env);
