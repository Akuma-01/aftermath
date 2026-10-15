import type { Claim, DiagnosticRecipe, Evidence, Incident, Scope } from '@aftermath/contracts';
import { evaluateSupport, makeReport } from '@aftermath/domain';

// Fixed synthetic observation timestamps keep fixture tests reproducible.
export const FIXTURE_CREATED_AT = '2026-09-25T10:10:00.000Z';
export const fixtureScope: Readonly<Scope> = Object.freeze({
  environment: 'production',
  timeWindow: '2026-09-25T09:40/10:10Z',
});

function evidence(
  sourceId: string,
  title: string,
  content: string,
  kind: Evidence['kind'],
  source: string,
  service: string,
  observedAt: string,
): Evidence {
  return {
    id: `${sourceId}-v1`,
    sourceId,
    version: 1,
    title,
    summary: content,
    content,
    kind,
    source,
    service,
    observedAt,
    scope: { ...fixtureScope },
    status: 'active',
    originGroupId: `origin-${sourceId}`,
  };
}

function claim(
  id: string,
  title: string,
  text: string,
  type: Claim['type'],
  groups: string[][],
): Claim {
  return {
    id: `${id}-v1`,
    title,
    text,
    type,
    scope: { ...fixtureScope },
    supportGroups: groups.map((members, index) => ({
      id: `${id}-G${index + 1}`,
      ruleId: `fixture-${id}-${index + 1}`,
      memberIds: members.map((member) => `${member}-v1`),
    })),
    oppositionGroups: [],
  };
}

/** Fresh deterministic objects for unit tests; not a production incident ID allocator. */
export function createDomainFixture(): Incident {
  const sources = [
    evidence(
      'E1',
      'Database pool exhaustion',
      'Imported log: active=100 max=100 waiting=42; recorded scope is production.',
      'log',
      'Imported log',
      'database',
      '2026-09-25T09:43:00.000Z',
    ),
    evidence(
      'E2',
      'Checkout timeouts',
      '18.4% of production checkout requests exceeded the five-second deadline.',
      'metric',
      'Service metrics',
      'checkout',
      '2026-09-25T09:45:00.000Z',
    ),
    evidence(
      'E3',
      'Payment latency spike',
      'Production payment-provider p95 latency was 4800ms.',
      'trace',
      'Distributed tracing',
      'payment',
      '2026-09-25T09:46:00.000Z',
    ),
    evidence(
      'E4',
      'Provider degradation',
      'An independent provider observation records elevated latency in the same window.',
      'event',
      'Provider status',
      'payment',
      '2026-09-25T09:48:00.000Z',
    ),
    evidence(
      'E5',
      'Checkout deployment',
      'Checkout release v2.14.0 preceded the alert. Temporal context does not establish causality.',
      'event',
      'Deployment ledger',
      'checkout',
      '2026-09-25T09:34:00.000Z',
    ),
    evidence(
      'E6',
      'Service dependency map',
      'Production checkout synchronously calls the payment provider with a five-second timeout.',
      'manifest',
      'Service catalog',
      'checkout',
      '2026-09-25T09:40:00.000Z',
    ),
  ];
  const claims = [
    claim(
      'C1',
      'Checkout requests are timing out',
      'Production checkout is experiencing elevated request timeouts: 18.4% exceed the configured deadline.',
      'observation',
      [['E2']],
    ),
    claim(
      'C2',
      'Production database pool pressure',
      'The imported log indicates database pool exhaustion in the recorded production scope.',
      'observation',
      [['E1']],
    ),
    claim(
      'C3',
      'Database pressure may explain failures',
      'Database pressure is a working hypothesis for checkout failures. The available evidence does not establish causality.',
      'hypothesis',
      [['C1', 'C2']],
    ),
    claim(
      'C4',
      'Payment-provider latency is elevated',
      'Payment-provider latency is elevated during the incident. At least one accepted observation supports this finding.',
      'observation',
      [['E3'], ['E4']],
    ),
    claim(
      'C5',
      'Inspect the payment timeout path',
      'Run a bounded payment timeout check: checkout depends on a provider showing elevated latency. No production changes are recommended yet.',
      'recommendation',
      [['C4', 'E6']],
    ),
  ];
  const evaluations = evaluateSupport(sources, claims);
  return {
    id: 'domain-checkout-fixture',
    title: 'Checkout requests timing out',
    service: 'checkout-api',
    severity: 'SEV 2',
    eventSeq: 1,
    evidenceEpoch: 1,
    reportStatus: 'current',
    evidence: sources,
    claims,
    evaluations,
    corrections: [],
    reports: [makeReport(claims, evaluations, 1, undefined, FIXTURE_CREATED_AT)],
  };
}

export const diagnosticRecipes: DiagnosticRecipe[] = [
  {
    id: 'production-pool',
    serviceId: 'database',
    prerequisiteIds: [],
    title: 'Check production pool usage',
    description: 'Inspect pool utilization and connection failures for the incident window.',
    informs: ['C2-v1', 'C3-v1'],
    estimatedCost: 1,
  },
  {
    id: 'payment-timeouts',
    serviceId: 'payment',
    prerequisiteIds: ['E6-v1'],
    title: 'Inspect payment timeout traces',
    description: 'Check production payment spans for upstream timeouts.',
    informs: ['C4-v1', 'C5-v1'],
    estimatedCost: 2,
  },
  {
    id: 'source-environment',
    serviceId: 'database',
    prerequisiteIds: [],
    title: 'Verify log environment',
    description: 'Look up the original environment recorded in source metadata.',
    informs: ['C2-v1', 'C3-v1'],
    estimatedCost: 0.5,
  },
];
/** Small operational scenario; core-only tests can keep using createDomainFixture. */
export function createIncident(): Incident {
  const incident = createDomainFixture();
  incident.id = 'checkout-fixture';
  incident.scenario = 'checkout';
  incident.topology = {
    services: [
      { id: 'checkout', name: 'Checkout API', tier: 0 },
      { id: 'database', name: 'Orders database', tier: 1 },
      { id: 'payment', name: 'Payment provider', tier: 1 },
    ],
    dependencies: [
      { caller: 'checkout', dependency: 'database' },
      { caller: 'checkout', dependency: 'payment' },
    ],
  };
  incident.claims.forEach((c, i) => {
    c.serviceIds = [['checkout'], ['database'], ['checkout'], ['payment'], ['checkout']][i];
  });
  incident.diagnosticRecipes = structuredClone(diagnosticRecipes);
  incident.completedDiagnosticIds = [];
  return incident;
}

/** Authored synthetic commerce workload; measurements are fixtures, not production telemetry. */
export function createCommerceIncident(): Incident {
  const incident = createIncident();
  incident.scenario = 'commerce';
  incident.id = 'commerce-fixture';
  incident.title = 'Commerce disruption across checkout, orders, and fulfillment';
  const tiers: string[][] = [
    ['storefront', 'mobile', 'subscriptions', 'fulfillment'],
    ['gateway', 'billing', 'shipping', 'notifications', 'search'],
    ['checkout', 'cart', 'pricing', 'orders', 'reservations'],
    ['catalog', 'promotions', 'inventory', 'payment-router', 'fraud', 'ledger'],
    ['database', 'redis', 'payment', 'event-bus'],
  ];
  const dependencies: Array<[string, string]> = [
    ['storefront', 'gateway'],
    ['mobile', 'gateway'],
    ['gateway', 'checkout'],
    ['gateway', 'catalog'],
    ['gateway', 'search'],
    ['checkout', 'cart'],
    ['checkout', 'pricing'],
    ['checkout', 'reservations'],
    ['checkout', 'orders'],
    ['checkout', 'payment-router'],
    ['cart', 'redis'],
    ['cart', 'catalog'],
    ['pricing', 'promotions'],
    ['pricing', 'catalog'],
    ['reservations', 'inventory'],
    ['inventory', 'database'],
    ['orders', 'database'],
    ['orders', 'event-bus'],
    ['orders', 'payment-router'],
    ['payment-router', 'fraud'],
    ['payment-router', 'payment'],
    ['payment-router', 'ledger'],
    ['fraud', 'redis'],
    ['ledger', 'database'],
    ['billing', 'payment-router'],
    ['billing', 'ledger'],
    ['subscriptions', 'billing'],
    ['fulfillment', 'orders'],
    ['fulfillment', 'shipping'],
    ['shipping', 'event-bus'],
    ['notifications', 'event-bus'],
    ['catalog', 'database'],
    ['search', 'catalog'],
    ['promotions', 'redis'],
  ];
  incident.topology = {
    services: tiers.flatMap((ids, tier) =>
      ids.map((id) => ({ id, name: id.replaceAll('-', ' '), tier })),
    ),
    dependencies: dependencies.map(([caller, dependency]) => ({ caller, dependency })),
  };
  const observations: Array<[string, string, string, string]> = [
    [
      'E10',
      'Orders commit timeouts',
      'orders',
      'Orders commit p95=5800ms; deadline failures=12.2%; 4200 requests.',
    ],
    [
      'E11',
      'Reservation latency',
      'reservations',
      'Reservation p95=4200ms; inventory span p95=3900ms; 6100 requests.',
    ],
    [
      'E12',
      'Fulfillment backlog',
      'fulfillment',
      'Unacknowledged order submissions=280; backlog age=19 minutes.',
    ],
    [
      'E13',
      'Promotion checks healthy',
      'promotions',
      'Promotion lookup p95=42ms; success=99.99%; 14000 lookups.',
    ],
    [
      'E14',
      'Catalog reads healthy',
      'catalog',
      'Catalog cached-read p95=65ms; success=99.98%; 26000 reads.',
    ],
    [
      'E15',
      'Cart cache healthy',
      'cart',
      'Cart cache p95=19ms; Redis hit ratio=98.4%; 11000 requests.',
    ],
    [
      'E16',
      'Billing requests delayed',
      'billing',
      'Billing p95=5100ms; 7.1% of renewal requests exceed their deadline.',
    ],
    [
      'E17',
      'Mobile checkout failures',
      'mobile',
      'Mobile checkout error ratio=17.9%; 2000 sessions; same incident window.',
    ],
    [
      'E18',
      'Gateway checkout errors',
      'gateway',
      'Gateway 504 ratio on checkout routes=18.1%; catalog route success=99.98%.',
    ],
    [
      'E19',
      'Order event lag',
      'event-bus',
      'Order-events consumer lag=270 records; shipping-events lag=2 records.',
    ],
    ['E20', 'Search reads healthy', 'search', 'Search p95=110ms; success=99.97%; 9000 requests.'],
  ];
  incident.evidence.push(
    ...observations.map(([id, title, service, observation]) =>
      evidence(
        id,
        title,
        `SYNTHETIC SERVICE METRICS\n${observation}\nenvironment=production\nwindow=09:40–10:10 UTC`,
        'metric',
        'Commerce telemetry fixture',
        service,
        '2026-09-25T09:50:00.000Z',
      ),
    ),
  );
  const manifest = incident.evidence.find((e) => e.id === 'E6-v1')!;
  manifest.summary =
    'Checkout reaches payment through the payment router and storage through orders and inventory.';
  manifest.content = `SYNTHETIC SERVICE CATALOG\n${dependencies.map(([a, b]) => `${a} → ${b}`).join('\n')}\nDependency edges describe possible propagation, not proof of cause.`;
  const additions: Array<[string, string, string, Claim['type'], string[][], string]> = [
    [
      'C10',
      'Orders are missing their deadline',
      'Order commits exceed the deadline in 12.2% of sampled requests.',
      'observation',
      [['E10']],
      'orders',
    ],
    [
      'C11',
      'Database contention may delay orders',
      'Database pressure is a candidate contributor to delayed order commits; temporal association does not prove causality.',
      'hypothesis',
      [['C10', 'C2']],
      'orders',
    ],
    [
      'C12',
      'Reservations are slow',
      'Reservation latency is elevated and most sampled time is in inventory spans.',
      'observation',
      [['E11']],
      'reservations',
    ],
    [
      'C13',
      'Inventory may share database pressure',
      'Inventory delays may involve the same database pressure. Confirm with production observations before acting.',
      'hypothesis',
      [['C12', 'C2']],
      'inventory',
    ],
    [
      'C14',
      'Fulfillment has a backlog',
      'Fulfillment has 280 unacknowledged order submissions in the incident window.',
      'observation',
      [['E12']],
      'fulfillment',
    ],
    [
      'C15',
      'Order delays may propagate to fulfillment',
      'Delayed order commits are a candidate explanation for the fulfillment backlog, subject to validation of their supporting premises.',
      'hypothesis',
      [['C11', 'C14']],
      'fulfillment',
    ],
    [
      'C16',
      'Investigate the shared database path',
      'Inspect the shared database path across checkout and fulfillment; mobile and gateway observations corroborate user impact but not its cause.',
      'recommendation',
      [['C3', 'C15', 'E17', 'E18']],
      'gateway',
    ],
    [
      'C17',
      'Order degradation remains independently observed',
      'Order degradation has at least one admissible observation, even if its database explanation changes.',
      'observation',
      [['C11'], ['E10']],
      'orders',
    ],
    [
      'C18',
      'Promotion service is healthy',
      'Promotion lookup metrics remain healthy during the same incident window.',
      'observation',
      [['E13']],
      'promotions',
    ],
    [
      'C19',
      'Catalog and search reads remain healthy',
      'Catalog and search read metrics remain healthy; shared infrastructure alone does not establish an outage.',
      'observation',
      [['E14', 'E20']],
      'catalog',
    ],
    [
      'C20',
      'Cart cache remains healthy',
      'Cart cache latency and hit ratio remain within the recorded healthy range.',
      'observation',
      [['E15']],
      'cart',
    ],
    [
      'C21',
      'Inspect the billing payment path',
      'Billing delays and elevated provider latency justify a bounded payment-path investigation; they do not establish sole causality.',
      'recommendation',
      [['E16', 'C4']],
      'billing',
    ],
    [
      'C22',
      'Order events are lagging',
      'Order event consumers are 270 records behind while shipping event lag remains small.',
      'observation',
      [['E19']],
      'event-bus',
    ],
  ];
  incident.claims.push(
    ...additions.map(([id, title, text, type, groups, serviceId]) => ({
      ...claim(id, title, text, type, groups),
      serviceIds: [serviceId],
    })),
  );
  incident
    .diagnosticRecipes!.find((r) => r.id === 'production-pool')!
    .informs.push('C11-v1', 'C13-v1', 'C15-v1', 'C16-v1');
  incident.diagnosticRecipes!.find((r) => r.id === 'payment-timeouts')!.informs.push('C21-v1');
  incident.evaluations = evaluateSupport(incident.evidence, incident.claims);
  incident.reports = [
    makeReport(incident.claims, incident.evaluations, 1, undefined, FIXTURE_CREATED_AT),
  ];
  return incident;
}
