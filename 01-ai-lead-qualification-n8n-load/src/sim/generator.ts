import type { Rng } from '../lib/random.js';

/**
 * Synthetic lead generator.
 *
 * The mix matters more than the realism of any single lead: a load run made
 * entirely of perfect leads exercises one code path and tells you nothing about
 * the validation boundary, the blocklist, or the duplicate handling. These
 * weights are roughly what an inbound B2B form actually receives.
 */
const MIX: Array<{ kind: LeadKind; weight: number }> = [
  { kind: 'enterprise', weight: 12 },
  { kind: 'midmarket', weight: 26 },
  { kind: 'small', weight: 24 },
  { kind: 'tyre_kicker', weight: 14 },
  { kind: 'job_seeker', weight: 8 },
  { kind: 'spam', weight: 6 },
  { kind: 'competitor', weight: 2 },
  { kind: 'duplicate', weight: 5 },
  { kind: 'invalid', weight: 3 },
];

export type LeadKind =
  | 'enterprise'
  | 'midmarket'
  | 'small'
  | 'tyre_kicker'
  | 'job_seeker'
  | 'spam'
  | 'competitor'
  | 'duplicate'
  | 'invalid';

const FIRST = ['John', 'Maria', 'Ivan', 'Elena', 'Petar', 'Anna', 'Georgi', 'Sofia', 'Nikolay', 'Daniela', 'Lukas', 'Ines'];
const LAST = ['Smith', 'Petrova', 'Ivanov', 'Dimitrova', 'Georgiev', 'Novak', 'Weber', 'Kovacs', 'Lindqvist', 'Moreau'];
const COMPANY = ['Acme', 'Northwind', 'Globex', 'Initech', 'Umbrella', 'Vertex', 'Lumen', 'Cascade', 'Meridian', 'Orbit'];
const SUFFIX = ['Ltd', 'GmbH', 'AB', 'BV', 'SRL', 'AS'];
const DOMAIN = ['co', 'io', 'com', 'de', 'bg', 'eu'];

const ENTERPRISE_MESSAGES = [
  'We need to automate customer support across three regions. Our current process is manual and we want to start this quarter.',
  'We are replacing our support tooling and need automation integrated with our existing CRM before the end of the year.',
  'Our support team handles 4000 tickets a month manually. We need to automate triage and routing urgently.',
];
const MIDMARKET_MESSAGES = [
  'We are looking at automating parts of our customer support and comparing a few options.',
  'Interested in a demo. We want to understand pricing and how the integration works with our current stack.',
  'We need to evaluate automation for our operations team. Can you send a proposal?',
];
const SMALL_MESSAGES = [
  'We are a small team looking at automating our support inbox. Curious about pricing.',
  'Looking for something simple to handle our online store enquiries automatically.',
];
const TYRE_KICKER_MESSAGES = ['Just browsing, what do you do?', 'How much?', 'info please'];
const JOB_MESSAGES = [
  'Hi, are you hiring? I am sending my CV for any open vacancy.',
  'I am a student writing a thesis on automation and would like some information for my research project.',
];
const SPAM_MESSAGES = [
  'We offer premium SEO services and quality backlinks for your website. Guaranteed first page.',
  'Would you be interested in a guest post on your blog? We have high authority sites.',
];

export interface GeneratedLead {
  kind: LeadKind;
  payload: unknown;
}

/**
 * Deterministic given the rng. Returns raw payloads — including deliberately
 * invalid ones — because the validation boundary is part of what is under test.
 */
export function createLeadGenerator(rng: Rng) {
  const totalWeight = MIX.reduce((sum, entry) => sum + entry.weight, 0);
  const previous: unknown[] = [];

  const pickKind = (): LeadKind => {
    let roll = rng.next() * totalWeight;
    for (const entry of MIX) {
      roll -= entry.weight;
      if (roll <= 0) return entry.kind;
    }
    return 'midmarket';
  };

  const person = () => {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    return { first, last, name: `${first} ${last}` };
  };

  const business = () => {
    const company = `${rng.pick(COMPANY)} ${rng.pick(SUFFIX)}`;
    const slug = company.split(' ')[0]!.toLowerCase();
    return { company, domain: `${slug}${rng.int(1, 400)}.${rng.pick(DOMAIN)}` };
  };

  return function next(): GeneratedLead {
    // 'duplicate' can be drawn before anything has been generated to duplicate.
    // Fall back to a normal lead rather than indexing into an empty history.
    let kind = pickKind();
    if (kind === 'duplicate' && previous.length === 0) kind = 'midmarket';

    const { first, last, name } = person();

    if (kind === 'duplicate') {
      // Re-delivery of an earlier lead, with the casing a real retry would vary.
      const original = previous[rng.int(0, previous.length)] as Record<string, unknown>;
      return { kind, payload: { ...original, email: String(original.email).toUpperCase() } };
    }

    if (kind === 'invalid') {
      const variants: unknown[] = [
        { name, message: 'Call me back please' },
        { name, email: 'not-an-email-address', message: 'Interested in your product' },
        { name, email: `${first.toLowerCase()}@${business().domain}`, message: '' },
        { name, email: `${first.toLowerCase()}@${business().domain}`, budget: -4000, message: 'We need automation urgently' },
      ];
      return { kind, payload: rng.pick(variants) };
    }

    if (kind === 'competitor') {
      return {
        kind,
        payload: {
          name,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@competitor.com`,
          company: 'Competitor',
          employees: rng.int(50, 500),
          budget: rng.int(20_000, 80_000),
          message: 'We would like to discuss a partnership and automate our joint support workflow.',
          source: 'api',
        },
      };
    }

    if (kind === 'job_seeker' || kind === 'spam') {
      const payload = {
        name,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${rng.int(1, 99)}@gmail.com`,
        message: kind === 'spam' ? rng.pick(SPAM_MESSAGES) : rng.pick(JOB_MESSAGES),
        source: 'email',
      };
      previous.push(payload);
      return { kind, payload };
    }

    const { company, domain } = business();
    const shape = {
      enterprise: { employees: () => rng.int(250, 4000), budget: () => rng.int(30_000, 250_000), messages: ENTERPRISE_MESSAGES, budgetChance: 0.75 },
      midmarket: { employees: () => rng.int(50, 250), budget: () => rng.int(8_000, 40_000), messages: MIDMARKET_MESSAGES, budgetChance: 0.5 },
      small: { employees: () => rng.int(3, 49), budget: () => rng.int(1_000, 9_000), messages: SMALL_MESSAGES, budgetChance: 0.35 },
      tyre_kicker: { employees: () => rng.int(1, 15), budget: () => rng.int(0, 800), messages: TYRE_KICKER_MESSAGES, budgetChance: 0.1 },
    }[kind as 'enterprise' | 'midmarket' | 'small' | 'tyre_kicker'] ?? {
      employees: () => rng.int(50, 250),
      budget: () => rng.int(8_000, 40_000),
      messages: MIDMARKET_MESSAGES,
      budgetChance: 0.5,
    };

    const payload: Record<string, unknown> = {
      name,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
      company,
      message: rng.pick(shape.messages),
      source: rng.pick(['website_form', 'website_form', 'email', 'api', 'referral']),
    };
    // Real forms have optional fields, and they are frequently blank.
    if (rng.chance(0.85)) payload.employees = shape.employees();
    if (rng.chance(shape.budgetChance)) payload.budget = shape.budget();

    previous.push(payload);
    if (previous.length > 200) previous.shift();
    return { kind, payload };
  };
}
