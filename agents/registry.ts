import type { Database } from "@/types/database";

export type DataCategory = Database["public"]["Enums"]["data_category"];
export type CostTier = Database["public"]["Enums"]["cost_tier"];

export interface DepartmentDefinition {
  slug: string;
  name: string;
  description: string;
  /** Tailwind palette key used by the Office View. */
  accent: "violet" | "sky" | "emerald" | "amber" | "rose" | "cyan" | "indigo" | "teal" | "slate";
  sortOrder: number;
}

export interface AgentDefinition {
  slug: AgentSlug;
  displayName: string;
  roleTitle: string;
  department: DepartmentDefinition["slug"];
  description: string;
  responsibilities: string[];
  /** Tool identifiers the agent may call. Enforced by the agent runtime. */
  allowedTools: string[];
  /** Data categories the agent may read (least privilege, POPIA minimisation). */
  dataCategories: DataCategory[];
  modelTier: CostTier;
  maxConcurrentTasks: number;
  escalationPolicy: {
    /** Escalate to a human after this many consecutive failures. */
    maxConsecutiveFailures: number;
    notifyRoles: Array<"owner" | "admin" | "operator">;
  };
  /** Whether a functional (simulated or live) executor exists yet. */
  implemented: boolean;
}

export const AGENT_SLUGS = [
  "tender_director",
  "tender_discovery",
  "opportunity_qualification",
  "tender_analyst",
  "compliance",
  "document_manager",
  "proposal_writer",
  "pricing",
  "forms",
  "quality_assurance",
  "submission",
  "communications",
  "deadline",
  "tender_intelligence",
] as const;
export type AgentSlug = (typeof AGENT_SLUGS)[number];

export const DEPARTMENTS: DepartmentDefinition[] = [
  { slug: "executive", name: "Executive / Orchestration", description: "Coordinates every bid and owns deadlines.", accent: "violet", sortOrder: 0 },
  {
    slug: "tender_intelligence",
    name: "Tender Intelligence",
    description: "Finds opportunities, qualifies them and learns from outcomes.",
    accent: "sky",
    sortOrder: 1,
  },
  { slug: "bid_operations", name: "Bid Operations", description: "Analyses tender packs and prepares the response.", accent: "indigo", sortOrder: 2 },
  { slug: "compliance", name: "Compliance & Governance", description: "Validates eligibility and mandatory documentation.", accent: "emerald", sortOrder: 3 },
  { slug: "finance", name: "Finance & Pricing", description: "Builds pricing models for human sign-off.", accent: "amber", sortOrder: 4 },
  { slug: "quality_assurance", name: "Quality Assurance", description: "Independent review of the complete bid.", accent: "rose", sortOrder: 5 },
  { slug: "submission", name: "Submission Operations", description: "Prepares and records approved submissions.", accent: "cyan", sortOrder: 6 },
  { slug: "communications", name: "Communications", description: "Monitors and drafts tender correspondence.", accent: "teal", sortOrder: 7 },
  { slug: "documents", name: "Document Management", description: "Guards the company document vault.", accent: "slate", sortOrder: 8 },
];

const ESCALATE_DEFAULT: AgentDefinition["escalationPolicy"] = {
  maxConsecutiveFailures: 3,
  notifyRoles: ["owner", "admin"],
};

export const AGENTS: AgentDefinition[] = [
  {
    slug: "tender_director",
    displayName: "Tender Director",
    roleTitle: "Orchestrator",
    department: "executive",
    description: "Receives opportunities, plans the workflow and delegates to specialists.",
    responsibilities: [
      "Receive new tender opportunities",
      "Assign tasks and manage dependencies",
      "Decide the next workflow step",
      "Manage retries and prevent duplicate workflows",
      "Request human intervention where required",
    ],
    allowedTools: ["workflow.plan", "task.assign", "approval.request"],
    dataCategories: ["PUBLIC_TENDER_DATA"],
    modelTier: "MID",
    maxConcurrentTasks: 5,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "tender_discovery",
    displayName: "Tender Scout",
    roleTitle: "Tender Discovery Agent",
    department: "tender_intelligence",
    description: "Scans National Treasury eTenders for the provinces you watch, records each open tender and hands it to the Tender Director.",
    responsibilities: [
      "Scan eTenders for the watched provinces on request and every morning",
      "Record publication and closing dates, organisation, province and sector",
      "Capture briefing requirements, submission type and source links",
      "Never treat a discovered tender as qualified",
    ],
    allowedTools: ["connector.search", "connector.getTender", "web.search"],
    dataCategories: ["PUBLIC_TENDER_DATA"],
    modelTier: "LOW",
    maxConcurrentTasks: 3,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "opportunity_qualification",
    displayName: "Qualification Agent",
    roleTitle: "Opportunity Qualification",
    department: "tender_intelligence",
    description: "Compares tender requirements with company capability and returns an evidence-based fit assessment.",
    responsibilities: [
      "Check mandatory eligibility and hard disqualifiers",
      "Assess capability, geography, financial capacity and contract size",
      "Report evidence for every factor, never a bare score",
    ],
    allowedTools: ["company.capabilities.read"],
    dataCategories: ["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS", "COMPANY_CAPABILITIES", "COMPANY_PROFILE"],
    modelTier: "MID",
    maxConcurrentTasks: 2,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "tender_analyst",
    displayName: "Tender Analyst",
    roleTitle: "Requirements Analyst",
    department: "bid_operations",
    description: "Reads the full tender pack and extracts requirements with citations.",
    responsibilities: [
      "Extract scope, mandatory conditions, forms and deadlines",
      "Identify briefings, evaluation method and submission instructions",
      "Cite the source document and page for each requirement",
    ],
    allowedTools: ["tender.documents.read"],
    dataCategories: ["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS"],
    modelTier: "MID",
    maxConcurrentTasks: 2,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "compliance",
    displayName: "Compliance Officer",
    roleTitle: "Compliance Agent",
    department: "compliance",
    description: "Validates registrations, tax, B-BBEE and mandatory declarations. Never fabricates compliance.",
    responsibilities: [
      "Validate company and supplier registrations",
      "Check tax, B-BBEE, banking and insurance documentation",
      "Track expiry dates and report missing items",
    ],
    allowedTools: ["vault.metadata.read"],
    dataCategories: ["PUBLIC_TENDER_DATA", "COMPANY_PROFILE", "TAX", "BBBEE", "INSURANCE", "CERTIFICATIONS"],
    modelTier: "MID",
    maxConcurrentTasks: 2,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "document_manager",
    displayName: "Document Manager",
    roleTitle: "Vault Custodian",
    department: "documents",
    description: "Releases permitted document versions to authorised agents and tracks expiry.",
    responsibilities: [
      "Identify and classify documents",
      "Release only permitted versions to authorised agents",
      "Track expiry and usage; block stale documents",
    ],
    allowedTools: ["vault.read", "vault.signUrl"],
    dataCategories: ["COMPANY_PROFILE", "TAX", "BBBEE", "BANKING", "INSURANCE", "CERTIFICATIONS", "DIRECTOR_PERSONAL", "PROOF_OF_ADDRESS"],
    modelTier: "LOW",
    maxConcurrentTasks: 4,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: false,
  },
  {
    slug: "proposal_writer",
    displayName: "Proposal Writer",
    roleTitle: "Bid Writer",
    department: "bid_operations",
    description: "Drafts tender responses from verified company information only; flags unknowns.",
    responsibilities: [
      "Draft methodology, delivery and quality sections",
      "Use only verified projects, staff and certifications",
      "Flag every missing fact as MISSING_INFORMATION",
    ],
    allowedTools: ["company.capabilities.read", "company.references.read"],
    dataCategories: ["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS", "COMPANY_PROFILE", "COMPANY_CAPABILITIES", "PROJECT_REFERENCES"],
    modelTier: "MID",
    maxConcurrentTasks: 2,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "pricing",
    displayName: "Pricing Analyst",
    roleTitle: "Pricing Agent",
    department: "finance",
    description: "Builds pricing schedules for human approval. Cannot approve binding prices.",
    responsibilities: [
      "Structure the pricing schedule required by the tender",
      "Apply cost, overhead, contingency and margin rules",
      "Request human approval for final pricing",
    ],
    allowedTools: ["pricing.model"],
    dataCategories: ["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS", "PRICING", "FINANCIAL"],
    modelTier: "MID",
    maxConcurrentTasks: 2,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "forms",
    displayName: "Forms Agent",
    roleTitle: "Returnables Specialist",
    department: "bid_operations",
    description: "Populates repetitive forms from verified company data and records each field's source.",
    responsibilities: [
      "Populate standard bidding documents from verified data",
      "Record the source of every populated field",
      "Never guess declaration content",
    ],
    allowedTools: ["company.profile.read"],
    dataCategories: ["PUBLIC_TENDER_DATA", "COMPANY_PROFILE"],
    modelTier: "LOW",
    maxConcurrentTasks: 2,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: false,
  },
  {
    slug: "quality_assurance",
    displayName: "QA Reviewer",
    roleTitle: "Quality Assurance Agent",
    department: "quality_assurance",
    description: "Independently reviews the full bid before approval.",
    responsibilities: [
      "Check mandatory documents, forms and signatures",
      "Verify pricing completeness and arithmetic",
      "Verify deadline, format and declarations",
    ],
    allowedTools: ["bid.read"],
    dataCategories: ["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS", "PRICING", "COMPANY_PROFILE"],
    modelTier: "HIGH",
    maxConcurrentTasks: 1,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: true,
  },
  {
    slug: "submission",
    displayName: "Submission Officer",
    roleTitle: "Submission Agent",
    department: "submission",
    description: "Verifies approval, deadline and package integrity, then records the submission.",
    responsibilities: [
      "Verify approval, deadline, package hash and destination",
      "Create user action items for physical submissions",
      "Record submission receipts",
    ],
    allowedTools: ["submission.prepare", "submission.record"],
    dataCategories: ["PUBLIC_TENDER_DATA", "SUBMISSION"],
    modelTier: "LOW",
    maxConcurrentTasks: 1,
    escalationPolicy: { maxConsecutiveFailures: 1, notifyRoles: ["owner", "admin"] },
    implemented: true,
  },
  {
    slug: "communications",
    displayName: "Communications Agent",
    roleTitle: "Tender Correspondence",
    department: "communications",
    description: "Classifies tender emails and drafts responses for approval.",
    responsibilities: [
      "Classify clarifications, amendments, notices and awards",
      "Associate correspondence with tenders",
      "Draft responses; material ones require approval",
    ],
    allowedTools: ["inbox.read", "inbox.draft"],
    dataCategories: ["PUBLIC_TENDER_DATA", "COMMUNICATIONS"],
    modelTier: "LOW",
    maxConcurrentTasks: 3,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: false,
  },
  {
    slug: "deadline",
    displayName: "Deadline Agent",
    roleTitle: "Schedule Controller",
    department: "executive",
    description: "Tracks briefing, question, review and closing deadlines and escalates warnings.",
    responsibilities: [
      "Track briefing, site meeting and question deadlines",
      "Track internal review, approval and submission deadlines",
      "Raise escalating warnings",
    ],
    allowedTools: ["calendar.read", "notification.send"],
    dataCategories: ["PUBLIC_TENDER_DATA"],
    modelTier: "LOW",
    maxConcurrentTasks: 4,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: false,
  },
  {
    slug: "tender_intelligence",
    displayName: "Intelligence Analyst",
    roleTitle: "Tender Intelligence Agent",
    department: "tender_intelligence",
    description: "Analyses historical outcomes to improve future qualification decisions.",
    responsibilities: [
      "Track opportunities, submissions, wins and losses",
      "Analyse pricing and agency patterns from public information",
      "Report AI cost and time saved",
    ],
    allowedTools: ["analytics.read", "web.search"],
    dataCategories: ["PUBLIC_TENDER_DATA", "PRICING"],
    modelTier: "MID",
    maxConcurrentTasks: 1,
    escalationPolicy: ESCALATE_DEFAULT,
    implemented: false,
  },
];

export function getAgentDefinition(slug: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.slug === slug);
}

/** Throws if the registry is internally inconsistent. Run by unit tests. */
export function validateRegistry(): void {
  const depSlugs = new Set(DEPARTMENTS.map((d) => d.slug));
  const seen = new Set<string>();
  for (const a of AGENTS) {
    if (seen.has(a.slug)) throw new Error(`Duplicate agent ${a.slug}`);
    seen.add(a.slug);
    if (!depSlugs.has(a.department)) throw new Error(`Agent ${a.slug} has unknown department ${a.department}`);
    if (a.dataCategories.length === 0) throw new Error(`Agent ${a.slug} has no data categories`);
  }
  for (const s of AGENT_SLUGS) if (!seen.has(s)) throw new Error(`Agent ${s} missing from registry`);
}
