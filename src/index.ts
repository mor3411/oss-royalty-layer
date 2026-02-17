import { env } from "./config/env.js";

function bootstrap(): void {
  console.log("OSS Royalty Layer scaffold started");
  console.log(`Environment: ${env.NODE_ENV}`);
}

bootstrap();
