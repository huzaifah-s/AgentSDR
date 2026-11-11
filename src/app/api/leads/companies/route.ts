import { NextRequest, NextResponse } from "next/server";
import { listCompanies, upsertCompany, withLeadTransaction } from "@/lib/leads/records";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { and, eq } from "drizzle-orm";
import { companies } from "@/lib/leads/schema";
import { parseCompanyDomain } from "@/lib/leads/identity";
import { inOrg } from "@/lib/tenancy/scope";

export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, () => list(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function list(req: NextRequest) {
  const sort = req.nextUrl.searchParams.get("sort");
  const direction = req.nextUrl.searchParams.get("direction");
  const result = await listCompanies({
    q: req.nextUrl.searchParams.get("q") ?? undefined,
    limit: Number(req.nextUrl.searchParams.get("limit") ?? 50),
    offset: Number(req.nextUrl.searchParams.get("offset") ?? 0),
    sort: sort === "name" || sort === "domain" || sort === "people" || sort === "updated" ? sort : undefined,
    direction: direction === "asc" || direction === "desc" ? direction : undefined,
  });
  return NextResponse.json({ companies: result.rows, total: result.total });
}

export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, () => create(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function create(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.domain !== "string" || !body.domain.trim()) return NextResponse.json({ error: "domain is required" }, { status: 400 });
  // The domain is the company's identity: refuse a name typed into it.
  const domain = parseCompanyDomain(body.domain);
  if (!domain) return NextResponse.json({ error: `Invalid company domain: ${body.domain} (expected something like acme.com)` }, { status: 400 });
  try {
    const result = await withLeadTransaction(async (tx) => {
      const [existing] = await tx.select({ id: companies.id }).from(companies).where(and(inOrg(companies), eq(companies.domain, domain))).limit(1);
      const company = await upsertCompany(tx, {
        domain,
        name: typeof body.name === "string" ? body.name : null,
        linkedinUrl: typeof body.linkedinUrl === "string" ? body.linkedinUrl : null,
        source: "manual",
      });
      return { company, created: !existing };
    });
    if (!result.company) return NextResponse.json({ error: "domain is required" }, { status: 400 });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save company" }, { status: 400 });
  }
}
