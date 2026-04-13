import bcrypt from "bcryptjs";
import {
  Environment,
  MemberRole,
  ProductType,
} from "@prisma/client";
import prisma from "../src";

const DEMO_USER_ID = "usr_demo";
const DEMO_USER_EMAIL = "demo@rovenue.dev";
const DEMO_PROJECT_SLUG = "demo";
const DEMO_PUBLIC_KEY = "rov_pub_demo_production";
const DEMO_API_KEY_ID = "apkdemoseedkey";
const DEMO_SECRET_PLAINTEXT = `rov_sec_${DEMO_API_KEY_ID}_demosecret123456789`;
const PRODUCT_PRO_MONTHLY = "pro_monthly";
const PRODUCT_CREDITS_100 = "credits_100";
const DEFAULT_GROUP = "default";

async function main() {
  console.log("Seeding database...");

  const now = new Date();

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      id: DEMO_USER_ID,
      name: "Demo User",
      email: DEMO_USER_EMAIL,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const project = await prisma.project.upsert({
    where: { slug: DEMO_PROJECT_SLUG },
    update: {},
    create: {
      name: "Demo Project",
      slug: DEMO_PROJECT_SLUG,
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
      role: MemberRole.OWNER,
    },
  });

  // Secret key format: `rov_sec_<apiKeyId>_<random>`. The id is encoded in
  // the token so the auth middleware can look up the row without bcrypting
  // every candidate.
  await prisma.apiKey.upsert({
    where: { keyPublic: DEMO_PUBLIC_KEY },
    update: {},
    create: {
      id: DEMO_API_KEY_ID,
      projectId: project.id,
      label: "Default production key",
      keyPublic: DEMO_PUBLIC_KEY,
      keySecretHash: await bcrypt.hash(DEMO_SECRET_PLAINTEXT, 10),
      environment: Environment.PRODUCTION,
    },
  });

  const subscription = await prisma.product.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: PRODUCT_PRO_MONTHLY,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: PRODUCT_PRO_MONTHLY,
      type: ProductType.SUBSCRIPTION,
      displayName: "Pro Monthly",
      storeIds: {
        apple: "com.rovenue.demo.pro.monthly",
        google: PRODUCT_PRO_MONTHLY,
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
        identifier: PRODUCT_CREDITS_100,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: PRODUCT_CREDITS_100,
      type: ProductType.CONSUMABLE,
      displayName: "100 Credits",
      storeIds: {
        apple: "com.rovenue.demo.credits.100",
        google: PRODUCT_CREDITS_100,
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
        identifier: DEFAULT_GROUP,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: DEFAULT_GROUP,
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
  console.log(`  public:  ${DEMO_PUBLIC_KEY}`);
  console.log(`  secret:  ${DEMO_SECRET_PLAINTEXT} (DEV ONLY)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
