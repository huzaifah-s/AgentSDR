import { NextRequest, NextResponse } from "next/server";
import { listPeoplePage } from "@/lib/leads/records";
import { upsertManualPerson } from "@/lib/leads/manualImport";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";

export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, () => listPeople(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function listPeople(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  const offset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  const campaignChannel = req.nextUrl.searchParams.get("campaignChannel");
  const sort = req.nextUrl.searchParams.get("sort");
  const direction = req.nextUrl.searchParams.get("direction");
  const crmCategory = req.nextUrl.searchParams.get("crmCategory");
  const crmWorkflowState = req.nextUrl.searchParams.get("crmWorkflowState");
  const result = await listPeoplePage({
    q: req.nextUrl.searchParams.get("q") ?? undefined,
    limit,
    offset,
    campaignChannel: campaignChannel === "email" || campaignChannel === "linkedin" || campaignChannel === "unassigned" ? campaignChannel : undefined,
    hasEmail: req.nextUrl.searchParams.get("hasEmail") === "true" ? true : undefined,
    hasLinkedin: req.nextUrl.searchParams.get("hasLinkedin") === "true" ? true : undefined,
    hasPhone: req.nextUrl.searchParams.get("hasPhone") === "true" ? true : undefined,
    sort: sort === "name" || sort === "title" || sort === "email" || sort === "company" || sort === "updated" || sort === "created" ? sort : undefined,
    direction: direction === "asc" || direction === "desc" ? direction : undefined,
    crmCategory: crmCategory === "customer" || crmCategory === "interested" || crmCategory === "not_interested" || crmCategory === "other" ? crmCategory : undefined,
    crmWorkflowState: crmWorkflowState === "unclassified" || crmWorkflowState === "classifying" || crmWorkflowState === "action_required" || crmWorkflowState === "waiting" || crmWorkflowState === "idle" || crmWorkflowState === "paused" || crmWorkflowState === "closed" || crmWorkflowState === "error" ? crmWorkflowState : undefined,
    crmSubcategoryId: req.nextUrl.searchParams.get("crmSubcategoryId") ?? undefined,
    crmAiChange: req.nextUrl.searchParams.get("crmAiChange") === "true" ? true : undefined,
  });
  return NextResponse.json({ people: result.rows, total: result.total });
}

export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, () => createPerson(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function createPerson(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body is required" }, { status: 400 });
  try {
    const result = await upsertManualPerson({
      email: typeof body.email === "string" ? body.email : null,
      linkedinUrl: typeof body.linkedinUrl === "string" ? body.linkedinUrl : null,
      fullName: typeof body.fullName === "string" ? body.fullName : null,
      firstName: typeof body.firstName === "string" ? body.firstName : null,
      lastName: typeof body.lastName === "string" ? body.lastName : null,
      title: typeof body.title === "string" ? body.title : null,
      companyName: typeof body.companyName === "string" ? body.companyName : null,
      companyDomain: typeof body.companyDomain === "string" ? body.companyDomain : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      phone: typeof body.phone === "string" ? body.phone : null,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
