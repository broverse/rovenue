import bcrypt from "bcryptjs";
import prisma from "../src";

async function main() {
  console.log("Seeding database...");

  const now = new Date();

  const user = await prisma.user.upsert({
    where: { email: "demo@rovenue.dev" },
    update: {},
    create: {
      id: "usr_demo",
      name: "Demo User",
      email: "demo@rovenue.dev",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const project = await prisma.project.upsert({
    where: { slug: "demo" },
    update: {},
    create: {
      name: "Demo Project",
      slug: "demo",
      settings: {},
    },
  });

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project.id, userId: user.id },
    },
    update: {},
    create: {
      projectId: project.id,
      userId: user.id,
      role: "OWNER",
    },
  });

  const demoSecretPlaintext = "rov_sec_demo_do_not_use_in_prod";
  await prisma.apiKey.upsert({
    where: { keyPublic: "rov_pub_demo_production" },
    update: {},
    create: {
      projectId: project.id,
      label: "Default production key",
      keyPublic: "rov_pub_demo_production",
      keySecretHash: await bcrypt.hash(demoSecretPlaintext, 10),
      environment: "PRODUCTION",
    },
  });

  const subscription = await prisma.product.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: "pro_monthly",
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: "pro_monthly",
      type: "SUBSCRIPTION",
      displayName: "Pro Monthly",
      storeIds: {
        apple: "com.rovenue.demo.pro.monthly",
        google: "pro_monthly",
        stripe: "price_demo_pro_monthly",
      },
      entitlementKeys: ["premium", "analytics"],
      isActive: true,
    },
  });

  const creditPack = await prisma.product.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: "credits_100",
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: "credits_100",
      type: "CONSUMABLE",
      displayName: "100 Credits",
      storeIds: {
        apple: "com.rovenue.demo.credits.100",
        google: "credits_100",
        stripe: "price_demo_credits_100",
      },
      entitlementKeys: [],
      creditAmount: 100,
      isActive: true,
    },
  });

  await prisma.productGroup.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: "default",
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: "default",
      isDefault: true,
      products: [
        {
          productId: subscription.id,
          order: 1,
          isPromoted: true,
          metadata: {},
        },
        {
          productId: creditPack.id,
          order: 2,
          isPromoted: false,
          metadata: {},
        },
      ],
      metadata: {
        title: "Choose your plan",
        description: "Upgrade to Pro or top up credits",
        theme: "default",
      },
    },
  });

  console.log("Seed complete");
  console.log(`  user:    ${user.email}`);
  console.log(`  project: ${project.slug} (${project.id})`);
  console.log(`  public:  rov_pub_demo_production`);
  console.log(`  secret:  ${demoSecretPlaintext} (DEV ONLY)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
