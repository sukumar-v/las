export interface Policy {
  allowed: string[];
  allowedWithCare?: string[];
  exceptions?: Record<string, string>;
}
export type LicenseNode = { id: string } | { op: "AND" | "OR"; args: LicenseNode[] };
export interface Evaluation {
  status: "ok" | "warn" | "fail";
  bad: string[];
  care: string[];
}
export interface PackageLicense {
  name: string;
  version: string;
  license?: string;
}
export function tokenize(expr: string): string[];
export function parseExpression(expr: string): LicenseNode;
export function evaluateLicense(expr: string | undefined | null, policy: Policy): Evaluation;
export function licenseOfManifest(pkg: Record<string, unknown>): string | undefined;
export function flattenPnpmLicenses(json: unknown): PackageLicense[];
export function checkPackages(
  packages: PackageLicense[],
  policy: Policy
): {
  offenders: (PackageLicense & { bad: string[]; care: string[] })[];
  warnings: (PackageLicense & { bad: string[]; care: string[] })[];
  excepted: (PackageLicense & { reason: string })[];
};
