import { env } from "./config/env.js";

function bootstrap(): void {
  console.log("OSS Royalty Layer scaffold started");
  console.log(`Environment: ${env.NODE_ENV}`);
}

try {
  bootstrap();
} catch (error) {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("Failed to start OSS Royalty Layer. Check environment configuration.", details);
  process.exit(1);
}
