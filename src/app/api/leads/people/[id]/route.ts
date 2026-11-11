import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { PersonEditError, updatePerson, type PersonEditInput } from "@/lib/leads/editPerson";

const FIELDS = ["firstName", "lastName", "email", "linkedinUrl", "phone", "title", "companyName", "companyDomain", "notes"] as const;

/**
 * PATCH /api/leads/people/[id] — the Edit person form. Every field is sent as
 * it should now be ("" or null clears it); a missing field is cleared too, so
 * a caller cannot half-apply an edit by accident.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body is required" }, { status: 400 });
  const input: PersonEditInput = Object.fromEntries(
    FIELDS.map((key) => [key, typeof body[key] === "string" ? body[key] : null]),
  );
  try {
    return await withOrgContext(req, async () => {
      try {
        return NextResponse.json(await updatePerson(id, input));
      } catch (error) {
        if (error instanceof PersonEditError) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
      }
    });
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}
