import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function main() {
  const org = await prisma.organization.create({
    data: {
      name: "Acme Inc",
      plan: "PRO",
      featureFlags: {
        semantic_cache: true,
        streaming: true,
        rate_limit_rpm: 1000,
        allowed_models: ["gpt-4o", "claude-3-5-sonnet"],
        request_dedup: false,
      },
    },
  });

  await prisma.user.create({
    data: {
      email: "owner@acme.test",
      // placeholder - real auth service hashes with bcrypt, not this.
      passwordHash: sha256("dev-password-not-for-prod"),
      role: "OWNER",
      orgId: org.id,
    },
  });

  const rawKey = `cm_live_${randomUUID().replace(/-/g, "")}`;
  await prisma.apiKey.create({
    data: {
      orgId: org.id,
      keyHash: sha256(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: ["chat:read", "chat:write"],
      rateLimitRpm: 1000,
    },
  });

  console.log("Seeded org:", org.id);
  console.log("Raw API key (shown once):", rawKey);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
