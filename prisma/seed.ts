// prisma/seed.ts
import { PrismaClient, UserRole, TrustEventType } from '@prisma/client';
import { ALL_TAGS } from '@/lib/tags';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Seed site settings
  const defaultSettings = [
    { key: 'community_verified_threshold', value: '5' },
    { key: 'recommended_threshold', value: '15' },
    { key: 'trust_approved', value: '10' },
    { key: 'trust_rejected', value: '-10' },
    { key: 'trust_correct_verification', value: '2' },
    { key: 'trust_false_verification', value: '-5' },
    { key: 'trust_duplicate_found', value: '5' },
    { key: 'trust_spam', value: '-20' },
    { key: 'dat_name', value: 'HackHash Community' },
    { key: 'dat_description', value: 'Community-driven ROM Hack verification database' },
    { key: 'dat_url', value: 'https://hackhash.example.com' },
    { key: 'dat_author', value: 'HackHash Community' },
  ];

  for (const setting of defaultSettings) {
    await prisma.siteSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting,
    });
  }

  // Seed default tags — descriptive/genre tags only. Platform (NES, SNES, etc.)
  // is its own dedicated field on Submission now, not a freeform tag.
  //
  // Reads from src/lib/tags.ts (ALL_TAGS) rather than keeping its own
  // separately hand-typed copy — this used to be a third duplicate of the
  // tag list (alongside SubmitForm.tsx and TagFilters.tsx, both fixed
  // years ago) that could drift from what the app actually shows. Not
  // load-bearing either way: ensureTagsExist() self-heals any tag this
  // script never got a chance to run for, same as it always has.
  for (const tag of ALL_TAGS) {
    const data = {
      name: tag.name,
      tier: tag.tier.toUpperCase() as 'SIMPLE' | 'ADVANCED',
      description: tag.description,
      tagGroup: tag.group ?? null,
    };
    await prisma.tag.upsert({
      where: { slug: tag.slug },
      update: data,
      create: { slug: tag.slug, ...data },
    });
  }

  console.log('✅ Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
