/**
 * Suggestions for the sectors box. Qualification compares a company's sectors with a
 * tender's category by exact, case-insensitive match (agents/qualification/logic.ts), and
 * eTenders' category names are long descriptions, so these are only a starting point:
 * the box accepts any text, and the hint tells people to use the wording they see on
 * eTenders. Extend this list from the categories the portal actually returns.
 */
export const SECTOR_SUGGESTIONS = [
  "Construction",
  "Civil engineering",
  "Building maintenance",
  "Electrical",
  "Plumbing",
  "Security services",
  "Cleaning services",
  "Catering",
  "Information technology",
  "Professional services",
  "Consulting",
  "Transport and logistics",
  "Printing and stationery",
  "Medical supplies",
  "Office furniture and equipment",
];
